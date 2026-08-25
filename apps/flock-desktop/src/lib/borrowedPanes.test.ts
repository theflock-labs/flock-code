import { describe, it, expect } from "vitest";
import { type LayoutNode, allPaneIds, paneCount } from "./layout";
import {
  type BorrowedRef,
  addBorrowed,
  removeBorrowed,
  borrowedOwner,
  remapBorrowed,
  reconcileTab,
  appendLeaf,
} from "./borrowedPanes";

function leaf(paneId: string): LayoutNode {
  return { type: "leaf", paneId };
}

function hsplit(ratio: number, first: LayoutNode, second: LayoutNode): LayoutNode {
  return { type: "split", dir: "horizontal", ratio, first, second };
}

function ref(paneId: string, workspaceId: string): BorrowedRef {
  return { paneId, workspaceId };
}

function dirOf(node: LayoutNode): string {
  if (node.type !== "split") throw new Error("expected split");
  return node.dir;
}

describe("addBorrowed", () => {
  it("records a loan on an absent list", () => {
    expect(addBorrowed(undefined, ref("p1", "ws-a"))).toEqual([ref("p1", "ws-a")]);
  });

  it("keeps at most one ref per pane however often it is borrowed", () => {
    let list = addBorrowed(undefined, ref("p1", "ws-a"));
    list = addBorrowed(list, ref("p2", "ws-b"));
    list = addBorrowed(list, ref("p1", "ws-a"));
    expect(list).toEqual([ref("p1", "ws-a"), ref("p2", "ws-b")]);
  });

  it("moves a pane's loan to its new owner without adding a second ref", () => {
    const list = addBorrowed(addBorrowed(undefined, ref("p1", "ws-a")), ref("p1", "ws-c"));
    expect(list).toEqual([ref("p1", "ws-c")]);
  });

  it("leaves the caller's list untouched", () => {
    const before = [ref("p1", "ws-a")];
    addBorrowed(before, ref("p2", "ws-b"));
    expect(before).toEqual([ref("p1", "ws-a")]);
  });
});

describe("removeBorrowed", () => {
  it("returns only the named loan", () => {
    const list = [ref("p1", "ws-a"), ref("p2", "ws-b")];
    expect(removeBorrowed(list, "p1")).toEqual([ref("p2", "ws-b")]);
  });

  it("is a no-op for a pane that was never borrowed", () => {
    const list = [ref("p1", "ws-a")];
    expect(removeBorrowed(list, "p9")).toEqual(list);
    expect(removeBorrowed(undefined, "p9")).toEqual([]);
  });
});

describe("borrowedOwner", () => {
  it("names the owning workspace of a borrowed pane", () => {
    expect(borrowedOwner([ref("p1", "ws-a")], "p1")).toBe("ws-a");
  });

  it("reports nothing for a pane the tab owns itself", () => {
    expect(borrowedOwner([ref("p1", "ws-a")], "p2")).toBeUndefined();
    expect(borrowedOwner(undefined, "p1")).toBeUndefined();
  });
});

describe("remapBorrowed", () => {
  it("rewrites a loan to the pane's fresh id after a restore", () => {
    const { resolved, pending } = remapBorrowed(
      [ref("old1", "ws-a")],
      new Map([["old1", "new1"]]),
    );
    expect(resolved).toEqual([ref("new1", "ws-a")]);
    expect(pending).toEqual([]);
  });

  it("holds back a loan whose owning workspace has not restored yet", () => {
    const { resolved, pending } = remapBorrowed([ref("old1", "ws-a")], new Map());
    expect(resolved).toEqual([]);
    expect(pending).toEqual([ref("old1", "ws-a")]);
  });

  it("splits a mixed list instead of losing either half", () => {
    const list = [ref("old1", "ws-a"), ref("old2", "ws-b"), ref("old3", "ws-a")];
    const { resolved, pending } = remapBorrowed(
      list,
      new Map([
        ["old1", "new1"],
        ["old3", "new3"],
      ]),
    );
    expect(resolved).toEqual([ref("new1", "ws-a"), ref("new3", "ws-a")]);
    expect(pending).toEqual([ref("old2", "ws-b")]);
    expect(resolved.length + pending.length).toBe(list.length);
  });

  it("keeps a pending ref resolvable by a later pass", () => {
    const first = remapBorrowed([ref("old2", "ws-b")], new Map());
    const second = remapBorrowed(first.pending, new Map([["old2", "new2"]]));
    expect(second.resolved).toEqual([ref("new2", "ws-b")]);
    expect(second.pending).toEqual([]);
  });

  it("preserves the owning workspace across the rewrite", () => {
    const { resolved } = remapBorrowed([ref("old1", "ws-a")], new Map([["old1", "new1"]]));
    expect(resolved[0].workspaceId).toBe("ws-a");
  });

  it("returns empty halves for an absent list", () => {
    expect(remapBorrowed(undefined, new Map())).toEqual({ resolved: [], pending: [] });
  });
});

describe("reconcileTab", () => {
  it("drops leaves with no pane behind them and collapses the split", () => {
    const tree = hsplit(0.5, leaf("p1"), leaf("ghost"));
    const { tree: healed } = reconcileTab(tree, [], new Set(["p1"]));
    expect(healed).toEqual(leaf("p1"));
  });

  it("forgets a loan whose owning pane is gone but keeps one still alive off-tree", () => {
    const tree = hsplit(0.5, leaf("p1"), leaf("borrowed-dead"));
    const borrowed = [ref("borrowed-dead", "ws-b"), ref("borrowed-live", "ws-c")];
    const result = reconcileTab(tree, borrowed, new Set(["p1", "borrowed-live"]));
    expect(result.tree).toEqual(leaf("p1"));
    expect(result.borrowed).toEqual([ref("borrowed-live", "ws-c")]);
  });

  it("empties a tab whose every pane died", () => {
    const result = reconcileTab(hsplit(0.5, leaf("a"), leaf("b")), [ref("a", "ws-a")], new Set());
    expect(result.tree).toBeNull();
    expect(result.borrowed).toEqual([]);
  });

  it("leaves a healthy tab exactly as it was", () => {
    const tree = hsplit(0.5, leaf("p1"), leaf("p2"));
    const borrowed = [ref("p2", "ws-b")];
    const result = reconcileTab(tree, borrowed, new Set(["p1", "p2"]));
    expect(result.tree).toEqual(tree);
    expect(result.borrowed).toEqual(borrowed);
  });

  it("tolerates a tab with no tree and no loans", () => {
    expect(reconcileTab(null, undefined, new Set(["p1"]))).toEqual({ tree: null, borrowed: [] });
  });
});

describe("appendLeaf", () => {
  it("makes the first pane the whole tab", () => {
    expect(appendLeaf(null, "p1")).toEqual(leaf("p1"));
  });

  it("shows every appended pane exactly once", () => {
    let tree = appendLeaf(null, "p1");
    tree = appendLeaf(tree, "p2");
    tree = appendLeaf(tree, "p3");
    expect(allPaneIds(tree)).toEqual(["p1", "p2", "p3"]);
    expect(paneCount(tree)).toBe(3);
  });

  it("alternates split direction so repeated appends tile instead of striping", () => {
    const one = appendLeaf(null, "p1");
    const two = appendLeaf(one, "p2");
    const three = appendLeaf(two, "p3");
    const four = appendLeaf(three, "p4");
    expect(dirOf(two)).toBe("vertical");
    expect(dirOf(three)).toBe("horizontal");
    expect(dirOf(four)).toBe("vertical");
  });

  it("leaves the existing panes an equal share of the tab", () => {
    const two = appendLeaf(appendLeaf(null, "p1"), "p2");
    const three = appendLeaf(two, "p3");
    expect(three).toMatchObject({ type: "split", ratio: 2 / 3 });
    expect(two).toMatchObject({ type: "split", ratio: 1 / 2 });
  });

  it("never squeezes the incoming pane below the range splits are created with", () => {
    let tree = appendLeaf(null, "p0");
    for (let i = 1; i < 14; i++) tree = appendLeaf(tree, `p${i}`);
    if (tree.type !== "split") throw new Error("expected split");
    expect(tree.ratio).toBeLessThanOrEqual(0.9);
    expect(tree.ratio).toBeGreaterThanOrEqual(0.1);
  });

  it("is a no-op for a pane the tab already shows", () => {
    const tree = hsplit(0.5, leaf("p1"), leaf("p2"));
    expect(appendLeaf(tree, "p2")).toBe(tree);
    expect(allPaneIds(appendLeaf(tree, "p1"))).toEqual(["p1", "p2"]);
  });

  it("leaves the caller's tree untouched", () => {
    const tree = hsplit(0.5, leaf("p1"), leaf("p2"));
    appendLeaf(tree, "p3");
    expect(tree).toEqual(hsplit(0.5, leaf("p1"), leaf("p2")));
  });
});
