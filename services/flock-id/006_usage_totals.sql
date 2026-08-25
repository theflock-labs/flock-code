-- Add cumulative Claude Code token spend + USD to the social usage stats.
--
-- Unlike prompts/agents/workspaces (small per-event increments handled by
-- bump_stats), these are absolute cumulative totals the client computes locally
-- from its Claude Code transcripts and pushes as a snapshot. So they need a
-- "set" RPC, not an "add" one. set_usage_totals writes the greater of the
-- stored and incoming value (monotonic): a total is cumulative-all-time and only
-- grows, and taking the max keeps a second machine — which sees only its own
-- local transcripts — from stomping a higher total synced from elsewhere.
--
-- USD is stored in micros (USD × 1e6) to keep an exact integer. Safe to re-run.

alter table public.user_stats
  add column if not exists tokens_total    bigint not null default 0,
  add column if not exists cost_usd_micros bigint not null default 0;

create or replace function public.set_usage_totals(
  p_tokens_total bigint, p_cost_usd_micros bigint
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  -- Clamp negatives to 0; leave the ceiling open (real totals reach billions of
  -- tokens). Monotonic on write, so a stale/low snapshot can't lower the total.
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
