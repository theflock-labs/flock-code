-- Release announcements. A realtime "an update was posted" signal so every
-- running app shows the update pill the instant we ship, instead of waiting for
-- its next poll. Run after 008 in the Supabase SQL editor.
--
-- The row is a NUDGE only — the app still fetches the signed latest.json for the
-- real version + signature, so this changes nothing about update security. The
-- sole writer is release.sh (service role); the table is world-readable so even
-- a signed-out client can subscribe.

create table if not exists public.releases (
  version  text        primary key,
  notes    text,
  platform text        not null default 'darwin-aarch64',
  pub_date timestamptz not null default now()
);

alter table public.releases enable row level security;

-- The existence of a new version is public: anon + authenticated may read and
-- realtime-subscribe. No insert/update/delete policy → only the service role
-- (release.sh) can write.
drop policy if exists "releases are public" on public.releases;
create policy "releases are public"
  on public.releases for select to anon, authenticated
  using (true);

grant select on public.releases to anon, authenticated;

-- Emit realtime change events to subscribers (idempotent — the publication
-- can't take IF NOT EXISTS on ADD TABLE, so guard it).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'releases'
  ) then
    execute 'alter publication supabase_realtime add table public.releases';
  end if;
end $$;
