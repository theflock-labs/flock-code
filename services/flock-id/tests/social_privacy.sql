\set ON_ERROR_STOP on
create function public.test_assert(ok boolean, message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'assertion failed: %', message; end if; end;
$$;

-- Accounts existed before the migration: all sharing now defaults off.
select public.test_assert((select bool_and(not usage_sharing and not presence_sharing) from public.profiles), 'private defaults');
insert into auth.users(id,email) values ('00000000-0000-4000-8000-000000000005','new@example.test');
select public.test_assert(not exists(select 1 from public.friendships where '00000000-0000-4000-8000-000000000005' in (requester,addressee)), 'new account has no founder friend');

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-4000-8000-000000000003';
select public.test_assert((select count(*) = 0 from public.user_stats where id = '00000000-0000-4000-8000-000000000001'), 'stranger cannot see stats');
insert into public.friendships(requester,addressee) values (auth.uid(),'00000000-0000-4000-8000-000000000001');
select public.test_assert((select count(*) = 0 from public.user_stats where id = '00000000-0000-4000-8000-000000000001'), 'pending requester cannot see stats');
select public.test_assert((select count(*) = 0 from public.usage_daily where id = '00000000-0000-4000-8000-000000000001'), 'pending requester cannot see daily history');
select public.test_assert(jsonb_array_length(public.realtime_context()->'peers') = 2, 'pending peer excluded (only self and historical founder)');
do $$ begin
  perform public.authorize_stream(gen_random_uuid(),gen_random_uuid(),'alice',true);
  raise exception 'pending stream incorrectly authorized';
exception when others then if sqlerrm <> 'accepted friendship required' then raise; end if; end $$;
do $$ begin
  perform public.bump_stats(1,0,0);
  raise exception 'upload without consent succeeded';
exception when others then if sqlerrm <> 'usage sharing is disabled' then raise; end if; end $$;

set request.jwt.claim.sub = '00000000-0000-4000-8000-000000000001';
select public.set_social_privacy(null, true);
select public.test_assert((select count(*) = 1 from public.user_stats where id=auth.uid()), 'presence-only preference preserves private history');
select public.test_assert((select usage_sharing = false from public.profiles where id=auth.uid()), 'presence preference cannot opt usage in');
select public.set_social_privacy(true, true);
-- Opt-in alone must not expose usage to pending requesters.
set request.jwt.claim.sub = '00000000-0000-4000-8000-000000000003';
select public.test_assert((select count(*) = 0 from public.user_stats where id = '00000000-0000-4000-8000-000000000001'), 'opted-in usage still requires acceptance');
set request.jwt.claim.sub = '00000000-0000-4000-8000-000000000001';
update public.friendships set status = 'accepted' where requester = '00000000-0000-4000-8000-000000000003' and addressee = auth.uid();
select public.authorize_stream('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','mallory',false);
select (public.realtime_context()->'streams'->0->>'grant_id') as grant_id \gset original_
set request.jwt.claim.sub = '00000000-0000-4000-8000-000000000003';
select public.test_assert((select count(*) = 1 from public.user_stats where id = '00000000-0000-4000-8000-000000000001'), 'accepted friend sees opted-in stats');
select public.test_assert((select count(*) = 1 from public.usage_daily where id = '00000000-0000-4000-8000-000000000001'), 'accepted friend sees opted-in daily history');
select public.test_assert(jsonb_array_length(public.realtime_context()->'streams') = 1, 'viewer grant visible');
select public.test_assert((public.realtime_context()->'streams'->0->>'allow_input')::boolean = false, 'observe is read only');

-- A different accepted friend cannot take ownership of a known stream UUID.
set request.jwt.claim.sub = '00000000-0000-4000-8000-000000000001';
insert into public.friendships(requester,addressee) values(auth.uid(),'00000000-0000-4000-8000-000000000002');
set request.jwt.claim.sub = '00000000-0000-4000-8000-000000000002';
select public.test_assert((select count(*) = 0 from public.user_stats where id = '00000000-0000-4000-8000-000000000001'), 'pending addressee cannot see usage');
update public.friendships set status = 'accepted' where requester = '00000000-0000-4000-8000-000000000001' and addressee = auth.uid();
select public.test_assert(jsonb_array_length(public.realtime_context()->'streams') = 0, 'nonmember cannot obtain known stream');
select public.end_stream_session('10000000-0000-4000-8000-000000000001');
do $$ begin
  perform public.authorize_stream('10000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000001','alice',true);
  raise exception 'stream ownership overwritten';
exception when others then if sqlerrm <> 'stream belongs to another owner' then raise; end if; end $$;

set request.jwt.claim.sub = '00000000-0000-4000-8000-000000000001';
select public.test_assert(jsonb_array_length(public.realtime_context()->'streams') = 1, 'nonmember cannot revoke known stream session');

-- Unfriend permanently revokes the old generation, even if reaccepted later.
set request.jwt.claim.sub = '00000000-0000-4000-8000-000000000003';
delete from public.friendships where requester = auth.uid() and addressee = '00000000-0000-4000-8000-000000000001';
select public.test_assert(jsonb_array_length(public.realtime_context()->'streams') = 0, 'unfriend revokes streams');
insert into public.friendships(requester,addressee) values(auth.uid(),'00000000-0000-4000-8000-000000000001');
set request.jwt.claim.sub = '00000000-0000-4000-8000-000000000001';
update public.friendships set status = 'accepted' where requester = '00000000-0000-4000-8000-000000000003' and addressee = auth.uid();
select public.test_assert(jsonb_array_length(public.realtime_context()->'streams') = 0, 're-friend does not resurrect stream');
select public.authorize_stream('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','mallory',true);
select public.test_assert(public.realtime_context()->'streams'->0->>'grant_id' <> :'original_grant_id', 'reopened stream has new channel generation');
set request.jwt.claim.sub = '00000000-0000-4000-8000-000000000003';
select public.end_stream_session('10000000-0000-4000-8000-000000000001');
select public.test_assert(jsonb_array_length(public.realtime_context()->'streams') = 0, 'viewer may end session');

-- Revocation hides old data immediately and deletes it for the owner too.
set request.jwt.claim.sub = '00000000-0000-4000-8000-000000000001';
select public.set_social_privacy(false,false);
select public.test_assert((select count(*) = 0 from public.user_stats where id = auth.uid()), 'disable deletes own totals');
select public.test_assert((select count(*) = 0 from public.usage_daily where id = auth.uid()), 'disable deletes own daily history');
select public.set_social_privacy(null,true);
select public.test_assert((select usage_sharing = false from public.profiles where id=auth.uid()), 'presence change cannot re-enable revoked usage');
do $$ begin
  perform public.set_usage_totals(100,100);
  raise exception 'revoked consent accepted upload';
exception when others then if sqlerrm <> 'usage sharing is disabled' then raise; end if; end $$;
reset role;
set request.jwt.claim.sub = '';
set role anon;
do $$ begin
  perform public.realtime_context();
  raise exception 'anonymous context was allowed';
exception when insufficient_privilege then null; end $$;
reset role;
