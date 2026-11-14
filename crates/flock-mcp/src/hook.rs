//! `flock-mcp hook <agent> <event>`: a Claude Code command hook that turns the
//! event's JSON into one short line for flock's hook log.
//!
//! flock's lifecycle hooks are shell one-liners (see the desktop app's
//! `hooks.rs`), which is enough for events that carry nothing but their name.
//! Tool and task events carry nested JSON — which file, which command, which
//! page — that `sed` cannot read reliably, so they come here instead. The
//! installed command checks for a flock pane id before it runs this, and
//! redirects stdout into the log, so:
//!
//! * the line is printed, never written: the shell's `>>` is what appends, the
//!   same way as for every other flock hook;
//! * nothing is printed for Claude Code to read, so this can never approve,
//!   deny or change a tool call — it only reports one;
//! * it always exits 0, and every field is capped, so a huge `Write` or a
//!   malformed payload costs one short line at most.

use serde_json::{json, Map, Value};
use std::io::Read;

/// Read at most this much of the payload. A `Write`'s `tool_input` carries the
/// whole file; only its path is wanted.
const MAX_PAYLOAD: u64 = 4 * 1024 * 1024;
const MAX_DETAIL: usize = 160;

pub fn run(agent: &str, event: &str) {
    let pane = std::env::var("FLOCK_PANE_ID")
        .or_else(|_| std::env::var("CLARENCE_PANE_ID"))
        .unwrap_or_default();
    if pane.is_empty() {
        return;
    }
    let mut raw = Vec::new();
    let _ = std::io::stdin().take(MAX_PAYLOAD).read_to_end(&mut raw);
    let payload: Value = serde_json::from_slice(&raw).unwrap_or(Value::Null);
    let time = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let home = std::env::var("HOME").unwrap_or_default();
    let line = summarize(agent, event, &pane, time, &payload, &home);
    println!("{line}");
}

/// One log line for `event`, in the shape flock's other hooks write
/// (`time`/`agent`/`event`/`pane_id`), plus what the event is about.
pub fn summarize(agent: &str, event: &str, pane: &str, time: u64, payload: &Value, home: &str) -> Value {
    let mut out = Map::new();
    out.insert("time".into(), json!(time));
    out.insert("agent".into(), json!(agent));
    out.insert("event".into(), json!(event));
    out.insert("pane_id".into(), json!(pane));
    let s = |key: &str| payload.get(key).and_then(Value::as_str);
    match event {
        "PreToolUse" | "PostToolUseFailure" => {
            let tool = s("tool_name").unwrap_or("");
            out.insert("tool".into(), json!(clip(tool, 80)));
            let input = payload.get("tool_input").cloned().unwrap_or(Value::Null);
            let cwd = s("cwd").unwrap_or("");
            if let Some(detail) = tool_detail(tool, &input, cwd, home) {
                out.insert("detail".into(), json!(detail));
            }
            if let Some(url) = input.get("url").and_then(Value::as_str).filter(|u| is_web_url(u)) {
                out.insert("url".into(), json!(clip(url, 300)));
            }
            if tool == "TodoWrite" {
                if let Some(todos) = input.get("todos").and_then(Value::as_array) {
                    let done = todos
                        .iter()
                        .filter(|t| t.get("status").and_then(Value::as_str) == Some("completed"))
                        .count();
                    out.insert("todos_done".into(), json!(done));
                    out.insert("todos_total".into(), json!(todos.len()));
                }
            }
        }
        "StopFailure" => {
            out.insert("error".into(), json!(clip(s("error").unwrap_or("unknown"), 40)));
            if let Some(d) = payload.get("error_details").and_then(|d| d.as_str().map(str::to_string).or_else(|| Some(d.to_string()))) {
                if !d.is_empty() && d != "null" {
                    out.insert("error_details".into(), json!(clip(&d, MAX_DETAIL)));
                }
            }
        }
        "TaskCreated" | "TaskCompleted" => {
            if let Some(id) = s("task_id") {
                out.insert("task_id".into(), json!(clip(id, 80)));
            }
            if let Some(subject) = s("task_subject") {
                out.insert("task".into(), json!(clip(subject, 120)));
            }
        }
        _ => {}
    }
    Value::Object(out)
}

/// The one thing worth showing about a tool call: the file, the command, the
/// search, the page. None when the tool says nothing a person would read.
fn tool_detail(tool: &str, input: &Value, cwd: &str, home: &str) -> Option<String> {
    let s = |key: &str| input.get(key).and_then(Value::as_str).filter(|v| !v.trim().is_empty());
    let detail = match tool {
        "Edit" | "MultiEdit" | "Write" | "Read" | "NotebookEdit" => {
            s("file_path").or_else(|| s("notebook_path")).map(|p| short_path(p, cwd, home))
        }
        // Claude Code writes a description for most commands ("Run the
        // tests"); it reads better than the command itself.
        "Bash" | "PowerShell" => s("description").or_else(|| s("command")).map(str::to_string),
        "Grep" | "Glob" => s("pattern").map(str::to_string),
        "WebFetch" => s("url").map(str::to_string),
        "WebSearch" => s("query").map(str::to_string),
        "Agent" | "Task" => s("description").map(str::to_string),
        "Skill" => s("skill").or_else(|| s("command")).map(str::to_string),
        _ if tool.starts_with("mcp__") => s("url").map(str::to_string),
        _ => None,
    }?;
    let first = detail.lines().next().unwrap_or("").trim();
    if first.is_empty() {
        return None;
    }
    Some(clip(first, MAX_DETAIL))
}

/// A path as the agent would say it: relative to where it runs, or under `~`.
fn short_path(path: &str, cwd: &str, home: &str) -> String {
    let cwd = cwd.trim_end_matches('/');
    if !cwd.is_empty() {
        if let Some(rest) = path.strip_prefix(cwd).and_then(|r| r.strip_prefix('/')) {
            return rest.to_string();
        }
    }
    let home = home.trim_end_matches('/');
    if !home.is_empty() {
        if let Some(rest) = path.strip_prefix(home).and_then(|r| r.strip_prefix('/')) {
            return format!("~/{rest}");
        }
    }
    path.to_string()
}

fn is_web_url(u: &str) -> bool {
    u.starts_with("http://") || u.starts_with("https://")
}

/// At most `max` characters, on a character boundary, with an ellipsis when cut.
fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(event: &str, payload: Value) -> Value {
        summarize("claude", event, "p1", 7, &payload, "/Users/sam")
    }

    #[test]
    fn an_edit_names_its_file_relative_to_the_agent() {
        let v = line(
            "PreToolUse",
            json!({"cwd": "/Users/sam/storefront", "tool_name": "Edit", "tool_input": {"file_path": "/Users/sam/storefront/src/Steps.tsx", "old_string": "a", "new_string": "b"}}),
        );
        assert_eq!(v, json!({"time": 7, "agent": "claude", "event": "PreToolUse", "pane_id": "p1", "tool": "Edit", "detail": "src/Steps.tsx"}));
    }

    #[test]
    fn a_command_is_its_description_when_it_has_one() {
        let v = line("PreToolUse", json!({"tool_name": "Bash", "tool_input": {"command": "npm test -- --run", "description": "Run the tests"}}));
        assert_eq!(v["detail"], "Run the tests");
        let v = line("PreToolUse", json!({"tool_name": "Bash", "tool_input": {"command": "git status\ngit diff"}}));
        assert_eq!(v["detail"], "git status");
    }

    #[test]
    fn a_wink_page_carries_its_url() {
        let v = line("PreToolUse", json!({"tool_name": "mcp__wink__navigate", "tool_input": {"url": "http://localhost:3000/checkout", "tab_id": "a1"}}));
        assert_eq!(v["tool"], "mcp__wink__navigate");
        assert_eq!(v["url"], "http://localhost:3000/checkout");
        assert_eq!(v["detail"], "http://localhost:3000/checkout");
        // Not a web page: no url field.
        let v = line("PreToolUse", json!({"tool_name": "mcp__wink__navigate", "tool_input": {"url": "javascript:alert(1)"}}));
        assert!(v.get("url").is_none());
    }

    #[test]
    fn todos_report_progress_and_tasks_their_subject() {
        let v = line(
            "PreToolUse",
            json!({"tool_name": "TodoWrite", "tool_input": {"todos": [{"content": "a", "status": "completed"}, {"content": "b", "status": "in_progress"}, {"content": "c", "status": "pending"}]}}),
        );
        assert_eq!((v["todos_done"].as_u64(), v["todos_total"].as_u64()), (Some(1), Some(3)));
        let v = line("TaskCompleted", json!({"task_id": "t-1", "task_subject": "Wire the checkout button"}));
        assert_eq!((v["task_id"].as_str(), v["task"].as_str()), (Some("t-1"), Some("Wire the checkout button")));
    }

    #[test]
    fn a_failed_turn_says_why() {
        let v = line("StopFailure", json!({"error": "rate_limit", "error_details": "429 Too Many Requests"}));
        assert_eq!((v["error"].as_str(), v["error_details"].as_str()), (Some("rate_limit"), Some("429 Too Many Requests")));
    }

    #[test]
    fn huge_or_broken_input_costs_one_short_line() {
        let big = "x".repeat(100_000);
        let v = line("PreToolUse", json!({"tool_name": "Bash", "tool_input": {"command": big}}));
        assert!(v["detail"].as_str().unwrap().chars().count() <= MAX_DETAIL);
        let v = line("PreToolUse", Value::Null);
        assert_eq!(v["tool"], "");
        assert!(v.get("detail").is_none());
    }

    #[test]
    fn paths_outside_the_project_read_from_home() {
        assert_eq!(short_path("/Users/sam/Desktop/a.png", "/Users/sam/storefront", "/Users/sam"), "~/Desktop/a.png");
        assert_eq!(short_path("/etc/hosts", "/Users/sam/storefront", "/Users/sam"), "/etc/hosts");
    }
}
