// Fan-out and merge: one prompt, N agents, each in its own worktree off one
// commit, compared side by side, one of them merged.
//
// This module is the decision-making half — naming, live state, and what
// cleanup is allowed to destroy. Everything that touches git or a PTY lives in
// App.tsx; everything here is pure so the rules that can lose someone's work
// are testable without a repo.

import type { Pane, RaceContender, RaceState } from "../types";
import { slugify } from "./branchPlan";

/** The branch stem a race's contenders are cut from, derived from the prompt.
 *
 * Prefixed `race-` on purpose: a race leaves N branches behind in a repo the
 * user also works in by hand, and without a prefix a five-way fan-out on
 * "fix the login redirect" is five branches that read exactly like branches
 * someone made deliberately. `slugify` caps at 24 characters, which is where
 * the prompt gets cut; the prefix sits outside that so it is never the part
 * that survives.
 */
export function raceStem(prompt: string): string {
  const slug = slugify(prompt);
  // slugify falls back to "ws" (its own workspace-flavoured default) when
  // nothing survives — an all-emoji or all-punctuation prompt. "race" alone is
  // the honest name for that.
  return slug && slug !== "ws" ? `race-${slug}` : "race";
}

/** What a race tab is called. Short enough to sit in the tab strip next to
 * "1" and "2" without pushing them off the end. */
export function raceTabName(prompt: string, contenders: number): string {
  const slug = slugify(prompt);
  const subject = slug && slug !== "ws" ? slug.slice(0, 14).replace(/-+$/, "") : "race";
  // A tab name is a plain string with nowhere to hang an SVG, so this is the
  // one branch mark in the app that has to be a character — which is exactly
  // why it is no longer ⑂. That glyph is in neither bundled face nor in SF
  // Mono, so a tab label rendered it from Apple Symbols, at a different weight
  // from the tab's own text, a few pixels from the sidebar's real branch icon.
  // "×3" says the same thing (three contenders) in glyphs the app actually
  // ships, and reads as a count rather than a symbol you have to learn.
  return `×${contenders} ${subject}`;
}

/** How a contender is doing right now, derived from the live pane list.
 *
 * `gone` is a real and expected state, not an error: panes are closed, popped
 * out, and lost to a crash, while the worktree they were working in stays on
 * disk. A contender whose agent has gone is still a contender — its diff is
 * still readable and it is still mergeable — so the compare view has to be
 * able to show it rather than dropping the column.
 */
export type ContenderState = "working" | "needs-input" | "resting" | "gone";

export function contenderState(c: RaceContender, panes: Pane[]): ContenderState {
  // Matched on cwd, not pane id: pane ids are regenerated on restore, cwd is
  // the worktree path and is written back into the saved pane state verbatim.
  const pane = panes.find((p) => p.worktree?.path === c.worktreePath || p.cwd === c.worktreePath);
  if (!pane) return "gone";
  if (pane.spawning || pane.booting) return "working";
  switch (pane.status) {
    case "working":
      return "working";
    case "awaiting_input":
    case "blocked":
      return "needs-input";
    default:
      return "resting";
  }
}

/** One loser's teardown. */
export interface CleanupTarget {
  branch: string;
  worktreePath: string;
  /** Pane still running in this worktree, which has to be closed before the
   * worktree can be removed — `git worktree remove` refuses while a process
   * holds it, and killing the agent silently would be worse than saying so. */
  paneId?: string;
  /** Delete the branch too, discarding whatever it holds. */
  deleteBranch: boolean;
}

/** What "discard the others" actually removes.
 *
 * Three rules, each of which was a way to destroy the wrong thing:
 *
 * - The winner is never a target. Its worktree is the checkout the merge just
 *   committed from and, if its agent is still alive, its cwd.
 * - A contender sharing the winner's worktree path is never a target either.
 *   Two contenders can end up in one checkout when `create_worktree` hands
 *   back an existing worktree for a branch that was already live.
 * - `deleteBranch` is the caller's explicit choice and is passed straight
 *   through. It is NOT softened by an unmerged-commit check the way
 *   `safeRemoveWorktree` softens it, because here the unmerged commits are the
 *   whole point: every loser's branch holds work that exists nowhere else, so
 *   a "delete only if nothing would be lost" rule would delete nothing, ever.
 *   The confirmation that precedes this is what makes it a choice.
 */
export function cleanupPlan(
  race: RaceState,
  winnerBranch: string,
  panes: Pane[],
  deleteBranches: boolean,
): CleanupTarget[] {
  const winner = race.contenders.find((c) => c.branch === winnerBranch);
  return race.contenders
    .filter((c) => c.branch !== winnerBranch && c.worktreePath !== winner?.worktreePath)
    .map((c) => ({
      branch: c.branch,
      worktreePath: c.worktreePath,
      paneId: panes.find((p) => p.worktree?.path === c.worktreePath || p.cwd === c.worktreePath)?.id,
      deleteBranch: deleteBranches,
    }));
}
