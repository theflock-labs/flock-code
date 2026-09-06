-- Password placeholders are replaced only with validated random hexadecimal credentials.
BEGIN;
ALTER ROLE flock PASSWORD '__ADMIN_PASSWORD__';
DO $roles$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flock_app') THEN
    CREATE ROLE flock_app LOGIN;
  END IF;
END $roles$;
ALTER ROLE flock_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD '__RUNTIME_PASSWORD__';
-- A previously created runtime role must not retain an inherited admin role.
DO $memberships$ DECLARE parent text; BEGIN
  FOR parent IN SELECT r.rolname FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid
    JOIN pg_roles child ON child.oid = m.member WHERE child.rolname = 'flock_app'
  LOOP EXECUTE format('REVOKE %I FROM flock_app', parent); END LOOP;
END $memberships$;
REVOKE ALL ON DATABASE flock_kg FROM PUBLIC;
REVOKE ALL ON DATABASE flock_kg FROM flock_app;
GRANT CONNECT ON DATABASE flock_kg TO flock_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM flock_app;
GRANT USAGE ON SCHEMA public TO flock_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO flock_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO flock_app;
ALTER DEFAULT PRIVILEGES FOR ROLE flock IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO flock_app;
ALTER DEFAULT PRIVILEGES FOR ROLE flock IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO flock_app;
COMMIT;

-- Password rotation alone does not revoke already authenticated legacy pools.
-- Only pre-upgrade network administrator connections are closed; provisioning
-- uses this local socket and runtime-role sessions keep running.
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
  WHERE usename = 'flock' AND client_addr IS NOT NULL AND pid <> pg_backend_pid();
