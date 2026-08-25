#!/usr/bin/env python3
"""A fake agent for the release gate: paints a pane, and records what it is sent.

The recording half is the point. The gate can already tell that the app did not
crash, but 0.7.30 and 0.7.31 shipped a bug no crash check could see: with mouse
reporting turned off, xterm fell back to alternate-scroll and translated the
scroll wheel into Up/Down arrow keys, which Claude Code reads as prompt history.
Scrolling a pane walked the input history and there was no way to read an
agent's output. Three tsc-clean, test-green releases went out with it.

That failure is only visible from inside the agent, because the arrow keys are
delivered over the pty and consumed there. So this stub writes every byte it is
sent to `$SMOKE_STDIN_LOG`, and the gate scrolls a pane and then asserts no
cursor-key sequence arrived. It is the one test that would have caught it.

Spawned under the name `codex` via seed_flock_profile.py's wrapper, because
`commands.rs` allowlists only claude/opencode/codex/pi.
"""

from __future__ import annotations

import os
import sys
import threading
import time

PANE = os.environ.get("FLOCK_PANE_ID", os.environ.get("CLARENCE_PANE_ID", "?"))
STDIN_LOG = os.environ.get("SMOKE_STDIN_LOG", "")
READY_DIR = os.environ.get("SMOKE_READY_DIR", "")

# Matches what agentBoot watches for, so the pane leaves its boot card and the
# terminal is actually visible — a gate that scrolled a boot card would prove
# nothing.
BANNER = "smoke stub ready"


def mouse_modes() -> list[str]:
    """The DECSET modes a real Claude Code would enable, given flock's env.

    This mapping is not invented — it was measured by driving `claude` under a
    pty with the fullscreen renderer on:

        nothing set              -> ?1000 ?1002 ?1003 ?1006
        DISABLE_MOUSE=1          -> none
        DISABLE_MOUSE_CLICKS=1   -> ?1000 ?1006

    Honouring it is what makes the scroll assertion mean anything. A stub that
    always enabled mouse reporting could never see the regression; one that
    never enabled it would fail every version, including the fixed ones. The
    bug is a *disagreement* between what flock asks the agent to do and what
    that leaves xterm doing with the wheel, so the stub has to obey the same
    request a real agent obeys.
    """
    def on(name: str) -> bool:
        v = os.environ.get(name, "")
        return v not in ("", "0", "false", "False")

    if on("CLAUDE_CODE_DISABLE_MOUSE"):
        return []
    if on("CLAUDE_CODE_DISABLE_MOUSE_CLICKS"):
        return ["1000", "1006"]
    return ["1000", "1002", "1003", "1006"]


def record_stdin() -> None:
    """Append raw bytes from the pty to the log, as hex.

    Hex, not text: the sequences we care about are escape codes, and a text log
    of "\\x1b[A" is ambiguous about whether the app sent an escape or the four
    literal characters. Unbuffered and flushed per read so the gate can assert
    immediately after scrolling rather than waiting on process exit.
    """
    if not STDIN_LOG:
        return
    fd = sys.stdin.fileno()
    with open(STDIN_LOG, "ab", buffering=0) as log:
        while True:
            try:
                chunk = os.read(fd, 4096)
            except OSError:
                return
            if not chunk:
                return
            log.write(chunk.hex().encode() + b"\n")


def main() -> int:
    # A real agent answers --version and friends; flock probes before spawning.
    if len(sys.argv) > 1 and sys.argv[1] in ("--version", "-v", "--help", "-h"):
        print("smoke-stub 1.0")
        return 0

    threading.Thread(target=record_stdin, daemon=True).start()

    out = sys.stdout
    # The alternate screen is the whole point. xterm only falls back to
    # alternate-scroll — turning the wheel into cursor keys — in the alt buffer,
    # because that is the buffer with no scrollback of its own. A stub that
    # stayed on the main screen would scroll xterm's own scrollback and pass
    # every version, which is exactly what the first draft of this did.
    out.write("\x1b[?1049h")
    for mode in mouse_modes():
        out.write(f"\x1b[?{mode}h")
    out.write(f"{BANNER} pane={PANE}\r\n")
    # Enough lines to fill any pane, so the viewport has something to scroll
    # and the gate is not scrolling empty space.
    for i in range(200):
        out.write(f"line {i:04d} " + "." * 60 + "\r\n")
    out.flush()

    # Tell the gate this pane is up. A file per pane, so it can wait for all N
    # rather than sleeping and hoping.
    if READY_DIR:
        os.makedirs(READY_DIR, exist_ok=True)
        with open(os.path.join(READY_DIR, PANE), "w") as f:
            # Record the decision, not just readiness: if the scroll assertion
            # never fires, the first question is always whether the stub set the
            # mouse modes it was supposed to.
            f.write("ready modes=%s DISABLE_MOUSE=%r DISABLE_MOUSE_CLICKS=%r\n" % (
                ",".join(mouse_modes()) or "none",
                os.environ.get("CLAUDE_CODE_DISABLE_MOUSE"),
                os.environ.get("CLAUDE_CODE_DISABLE_MOUSE_CLICKS")))

    # Stay alive: a pane whose process exits shows "[process exited]" and stops
    # being a terminal under test.
    while True:
        time.sleep(1)


if __name__ == "__main__":
    sys.exit(main())
