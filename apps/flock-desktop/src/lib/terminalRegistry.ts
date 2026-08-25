import type { Terminal as XTerm } from "@xterm/xterm";
import type { IntentSniffer } from "./intentSniffer";
import { firstUrl } from "./terminalLinks";

// Terminal.tsx owns one XTerm instance per pane but App.tsx builds the pane
// context menu (Copy / Copy URL need the live selection at right-click time)
// — this module is the narrow bridge between the two without prop-drilling
// the xterm instance itself up through PaneArea.
const terminals = new Map<string, XTerm>();

// The same bridge carries each pane's IntentSniffer — the readline-style shadow
// buffer of the user's un-submitted keystrokes — so the context menu can read
// (and clear) what's typed into the agent's input box but not yet sent.
const sniffers = new Map<string, IntentSniffer>();

export function registerTerminal(paneId: string, term: XTerm) {
  terminals.set(paneId, term);
}

/** With `term` given, the entry is removed only when it is that instance's
 *  own. A borrowed pane mounts two Terminals under one pane id, and an
 *  unmounting one ("Return to workspace", tab close) must not evict the entry
 *  the still-mounted instance owns — that silently killed Copy / Copy URL /
 *  Send to Prompt Queue for the pane until a remount. */
export function unregisterTerminal(paneId: string, term?: XTerm) {
  if (term && terminals.get(paneId) !== term) return;
  terminals.delete(paneId);
}

export function getTerminalSelection(paneId: string): string {
  return terminals.get(paneId)?.getSelection() ?? "";
}

/** Drop whatever is selected in a pane. Used when a ⌘-drag rearranges panes:
 *  the drag suppresses xterm's mousedown so no selection should start, but if
 *  one slips through (or was left over from before), it would sit highlighted
 *  under a pane that has since moved. */
export function clearTerminalSelection(paneId: string) {
  terminals.get(paneId)?.clearSelection();
}

export function registerSniffer(paneId: string, sniffer: IntentSniffer) {
  sniffers.set(paneId, sniffer);
}

/** Same ownership guard as [`unregisterTerminal`]. */
export function unregisterSniffer(paneId: string, sniffer?: IntentSniffer) {
  if (sniffer && sniffers.get(paneId) !== sniffer) return;
  sniffers.delete(paneId);
}

/** The pane's current un-submitted input line, or "" when there's no live
 *  sniffer (popped-out/unmounted) or the line is empty. */
export function getInputLine(paneId: string): string {
  return sniffers.get(paneId)?.currentLine() ?? "";
}

/** Keep the sniffer in sync when text reaches the input line without passing
 *  through this pane's xterm onData — every such path must call this or the
 *  tracked line goes stale and "Send to Prompt Queue" captures a fragment.
 *  Current callers: staged image paths (imageAttach), dropped file paths
 *  (usePtyFileDrop), voice dictation, a co-pilot partner's keystrokes
 *  (streamPublisher), broadcast-group panes (Terminal), and both prompt-queue
 *  insert paths (App: sendPromptToPane, launchQueueItem).
 *  Pass the bytes exactly as sent, escape sequences included — the sniffer
 *  models bracketed-paste wrappers, so a bracketed multi-line paste is tracked
 *  as newlines rather than a submit. */
export function noteInjectedInput(paneId: string, text: string) {
  sniffers.get(paneId)?.feed(text);
}

/** Build the key bytes that clear the pane's input line and reset the tracked
 *  buffer. Emits a full line of forward-deletes AND a full line of backspaces:
 *  whatever the real cursor position, one direction sweeps the head and the
 *  other the tail, so a cursor that drifted out of sync (e.g. Claude Code's
 *  autocomplete swallowing arrow keys) can't leave stray characters behind.
 *  Excess deletes at either end are harmless no-ops. Returns null when the line
 *  is already empty. */
export function clearInputLineBytes(paneId: string): Uint8Array | null {
  const sniffer = sniffers.get(paneId);
  if (!sniffer) return null;
  const len = sniffer.currentLine().length;
  if (len === 0) return null;
  const bytes: number[] = [];
  for (let i = 0; i < len; i++) bytes.push(0x1b, 0x5b, 0x33, 0x7e); // ESC[3~ (Delete) — sweep the tail
  for (let i = 0; i < len; i++) bytes.push(0x7f); // DEL (Backspace) — sweep the head
  sniffer.reset();
  return new Uint8Array(bytes);
}

/** The pane's full visible buffer (scrollback + screen) as plain text, capped
 *  to the TAIL `maxChars` characters — the end of a review agent's output is
 *  where its verdict lives. Empty string when the terminal isn't mounted. */
export function getTerminalBuffer(paneId: string, maxChars = 8000): string {
  const term = terminals.get(paneId);
  if (!term) return "";
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i++) {
    lines.push(buf.getLine(i)?.translateToString(true) ?? "");
  }
  const text = lines.join("\n").trim();
  return text.length > maxChars ? text.slice(text.length - maxChars) : text;
}

/** First URL found within the pane's current selection, if any. Delimited by
 *  the same matcher the clickable-link provider uses, so "Copy URL" and
 *  clicking the link give you the same string. */
export function getSelectionUrl(paneId: string): string | null {
  const selection = getTerminalSelection(paneId);
  if (!selection) return null;
  return firstUrl(selection);
}
