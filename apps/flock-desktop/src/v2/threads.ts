// The sidebar's model: projects (workspaces), and in each the threads you are
// running there (a tab, usually one agent, sometimes a grid of them).
//
// v1 drew the same information as four things at once: workspace cards, an
// "Agents" section for the focused workspace only, a tab strip in the pane
// header and a notifications pill in the titlebar. Here it is one list, like
// the chats in lucy-chat: every thread of every project, each with one state
// and one title, the one you are looking at highlighted.

import { allPaneIds } from "../lib/layout";
import { latestTask, sameTitle } from "./titles";
import type { Pane, Workspace, WorkspaceTab } from "../types";

/** One word for what a thread needs from you, in the order they matter. */
export type ThreadState = "needs-you" | "failed" | "working" | "starting" | "idle" | "ended" | "asleep";

const RANK: readonly ThreadState[] = ["needs-you", "failed", "working", "starting", "idle", "ended", "asleep"];

export interface Thread {
  /** `${workspaceId}:${tabId}`, stable across restarts (tab ids are saved). */
  key: string;
  workspaceId: string;
  tabId: string;
  title: string;
  state: ThreadState;
  /** Agents laid out in the thread. */
  agents: number;
  /** When the thread's state began (ms), for "2m". */
  since?: number;
  /** Agent kinds in the thread, e.g. ["claude"]. */
  kinds: string[];
  /** The pane the thread opens on. */
  paneId?: string;
  race: boolean;
  /** What its agent is on now, when that has moved on from the title: the
   *  latest task-like prompt (see titles.latestTask). */
  doing?: string;
}

export interface Project {
  id: string;
  name: string;
  repoPath: string;
  branch: string;
  threads: Thread[];
  /** Threads waiting on you. */
  waiting: number;
  /** False while the workspace has not been restored this launch: its threads
   *  come from the saved state and its agents are not running yet. */
  awake: boolean;
}

/** A pane as the saved state records it, enough to list it before restore. */
export interface DormantPane {
  id: string;
  kind: string;
  displayName?: string;
  intent?: string;
}

export interface DormantTab {
  id: string;
  name: string;
  renamed?: boolean;
  paneIds: string[];
  focusedPaneId?: string | null;
  race?: boolean;
}

/** A workspace's threads, read from its saved state blob before restore. */
export interface Dormant {
  tabs: DormantTab[];
  panes: DormantPane[];
  focusedTabId?: string;
}

/** Read the threads out of a saved workspace blob without restoring it.
 *  Returns null for a blob that cannot be read (restore will say so itself). */
export function parseDormant(raw: string | null | undefined): Dormant | null {
  if (!raw) return { tabs: [], panes: [] };
  try {
    const parsed = JSON.parse(raw) as {
      tabs?: Array<Partial<WorkspaceTab> & { id?: string }>;
      layoutTree?: WorkspaceTab["layoutTree"];
      focusedTabId?: string;
      panes?: Array<{ id?: string; cmd?: string; displayName?: string; intent?: string }>;
    };
    const panes: DormantPane[] = (parsed.panes ?? [])
      .filter((p): p is { id: string; cmd?: string; displayName?: string; intent?: string } => typeof p?.id === "string")
      .map((p) => ({ id: p.id, kind: p.cmd ?? "claude", displayName: p.displayName, intent: p.intent }));
    const rawTabs = parsed.tabs ?? (parsed.layoutTree ? [{ id: "tab-legacy", name: "1", layoutTree: parsed.layoutTree }] : []);
    const tabs: DormantTab[] = rawTabs
      .filter((t) => typeof t?.id === "string")
      .map((t) => ({
        id: t.id as string,
        name: t.name ?? "",
        renamed: t.renamed,
        paneIds: t.layoutTree ? allPaneIds(t.layoutTree) : [],
        focusedPaneId: t.focusedPaneId ?? null,
        race: !!t.race,
      }));
    return { tabs, panes, focusedTabId: parsed.focusedTabId };
  } catch {
    return null;
  }
}

/** The state one pane is in, in thread terms. */
export function paneState(p: Pick<Pane, "status" | "spawning" | "booting">): ThreadState {
  if (p.spawning || p.booting) return "starting";
  switch (p.status) {
    case "awaiting_input":
    case "blocked":
      return "needs-you";
    case "working":
      return "working";
    case "failed":
      return "failed";
    case "done":
      return "ended";
    default:
      return "idle";
  }
}

/** The thread's state is its most urgent pane's. */
export function rollup(states: ThreadState[]): ThreadState {
  let best: ThreadState = "idle";
  let bestRank = RANK.length;
  for (const s of states) {
    const r = RANK.indexOf(s);
    if (r < bestRank) {
      best = s;
      bestRank = r;
    }
  }
  return states.length === 0 ? "idle" : best;
}

/** What a thread is called: the name you gave it, else its task, else its agent. */
export function threadTitle(
  tab: Pick<WorkspaceTab, "name" | "renamed">,
  primary: { intent?: string; displayName?: string } | undefined,
  others: Array<{ intent?: string }>,
): string {
  if (tab.renamed && tab.name.trim()) return tab.name.trim();
  const intent = primary?.intent ?? others.find((p) => p.intent)?.intent;
  if (intent?.trim()) return intent.trim();
  return primary?.displayName ?? "New agent";
}

function liveThreads(ws: Workspace): Thread[] {
  const out: Thread[] = [];
  const byId = new Map(ws.panes.map((p) => [p.id, p]));
  for (const tab of ws.tabs) {
    const ids = tab.layoutTree ? allPaneIds(tab.layoutTree) : [];
    const panes = ids.map((id) => byId.get(id)).filter((p): p is Pane => !!p);
    if (panes.length === 0) continue;
    const primary = panes.find((p) => p.id === tab.focusedPaneId) ?? panes[0];
    const states = panes.map(paneState);
    const state = rollup(states);
    const lead = panes[states.indexOf(state)] ?? primary;
    const title = threadTitle(tab, primary, panes);
    const doing = latestTask(primary.promptHistory) ?? panes.map((p) => latestTask(p.promptHistory)).find(Boolean);
    out.push({
      key: `${ws.id}:${tab.id}`,
      workspaceId: ws.id,
      tabId: tab.id,
      title,
      state,
      agents: panes.length,
      since: lead?.statusChangedAt,
      kinds: [...new Set(panes.map((p) => p.kind))],
      paneId: primary.id,
      race: !!tab.race,
      doing: doing && !sameTitle(doing, title) ? doing : undefined,
    });
  }
  return out;
}

function dormantThreads(ws: Workspace, d: Dormant): Thread[] {
  const byId = new Map(d.panes.map((p) => [p.id, p]));
  const out: Thread[] = [];
  for (const tab of d.tabs) {
    const panes = tab.paneIds.map((id) => byId.get(id)).filter((p): p is DormantPane => !!p);
    if (panes.length === 0) continue;
    const primary = panes.find((p) => p.id === tab.focusedPaneId) ?? panes[0];
    out.push({
      key: `${ws.id}:${tab.id}`,
      workspaceId: ws.id,
      tabId: tab.id,
      title: threadTitle(tab, primary, panes),
      state: "asleep",
      agents: panes.length,
      kinds: [...new Set(panes.map((p) => p.kind))],
      race: !!tab.race,
    });
  }
  return out;
}

/** Every project with its threads, in the workspaces' stored order. A project
 *  with a `dormant` entry has not been restored yet and lists its saved threads. */
export function buildProjects(workspaces: Workspace[], dormant: Readonly<Record<string, Dormant | undefined>>): Project[] {
  return workspaces.map((ws) => {
    const d = dormant[ws.id];
    const threads = d ? dormantThreads(ws, d) : liveThreads(ws);
    return {
      id: ws.id,
      name: ws.name,
      repoPath: ws.repo_path,
      branch: ws.branch,
      threads,
      waiting: threads.filter((t) => t.state === "needs-you").length,
      awake: !d,
    };
  });
}

/** Narrow the list to a search: a project whose name matches keeps all of its
 *  threads, otherwise only the threads whose title or agent matches stay. */
export function filterProjects(projects: Project[], query: string): Project[] {
  const q = query.trim().toLowerCase();
  if (!q) return projects;
  const out: Project[] = [];
  for (const p of projects) {
    if (p.name.toLowerCase().includes(q)) {
      out.push(p);
      continue;
    }
    const threads = p.threads.filter(
      (t) => t.title.toLowerCase().includes(q) || t.kinds.some((k) => k.toLowerCase().includes(q)),
    );
    if (threads.length > 0) out.push({ ...p, threads });
  }
  return out;
}

/** Every thread waiting on you, across projects, in sidebar order. */
export function waitingThreads(projects: Project[]): Thread[] {
  return projects.flatMap((p) => p.threads.filter((t) => t.state === "needs-you"));
}

/** "now", "4m", "2h", "3d": how long a thread has been in its state. */
export function ago(since: number | undefined, now: number): string {
  if (!since) return "";
  const s = Math.max(0, Math.floor((now - since) / 1000));
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
