#!/usr/bin/env python3
"""Write a flock profile that opens N stub-agent panes on launch, with no GUI.

flock has no CLI and no scripted way to open a pane, but it does have a
restore path: `workspace_state` holds one JSON blob per workspace, and on
launch the frontend re-spawns every pane in it from the saved `cmd`, `args`
and `cwd`. Seeding that blob is therefore a supported code path being used as
written, not a test hook bolted on for the benchmark — the panes come up
exactly as a user's saved workspace comes up.

Two constraints shape the result:

  * `commands.rs` allowlists the spawnable commands to claude/opencode/codex/pi.
    The stub therefore has to *be* one of those names. `codex` is the one with
    no real binary anywhere on the PATH flock builds (`augmented_path()` puts
    $HOME/.local/bin first, then homebrew — and homebrew here has a real `pi`),
    so the stub is installed at $HOME/.local/bin/codex inside the throwaway
    profile and wins resolution outright.

  * The restore path bumps no usage counters. `recordUsage` fires on *creating*
    a workspace or agent, never on restoring one, and the token sync reads
    ~/.claude/projects which does not exist under a throwaway HOME. So a run
    that seeds and restores reports nothing to flock ID, which matters because
    the app needs a real signed-in session to get past its cockpit gate.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
import uuid

# /usr/bin/python3 by name, not sys.executable: the same interpreter has to run
# the stub in both apps or the per-pane workload is not the same workload. The
# system python is the one thing guaranteed present and identical on both sides.
WRAPPER = """#!/bin/sh
# flock's spawn allowlist only permits claude/opencode/codex/pi, so the stub
# agent has to answer to one of those names. exec, so this shell is replaced
# and the process tree stays the shape a real agent would give it.
exec /usr/bin/python3 {stub} "$@"
"""


def grid(n: int) -> tuple[int, int]:
    """Rows x cols, matching the app's own grid presets closely enough that the
    pane geometry (and therefore the terminal size each stub writes into) is
    the natural one for N."""
    return {1: (1, 1), 2: (1, 2), 4: (2, 2), 6: (2, 3), 8: (2, 4), 12: (3, 4)}.get(
        n, (1, n)
    )


def build_grid_layout(pane_ids: list[str], rows: int, cols: int) -> dict:
    """Port of buildGridLayout in src/lib/layout.ts."""

    def combine_h(ids):
        if len(ids) == 1:
            return {"type": "leaf", "paneId": ids[0]}
        mid = len(ids) // 2
        return {"type": "split", "dir": "horizontal", "ratio": mid / len(ids),
                "first": combine_h(ids[:mid]), "second": combine_h(ids[mid:])}

    def combine_v(nodes):
        if len(nodes) == 1:
            return nodes[0]
        mid = len(nodes) // 2
        return {"type": "split", "dir": "vertical", "ratio": mid / len(nodes),
                "first": combine_v(nodes[:mid]), "second": combine_v(nodes[mid:])}

    row_nodes = [combine_h(pane_ids[r * cols:(r + 1) * cols]) for r in range(rows)]
    return combine_v(row_nodes)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--home", required=True, help="throwaway HOME to build")
    ap.add_argument("--repo", required=True, help="cwd for every pane; must exist")
    ap.add_argument("--panes", type=int, required=True)
    ap.add_argument("--stub", required=True, help="path to bench_stub_agent.py")
    ap.add_argument("--app", required=True, help="path to flock.app")
    ap.add_argument("--copy-auth-from", default=os.path.expanduser("~"),
                    help="real HOME to copy the signed-in flock ID session from")
    args = ap.parse_args()

    home = os.path.abspath(args.home)
    os.makedirs(home, exist_ok=True)

    # ── The stub, under the name flock will spawn ────────────────────────────
    binroot = os.path.join(home, ".local", "bin")
    os.makedirs(binroot, exist_ok=True)
    wrapper = os.path.join(binroot, "codex")
    with open(wrapper, "w") as f:
        f.write(WRAPPER.format(stub=os.path.abspath(args.stub)))
    os.chmod(wrapper, 0o755)

    # ── The signed-in session ────────────────────────────────────────────────
    # flock renders a sign-in gate instead of the cockpit without a flock ID
    # session, and the session lives in the webview's localStorage under
    # ~/Library/WebKit/app.flock.desktop. Copied, never moved or written back:
    # the real profile is only ever read.
    src = os.path.join(args.copy_auth_from, "Library", "WebKit", "app.flock.desktop")
    dst = os.path.join(home, "Library", "WebKit", "app.flock.desktop")
    if os.path.isdir(src) and not os.path.exists(dst):
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copytree(src, dst)
        print(f"seed: copied flock ID session from {src}")
    elif not os.path.isdir(src):
        print(f"seed: WARNING no webview profile at {src} — the app will land on "
              f"the sign-in gate and no panes will spawn", file=sys.stderr)

    # ── First launch: let the app run its own migrations ─────────────────────
    # Hand-writing the schema would silently rot the moment a migration lands,
    # and ~/.flock must never be built by hand (flock_core::paths owns it). So
    # the app builds it: launch, wait for flock.db, quit.
    # Two candidates, because `data_dir()` is dev-aware: a release bundle writes
    # ~/.flock, a debug one ~/.flock-dev. Looking only for the release path made
    # the release gate fail on a debug build with "the app never created
    # flock.db" while the app was up and healthy beside it.
    candidates = [os.path.join(home, ".flock", "flock.db"),
                  os.path.join(home, ".flock-dev", "flock.db")]
    db = candidates[0]
    if not os.path.exists(db):
        env = dict(os.environ, HOME=home)
        binary = os.path.join(args.app, "Contents", "MacOS", "flock-desktop")
        p = subprocess.Popen([binary], env=env,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(600):
            found = next((c for c in candidates if os.path.exists(c)), None)
            if found:
                db = found
                break
            time.sleep(0.1)
        time.sleep(2.0)  # let migrations finish and the file settle
        p.terminate()
        try:
            p.wait(timeout=15)
        except subprocess.TimeoutExpired:
            p.kill()
        db = next((c for c in candidates if os.path.exists(c)), db)
        if not os.path.exists(db):
            print("seed: the app never created flock.db in %s" % " or ".join(
                os.path.dirname(c) for c in candidates), file=sys.stderr)
            return 1
        print(f"seed: {db} created by the app itself")

    # ── The workspace, and its N panes ───────────────────────────────────────
    ws_id = str(uuid.uuid4())
    pane_ids = [str(uuid.uuid4()) for _ in range(args.panes)]
    rows, cols = grid(args.panes)
    state = {
        "agentKind": "codex",
        "useWorktrees": False,
        "secure": False,
        "prReview": False,
        "tabs": [{
            "id": "tab-bench",
            "name": "1",
            "layoutTree": build_grid_layout(pane_ids, rows, cols),
            "focusedPaneId": pane_ids[0],
            "zoomedPaneId": None,
        }],
        "focusedTabId": "tab-bench",
        "panes": [
            {"id": pid, "cmd": "codex", "args": [], "cwd": os.path.abspath(args.repo)}
            for pid in pane_ids
        ],
    }

    conn = sqlite3.connect(db)
    now = int(time.time())
    conn.execute("DELETE FROM workspaces")
    conn.execute(
        "INSERT INTO workspaces (id, name, repo_path, branch, created_at, position)"
        " VALUES (?,?,?,?,?,0)",
        (ws_id, f"bench-{args.panes}", os.path.abspath(args.repo), "main", now),
    )
    conn.execute(
        "INSERT INTO workspace_state (workspace_id, state_json, updated_at) VALUES (?,?,?)",
        (ws_id, json.dumps(state), now),
    )
    conn.commit()
    conn.close()

    print(f"seed: workspace {ws_id} with {args.panes} panes "
          f"({rows}x{cols}) cwd={args.repo}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
