#!/usr/bin/env bash
# Launch a built flock.app, touch it the way a person would, and fail if it
# dies. Runs from scripts/release.sh between the build and the publish, so a
# build that cannot survive a click never reaches anyone's auto-update.
#
# Why this exists, specifically:
#
#   0.7.30  aborted the process on the *first click* of any titlebar. The cause
#           was an Objective-C selector that does not resolve until runtime, so
#           it compiled clean and passed every test.
#   0.7.30  also turned the scroll wheel into prompt-history navigation, which
#   0.7.31  no test could see either, because the behaviour lives in the agent
#           on the far side of a pty.
#
# Both were shipped to every install inside one day. Unit tests, tsc and clippy
# were all green for both. The only thing that would have caught them is what
# this script does: run the actual bundle and drive it.
#
# Usage:  scripts/smoke.sh [path-to-flock.app]
# Exit:   0 pass, non-zero fail (release.sh aborts on non-zero)
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP="${1:-$REPO_DIR/target/release/bundle/macos/flock.app}"
BIN="$APP/Contents/MacOS/flock-desktop"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() { echo "!! smoke: $*" >&2; exit 1; }
step() { echo "── smoke: $*"; }

[ -x "$BIN" ] || fail "no executable at $BIN"

# ── Accessibility ────────────────────────────────────────────────────────────
# Everything below is synthetic input, which macOS refuses to deliver without
# Accessibility permission for the process running this script. Refused input
# is silent: the app just sits there and every assertion passes. That is a
# smoke test that certifies nothing, so prove the permission first and stop if
# it is missing rather than shipping on a vacuous pass.
osascript -e 'tell application "System Events" to return name of first process' >/dev/null 2>&1 \
  || fail "no Accessibility permission for this terminal.
   System Settings → Privacy & Security → Accessibility → enable your terminal.
   Refusing to pass a smoke test whose input cannot reach the app."

step "building input driver"
clang -o "$WORK/input" "$REPO_DIR/scripts/smoke-input.c" -framework ApplicationServices \
  || fail "could not build smoke-input.c"

# ── Isolation ────────────────────────────────────────────────────────────────
# A fresh HOME, so the smoke run cannot touch the real ~/.flock: launching the
# installed app against it restores every saved workspace and spawns a real
# agent in each, which is a lot of side effect for a release check, and it
# would race the copy the user already has open.
#
# The cost is that a clean profile lands on the sign-in gate rather than the
# cockpit, so this covers window chrome and startup, not panes. See the
# follow-up note at the bottom.
export HOME="$WORK/home"
mkdir -p "$HOME"

crash_count() { ls "$1"/flock-desktop-*.ips 2>/dev/null | wc -l | tr -d ' '; }
SYSTEM_REPORTS="$(eval echo ~"$(id -un)")/Library/Logs/DiagnosticReports"
before_crashes="$(crash_count "$SYSTEM_REPORTS")"

step "launching $(basename "$APP")"
"$BIN" >"$WORK/app.log" 2>&1 &
APP_PID=$!
# The app is killed however this script exits, including on a failed assertion
# — a smoke test must never leave a stray copy of flock running.
# The `wait` reaps the killed child inside the trap: without it bash prints its
# own "Terminated: 15" job notice after the PASS line, which reads like the
# smoke test failed at the moment it succeeded.
trap 'kill "$APP_PID" 2>/dev/null || true; wait "$APP_PID" 2>/dev/null || true; rm -rf "$WORK"' EXIT

alive() { kill -0 "$APP_PID" 2>/dev/null; }

# ── Window ───────────────────────────────────────────────────────────────────
# The AppleScript lives in a file rather than a heredoc inside $( ): bash parses
# that combination badly and fails with an unmatched paren before it ever runs.
cat >"$WORK/geom.applescript" <<'OSA'
on run argv
  tell application "System Events"
    tell (first process whose unix id is (item 1 of argv as integer))
      set w to first window
      set pz to get position of w
      set sz to get size of w
      -- `as text` on each: AppleScript's & on two integers builds a *list*, not
      -- a string, and the reply comes back as "215, ,87" which no shell can parse.
      return ((item 1 of pz) as text) & "," & ((item 2 of pz) as text) & "," & ((item 1 of sz) as text) & "," & ((item 2 of sz) as text)
    end tell
  end tell
end run
OSA

step "waiting for a window"
geom=""
for _ in $(seq 1 60); do
  alive || fail "process exited during startup
$(tail -20 "$WORK/app.log")"
  geom="$(osascript "$WORK/geom.applescript" "$APP_PID" 2>/dev/null || true)"
  geom="${geom// /}"
  # Only accept a shape we can do arithmetic on — a partial or oddly-coerced
  # reply must not silently become a zero coordinate that clicks the corner of
  # the screen and asserts nothing.
  if [[ "$geom" =~ ^-?[0-9]+,-?[0-9]+,[0-9]+,[0-9]+$ ]]; then break; fi
  geom=""
  sleep 1
done
[ -n "$geom" ] || fail "no window appeared within 60s"

IFS=, read -r WX WY WW WH <<<"$geom"
step "window at ${WX},${WY} ${WW}x${WH}"

# Titlebar strip, left of centre: clear of the traffic lights on the left and
# of whatever pill the app centres in the bar.
TBX=$((WX + WW / 4))
TBY=$((WY + 12))
# Middle of the content area, for the wheel.
BODYX=$((WX + WW / 2))
BODYY=$((WY + WH / 2))

check() {
  sleep 1
  alive || fail "process died after: $1
$(tail -20 "$WORK/app.log")"
  now="$(crash_count "$SYSTEM_REPORTS")"
  [ "$now" = "$before_crashes" ] || fail "a crash report was written after: $1"
}

step "clicking the titlebar"
"$WORK/input" click "$TBX" "$TBY"; check "titlebar click"

step "double-clicking the titlebar"
"$WORK/input" dblclick "$TBX" "$TBY"; check "titlebar double-click"

step "dragging the window"
"$WORK/input" drag "$TBX" "$TBY" -120 40; check "window drag"
# Put it back, so a failure later leaves the window where we found it.
"$WORK/input" drag $((TBX - 120)) $((TBY + 40)) 120 -40; check "window drag back"

step "scrolling the body"
"$WORK/input" scroll "$BODYX" "$BODYY" 5;  check "scroll up"
"$WORK/input" scroll "$BODYX" "$BODYY" -5; check "scroll down"

step "window still present"
osascript -e "tell application \"System Events\" to tell (first process whose unix id is $APP_PID) to return count of windows" >/dev/null 2>&1 \
  || fail "the window went away"


# ── Phase B: the cockpit ─────────────────────────────────────────────────────
# Everything above drives window chrome on a clean profile, which never gets
# past the sign-in gate. That caught 0.7.30's crash and would have missed
# 0.7.30/0.7.31's wheel regression entirely, because that one lives in an agent
# on the far side of a pty.
#
# So: seed a throwaway profile with two stub-agent panes (reusing the benchmark
# harness's seeder, which drives flock's own restore path rather than a test
# hook), scroll one, and ask the stub what it was sent. If the wheel is being
# translated into cursor keys again, the stub sees ESC [ A and this fails.
#
# Requires a signed-in flock ID session to copy, because the cockpit is gated on
# one. Absent that we warn and skip rather than fail: a release machine without
# a session should ship with reduced coverage, not be blocked. The warning is
# loud so a skipped phase is never mistaken for a passed one.
AUTH_SRC="$(eval echo ~"$(id -un)")/Library/WebKit/app.flock.desktop"
if [ ! -d "$AUTH_SRC" ]; then
  echo "!! smoke: no flock ID session at $AUTH_SRC — SKIPPING the cockpit phase."
  echo "   Coverage is window chrome only. Panes, terminals and the scroll"
  echo "   regression test did NOT run."
  echo "── smoke: PASS (chrome only)"
  exit 0
fi

kill "$APP_PID" 2>/dev/null || true; wait "$APP_PID" 2>/dev/null || true

B="$WORK/cockpit"
mkdir -p "$B/home" "$B/repo" "$B/ready"
git -C "$B/repo" init -q 2>/dev/null || true
export SMOKE_STDIN_LOG="$B/stdin.hex"
export SMOKE_READY_DIR="$B/ready"
: > "$SMOKE_STDIN_LOG"

step "seeding a 2-pane profile"
HOME="$(eval echo ~"$(id -un)")" /usr/bin/python3 "$REPO_DIR/scripts/bench/seed_flock_profile.py" \
  --home "$B/home" --repo "$B/repo" --panes 2 \
  --stub "$REPO_DIR/scripts/smoke_stub_agent.py" --app "$APP" >"$B/seed.log" 2>&1 \
  || fail "could not seed a profile
$(tail -15 "$B/seed.log")"

export HOME="$B/home"
step "launching into the cockpit"
"$BIN" >"$B/app.log" 2>&1 &
APP_PID=$!
trap 'kill "$APP_PID" 2>/dev/null || true; wait "$APP_PID" 2>/dev/null || true; rm -rf "$WORK"' EXIT

step "waiting for 2 panes to report ready"
for _ in $(seq 1 90); do
  alive || fail "process exited while opening the cockpit
$(tail -20 "$B/app.log")"
  [ "$(ls "$B/ready" 2>/dev/null | wc -l | tr -d ' ')" = "2" ] && break
  sleep 1
done
[ "$(ls "$B/ready" 2>/dev/null | wc -l | tr -d ' ')" = "2" ] \
  || fail "only $(ls "$B/ready" 2>/dev/null | wc -l | tr -d ' ')/2 panes came up in 90s
$(tail -20 "$B/app.log")"
check "opening two agent panes"

geom="$(osascript "$WORK/geom.applescript" "$APP_PID" 2>/dev/null || true)"
geom="${geom// /}"
[[ "$geom" =~ ^-?[0-9]+,-?[0-9]+,[0-9]+,[0-9]+$ ]] || fail "no cockpit window"
IFS=, read -r WX WY WW WH <<<"$geom"

# NOT asserted here, deliberately: whether the wheel reaches the agent.
#
# The intent was to scroll a pane and check the stub was not sent ESC [ A/B —
# the 0.7.30/0.7.31 regression. The mechanism is real (xterm's wheel handler
# sends cursor keys when the app has not requested wheel reporting and the alt
# buffer has no scrollback), and the stub models Claude Code's mouse contract so
# it can be reproduced. What I could not do is get synthetic input to land
# reliably inside a specific pane: the stub is alive with the pty on stdin and
# the env it needs, and neither a click nor a keystroke nor a scroll at the
# pane's centre reached it.
#
# An assertion that cannot fail is worse than no assertion, because it reads as
# coverage. The regression is pinned in Rust instead — see
# `commands.rs::the_pane_env_keeps_the_wheel_alive`. Landing input inside a pane
# is the work that would make this a real end-to-end check.

echo "── smoke: PASS (chrome + cockpit)"

# Known gap, on purpose rather than by omission: a clean HOME means this never
# reaches the cockpit, so panes, terminals and agent output are not covered —
# and the wheel test above therefore scrolls the sign-in gate, not a pty. That
# still catches a crash-on-scroll, but it would NOT have caught 0.7.30's
# wheel-becomes-prompt-history regression. Closing that needs a signed-in
# fixture profile with a stub agent; worth doing next.
