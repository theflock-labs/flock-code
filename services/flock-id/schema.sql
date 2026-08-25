-- flock ID: profiles + friend graph on Supabase.
-- Run once in the Supabase SQL editor (or `supabase db push`).
--
-- Identity lives in Supabase Auth (federated Google); this schema
-- adds the public profile (handle, display name, avatar) and the friendship
-- graph, guarded entirely by row-level security so the desktop app talks to
-- PostgREST directly with the anon key — no API service in between.
--
-- Emails deliberately stay in auth.users (private). Profiles expose only
-- what a friend may see.

create extension if not exists citext;

-- ─── Profiles ────────────────────────────────────────────────────────────────

create table public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  -- Claimed by the user after first sign-in; lowercase slug, 3-32 chars.
  handle       citext unique check (handle ~ '^[a-z0-9][a-z0-9_-]{2,31}$'),
  display_name text,
  avatar_url   text,
  created_at   timestamptz not null default now()
);

-- Every new auth user gets a profile row seeded from the OAuth metadata.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    new.raw_user_meta_data ->> 'avatar_url'
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

alter table public.profiles enable row level security;

-- Profile reads are scoped to self + friendship edges. That policy references
-- the friendships table, so it is created after friendships below. Only the
-- owner can edit their own row.
create policy "own profile is editable"
  on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- ─── Friendships ─────────────────────────────────────────────────────────────

create table public.friendships (
  requester    uuid not null references public.profiles (id) on delete cascade,
  addressee    uuid not null references public.profiles (id) on delete cascade,
  status       text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at   timestamptz not null default now(),
  responded_at timestamptz,
  primary key (requester, addressee),
  check (requester <> addressee)
);

-- One edge per pair regardless of direction: A→B blocks B→A.
create unique index friendships_pair
  on public.friendships (least(requester, addressee), greatest(requester, addressee));

alter table public.friendships enable row level security;

-- You see only edges you're part of.
create policy "own friendship edges are visible"
  on public.friendships for select to authenticated
  using (auth.uid() in (requester, addressee));

-- You can only send requests as yourself, and only as 'pending'.
create policy "send friend requests as yourself"
  on public.friendships for insert to authenticated
  with check (requester = auth.uid() and status = 'pending');

-- Only the addressee can accept (the sole legal transition).
create policy "addressee accepts"
  on public.friendships for update to authenticated
  using (addressee = auth.uid() and status = 'pending')
  with check (addressee = auth.uid() and status = 'accepted');

-- Either side can delete: cancel a request, decline one, or unfriend.
create policy "either side can sever"
  on public.friendships for delete to authenticated
  using (auth.uid() in (requester, addressee));

-- A friendship's endpoints are fixed; only status/responded_at may change.
-- Without this, the "addressee accepts" policy would let the accepting user
-- rewrite `requester` to forge an edge the victim never initiated.
create function public.friendships_lock_endpoints()
returns trigger
language plpgsql
as $$
begin
  if new.requester <> old.requester or new.addressee <> old.addressee then
    raise exception 'friendship endpoints are immutable';
  end if;
  return new;
end;
$$;

create trigger friendships_no_endpoint_change
  before update on public.friendships
  for each row execute function public.friendships_lock_endpoints();

-- Profile reads (declared here because it references friendships): a profile is
-- visible to its owner and to anyone sharing an edge with it, accepted or
-- pending, in either direction — everything the app renders.
create policy "profiles visible to self and friends"
  on public.profiles for select to authenticated
  using (
    id = auth.uid()
    or exists (
      select 1 from public.friendships f
      where (f.requester = auth.uid() and f.addressee = profiles.id)
         or (f.addressee = auth.uid() and f.requester = profiles.id)
    )
  );

-- ─── Lookup ──────────────────────────────────────────────────────────────────

-- Exact-handle lookup for the "add friend" box. Deliberately not a search:
-- no substring matching, so the user base can't be enumerated. SECURITY
-- DEFINER so it can resolve a not-yet-friend the restrictive profiles select
-- policy would otherwise hide; still a single exact-match row, execute limited
-- to signed-in users, search_path pinned.
create function public.lookup_handle(q text)
returns table (id uuid, handle citext, display_name text, avatar_url text)
language sql stable
security definer set search_path = public
as $$
  select p.id, p.handle, p.display_name, p.avatar_url
  from public.profiles p
  where p.handle = lower(trim(q));
$$;

revoke execute on function public.lookup_handle(text) from anon, public;
grant  execute on function public.lookup_handle(text) to authenticated;

-- ─── Social usage stats ──────────────────────────────────────────────────────

-- A few per-user counters a friend can see in the friends pane. Minimal to
-- start: prompts submitted to agents, agents launched, workspaces created.
create table public.user_stats (
  id                 uuid primary key references public.profiles (id) on delete cascade,
  prompts_sent       bigint not null default 0,
  agents_launched    bigint not null default 0,
  workspaces_created bigint not null default 0,
  -- Cumulative Claude Code token spend + USD (USD × 1e6), computed locally from
  -- the client's transcripts and written via set_usage_totals (absolute, not
  -- incremental).
  tokens_total       bigint not null default 0,
  cost_usd_micros    bigint not null default 0,
  updated_at         timestamptz not null default now()
);

alter table public.user_stats enable row level security;

-- Same visibility as profiles: self plus friendship edges. No public board.
create policy "stats visible to self and friends"
  on public.user_stats for select to authenticated
  using (
    id = auth.uid()
    or exists (
      select 1 from public.friendships f
      where (f.requester = auth.uid() and f.addressee = user_stats.id)
         or (f.addressee = auth.uid() and f.requester = user_stats.id)
    )
  );

-- Atomically add to the caller's own counters (scoped to auth.uid()); per-call
-- deltas are clamped so a client can't inflate its numbers in one jump.
create function public.bump_stats(
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
  insert into public.user_stats (id, prompts_sent, agents_launched, workspaces_created, updated_at)
  values (auth.uid(), p, a, w, now())
  on conflict (id) do update set
    prompts_sent       = public.user_stats.prompts_sent       + p,
    agents_launched    = public.user_stats.agents_launched    + a,
    workspaces_created = public.user_stats.workspaces_created + w,
    updated_at         = now();
end;
$$;

revoke execute on function public.bump_stats(int, int, int) from anon, public;
grant  execute on function public.bump_stats(int, int, int) to authenticated;

-- Set the caller's cumulative Claude Code token + USD totals. Absolute (not
-- incremental) and monotonic — the client computes these from its local
-- transcripts and pushes a snapshot; taking the max keeps a machine that sees
-- only its own transcripts from lowering a higher total synced elsewhere.
create function public.set_usage_totals(
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
  insert into public.user_stats (id, tokens_total, cost_usd_micros, updated_at)
  values (auth.uid(), t, c, now())
  on conflict (id) do update set
    tokens_total    = greatest(public.user_stats.tokens_total, t),
    cost_usd_micros = greatest(public.user_stats.cost_usd_micros, c),
    updated_at      = now();
end;
$$;

revoke execute on function public.set_usage_totals(bigint, bigint) from anon, public;
grant  execute on function public.set_usage_totals(bigint, bigint) to authenticated;
