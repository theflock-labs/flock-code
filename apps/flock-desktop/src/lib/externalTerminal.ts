// Which real terminal emulator the "open a terminal here" button launches.
//
// Detection is a backend call (a bundle scan, see src-tauri/terminals.rs) and
// the answer only changes when the user installs an app, so it's fetched once
// per session and shared — several buttons across the window would otherwise
// each pay for it. The chosen app is a local preference like the worktree
// defaults; it's stored by id, never by path, so an app that moves still works.

import { listTerminalApps, openTerminalAt, type TerminalApp } from "./tauri";

const PREF_KEY = "flock:external-terminal";
const PREF_EVENT = "flock:external-terminal-change";

let apps: TerminalApp[] | null = null;
let inflight: Promise<TerminalApp[]> | null = null;

/** Installed terminals, in picker order. Cached after the first call. */
export function terminalApps(): Promise<TerminalApp[]> {
  if (apps) return Promise.resolve(apps);
  if (!inflight) {
    inflight = listTerminalApps()
      .then((found) => { apps = found; return found; })
      .catch((err) => { console.error("terminal detection failed", err); return []; })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

/** The detected list if it's already loaded, else null — for a first render
 *  that shouldn't wait on the round-trip. */
export function terminalAppsSnapshot(): TerminalApp[] | null {
  return apps;
}

/** The user's chosen terminal id, or null when they haven't picked one. Note
 *  this can name an app that has since been uninstalled — resolve it against
 *  the detected list before using it. */
export function getPreferredTerminalId(): string | null {
  return localStorage.getItem(PREF_KEY);
}

export function setPreferredTerminalId(id: string) {
  localStorage.setItem(PREF_KEY, id);
  window.dispatchEvent(new Event(PREF_EVENT));
}

export function onPreferredTerminalChange(fn: () => void): () => void {
  window.addEventListener(PREF_EVENT, fn);
  return () => window.removeEventListener(PREF_EVENT, fn);
}

/** The app a click should launch: the stored choice when it's still installed,
 *  otherwise the first detected one (the backend orders purpose-built terminals
 *  ahead of Terminal.app, so this is a decent guess rather than a fallback). */
export function resolvePreferred(list: TerminalApp[]): TerminalApp | null {
  if (list.length === 0) return null;
  const id = getPreferredTerminalId();
  return list.find((a) => a.id === id) ?? list[0];
}

/** Open `dir` in the preferred terminal. Resolves to the app used, or null when
 *  no terminal is installed. The caller surfaces failures — a silent no-op on a
 *  button press is worse than an error toast. */
export async function openExternalTerminal(dir: string): Promise<TerminalApp | null> {
  const list = await terminalApps();
  const app = resolvePreferred(list);
  if (!app) return null;
  await openTerminalAt(app.id, dir);
  return app;
}
