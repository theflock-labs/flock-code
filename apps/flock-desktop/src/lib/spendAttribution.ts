// Turning a window of Claude Code spend into "who spent it".
//
// The backend hands back one row per session (`claude_spend_windows`), because
// the session id is the only key flock actually controls: every claude pane is
// launched with `--session-id <uuid>` (`withClaudeSession` in App.tsx), so a
// row maps back to exactly one pane, and through the pane to a workspace and a
// repo. Everything here is that mapping and nothing else — no fetching, no
// clock, no React — so the arithmetic a budget fires on can be pinned by tests.
//
// Two invariants this file exists to hold:
//
//   * **Nothing is counted twice.** Every row lands in at most one pane, one
//     workspace and one repo. A workspace total is never the sum of a session
//     figure and a directory figure describing the same tokens — that is the
//     mistake that makes a $50 ceiling fire at $25.
//   * **Nothing is silently dropped.** Rows nobody can claim, plus the
//     window's own unattributed remainder (turns written with no session id at
//     all), land in `unclaimed`. `sum(perWorkspace) + unclaimed === total`, and
//     a test asserts it. A budget that quietly loses spend is worse than no
//     budget, because it reads as reassurance.
//
// Every dollar here is priced from the local table in `claude_code_usage.rs`
// and drifts whenever Anthropic changes prices. It is a guardrail, not a bill.

import type { SpendWindow } from "./tauri";

/** Tokens and estimated dollars. */
export interface Spend {
  tokens: number;
  costUsd: number;
}

export const ZERO_SPEND: Spend = { tokens: 0, costUsd: 0 };

/** What attribution needs to know about a live pane. */
export interface PaneRef {
  id: string;
  workspaceId: string;
  /** Claude panes only. Panes without one can still be reached by `cwd`. */
  sessionId?: string;
  cwd: string;
}

/** What attribution needs to know about a workspace. */
export interface WorkspaceRef {
  id: string;
  repoPath: string;
}

export interface Attribution {
  /** Per pane — only for rows whose session id matched a live pane. */
  perPane: Map<string, Spend>;
  perWorkspace: Map<string, Spend>;
  /** Keyed by the workspace's `repoPath`. Several workspaces on one repo
   * (the common case for a racing setup) collapse into one entry. */
  perRepo: Map<string, Spend>;
  /** In-window spend no workspace could be found for. */
  unclaimed: Spend;
  /** Everything in the window. Equals the sum of `perWorkspace` + `unclaimed`. */
  total: Spend;
}

function add(into: Map<string, Spend>, key: string, tokens: number, costUsd: number): void {
  const prev = into.get(key);
  if (prev) {
    prev.tokens += tokens;
    prev.costUsd += costUsd;
  } else {
    into.set(key, { tokens, costUsd });
  }
}

/** Is `child` the same path as `parent`, or inside it?
 *
 * The `+ "/"` matters: a plain `startsWith` makes `/src/flock-code-old` look
 * like it lives inside `/src/flock-code`, which would charge one repo's agents
 * to a different repo's budget. */
export function isUnder(child: string, parent: string): boolean {
  if (!child || !parent) return false;
  return child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

/** Attribute a window of spend across panes, workspaces and repos.
 *
 * Resolution order per row, first match wins:
 *   1. its session id matches a live pane — exact, and the only way a row can
 *      be charged to an individual agent;
 *   2. its `cwd` matches a live pane's working directory — the pane is gone
 *      (closed, or the app restarted) but we still know whose worktree it was;
 *   3. its `cwd` sits inside a workspace's repo path, longest match winning so
 *      a repo nested inside another resolves to the inner one;
 *   4. nothing — it goes to `unclaimed`.
 *
 * Steps 2 and 3 never run for a row step 1 already claimed, which is what
 * keeps a row from being counted against a workspace twice.
 */
export function attributeSpend(
  window: SpendWindow | null,
  panes: PaneRef[],
  workspaces: WorkspaceRef[],
): Attribution {
  const perPane = new Map<string, Spend>();
  const perWorkspace = new Map<string, Spend>();
  const perRepo = new Map<string, Spend>();
  const unclaimed: Spend = { tokens: 0, costUsd: 0 };

  if (!window) {
    return { perPane, perWorkspace, perRepo, unclaimed, total: { ...ZERO_SPEND } };
  }

  // First pane wins a duplicated session id. Two panes should never share one
  // (flock mints a fresh uuid per spawn), but if it ever happened, charging
  // both would inflate the workspace total — so we pick one and stay
  // deterministic about which.
  const bySession = new Map<string, PaneRef>();
  for (const p of panes) {
    if (p.sessionId && !bySession.has(p.sessionId)) bySession.set(p.sessionId, p);
  }
  const byCwd = new Map<string, PaneRef>();
  for (const p of panes) {
    if (p.cwd && !byCwd.has(p.cwd)) byCwd.set(p.cwd, p);
  }
  const repoOf = new Map<string, string>();
  for (const w of workspaces) repoOf.set(w.id, w.repoPath);

  /** Longest repo path containing `cwd`, so a repo checked out inside another
   * repo attributes to the inner one rather than whichever we saw first. */
  const workspaceByPath = (cwd: string): WorkspaceRef | undefined => {
    let best: WorkspaceRef | undefined;
    for (const w of workspaces) {
      if (!isUnder(cwd, w.repoPath)) continue;
      if (!best || w.repoPath.length > best.repoPath.length) best = w;
    }
    return best;
  };

  for (const row of window.sessions) {
    const { tokens } = row;
    const costUsd = row.cost_usd;

    // Only an exact session match names an individual agent. A cwd match says
    // "some agent in this worktree", which is a weaker claim and must not be
    // charged to whichever pane happens to sit there now.
    const owner = bySession.get(row.session_id);
    if (owner) add(perPane, owner.id, tokens, costUsd);

    const pane = owner ?? byCwd.get(row.cwd);
    const viaPath = pane ? undefined : workspaceByPath(row.cwd);
    const workspaceId = pane?.workspaceId ?? viaPath?.id;
    const repoPath = pane ? repoOf.get(pane.workspaceId) : viaPath?.repoPath;

    if (workspaceId) {
      add(perWorkspace, workspaceId, tokens, costUsd);
      if (repoPath) add(perRepo, repoPath, tokens, costUsd);
    } else {
      unclaimed.tokens += tokens;
      unclaimed.costUsd += costUsd;
    }
  }

  // Turns the backend could not attribute at all (no session id on the line)
  // are already excluded from `sessions`; fold them in so the identity
  // sum(perWorkspace) + unclaimed === total holds.
  unclaimed.tokens += window.unattributed_tokens;
  unclaimed.costUsd += window.unattributed_cost_usd;

  return {
    perPane,
    perWorkspace,
    perRepo,
    unclaimed,
    total: { tokens: window.tokens, costUsd: window.cost_usd },
  };
}

/** Spend for one key, or zero. Callers want a number, not a `Map | undefined`. */
export function spendFor(map: Map<string, Spend>, key: string | undefined): Spend {
  return (key && map.get(key)) || ZERO_SPEND;
}

// ─── Window boundaries ───────────────────────────────────────────────────────
//
// Deliberately **local** midnight and local month start, not UTC. A budget is
// something a person watches over their own working day; a UTC day would reset
// mid-afternoon in Sydney and mid-evening in California, and the first thing
// anyone would notice is the alert firing twice on one day's work.

/** Start of `now`'s local day, ms since epoch. */
export function dayStartMs(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Start of `now`'s local month, ms since epoch. */
export function monthStartMs(now: number): number {
  const d = new Date(now);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Stable label for the period `now` falls in — "2026-08-09" / "2026-08".
 *
 * This is what makes an alert fire once per period rather than once per poll,
 * and re-arm on its own when the period rolls over, with no timer to schedule
 * and nothing to miss if the app was closed at midnight. Built from local
 * date parts for the same reason the boundaries above are local. */
export function periodKey(now: number, period: "day" | "month"): string {
  const d = new Date(now);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  if (period === "month") return `${y}-${m}`;
  return `${y}-${m}-${String(d.getDate()).padStart(2, "0")}`;
}
