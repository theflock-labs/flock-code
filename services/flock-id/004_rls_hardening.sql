-- RLS hardening for the flock ID graph. Two fixes, both safe to re-run.
--
-- M3  profiles were world-readable to any signed-in user (select policy
--     `using (true)`), so anyone could dump the whole member directory
--     (handles + real names). Restrict reads to your own row plus profiles you
--     share a friendship edge with (accepted OR pending, either direction),
--     which is everything the app actually renders. Exact-handle discovery for
--     "add friend" keeps working because lookup_handle becomes SECURITY
--     DEFINER below (exact match only, so still no enumeration).
--
-- M4  the "addressee accepts" update policy pinned status/addressee but not
--     `requester`, so the accepting user could rewrite requester to any id and
--     forge an accepted friendship the victim never initiated. A friendship's
--     endpoints are immutable, so enforce that with a trigger (policy-
--     independent, covers every update path).

-- ─── M3: scope profile reads to self + friendship edges ──────────────────────

drop policy if exists "profiles are readable by the signed-in" on public.profiles;
drop policy if exists "profiles visible to self and friends"   on public.profiles;

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

-- Exact-handle lookup for the "add friend" box. Now SECURITY DEFINER so it can
-- resolve a handle the caller isn't yet friends with (the restrictive select
-- policy above would otherwise hide it). Still an exact match on a single row,
-- so the user base can't be enumerated, and execute is limited to signed-in
-- users. search_path is pinned so the definer body can't be hijacked.
create or replace function public.lookup_handle(q text)
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

-- ─── M4: friendship endpoints are immutable ──────────────────────────────────

-- Only status/responded_at may change on a friendship; requester and addressee
-- are fixed for the life of the edge. Blocks the accept-time requester rewrite.
create or replace function public.friendships_lock_endpoints()
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

drop trigger if exists friendships_no_endpoint_change on public.friendships;
create trigger friendships_no_endpoint_change
  before update on public.friendships
  for each row execute function public.friendships_lock_endpoints();
