import { afterEach, describe, expect, it, vi } from "vitest";
import { readWorkspacePresets, writeWorkspacePresets } from "./workspacePresets";

afterEach(() => vi.unstubAllGlobals());

describe("workspace preset storage", () => {
  it("recovers usable lineups from partially corrupted storage", () => {
    const valid = { id: "saved", name: " Daily team ", agents: ["claude", "codex", "pi"] };
    vi.stubGlobal("localStorage", { getItem: () => JSON.stringify([
      null, { ...valid, agents: [] }, { ...valid, agents: ["unknown"] },
      { ...valid, id: "starter-claude" }, valid, { ...valid, name: "Duplicate ID" },
    ]) });
    expect(readWorkspacePresets()).toEqual([{ ...valid, name: "Daily team" }]);
  });

  it("tolerates unreadable storage and reports write failures", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("quota"); },
    });
    expect(readWorkspacePresets()).toEqual([]);
    expect(writeWorkspacePresets([])).toBe(false);
  });

  it("ignores malformed JSON rather than breaking the new-workspace dialog", () => {
    vi.stubGlobal("localStorage", { getItem: () => "not json" });
    expect(readWorkspacePresets()).toEqual([]);
  });
});
