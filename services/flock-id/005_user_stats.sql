-- Social usage stats: a small set of per-user counters a friend can see in the
-- friends pane. Deliberately minimal to start (prompts, agents, workspaces).
-- Safe to re-run.

create table if not exists public.user_stats (
  id                 uuid primary key references public.profiles (id) on delete cascade,
  prompts_sent       bigint not null default 0,
  agents_launched    bigint not null default 0,
  workspaces_created bigint not null default 0,
  updated_at         timestamptz not null default now()
);

alter table public.user_stats enable row level security;

-- Same visibility as profiles: your own row, plus anyone you share a friendship
-- edge with (accepted or pending, either direction). No public leaderboard.
drop policy if exists "stats visible to self and friends" on public.user_stats;
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

-- Atomically add to the CALLER's own counters (auth.uid()), upserting the row
-- on first use. SECURITY DEFINER so it can write, but scoped to auth.uid(), so
-- a user can only ever bump their own stats. Per-call deltas are clamped to a
-- sane ceiling so a client can't inflate its numbers in one giant jump.
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
