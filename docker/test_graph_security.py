"""Credential/privilege regression test against an isolated disposable database.

Run: python3 -m unittest docker/test_graph_security.py
Never connects to an installed graph or truncates an existing database.
"""

from pathlib import Path
import subprocess
import time
import unittest
import uuid


class GraphCredentialTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.container = f"flock-security-test-{uuid.uuid4().hex}"
        cls.admin = "a" * 64
        cls.runtime = "b" * 64
        subprocess.run([
            "docker", "run", "--rm", "-d", "--name", cls.container,
            "-e", "POSTGRES_USER=flock", "-e", "POSTGRES_PASSWORD=legacy-test-password",
            "-e", "POSTGRES_DB=flock_kg", "-p", "127.0.0.1::5432", "pgvector/pgvector:pg16",
        ], check=True, capture_output=True)
        cls.addClassCleanup(lambda: subprocess.run(["docker", "rm", "-f", cls.container], capture_output=True))
        for _ in range(80):
            result = subprocess.run(["docker", "exec", cls.container, "pg_isready", "-h", "127.0.0.1", "-U", "flock", "-d", "flock_kg"], capture_output=True)
            if result.returncode == 0:
                break
            time.sleep(0.25)
        else:
            raise RuntimeError("Isolated Postgres did not start")
        cls.address = subprocess.run(["docker", "inspect", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", cls.container], capture_output=True, text=True, check=True).stdout.strip()
        schema = Path(__file__).resolve().parents[1] / "apps/flock-desktop/src-tauri/graph"
        cls.sql((schema / "schema.sql").read_text())
        cls.sql("INSERT INTO kg_node(kind,label,body) VALUES ('Note','preserved before rotation','original')")
        legacy = subprocess.Popen(["docker", "exec", "-i", "-e", "PGPASSWORD=legacy-test-password", "-e", "PGAPPNAME=flock-legacy-fixture", cls.container, "psql", "-h", cls.address, "-U", "flock", "-d", "flock_kg", "-c", "SELECT pg_sleep(60)"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        cls.addClassCleanup(lambda: legacy.terminate() if legacy.poll() is None else None)
        for _ in range(40):
            if cls.sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='flock-legacy-fixture'") == "1":
                break
            time.sleep(0.05)
        else:
            raise RuntimeError("Legacy administrator fixture did not connect")
        roles = (schema / "roles.sql").read_text().replace("__ADMIN_PASSWORD__", cls.admin).replace("__RUNTIME_PASSWORD__", cls.runtime)
        cls.sql(roles)
        cls.legacy_exit = legacy.wait(timeout=5)
        cls.sql(roles)  # An interrupted/retried migration must be idempotent.

    @classmethod
    def sql(cls, statement, role="flock", password=None, success=True):
        args = ["docker", "exec", "-i"]
        if password is not None:
            args += ["-e", f"PGPASSWORD={password}"]
        args += [cls.container, "psql", "-U", role, "-d", "flock_kg", "-v", "ON_ERROR_STOP=1", "-Atq"]
        if password is not None:
            args += ["-h", cls.address]
        result = subprocess.run(args, input=statement, text=True, capture_output=True)
        if success and result.returncode:
            raise AssertionError(result.stderr)
        if not success and not result.returncode:
            raise AssertionError("Forbidden database operation unexpectedly succeeded")
        return result.stdout.strip()

    def test_old_password_is_revoked_and_existing_data_survives(self):
        self.sql("SELECT 1", password="legacy-test-password", success=False)
        self.assertEqual(self.sql("SELECT body FROM kg_node WHERE label='preserved before rotation'", "flock_app", self.runtime), "original")

    def test_rotation_disconnects_authenticated_legacy_administrators(self):
        self.assertNotEqual(self.legacy_exit, 0)

    def test_runtime_can_read_and_write_knowledge(self):
        value = self.sql("INSERT INTO kg_node(kind,label) VALUES ('Note','runtime write'); UPDATE kg_node SET body='updated' WHERE label='runtime write'; SELECT body FROM kg_node WHERE label='runtime write'; DELETE FROM kg_node WHERE label='runtime write';", "flock_app", self.runtime)
        self.assertEqual(value, "updated")

    def test_runtime_cannot_administer_the_server_or_schema(self):
        for statement in ["CREATE ROLE escaped", "CREATE DATABASE escaped", "CREATE TABLE escaped(id int)", "ALTER TABLE kg_node ADD escaped int", "SET ROLE flock", "SELECT pg_read_file('/etc/passwd')"]:
            with self.subTest(statement=statement):
                self.sql(statement, "flock_app", self.runtime, success=False)
        self.assertEqual(self.sql("SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls FROM pg_roles WHERE rolname=current_user", "flock_app", self.runtime), "f")

    def test_port_is_only_bound_to_loopback(self):
        address = subprocess.run(["docker", "port", self.container, "5432"], capture_output=True, text=True, check=True).stdout.strip()
        self.assertTrue(address.startswith("127.0.0.1:"), address)


if __name__ == "__main__":
    unittest.main()
