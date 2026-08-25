// Which pop-up toasts the user has told us to stop raising.
//
// A toast is the only surface in flock that interrupts: it covers the corner
// of the window, it has a 45-second timer, and letting it run out DECLINES.
// Four kinds can raise one without the user having clicked anything, and one
// of them (`pr_opened`) fires off a 30-second poll, so an agent having a
// productive afternoon can put a decision in front of you every few minutes.
//
// SUPPRESSING A TOAST MUST NOT SUPPRESS THE EVENT. Every call site pushes a
// notification into the bell feed first and raises the toast second, and the
// guard goes between the two. Turning off the pop-up therefore downgrades the
// event from "interrupt me" to "tell me when I look", which is what a person
// clicking "Don't show again" is asking for. It must never come to mean a
// friend's request to pair was silently dropped.
//
// Suppression is per KIND and permanent until reversed. The reversal lives in
// Settings then Appearance, and the count of what is currently hidden is shown
// there, because a control with no way back is not a preference.

import type { ToastItem } from "../components/SessionToast";

export type ToastKind = ToastItem["kind"];

/** Toast kinds in the order Settings lists them, with the wording used both on
 *  the "Don't show again" confirmation and in the Settings list. */
export const TOAST_KIND_LABELS: Record<ToastKind, string> = {
  pr_opened: "New pull requests",
  observe_request: "Requests to watch your terminal",
  task_send: "Tasks sent to you",
  copilot_invite: "Invitations to co-pilot",
};

const STORAGE_KEY = "flock:toasts-off";
const EVENT = "flock:toasts-off-changed";

type Suppressed = Partial<Record<ToastKind, true>>;

function read(): Suppressed {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    // A map rather than a list so an unknown key from a future version is
    // carried through untouched instead of being dropped on the next write.
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Suppressed;
  } catch {
    // Unreadable storage means we do not know what was suppressed, and the
    // safe answer to that is to interrupt rather than to stay silent.
    return {};
  }
}

function write(next: Suppressed) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* a preference that cannot be saved is not worth taking the window down for */
  }
  // The native `storage` event does not fire in the document that wrote it,
  // so Settings would keep showing the old list. Same pattern as budgets.ts.
  window.dispatchEvent(new Event(EVENT));
}

export function isToastSuppressed(kind: ToastKind): boolean {
  return read()[kind] === true;
}

export function suppressToast(kind: ToastKind) {
  write({ ...read(), [kind]: true });
}

export function unsuppressToast(kind: ToastKind) {
  const next = read();
  delete next[kind];
  write(next);
}

/** Every kind currently hidden, in the order Settings lists them. */
export function suppressedToasts(): ToastKind[] {
  const off = read();
  return (Object.keys(TOAST_KIND_LABELS) as ToastKind[]).filter((k) => off[k] === true);
}

export function showAllToasts() {
  write({});
}

export function onToastSuppressionChange(fn: () => void): () => void {
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
}
