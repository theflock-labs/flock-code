// Borrowed panes: a tab showing a pane that belongs to another workspace.
//
// A layout tree holds bare pane id strings and nothing else, so it cannot say
// where a pane came from: once a borrowed pane's id is in a leaf it looks
// exactly like a pane the tab owns, and the borrowing workspace would start
// spawning, closing and tearing down worktrees for a pane it never created.
// The loan is therefore recorded beside the tree as a list of refs carrying
// the owning workspace id.
//
// That list is also the only thing that survives a relaunch. Every pane is
// respawned with a fresh id, so a saved tree is remapped old→new; a borrowed
// id is minted by the OTHER workspace's restore, which is lazy and may not
// have happened yet. The ref list is what tells restore which workspace has
// to come up before the loan can be resolved, and remapBorrowed hands back
// the still-unresolved refs rather than dropping them, because a dropped ref
// is a borrowed pane that vanishes for good.

import { type LayoutNode, allPaneIds, paneCount, pruneLayoutTree } from "./layout";

/** A pane displayed in this tab but owned by another workspace. */
export interface BorrowedRef {
  paneId: string;
  workspaceId: string;
}

/** Record a loan. Idempotent by pane id: borrowing the same pane twice must
 *  not leave two refs behind, since removeBorrowed clears one ref and the
 *  survivor would keep the pane pinned to a tab nothing renders it in. The
 *  workspace id is overwritten because a pane can change hands (it is moved
 *  to another workspace) while the borrowing tab holds the loan. */
export function addBorrowed(list: BorrowedRef[] | undefined, ref: BorrowedRef): BorrowedRef[] {
  const existing = list ?? [];
  if (existing.some((r) => r.paneId === ref.paneId)) {
    return existing.map((r) => (r.paneId === ref.paneId ? { ...r, workspaceId: ref.workspaceId } : r));
  }
  return [...existing, ref];
}

/** Return the loan. */
export function removeBorrowed(list: BorrowedRef[] | undefined, paneId: string): BorrowedRef[] {
  return (list ?? []).filter((r) => r.paneId !== paneId);
}

/** Which workspace owns `paneId`, or undefined if the tab owns it itself. */
export function borrowedOwner(list: BorrowedRef[] | undefined, paneId: string): string | undefined {
  return (list ?? []).find((r) => r.paneId === paneId)?.workspaceId;
}

/** Rewrite borrowed refs through a restore's old→new pane id map.
 *
 *  Split rather than merged: restore is lazy and per workspace, so a pass run
 *  while the owning workspace is still asleep knows none of its new ids. A ref
 *  it cannot resolve is returned untouched under `pending` so the next pass,
 *  after that workspace restores, can resolve it against its old id. Rewriting
 *  pending refs to their (unknown) new ids, or filtering them out, both lose
 *  the loan permanently. */
export function remapBorrowed(
  list: BorrowedRef[] | undefined,
  idMap: Map<string, string>,
): { resolved: BorrowedRef[]; pending: BorrowedRef[] } {
  const resolved: BorrowedRef[] = [];
  const pending: BorrowedRef[] = [];
  for (const ref of list ?? []) {
    const fresh = idMap.get(ref.paneId);
    if (fresh === undefined) pending.push(ref);
    else resolved.push({ ...ref, paneId: fresh });
  }
  return { resolved, pending };
}

/** Heal a tab against the panes that actually exist. Run after a restore, and
 *  after a workspace is deleted (which takes its panes with it).
 *
 *  A leaf with no pane behind it renders as a blank, uncloseable ghost, and a
 *  ref to a pane nobody owns any more keeps the tab claiming a loan that can
 *  never be repaid, so both go. A live ref is kept even when it is not in the
 *  tree: a borrowed pane can be zoomed, popped out or laid out by the owner
 *  alone, and forgetting the loan there would let the borrowing workspace
 *  treat the pane as its own the next time it appears. */
export function reconcileTab(
  tree: LayoutNode | null,
  borrowed: BorrowedRef[] | undefined,
  liveIds: Set<string>,
): { tree: LayoutNode | null; borrowed: BorrowedRef[] } {
  return {
    tree: tree ? pruneLayoutTree(tree, liveIds) : null,
    borrowed: (borrowed ?? []).filter((r) => liveIds.has(r.paneId)),
  };
}

/** Add a pane to a tree by splitting at the root.
 *
 *  Alternating the direction on leaf parity is what keeps repeated appends from
 *  building one long strip of slivers: borrowing happens a pane at a time, so
 *  every append here is a root split and a fixed direction would stack them all
 *  the same way. The ratio gives the existing subtree n/(n+1) of the space, so
 *  the panes already there keep an equal share of what is left instead of the
 *  incoming pane taking half the tab. */
export function appendLeaf(tree: LayoutNode | null, paneId: string): LayoutNode {
  if (!tree) return { type: "leaf", paneId };
  // Re-appending a pane already in the tree would plant its id in two leaves,
  // and a pane rendered twice is one xterm instance fighting two containers.
  if (allPaneIds(tree).includes(paneId)) return tree;
  const n = paneCount(tree);
  return {
    type: "split",
    dir: n % 2 === 0 ? "horizontal" : "vertical",
    // Clamped to the range splits are created with: past ten panes the raw
    // n/(n+1) would hand the newcomer a sliver too thin to read.
    ratio: Math.max(0.1, Math.min(0.9, n / (n + 1))),
    first: tree,
    second: { type: "leaf", paneId },
  };
}
