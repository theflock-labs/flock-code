import { describe, expect, it } from "vitest";
import { branchForAgent, normalizePlan, previewBranches, slugify, validateStem } from "./branchPlan";
import type { BranchPlan } from "../types";

const newPlan = (over: Partial<BranchPlan> = {}): BranchPlan => ({
  mode: "new",
  stem: "refactor-auth",
  baseRef: "origin/main",
  fetch: true,
  ...over,
});

describe("branchForAgent", () => {
  it("gives a solo agent the bare stem", () => {
    expect(branchForAgent(newPlan(), "Pluto", true)).toBe("refactor-auth");
  });

  it("suffixes every additional agent with its own name", () => {
    expect(branchForAgent(newPlan(), "Pluto", false)).toBe("refactor-auth-pluto");
    expect(branchForAgent(newPlan(), "Nova Prime", false)).toBe("refactor-auth-nova-prime");
  });

  // A slash would make refs/heads/refactor-auth a directory, which git can't
  // reconcile with the solo agent's refs/heads/refactor-auth file.
  it("never separates with a slash, so a split can't hit a D/F conflict", () => {
    expect(branchForAgent(newPlan(), "Pluto", false)).not.toContain("refactor-auth/");
  });

  it("returns the picked branch in existing mode, whoever the agent is", () => {
    const plan = newPlan({ mode: "existing", branch: "fix/login" });
    expect(branchForAgent(plan, "Pluto", true)).toBe("fix/login");
    expect(branchForAgent(plan, "Nova", false)).toBe("fix/login");
  });
});

describe("normalizePlan", () => {
  it("leaves an existing-branch checkout alone for one agent", () => {
    const plan = newPlan({ mode: "existing", branch: "fix/login" });
    expect(normalizePlan(plan, 1)).toEqual(plan);
  });

  // git allows a branch in one worktree at a time, so N agents can't all check
  // out the same one; the pick becomes the base instead.
  it("turns an existing-branch pick into a base ref past one agent", () => {
    const plan = newPlan({ mode: "existing", branch: "fix/login", fetch: false });
    expect(normalizePlan(plan, 4)).toEqual({
      mode: "new",
      stem: "fix-login",
      baseRef: "fix/login",
      fetch: false,
    });
  });

  it("leaves new and current plans untouched", () => {
    expect(normalizePlan(newPlan(), 8)).toEqual(newPlan());
    const shared = newPlan({ mode: "current" });
    expect(normalizePlan(shared, 8)).toEqual(shared);
  });
});

describe("validateStem", () => {
  it("accepts ordinary branch names", () => {
    expect(validateStem("refactor-auth")).toBeNull();
    expect(validateStem("feat/login-v2")).toBeNull();
    expect(validateStem("release-1.2")).toBeNull();
  });

  it("rejects what git would reject", () => {
    for (const bad of ["", "  ", "has space", "-lead", "/lead", "trail/", "a//b", "a..b", "end.", "@", "HEAD", "a@{0}", "a~1", "a^", "a:b", "a?", "a*", "a\\b"]) {
      expect(validateStem(bad), `expected ${JSON.stringify(bad)} to be rejected`).not.toBeNull();
    }
  });
});

describe("previewBranches", () => {
  it("shows the exact name for a solo agent and the shape for a fleet", () => {
    expect(previewBranches(newPlan(), 1)).toBe("refactor-auth");
    expect(previewBranches(newPlan(), 4)).toBe("refactor-auth-<agent>");
  });

  it("previews the normalized plan, not the raw pick", () => {
    const plan = newPlan({ mode: "existing", branch: "fix/login" });
    expect(previewBranches(plan, 1)).toBe("fix/login");
    expect(previewBranches(plan, 2)).toBe("fix-login-<agent>");
  });

  it("has nothing to preview when agents share the checkout", () => {
    expect(previewBranches(newPlan({ mode: "current" }), 4)).toBe("");
  });
});

describe("slugify", () => {
  it("produces a ref-safe, length-capped slug", () => {
    expect(slugify("Refactor Auth!")).toBe("refactor-auth");
    expect(slugify("  ")).toBe("ws");
    expect(slugify("x".repeat(50))).toHaveLength(24);
  });
});
