//! Claude subscription usage limits, surfaced from the same private endpoint
//! Claude Code's own `/usage` view uses (`GET /api/oauth/usage`).
//!
//! There is no supported public API for this, so a few things are load-bearing
//! and worth stating up front:
//!   * **Auth** reuses the user's existing Claude Code login — the OAuth token
//!     it already stored. On macOS that lives in the login keychain (service
//!     `Claude Code-credentials`), elsewhere in `~/.claude/.credentials.json`.
//!     We read it read-only; we never write or refresh it (the `claude` CLI the
//!     user runs in panes keeps it fresh).
//!   * **`User-Agent: claude-code/…` is mandatory.** Without it the endpoint
//!     drops you into an aggressively rate-limited bucket and 429s persistently.
//!   * **Poll no faster than every 180s.** We cache results for that long and
//!     serve the cache to every caller in between, so a chatty UI can't trip the
//!     limiter.
//!
//! Because it's unofficial it may change or vanish without notice; every field
//! is treated as optional and a fetch failure degrades to a friendly error
//! rather than taking anything down.

use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA: &str = "oauth-2025-04-20";
const KEYCHAIN_SERVICE: &str = "Claude Code-credentials";
/// Minimum spacing between real network fetches (the endpoint rate-limits hard).
const CACHE_TTL: Duration = Duration::from_secs(180);

// ─── Public shape returned to the frontend ──────────────────────────────────

/// One limit meter (a labeled progress bar in the UI).
#[derive(Debug, Clone, Serialize)]
pub struct UsageBar {
    /// Stable machine tag: `session` | `weekly_all` | `weekly_scoped` | …
    pub kind: String,
    /// `session` | `weekly` — used to group bars under a heading.
    pub group: String,
    /// Human label ("Current session", "All models", "Fable").
    pub label: String,
    pub percent: f64,
    /// `normal` | `warning` | `critical` — drives bar color.
    pub severity: String,
    /// ISO-8601 reset instant, if the window resets.
    pub resets_at: Option<String>,
    pub is_active: bool,
}

/// Pay-as-you-go usage credits ("Usage credits" in Claude Code).
#[derive(Debug, Clone, Serialize)]
pub struct UsageSpend {
    pub enabled: bool,
    pub percent: f64,
    /// Amounts in the currency's minor unit (cents), with `exponent` decimals.
    pub used_minor: i64,
    pub limit_minor: i64,
    pub currency: String,
    pub exponent: i32,
    pub disclaimer: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClaudeUsage {
    /// Plan label, e.g. "Max (5x)" — derived from the stored credential.
    pub plan: Option<String>,
    pub bars: Vec<UsageBar>,
    pub spend: Option<UsageSpend>,
    /// When these numbers were actually fetched (ms since epoch), so the UI can
    /// show "updated 40s ago" honestly even when served from cache.
    pub fetched_at_ms: i64,
}

// ─── Endpoint response (only the fields we consume; all lenient) ─────────────

#[derive(Debug, Deserialize)]
struct RawUsage {
    #[serde(default)]
    limits: Vec<RawLimit>,
    #[serde(default)]
    spend: Option<RawSpend>,
}

#[derive(Debug, Deserialize)]
struct RawLimit {
    #[serde(default)]
    kind: String,
    #[serde(default)]
    group: String,
    #[serde(default)]
    percent: f64,
    #[serde(default)]
    severity: String,
    #[serde(default)]
    resets_at: Option<String>,
    #[serde(default)]
    scope: Option<RawScope>,
    #[serde(default)]
    is_active: bool,
}

#[derive(Debug, Deserialize)]
struct RawScope {
    #[serde(default)]
    model: Option<RawModel>,
}

#[derive(Debug, Deserialize)]
struct RawModel {
    #[serde(default)]
    display_name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawSpend {
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    percent: f64,
    #[serde(default)]
    used: Option<RawMoney>,
    #[serde(default)]
    limit: Option<RawMoney>,
    #[serde(default)]
    disclaimer: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawMoney {
    #[serde(default)]
    amount_minor: i64,
    #[serde(default)]
    currency: String,
    #[serde(default)]
    exponent: i32,
}

// ─── Credential extraction ──────────────────────────────────────────────────

struct Creds {
    token: String,
    plan: Option<String>,
}

/// Read the Claude Code OAuth credential: file first (Linux/Windows and any
/// macOS install that opted out of the keychain), then the macOS keychain.
fn read_creds() -> Result<Creds, String> {
    if let Some(c) = read_creds_file() {
        return Ok(c);
    }
    #[cfg(target_os = "macos")]
    if let Some(c) = read_creds_keychain() {
        return Ok(c);
    }
    Err("Not signed in to Claude Code. Run `claude` and sign in, then reopen this.".into())
}

fn read_creds_file() -> Option<Creds> {
    let home = std::env::var("HOME").ok()?;
    let raw = std::fs::read_to_string(format!("{home}/.claude/.credentials.json")).ok()?;
    parse_creds(&raw)
}

#[cfg(target_os = "macos")]
fn read_creds_keychain() -> Option<Creds> {
    let out = std::process::Command::new("/usr/bin/security")
        .args(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let raw = String::from_utf8(out.stdout).ok()?;
    parse_creds(raw.trim())
}

/// Pull the access token and derive a plan label out of the stored JSON blob.
fn parse_creds(raw: &str) -> Option<Creds> {
    let v: serde_json::Value = serde_json::from_str(raw).ok()?;
    let oauth = v.get("claudeAiOauth")?;
    let token = oauth.get("accessToken")?.as_str()?.to_string();
    if token.is_empty() {
        return None;
    }
    let plan = plan_label(
        oauth.get("subscriptionType").and_then(|s| s.as_str()),
        oauth.get("rateLimitTier").and_then(|s| s.as_str()),
    );
    Some(Creds { token, plan })
}

/// "max" + "default_claude_max_5x" → "Max (5x)".
fn plan_label(subscription: Option<&str>, tier: Option<&str>) -> Option<String> {
    let sub = subscription?;
    let mut label = {
        let mut c = sub.chars();
        match c.next() {
            Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
            None => return None,
        }
    };
    // Recover the "5x"/"20x" multiplier baked into the rate-limit tier name.
    if let Some(mult) = tier
        .and_then(|t| t.rsplit('_').next())
        .filter(|s| s.ends_with('x') && s[..s.len() - 1].chars().all(|c| c.is_ascii_digit()))
    {
        label.push_str(&format!(" ({mult})"));
    }
    Some(label)
}

// ─── Fetch + cache ──────────────────────────────────────────────────────────

fn cache() -> &'static Mutex<Option<(Instant, ClaudeUsage)>> {
    static CACHE: OnceLock<Mutex<Option<(Instant, ClaudeUsage)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

/// Serve the last successfully-fetched usage (any age) as a soft fallback on a
/// transient error, so the bar doesn't disappear on a blip; error out only if
/// we've never gotten a value.
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

/// Fetch usage, serving a <180s-old cached copy when one exists (unless
/// `force`). `force` still can't beat the endpoint's own limiter, but it lets a
/// deliberate "refresh" button skip our local TTL.
#[tauri::command]
pub async fn claude_usage(force: bool) -> Result<ClaudeUsage, String> {
    if !force {
        if let Some((at, cached)) = cache().lock().unwrap().as_ref() {
            if at.elapsed() < CACHE_TTL {
                return Ok(cached.clone());
            }
        }
    }

    let creds = read_creds()?;
    let client = reqwest::Client::builder()
        // Load-bearing: the endpoint 429s hard without a claude-code UA.
        .user_agent(concat!("claude-code/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    // The endpoint rate-limits aggressively (429, no Retry-After). A transient
    // failure must NOT make the UI's usage bar vanish, so on any *transient*
    // error we fall back to the last value we successfully fetched (however
    // old), and only surface a hard error when we've never had one. Genuine
    // sign-out (401/403) is the exception — there the bar should hide.
    let resp = match client
        .get(USAGE_URL)
        .bearer_auth(&creds.token)
        .header("anthropic-beta", OAUTH_BETA)
        .header("anthropic-version", "2023-06-01")
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return stale_or(format!("usage request failed: {e}")),
    };

    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err("Claude Code session expired. Run `claude` to sign in again.".into());
    }
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return stale_or("Claude usage is rate-limited right now. Try again in a few minutes.".into());
    }
    if !status.is_success() {
        return stale_or(format!("usage endpoint returned {status}"));
    }

    let raw: RawUsage = match resp.json().await {
        Ok(r) => r,
        Err(e) => return stale_or(format!("bad usage payload: {e}")),
    };
    let usage = shape(raw, creds.plan);

    *cache().lock().unwrap() = Some((Instant::now(), usage.clone()));

    // Sample account spend into the graph's cost curve (flock Enterprise
    // phase 1). Only fires on a real fetch (cache miss), so the cadence matches
    // the UI's 180s poll; de-duped in the graph layer. It no longer feeds a
    // displayed figure: cost-per-outcome divided this whole-account number by
    // merged PRs and was removed as unattributable, and attributed spend is
    // computed per session id in `claude_code_usage.rs`. Kept because the curve
    // itself is cheap and is the only long-run record of account spend.
    if let Some(spend) = &usage.spend {
        if spend.enabled && spend.used_minor > 0 {
            let (used, limit, cur, exp) =
                (spend.used_minor, spend.limit_minor, spend.currency.clone(), spend.exponent);
            tauri::async_runtime::spawn(async move {
                crate::graph::record_usage_snapshot("claude", used, Some(limit), cur, exp).await;
            });
        }
    }

    Ok(usage)
}

/// Flatten the endpoint's `limits[]`/`spend` into the UI's bar list, labeling
/// each meter. Falls back through kind → group so an unknown future `kind`
/// still renders something sensible rather than vanishing.
fn shape(raw: RawUsage, plan: Option<String>) -> ClaudeUsage {
    let bars = raw
        .limits
        .into_iter()
        .map(|l| {
            let model = l
                .scope
                .as_ref()
                .and_then(|s| s.model.as_ref())
                .and_then(|m| m.display_name.clone());
            let label = match l.kind.as_str() {
                "session" => "Current session".to_string(),
                "weekly_all" => "All models".to_string(),
                "weekly_scoped" => model.unwrap_or_else(|| "Model limit".to_string()),
                _ => model.unwrap_or_else(|| {
                    if l.group == "weekly" {
                        "Weekly".to_string()
                    } else {
                        "Usage".to_string()
                    }
                }),
            };
            UsageBar {
                kind: l.kind,
                group: l.group,
                label,
                percent: l.percent,
                severity: if l.severity.is_empty() { "normal".into() } else { l.severity },
                resets_at: l.resets_at,
                is_active: l.is_active,
            }
        })
        .collect();

    let spend = raw.spend.map(|s| {
        let (used_minor, currency, exponent) = s
            .used
            .as_ref()
            .map(|m| (m.amount_minor, m.currency.clone(), m.exponent))
            .unwrap_or((0, "USD".into(), 2));
        let limit_minor = s.limit.as_ref().map(|m| m.amount_minor).unwrap_or(0);
        UsageSpend {
            enabled: s.enabled,
            percent: s.percent,
            used_minor,
            limit_minor,
            currency,
            exponent,
            disclaimer: s.disclaimer,
        }
    });

    ClaudeUsage {
        plan,
        bars,
        spend,
        fetched_at_ms: now_ms(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_label_formats_multiplier() {
        assert_eq!(plan_label(Some("max"), Some("default_claude_max_5x")).as_deref(), Some("Max (5x)"));
        assert_eq!(plan_label(Some("pro"), None).as_deref(), Some("Pro"));
        assert_eq!(plan_label(Some("max"), Some("weird_tier")).as_deref(), Some("Max"));
        assert_eq!(plan_label(None, Some("default_claude_max_5x")), None);
    }

    #[test]
    fn parse_creds_reads_token_and_plan() {
        let raw = r#"{"claudeAiOauth":{"accessToken":"sk-ant-oat01-abc","subscriptionType":"max","rateLimitTier":"default_claude_max_5x"}}"#;
        let c = parse_creds(raw).unwrap();
        assert_eq!(c.token, "sk-ant-oat01-abc");
        assert_eq!(c.plan.as_deref(), Some("Max (5x)"));
    }

    #[test]
    fn shape_labels_scoped_model() {
        let raw: RawUsage = serde_json::from_str(
            r#"{"limits":[
                {"kind":"session","group":"session","percent":29.0,"severity":"normal","resets_at":"t1","is_active":false},
                {"kind":"weekly_scoped","group":"weekly","percent":72.0,"severity":"normal","scope":{"model":{"display_name":"Fable"}},"is_active":true}
            ],"spend":{"enabled":false,"percent":0.0,"used":{"amount_minor":0,"currency":"EUR","exponent":2},"limit":{"amount_minor":100,"currency":"EUR","exponent":2}}}"#,
        )
        .unwrap();
        let u = shape(raw, Some("Max (5x)".into()));
        assert_eq!(u.bars.len(), 2);
        assert_eq!(u.bars[0].label, "Current session");
        assert_eq!(u.bars[1].label, "Fable");
        assert!(u.bars[1].is_active);
        let spend = u.spend.unwrap();
        assert_eq!(spend.limit_minor, 100);
        assert_eq!(spend.currency, "EUR");
    }
}
