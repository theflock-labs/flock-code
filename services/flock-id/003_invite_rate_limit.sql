-- Invite email abuse controls: the /api/invite endpoint (Resend, from an
-- SPF/DKIM-aligned sender address) must only ever deliver to an address
-- the caller genuinely recorded as a pending invite, and no faster than a
-- human plausibly invites people. Both checks live in the DB so they survive
-- across stateless serverless invocations.
--
-- Additive and backward compatible: a new table plus one function. Nothing in
-- 002_invites.sql (or the add_friend_by_email flow) changes.

-- ─── Send log ────────────────────────────────────────────────────────────────

-- One row per delivered invite email, the source of truth for rate limiting.
-- Kept separate from public.invites so a single invite row can be counted
-- across repeat sends (the unique(inviter, email) invite row never grows).
create table public.invite_sends (
  id       uuid primary key default gen_random_uuid(),
  inviter  uuid not null references public.profiles (id) on delete cascade,
  email    citext not null,
  sent_at  timestamptz not null default now()
);

create index invite_sends_inviter_sent_at
  on public.invite_sends (inviter, sent_at);

alter table public.invite_sends enable row level security;

-- You see only your own sends. Writes go through the definer function below.
create policy "own invite sends are visible"
  on public.invite_sends for select to authenticated
  using (inviter = auth.uid());

-- ─── Gate a single send ──────────────────────────────────────────────────────

-- Called by the invite endpoint with the caller's token. Runs as definer so
-- it can write the log, but auth.uid() is still the caller, so a user can only
-- ever spend their own budget. Returns:
--   'ok'           the send is authorized and has been recorded
--   'no_invite'    no pending invite row for (caller, email) exists
--   'rate_limited' the caller is over the daily or burst cap
--
-- The send is recorded before the email actually goes out (the endpoint
-- reserves the slot, then sends), so a downstream delivery failure still
-- spends budget. With a 20/day cap that is a deliberate, conservative trade.
create function public.record_invite_send(target_email text)
returns text
language plpgsql
security definer set search_path = public
as $$
declare
  me          uuid   := auth.uid();
  addr        citext := lower(trim(target_email));
  day_count   integer;
  burst_count integer;
begin
  if me is null then
    raise exception 'not signed in';
  end if;

  -- Only an address this caller actually invited (and that has not yet joined)
  -- may be emailed. This is what removes the arbitrary-recipient spam cannon.
  if not exists (
    select 1 from public.invites
    where inviter = me and email = addr and consumed_by is null
  ) then
    return 'no_invite';
  end if;

  -- Rolling 24h cap.
  select count(*) into day_count
  from public.invite_sends
  where inviter = me and sent_at > now() - interval '24 hours';
  if day_count >= 20 then
    return 'rate_limited';
  end if;

  -- Per-minute burst cap. Also bounds hammering a single already-invited
  -- address, since every resend counts here too.
  select count(*) into burst_count
  from public.invite_sends
  where inviter = me and sent_at > now() - interval '60 seconds';
  if burst_count >= 5 then
    return 'rate_limited';
  end if;

  insert into public.invite_sends (inviter, email) values (me, addr);
  return 'ok';
end;
$$;

revoke execute on function public.record_invite_send(text) from anon, public;
grant execute on function public.record_invite_send(text) to authenticated;
