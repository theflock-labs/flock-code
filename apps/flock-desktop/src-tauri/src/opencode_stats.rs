//! opencode local usage stats — cumulative session cost + tokens, read straight
//! from opencode's own SQLite DB (`~/.local/share/opencode/opencode.db`, the
//! `session` table).
//!
//! Unlike Claude Code and Codex, opencode has **no** remaining-limit / credits
//! endpoint — it's a pass-through to whatever provider you configure (confirmed
//! against the opencode source). So this is *spend-to-date*, the one
//! opencode-specific number worth surfacing: how much cost and how many tokens
//! you've run through opencode across all sessions.
//!
//! Read-only via the system `sqlite3` (`-readonly`), so it never locks or
//! disturbs a running opencode instance. Any problem (no DB, schema drift, query
//! failure) degrades to `available: false`, and the chip simply hides.

use serde::Serialize;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

const SQLITE3: &str = "/usr/bin/sqlite3";
const QUERY: &str = "SELECT COUNT(*), COALESCE(SUM(cost),0), \
    COALESCE(SUM(tokens_input),0), COALESCE(SUM(tokens_output),0), \
    COALESCE(SUM(tokens_reasoning),0), COALESCE(SUM(tokens_cache_read),0), \
    COALESCE(SUM(tokens_cache_write),0) FROM session;";

#[derive(Debug, Clone, Serialize, Default)]
pub struct OpencodeStats {
    /// False when opencode isn't installed / has no DB / the query failed. The
    /// UI hides the chip entirely in that case.
    pub available: bool,
    pub sessions: i64,
    /// Total cost in USD (0 for free/local models that don't report cost).
    pub cost: f64,
    pub tokens_input: i64,
    pub tokens_output: i64,
    pub tokens_reasoning: i64,
    pub tokens_cache_read: i64,
    pub tokens_cache_write: i64,
    pub fetched_at_ms: i64,
}

/// `~/.local/share/opencode/opencode.db`, honoring `XDG_DATA_HOME`.
fn db_path() -> Option<String> {
    let base = std::env::var("XDG_DATA_HOME")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("{}/.local/share", std::env::var("HOME").unwrap_or_default()));
    let path = format!("{base}/opencode/opencode.db");
    std::path::Path::new(&path).exists().then_some(path)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn unavailable() -> OpencodeStats {
    OpencodeStats {
        available: false,
        fetched_at_ms: now_ms(),
        ..Default::default()
    }
}

#[tauri::command]
pub async fn opencode_stats() -> Result<OpencodeStats, String> {
    let Some(path) = db_path() else {
        return Ok(unavailable());
    };
    let out = Command::new(SQLITE3)
        .args(["-readonly", &path, QUERY])
        .output()
        .map_err(|e| format!("sqlite3 failed: {e}"))?;
    if !out.status.success() {
        return Ok(unavailable());
    }
    let line = String::from_utf8_lossy(&out.stdout);
    Ok(parse(line.trim()).unwrap_or_else(unavailable))
}

/// Parse sqlite3's pipe-delimited single row into stats.
fn parse(line: &str) -> Option<OpencodeStats> {
    let f: Vec<&str> = line.split('|').collect();
    if f.len() < 7 {
        return None;
    }
    Some(OpencodeStats {
        available: true,
        sessions: f[0].parse().ok()?,
        cost: f[1].parse().ok()?,
        tokens_input: f[2].parse().ok()?,
        tokens_output: f[3].parse().ok()?,
        tokens_reasoning: f[4].parse().ok()?,
        tokens_cache_read: f[5].parse().ok()?,
        tokens_cache_write: f[6].parse().ok()?,
        fetched_at_ms: now_ms(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_reads_pipe_row() {
        let s = parse("39|0.0|1882438|263455|213435|61425088|0").unwrap();
        assert!(s.available);
        assert_eq!(s.sessions, 39);
        assert_eq!(s.cost, 0.0);
        assert_eq!(s.tokens_input, 1882438);
        assert_eq!(s.tokens_cache_read, 61425088);
    }

    #[test]
    fn parse_reads_cost() {
        let s = parse("5|1.2345|100|200|0|0|0").unwrap();
        assert_eq!(s.sessions, 5);
        assert!((s.cost - 1.2345).abs() < 1e-9);
    }

    #[test]
    fn parse_rejects_short_row() {
        assert!(parse("1|2|3").is_none());
    }
}
