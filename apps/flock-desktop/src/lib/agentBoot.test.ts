import { describe, it, expect } from "vitest";
import { AGENT_START_MARKER, BootScanner } from "./agentBoot";

// The card this drives covers a live terminal, so a scanner that never fires
// leaves an agent hidden behind it until the card's own failsafe — long enough
// to read as the app being broken. And one that fires too early puts the card
// back where it started: showing the user something they didn't ask for, here
// an empty screen. The chunk sequences below are real captures from a pty.

const enc = new TextEncoder();
const bytes = (s: string) => enc.encode(s);

/** Feed chunks in order; return the 1-based index of the chunk that revealed
 *  the pane, or 0 if none did. */
function revealsOn(chunks: string[]): number {
  const s = new BootScanner();
  let at = 0;
  chunks.forEach((c, i) => {
    if (s.feed(bytes(c)) === "start" && at === 0) at = i + 1;
  });
  return at;
}

/** What Claude Code actually writes between the marker and its first frame:
 *  capability probes, ~960ms of them, none of it anything to look at. */
const PROBES = ["\x1b7\x1b[r\x1b8\x1b[?25h", "\x1b[?25l\x1b[?2004h", "\x1b[?1004h\x1b[?2031h", "\x1b]11;?\x07\x1b[c", "\x1b[>0q\x1b[c"];
const ALT_SCREEN = "\x1b[?1049h\x1b[2J\x1b[H\x1b[?1000h";

describe("the boot card lifts when the agent starts painting", () => {
  it("waits for the agent, not for the marker", () => {
    // The marker is written in the instant before the agent runs. Lifting on
    // it would swap the boot noise for a blank screen.
    expect(revealsOn(["shell prompt", AGENT_START_MARKER])).toBe(0);
    expect(revealsOn(["shell prompt", AGENT_START_MARKER, ALT_SCREEN])).toBe(3);
  });

  it("sits through the terminal-capability probes and lifts on the first frame", () => {
    expect(revealsOn([AGENT_START_MARKER, ...PROBES, ALT_SCREEN])).toBe(PROBES.length + 2);
  });

  it("lifts on printed output, for an agent that never leaves the main screen", () => {
    // Codex draws inline: no alt screen ever, so the first readable thing it
    // writes is the signal.
    expect(revealsOn([AGENT_START_MARKER, "\x1b[?2004h\x1b[>4;0m\x1b[>7u", "\x1b[?2026h  ▌ Codex  v0.5"])).toBe(3);
  });

  it("lifts on the same chunk when it carries the agent's first bytes too", () => {
    expect(revealsOn([`${AGENT_START_MARKER}${ALT_SCREEN}`])).toBe(1);
  });

  it("finds a marker split across chunks", () => {
    const half = AGENT_START_MARKER.length >> 1;
    expect(
      revealsOn([
        "· flock: npm ci\r\n",
        AGENT_START_MARKER.slice(0, half),
        AGENT_START_MARKER.slice(half),
        ALT_SCREEN,
      ]),
    ).toBe(4);
  });

  it("finds a marker split one byte at a time", () => {
    expect(revealsOn([...AGENT_START_MARKER.split(""), ALT_SCREEN])).toBe(AGENT_START_MARKER.length + 1);
  });

  it("ignores everything before the marker, however much there is", () => {
    // An install can print megabytes before the agent is even launched.
    expect(revealsOn(["added 402 packages\n".repeat(500)])).toBe(0);
  });

  it("reports the marker, so the caller can start the grace timer", () => {
    const s = new BootScanner();
    expect(s.feed(bytes("shell prompt"))).toBe("none");
    expect(s.feed(bytes(AGENT_START_MARKER))).toBe("armed");
    expect(s.feed(bytes("\x1b[?25l"))).toBe("none");
  });

  it("fires once and only once", () => {
    const s = new BootScanner();
    s.feed(bytes(AGENT_START_MARKER));
    expect(s.feed(bytes("the first frame"))).toBe("start");
    expect(s.feed(bytes("the second frame"))).toBe("none");
    // A remount replays the ring, marker and all, onto a pane already revealed.
    expect(s.feed(bytes(`${AGENT_START_MARKER}again, from the ring`))).toBe("none");
  });
});
