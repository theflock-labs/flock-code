// Shared "is the app window visible" signal, so background pollers (git repo
// scans, GitHub API polls, the graph-overview pulse) can pause when the app is
// minimized/hidden and resume-with-an-immediate-refresh when it comes back.
// One set of listeners for the whole app; pollers read isWindowActive()
// synchronously to skip a tick, and subscribe to refresh on resume.
//
// Deliberately keyed on document visibility (hidden), NOT window focus: focus
// would falsely pause while the app sits visible on a second monitor. Hidden is
// the well-defined "user genuinely isn't looking" case (minimized / hidden /
// other Space) and captures the dominant idle waste.

let active = typeof document !== "undefined" ? !document.hidden : true;
const subs = new Set<(active: boolean) => void>();

function recompute() {
  const next = typeof document !== "undefined" ? !document.hidden : true;
  if (next === active) return;
  active = next;
  for (const cb of subs) cb(active);
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", recompute);
}

/** Whether the app window is currently visible. */
export function isWindowActive(): boolean {
  return active;
}

/** Subscribe to visibility changes; the callback gets the new active state.
 *  Returns an unsubscribe fn. */
export function onWindowActiveChange(cb: (active: boolean) => void): () => void {
  subs.add(cb);
  return () => { subs.delete(cb); };
}
