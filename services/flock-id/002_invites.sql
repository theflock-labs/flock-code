-- Invites + referrals: add friends by email, invite the ones who aren't
-- here yet, credit the inviter when they arrive (free flock after beta).
--
-- Delivery is deliberately client-side (the inviter's own mail app with a
-- prefilled message): personal invites from a friend convert better than
-- transactional email, and there's no SMTP to run. This schema records the
-- invite so signup can close the loop server-side.

-- ─── Invites ─────────────────────────────────────────────────────────────────

create table public.invites (
  id          uuid primary key default gen_random_uuid(),
  inviter     uuid not null references public.profiles (id) on delete cascade,
  email       citext not null,
  created_at  timestamptz not null default now(),
  consumed_by uuid references public.profiles (id),
  consumed_at timestamptz,
  unique (inviter, email)
);

alter table public.invites enable row level security;

-- You see only invites you sent. Writes go through the definer functions.
create policy "own invites are visible"
  on public.invites for select to authenticated
  using (inviter = auth.uid());

-- ─── Referrals ───────────────────────────────────────────────────────────────

create table public.referrals (
  inviter    uuid not null references public.profiles (id) on delete cascade,
  invitee    uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (inviter, invitee)
);

alter table public.referrals enable row level security;

create policy "own referrals are visible"
  on public.referrals for select to authenticated
  using (auth.uid() in (inviter, invitee));

-- ─── Add friend by email (or record an invite) ───────────────────────────────

-- Security definer: needs to peek at auth.users to resolve email → user.
-- Returns 'requested' | 'invited' | 'already' | 'self'. Yes, the return
-- value reveals whether an email has an account — acceptable for a dev
-- tool; the alternative kills the invite UX.
create function public.add_friend_by_email(target_email text)
returns text
language plpgsql
security definer set search_path = public
as $$
declare
  me     uuid := auth.uid();
  target uuid;
begin
  if me is null then
    raise exception 'not signed in';
  end if;

  select id into target
  from auth.users
  where lower(email) = lower(trim(target_email))
  limit 1;

  if target is null then
    insert into public.invites (inviter, email)
    values (me, lower(trim(target_email)))
    on conflict (inviter, email) do nothing;
    return 'invited';
  end if;

  if target = me then
    return 'self';
  end if;

  begin
    insert into public.friendships (requester, addressee) values (me, target);
  exception when unique_violation then
    return 'already';
  end;
  return 'requested';
end;
$$;

revoke execute on function public.add_friend_by_email(text) from anon, public;
grant execute on function public.add_friend_by_email(text) to authenticated;

-- ─── Close the loop on signup ────────────────────────────────────────────────

-- Extends the profile-creation trigger: if the new user's email matches an
-- unconsumed invite, the EARLIEST inviter gets the referral credit and an
-- instant mutual friendship — you arrive with the person who brought you
-- already at your side. Only the first invite wins, so invite-spamming an
-- address can't farm credits.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  inv record;
begin
  insert into public.profiles (id, display_name, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    new.raw_user_meta_data ->> 'avatar_url'
  );

  select * into inv
  from public.invites
  where email = new.email and consumed_by is null
  order by created_at asc
  limit 1;

  if found then
    update public.invites
      set consumed_by = new.id, consumed_at = now()
      where id = inv.id;
    insert into public.referrals (inviter, invitee)
      values (inv.inviter, new.id)
      on conflict do nothing;
    insert into public.friendships (requester, addressee, status, responded_at)
      values (inv.inviter, new.id, 'accepted', now())
      on conflict do nothing;
  end if;

  return new;
end;
$$;

-- Realtime: the app subscribes to friendship changes so requests and
-- accepts land as live notifications (RLS still gates row visibility).
alter publication supabase_realtime add table public.friendships;
