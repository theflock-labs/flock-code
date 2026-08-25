//! Capturing the session id an agent generates for a pane, so it can be
//! resumed by id after an app restart — the piece that gives opencode/codex
//! per-agent resume even when several agents share one working directory.
//!
//! claude lets us *impose* an id (`--session-id`), so it doesn't need this.
//! opencode and codex mint their own ids, so instead we look them up from the
//! agent's on-disk session store, matching by working directory and recency.

use serde_json::Value;
use std::path::PathBuf;

fn home() -> PathBuf {
    std::env::var("HOME").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("/tmp"))
}

/// Find the session id an agent created for a pane running in `cwd`.
/// `after_ms` is roughly when the pane started (unix ms); `exclude` are ids
/// already claimed by other live panes, so N agents in one cwd each latch onto
/// a distinct session. Returns None until the agent has actually recorded a
/// session (i.e. the user has interacted with it).
pub fn capture(cmd: &str, cwd: &str, after_ms: i64, exclude: &[String]) -> Option<String> {
    match cmd {
        "opencode" => opencode(cwd, after_ms, exclude),
        "codex" => codex(cwd, after_ms, exclude),
        _ => None,
    }
}

fn json_files(dir: &PathBuf, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            json_files(&p, out);
        } else if p.extension().and_then(|x| x.to_str()) == Some("json") {
            out.push(p);
        }
    }
}

// ── opencode ────────────────────────────────────────────────────────────────
// ~/.local/share/opencode/storage/session/<project>/ses_<id>.json, each with
// { id, directory, time: { created, updated } }.

fn opencode(cwd: &str, after_ms: i64, exclude: &[String]) -> Option<String> {
    let dir = home().join(".local/share/opencode/storage/session");
    let mut files = Vec::new();
    json_files(&dir, &mut files);
    let grace = after_ms - 5 * 60 * 1000; // tolerate the session being made just before we noticed the pane
    let mut best: Option<(i64, String)> = None; // (updated, id)
    for f in files {
        let Ok(txt) = std::fs::read_to_string(&f) else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&txt) else { continue };
        let id = v.get("id").and_then(Value::as_str).unwrap_or("");
        let directory = v.get("directory").and_then(Value::as_str).unwrap_or("");
        let time = v.get("time");
        let created = time.and_then(|t| t.get("created")).and_then(Value::as_i64).unwrap_or(0);
        let updated = time.and_then(|t| t.get("updated")).and_then(Value::as_i64).unwrap_or(created);
        if id.is_empty() || directory != cwd || created < grace {
            continue;
        }
        if exclude.iter().any(|e| e == id) {
            continue;
        }
        if best.as_ref().map_or(true, |(u, _)| updated > *u) {
            best = Some((updated, id.to_string()));
        }
    }
    best.map(|(_, id)| id)
}

// ── codex (best-effort) ──────────────────────────────────────────────────────
// OpenAI Codex records rollouts under ~/.codex/sessions/**/rollout-*.jsonl,
// whose first line carries session meta (id + cwd). Builds vary, so this
// gracefully returns None when the store isn't found — codex just spawns fresh.

fn codex(cwd: &str, after_ms: i64, exclude: &[String]) -> Option<String> {
    let dir = home().join(".codex/sessions");
    let mut files = Vec::new();
    rollout_files(&dir, &mut files);
    let grace = after_ms - 5 * 60 * 1000;
    let mut best: Option<(i64, String)> = None; // (mtime, id)
    for f in files {
        let Some(meta) = first_json_line(&f) else { continue };
        let id = meta
            .get("id")
            .or_else(|| meta.get("session_id"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| session_id_from_name(&f));
        let Some(id) = id.filter(|s| !s.is_empty()) else { continue };
        let scwd = meta
            .get("cwd")
            .or_else(|| meta.get("workdir"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if !scwd.is_empty() && scwd != cwd {
            continue;
        }
        let mtime = std::fs::metadata(&f)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        if mtime < grace || exclude.iter().any(|e| *e == id) {
            continue;
        }
        if best.as_ref().map_or(true, |(u, _)| mtime > *u) {
            best = Some((mtime, id));
        }
    }
    best.map(|(_, id)| id)
}

fn rollout_files(dir: &PathBuf, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            rollout_files(&p, out);
        } else if p.file_name().and_then(|n| n.to_str()).map_or(false, |n| n.starts_with("rollout-") && n.ends_with(".jsonl")) {
            out.push(p);
        }
    }
}

fn first_json_line(path: &PathBuf) -> Option<Value> {
    use std::io::{BufRead, BufReader};
    let file = std::fs::File::open(path).ok()?;
    let mut line = String::new();
    BufReader::new(file).read_line(&mut line).ok()?;
    serde_json::from_str(line.trim()).ok()
}

/// codex rollout files are named `rollout-<timestamp>-<session-uuid>.jsonl`.
fn session_id_from_name(path: &PathBuf) -> Option<String> {
    let name = path.file_stem()?.to_str()?; // rollout-<ts>-<uuid>
    let uuid = name.rsplit('-').take(5).collect::<Vec<_>>();
    if uuid.len() == 5 {
        let mut parts = uuid;
        parts.reverse();
        Some(parts.join("-"))
    } else {
        None
    }
}
