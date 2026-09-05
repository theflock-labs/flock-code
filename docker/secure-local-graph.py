#!/usr/bin/env python3
"""Start/upgrade the legacy development graph without replacing its volume.

Requires a built flock-mcp on PATH (or FLOCK_MCP_BINARY). The desktop stack is
managed by Settings → flock Graph instead; this script only owns flock-pg.
"""

import json
import fcntl
import stat
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parent
SECRETS = ROOT / ".graph-secrets"


def private_write(path, data, exclusive=False):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".pending-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        if exclusive:
            try:
                os.link(tmp, path)
            except FileExistsError:
                pass
        else:
            os.replace(tmp, path)
    finally:
        Path(tmp).unlink(missing_ok=True)


def credentials():
    path = SECRETS / "credentials.json"
    if not path.exists():
        private_write(path, json.dumps({"admin": secrets.token_hex(32), "runtime": secrets.token_hex(32)}), exclusive=True)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.geteuid():
        raise RuntimeError("Saved graph credentials must be an owner-only regular file")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as stream:
        value = json.load(stream)
    for key in ("admin", "runtime"):
        if len(value[key]) != 64 or any(c not in "0123456789abcdef" for c in value[key]):
            raise RuntimeError("Invalid saved graph credentials; restore them from backup, do not regenerate them")
    return value


def run(args, **kwargs):
    result = subprocess.run(args, capture_output=True, text=True, **kwargs)
    if result.returncode:
        # Database/CLI errors may quote SQL or URLs. Never print credential-bearing output.
        raise RuntimeError(f"{Path(args[0]).name} failed; data and saved credentials were preserved. Check database health and retry.")
    return result.stdout


def start():
    binary = os.environ.get("FLOCK_MCP_BINARY") or shutil.which("flock-mcp")
    if not binary:
        raise RuntimeError("Build flock-mcp first: cargo build -p flock-mcp --locked; then set FLOCK_MCP_BINARY=target/debug/flock-mcp")
    value = credentials()
    private_write(SECRETS / "admin-password", value["admin"])
    run(["docker", "compose", "-f", str(ROOT / "compose.yml"), "up", "-d"])
    for _ in range(90):
        ready = subprocess.run(["docker", "exec", "flock-pg", "pg_isready", "-h", "127.0.0.1", "-U", "flock", "-d", "flock_kg"], capture_output=True)
        if ready.returncode == 0:
            break
        time.sleep(1)
    else:
        raise RuntimeError("Graph did not become ready; volume and credentials were preserved")
    sql_path = ROOT.parent / "apps/flock-desktop/src-tauri/graph/roles.sql"
    sql = sql_path.read_text().replace("__ADMIN_PASSWORD__", value["admin"]).replace("__RUNTIME_PASSWORD__", value["runtime"])
    run(["docker", "exec", "-i", "flock-pg", "psql", "-U", "flock", "-d", "flock_kg", "-v", "ON_ERROR_STOP=1", "-q"], input=sql)
    env = dict(os.environ, FLOCK_KG_URL=f"postgresql://flock:{value['admin']}@127.0.0.1:15432/flock_kg")
    run([binary, "migrate"], env=env)
    private_write(SECRETS / "runtime-url", f"postgresql://flock_app:{value['runtime']}@127.0.0.1:15432/flock_kg")
    print("Graph is ready. Runtime-only connection URL is in docker/.graph-secrets/runtime-url (keep it private).")


def main():
    SECRETS.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(SECRETS / "operation.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "r+"):
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("Another graph operation is running; wait and retry")
        start()


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, RuntimeError) as error:
        raise SystemExit(str(error))
