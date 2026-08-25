import { describe, it, expect } from "vitest";
import {
  type LayoutNode,
  type Rect,
  split,
  remove,
  allPaneIds,
  paneCount,
  firstPaneId,
  setRatioAtPath,
  balanceLayoutTree,
  remapLayoutTree,
  pruneLayoutTree,
  buildGridLayout,
  computeLayout,
  swapPanes,
} from "./layout";

const EPS = 1e-6;

function leaf(paneId: string): LayoutNode {
  return { type: "leaf", paneId };
}

function hsplit(ratio: number, first: LayoutNode, second: LayoutNode): LayoutNode {
  return { type: "split", dir: "horizontal", ratio, first, second };
}

function vsplit(ratio: number, first: LayoutNode, second: LayoutNode): LayoutNode {
  return { type: "split", dir: "vertical", ratio, first, second };
}

function area(width: number, height: number): Rect {
  return { x: 0, y: 0, width, height };
}

function ratioOf(node: LayoutNode): number {
  if (node.type !== "split") throw new Error("expected split");
  return node.ratio;
}

function secondOf(node: LayoutNode): LayoutNode {
  if (node.type !== "split") throw new Error("expected split");
  return node.second;
}

function assertTilesArea(rects: { paneId: string; rect: Rect }[], a: Rect) {
  const total = rects.reduce((sum, { rect }) => sum + rect.width * rect.height, 0);
  expect(total).toBe(a.width * a.height);
  for (const { rect } of rects) {
    expect(rect.x).toBeGreaterThanOrEqual(a.x);
    expect(rect.y).toBeGreaterThanOrEqual(a.y);
    expect(rect.x + rect.width).toBeLessThanOrEqual(a.x + a.width);
    expect(rect.y + rect.height).toBeLessThanOrEqual(a.y + a.height);
  }
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const r = rects[i].rect;
      const o = rects[j].rect;
      const xOverlap = r.x < o.x + o.width && o.x < r.x + r.width;
      const yOverlap = r.y < o.y + o.height && o.y < r.y + r.height;
      expect(xOverlap && yOverlap).toBe(false);
    }
  }
}

describe("split / remove", () => {
  it("splits the targeted leaf, placing the new pane second", () => {
    const tree = split(hsplit(0.5, leaf("a"), leaf("b")), "b", "vertical", "c");
    expect(paneCount(tree)).toBe(3);
    expect(allPaneIds(tree)).toEqual(["a", "b", "c"]);
    const inner = secondOf(tree);
    expect(inner).toEqual(vsplit(0.5, leaf("b"), leaf("c")));
    expect(firstPaneId(tree)).toBe("a");
  });

  it("removing a leaf collapses its split; removing the last returns null", () => {
    let tree: LayoutNode | null = hsplit(0.5, leaf("a"), vsplit(0.5, leaf("b"), leaf("c")));
    tree = remove(tree, "b");
    expect(tree).toEqual(hsplit(0.5, leaf("a"), leaf("c")));
    tree = remove(tree!, "a");
    expect(tree).toEqual(leaf("c"));
    expect(remove(tree!, "c")).toBeNull();
  });
});

describe("setRatioAtPath", () => {
  it("sets the ratio at a nested path and clamps to 0.1..0.9", () => {
    const tree = hsplit(0.5, leaf("a"), vsplit(0.5, leaf("b"), leaf("c")));
    expect(ratioOf(setRatioAtPath(tree, [], 0.3))).toBeCloseTo(0.3, 6);
    expect(ratioOf(setRatioAtPath(tree, [], 0.05))).toBeCloseTo(0.1, 6);
    expect(ratioOf(setRatioAtPath(tree, [], 0.95))).toBeCloseTo(0.9, 6);
    const nested = setRatioAtPath(tree, ["second"], 0.99);
    expect(ratioOf(secondOf(nested))).toBeCloseTo(0.9, 6);
    expect(ratioOf(nested)).toBeCloseTo(0.5, 6); // untouched
  });
});

describe("balanceLayoutTree", () => {
  // Parity case with crates/flock-tui/src/layout.rs reset_ratios tests:
  // leaf | (leaf | leaf) balances to 1/3 · 1/3 · 1/3 (root ratio 1/3,
  // inner 1/2), not 1/2 · 1/4 · 1/4.
  it("weights a 3-leaf chain to thirds", () => {
    const balanced = balanceLayoutTree(hsplit(0.8, leaf("a"), hsplit(0.2, leaf("b"), leaf("c"))));
    expect(Math.abs(ratioOf(balanced) - 1 / 3)).toBeLessThan(EPS);
    expect(Math.abs(ratioOf(secondOf(balanced)) - 0.5)).toBeLessThan(EPS);
  });

  // Parity case with layout.rs: 4-leaf right-leaning chain
  // leaf | (leaf | (leaf | leaf)) balances to ratios 1/4, 1/3, 1/2.
  it("weights a 4-leaf asymmetric chain", () => {
    const tree = hsplit(0.5, leaf("a"), vsplit(0.5, leaf("b"), hsplit(0.5, leaf("c"), leaf("d"))));
    const balanced = balanceLayoutTree(tree);
    expect(Math.abs(ratioOf(balanced) - 0.25)).toBeLessThan(EPS);
    const inner = secondOf(balanced);
    expect(Math.abs(ratioOf(inner) - 1 / 3)).toBeLessThan(EPS);
    expect(Math.abs(ratioOf(secondOf(inner)) - 0.5)).toBeLessThan(EPS);
  });
});

describe("remapLayoutTree", () => {
  it("maps leaf IDs through the old→new map, keeping unknown IDs", () => {
    const tree = hsplit(0.4, leaf("old-a"), vsplit(0.6, leaf("old-b"), leaf("keep")));
    const remapped = remapLayoutTree(
      tree,
      new Map([["old-a", "new-a"], ["old-b", "new-b"]]),
    );
    expect(remapped).toEqual(hsplit(0.4, leaf("new-a"), vsplit(0.6, leaf("new-b"), leaf("keep"))));
  });
});

describe("pruneLayoutTree", () => {
  it("drops ghost leaves and collapses the orphaned split", () => {
    const tree = hsplit(0.5, leaf("ghost"), vsplit(0.5, leaf("b"), leaf("c")));
    const pruned = pruneLayoutTree(tree, new Set(["b", "c"]));
    expect(pruned).toEqual(vsplit(0.5, leaf("b"), leaf("c")));
  });

  it("returns null when only ghosts remain", () => {
    const tree = hsplit(0.5, leaf("ghost1"), leaf("ghost2"));
    expect(pruneLayoutTree(tree, new Set(["real"]))).toBeNull();
  });
});

describe("buildGridLayout presets", () => {
  // rows × cols per WindowLayout preset (layoutGrid in App.tsx).
  const presets: [number, number, number][] = [
    [1, 1, 1],
    [2, 1, 2],
    [4, 2, 2],
    [6, 2, 3],
    [8, 2, 4],
    [12, 3, 4],
  ];

  for (const [count, rows, cols] of presets) {
    it(`builds a balanced ${rows}x${cols} grid for ${count} pane(s)`, () => {
      const ids = Array.from({ length: count }, (_, i) => `p${i}`);
      const tree = buildGridLayout(ids, rows, cols);
      expect(paneCount(tree)).toBe(count);
      expect(allPaneIds(tree)).toEqual(ids);

      // Every cell gets an equal share of a divisible area.
      const a = area(cols * 240, rows * 240);
      const rects = computeLayout(tree, a);
      assertTilesArea(rects, a);
      for (const { rect } of rects) {
        expect(rect.width).toBe(240);
        expect(rect.height).toBe(240);
      }
    });
  }
});

describe("swapPanes", () => {
  const tree = hsplit(0.3, leaf("a"), vsplit(0.6, leaf("b"), leaf("c")));

  it("trades two panes' places", () => {
    const swapped = swapPanes(tree, "a", "c");
    expect(swapped).toEqual(hsplit(0.3, leaf("c"), vsplit(0.6, leaf("b"), leaf("a"))));
  });

  it("keeps every split direction and ratio", () => {
    const swapped = swapPanes(tree, "a", "b");
    const rects = computeLayout(swapped, area(1000, 500));
    const before = computeLayout(tree, area(1000, 500));
    // Same cells, different occupants.
    expect(rects.map((r) => r.rect)).toEqual(before.map((r) => r.rect));
    expect(rects.map((r) => r.paneId)).toEqual(["b", "a", "c"]);
  });

  it("is a no-op for a pane swapped with itself or an unknown id", () => {
    expect(swapPanes(tree, "a", "a")).toBe(tree);
    // Never plants an id with no pane behind it (that renders as a blank,
    // uncloseable ghost pane).
    expect(swapPanes(tree, "a", "zzz")).toBe(tree);
  });

  it("never duplicates or drops a pane in a 12-agent grid", () => {
    const ids = Array.from({ length: 12 }, (_, i) => `p${i}`);
    const grid = buildGridLayout(ids, 3, 4);
    const swapped = swapPanes(grid, "p0", "p11");
    expect([...allPaneIds(swapped)].sort()).toEqual([...ids].sort());
    expect(paneCount(swapped)).toBe(12);
  });
});

describe("computeLayout", () => {
  it("tiles the area without overlap for an asymmetric tree", () => {
    const tree = balanceLayoutTree(hsplit(0.5, leaf("a"), vsplit(0.5, leaf("b"), leaf("c"))));
    const a = area(900, 450);
    const rects = computeLayout(tree, a);
    expect(rects.length).toBe(3);
    assertTilesArea(rects, a);
  });

  it("respects the split ratio", () => {
    const rects = computeLayout(hsplit(0.3, leaf("a"), leaf("b")), area(1000, 200));
    expect(rects[0].rect.width).toBe(300);
    expect(rects[1].rect.width).toBe(700);
  });

  it("clamps each side to the 20px minimum on extreme ratios", () => {
    // Ratios beyond splitRect's clamp window still leave 20px per side.
    const wide = computeLayout(hsplit(0.9, leaf("a"), leaf("b")), area(100, 100));
    expect(wide[0].rect.width).toBe(80);
    expect(wide[1].rect.width).toBe(20);
    const tall = computeLayout(vsplit(0.01, leaf("a"), leaf("b")), area(100, 100));
    expect(tall[0].rect.height).toBe(20);
    expect(tall[1].rect.height).toBe(80);
  });
});
