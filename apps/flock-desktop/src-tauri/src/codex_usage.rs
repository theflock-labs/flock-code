//! Codex (OpenAI/ChatGPT) subscription usage limits, from the same private
//! endpoint the Codex CLI's own usage bar uses: `GET /backend-api/wham/usage`.
//!
//! Mirrors [`crate::claude_usage`] and reuses its output shape so the same
//! frontend bar/panel renders either agent. Auth reuses the Codex CLI's stored
//! ChatGPT login (`~/.codex/auth.json` → `tokens.access_token` +
//! `tokens.account_id`); we read it, never refresh it (the `codex` CLI the user
//! runs keeps it fresh). Results cache for 180s.
//!
//! Same honesty caveats as the Claude side, plus two Codex-specific ones:
//!   * `chatgpt.com` sits behind Cloudflare — datacenter/VPN IPs can get a 403
//!     challenge; from a normal desktop it succeeds directly.
//!   * The window model is `primary` (5-hour) + `secondary` (weekly); free-tier
//!     accounts often report only the primary window.

use crate::claude_usage::{ClaudeUsage, UsageBar};
use chrono::DateTime;
use serde::Deserialize;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
/// A plausible Codex CLI user-agent. The endpoint doesn't strictly require it,
/// but sending one avoids being singled out by future UA gating.
const USER_AGENT: &str = "codex_cli_rs/0.144.1 (flock)";
const CACHE_TTL: Duration = Duration::from_secs(180);

// ─── ~/.codex/auth.json ─────────────────────────────────────────────────────

#[derive(Deserialize)]
struct Auth {
    tokens: Option<Tokens>,
}

#[derive(Deserialize)]
struct Tokens {
    access_token: Option<String>,
    account_id: Option<String>,
}

fn read_auth() -> Result<(String, String), String> {
    let home = std::env::var("HOME").map_err(|_| "no HOME".to_string())?;
    let raw = std::fs::read_to_string(format!("{home}/.codex/auth.json"))
        .map_err(|_| "Not signed in to Codex. Run `codex` and sign in, then reopen this.".to_string())?;
    let auth: Auth = serde_json::from_str(&raw).map_err(|e| format!("bad codex auth.json: {e}"))?;
    let tokens = auth.tokens.ok_or("codex auth.json has no tokens")?;
    let token = tokens
        .access_token
        .filter(|s| !s.is_empty())
        .ok_or("codex auth.json missing access_token")?;
    Ok((token, tokens.account_id.unwrap_or_default()))
}

// ─── Endpoint response (only what we consume; all lenient) ──────────────────

#[derive(Deserialize)]
struct RawUsage {
    #[serde(default)]
    plan_type: Option<String>,
    #[serde(default)]
    rate_limit: Option<RawRateLimit>,
}

#[derive(Deserialize)]
struct RawRateLimit {
    #[serde(default)]
    primary_window: Option<RawWindow>,
    #[serde(default)]
    secondary_window: Option<RawWindow>,
}

#[derive(Deserialize)]
struct RawWindow {
    #[serde(default)]
    used_percent: f64,
    /// Unix epoch (seconds) at which the window resets.
    #[serde(default)]
    reset_at: Option<i64>,
}

// ─── Cache ──────────────────────────────────────────────────────────────────

fn cache() -> &'static Mutex<Option<(Instant, ClaudeUsage)>> {
    static CACHE: OnceLock<Mutex<Option<(Instant, ClaudeUsage)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

/// Serve the last good value (any age) on a transient error so the bar persists
/// through a blip; error out only if we've never fetched successfully.
fn stale_or(msg: String) -> Result<ClaudeUsage, String> {
    match cache().lock().unwrap().as_ref() {
        Some((_, cached)) => Ok(cached.clone()),
        None => Err(msg),
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ─── Command ────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn codex_usage(force: bool) -> Result<ClaudeUsage, String> {
    if !force {
        if let Some((at, cached)) = cache().lock().unwrap().as_ref() {
            if at.elapsed() < CACHE_TTL {
                return Ok(cached.clone());
            }
        }
    }

    let (token, account) = read_auth()?;
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    // On a transient failure, fall back to the last good value so the bar
    // doesn't vanish (Cloudflare 403s and 429s here are common). Only genuine
    // sign-out (401) hides it.
    let resp = match client
        .get(USAGE_URL)
        .bearer_auth(&token)
        .header("ChatGPT-Account-Id", &account)
        .header("originator", "codex_cli_rs")
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return stale_or(format!("codex usage request failed: {e}")),
    };

    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err("Codex session expired. Run `codex` to sign in again.".into());
    }
    if status == reqwest::StatusCode::FORBIDDEN {
        // Cloudflare challenge or account not permitted — transient, keep last.
        return stale_or("Codex usage is temporarily unavailable (blocked upstream).".into());
    }
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return stale_or("Codex usage is rate-limited right now. Try again in a few minutes.".into());
    }
    if !status.is_success() {
        return stale_or(format!("codex usage endpoint returned {status}"));
    }

    let raw: RawUsage = match resp.json().await {
        Ok(r) => r,
        Err(e) => return stale_or(format!("bad codex usage payload: {e}")),
    };
    let usage = shape(raw);

    *cache().lock().unwrap() = Some((Instant::now(), usage.clone()));
    Ok(usage)
}

/// Map Codex's primary/secondary windows into the shared usage-bar shape.
fn shape(raw: RawUsage) -> ClaudeUsage {
    let plan = raw.plan_type.as_deref().map(plan_label);
    let mut bars = Vec::new();
    if let Some(rl) = raw.rate_limit {
        if let Some(w) = rl.primary_window {
            bars.push(window_bar("session", "session", "Current session", w));
        }
        if let Some(w) = rl.secondary_window {
            bars.push(window_bar("weekly_all", "weekly", "Weekly", w));
        }
    }
    ClaudeUsage {
        plan,
        bars,
        spend: None,
        fetched_at_ms: now_ms(),
    }
}

fn window_bar(kind: &str, group: &str, label: &str, w: RawWindow) -> UsageBar {
    let severity = if w.used_percent >= 95.0 {
        "critical"
    } else if w.used_percent >= 80.0 {
        "warning"
    } else {
        "normal"
    };
    let resets_at = w
        .reset_at
        .and_then(|secs| DateTime::from_timestamp(secs, 0))
        .map(|dt| dt.to_rfc3339());
    UsageBar {
        kind: kind.into(),
        group: group.into(),
        label: label.into(),
        percent: w.used_percent,
        severity: severity.into(),
        resets_at,
        is_active: false,
    }
}

/// "plus" → "Plus", "pro" → "Pro", "free_workspace" → "Free workspace".
fn plan_label(plan: &str) -> String {
    let pretty = plan.replace('_', " ");
    let mut c = pretty.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => pretty,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_label_prettifies() {
        assert_eq!(plan_label("plus"), "Plus");
        assert_eq!(plan_label("free_workspace"), "Free workspace");
        assert_eq!(plan_label("pro"), "Pro");
    }

    #[test]
    fn shape_maps_windows_and_severity() {
        let raw: RawUsage = serde_json::from_str(
            r#"{"plan_type":"free","rate_limit":{
                "primary_window":{"used_percent":100.0,"reset_at":1786457099},
                "secondary_window":null}}"#,
        )
        .unwrap();
        let u = shape(raw);
        assert_eq!(u.plan.as_deref(), Some("Free"));
        assert_eq!(u.bars.len(), 1);
        assert_eq!(u.bars[0].group, "session");
        assert_eq!(u.bars[0].label, "Current session");
        assert_eq!(u.bars[0].severity, "critical");
        assert!(u.bars[0].resets_at.is_some());
    }
}
