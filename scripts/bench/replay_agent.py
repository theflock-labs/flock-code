#!/usr/bin/env python3
"""A fake agent that replays real Claude Code sessions, at their recorded pace,
in a loop — the output load of a busy Claude Code pane without spending a token.

Uses the website demo's recordings (apps/flock-desktop/src/dev/demo-recordings,
byte-exact captures of Claude Code 2.1.319's fullscreen renderer), picks one by
the pane id so a grid gets a mix, and starts each pane at a different point so
their repaints do not line up. REPLAY_SPEED > 1 plays faster (a heavier load).
Input from the pty is read and dropped, so the agent never blocks on it.
"""

from __future__ import annotations

import glob
import re
import hashlib
import json
import os
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
DIR = os.environ.get(
    "REPLAY_DIR", os.path.join(HERE, "..", "..", "apps", "flock-desktop", "src", "dev", "demo-recordings")
)
SPEED = float(os.environ.get("REPLAY_SPEED", "1"))
# flock runs Claude Code with CLAUDE_CODE_DISABLE_MOUSE_CLICKS, which leaves
# only click and wheel reporting on; the recordings were made without it, so
# their motion-tracking modes are dropped to match what flock really gets.
DROP = [b"\x1b[?1002h", b"\x1b[?1003h"]
# REPLAY_STRIP_COLOR=1 removes 24-bit colours (an experiment: does the load
# depend on how many distinct colours the terminals draw?).
STRIP_COLOR = os.environ.get("REPLAY_STRIP_COLOR") == "1"
TRUECOLOR = re.compile(rb"(?<=[\[;])[34]8;2;\d+;\d+;\d+;?")
PANE = os.environ.get("FLOCK_PANE_ID", str(os.getpid()))


def drain() -> None:
    try:
        while os.read(0, 4096):
            pass
    except OSError:
        pass


def main() -> None:
    files = [f for f in sorted(glob.glob(os.path.join(DIR, "*.json"))) if os.path.getsize(f) > 10_000]
    if not files:
        sys.stderr.write(f"replay_agent: no recordings in {DIR}\n")
        time.sleep(3600)
        return
    seed = int(hashlib.sha1(PANE.encode()).hexdigest(), 16)
    rec = json.load(open(files[seed % len(files)]))
    chunks = rec["chunks"]
    threading.Thread(target=drain, daemon=True).start()
    out = sys.stdout.buffer
    offset = seed % max(1, len(chunks))
    if os.environ.get("REPLAY_IDLE") == "1":
        # Paint the recording once, then sit still: a pane with no output.
        out.write("".join(c for _, c in chunks).encode())
        out.flush()
        while True:
            time.sleep(3600)
    while True:
        start = time.monotonic()
        base = chunks[offset][0] if offset else 0
        for t, text in chunks[offset:]:
            wait = (t - base) / 1000 / SPEED - (time.monotonic() - start)
            if wait > 0:
                time.sleep(wait)
            data = text.encode()
            for seq in DROP:
                data = data.replace(seq, b"")
            if STRIP_COLOR:
                data = TRUECOLOR.sub(b"", data)
            out.write(data)
            out.flush()
        offset = 0
        time.sleep(1.5 / SPEED)
        out.write(b"\x1b[2J\x1b[H")
        out.flush()


if __name__ == "__main__":
    main()
