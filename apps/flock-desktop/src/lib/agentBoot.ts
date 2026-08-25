// Telling "flock is still getting this pane ready" apart from "the agent is
// drawing in it".
//
// A fresh pane is not the agent yet: it is a login shell starting, the echoed
// `eval` line, a worktree's `npm ci`, a secure pane's image build. All of that
// used to scroll past before Claude Code or Codex finally painted, which read
// as flock being slow at something the user never asked to watch. So the pane
// spawn writes one marker on the tty in the instant before the agent runs
// (`AGENT_START_MARKER` in crates/flock-pty/src/lib.rs — the two must stay
// byte-identical), and the boot card stays up until the agent paints.

/** The OSC the launch line emits immediately before the agent. Swallowed by
 *  xterm's parser, so it is never visible in the pane. */
export const AGENT_START_MARKER = "\x1b]777;flock;agent\x07";

const enc = new TextEncoder();
const MARKER = enc.encode(AGENT_START_MARKER);
/** Entering the alternate screen: how a full-screen TUI announces it is taking
 *  the terminal over. Claude Code and opencode both do this as their first act
 *  of painting; Codex draws inline and never does. */
const ALT_SCREEN = enc.encode("\x1b[?1049h");

/** Printable bytes in a row that mean the agent is writing something a person
 *  can read, rather than negotiating with the terminal. Long enough to clear
 *  the capability probes an agent fires first (`\x1b[?1004h`, `\x1b]11;?\x07`,
 *  `\x1b[>0q` — six printable characters at the outside), short enough that any
 *  real first frame, or a plain shell's prompt, trips it at once. */
const PAINT_RUN = 8;

/** How long to wait for a paint that never comes before showing the terminal
 *  anyway. An agent that has said nothing for this long after being launched
 *  is one whose own screen is the only honest thing left to show. Enforced by
 *  the caller, on a timer: the point of it is the case where no further bytes
 *  arrive at all, which no amount of scanning can catch. */
export const PAINT_GRACE_MS = 1500;

/** What `feed` saw. `armed` is the marker: flock is done, the agent is
 *  launched, and the grace timer starts from here. `start` is the agent
 *  actually drawing. */
export type BootSignal = "none" | "armed" | "start";

/** Watches one pane's byte stream and reports the moment the agent's own
 *  output starts.
 *
 *  Not the marker itself: the marker is written by the shell in the instant
 *  *before* the agent runs, and an agent then spends up to a second probing
 *  the terminal before its first frame (measured: Claude Code paints ~960ms
 *  after the marker). Lifting the card there would trade the boot noise for a
 *  blank screen, so the marker only arms the scanner.
 *
 *  Stateful because PTY output arrives in arbitrary chunks and the marker can
 *  straddle two of them: the last few bytes of every chunk are carried into
 *  the next comparison. */
export class BootScanner {
  private tail = new Uint8Array(0);
  private armed = false;
  private done = false;

  /** Reports the marker and, later, the agent's first painting — each once. A
   *  pane boots once, so everything after `start` is `none`, including the
   *  marker replayed from the output ring on a later remount. */
  feed(chunk: Uint8Array): BootSignal {
    if (this.done) return "none";
    let rest = chunk;
    let armedNow = false;
    if (!this.armed) {
      const hay = this.tail.length === 0 ? chunk : concat(this.tail, chunk);
      const at = indexOf(hay, MARKER);
      if (at === -1) {
        this.tail = hay.slice(Math.max(0, hay.length - (MARKER.length - 1)));
        return "none";
      }
      this.armed = true;
      armedNow = true;
      this.tail = new Uint8Array(0);
      // Whatever followed the marker in this same chunk is already the agent's.
      rest = hay.slice(at + MARKER.length);
    }
    // Three ways to say "I am drawing now", because the agents differ: Claude
    // Code and opencode take the alternate screen, Codex erases the main one
    // and draws in place, and a pane that is just a shell simply prints. All
    // three clear the probe traffic (`\x1b[?25h`, `\x1b[c`, `\x1b]11;?\x07`)
    // that the first two spend up to a second on before their first frame.
    if (
      rest.length > 0 &&
      (indexOf(rest, ALT_SCREEN) !== -1 || hasEraseDisplay(rest) || hasPrintableRun(rest, PAINT_RUN))
    ) {
      this.done = true;
      return "start";
    }
    return armedNow ? "armed" : "none";
  }
}

/** Whether `buf` contains an erase-in-display (`CSI [params] J`) — a terminal
 *  saying "this screen is mine now". Deliberately not erase-in-*line*
 *  (`CSI K`), which is what a shell redrawing its prompt emits. */
function hasEraseDisplay(buf: Uint8Array): boolean {
  for (let i = 0; i + 2 < buf.length; i++) {
    if (buf[i] !== 0x1b || buf[i + 1] !== 0x5b) continue; // ESC [
    let j = i + 2;
    // Parameter and intermediate bytes, then the final byte that names it.
    while (j < buf.length && buf[j] >= 0x20 && buf[j] <= 0x3f) j++;
    if (j < buf.length && buf[j] === 0x4a) return true; // J
  }
  return false;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function indexOf(hay: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/** Whether `buf` holds `n` printable bytes in a row. Anything from 0x80 up
 *  counts: an agent's first frame is mostly box-drawing characters, and no
 *  escape sequence carries them. */
function hasPrintableRun(buf: Uint8Array, n: number): boolean {
  let run = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    run = (b >= 0x20 && b !== 0x7f) || b >= 0x80 ? run + 1 : 0;
    if (run >= n) return true;
  }
  return false;
}
