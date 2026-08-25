// Helpers for workspace tabs — each tab is an independent split-pane layout
// within a workspace (like a terminal app's tabs). See WorkspaceTab in
// types.ts for why panes live on the workspace rather than the tab.

import { allPaneIds } from "./layout";
import type { Workspace, WorkspaceTab } from "../types";

let counter = 0;
function newTabId(): string {
  counter += 1;
  return `tab-${Date.now()}-${counter}`;
}

export function makeTab(name: string): WorkspaceTab {
  return { id: newTabId(), name, layoutTree: null, focusedPaneId: null, zoomedPaneId: null };
}

export function getFocusedTab(ws: Workspace): WorkspaceTab {
  return ws.tabs.find((t) => t.id === ws.focusedTabId) ?? ws.tabs[0];
}

/** Which tab (if any) currently has `paneId` somewhere in its layout tree. */
export function findTabForPane(ws: Workspace, paneId: string): WorkspaceTab | undefined {
  return ws.tabs.find((t) => t.layoutTree && allPaneIds(t.layoutTree).includes(paneId));
}

/** True if `paneId` isn't laid out in any tab — i.e. it's popped out into
 * its own window, or (transiently) mid-spawn. */
export function isPaneInAnyTab(ws: Workspace, paneId: string): boolean {
  return findTabForPane(ws, paneId) !== undefined;
}
