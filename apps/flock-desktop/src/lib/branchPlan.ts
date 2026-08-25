// How a workspace's BranchPlan turns into actual git branches.
//
// One agent gets the stem itself; every additional agent gets a
// `{stem}-{agent}` sibling. The separator is a dash, not a slash, on purpose:
// git refs are files, so `refactor-auth` and `refactor-auth/pluto` cannot both
// exist (directory/file conflict) — which is exactly what would happen the
// first time someone split a solo workspace.

import type { BranchPlan } from "../types";

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-+|-+$)/g, "").slice(0, 24) || "ws";
}

/** Resolve a plan against how many agents will actually run under it.
 *
 * "Check out this existing branch" only means something for a single agent —
 * git allows a branch in one worktree at a time. With more, the picked branch
 * becomes the base every agent branches off instead. */
export function normalizePlan(plan: BranchPlan, agentCount: number): BranchPlan {
  if (plan.mode === "existing" && agentCount > 1) {
    const branch = plan.branch ?? "";
    return { mode: "new", stem: slugify(branch), baseRef: branch, fetch: plan.fetch };
  }
  return plan;
}

/** The branch a given agent should end up on.
 *
 * `solo` means this agent is the only one the plan is being applied to right
 * now, so it takes the bare stem. Later spawns into the same workspace pass
 * `solo: false` and get a suffixed sibling, which is why the stem stays free
 * of a D/F conflict. */
export function branchForAgent(plan: BranchPlan, agentName: string, solo: boolean): string {
  if (plan.mode === "existing") return plan.branch ?? "";
  return solo ? plan.stem : `${plan.stem}-${slugify(agentName)}`;
}

/** Client-side branch-name check. The backend re-validates with git's own
 * `check-ref-format`; this exists to disable Create with a reason rather than
 * to be authoritative. */
export function validateStem(stem: string): string | null {
  const s = stem.trim();
  if (!s) return "Branch name required.";
  if (/\s/.test(s)) return "No spaces in a branch name.";
  if (s.startsWith("-")) return "Can't start with a dash.";
  if (s.startsWith("/") || s.endsWith("/") || s.includes("//")) return "Bad use of “/”.";
  if (s.endsWith(".") || s.includes("..")) return "Bad use of “.”.";
  if (s.includes("@{") || s === "@" || s === "HEAD") return "Reserved name.";
  if (/[~^:?*[\\\x00-\x1f\x7f]/.test(s)) return "Contains a character git won't allow.";
  return null;
}

/** The branch name the dialog shows under the branch field. Agent names are
 * drawn at spawn time, so a multi-agent plan previews the shape rather than
 * inventing names it can't promise. The count is the caller's to phrase. */
export function previewBranches(plan: BranchPlan, agentCount: number): string {
  const p = normalizePlan(plan, agentCount);
  if (p.mode === "current") return "";
  if (p.mode === "existing") return p.branch ?? "";
  // <agent> rather than ⟨agent⟩: mathematical angle brackets are in neither
  // bundled face, and this string is shown inside a <code> element where the
  // ASCII pair is the conventional way to write a placeholder anyway.
  return agentCount <= 1 ? p.stem : `${p.stem}-<agent>`;
}
