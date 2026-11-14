// What an agent is doing right now, from Claude Code's own hooks: the tool it
// is using and on what, the page it has open in Wink, its to-do progress, and
// why a turn stopped short. The hooks report it (src-tauri/src/hooks.rs
// TOOL_EVENTS, crates/flock-mcp/src/hook.rs); this folds each report into the
// pane's live state and says it in words. Nothing here is saved.

import type { HookEvent } from "../lib/tauri";
import type { PaneLive } from "../types";

const WINK = "mcp__wink__";

/** The pane's live state after one hook event; the same object when nothing changed. */
export function applyHookEvent(live: PaneLive | undefined, e: HookEvent): PaneLive | undefined {
  const cur = live ?? {};
  switch (e.event) {
    case "UserPromptSubmit":
      // A new turn: what the last one was doing, saw or hit is over.
      return { todos: cur.todos, tasks: cur.tasks };
    case "SessionStart":
      return cur.tool || cur.turnError ? { ...cur, tool: undefined, detail: undefined, turnError: undefined } : live;
    case "PreToolUse": {
      const next: PaneLive = { ...cur, tool: e.tool || undefined, detail: e.detail || undefined, turnError: undefined, doneUnseen: false };
      if (e.tool?.startsWith(WINK) && e.url) next.browsing = e.url;
      if (e.tool === "TodoWrite" && typeof e.todos_total === "number") {
        next.todos = e.todos_total > 0 ? { done: e.todos_done ?? 0, total: e.todos_total } : undefined;
      }
      return next;
    }
    case "Stop":
      return cur.tool ? { ...cur, tool: undefined, detail: undefined } : live;
    case "StopFailure":
      return { ...cur, tool: undefined, detail: undefined, turnError: e.error || "unknown" };
    case "TaskCreated":
    case "TaskCompleted": {
      if (!e.task_id) return live;
      const tasks = { created: cur.tasks?.created ?? [], completed: cur.tasks?.completed ?? [] };
      const list = e.event === "TaskCreated" ? tasks.created : tasks.completed;
      if (list.includes(e.task_id)) return live;
      const next = e.event === "TaskCreated"
        ? { ...tasks, created: [...tasks.created, e.task_id] }
        : { created: tasks.created.includes(e.task_id) ? tasks.created : [...tasks.created, e.task_id], completed: [...tasks.completed, e.task_id] };
      return { ...cur, tasks: next, todos: { done: next.completed.length, total: next.created.length } };
    }
    default:
      return live;
  }
}

/** A page as a person reads it: "localhost:3000/checkout". */
export function pageLabel(url: string): string {
  const bare = url.replace(/^[a-z]+:\/\//i, "").replace(/[?#].*$/, "").replace(/\/$/, "");
  return bare.length > 48 ? `${bare.slice(0, 47)}…` : bare;
}

function fileLabel(path: string): string {
  return path.length > 48 ? `…${path.slice(-47)}` : path;
}

/** What the agent is doing now, in a few words: "Editing src/Steps.tsx". */
export function activityLabel(live: PaneLive | undefined): string | undefined {
  const tool = live?.tool;
  if (!tool) return undefined;
  const d = live?.detail;
  if (tool.startsWith(WINK)) {
    const what = tool.slice(WINK.length);
    const page = live?.browsing ? pageLabel(live.browsing) : undefined;
    switch (what) {
      case "navigate":
      case "tab_open":
        return page ? `Opening ${page} in Wink` : "Opening a page in Wink";
      case "screenshot":
      case "snapshot":
      case "read_page":
      case "find":
        return "Looking at the page in Wink";
      case "console_logs":
        return "Reading the console in Wink";
      case "network_requests":
        return "Reading network requests in Wink";
      case "export_test":
        return "Writing a Playwright test from Wink";
      case "record":
      case "trace":
        return "Recording in Wink";
      default:
        return "Using the page in Wink";
    }
  }
  if (tool.startsWith("mcp__")) {
    const [, server, name] = tool.split("__");
    return name ? `${server}: ${name.replace(/_/g, " ")}` : server;
  }
  switch (tool) {
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return d ? `Editing ${fileLabel(d)}` : "Editing";
    case "Write":
      return d ? `Writing ${fileLabel(d)}` : "Writing a file";
    case "Read":
      return d ? `Reading ${fileLabel(d)}` : "Reading";
    case "Bash":
    case "PowerShell":
      return d ?? "Running a command";
    case "Grep":
    case "Glob":
      return d ? `Searching for ${d}` : "Searching";
    case "WebFetch":
      return d ? `Reading ${pageLabel(d)}` : "Reading a page";
    case "WebSearch":
      return "Searching the web";
    case "Agent":
    case "Task":
      return d ? `Sub-agent: ${d}` : "Running a sub-agent";
    case "TodoWrite":
      return "Planning";
    case "Skill":
      return d ? `Using ${d}` : "Using a skill";
    default:
      return tool;
  }
}

/** A failed turn's reason as a person reads it. */
export function turnErrorLabel(error: string | undefined): string | undefined {
  if (!error) return undefined;
  const words: Record<string, string> = {
    rate_limit: "hit its rate limit",
    overloaded: "Claude is overloaded",
    authentication_failed: "signed out",
    billing_error: "billing problem",
    max_output_tokens: "reply too long",
    server_error: "server error",
    invalid_request: "request rejected",
    model_not_found: "model not found",
  };
  return words[error] ?? error.replace(/_/g, " ");
}
