// Prompt sniffer, extracted from Terminal.tsx. Runs a minimal readline-style
// line editor over the user's raw keystrokes: `buf` is the current line as an
// array of chars, `cur` the cursor index within it. This is what makes
// deletes/edits reflect accurately — an append-only buffer keeps text the
// user backspaced away, concatenating abandoned drafts. Reads *input*
// (keystrokes); the PTY output loop only ever sees agent output.
//
// Two rules keep the shadow buffer matching what an agent's prompt actually
// holds, since it is also what "Send to Prompt Queue" lifts out: only CR
// submits (LF inserts a newline — Claude Code's Ctrl-J / Option+Enter), and
// nothing submits inside a bracketed paste. Text that reaches the PTY without
// passing through xterm must be replayed here via noteInjectedInput.

const MAX_LINE_CHARS = 500;
const MAX_PROMPT_CHARS = 200;

// Delete the word before the cursor (Ctrl-W / Option+Backspace): skip any
// trailing spaces, then the run of non-spaces.
function deleteWordBefore(buf: string[], cur: number): number {
  let start = cur;
  while (start > 0 && buf[start - 1] === " ") start--;
  while (start > 0 && buf[start - 1] !== " ") start--;
  buf.splice(start, cur - start);
  return start;
}

export class IntentSniffer {
  private buf: string[] = [];
  private cur = 0;
  // True between ESC[200~ and ESC[201~. Inside a bracketed paste no byte
  // submits: agent prompts (and shells) insert the pasted newlines into the
  // input line instead of running it, so the shadow buffer must too — else a
  // multi-line paste is tracked as "first line only".
  private pasting = false;

  /** Discard any half-typed line, e.g. when the pane remounts. */
  reset(): void {
    this.buf = [];
    this.cur = 0;
    this.pasting = false;
  }

  /** The current un-submitted line exactly as typed (untrimmed), newlines
   *  included. Powers the pane context menu's "Send to Prompt Queue" — what's
   *  sitting in the agent's input box but hasn't been submitted yet. */
  currentLine(): string {
    return this.buf.join("");
  }

  /** Feed a chunk of keystrokes; edits the tracked line and returns the first
   *  prompt submitted within the chunk (trimmed, newlines flattened, capped at
   *  200 chars) so the caller can record it as the pane's intent, or null when
   *  nothing was submitted. At most one prompt per feed, but parsing always
   *  runs to the end of the chunk — whatever follows a submit is real input
   *  sitting in the box, and dropping it would leave the buffer stale. */
  feed(data: string): string | null {
    const s = data;
    const buf = this.buf;
    let cur = this.cur;
    let submitted: string | null = null;
    let i = 0;
    while (i < s.length) {
      const code = s.charCodeAt(i);
      if (code === 0x1b) {
        const next = s[i + 1];
        if (next === "[") {
          // CSI: ESC [ <params/intermediates 0x20-0x3f> <final 0x40-0x7e>.
          // Consume the WHOLE sequence (params included) so modified keys
          // like Shift+Arrow (ESC[1;2C) don't leak their "1;2" as text.
          let j = i + 2;
          while (j < s.length && s.charCodeAt(j) >= 0x20 && s.charCodeAt(j) <= 0x3f) j++;
          const params = s.slice(i + 2, j);
          switch (s[j]) {
            case "D": cur = Math.max(0, cur - 1); break;          // ←
            case "C": cur = Math.min(buf.length, cur + 1); break; // →
            case "H": cur = 0; break;                             // Home
            case "F": cur = buf.length; break;                    // End
            case "~":                                             // Home/End/Delete + paste brackets
              if (params === "1" || params === "7") cur = 0;
              else if (params === "4" || params === "8") cur = buf.length;
              else if (params === "3" && cur < buf.length) buf.splice(cur, 1);
              else if (params === "200") this.pasting = true;
              else if (params === "201") this.pasting = false;
              break;
          }
          i = j + 1;
        } else if (next === "O") {
          // SS3 (application cursor keys): ESC O <final>.
          switch (s[i + 2]) {
            case "D": cur = Math.max(0, cur - 1); break;
            case "C": cur = Math.min(buf.length, cur + 1); break;
            case "H": cur = 0; break;
            case "F": cur = buf.length; break;
          }
          i += 3;
        } else if (next === "P" || next === "]" || next === "X" || next === "^" || next === "_") {
          // String-terminated sequences (DCS/OSC/SOS/PM/APC). These arrive on
          // *input* because xterm auto-answers the queries an agent's TUI
          // makes on startup/redraw — device attributes, cursor position,
          // terminal version, background color. Consume the whole payload
          // through its terminator (ST = ESC \, or BEL for OSC) so the reply
          // body can't leak into the captured prompt as garbage text.
          let j = i + 2;
          while (j < s.length) {
            const c = s.charCodeAt(j);
            if (c === 0x07) { j++; break; }                      // BEL
            if (c === 0x1b && s[j + 1] === "\\") { j += 2; break; } // ST
            j++;
          }
          i = j;
        } else if (s.charCodeAt(i + 1) === 0x7f || next === "b" || next === "B") {
          cur = deleteWordBefore(buf, cur); // Option/Meta + Backspace
          i += 2;
        } else {
          i += 2; // some other escape — skip ESC + its final byte
        }
        continue;
      }
      if (code === 0x0a && s.charCodeAt(i - 1) === 0x0d) {
        i++; // CRLF pair — the CR already did the work, don't count it twice
        continue;
      }
      if (code === 0x0d && !this.pasting) {
        // Enter submits. LF (0x0a) does NOT: agent prompts bind it to "insert a
        // newline" (Claude Code's Ctrl-J / Option+Enter), and it is how
        // multi-line text lands when we type a queued prompt into a pane.
        const prompt = buf.join("").replace(/\n/g, " ").trim();
        buf.length = 0;
        cur = 0;
        if (prompt.length > 0 && submitted === null) {
          submitted = prompt.slice(0, MAX_PROMPT_CHARS);
        }
      } else if (code === 0x0a || code === 0x0d) {
        // A newline that doesn't submit — inside a bracketed paste, or LF.
        if (buf.length < MAX_LINE_CHARS) { buf.splice(cur, 0, "\n"); cur++; }
      } else if (code === 0x7f || code === 0x08) {
        if (cur > 0) { buf.splice(cur - 1, 1); cur--; } // backspace
      } else if (code === 0x17) {
        cur = deleteWordBefore(buf, cur); // Ctrl-W delete word
      } else if (code === 0x15) {
        buf.splice(0, cur); cur = 0; // Ctrl-U delete to line start
      } else if (code === 0x0b) {
        buf.splice(cur); // Ctrl-K delete to line end
      } else if (code === 0x01) {
        cur = 0; // Ctrl-A start of line
      } else if (code === 0x05) {
        cur = buf.length; // Ctrl-E end of line
      } else if (code === 0x03) {
        buf.length = 0; cur = 0; // Ctrl-C clears the line
      } else if (code >= 0x20 && buf.length < MAX_LINE_CHARS) {
        buf.splice(cur, 0, s[i]); cur++; // printable — insert at cursor
      }
      i++;
    }
    this.cur = cur;
    return submitted;
  }
}
