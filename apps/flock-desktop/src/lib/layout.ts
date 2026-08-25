// BSP (Binary Space Partitioning) split tree — ported from
// crates/flock-tui/src/layout.rs. Manages the arrangement of
// terminal panes inside a workspace.

export type SplitDir = "horizontal" | "vertical";

export type LayoutNode =
  | { type: "leaf"; paneId: string }
  | {
      type: "split";
      dir: SplitDir;
      ratio: number; // 0.1..0.9 — fraction for the first child
      first: LayoutNode;
      second: LayoutNode;
    };

/** Split the leaf pane matching `target` in direction `dir`,
 *  placing `newPaneId` as the newly created leaf. */
export function split(
  node: LayoutNode,
  target: string,
  dir: SplitDir,
  newPaneId: string,
): LayoutNode {
  return splitInner(node, target, dir, newPaneId);
}

function splitInner(
  node: LayoutNode,
  target: string,
  dir: SplitDir,
  childId: string,
): LayoutNode {
  if (node.type === "leaf") {
    if (node.paneId === target) {
      return {
        type: "split",
        dir,
        ratio: 0.5,
        first: { type: "leaf", paneId: node.paneId },
        second: { type: "leaf", paneId: childId },
      };
    }
    return node;
  }
  // split node
  return {
    ...node,
    first: splitInner(node.first, target, dir, childId),
    second: splitInner(node.second, target, dir, childId),
  };
}

/** Remove the pane matching `target`.
 *  Returns null when the entire subtree should be removed (last pane). */
export function remove(node: LayoutNode, target: string): LayoutNode | null {
  if (node.type === "leaf") {
    return node.paneId === target ? null : node;
  }
  const first = remove(node.first, target);
  const second = remove(node.second, target);
  if (first === null && second === null) return null;
  if (first === null) return second;
  if (second === null) return first;
  return { ...node, first, second };
}

/** Swap the positions of two panes, leaving every split direction and ratio
 *  untouched — only the two leaves trade places. Backs dragging a pane's
 *  topbar onto another pane to rearrange a crowded grid. */
export function swapPanes(node: LayoutNode, a: string, b: string): LayoutNode {
  // Both leaves must exist, else the "swap" would plant an id with no pane
  // behind it — a blank, uncloseable ghost pane (see pruneLayoutTree).
  if (a === b) return node;
  const ids = allPaneIds(node);
  if (!ids.includes(a) || !ids.includes(b)) return node;
  return swapInner(node, a, b);
}

function swapInner(node: LayoutNode, a: string, b: string): LayoutNode {
  if (node.type === "leaf") {
    if (node.paneId === a) return { type: "leaf", paneId: b };
    if (node.paneId === b) return { type: "leaf", paneId: a };
    return node;
  }
  return {
    ...node,
    first: swapInner(node.first, a, b),
    second: swapInner(node.second, a, b),
  };
}

/** Get all pane IDs in the tree. */
export function allPaneIds(node: LayoutNode): string[] {
  if (node.type === "leaf") return [node.paneId];
  return [...allPaneIds(node.first), ...allPaneIds(node.second)];
}

/** Count panes in the tree. */
export function paneCount(node: LayoutNode): number {
  if (node.type === "leaf") return 1;
  return paneCount(node.first) + paneCount(node.second);
}

/** Get the first (leftmost/topmost) pane ID. */
export function firstPaneId(node: LayoutNode): string {
  if (node.type === "leaf") return node.paneId;
  return firstPaneId(node.first);
}

/** A route down the tree to a specific split node: "first" or "second" at
 *  each branch. */
export type SplitPath = ("first" | "second")[];

/** Return a new tree with the ratio at `path` set to `ratio` (clamped to the
 *  same 0.1..0.9 range splits are created with). */
export function setRatioAtPath(node: LayoutNode, path: SplitPath, ratio: number): LayoutNode {
  if (node.type === "leaf") return node;
  const clamped = Math.max(0.1, Math.min(0.9, ratio));
  if (path.length === 0) return { ...node, ratio: clamped };
  const [head, ...rest] = path;
  return head === "first"
    ? { ...node, first: setRatioAtPath(node.first, rest, ratio) }
    : { ...node, second: setRatioAtPath(node.second, rest, ratio) };
}

/** Rebalance every split so each leaf pane ends up with an equal share of
 *  screen space, keeping the existing tree shape and split directions. A
 *  split's ratio is set to the fraction of leaves living in its first subtree,
 *  so e.g. a `leaf | (leaf | leaf)` tree resolves to 1/3 · 1/3 · 1/3 rather
 *  than the 1/2 · 1/4 · 1/4 that a naive "every ratio = 0.5" would give.
 *  Backs the double-click-a-gutter "even out the panes" gesture. */
export function balanceLayoutTree(node: LayoutNode): LayoutNode {
  if (node.type === "leaf") return node;
  const first = balanceLayoutTree(node.first);
  const second = balanceLayoutTree(node.second);
  const ratio = paneCount(first) / (paneCount(first) + paneCount(second));
  return { ...node, ratio: Math.max(0.1, Math.min(0.9, ratio)), first, second };
}

/** Remap every leaf pane ID in a tree using the provided old→new ID map.
 *  Used when restoring a saved layout after a restart (old PTY IDs are gone). */
export function remapLayoutTree(node: LayoutNode, idMap: Map<string, string>): LayoutNode {
  if (node.type === "leaf") {
    return { type: "leaf", paneId: idMap.get(node.paneId) ?? node.paneId };
  }
  return {
    ...node,
    first: remapLayoutTree(node.first, idMap),
    second: remapLayoutTree(node.second, idMap),
  };
}

/** Drop every leaf whose pane ID isn't in `valid`, collapsing splits that
 *  lose a side. Returns null if nothing valid remains. Used on restore to
 *  heal saved layouts that contain "ghost" leaves — pane IDs with no pane
 *  record behind them, which render as blank, uncloseable panes and keep a
 *  tab from ever reading as empty. */
export function pruneLayoutTree(node: LayoutNode, valid: Set<string>): LayoutNode | null {
  if (node.type === "leaf") return valid.has(node.paneId) ? node : null;
  const first = pruneLayoutTree(node.first, valid);
  const second = pruneLayoutTree(node.second, valid);
  if (first && second) return { ...node, first, second };
  return first ?? second;
}

/** Build a grid layout tree from an ordered list of pane IDs.
 *  Rows are stacked vertically; columns within each row split horizontally.
 *  Ratios are computed so every cell gets an equal share of screen space. */
export function buildGridLayout(paneIds: string[], rows: number, cols: number): LayoutNode {
  function combineH(ids: string[]): LayoutNode {
    if (ids.length === 1) return { type: "leaf", paneId: ids[0] };
    const mid = Math.floor(ids.length / 2);
    return {
      type: "split", dir: "horizontal",
      ratio: mid / ids.length,
      first: combineH(ids.slice(0, mid)),
      second: combineH(ids.slice(mid)),
    };
  }
  function combineV(nodes: LayoutNode[]): LayoutNode {
    if (nodes.length === 1) return nodes[0];
    const mid = Math.floor(nodes.length / 2);
    return {
      type: "split", dir: "vertical",
      ratio: mid / nodes.length,
      first: combineV(nodes.slice(0, mid)),
      second: combineV(nodes.slice(mid)),
    };
  }
  const rowNodes = Array.from({ length: rows }, (_, r) =>
    combineH(paneIds.slice(r * cols, (r + 1) * cols)),
  );
  return combineV(rowNodes);
}

// ─── Pixel layout computation (ported from layout.rs) ───────────────────

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BorderRect extends Rect {
  dir: SplitDir;
  /** Route to this split node, for resizing it via setRatioAtPath. */
  path: SplitPath;
  /** The split node's own area, pre-split — ratio during a drag is computed
   *  relative to this, not the whole grid. */
  area: Rect;
}

/** Compute pixel rects for every leaf pane. */
export function computeLayout(node: LayoutNode, area: Rect): { paneId: string; rect: Rect }[] {
  const out: { paneId: string; rect: Rect }[] = [];
  layoutInner(node, area, out);
  return out;
}

function layoutInner(node: LayoutNode, area: Rect, out: { paneId: string; rect: Rect }[]) {
  if (node.type === "leaf") {
    out.push({ paneId: node.paneId, rect: area });
    return;
  }
  const [a, b] = splitRect(area, node.dir, node.ratio);
  layoutInner(node.first, a, out);
  layoutInner(node.second, b, out);
}

/** Compute draggable gutter rects for splits. */
export function computeBorders(node: LayoutNode, area: Rect): BorderRect[] {
  const out: BorderRect[] = [];
  bordersInner(node, area, out, []);
  return out;
}

function bordersInner(node: LayoutNode, area: Rect, out: BorderRect[], path: SplitPath) {
  if (node.type === "split") {
    const [a, b] = splitRect(area, node.dir, node.ratio);
    const border: BorderRect = node.dir === "horizontal"
      ? { x: a.x + a.width, y: area.y, width: 2, height: area.height, dir: node.dir, path, area }
      : { x: area.x, y: a.y + a.height, width: area.width, height: 2, dir: node.dir, path, area };
    out.push(border);
    bordersInner(node.first, a, out, [...path, "first"]);
    bordersInner(node.second, b, out, [...path, "second"]);
  }
}

function splitRect(area: Rect, dir: SplitDir, ratio: number): [Rect, Rect] {
  if (dir === "horizontal") {
    const w1 = Math.round(area.width * ratio);
    const w1c = Math.max(20, Math.min(w1, area.width - 20));
    const w2 = area.width - w1c;
    return [
      { x: area.x, y: area.y, width: w1c, height: area.height },
      { x: area.x + w1c, y: area.y, width: w2, height: area.height },
    ];
  } else {
    const h1 = Math.round(area.height * ratio);
    const h1c = Math.max(20, Math.min(h1, area.height - 20));
    const h2 = area.height - h1c;
    return [
      { x: area.x, y: area.y, width: area.width, height: h1c },
      { x: area.x, y: area.y + h1c, width: area.width, height: h2 },
    ];
  }
}
