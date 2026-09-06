// Broadcast input ("synchronize panes"): when a tab's broadcast is on, the
// keystrokes typed into its focused pane are replicated to every visible pane in
// that tab — tmux's synchronize-panes, on a switch.
//
// State is ephemeral and module-level (keyed by tab id). It deliberately does
// NOT persist: a sync mode that silently survived a relaunch — quietly fanning
// your typing into every agent — is a footgun. Flip it on when you want it.

import { useEffect, useReducer } from "react";
import { allPaneIds } from "./layout";
import type { Pane, WorkspaceTab } from "../types";

/** Old saved workspaces can each have a tab named `tab-legacy`. A sync mode
 * belongs to one workspace's tab, even when their historical IDs coincide. */
export function broadcastKey(workspaceId: string, tabId: string): string {
  return JSON.stringify([workspaceId, tabId]);
}

/** The same recipients power both the visible disclosure and actual delivery.
 * Borrowed local panes have a real PTY here; streams and pop-out windows do
 * not. Boot cards are excluded until the agent has taken over its terminal. */
export function broadcastRecipients(
  tab: WorkspaceTab,
  panes: readonly Pane[],
  borrowed?: ReadonlyMap<string, { pane: Pane }>,
  poppedOutIds?: ReadonlySet<string>,
): Pane[] {
  const ids = tab.zoomedPaneId
    ? [tab.zoomedPaneId]
    : tab.layoutTree ? allPaneIds(tab.layoutTree) : [];
  const byId = new Map(panes.map((pane) => [pane.id, pane]));
  return [...new Set(ids)].flatMap((id) => {
    const pane = byId.get(id) ?? borrowed?.get(id)?.pane;
    return pane && !pane.streamId && !pane.spawning && !pane.booting && !poppedOutIds?.has(id)
      ? [pane] : [];
  });
}

export function broadcastIsActive(key: string, tab: WorkspaceTab, recipients: readonly Pane[], visible: boolean): boolean {
  return visible && isBroadcasting(key) && recipients.length > 1
    && recipients.some((pane) => pane.id === tab.focusedPaneId);
}

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
