-- Bound set_usage_totals. Run after 011 in the Supabase SQL editor. Safe to
-- re-run (create or replace).
--
-- set_usage_totals takes an absolute snapshot and keeps the max forever, which
-- is deliberate: a machine that can only see its own transcripts must not lower
-- a higher total synced from another one. The cost of that design is that the
-- write is irreversible by the user — only a service-role write can bring a
-- total back down.
--
-- Combined with an unbounded input, that made permanent self-inflicted
-- corruption a single RPC call away. The anon key is in the shipped bundle, so
-- anyone can call this directly with bigint max; the value then sticks forever
-- and no client-side fix can reach it. The clamp below is an absurdity guard,
-- not a business limit: a trillion tokens is orders of magnitude beyond any
-- real cumulative usage, so nothing legitimate is ever truncated, while the
-- number that survives stays a number rather than 9.2e18.

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

-- Existing rows can already be past the ceiling (the function was unbounded
-- before this file existed), and those are exactly the poisoned ones. Bring
-- them back into range; a legitimate row cannot be up here.
update public.user_stats
   set tokens_total    = least(tokens_total, 1000000000000),
       cost_usd_micros = least(cost_usd_micros, 1000000000000)
 where tokens_total    > 1000000000000
    or cost_usd_micros > 1000000000000;
