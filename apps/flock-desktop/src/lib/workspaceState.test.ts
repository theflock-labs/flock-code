import { describe, it, expect } from "vitest";
import type { Pane, WorkspaceTab } from "../types";
import {
  agentCommand,
  buildWorkspaceStateBlob,
  patchSavedBudget,
  restoreDisplayNames,
  shouldHydrateAfterEmptyRestore,
  shouldPersistWorkspace,
  worktreesFromSavedState,
  type WorkspaceStateSource,
} from "./workspaceState";

const tab: WorkspaceTab = {
  id: "tab-1",
  name: "1",
  layoutTree: { type: "leaf", paneId: "p1" },
  focusedPaneId: "p1",
  zoomedPaneId: null,
};

function pane(partial: Partial<Pane> & Pick<Pane, "id" | "kind">): Pane {
  return {
    workspaceId: "ws-1",
    status: "idle",
    attention: false,
    cwd: "/repo",
    ...partial,
  };
}

function source(over: Partial<WorkspaceStateSource> = {}): WorkspaceStateSource {
  return {
    id: "ws-1",
    agentKind: "claude",
    tabs: [tab],
    focusedTabId: "tab-1",
    panes: [],
    ...over,
  };
}

describe("shouldPersistWorkspace", () => {
  it("does not write an unrestored shell", () => {
    const hydrated = new Set<string>();
    expect(shouldPersistWorkspace(source({ panes: [] }), hydrated)).toBe(false);
  });

  it("writes once the workspace has been hydrated", () => {
    expect(shouldPersistWorkspace(source(), new Set(["ws-1"]))).toBe(true);
  });

  it("never writes a session workspace, even if the id is hydrated", () => {
    const hydrated = new Set(["ws-1"]);
    expect(shouldPersistWorkspace(source({ copilot: { sessionId: "s", partnerLogin: "a", partnerWid: "w", status: "connected" } }), hydrated)).toBe(false);
    expect(shouldPersistWorkspace(source({ observe: { sessionId: "s", ownerLogin: "a", ownerWid: "w" } }), hydrated)).toBe(false);
  });
});

describe("shouldHydrateAfterEmptyRestore", () => {
  const emptyRestore = new Set(["ws-1"]);

  it("hydrates once a pane exists after restore spawned none", () => {
    expect(
      shouldHydrateAfterEmptyRestore(
        source({ panes: [pane({ id: "p1", kind: "claude" })] }),
        new Set(),
        emptyRestore,
      ),
    ).toBe(true);
  });

  it("does not hydrate an unrestored shell that never finished restore", () => {
    expect(
      shouldHydrateAfterEmptyRestore(
        source({ panes: [pane({ id: "p1", kind: "claude" })] }),
        new Set(),
        new Set(),
      ),
    ).toBe(false);
  });

  it("does not hydrate while the workspace is still empty", () => {
    expect(shouldHydrateAfterEmptyRestore(source({ panes: [] }), new Set(), emptyRestore)).toBe(false);
  });
});

describe("buildWorkspaceStateBlob", () => {
  it("round-trips each pane's own cmd, not the workspace default", () => {
    const blob = buildWorkspaceStateBlob(source({
      agentKind: "claude",
      panes: [
        pane({ id: "p1", kind: "claude", displayName: "Pluto" }),
        pane({ id: "p2", kind: "opencode", displayName: "Nova" }),
        pane({ id: "p3", kind: "codex", displayName: "Otto" }),
      ],
    }));
    expect(blob.agentKind).toBe("claude");
    expect(blob.panes.map((p) => p.cmd)).toEqual(["claude", "opencode", "codex"]);
    expect(blob.panes[0]).toMatchObject(agentCommand("claude"));
    expect(blob.panes[1]).toMatchObject(agentCommand("opencode"));
    expect(blob.panes[2]).toMatchObject(agentCommand("codex"));
  });

  it("maps an unknown pane kind through the AgentKind guard, not a default launch", () => {
    const blob = buildWorkspaceStateBlob(source({
      panes: [pane({ id: "p1", kind: "not-an-agent" })],
    }));
    expect(blob.panes[0]).toMatchObject(agentCommand("claude"));
  });

  it("persists displayName so restore can reuse it", () => {
    const blob = buildWorkspaceStateBlob(source({
      panes: [pane({ id: "p1", kind: "claude", displayName: "Pluto" })],
    }));
    expect(blob.panes[0].displayName).toBe("Pluto");
  });
});

describe("restoreDisplayNames", () => {
  it("reuses a saved displayName and only mints the gaps", () => {
    const minted: string[] = [];
    const names = restoreDisplayNames(
      [{ displayName: "Pluto" }, {}, { displayName: "Nova" }],
      (taken) => {
        const next = `mint-${taken.length}`;
        minted.push(next);
        return next;
      },
    );
    expect(names).toEqual(["Pluto", "mint-1", "Nova"]);
    expect(minted).toEqual(["mint-1"]);
  });
});

describe("patchSavedBudget", () => {
  it("sets budget on an existing blob without touching panes", () => {
    const raw = JSON.stringify({
      agentKind: "claude",
      panes: [{ id: "p1", cmd: "opencode", args: ["-c"], cwd: "/wt/a" }],
    });
    const next = JSON.parse(patchSavedBudget(raw, { period: "day", limitUsd: 10 }));
    expect(next.budget).toEqual({ period: "day", limitUsd: 10 });
    expect(next.panes).toEqual([{ id: "p1", cmd: "opencode", args: ["-c"], cwd: "/wt/a" }]);
    expect(next.agentKind).toBe("claude");
  });

  it("writes a budget-only blob when nothing was saved", () => {
    expect(JSON.parse(patchSavedBudget("", { period: "month", limitUsd: 50 }))).toEqual({
      budget: { period: "month", limitUsd: 50 },
    });
    expect(JSON.parse(patchSavedBudget(undefined, { period: "day", limitUsd: 1 }))).toEqual({
      budget: { period: "day", limitUsd: 1 },
    });
  });

  it("does not invent a budget-only blob over unreadable JSON", () => {
    expect(() => patchSavedBudget("not-json", { period: "day", limitUsd: 10 })).toThrow(
      /not valid JSON/,
    );
    expect(() => patchSavedBudget("[]", { period: "day", limitUsd: 10 })).toThrow(/not an object/);
    expect(() => patchSavedBudget("null", { period: "day", limitUsd: 10 })).toThrow(/not an object/);
  });

  it("clears budget without dropping other fields", () => {
    const raw = JSON.stringify({
      agentKind: "claude",
      budget: { period: "day", limitUsd: 10 },
      panes: [{ id: "p1", cmd: "claude", args: [], cwd: "/repo" }],
    });
    const next = JSON.parse(patchSavedBudget(raw, undefined));
    expect(next.budget).toBeUndefined();
    expect(next.agentKind).toBe("claude");
    expect(next.panes).toHaveLength(1);
  });
});

describe("worktreesFromSavedState", () => {
  it("lists worktree paths from an unrestored workspace's blob", () => {
    const raw = JSON.stringify({
      agentKind: "claude",
      panes: [
        { id: "p1", cmd: "claude", args: [], cwd: "/wt/a", worktree: { path: "/wt/a", branch: "feat-a" } },
        { id: "p2", cmd: "opencode", args: [], cwd: "/repo" },
        { id: "p3", cmd: "codex", args: [], cwd: "/wt/c", worktree: { path: "/wt/c", branch: "feat-c" } },
      ],
    });
    expect(worktreesFromSavedState(raw)).toEqual([
      { path: "/wt/a", branch: "feat-a" },
      { path: "/wt/c", branch: "feat-c" },
    ]);
  });

  it("returns nothing for a missing or unreadable blob", () => {
    expect(worktreesFromSavedState(undefined)).toEqual([]);
    expect(worktreesFromSavedState("")).toEqual([]);
    expect(worktreesFromSavedState("not-json")).toEqual([]);
  });
});
