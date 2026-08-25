-- Daily snapshots of the cumulative Claude Code token/USD totals, so the app
-- can plot usage over time (the My Info dashboard chart). One row per user per
-- calendar day holding that day's *highest observed cumulative* total — the
-- same monotonic snapshot semantics as user_stats.set_usage_totals, so a stale
-- or lower reading (e.g. a second machine that sees fewer local transcripts)
-- never lowers the day's figure.
--
-- Per-day *deltas* are derived on read by diffing consecutive days, so nothing
-- here needs to know the increment — the client just pushes the same absolute
-- snapshot it already computes for set_usage_totals. Cost in micros (USD × 1e6)
-- to keep an exact integer. Safe to re-run.

create table if not exists public.usage_daily (
  id              uuid        not null references public.profiles (id) on delete cascade,
  day             date        not null default current_date,
  tokens_total    bigint      not null default 0,
  cost_usd_micros bigint      not null default 0,
  updated_at      timestamptz not null default now(),
  primary key (id, day)
);

-- Reads are always "this user's last N days", so index the range scan.
create index if not exists usage_daily_id_day_idx on public.usage_daily (id, day desc);

alter table public.usage_daily enable row level security;

-- Same visibility as user_stats: your own history, plus any friend's (accepted
-- or pending, either direction). No public leaderboard.
drop policy if exists "usage history visible to self and friends" on public.usage_daily;
create policy "usage history visible to self and friends"
  on public.usage_daily for select to authenticated
  using (
    id = auth.uid()
    or exists (
      select 1 from public.friendships f
      where (f.requester = auth.uid() and f.addressee = usage_daily.id)
         or (f.addressee = auth.uid() and f.requester = usage_daily.id)
    )
  );

-- Record today's cumulative snapshot for the CALLER (auth.uid()), monotonic per
-- day. SECURITY DEFINER so it can write, but hard-scoped to auth.uid() so a user
-- can only ever write their own history.
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
  insert into public.usage_daily (id, day, tokens_total, cost_usd_micros, updated_at)
  values (auth.uid(), current_date, t, c, now())
  on conflict (id, day) do update set
    tokens_total    = greatest(public.usage_daily.tokens_total, t),
    cost_usd_micros = greatest(public.usage_daily.cost_usd_micros, c),
    updated_at      = now();
end;
$$;

revoke execute on function public.record_usage_daily(bigint, bigint) from anon, public;
grant  execute on function public.record_usage_daily(bigint, bigint) to authenticated;
