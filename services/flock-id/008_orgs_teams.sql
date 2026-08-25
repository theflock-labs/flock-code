-- Orgs & teams on flock ID. Run after 007 in the Supabase SQL editor.
--
-- Server-side source of truth for tenancy: who belongs to which org/team,
-- with handle-based invites. The desktop app mirrors the signed-in user's
-- active membership into the local/team knowledge graph (kg_org/kg_team/
-- kg_membership, same UUIDs) so agent spawns carry FLOCK_ORG_ID /
-- FLOCK_TEAM_ID and graph writes are tenant-scoped.
--
-- All writes go through SECURITY DEFINER RPCs (auth-checked, search_path
-- pinned, execute revoked from anon) — the tables have no insert/update
-- policies at all, so PostgREST can't be used to forge membership. Reads are
-- policy-scoped to members. Membership checks live in definer helper
-- functions because a policy on org_members that queries org_members would
-- recurse.

-- ─── Tables ──────────────────────────────────────────────────────────────────

create table public.orgs (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(trim(name)) between 1 and 64),
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now()
);

create table public.teams (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.orgs (id) on delete cascade,
  name       text not null check (char_length(trim(name)) between 1 and 64),
  created_at timestamptz not null default now(),
  unique (org_id, name)
);

create table public.org_members (
  org_id     uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  role       text not null default 'member' check (role in ('owner', 'admin', 'member')),
  joined_at  timestamptz not null default now(),
  primary key (org_id, profile_id)
);

create table public.team_members (
  team_id    uuid not null references public.teams (id) on delete cascade,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  joined_at  timestamptz not null default now(),
  primary key (team_id, profile_id)
);

-- Handle-based invites, mirroring the friendship request shape: a pending row
-- the invitee accepts or declines. No email leg — org invites are for people
-- who already have a flock ID (friend-invite emails cover acquisition).
create table public.org_invites (
  org_id     uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  invited_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  primary key (org_id, profile_id)
);

create index org_members_profile on public.org_members (profile_id);
create index team_members_profile on public.team_members (profile_id);
create index org_invites_profile on public.org_invites (profile_id);

-- ─── Membership helpers ──────────────────────────────────────────────────────
-- SECURITY DEFINER so policies can consult membership without RLS recursion
-- (a policy on org_members that selects org_members would loop). STABLE so
-- the planner may cache within a statement.

create function public.is_org_member(o uuid)
returns boolean
language sql stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.org_members m
    where m.org_id = o and m.profile_id = auth.uid()
  );
$$;

create function public.is_org_admin(o uuid)
returns boolean
language sql stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.org_members m
    where m.org_id = o and m.profile_id = auth.uid()
      and m.role in ('owner', 'admin')
  );
$$;

revoke execute on function public.is_org_member(uuid) from anon, public;
revoke execute on function public.is_org_admin(uuid) from anon, public;
grant  execute on function public.is_org_member(uuid) to authenticated;
grant  execute on function public.is_org_admin(uuid) to authenticated;

-- ─── Row-level security (reads only; all writes are RPCs) ────────────────────

alter table public.orgs         enable row level security;
alter table public.teams        enable row level security;
alter table public.org_members  enable row level security;
alter table public.team_members enable row level security;
alter table public.org_invites  enable row level security;

-- An org is visible to its members, and to someone with a pending invite
-- (they need the name to decide).
create policy "orgs visible to members and invitees"
  on public.orgs for select to authenticated
  using (
    public.is_org_member(id)
    or exists (
      select 1 from public.org_invites i
      where i.org_id = orgs.id and i.profile_id = auth.uid()
    )
  );

create policy "teams visible to org members"
  on public.teams for select to authenticated
  using (public.is_org_member(org_id));

create policy "org roster visible to members"
  on public.org_members for select to authenticated
  using (public.is_org_member(org_id));

create policy "team rosters visible to org members"
  on public.team_members for select to authenticated
  using (exists (
    select 1 from public.teams t
    where t.id = team_members.team_id and public.is_org_member(t.org_id)
  ));

-- Invites: the invitee sees their own; admins see the org's outstanding ones.
create policy "invites visible to invitee and org admins"
  on public.org_invites for select to authenticated
  using (profile_id = auth.uid() or public.is_org_admin(org_id));

-- The invitee declines their own; an admin revokes. (Accept goes through the
-- RPC because it must also insert the membership row.)
create policy "invitee declines or admin revokes"
  on public.org_invites for delete to authenticated
  using (profile_id = auth.uid() or public.is_org_admin(org_id));

-- ─── RPCs ────────────────────────────────────────────────────────────────────

-- Create an org; the creator becomes its owner.
create function public.create_org(p_name text)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_org uuid;
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;
  insert into public.orgs (name, created_by)
  values (trim(p_name), auth.uid())
  returning id into v_org;
  insert into public.org_members (org_id, profile_id, role)
  values (v_org, auth.uid(), 'owner');
  return v_org;
end;
$$;

-- Create a team inside an org. Admins/owners only.
create function public.create_team(p_org uuid, p_name text)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_team uuid;
begin
  if not public.is_org_admin(p_org) then
    raise exception 'only org owners/admins can create teams';
  end if;
  insert into public.teams (org_id, name)
  values (p_org, trim(p_name))
  returning id into v_team;
  return v_team;
end;
$$;

-- Invite an exact handle into an org. Admins/owners only. Exact-match lookup
-- (same non-enumerable contract as lookup_handle). Returns 'member' when the
-- handle already belongs, else 'invited'. Pending invites per org are capped
-- as an abuse guard.
create function public.invite_to_org(p_org uuid, p_handle text)
returns text
language plpgsql
security definer set search_path = public
as $$
declare
  v_target uuid;
begin
  if not public.is_org_admin(p_org) then
    raise exception 'only org owners/admins can invite';
  end if;
  select id into v_target from public.profiles
  where handle = lower(trim(p_handle));
  if v_target is null then
    raise exception 'no such handle';
  end if;
  if exists (select 1 from public.org_members m where m.org_id = p_org and m.profile_id = v_target) then
    return 'member';
  end if;
  if (select count(*) from public.org_invites i where i.org_id = p_org) >= 50 then
    raise exception 'too many pending invites for this org';
  end if;
  insert into public.org_invites (org_id, profile_id, invited_by)
  values (p_org, v_target, auth.uid())
  on conflict (org_id, profile_id) do nothing;
  return 'invited';
end;
$$;

-- Accept or decline a pending invite. Invitee only; accepting inserts the
-- membership and consumes the invite atomically.
create function public.respond_org_invite(p_org uuid, p_accept boolean)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_found int;
begin
  delete from public.org_invites
  where org_id = p_org and profile_id = auth.uid();
  get diagnostics v_found = row_count;
  if v_found = 0 then
    raise exception 'no pending invite';
  end if;
  if p_accept then
    insert into public.org_members (org_id, profile_id, role)
    values (p_org, auth.uid(), 'member')
    on conflict (org_id, profile_id) do nothing;
  end if;
end;
$$;

-- Join/leave a team. Self-serve for any member of the team's org — teams are
-- working groups, not permission boundaries (those are the org).
create function public.join_team(p_team uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_org uuid;
begin
  select org_id into v_org from public.teams where id = p_team;
  if v_org is null or not public.is_org_member(v_org) then
    raise exception 'not a member of this org';
  end if;
  insert into public.team_members (team_id, profile_id)
  values (p_team, auth.uid())
  on conflict (team_id, profile_id) do nothing;
end;
$$;

create function public.leave_team(p_team uuid)
returns void
language sql
security definer set search_path = public
as $$
  delete from public.team_members
  where team_id = p_team and profile_id = auth.uid();
$$;

-- Change a member's role. Owners only (the only role that can mint owners —
-- an admin promoting themselves to owner would be privilege escalation).
create function public.set_org_role(p_org uuid, p_profile uuid, p_role text)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if p_role not in ('owner', 'admin', 'member') then
    raise exception 'bad role';
  end if;
  if not exists (
    select 1 from public.org_members m
    where m.org_id = p_org and m.profile_id = auth.uid() and m.role = 'owner'
  ) then
    raise exception 'only owners can change roles';
  end if;
  if p_profile = auth.uid() and p_role <> 'owner'
     and not exists (
       select 1 from public.org_members m
       where m.org_id = p_org and m.role = 'owner' and m.profile_id <> auth.uid()
     ) then
    raise exception 'promote another owner first';
  end if;
  update public.org_members set role = p_role
  where org_id = p_org and profile_id = p_profile;
end;
$$;

-- Remove a member (admins; removing an owner takes an owner). Also clears
-- their team memberships in that org.
create function public.remove_org_member(p_org uuid, p_profile uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_target_role text;
begin
  if not public.is_org_admin(p_org) then
    raise exception 'only org owners/admins can remove members';
  end if;
  select role into v_target_role from public.org_members
  where org_id = p_org and profile_id = p_profile;
  if v_target_role is null then
    return;
  end if;
  if v_target_role = 'owner' and not exists (
    select 1 from public.org_members m
    where m.org_id = p_org and m.profile_id = auth.uid() and m.role = 'owner'
  ) then
    raise exception 'only an owner can remove an owner';
  end if;
  delete from public.team_members tm
  using public.teams t
  where tm.team_id = t.id and t.org_id = p_org and tm.profile_id = p_profile;
  delete from public.org_members
  where org_id = p_org and profile_id = p_profile;
end;
$$;

-- Leave an org. The last owner can't abandon a populated org (promote someone
-- first); the sole remaining member leaving deletes the org outright.
create function public.leave_org(p_org uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_role text;
  v_others int;
begin
  select role into v_role from public.org_members
  where org_id = p_org and profile_id = auth.uid();
  if v_role is null then
    return;
  end if;
  select count(*) into v_others from public.org_members
  where org_id = p_org and profile_id <> auth.uid();
  if v_others = 0 then
    delete from public.orgs where id = p_org;
    return;
  end if;
  if v_role = 'owner' and not exists (
    select 1 from public.org_members m
    where m.org_id = p_org and m.role = 'owner' and m.profile_id <> auth.uid()
  ) then
    raise exception 'promote another owner before leaving';
  end if;
  delete from public.team_members tm
  using public.teams t
  where tm.team_id = t.id and t.org_id = p_org and tm.profile_id = auth.uid();
  delete from public.org_members
  where org_id = p_org and profile_id = auth.uid();
end;
$$;

-- Org roster with handles. A definer RPC (not a profiles join) because the
-- profiles select policy is scoped to self + friends — teammates aren't
-- necessarily friends, and the roster must still render.
create function public.list_org_members(p_org uuid)
returns table (id uuid, handle citext, avatar_url text, role text)
language sql stable
security definer set search_path = public
as $$
  select p.id, p.handle, p.avatar_url, m.role
  from public.org_members m
  join public.profiles p on p.id = m.profile_id
  where m.org_id = p_org and public.is_org_member(p_org)
  order by m.joined_at;
$$;

-- The caller's pending invites, with org name and inviter handle (definer for
-- the same profiles-RLS reason as above).
create function public.my_org_invites()
returns table (org_id uuid, org_name text, invited_by_handle citext)
language sql stable
security definer set search_path = public
as $$
  select i.org_id, o.name, p.handle
  from public.org_invites i
  join public.orgs o on o.id = i.org_id
  left join public.profiles p on p.id = i.invited_by
  where i.profile_id = auth.uid()
  order by i.created_at;
$$;

revoke execute on function public.create_org(text)                    from anon, public;
revoke execute on function public.create_team(uuid, text)             from anon, public;
revoke execute on function public.invite_to_org(uuid, text)           from anon, public;
revoke execute on function public.respond_org_invite(uuid, boolean)   from anon, public;
revoke execute on function public.join_team(uuid)                     from anon, public;
revoke execute on function public.leave_team(uuid)                    from anon, public;
revoke execute on function public.set_org_role(uuid, uuid, text)      from anon, public;
revoke execute on function public.remove_org_member(uuid, uuid)       from anon, public;
revoke execute on function public.leave_org(uuid)                     from anon, public;
revoke execute on function public.list_org_members(uuid)              from anon, public;
revoke execute on function public.my_org_invites()                    from anon, public;

grant execute on function public.create_org(text)                     to authenticated;
grant execute on function public.create_team(uuid, text)              to authenticated;
grant execute on function public.invite_to_org(uuid, text)            to authenticated;
grant execute on function public.respond_org_invite(uuid, boolean)    to authenticated;
grant execute on function public.join_team(uuid)                      to authenticated;
grant execute on function public.leave_team(uuid)                     to authenticated;
grant execute on function public.set_org_role(uuid, uuid, text)       to authenticated;
grant execute on function public.remove_org_member(uuid, uuid)        to authenticated;
grant execute on function public.leave_org(uuid)                      to authenticated;
grant execute on function public.list_org_members(uuid)               to authenticated;
grant execute on function public.my_org_invites()                     to authenticated;
