import { describe, expect, it } from "vitest";
import { searchSettings } from "./settingsSearch";

describe("settings search vocabulary", () => {
  it.each([
    ["agent status", "agent-hooks"], ["hooks", "agent-hooks"],
    ["sandbox", "secure-mode"], ["session export", "session-records"],
    ["history", "session-records"], ["theme", "theme"],
    ["app text", "app-text"], ["microphone", "voice"],
  ])("finds the relevant control for %s", (query, id) => {
    expect(searchSettings(query)[0]?.id).toBe(id);
  });

  it("handles case, punctuation and partial words without broad OR matches", () => {
    expect(searchSettings("  AGENT-STAT  ")[0]?.id).toBe("agent-hooks");
    expect(searchSettings("agent impossible-setting")).toEqual([]);
    expect(searchSettings("! ?")).toEqual([]);
    expect(searchSettings(" ")).toEqual([]);
  });
});
