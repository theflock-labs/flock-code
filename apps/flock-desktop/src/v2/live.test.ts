import { describe, expect, it } from "vitest";
import type { HookEvent } from "../lib/tauri";
import { activityLabel, applyHookEvent, pageLabel, turnErrorLabel } from "./live";
import { paneState } from "./threads";

const ev = (event: HookEvent["event"], extra: Partial<HookEvent> = {}): HookEvent => ({ time: 1, agent: "claude", event, pane_id: "p", ...extra });

describe("live agent state from hooks", () => {
  it("says what a tool call is doing", () => {
    const live = applyHookEvent(undefined, ev("PreToolUse", { tool: "Edit", detail: "src/checkout/Steps.tsx" }));
    expect(activityLabel(live)).toBe("Editing src/checkout/Steps.tsx");
    expect(activityLabel(applyHookEvent(live, ev("PreToolUse", { tool: "Bash", detail: "Run the tests" })))).toBe("Run the tests");
    expect(activityLabel(applyHookEvent(live, ev("PreToolUse", { tool: "mcp__flock-graph__kg_query" })))).toBe("flock-graph: kg query");
  });

  it("keeps the page an agent opened in Wink for the rest of its turn", () => {
    let live = applyHookEvent(undefined, ev("PreToolUse", { tool: "mcp__wink__navigate", url: "http://localhost:3000/checkout?step=2" }));
    expect(activityLabel(live)).toBe("Opening localhost:3000/checkout in Wink");
    live = applyHookEvent(live, ev("PreToolUse", { tool: "mcp__wink__console_logs" }));
    expect(activityLabel(live)).toBe("Reading the console in Wink");
    expect(live?.browsing).toBe("http://localhost:3000/checkout?step=2");
    live = applyHookEvent(live, ev("Stop"));
    expect(live?.tool).toBeUndefined();
    expect(live?.browsing).toBe("http://localhost:3000/checkout?step=2");
    live = applyHookEvent(live, ev("UserPromptSubmit"));
    expect(live?.browsing).toBeUndefined();
  });

  it("counts to-dos from TodoWrite and from task events", () => {
    const todo = applyHookEvent(undefined, ev("PreToolUse", { tool: "TodoWrite", todos_done: 1, todos_total: 4 }));
    expect(todo?.todos).toEqual({ done: 1, total: 4 });
    let live = applyHookEvent(undefined, ev("TaskCreated", { task_id: "a" }));
    live = applyHookEvent(live, ev("TaskCreated", { task_id: "b" }));
    live = applyHookEvent(live, ev("TaskCompleted", { task_id: "a" }));
    live = applyHookEvent(live, ev("TaskCompleted", { task_id: "a" }));
    expect(live?.todos).toEqual({ done: 1, total: 2 });
  });

  it("shows a failed turn as failed, with its reason, until the next turn", () => {
    let live = applyHookEvent(undefined, ev("StopFailure", { error: "rate_limit" }));
    expect(paneState({ status: "idle", live })).toBe("failed");
    expect(turnErrorLabel(live?.turnError)).toBe("hit its rate limit");
    live = applyHookEvent(live, ev("UserPromptSubmit"));
    expect(paneState({ status: "working", live })).toBe("working");
    expect(live?.turnError).toBeUndefined();
  });

  it("a finished turn you have not seen is done; once seen, idle", () => {
    expect(paneState({ status: "idle", live: { doneUnseen: true } })).toBe("done");
    expect(paneState({ status: "idle", live: { doneUnseen: false } })).toBe("idle");
    expect(paneState({ status: "awaiting_input", live: { doneUnseen: true } })).toBe("needs-you");
  });

  it("leaves unrelated events alone", () => {
    const live = { tool: "Read" };
    expect(applyHookEvent(live, ev("Notification", { message: "x" }))).toBe(live);
    expect(pageLabel("https://example.com/")).toBe("example.com");
  });
});
