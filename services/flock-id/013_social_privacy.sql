-- Apply after 012, before deploying the matching presence service/client.
-- All existing accounts start private. Historical friendships are preserved;
-- the old founder backfill has no provenance from which to infer consent.
begin;

alter table public.profiles add column if not exists usage_sharing boolean not null default false;
alter table public.profiles add column if not exists presence_sharing boolean not null default false;

create or replace function public.can_read_usage(owner_id uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select owner_id = auth.uid() or (
    exists (select 1 from public.profiles p where p.id = owner_id and p.usage_sharing)
    and exists (select 1 from public.friendships f where f.status = 'accepted'
      and ((f.requester = auth.uid() and f.addressee = owner_id)
        or (f.addressee = auth.uid() and f.requester = owner_id)))
  );
$$;
revoke all on function public.can_read_usage(uuid) from public, anon;
grant execute on function public.can_read_usage(uuid) to authenticated;

drop policy if exists "stats visible to self and friends" on public.user_stats;
create policy "stats visible to self and friends" on public.user_stats for select to authenticated
  using (public.can_read_usage(id));
drop policy if exists "usage history visible to self and friends" on public.usage_daily;
create policy "usage history visible to self and friends" on public.usage_daily for select to authenticated
  using (public.can_read_usage(id));

-- Enforce consent even for old clients calling SECURITY DEFINER usage RPCs.
create or replace function public.require_usage_consent()
returns trigger language plpgsql security definer set search_path = public as $$
declare consent boolean;
begin
  if auth.uid() is not null then
    -- Same profile row lock as revocation, held until this write commits.
    select usage_sharing into consent from public.profiles
      where id = new.id and id = auth.uid() for update;
    if consent is distinct from true then raise exception 'usage sharing is disabled'; end if;
  end if;
  return new;
end;
$$;
create trigger user_stats_consent before insert or update on public.user_stats
  for each row execute function public.require_usage_consent();
create trigger usage_daily_consent before insert or update on public.usage_daily
  for each row execute function public.require_usage_consent();

create or replace function public.set_social_privacy(p_usage boolean default null, p_presence boolean default null, p_delete_usage boolean default false)
returns void language plpgsql security definer set search_path = public as $$
declare was_enabled boolean;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select usage_sharing into was_enabled from public.profiles where id = auth.uid() for update;
  update public.profiles set usage_sharing = coalesce(p_usage, usage_sharing),
    presence_sharing = coalesce(p_presence, presence_sharing) where id = auth.uid();
  if not coalesce(p_usage, was_enabled, false) and (was_enabled or coalesce(p_delete_usage, false)) then
    delete from public.usage_daily where id = auth.uid();
    delete from public.user_stats where id = auth.uid();
  end if;
end;
$$;
revoke all on function public.set_social_privacy(boolean, boolean, boolean) from public, anon;
grant execute on function public.set_social_privacy(boolean, boolean, boolean) to authenticated;

-- Lock the account before usage rows, in the same order as revocation.
create or replace function public.bump_stats(
  d_prompts int default 0, d_agents int default 0, d_workspaces int default 0
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  p int := least(greatest(d_prompts, 0), 1000);
  a int := least(greatest(d_agents, 0), 1000);
  w int := least(greatest(d_workspaces, 0), 1000);
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;
  perform 1 from public.profiles where id = auth.uid() and usage_sharing for update;
  if not found then raise exception 'usage sharing is disabled'; end if;
  insert into public.user_stats (id, prompts_sent, agents_launched, workspaces_created, updated_at)
  values (auth.uid(), p, a, w, now())
  on conflict (id) do update set
    prompts_sent       = public.user_stats.prompts_sent       + p,
    agents_launched    = public.user_stats.agents_launched    + a,
    workspaces_created = public.user_stats.workspaces_created + w,
    updated_at         = now();
end;
$$;

create or replace function public.set_usage_totals(
  p_tokens_total bigint, p_cost_usd_micros bigint
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  -- 1e12 tokens; 1e12 micros = $1,000,000.
  max_tokens constant bigint := 1000000000000;
  max_cost   constant bigint := 1000000000000;
  t bigint := least(greatest(coalesce(p_tokens_total, 0), 0), max_tokens);
  c bigint := least(greatest(coalesce(p_cost_usd_micros, 0), 0), max_cost);
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;
  perform 1 from public.profiles where id = auth.uid() and usage_sharing for update;
  if not found then raise exception 'usage sharing is disabled'; end if;
  insert into public.user_stats (id, tokens_total, cost_usd_micros, updated_at)
  values (auth.uid(), t, c, now())
  on conflict (id) do update set
    tokens_total    = greatest(public.user_stats.tokens_total, t),
    cost_usd_micros = greatest(public.user_stats.cost_usd_micros, c),
    updated_at      = now();
end;
$$;

create or replace function public.record_usage_daily(
  p_tokens_total bigint, p_cost_usd_micros bigint
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  t bigint := greatest(coalesce(p_tokens_total, 0), 0);
  c bigint := greatest(coalesce(p_cost_usd_micros, 0), 0);
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;
  perform 1 from public.profiles where id = auth.uid() and usage_sharing for update;
  if not found then raise exception 'usage sharing is disabled'; end if;
  insert into public.usage_daily (id, day, tokens_total, cost_usd_micros, updated_at)
  values (auth.uid(), current_date, t, c, now())
  on conflict (id, day) do update set
    tokens_total    = greatest(public.usage_daily.tokens_total, t),
    cost_usd_micros = greatest(public.usage_daily.cost_usd_micros, c),
    updated_at      = now();
end;
$$;

-- Invites create a request the new account can accept. No founder auto-friend.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare inv record;
begin
  insert into public.profiles (id, display_name, avatar_url) values (
    new.id, coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    new.raw_user_meta_data ->> 'avatar_url');
  select * into inv from public.invites where email = new.email and consumed_by is null
    order by created_at asc limit 1;
  if found then
    update public.invites set consumed_by = new.id, consumed_at = now() where id = inv.id;
    insert into public.referrals (inviter, invitee) values (inv.inviter, new.id) on conflict do nothing;
    insert into public.friendships (requester, addressee, status)
      values (inv.inviter, new.id, 'pending') on conflict do nothing;
  end if;
  return new;
end;
$$;

-- UUID channels are regenerated on every reauthorization after ending. Knowing
-- a pane/session UUID is never sufficient to acquire its Ably capability.
create table public.stream_grants (
  stream_id uuid primary key,
  grant_id uuid not null unique default gen_random_uuid(),
  session_id uuid not null,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  viewer_id uuid not null references public.profiles(id) on delete cascade,
  allow_input boolean not null default false,
  expires_at timestamptz not null default now() + interval '8 hours',
  revoked_at timestamptz
);
alter table public.stream_grants enable row level security;
-- No direct table privileges: mutations and reads only through checked RPCs.
revoke all on public.stream_grants from anon, authenticated;

create or replace function public.authorize_stream(
  p_session_id uuid, p_stream_id uuid, p_viewer_handle text, p_allow_input boolean
) returns void language plpgsql security definer set search_path = public as $$
declare viewer uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select id into viewer from public.profiles where handle = lower(p_viewer_handle);
  -- Serialize grants per owner so parallel RPCs cannot race the limit.
  perform 1 from public.profiles where id = auth.uid() for update;
  if viewer is null then raise exception 'accepted friendship required'; end if;
  if viewer <> auth.uid() then
    -- Keep the friendship valid through INSERT. A concurrent unfriend either
    -- wins first (this fails) or runs after us and revokes this grant too.
    perform 1 from public.friendships where status = 'accepted'
      and ((requester = auth.uid() and addressee = viewer) or (addressee = auth.uid() and requester = viewer))
      for share;
    if not found then raise exception 'accepted friendship required'; end if;
  end if;
  if (select count(*) from public.stream_grants where owner_id = auth.uid()
      and revoked_at is null and expires_at > now() and stream_id <> p_stream_id) >= 64 then
    raise exception 'too many active streams';
  end if;
  insert into public.stream_grants as g (stream_id, session_id, owner_id, viewer_id, allow_input)
    values (p_stream_id, p_session_id, auth.uid(), viewer, coalesce(p_allow_input, false))
    on conflict (stream_id) do update set
      grant_id = case when g.revoked_at is not null or g.expires_at <= now()
        or g.viewer_id <> excluded.viewer_id or g.session_id <> excluded.session_id
        or g.allow_input <> excluded.allow_input then gen_random_uuid() else g.grant_id end,
      session_id = excluded.session_id, viewer_id = excluded.viewer_id,
      allow_input = excluded.allow_input, expires_at = now() + interval '8 hours', revoked_at = null
    where g.owner_id = auth.uid();
  if not found then raise exception 'stream belongs to another owner'; end if;
end;
$$;
revoke all on function public.authorize_stream(uuid, uuid, text, boolean) from public, anon;
grant execute on function public.authorize_stream(uuid, uuid, text, boolean) to authenticated;

create or replace function public.end_stream_session(p_session_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.stream_grants set revoked_at = now()
    where session_id = p_session_id and auth.uid() in (owner_id, viewer_id);
end;
$$;
revoke all on function public.end_stream_session(uuid) from public, anon;
grant execute on function public.end_stream_session(uuid) to authenticated;

create or replace function public.realtime_context()
returns jsonb language sql stable security definer set search_path = public as $$
  with peers as (
    select p.id, p.handle, p.presence_sharing from public.profiles p
    where p.handle is not null and (p.id = auth.uid() or exists (
      select 1 from public.friendships f where f.status = 'accepted'
        and ((f.requester = auth.uid() and f.addressee = p.id) or (f.addressee = auth.uid() and f.requester = p.id))
    ))
  )
  select jsonb_build_object(
    'identity', (select jsonb_build_object('id', id, 'handle', handle, 'presence_sharing', presence_sharing)
      from peers where id = auth.uid()),
    'peers', coalesce((select jsonb_agg(to_jsonb(p)) from peers p), '[]'::jsonb),
    'streams', coalesce((select jsonb_agg(to_jsonb(g)) from public.stream_grants g
      where auth.uid() in (g.owner_id, g.viewer_id) and g.revoked_at is null and g.expires_at > now()
      and g.owner_id in (select id from peers) and g.viewer_id in (select id from peers)), '[]'::jsonb)
  );
$$;
revoke all on function public.realtime_context() from public, anon;
grant execute on function public.realtime_context() to authenticated;

-- Removing a friendship permanently ends its old grants; re-adding the person
-- cannot silently resurrect a prior terminal session.
create or replace function public.revoke_unfriended_streams()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' or new.status <> 'accepted' then
    update public.stream_grants set revoked_at = now()
      where (owner_id = old.requester and viewer_id = old.addressee)
         or (owner_id = old.addressee and viewer_id = old.requester);
  end if;
  return null;
end;
$$;
create trigger friendship_stream_revocation after delete or update on public.friendships
  for each row execute function public.revoke_unfriended_streams();

commit;
