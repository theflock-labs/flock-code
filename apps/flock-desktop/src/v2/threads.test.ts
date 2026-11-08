import { describe, expect, it } from "vitest";
import type { Pane, Workspace, WorkspaceTab } from "../types";
import { ago, buildProjects, filterProjects, parseDormant, rollup, waitingThreads } from "./threads";

function pane(id: string, over: Partial<Pane> = {}): Pane {
  return { id, workspaceId: "w1", kind: "claude", status: "idle", attention: false, cwd: "/r", ...over };
}

function tab(id: string, paneIds: string[], over: Partial<WorkspaceTab> = {}): WorkspaceTab {
  const layoutTree =
    paneIds.length === 0
      ? null
      : paneIds.length === 1
        ? { type: "leaf" as const, paneId: paneIds[0] }
        : {
            type: "split" as const,
            dir: "horizontal" as const,
            ratio: 0.5,
            first: { type: "leaf" as const, paneId: paneIds[0] },
            second: { type: "leaf" as const, paneId: paneIds[1] },
          };
  return { id, name: "1", layoutTree, focusedPaneId: paneIds[0] ?? null, zoomedPaneId: null, ...over };
}

function ws(over: Partial<Workspace>): Workspace {
  return {
    id: "w1",
    name: "lucy-ui",
    repo_path: "/r",
    branch: "main",
    created_at: 0,
    accentColor: "",
    panes: [],
    tabs: [],
    focusedTabId: "",
    agentKind: "claude",
    ...over,
  };
}

describe("buildProjects", () => {
  it("lists one thread per tab with agents, titled by its task", () => {
    const [p] = buildProjects(
      [
        ws({
          panes: [pane("a", { intent: "Fix login" }), pane("b", { displayName: "Pluto" })],
          tabs: [tab("t1", ["a"]), tab("t2", ["b"]), tab("t3", [])],
        }),
      ],
      {},
    );
    expect(p.threads.map((t) => t.title)).toEqual(["Fix login", "Pluto"]);
    expect(p.awake).toBe(true);
  });

  it("prefers the name you gave a thread", () => {
    const [p] = buildProjects(
      [ws({ panes: [pane("a", { intent: "Fix login" })], tabs: [tab("t1", ["a"], { name: "UI", renamed: true })] })],
      {},
    );
    expect(p.threads[0].title).toBe("UI");
  });

  it("rolls a grid up to its most urgent agent and counts what waits on you", () => {
    const [p] = buildProjects(
      [
        ws({
          panes: [pane("a", { status: "working" }), pane("b", { status: "awaiting_input", statusChangedAt: 5 })],
          tabs: [tab("t1", ["a", "b"])],
        }),
      ],
      {},
    );
    expect(p.threads[0].state).toBe("needs-you");
    expect(p.threads[0].agents).toBe(2);
    expect(p.threads[0].since).toBe(5);
    expect(p.waiting).toBe(1);
  });

  it("shows a project that has not woken up from its saved state", () => {
    const raw = JSON.stringify({
      focusedTabId: "t2",
      tabs: [
        { id: "t1", name: "UI", renamed: true, layoutTree: { type: "leaf", paneId: "a" } },
        { id: "t2", name: "2", layoutTree: { type: "leaf", paneId: "b" } },
      ],
      panes: [
        { id: "a", cmd: "claude", intent: "Docs" },
        { id: "b", cmd: "codex", displayName: "Harry" },
      ],
    });
    const d = parseDormant(raw)!;
    const [p] = buildProjects([ws({})], { w1: d });
    expect(p.awake).toBe(false);
    expect(p.threads.map((t) => [t.title, t.state, t.kinds[0]])).toEqual([
      ["UI", "asleep", "claude"],
      ["Harry", "asleep", "codex"],
    ]);
  });

  it("reads a pre-tabs saved state", () => {
    const d = parseDormant(JSON.stringify({ layoutTree: { type: "leaf", paneId: "a" }, panes: [{ id: "a", cmd: "claude" }] }));
    expect(d?.tabs).toHaveLength(1);
    expect(parseDormant("not json")).toBeNull();
  });
});

describe("filterProjects", () => {
  const projects = buildProjects(
    [
      ws({ id: "w1", name: "lucy-ui", panes: [pane("a", { intent: "Fix login" })], tabs: [tab("t1", ["a"])] }),
      ws({ id: "w2", name: "wink", panes: [pane("b", { intent: "Onboarding", kind: "codex" })], tabs: [tab("t2", ["b"])] }),
    ],
    {},
  );

  it("keeps a whole project when its name matches, and single threads otherwise", () => {
    expect(filterProjects(projects, "wink").map((p) => p.name)).toEqual(["wink"]);
    expect(filterProjects(projects, "login")[0].threads.map((t) => t.title)).toEqual(["Fix login"]);
    expect(filterProjects(projects, "codex")[0].name).toBe("wink");
    expect(filterProjects(projects, "  ")).toBe(projects);
  });
});

describe("helpers", () => {
  it("ranks what needs you first", () => {
    expect(rollup(["idle", "working", "failed"])).toBe("failed");
    expect(rollup(["idle", "working"])).toBe("working");
    expect(rollup([])).toBe("idle");
  });

  it("finds every thread waiting on you", () => {
    const projects = buildProjects(
      [ws({ panes: [pane("a", { status: "blocked" })], tabs: [tab("t1", ["a"])] })],
      {},
    );
    expect(waitingThreads(projects).map((t) => t.key)).toEqual(["w1:t1"]);
  });

  it("says how long, briefly", () => {
    expect(ago(undefined, 0)).toBe("");
    expect(ago(0 + 1, 30_000)).toBe("now");
    expect(ago(1, 5 * 60_000)).toBe("4m");
    expect(ago(1, 3 * 3_600_000)).toBe("2h");
    expect(ago(1, 50 * 3_600_000)).toBe("2d");
  });
});

describe("what a thread's agent is on now", () => {
  it("shows the latest task under the name only once the agent has moved on", () => {
    const first = buildProjects(
      [ws({ panes: [pane("p1", { intent: "Spin it up", promptHistory: ["spin it up"] })], tabs: [tab("t1", ["p1"])], focusedTabId: "t1" })],
      {},
    )[0].threads[0];
    expect(first.title).toBe("Spin it up");
    expect(first.doing).toBeUndefined();

    const later = buildProjects(
      [ws({ panes: [pane("p1", { intent: "Spin it up", promptHistory: ["spin it up", "test something here", "yes"] })], tabs: [tab("t1", ["p1"])], focusedTabId: "t1" })],
      {},
    )[0].threads[0];
    expect(later.title).toBe("Spin it up");
    expect(later.doing).toBe("Test something here");
  });
});
