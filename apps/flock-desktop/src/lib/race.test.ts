import { describe, expect, it } from "vitest";
import { cleanupPlan, contenderState, raceStem, raceTabName } from "./race";
import type { Pane, RaceState } from "../types";

const pane = (over: Partial<Pane> = {}): Pane => ({
  id: "p1",
  workspaceId: "w1",
  kind: "claude",
  status: "idle",
  attention: false,
  cwd: "/wt/a",
  ...over,
});

const race = (over: Partial<RaceState> = {}): RaceState => ({
  prompt: "Fix the login redirect",
  baseSha: "a".repeat(40),
  baseLabel: "main",
  startedAt: 0,
  contenders: [
    { agentName: "Pluto", branch: "race-fix-the-login-redirect-pluto", worktreePath: "/wt/a" },
    { agentName: "Nova", branch: "race-fix-the-login-redirect-nova", worktreePath: "/wt/b" },
    { agentName: "Vega", branch: "race-fix-the-login-redirect-vega", worktreePath: "/wt/c" },
  ],
  ...over,
});

describe("raceStem", () => {
  it("prefixes the prompt slug so race branches are recognisable as such", () => {
    expect(raceStem("Fix the login redirect")).toBe("race-fix-the-login-redirect");
  });

  // slugify's own fallback is "ws", which belongs to workspaces and would read
  // as a branch someone named by hand.
  it("falls back to a bare race name when nothing survives slugification", () => {
    expect(raceStem("!!! ???")).toBe("race");
    expect(raceStem("")).toBe("race");
  });

  it("keeps the prefix outside slugify's length cap", () => {
    const stem = raceStem("a".repeat(80));
    expect(stem.startsWith("race-")).toBe(true);
    expect(stem.length).toBe("race-".length + 24);
  });
});

describe("raceTabName", () => {
  it("stays short enough to sit in the tab strip", () => {
    expect(raceTabName("Fix the login redirect", 4).length).toBeLessThanOrEqual(20);
  });

  it("never ends on a dangling separator when the slug is cut mid-word", () => {
    expect(raceTabName("one two three four five", 3)).not.toMatch(/-$/);
  });
});

describe("contenderState", () => {
  it("reports gone — not an error — when the agent's pane is closed", () => {
    expect(contenderState(race().contenders[0], [])).toBe("gone");
  });

  it("matches a pane by its worktree, so a restored pane's new id doesn't lose it", () => {
    const restored = pane({ id: "a-completely-different-id", cwd: "/wt/a", worktree: { path: "/wt/a", branch: "x" }, status: "working" });
    expect(contenderState(race().contenders[0], [restored])).toBe("working");
  });

  it("counts a still-spawning agent as working rather than resting", () => {
    expect(contenderState(race().contenders[0], [pane({ spawning: true, status: "idle" })])).toBe("working");
    expect(contenderState(race().contenders[0], [pane({ booting: true, status: "idle" })])).toBe("working");
  });

  it("separates an agent blocked on the user from one resting at its prompt", () => {
    expect(contenderState(race().contenders[0], [pane({ status: "awaiting_input" })])).toBe("needs-input");
    expect(contenderState(race().contenders[0], [pane({ status: "blocked" })])).toBe("needs-input");
    expect(contenderState(race().contenders[0], [pane({ status: "idle" })])).toBe("resting");
    expect(contenderState(race().contenders[0], [pane({ status: "done" })])).toBe("resting");
  });
});

describe("cleanupPlan", () => {
  const winner = "race-fix-the-login-redirect-pluto";

  it("never targets the winner's branch or worktree", () => {
    const plan = cleanupPlan(race(), winner, [], true);
    expect(plan.map((t) => t.branch)).toEqual([
      "race-fix-the-login-redirect-nova",
      "race-fix-the-login-redirect-vega",
    ]);
  });

  // create_worktree hands back an existing worktree when the branch it was
  // asked for is already checked out live, so two contenders can share one
  // directory. Removing it as a loser would pull the ground out from under the
  // winner's own checkout.
  it("spares a loser that shares the winner's checkout", () => {
    const shared = race({
      contenders: [
        { agentName: "Pluto", branch: winner, worktreePath: "/wt/a" },
        { agentName: "Nova", branch: "race-nova", worktreePath: "/wt/a" },
      ],
    });
    expect(cleanupPlan(shared, winner, [], true)).toEqual([]);
  });

  it("carries the pane still holding each worktree, so it can be closed first", () => {
    const panes = [pane({ id: "live-nova", cwd: "/wt/b", worktree: { path: "/wt/b", branch: "race-fix-the-login-redirect-nova" } })];
    const plan = cleanupPlan(race(), winner, panes, true);
    expect(plan.find((t) => t.worktreePath === "/wt/b")?.paneId).toBe("live-nova");
    expect(plan.find((t) => t.worktreePath === "/wt/c")?.paneId).toBeUndefined();
  });

  // Every loser's branch holds work that exists nowhere else — that is what
  // losing a race means. A "delete only if nothing would be lost" rule here
  // would never delete anything, so the flag is the user's call and passes
  // through untouched.
  it("passes the delete-branch choice straight through", () => {
    expect(cleanupPlan(race(), winner, [], true).every((t) => t.deleteBranch)).toBe(true);
    expect(cleanupPlan(race(), winner, [], false).some((t) => t.deleteBranch)).toBe(false);
  });
});
