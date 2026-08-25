import { describe, expect, it } from "vitest";
import {
  attributeSpend,
  dayStartMs,
  isUnder,
  monthStartMs,
  periodKey,
  spendFor,
  type PaneRef,
  type WorkspaceRef,
} from "./spendAttribution";
import type { SessionSpend, SpendWindow } from "./tauri";

function row(session_id: string, cwd: string, cost_usd: number, tokens = cost_usd * 1000): SessionSpend {
  return { session_id, cwd, tokens, cost_usd, last_ms: 0 };
}

function win(sessions: SessionSpend[], extra: Partial<SpendWindow> = {}): SpendWindow {
  const tokens = sessions.reduce((n, s) => n + s.tokens, 0) + (extra.unattributed_tokens ?? 0);
  const cost = sessions.reduce((n, s) => n + s.cost_usd, 0) + (extra.unattributed_cost_usd ?? 0);
  return {
    since_ms: 0,
    tokens,
    cost_usd: cost,
    sessions,
    unattributed_tokens: 0,
    unattributed_cost_usd: 0,
    undated_cost_usd: 0,
    ...extra,
  };
}

const WORKSPACES: WorkspaceRef[] = [
  { id: "ws-a", repoPath: "/src/flock-code" },
  { id: "ws-b", repoPath: "/src/other" },
];

const PANES: PaneRef[] = [
  { id: "p1", workspaceId: "ws-a", sessionId: "s1", cwd: "/wt/alpha" },
  { id: "p2", workspaceId: "ws-a", sessionId: "s2", cwd: "/wt/beta" },
  { id: "p3", workspaceId: "ws-b", sessionId: "s3", cwd: "/src/other" },
];

describe("attributeSpend", () => {
  it("charges a session to its pane, its workspace and its repo", () => {
    const a = attributeSpend(win([row("s1", "/wt/alpha", 3)]), PANES, WORKSPACES);
    expect(spendFor(a.perPane, "p1").costUsd).toBe(3);
    expect(spendFor(a.perWorkspace, "ws-a").costUsd).toBe(3);
    expect(spendFor(a.perRepo, "/src/flock-code").costUsd).toBe(3);
    expect(a.unclaimed.costUsd).toBe(0);
  });

  it("sums the workspace's panes rather than reporting only the largest", () => {
    const a = attributeSpend(win([row("s1", "/wt/alpha", 3), row("s2", "/wt/beta", 4)]), PANES, WORKSPACES);
    expect(spendFor(a.perWorkspace, "ws-a").costUsd).toBe(7);
    expect(spendFor(a.perPane, "p1").costUsd).toBe(3);
    expect(spendFor(a.perPane, "p2").costUsd).toBe(4);
  });

  it("collapses two workspaces on one repo into a single repo row", () => {
    const panes: PaneRef[] = [
      { id: "p1", workspaceId: "ws-a", sessionId: "s1", cwd: "/wt/alpha" },
      { id: "p9", workspaceId: "ws-c", sessionId: "s9", cwd: "/wt/gamma" },
    ];
    const workspaces: WorkspaceRef[] = [
      { id: "ws-a", repoPath: "/src/flock-code" },
      { id: "ws-c", repoPath: "/src/flock-code" },
    ];
    const a = attributeSpend(win([row("s1", "/wt/alpha", 2), row("s9", "/wt/gamma", 5)]), panes, workspaces);
    expect(spendFor(a.perRepo, "/src/flock-code").costUsd).toBe(7);
    expect(spendFor(a.perWorkspace, "ws-a").costUsd).toBe(2);
    expect(spendFor(a.perWorkspace, "ws-c").costUsd).toBe(5);
  });

  it("falls back to the worktree when the session's pane is gone", () => {
    // Session id nobody claims, but the directory is a live pane's worktree —
    // e.g. the agent was closed and respawned since the spend happened.
    const a = attributeSpend(win([row("s-dead", "/wt/alpha", 6)]), PANES, WORKSPACES);
    expect(spendFor(a.perWorkspace, "ws-a").costUsd).toBe(6);
    // A directory match says "some agent in this worktree", so no pane is named.
    expect(a.perPane.size).toBe(0);
  });

  it("falls back to the repo the directory sits inside", () => {
    const a = attributeSpend(win([row("s-dead", "/src/other/sub/dir", 4)]), PANES, WORKSPACES);
    expect(spendFor(a.perWorkspace, "ws-b").costUsd).toBe(4);
  });

  it("prefers the innermost repo when one is checked out inside another", () => {
    const workspaces: WorkspaceRef[] = [
      { id: "outer", repoPath: "/src" },
      { id: "inner", repoPath: "/src/flock-code" },
    ];
    const a = attributeSpend(win([row("s-x", "/src/flock-code/apps", 9)]), [], workspaces);
    expect(spendFor(a.perWorkspace, "inner").costUsd).toBe(9);
    expect(a.perWorkspace.has("outer")).toBe(false);
  });

  it("does not let a sibling directory borrow a repo's budget", () => {
    // "/src/flock-code-old" starts with "/src/flock-code" as a string. A plain
    // startsWith would charge the old checkout's agents to the new repo.
    const a = attributeSpend(win([row("s-x", "/src/flock-code-old", 5)]), [], WORKSPACES);
    expect(a.perWorkspace.size).toBe(0);
    expect(a.unclaimed.costUsd).toBe(5);
  });

  it("puts spend from an unknown directory in unclaimed, never on a workspace", () => {
    const a = attributeSpend(win([row("s-x", "/somewhere/else", 8)]), PANES, WORKSPACES);
    expect(a.perWorkspace.size).toBe(0);
    expect(a.unclaimed.costUsd).toBe(8);
  });

  it("folds the window's own session-less remainder into unclaimed", () => {
    const w = win([row("s1", "/wt/alpha", 2)], {
      unattributed_tokens: 500,
      unattributed_cost_usd: 1.5,
    });
    const a = attributeSpend(w, PANES, WORKSPACES);
    expect(a.unclaimed.costUsd).toBe(1.5);
    expect(a.unclaimed.tokens).toBe(500);
  });

  it("conserves the total: workspaces plus unclaimed equals the window", () => {
    // The identity that stops a budget being quietly wrong in either
    // direction. Mixed on purpose: a pane hit, a worktree hit, a repo hit, an
    // orphan, and a session-less remainder.
    const w = win(
      [
        row("s1", "/wt/alpha", 3),
        row("s-dead", "/wt/beta", 4),
        row("s-old", "/src/other/deep", 5),
        row("s-nowhere", "/tmp/x", 6),
      ],
      { unattributed_tokens: 100, unattributed_cost_usd: 7 },
    );
    const a = attributeSpend(w, PANES, WORKSPACES);
    const summed = [...a.perWorkspace.values()].reduce((n, s) => n + s.costUsd, 0);
    expect(summed + a.unclaimed.costUsd).toBeCloseTo(a.total.costUsd, 10);
    expect(a.total.costUsd).toBe(25);
    const summedTokens = [...a.perWorkspace.values()].reduce((n, s) => n + s.tokens, 0);
    expect(summedTokens + a.unclaimed.tokens).toBe(a.total.tokens);
  });

  it("counts a session once even if two panes claim the same id", () => {
    const panes: PaneRef[] = [
      { id: "p1", workspaceId: "ws-a", sessionId: "dup", cwd: "/wt/alpha" },
      { id: "p2", workspaceId: "ws-b", sessionId: "dup", cwd: "/wt/beta" },
    ];
    const a = attributeSpend(win([row("dup", "/wt/alpha", 10)]), panes, WORKSPACES);
    const summed = [...a.perWorkspace.values()].reduce((n, s) => n + s.costUsd, 0);
    expect(summed).toBe(10);
    expect(a.perPane.size).toBe(1);
  });

  it("reads a missing window as zero, not as an error", () => {
    const a = attributeSpend(null, PANES, WORKSPACES);
    expect(a.total.costUsd).toBe(0);
    expect(a.perWorkspace.size).toBe(0);
  });
});

describe("isUnder", () => {
  it("matches a directory and its descendants, not its name-prefix siblings", () => {
    expect(isUnder("/a/b", "/a/b")).toBe(true);
    expect(isUnder("/a/b/c", "/a/b")).toBe(true);
    expect(isUnder("/a/bc", "/a/b")).toBe(false);
    expect(isUnder("/a", "/a/b")).toBe(false);
    expect(isUnder("", "/a")).toBe(false);
    expect(isUnder("/a", "")).toBe(false);
    // A trailing slash on the parent must not double up into "/a//".
    expect(isUnder("/a/b", "/a/")).toBe(true);
  });
});

describe("window boundaries", () => {
  // Local, not UTC: a UTC day resets mid-afternoon in Sydney, which would fire
  // the day's alert twice on one working day.
  it("dayStartMs is local midnight of the same local day", () => {
    const now = new Date(2026, 7, 9, 14, 30, 15, 250).getTime();
    const start = dayStartMs(now);
    const d = new Date(start);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
    expect(d.getDate()).toBe(9);
    expect(start).toBeLessThanOrEqual(now);
  });

  it("monthStartMs is local midnight on the first", () => {
    const now = new Date(2026, 7, 9, 14, 30).getTime();
    const d = new Date(monthStartMs(now));
    expect(d.getDate()).toBe(1);
    expect(d.getMonth()).toBe(7);
    expect(d.getHours()).toBe(0);
  });

  it("a month start never lands after the day start inside it", () => {
    // The ordering the two-cutoff scan depends on.
    const now = new Date(2026, 0, 1, 0, 30).getTime();
    expect(monthStartMs(now)).toBeLessThanOrEqual(dayStartMs(now));
  });

  it("periodKey changes at the local boundary and pads its parts", () => {
    const jan5 = new Date(2026, 0, 5, 23, 59).getTime();
    const jan6 = new Date(2026, 0, 6, 0, 0).getTime();
    expect(periodKey(jan5, "day")).toBe("2026-01-05");
    expect(periodKey(jan6, "day")).toBe("2026-01-06");
    expect(periodKey(jan5, "month")).toBe("2026-01");
    expect(periodKey(jan6, "month")).toBe("2026-01");
    expect(periodKey(new Date(2026, 11, 31, 12).getTime(), "month")).toBe("2026-12");
  });
});
