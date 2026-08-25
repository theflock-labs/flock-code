//! Grok usage for the status-bar chip, read from the same session store as
//! `grok_context`.
//!
//! There is no grok equivalent of Claude Code's `/usage` or Codex's `wham`
//! endpoint that flock can call. The bar we first shipped treated
//! `inputTokens + outputTokens` as conversation context. On `grok-4.6-build`
//! those fields are a running total that can be tens of millions, so the
//! meter read as 6000% of a 1M window. That is not a limit.
//!
//! What this reports instead:
//!   * **Tokens today** — summed from main-thread `turn_completed` lines
//!     since local midnight. The chip shows this number.
//!   * **Conversation context** — only when the last turn's size actually
//!     fits the model's window. Anything larger is billing, not context,
//!     and is left off the percentage.
//!
//! Subagent session directories (`…/subagent-<id>/`) are skipped: they are
//! separate cwd keys, not a `subagents/` folder, and the parent turn already
//! carries their tokens.

use crate::grok_context::{last_turn, window_for};
use chrono::{Local, Timelike};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Longer than the chip's poll. The first ship used 20s for both, so every
/// tick missed the cache and re-read every `updates.jsonl` (tens of MB on
/// a machine that has been using grok). That hitch is what a 20-second
/// "the window froze" feels like.
const CACHE_TTL: Duration = Duration::from_secs(60);

fn cache() -> &'static Mutex<Option<(Instant, GrokUsage)>> {
    static CACHE: OnceLock<Mutex<Option<(Instant, GrokUsage)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

/// Per-file parse, keyed by path. Session files are append-only; an
/// unchanged stat means the last parse is still the answer. `today` is
/// stored so a file that sat still overnight is re-read once at midnight
/// (today-tokens would otherwise stay yesterday's).
struct FileMemo {
    mtime: Option<SystemTime>,
    len: u64,
    today: i64,
    today_tokens: u64,
    last_used: Option<u64>,
    last_model: Option<String>,
}

fn file_memos() -> &'static Mutex<HashMap<PathBuf, FileMemo>> {
    static MEMOS: OnceLock<Mutex<HashMap<PathBuf, FileMemo>>> = OnceLock::new();
    MEMOS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn sessions_root() -> PathBuf {
    match std::env::var_os("GROK_HOME") {
        Some(home) => PathBuf::from(home).join("sessions"),
        None => flock_core::paths::home_dir().join(".grok/sessions"),
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct GrokUsage {
    pub available: bool,
    pub today_tokens: u64,
    pub context_percent: Option<f64>,
    pub context_used: Option<u64>,
    pub context_window: Option<u64>,
    pub model: Option<String>,
    pub fetched_at_ms: i64,
}

#[tauri::command]
pub async fn grok_usage(force: bool) -> Result<GrokUsage, String> {
    if !force {
        if let Some((at, cached)) = cache().lock().unwrap().as_ref() {
            if at.elapsed() < CACHE_TTL {
                return Ok(cached.clone());
            }
        }
    }

    let root = sessions_root();
    let usage = tauri::async_runtime::spawn_blocking(move || aggregate(&root))
        .await
        .map_err(|e| format!("grok usage scan panicked: {e}"))?;

    *cache().lock().unwrap() = Some((Instant::now(), usage.clone()));
    Ok(usage)
}

fn aggregate(root: &Path) -> GrokUsage {
    let today = local_midnight_unix();
    let mut fullest: Option<(u64, u64, String)> = None;
    let mut today_tokens: u64 = 0;
    let mut seen: Vec<PathBuf> = Vec::new();

    if let Ok(cwds) = std::fs::read_dir(root) {
        for cwd in cwds.flatten() {
            if !cwd.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            // Subagents get their own percent-encoded cwd. The parent
            // conversation already billed those tokens.
            if cwd.file_name().to_string_lossy().contains("subagent-") {
                continue;
            }
            let Ok(sessions) = std::fs::read_dir(cwd.path()) else {
                continue;
            };
            for session in sessions.flatten() {
                if session.file_name() == "subagents" {
                    continue;
                }
                let updates = session.path().join("updates.jsonl");
                if !updates.is_file() {
                    continue;
                }
                seen.push(updates.clone());
                let (file_today, last) = scan_file(&updates, today);
                today_tokens += file_today;
                if let Some((used, model)) = last {
                    let window = window_for(&model, used);
                    // A last turn larger than the window is a running total,
                    // not what the next request will carry.
                    if used > 0 && used <= window {
                        let better = fullest.as_ref().map(|(u, _, _)| used > *u).unwrap_or(true);
                        if better {
                            fullest = Some((used, window, model));
                        }
                    }
                }
            }
        }
    }

    // Drop memos for sessions that have gone away so a long-lived app
    // does not keep a handle to every grok file it has ever seen.
    {
        let mut memos = file_memos().lock().unwrap();
        memos.retain(|path, _| seen.iter().any(|p| p == path));
    }

    let (context_percent, context_used, context_window, model) = match fullest {
        Some((used, window, model)) => {
            let percent = if window == 0 {
                0.0
            } else {
                (used as f64) * 100.0 / (window as f64)
            };
            (Some(percent), Some(used), Some(window), Some(model))
        }
        None => (None, None, None, None),
    };

    GrokUsage {
        available: today_tokens > 0 || context_percent.is_some(),
        today_tokens,
        context_percent,
        context_used,
        context_window,
        model,
        fetched_at_ms: now_ms(),
    }
}

fn scan_file(path: &Path, today: i64) -> (u64, Option<(u64, String)>) {
    let meta = std::fs::metadata(path).ok();
    let mtime = meta.as_ref().and_then(|m| m.modified().ok());
    let len = meta.as_ref().map(|m| m.len()).unwrap_or(0);
    {
        let memos = file_memos().lock().unwrap();
        if let Some(hit) = memos.get(path) {
            if hit.today == today && hit.mtime == mtime && hit.len == len {
                let last = match (hit.last_used, hit.last_model.clone()) {
                    (Some(used), Some(model)) => Some((used, model)),
                    _ => None,
                };
                return (hit.today_tokens, last);
            }
        }
    }
    let Ok(text) = std::fs::read_to_string(path) else {
        return (0, None);
    };
    let last = last_turn(&text);
    let today_tokens = tokens_since(&text, today);
    let memo = FileMemo {
        mtime,
        len,
        today,
        today_tokens,
        last_used: last.as_ref().map(|(u, _)| *u),
        last_model: last.as_ref().map(|(_, m)| m.clone()),
    };
    file_memos().lock().unwrap().insert(path.to_path_buf(), memo);
    (today_tokens, last)
}

fn tokens_since(text: &str, since_unix: i64) -> u64 {
    let mut sum = 0u64;
    for line in text.lines() {
        if !line.contains("turn_completed") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let ts = timestamp(&v);
        if ts < since_unix {
            continue;
        }
        let Some(update) = v.pointer("/params/update") else {
            continue;
        };
        if update.get("sessionUpdate").and_then(|s| s.as_str()) != Some("turn_completed") {
            continue;
        }
        let Some(usage) = update.get("usage") else {
            continue;
        };
        let num = |k: &str| usage.get(k).and_then(|n| n.as_u64()).unwrap_or(0);
        sum += num("inputTokens") + num("outputTokens");
    }
    sum
}

fn timestamp(v: &Value) -> i64 {
    v.get("timestamp")
        .and_then(|t| t.as_i64().or_else(|| t.as_f64().map(|f| f as i64)))
        .unwrap_or(0)
}

fn local_midnight_unix() -> i64 {
    Local::now()
        .with_hour(0)
        .and_then(|t| t.with_minute(0))
        .and_then(|t| t.with_second(0))
        .and_then(|t| t.with_nanosecond(0))
        .map(|t| t.timestamp())
        .unwrap_or(0)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TURN: &str = r#"{"timestamp":1786565320,"method":"_x.ai/session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"turn_completed","usage":{"inputTokens":58598,"outputTokens":1278,"totalTokens":59876,"cachedReadTokens":34688,"modelUsage":{"grok-4.6":{"inputTokens":58598,"outputTokens":1278,"totalTokens":59876}}}}}}"#;
    const BUILD_TOTAL: &str = r#"{"timestamp":1786565320,"method":"_x.ai/session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"turn_completed","usage":{"inputTokens":64690377,"outputTokens":0,"totalTokens":64690377,"modelUsage":{"grok-4.6-build":{"inputTokens":64690377,"outputTokens":0,"totalTokens":64690377}}}}}}"#;

    fn write_session(root: &Path, cwd: &str, id: &str, body: &str) {
        let dir = root.join(cwd).join(id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("updates.jsonl"), body).unwrap();
    }

    #[test]
    fn a_sane_session_is_context_and_a_build_total_is_not() {
        let root = std::env::temp_dir().join(format!("flock-grok-usage-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        write_session(&root, "proj", "sess-a", TURN);
        write_session(&root, "proj", "sess-huge", BUILD_TOTAL);

        let usage = aggregate(&root);
        let pct = usage.context_percent.expect("sane session");
        assert!((pct - (59_876.0 * 100.0 / 500_000.0)).abs() < 0.01);
        assert!(pct < 100.0, "must not report the 64M build total as context");
        assert_eq!(usage.model.as_deref(), Some("grok-4.6"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn subagent_cwds_are_skipped() {
        let root = std::env::temp_dir().join(format!("flock-grok-usage-sub-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        write_session(&root, "%2Ftmp%2Fsubagent-019ff7b7-aaaa", "sess", BUILD_TOTAL);
        write_session(&root, "proj", "sess-a", TURN);

        let usage = aggregate(&root);
        assert_eq!(usage.model.as_deref(), Some("grok-4.6"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_rewrite_is_noticed_and_an_unchanged_file_is_stable() {
        let root = std::env::temp_dir().join(format!("flock-grok-usage-memo-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        write_session(&root, "proj", "sess-a", TURN);
        let first = aggregate(&root);
        let second = aggregate(&root);
        assert_eq!(first.context_percent, second.context_percent);
        assert_eq!(first.model, second.model);
        write_session(&root, "proj", "sess-a", BUILD_TOTAL);
        let third = aggregate(&root);
        assert!(third.context_percent.is_none(), "64M build total must not stay memoized as context");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn empty_store_is_unavailable() {
        let root = std::env::temp_dir().join(format!("flock-grok-usage-empty-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let usage = aggregate(&root);
        assert!(!usage.available);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn tokens_since_skips_old_turns() {
        let old = TURN.replace("1786565320", "1000");
        let sum = tokens_since(&format!("{old}\n{TURN}\n"), 1_700_000_000);
        assert_eq!(sum, 58_598 + 1_278);
        assert_eq!(tokens_since(TURN, 1_800_000_000), 0);
    }
}
