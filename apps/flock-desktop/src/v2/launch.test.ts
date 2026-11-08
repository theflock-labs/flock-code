import { describe, expect, it, beforeEach } from "vitest";
import { launchArgs, loadLaunch, promptArgs, saveLaunch } from "./launch";

describe("launchArgs", () => {
  it("speaks each agent's own flags", () => {
    expect(launchArgs("claude", { model: "opus", effort: "high" })).toEqual(["--model", "opus", "--effort", "high"]);
    expect(launchArgs("codex", { effort: "medium" })).toEqual(["-c", 'model_reasoning_effort="medium"']);
    expect(launchArgs("grok", { effort: "low" })).toEqual(["--reasoning-effort", "low"]);
    expect(launchArgs("opencode", { model: "x/y", effort: "high" })).toEqual([]);
    expect(launchArgs("claude", {})).toEqual([]);
    expect(launchArgs("claude")).toEqual([]);
  });
});

describe("promptArgs", () => {
  it("puts a task after the end of the options", () => {
    expect(promptArgs("claude", "  fix the login redirect  ")).toEqual(["--", "fix the login redirect"]);
    expect(promptArgs("codex", "add tests\nfor checkout")).toEqual(["--", "add tests\nfor checkout"]);
  });

  it("types it for agents without a prompt argument, and for one-word prompts", () => {
    expect(promptArgs("opencode", "fix the bug")).toBeNull();
    expect(promptArgs("pi", "fix the bug")).toBeNull();
    expect(promptArgs("claude", "update")).toBeNull();
  });

  it("has nothing to add for no prompt", () => {
    expect(promptArgs("claude", "")).toEqual([]);
    expect(promptArgs("claude", undefined)).toEqual([]);
  });
});

describe("remembered choices", () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    globalThis.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    } as Storage;
  });

  it("keeps the last model and effort per agent, and drops what an agent no longer offers", () => {
    saveLaunch("claude", { model: "opus", effort: "max" });
    saveLaunch("codex", { model: "opus", effort: "max" });
    expect(loadLaunch("claude")).toEqual({ model: "opus", effort: "max" });
    expect(loadLaunch("codex")).toEqual({ model: undefined, effort: undefined });
    expect(loadLaunch("grok")).toEqual({ model: undefined, effort: undefined });
  });
});
