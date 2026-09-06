#!/usr/bin/env python3
"""RLS/stream authorization integration tests in an owned, disposable Postgres.
Never connects to a developer/production database. Requires Docker only.
"""
from pathlib import Path
import subprocess
import time
import uuid

root = Path(__file__).resolve().parents[1]
name = 'flock-social-test-' + uuid.uuid4().hex[:12]
def run(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, capture_output=True, **kwargs)
def sql(text):
    return run('docker', 'exec', '-i', name, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', input=text)
try:
    run('docker','run','--rm','-d','--name',name,'-e','POSTGRES_PASSWORD=isolated-test-only','postgres:16')
    for attempt in range(80):
        probe = subprocess.run(['docker','exec',name,'pg_isready','-h','127.0.0.1','-U','postgres'], capture_output=True)
        if probe.returncode == 0: break
        time.sleep(0.25)
    else: raise RuntimeError('isolated postgres did not start')
    sql("""
      create role authenticated; create role anon;
      create publication supabase_realtime;
      create schema auth;
      create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql stable as
        $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      grant usage on schema auth to authenticated, anon;
    """)
    sql((root/'schema.sql').read_text())
    # Exercise the complete real chain, including migrations unrelated to this
    # test's assertions: later security fixes must coexist with every deployed
    # table, policy and function. Seed pre-011 data to cover historical backfill.
    migrations = sorted(root.glob('[0-9][0-9][0-9]_*.sql'))
    for migration in migrations:
        if int(migration.name[:3]) < 11:
            sql(migration.read_text())
    sql("""
      insert into auth.users(id,email) values
        ('00000000-0000-4000-8000-000000000001','alice@example.test'),
        ('00000000-0000-4000-8000-000000000002','bob@example.test'),
        ('00000000-0000-4000-8000-000000000003','mallory@example.test'),
        ('00000000-0000-4000-8000-000000000004','founder@example.test');
      update public.profiles set handle = case right(id::text,1) when '1' then 'alice' when '2' then 'bob'
        when '3' then 'mallory' else 'remiminnebo' end;
      insert into public.user_stats(id,prompts_sent) values ('00000000-0000-4000-8000-000000000001',42);
      insert into public.usage_daily(id,tokens_total) values ('00000000-0000-4000-8000-000000000001',42);
      grant usage on schema public to authenticated, anon;
      grant select,insert,update,delete on all tables in schema public to authenticated;
    """)
    for migration in migrations:
        if int(migration.name[:3]) >= 11:
            sql(migration.read_text())
    print('Applied complete migration chain: schema.sql, ' + ', '.join(p.name for p in migrations))
    sql((root/'tests/social_privacy.sql').read_text())
    # Exercise real transaction races, not a textual policy approximation.
    alice = "set role authenticated; set request.jwt.claim.sub = '00000000-0000-4000-8000-000000000001';"
    def start_sql(text):
        process = subprocess.Popen(['docker','exec','-i',name,'psql','-h','127.0.0.1','-U','postgres',
                                    '-v','ON_ERROR_STOP=1'], stdin=subprocess.PIPE,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        process.stdin.write(text)
        process.stdin.close()
        process.stdin = None
        return process
    def wait_sleep(label):
        for _ in range(80):
            found = sql("select count(*) from pg_stat_activity where application_name = '" + label + "' and wait_event = 'PgSleep';")
            if ' 1' in found.stdout: return
            time.sleep(0.025)
        raise RuntimeError('race fixture failed to acquire its lock')
    sql(alice + 'select public.set_social_privacy(true,false);')
    writer = start_sql("set application_name='usage-writer'; begin; " + alice +
                       'select public.bump_stats(1,0,0); select pg_sleep(1); commit;')
    wait_sleep('usage-writer')
    sql(alice + 'select public.set_social_privacy(false,false);')
    writer.communicate(timeout=10)
    assert writer.returncode == 0
    sql("select public.test_assert((select count(*)=0 from public.user_stats where id='00000000-0000-4000-8000-000000000001'),'racing revoke deletes committed upload');")
    sql(alice + 'select public.set_social_privacy(true,false);')
    revoker = start_sql("set application_name='usage-revoker'; begin; " + alice +
                        'select public.set_social_privacy(false,false); select pg_sleep(1); commit;')
    wait_sleep('usage-revoker')
    try:
        sql(alice + 'select public.bump_stats(1,0,0);')
        raise AssertionError('upload survived concurrent revocation')
    except subprocess.CalledProcessError as error:
        assert 'usage sharing is disabled' in error.stderr
    revoker.communicate(timeout=10)
    assert revoker.returncode == 0
    # A grant racing an unfriend cannot survive and reactivate on re-friend.
    pending_grant = start_sql("set application_name='friend-grant-writer'; begin; " + alice +
        "select public.authorize_stream(gen_random_uuid(),gen_random_uuid(),'mallory',false); select pg_sleep(1); commit;")
    wait_sleep('friend-grant-writer')
    mallory = "set role authenticated; set request.jwt.claim.sub = '00000000-0000-4000-8000-000000000003';"
    sql(mallory + "delete from public.friendships where requester=auth.uid() and addressee='00000000-0000-4000-8000-000000000001';")
    pending_grant.communicate(timeout=10)
    assert pending_grant.returncode == 0
    sql(mallory + "insert into public.friendships(requester,addressee) values(auth.uid(),'00000000-0000-4000-8000-000000000001');")
    sql(alice + "update public.friendships set status='accepted' where requester='00000000-0000-4000-8000-000000000003' and addressee=auth.uid();")
    sql(alice + "select public.test_assert(jsonb_array_length(public.realtime_context()->'streams')=0,'racing unfriend permanently revokes new grant');")
    sql(alice + "select public.authorize_stream(gen_random_uuid(),gen_random_uuid(),'bob',false) from generate_series(1,63);")
    first = start_sql("set application_name='grant-writer'; begin; " + alice +
                      "select public.authorize_stream(gen_random_uuid(),gen_random_uuid(),'bob',false); select pg_sleep(1); commit;")
    wait_sleep('grant-writer')
    try:
        sql(alice + "select public.authorize_stream(gen_random_uuid(),gen_random_uuid(),'bob',false);")
        raise AssertionError('parallel authorizations exceeded stream limit')
    except subprocess.CalledProcessError as error:
        assert 'too many active streams' in error.stderr
    first.communicate(timeout=10)
    assert first.returncode == 0
    sql("select public.test_assert((select count(*)=64 from public.stream_grants where revoked_at is null and expires_at > now()),'parallel grant limit');")
    print('PASS: private defaults, legacy upload rejection, pending/accepted/stranger RLS, stream ownership, revocation, generation rotation, signup, anonymous denial, concurrent revocation/upload concurrent unfriend/grant and concurrent grant limit')
except subprocess.CalledProcessError as error:
    print(error.stderr)
    raise
finally:
    subprocess.run(['docker','rm','-f',name], capture_output=True)
