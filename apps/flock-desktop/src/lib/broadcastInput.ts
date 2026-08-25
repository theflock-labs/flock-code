// Broadcast input ("synchronize panes"): when a tab's broadcast is on, the
// keystrokes typed into its focused pane are replicated to every visible pane in
// that tab — tmux's synchronize-panes, on a switch.
//
// State is ephemeral and module-level (keyed by tab id). It deliberately does
// NOT persist: a sync mode that silently survived a relaunch — quietly fanning
// your typing into every agent — is a footgun. Flip it on when you want it.

import { useEffect, useReducer } from "react";

const enabled = new Set<string>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

export function isBroadcasting(tabId: string): boolean {
  return enabled.has(tabId);
}

export function toggleBroadcast(tabId: string): void {
  if (enabled.has(tabId)) enabled.delete(tabId);
  else enabled.add(tabId);
  notify();
}

/** Drop a tab's flag (call when the tab is closed so it can't linger). */
export function clearBroadcast(tabId: string): void {
  if (enabled.delete(tabId)) notify();
}

export function subscribeBroadcast(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** Re-render on any broadcast toggle; read isBroadcasting(tabId) fresh after. */
export function useBroadcast(): void {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => subscribeBroadcast(bump), []);
}
