-- The founder is everyone's first friend. Run after 010 in the Supabase SQL
-- editor.
--
-- Nobody's first launch should open onto an empty friends list: the sidebar is
-- the point of the product and it has nothing to show until you know someone.
-- MySpace solved this by putting Tom in every new account, and the mechanism
-- here is the same one 002 already uses for invite signups — a pre-accepted
-- friendship written by the profile-creation trigger, which the client is
-- already prepared for ("invite-signup auto-friendships arrive pre-accepted",
-- subscribeFriendEvents in flockId.ts).
--
-- It is an ordinary friendship, not a special case: it carries no flag, appears
-- exactly like any other edge, and can be removed by the user like any other.

-- ─── Who the founder is ──────────────────────────────────────────────────────

-- A flag on the row rather than a UUID literal buried in a function body. It is
-- visible in the data, it survives the account being recreated, and moving it is
-- an update instead of a migration.
alter table public.profiles
  add column if not exists is_founder boolean not null default false;

-- At most one. A second founder would make "the" founder ambiguous and the
-- trigger's `limit 1` arbitrary.
create unique index if not exists profiles_one_founder
  on public.profiles (is_founder) where is_founder;

update public.profiles set is_founder = true where handle = 'remiminnebo';

-- ─── Seed the friendship at signup ───────────────────────────────────────────

-- Extends the profile-creation trigger again (002 added the invite branch).
-- Order matters only in that the profile row must exist before a friendship can
-- reference it; the founder edge goes last so an invite-based edge from the same
-- person is already in place and this no-ops on it.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  inv record;
  founder uuid;
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

  -- Own block with its own handler: this runs inside the transaction that
  -- creates the auth user, so anything raised here does not cost a friendship,
  -- it costs the whole sign-up. No founder set yet, the founder signing up
  -- themselves, a constraint that changes underneath this later — none of them
  -- may turn into a 500 on someone's first launch.
  begin
    select id into founder from public.profiles where is_founder limit 1;
    if founder is not null and founder <> new.id then
      insert into public.friendships (requester, addressee, status, responded_at)
        values (founder, new.id, 'accepted', now())
        on conflict do nothing;
    end if;
  exception when others then
    null;
  end;

  return new;
end;
$$;

-- ─── Everyone who is already here ────────────────────────────────────────────

-- New accounts get the edge from the trigger; these are the ones that signed up
-- before it existed. `on conflict do nothing` with no target covers both the
-- (requester, addressee) key and the friendships_pair index, so an edge that
-- already exists in either direction is left exactly as it is — including a
-- pending request, which stays pending rather than being silently accepted.
insert into public.friendships (requester, addressee, status, responded_at)
select f.id, p.id, 'accepted', now()
from public.profiles f
cross join public.profiles p
where f.is_founder and p.id <> f.id
on conflict do nothing;
