// Workspace_state blob: what is written, and which workspaces may be written.
//
// Restore is lazy, so an unfocused workspace exists in React as an empty
// shell. Writing that shell would wipe the real blob. Per-pane cmd/args
// and displayName belong here because mixed-kind spawn is first-class and
// a race overwrites ws.agentKind while leaving the old panes in the list.

import type { AgentKind, BranchPlan, Pane, Workspace, WorkspaceTab } from "../types";
import { AGENT_META } from "./agents";
import type { Budget } from "./budgets";

export interface SavedPane {
  id: string;
  cmd: string;
  args: string[];
  cwd: string;
  worktree?: { path: string; branch: string };
  sessionId?: string;
  intent?: string;
  intentRaw?: string;
  promptHistory?: string[];
  model?: string;
  displayName?: string;
}

export interface WorkspaceStateBlob {
  agentKind: AgentKind;
  useWorktrees: boolean;
  branchPlan?: BranchPlan;
  secure: boolean;
  prReview: boolean;
  prReviewTarget?: { repo: string; number: number };
  budget?: Budget;
  tabs: WorkspaceTab[];
  focusedTabId: string;
  panes: SavedPane[];
}

export type WorkspaceStateSource = Pick<
  Workspace,
  | "id"
  | "agentKind"
  | "useWorktrees"
  | "branchPlan"
  | "secure"
  | "prReview"
  | "prReviewTarget"
  | "budget"
  | "tabs"
  | "focusedTabId"
  | "panes"
  | "copilot"
  | "observe"
>;

function asAgentKind(kind: string): AgentKind {
  return kind in AGENT_META ? (kind as AgentKind) : "claude";
}

/** Launch cmd/args for a pane kind. `ws.agentKind` is only the default for new splits. */
export function agentCommand(kind: AgentKind): { cmd: string; args: string[] } {
  // AGENT_META / pane.kind may name grok before AgentKind does.
  switch (kind as AgentKind | "grok") {
    case "opencode":
      return { cmd: "opencode", args: ["-c"] };
    case "codex":
      return { cmd: "codex", args: ["--yolo"] };
    case "claude":
      return { cmd: "claude", args: ["--dangerously-skip-permissions"] };
    case "pi":
      // No permission flags: pi executes tools directly by default. Restore
      // relies on scrollback replay (feature A) — `pi -c` resumes only the
      // *most recent* session, which collides across panes sharing a cwd.
      return { cmd: "pi", args: [] };
    case "grok":
      // `bypassPermissions` is grok's own name for the same thing the other
      // agents are launched with, and what secure mode is the answer to.
      return { cmd: "grok", args: ["--permission-mode", "bypassPermissions"] };
  }
}

export function buildWorkspaceStateBlob(ws: WorkspaceStateSource): WorkspaceStateBlob {
  return {
    agentKind: ws.agentKind,
    useWorktrees: ws.useWorktrees ?? false,
    branchPlan: ws.branchPlan,
    secure: ws.secure ?? false,
    prReview: ws.prReview ?? false,
    prReviewTarget: ws.prReviewTarget,
    budget: ws.budget,
    tabs: ws.tabs,
    focusedTabId: ws.focusedTabId,
    panes: ws.panes.map((p) => paneToSaved(p)),
  };
}

function paneToSaved(p: Pane): SavedPane {
  const { cmd, args } = agentCommand(asAgentKind(p.kind));
  return {
    id: p.id,
    cmd,
    args,
    cwd: p.cwd,
    worktree: p.worktree,
    sessionId: p.sessionId,
    intent: p.intent,
    intentRaw: p.intentRaw,
    promptHistory: p.promptHistory,
    model: p.model,
    displayName: p.displayName,
  };
}

/** Session workspaces are ephemeral; unrestored shells must not overwrite the blob. */
export function shouldPersistWorkspace(
  ws: Pick<WorkspaceStateSource, "id" | "copilot" | "observe">,
  hydratedIds: ReadonlySet<string>,
): boolean {
  if (ws.copilot || ws.observe) return false;
  return hydratedIds.has(ws.id);
}

/** Reuse saved names so a restart does not remint "Pluto" into "Harry". */
export function restoreDisplayNames(
  saved: Array<{ displayName?: string }>,
  mint: (taken: Array<string | undefined>) => string,
): string[] {
  const names: string[] = [];
  for (const sp of saved) {
    names.push(sp.displayName ?? mint(names));
  }
  return names;
}

/** Patch one field on the existing blob. Used for a budget set on an unrestored
 *  workspace: writing the React shell would wipe the saved panes.
 *  A missing blob may become budget-only. A present but unreadable blob must
 *  not — that is the same clobber as writing the empty shell. */
export function patchSavedBudget(raw: string | null | undefined, budget: Budget | undefined): string {
  let parsed: Record<string, unknown> = {};
  if (raw) {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error("saved workspace state is not valid JSON");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("saved workspace state is not an object");
    }
    parsed = value as Record<string, unknown>;
  }
  if (budget === undefined) delete parsed.budget;
  else parsed.budget = budget;
  return JSON.stringify(parsed);
}

/** Restore ran, spawned nothing, and left the blob as source of truth.
 *  A later successful spawn is the advertised way back to persistence.
 *  An unrestored shell (restore never finished) must not match — hydrating
 *  from "New Agent Here" on an unfocused workspace would write that one
 *  pane over the saved twelve. */
export function shouldHydrateAfterEmptyRestore(
  ws: Pick<WorkspaceStateSource, "id" | "panes" | "copilot" | "observe">,
  hydratedIds: ReadonlySet<string>,
  emptyRestoreIds: ReadonlySet<string>,
): boolean {
  if (ws.copilot || ws.observe) return false;
  if (hydratedIds.has(ws.id)) return false;
  if (!emptyRestoreIds.has(ws.id)) return false;
  return ws.panes.length > 0;
}

/** Worktrees recorded in a saved blob — the only list an unrestored delete has. */
export function worktreesFromSavedState(raw: string | null | undefined): { path: string; branch: string }[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { panes?: Array<{ worktree?: { path?: string; branch?: string } }> };
    if (!Array.isArray(parsed.panes)) return [];
    const out: { path: string; branch: string }[] = [];
    for (const p of parsed.panes) {
      const wt = p.worktree;
      if (wt?.path && wt.branch) out.push({ path: wt.path, branch: wt.branch });
    }
    return out;
  } catch {
    return [];
  }
}
