//! Cumulative Claude Code token spend + USD equivalent, computed from the local
//! session transcripts.
//!
//! The `/usage` OAuth endpoint (`claude_usage.rs`) returns limit *percentages*
//! and pay-as-you-go spend only — it carries no token counts, and no dollar
//! figure at all for subscription (Max/Pro) users. The richer "Usage" view in
//! Claude Code ("Total cost", "Usage by model") is instead computed locally from
//! the per-message `usage` recorded in the session transcripts under
//! `~/.claude/projects/**/*.jsonl`. We do the same here: sum tokens per model
//! across every transcript on this machine and price them with a per-model
//! table to get a USD estimate.
//!
//! The same walk also answers *who spent it, and when* — see [`SpendWindow`]
//! near the bottom. Budgets need a windowed, attributed figure, and re-walking
//! the transcripts a second time to get one would double the only expensive
//! thing in this module.
//!
//! Load-bearing notes:
//!   * **Local-machine only.** This counts sessions recorded on this machine,
//!     not claude.ai or other devices — same caveat Claude Code states. Secure
//!     (jailed) workspaces are included: their `~/.claude/projects` is bind-
//!     mounted to a `flock-secure-<ws>` directory under this same root, so the
//!     recursive walk below picks them up with nothing to special-case.
//!   * **USD is an estimate.** Transcripts store token counts, not cost; the
//!     dollar figure is `tokens × PRICES` and drifts if Anthropic changes
//!     prices (keep `PRICES` current). Token counts are exact. Anything built
//!     on `cost_usd` — the budgets in particular — is a guardrail priced from
//!     a local table, never an invoice, and must say so where a user reads it.
//!   * **De-duped by (message id, request id).** A single assistant turn can
//!     appear more than once across transcripts (sidechains, resumes); counting
//!     each `usage` block once avoids inflating totals — mirrors ccusage.
//!   * Walking every transcript is I/O-heavy, so results are cached briefly and
//!     any failure degrades to `available: false` rather than taking anything
//!     down.

use serde::Serialize;
use std::collections::HashSet;
use std::io::{BufRead, BufReader};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Re-walking the transcripts on every call is wasteful; the totals barely move
/// second-to-second. Serve a cached result for this long.
const CACHE_TTL: Duration = Duration::from_secs(120);

/// Per-model, per-million-token USD rates for input and output. Every cache
/// rate is a fixed multiple of the input rate — 1.25× for a 5-minute cache
/// write, **2× for a 1-hour write**, 0.1× for a read — so only the two base
/// rates are stored and `Prices` derives the rest. That removes a whole class
/// of drift: a new model needs one row, not four numbers that must agree.
///
/// Prefix-matched against the transcript's `model` string, so dated snapshots
/// (`claude-haiku-4-5-20251001`) and context variants (`claude-opus-5[1m]`)
/// resolve to the same row. Keep in sync with Anthropic pricing — and note
/// that a *new* model family needs a new row here: prefix matching does not
/// carry `claude-opus-4` forward to `claude-opus-5`, so a missing row silently
/// prices a flagship at `FALLBACK` rates.
const PRICES: &[(&str, Prices)] = &[
    ("claude-opus-5", Prices::new(5.0, 25.0)),
    ("claude-opus-4", Prices::new(5.0, 25.0)),
    ("claude-sonnet-5", Prices::new(3.0, 15.0)),
    ("claude-sonnet-4", Prices::new(3.0, 15.0)),
    ("claude-haiku-4", Prices::new(1.0, 5.0)),
    ("claude-fable-5", Prices::new(10.0, 50.0)),
    ("claude-mythos-5", Prices::new(10.0, 50.0)),
    // Older families a long-lived install may still have transcripts for.
    ("claude-3-5-haiku", Prices::new(0.80, 4.0)),
    ("claude-3-opus", Prices::new(15.0, 75.0)),
];

/// Fallback when a model string matches nothing in `PRICES` (a model newer than
/// this table). Tokens still count; cost uses mid-tier rates so the estimate is
/// in the right ballpark rather than zero. Hitting this is logged once per
/// scan per model — see `aggregate` — because it means the table is stale.
const FALLBACK: Prices = Prices::new(3.0, 15.0);

#[derive(Clone, Copy)]
struct Prices {
    input: f64,
    output: f64,
}

impl Prices {
    const fn new(input: f64, output: f64) -> Self {
        Self { input, output }
    }
    /// 5-minute-TTL cache write: 1.25× input.
    fn cache_write_5m(&self) -> f64 {
        self.input * 1.25
    }
    /// 1-hour-TTL cache write: 2× input. Claude Code runs long sessions on the
    /// 1h TTL, so this is the common case, not the exotic one.
    fn cache_write_1h(&self) -> f64 {
        self.input * 2.0
    }
    /// Cache read: 0.1× input.
    fn cache_read(&self) -> f64 {
        self.input * 0.1
    }
}

// ─── Public shape returned to the frontend ──────────────────────────────────

#[derive(Debug, Clone, Serialize, Default)]
pub struct ClaudeCodeUsage {
    /// False when `~/.claude/projects` is absent or unreadable. The UI hides the
    /// tiles in that case.
    pub available: bool,
    /// Total input tokens (uncached prompt tokens), summed across all models.
    pub tokens_input: i64,
    pub tokens_output: i64,
    pub tokens_cache_read: i64,
    pub tokens_cache_write: i64,
    /// Convenience: input + output + cache_read + cache_write.
    pub tokens_total: i64,
    /// Estimated total spend in USD (see module docs — an estimate).
    pub cost_usd: f64,
    /// When these numbers were computed (ms since epoch).
    pub fetched_at_ms: i64,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn cache() -> &'static Mutex<Option<(Instant, ClaudeCodeUsage)>> {
    static CACHE: OnceLock<Mutex<Option<(Instant, ClaudeCodeUsage)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn projects_dir() -> Option<std::path::PathBuf> {
    let home = std::env::var("HOME").ok()?;
    let path = std::path::Path::new(&home).join(".claude").join("projects");
    path.is_dir().then_some(path)
}

fn unavailable() -> ClaudeCodeUsage {
    ClaudeCodeUsage { available: false, fetched_at_ms: now_ms(), ..Default::default() }
}

/// Rates for `model`, plus whether they came from `PRICES` (`true`) or the
/// `FALLBACK` estimate (`false`). Callers use the flag to surface a stale table.
fn price_for(model: &str) -> (Prices, bool) {
    PRICES
        .iter()
        .find(|(prefix, _)| model.starts_with(prefix))
        .map(|(_, p)| (*p, true))
        .unwrap_or((FALLBACK, false))
}

#[tauri::command]
pub async fn claude_code_usage(force: bool) -> Result<ClaudeCodeUsage, String> {
    if !force {
        if let Some((at, cached)) = cache().lock().unwrap().as_ref() {
            if at.elapsed() < CACHE_TTL {
                return Ok(cached.clone());
            }
        }
    }

    let Some(dir) = projects_dir() else {
        return Ok(unavailable());
    };

    // Walking + parsing can be heavy for a long-lived install; do it off the
    // async runtime so we never block it.
    let usage = tauri::async_runtime::spawn_blocking(move || aggregate(&dir))
        .await
        .map_err(|e| format!("usage scan panicked: {e}"))?;

    *cache().lock().unwrap() = Some((Instant::now(), usage.clone()));
    Ok(usage)
}

/// One priced `usage` block, kept per file so an unchanged transcript never has
/// to be read again.
#[derive(Clone)]
struct Entry {
    /// "<message.id>:<requestId>", or `None` when the line carried neither and
    /// therefore cannot be de-duped against anything.
    key: Option<String>,
    input: i64,
    output: i64,
    cache_read: i64,
    cache_write: i64,
    cost: f64,
    /// When the turn was written, ms since epoch, from the line's `timestamp`.
    /// `None` when absent or unparseable — such a turn still counts toward the
    /// lifetime total but can never fall inside a window, because guessing
    /// which side of a budget boundary it belongs on is worse than reporting
    /// it as undated (see `SpendWindow::undated_cost_usd`).
    ts_ms: Option<i64>,
    /// The session that produced the turn. This is the whole attribution key:
    /// flock imposes the id with `--session-id`, so a row here maps back to
    /// exactly one pane. Subagent transcripts carry their *parent's* id, which
    /// is what we want — a Task tool's tokens are the parent agent's spend.
    session_id: Option<String>,
    /// The directory the agent was running in. Only used as a fallback when a
    /// session id matches no live pane (the pane was closed, or the app was
    /// restarted before the id was captured).
    cwd: Option<String>,
}

/// What a transcript contributed, and the stat it was true for.
struct FileScan {
    mtime: Option<SystemTime>,
    len: u64,
    entries: Vec<Entry>,
}

/// Parsed transcripts, keyed by path. Transcripts are append-only and the vast
/// majority never change again, so re-reading all of them on every scan is the
/// one cost here that grows without limit: fifteen days of use is already 1,400
/// files, and a year of it is tens of thousands. A stat is cheap, parsing is
/// not.
/// Keyed by scan root first, then by transcript path. Production only ever
/// passes `~/.claude/projects`, so the outer map holds one entry — but the
/// eviction below removes transcripts that are no longer on disk, and deciding
/// that from a listing of a *different* root would throw away entries that are
/// perfectly live. One shared map indexed only by file path made two concurrent
/// scans of different roots silently evict each other.
type DirScans = std::collections::HashMap<std::path::PathBuf, FileScan>;

fn scans() -> &'static Mutex<std::collections::HashMap<std::path::PathBuf, DirScans>> {
    static SCANS: OnceLock<Mutex<std::collections::HashMap<std::path::PathBuf, DirScans>>> =
        OnceLock::new();
    SCANS.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

/// Walk every `*.jsonl` transcript under `dir` and hand each de-duplicated
/// `usage` block to `visit` exactly once.
///
/// Only files whose size or mtime moved since the last call are re-read; the
/// rest are served from [`scans`]. De-duplication still runs across the whole
/// set every time, because it has to: the same assistant turn appears in more
/// than one transcript (resume, sidechain), so which file "owns" it is a
/// property of the set and not of any one file. That merge is a pass over
/// already-parsed entries, which is cheap next to the I/O it replaces.
///
/// Every reader of the transcripts goes through here rather than walking them
/// itself. The lifetime total and the windowed spend attribution are two
/// questions about the same corpus, and the corpus is the expensive part: a
/// second walk would double the I/O *and* let the two answers disagree about
/// which duplicate copy of a turn was the real one.
fn for_each_entry(dir: &std::path::Path, mut visit: impl FnMut(&Entry)) {
    let paths = jsonl_files(dir);
    let mut all = scans().lock().unwrap();
    let cache = all.entry(dir.to_path_buf()).or_default();

    for path in &paths {
        let meta = std::fs::metadata(path).ok();
        let len = meta.as_ref().map(|m| m.len()).unwrap_or(0);
        let mtime = meta.as_ref().and_then(|m| m.modified().ok());
        // Size AND mtime: a transcript is appended to, so size alone catches
        // almost everything, and mtime catches a rewrite that happens to land on
        // the same length.
        if let Some(prev) = cache.get(path) {
            if prev.len == len && prev.mtime == mtime {
                continue;
            }
        }
        cache.insert(
            path.clone(),
            FileScan { mtime, len, entries: parse_file(path) },
        );
    }
    // Transcripts that have gone away — a deleted project directory — must stop
    // counting, and must not sit in memory for the life of the process.
    let live: HashSet<&std::path::PathBuf> = paths.iter().collect();
    cache.retain(|p, _| live.contains(p));

    // Dedup key: "<message.id>:<requestId>". A turn re-logged across transcripts
    // (resume, sidechain) shares both, so we count its usage once.
    let mut seen: HashSet<&str> = HashSet::new();

    // Sorted, so which copy of a duplicated turn gets counted does not depend on
    // directory iteration order. The totals are identical either way, but a
    // stable answer is worth having when comparing two runs.
    let mut ordered: Vec<_> = cache.iter().collect();
    ordered.sort_by(|a, b| a.0.cmp(b.0));
    for (_, scan) in ordered {
        for e in &scan.entries {
            if let Some(key) = &e.key {
                if !seen.insert(key.as_str()) {
                    continue;
                }
            }
            visit(e);
        }
    }
}

/// Lifetime tokens + priced USD across every transcript under `dir`.
fn aggregate(dir: &std::path::Path) -> ClaudeCodeUsage {
    let mut input = 0i64;
    let mut output = 0i64;
    let mut cache_read = 0i64;
    let mut cache_write = 0i64;
    let mut cost = 0.0f64;

    for_each_entry(dir, |e| {
        input += e.input;
        output += e.output;
        cache_read += e.cache_read;
        cache_write += e.cache_write;
        cost += e.cost;
    });

    ClaudeCodeUsage {
        available: true,
        tokens_input: input,
        tokens_output: output,
        tokens_cache_read: cache_read,
        tokens_cache_write: cache_write,
        tokens_total: input + output + cache_read + cache_write,
        cost_usd: cost,
        fetched_at_ms: now_ms(),
    }
}

/// Price every `usage` block in one transcript. No de-duplication here — that
/// is a property of the whole set, applied by the caller.
fn parse_file(path: &std::path::Path) -> Vec<Entry> {
    let mut entries = Vec::new();
    // Model strings that fell through to FALLBACK — the table is stale for
    // these, so their dollars are an estimate at mid-tier rates. Logged once
    // each at the end rather than per line.
    let mut unpriced: HashSet<String> = HashSet::new();

    {
        let Ok(file) = std::fs::File::open(path) else { return entries };
        for line in BufReader::new(file).lines().map_while(Result::ok) {
            // Cheap pre-filter: only assistant messages carry a usage block.
            if !line.contains("\"usage\"") {
                continue;
            }
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
            let Some(msg) = v.get("message") else { continue };
            let Some(u) = msg.get("usage").filter(|u| u.is_object()) else { continue };

            // Carries the de-dup key when both ids are present; a block with
            // neither cannot be matched against anything and always counts.
            let key = match (
                msg.get("id").and_then(|x| x.as_str()),
                v.get("requestId").and_then(|x| x.as_str()),
            ) {
                (Some(mid), Some(rid)) => Some(format!("{mid}:{rid}")),
                _ => None,
            };

            let get = |k: &str| u.get(k).and_then(|x| x.as_i64()).unwrap_or(0);
            let i = get("input_tokens");
            let o = get("output_tokens");
            let cr = get("cache_read_input_tokens");
            let cw = get("cache_creation_input_tokens");

            // `cache_creation_input_tokens` is the total; the per-TTL split
            // lives in the `cache_creation` sub-object. The two TTLs bill at
            // different multiples of input (1.25× vs 2×), so pricing the total
            // at the 5m rate under-charges every long session. Anything the
            // split doesn't account for (older transcripts written before the
            // sub-object existed) falls back to the 5m rate.
            let (cw_1h, cw_5m) = match u.get("cache_creation").filter(|c| c.is_object()) {
                Some(c) => {
                    let g = |k: &str| c.get(k).and_then(|x| x.as_i64()).unwrap_or(0);
                    let h = g("ephemeral_1h_input_tokens");
                    (h, (cw - h).max(0))
                }
                None => (0, cw),
            };

            let model = msg.get("model").and_then(|m| m.as_str()).unwrap_or("");
            let (p, known) = price_for(model);
            if !known && !model.is_empty() {
                unpriced.insert(model.to_string());
            }
            let cost = (i as f64 * p.input
                + o as f64 * p.output
                + cr as f64 * p.cache_read()
                + cw_5m as f64 * p.cache_write_5m()
                + cw_1h as f64 * p.cache_write_1h())
                / 1_000_000.0;

            // Attribution fields. `sessionId` is the modern spelling and
            // `session_id` the older one; both appear on the same line in
            // current transcripts, and only the older one on archived ones.
            let str_at = |k: &str| {
                v.get(k)
                    .and_then(|x| x.as_str())
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
            };
            let session_id = str_at("sessionId").or_else(|| str_at("session_id"));

            entries.push(Entry {
                key,
                input: i,
                output: o,
                cache_read: cr,
                cache_write: cw,
                cost,
                ts_ms: v.get("timestamp").and_then(|t| t.as_str()).and_then(iso_ms),
                session_id,
                cwd: str_at("cwd"),
            });
        }
    }

    if !unpriced.is_empty() {
        let mut models: Vec<_> = unpriced.into_iter().collect();
        models.sort();
        tracing::warn!(
            target: "flock_desktop_lib::claude_code_usage",
            "no price row for {} — costing at FALLBACK rates; add them to PRICES",
            models.join(", ")
        );
    }

    entries
}

/// Parse a transcript `timestamp` ("2026-08-06T06:54:36.376Z") to ms since
/// epoch. Returns `None` for anything that isn't an RFC-3339 instant, which
/// keeps a malformed line out of every window rather than pinning it to 1970 —
/// an entry dated 1970 would sit *outside* every window and silently vanish
/// from the day's spend, which is the wrong direction for a budget to be wrong
/// in. `undated_cost_usd` reports them instead.
fn iso_ms(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

// ─── Windowed spend, attributed to a session ────────────────────────────────

/// What one Claude Code session spent inside a window.
///
/// The session id is the attribution key because it is the one flock controls:
/// panes are launched with `--session-id <uuid>` (`withClaudeSession` in
/// App.tsx), so a row here maps back to exactly one pane, and through it to a
/// workspace and a repo. `cwd` is the fallback for rows whose session no longer
/// matches a live pane.
#[derive(Debug, Clone, Serialize)]
pub struct SessionSpend {
    pub session_id: String,
    /// Directory of the newest turn in this window. A session does not change
    /// directory in practice, but taking the newest keeps it deterministic.
    pub cwd: String,
    pub tokens: i64,
    /// Priced from `PRICES` — an estimate, see the module docs.
    pub cost_usd: f64,
    /// Newest turn in the window, ms since epoch. Lets the UI sort by "who is
    /// burning money right now" rather than only by size.
    pub last_ms: i64,
}

/// Spend since one cutoff, broken down by session.
///
/// The rows are the *only* breakdown returned, on purpose. An earlier shape
/// returned per-session and per-directory groupings side by side, and every
/// consumer then had to remember that the two describe the same tokens — add
/// a session row to a directory row and you have double-counted a budget into
/// firing at half its ceiling. One row set, grouped downstream, cannot do that.
#[derive(Debug, Clone, Serialize, Default)]
pub struct SpendWindow {
    /// Cutoff this window was computed for, ms since epoch.
    pub since_ms: i64,
    /// Everything in the window, attributed or not.
    pub tokens: i64,
    pub cost_usd: f64,
    /// Rows sum to at most the totals above; the remainder is `unattributed_*`.
    pub sessions: Vec<SessionSpend>,
    /// In-window spend from turns that carried no session id. Nothing can be
    /// charged to a workspace, but it is still real money and the UI says so
    /// rather than quietly dropping it.
    pub unattributed_tokens: i64,
    pub unattributed_cost_usd: f64,
    /// Spend from turns with no parseable `timestamp`, which therefore fall in
    /// *no* window. Reported once (identically on every window) so an operator
    /// can tell "today cost nothing" from "today's transcripts are unreadable".
    pub undated_cost_usd: f64,
}

/// Windowed spend for several cutoffs in one transcript walk.
#[derive(Debug, Clone, Serialize, Default)]
pub struct SpendWindows {
    /// False when `~/.claude/projects` is absent or unreadable — same meaning
    /// as on [`ClaudeCodeUsage`]. Budgets must treat this as "unknown", not as
    /// "zero spent": a budget that reads a missing directory as $0 is a budget
    /// that never fires.
    pub available: bool,
    /// One entry per requested cutoff, in the order they were requested.
    pub windows: Vec<SpendWindow>,
    pub fetched_at_ms: i64,
}

/// Spend since each of `cutoffs`, computed in a single pass.
///
/// Several cutoffs rather than one call per window: a day ceiling and a month
/// ceiling are two questions about the same entries, and the dedup pass that
/// answers them is the expensive part. Doing it twice also opens a gap where
/// the two answers were computed against different on-disk state, which is how
/// a month total ends up smaller than the day total inside it.
fn spend_windows(dir: &std::path::Path, cutoffs: &[i64]) -> Vec<SpendWindow> {
    // Per cutoff: (total tokens, total cost, unattributed tokens/cost, rows).
    struct Acc {
        since_ms: i64,
        tokens: i64,
        cost: f64,
        un_tokens: i64,
        un_cost: f64,
        by_session: std::collections::HashMap<String, SessionSpend>,
    }
    let mut accs: Vec<Acc> = cutoffs
        .iter()
        .map(|&since_ms| Acc {
            since_ms,
            tokens: 0,
            cost: 0.0,
            un_tokens: 0,
            un_cost: 0.0,
            by_session: std::collections::HashMap::new(),
        })
        .collect();
    let mut undated = 0.0f64;

    for_each_entry(dir, |e| {
        let tokens = e.input + e.output + e.cache_read + e.cache_write;
        let Some(ts) = e.ts_ms else {
            undated += e.cost;
            return;
        };
        for acc in accs.iter_mut() {
            if ts < acc.since_ms {
                continue;
            }
            acc.tokens += tokens;
            acc.cost += e.cost;
            let Some(sid) = &e.session_id else {
                acc.un_tokens += tokens;
                acc.un_cost += e.cost;
                continue;
            };
            let row = acc.by_session.entry(sid.clone()).or_insert_with(|| SessionSpend {
                session_id: sid.clone(),
                cwd: String::new(),
                tokens: 0,
                cost_usd: 0.0,
                last_ms: 0,
            });
            row.tokens += tokens;
            row.cost_usd += e.cost;
            if ts >= row.last_ms {
                row.last_ms = ts;
                if let Some(cwd) = &e.cwd {
                    row.cwd = cwd.clone();
                }
            }
        }
    });

    accs.into_iter()
        .map(|acc| {
            let mut sessions: Vec<SessionSpend> = acc.by_session.into_values().collect();
            // Costliest first: the UI shows a top-N and the notification names
            // the biggest spender, so the order is part of the contract rather
            // than a display detail. Tie-broken on the id so a HashMap's
            // iteration order never leaks into what the user sees.
            sessions.sort_by(|a, b| {
                b.cost_usd
                    .partial_cmp(&a.cost_usd)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| a.session_id.cmp(&b.session_id))
            });
            SpendWindow {
                since_ms: acc.since_ms,
                tokens: acc.tokens,
                cost_usd: acc.cost,
                sessions,
                unattributed_tokens: acc.un_tokens,
                unattributed_cost_usd: acc.un_cost,
                undated_cost_usd: undated,
            }
        })
        .collect()
}

/// How many cutoffs one call may ask for. The frontend asks for two (today,
/// this month); the bound exists so a compromised webview cannot turn one
/// transcript walk into an unbounded amount of per-entry work.
const MAX_WINDOWS: usize = 8;

#[tauri::command]
pub async fn claude_spend_windows(since_ms: Vec<i64>) -> Result<SpendWindows, String> {
    let cutoffs: Vec<i64> = since_ms.into_iter().take(MAX_WINDOWS).collect();
    if cutoffs.is_empty() {
        return Ok(SpendWindows { available: true, windows: vec![], fetched_at_ms: now_ms() });
    }
    let Some(dir) = projects_dir() else {
        return Ok(SpendWindows { available: false, windows: vec![], fetched_at_ms: now_ms() });
    };
    // Same reasoning as `claude_code_usage`: the walk is I/O-heavy and must not
    // run on the async runtime. Unlike that one this is not separately cached —
    // `for_each_entry`'s per-file parse cache already absorbs the cost, and the
    // caller polls on a slow timer.
    let windows = tauri::async_runtime::spawn_blocking(move || spend_windows(&dir, &cutoffs))
        .await
        .map_err(|e| format!("spend scan panicked: {e}"))?;
    Ok(SpendWindows { available: true, windows, fetched_at_ms: now_ms() })
}

/// Tokens and estimated cost for **one** transcript — the per-session figure
/// the provenance record attributes to a single agent, as opposed to
/// [`aggregate`]'s machine-wide lifetime total.
///
/// Deliberately shares [`parse_file`] and therefore `PRICES`: a second pricing
/// table would drift from this one the first time Anthropic changed a rate, and
/// the two numbers would then disagree in the same app — one on the Usage tab,
/// one in an export handed to a finance team.
///
/// De-duplication is within this file only. A turn is written once per
/// transcript; the cross-file dedup `aggregate` does exists because a resume or
/// a sidechain re-logs a turn into a *different* transcript, and that is
/// exactly the case where the tokens do not belong to this session anyway.
///
/// Cost is returned in micros, because the caller stores it in SQLite as an
/// integer — a float column would drift by a cent across a few thousand rows,
/// and this total gets summed.
pub fn transcript_totals(path: &std::path::Path) -> flock_core::SessionTokens {
    let entries = parse_file(path);
    let mut seen: HashSet<&str> = HashSet::new();
    let mut t = flock_core::SessionTokens::default();
    let mut cost = 0.0f64;
    for e in &entries {
        if let Some(key) = &e.key {
            if !seen.insert(key.as_str()) {
                continue;
            }
        }
        t.input += e.input;
        t.output += e.output;
        t.cache_read += e.cache_read;
        t.cache_write += e.cache_write;
        cost += e.cost;
    }
    t.cost_usd_micros = (cost * 1_000_000.0).round() as i64;
    t
}

/// Every `*.jsonl` anywhere under `dir`. The main session transcripts sit one
/// level down (`~/.claude/projects/<slug>/<session>.jsonl`), but subagent runs
/// are nested deeper (`<slug>/<session>/subagents/agent-*.jsonl`) — and a
/// secure workspace's whole projects tree hangs one level lower still, under
/// `flock-secure-<ws>/`. A non-recursive walk drops all of that on the floor.
/// Recursion is
/// safe for double-counting because `aggregate` de-dupes on (message id,
/// request id) regardless of which file a turn was found in.
///
/// Depth-capped so a stray symlink or an unexpectedly deep tree can't turn the
/// scan into an unbounded walk of the user's home directory.
fn jsonl_files(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    fn walk(dir: &std::path::Path, depth: usize, out: &mut Vec<std::path::PathBuf>) {
        if depth == 0 {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for e in entries.flatten() {
            let p = e.path();
            // `file_type` from the DirEntry does not follow symlinks, so a
            // symlinked directory is not descended into.
            match e.file_type() {
                Ok(t) if t.is_dir() => walk(&p, depth - 1, out),
                Ok(t) if t.is_file() => {
                    if p.extension().and_then(|x| x.to_str()) == Some("jsonl") {
                        out.push(p);
                    }
                }
                _ => {}
            }
        }
    }
    let mut out = Vec::new();
    walk(dir, 6, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn price_prefix_matches_dated_snapshot() {
        let (p, known) = price_for("claude-haiku-4-5-20251001");
        assert!(known);
        assert_eq!(p.input, 1.0);
        assert_eq!(p.output, 5.0);
    }

    /// A new model family does not inherit the previous one's prefix, so each
    /// needs its own row. Opus 5 shipped without one and was silently billed
    /// at FALLBACK (Sonnet) rates — 60% of its true cost.
    #[test]
    fn price_covers_each_current_family() {
        for (model, input, output) in [
            ("claude-opus-5", 5.0, 25.0),
            ("claude-opus-5[1m]", 5.0, 25.0),
            ("claude-opus-4-8", 5.0, 25.0),
            ("claude-sonnet-5", 3.0, 15.0),
            ("claude-fable-5", 10.0, 50.0),
        ] {
            let (p, known) = price_for(model);
            assert!(known, "{model} fell through to FALLBACK");
            assert_eq!(p.input, input, "{model} input rate");
            assert_eq!(p.output, output, "{model} output rate");
        }
    }

    #[test]
    fn price_unknown_model_uses_fallback() {
        let (p, known) = price_for("claude-something-99");
        assert!(!known);
        assert_eq!(p.input, FALLBACK.input);
    }

    #[test]
    fn cache_rates_derive_from_input() {
        let p = Prices::new(5.0, 25.0);
        assert_eq!(p.cache_write_5m(), 6.25);
        assert_eq!(p.cache_write_1h(), 10.0);
        assert_eq!(p.cache_read(), 0.5);
    }

    #[test]
    fn aggregate_sums_and_prices_deduped() {
        let dir = std::env::temp_dir().join(format!("cc-usage-test-{}", now_ms()));
        let proj = dir.join("proj");
        std::fs::create_dir_all(&proj).unwrap();
        // Two lines share message id + requestId → counted once. A third,
        // distinct, is counted.
        let dup = r#"{"requestId":"r1","message":{"id":"m1","model":"claude-opus-4-8","usage":{"input_tokens":1000,"output_tokens":2000,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}"#;
        let other = r#"{"requestId":"r2","message":{"id":"m2","model":"claude-haiku-4-5","usage":{"input_tokens":1000000,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}"#;
        std::fs::write(proj.join("a.jsonl"), format!("{dup}\n{dup}\n{other}\n")).unwrap();

        let u = aggregate(&dir);
        assert!(u.available);
        // opus: 1000 input + 2000 output (once); haiku: 1_000_000 input.
        assert_eq!(u.tokens_input, 1_001_000);
        assert_eq!(u.tokens_output, 2000);
        // opus: 1000*5/1e6 + 2000*25/1e6 = 0.005 + 0.05 = 0.055; haiku: 1e6*1/1e6 = 1.0
        assert!((u.cost_usd - 1.055).abs() < 1e-9, "cost was {}", u.cost_usd);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// A 1-hour cache write bills at 2× input, not the 1.25× a 5-minute write
    /// costs. Claude Code's long sessions use the 1h TTL almost exclusively.
    #[test]
    fn aggregate_prices_1h_cache_writes_above_5m() {
        let dir = std::env::temp_dir().join(format!("cc-usage-ttl-{}", now_ms()));
        let proj = dir.join("proj");
        std::fs::create_dir_all(&proj).unwrap();
        // 1M cache-creation tokens on Opus 5, all on the 1-hour TTL.
        let line = r#"{"requestId":"r1","message":{"id":"m1","model":"claude-opus-5","usage":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":1000000,"cache_creation":{"ephemeral_1h_input_tokens":1000000,"ephemeral_5m_input_tokens":0}}}}"#;
        std::fs::write(proj.join("a.jsonl"), format!("{line}\n")).unwrap();

        let u = aggregate(&dir);
        assert_eq!(u.tokens_cache_write, 1_000_000);
        // 1e6 * (5.0 * 2.0) / 1e6 = 10.00, not the 6.25 a 5m write would cost.
        assert!((u.cost_usd - 10.0).abs() < 1e-9, "cost was {}", u.cost_usd);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// A transcript with no `cache_creation` split (older Claude Code) still
    /// bills its cache writes, at the 5-minute rate.
    #[test]
    fn aggregate_defaults_cache_writes_without_split_to_5m() {
        let dir = std::env::temp_dir().join(format!("cc-usage-nosplit-{}", now_ms()));
        let proj = dir.join("proj");
        std::fs::create_dir_all(&proj).unwrap();
        let line = r#"{"requestId":"r1","message":{"id":"m1","model":"claude-opus-5","usage":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":1000000}}}"#;
        std::fs::write(proj.join("a.jsonl"), format!("{line}\n")).unwrap();

        let u = aggregate(&dir);
        assert!((u.cost_usd - 6.25).abs() < 1e-9, "cost was {}", u.cost_usd);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Subagent transcripts live at `<slug>/<session>/subagents/*.jsonl`, two
    /// levels below the main ones. A non-recursive walk missed them entirely.
    #[test]
    fn aggregate_counts_nested_subagent_transcripts() {
        let dir = std::env::temp_dir().join(format!("cc-usage-nested-{}", now_ms()));
        let proj = dir.join("proj");
        let sub = proj.join("session-abc").join("subagents");
        std::fs::create_dir_all(&sub).unwrap();

        let main = r#"{"requestId":"r1","message":{"id":"m1","model":"claude-opus-5","usage":{"input_tokens":100,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}"#;
        let agent = r#"{"requestId":"r2","message":{"id":"m2","model":"claude-opus-5","usage":{"input_tokens":900,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}"#;
        std::fs::write(proj.join("session-abc.jsonl"), format!("{main}\n")).unwrap();
        std::fs::write(sub.join("agent-xyz.jsonl"), format!("{agent}\n")).unwrap();

        let u = aggregate(&dir);
        assert_eq!(u.tokens_input, 1000, "subagent tokens were dropped");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// The same turn re-logged into a nested transcript must not double-count.
    #[test]
    fn aggregate_dedupes_across_nesting_levels() {
        let dir = std::env::temp_dir().join(format!("cc-usage-dedup-{}", now_ms()));
        let proj = dir.join("proj");
        let sub = proj.join("session-abc").join("subagents");
        std::fs::create_dir_all(&sub).unwrap();

        let line = r#"{"requestId":"r1","message":{"id":"m1","model":"claude-opus-5","usage":{"input_tokens":500,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}"#;
        std::fs::write(proj.join("session-abc.jsonl"), format!("{line}\n")).unwrap();
        std::fs::write(sub.join("agent-xyz.jsonl"), format!("{line}\n")).unwrap();

        let u = aggregate(&dir);
        assert_eq!(u.tokens_input, 500);

        std::fs::remove_dir_all(&dir).ok();
    }

    // ── Incremental rescan ───────────────────────────────────────────────
    // Transcripts are append-only and almost all of them never change again,
    // so a rescan re-reads only what moved. These pin the three cases that
    // matter: a file left alone, a file appended to, and a file that is gone.

    fn line(id: &str, req: &str, input: i64) -> String {
        format!(
            r#"{{"requestId":"{req}","message":{{"id":"{id}","model":"claude-haiku-4-5","usage":{{"input_tokens":{input},"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}}}}"#
        )
    }

    #[test]
    fn an_untouched_transcript_is_not_read_again() {
        let dir = std::env::temp_dir().join(format!("cc-usage-incr-{}", now_ms()));
        let proj = dir.join("proj");
        std::fs::create_dir_all(&proj).unwrap();
        let f = proj.join("a.jsonl");
        std::fs::write(&f, format!("{}\n", line("m1", "r1", 500))).unwrap();

        assert_eq!(aggregate(&dir).tokens_input, 500);

        // Make it unreadable. A rescan that opened it would get nothing and the
        // total would fall to zero — so an unchanged total is proof the file was
        // served from the parse cache rather than re-read.
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o000)).unwrap();
        assert_eq!(aggregate(&dir).tokens_input, 500);

        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o644)).unwrap();
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_appended_transcript_is_re_read() {
        let dir = std::env::temp_dir().join(format!("cc-usage-append-{}", now_ms()));
        let proj = dir.join("proj");
        std::fs::create_dir_all(&proj).unwrap();
        let f = proj.join("a.jsonl");
        std::fs::write(&f, format!("{}\n", line("m1", "r1", 500))).unwrap();
        assert_eq!(aggregate(&dir).tokens_input, 500);

        let mut body = std::fs::read_to_string(&f).unwrap();
        body.push_str(&format!("{}\n", line("m2", "r2", 700)));
        std::fs::write(&f, body).unwrap();

        assert_eq!(aggregate(&dir).tokens_input, 1200);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_deleted_transcript_stops_counting() {
        let dir = std::env::temp_dir().join(format!("cc-usage-gone-{}", now_ms()));
        let proj = dir.join("proj");
        std::fs::create_dir_all(&proj).unwrap();
        std::fs::write(proj.join("a.jsonl"), format!("{}\n", line("m1", "r1", 500))).unwrap();
        std::fs::write(proj.join("b.jsonl"), format!("{}\n", line("m2", "r2", 700))).unwrap();
        assert_eq!(aggregate(&dir).tokens_input, 1200);

        std::fs::remove_file(proj.join("b.jsonl")).unwrap();
        assert_eq!(aggregate(&dir).tokens_input, 500);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// The per-session figure the provenance record stores. Same parser and the
    /// same price table as the machine-wide total, so an export and the Usage
    /// tab can never quote different rates for the same tokens.
    #[test]
    fn transcript_totals_price_one_session_in_micros() {
        let dir = std::env::temp_dir().join(format!("cc-usage-session-{}", now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("session.jsonl");
        // 1000 in + 2000 out on Opus 5 = 0.005 + 0.05 = $0.055, and the second
        // copy of the same turn (a resume re-logging it) must not double it.
        let turn = r#"{"requestId":"r1","message":{"id":"m1","model":"claude-opus-5","usage":{"input_tokens":1000,"output_tokens":2000,"cache_read_input_tokens":500,"cache_creation_input_tokens":0}}}"#;
        std::fs::write(&path, format!("{turn}\n{turn}\n")).unwrap();

        let t = transcript_totals(&path);
        assert_eq!(t.input, 1000);
        assert_eq!(t.output, 2000);
        assert_eq!(t.cache_read, 500);
        assert_eq!(t.cache_write, 0);
        // 0.055 + 500 * (5.0 * 0.1) / 1e6 = 0.055 + 0.00025 = 0.05525
        assert_eq!(t.cost_usd_micros, 55_250);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// A pane whose agent has not been spoken to yet has no transcript at all.
    #[test]
    fn transcript_totals_of_a_missing_file_is_zero() {
        let t = transcript_totals(std::path::Path::new("/nonexistent/session.jsonl"));
        assert_eq!(t.input, 0);
        assert_eq!(t.cost_usd_micros, 0);
    }

    /// The reason de-duplication cannot be cached per file: the same turn lives
    /// in two transcripts, and appending to one of them must not make it count
    /// twice.
    #[test]
    fn dedup_survives_a_partial_rescan() {
        let dir = std::env::temp_dir().join(format!("cc-usage-dedup-{}", now_ms()));
        let proj = dir.join("proj");
        std::fs::create_dir_all(&proj).unwrap();
        let shared = line("m1", "r1", 500);
        std::fs::write(proj.join("a.jsonl"), format!("{shared}\n")).unwrap();
        std::fs::write(proj.join("b.jsonl"), format!("{shared}\n")).unwrap();
        assert_eq!(aggregate(&dir).tokens_input, 500, "the shared turn counts once");

        // Touch only b. a is served from cache, and the shared turn must still
        // resolve to one count across the two.
        std::fs::write(proj.join("b.jsonl"), format!("{shared}\n{}\n", line("m2", "r2", 300))).unwrap();
        assert_eq!(aggregate(&dir).tokens_input, 800);

        std::fs::remove_dir_all(&dir).ok();
    }

    // ── Windowed spend attribution ───────────────────────────────────────
    // The lifetime total is a sum; this is a sum with a cutoff, a grouping key
    // and two escape hatches (no session, no timestamp). Each of those is a
    // way for a budget to be quietly wrong about how much has been spent.

    /// One priced turn: `input` tokens of haiku input, so cost is
    /// `input / 1e6` dollars exactly.
    fn dated(id: &str, ts: &str, session: &str, cwd: &str, input: i64) -> String {
        format!(
            r#"{{"requestId":"r-{id}","timestamp":"{ts}","sessionId":"{session}","cwd":"{cwd}","message":{{"id":"{id}","model":"claude-haiku-4-5","usage":{{"input_tokens":{input},"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}}}}"#
        )
    }

    fn fixture(name: &str, body: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("cc-spend-{name}-{}", now_ms()));
        let proj = dir.join("proj");
        std::fs::create_dir_all(&proj).unwrap();
        std::fs::write(proj.join("a.jsonl"), body).unwrap();
        dir
    }

    #[test]
    fn spend_window_excludes_turns_before_the_cutoff() {
        let dir = fixture(
            "cutoff",
            &format!(
                "{}\n{}\n",
                dated("m1", "2026-08-01T00:00:00.000Z", "s1", "/repo", 1_000_000),
                dated("m2", "2026-08-09T12:00:00.000Z", "s1", "/repo", 2_000_000),
            ),
        );
        let since = iso_ms("2026-08-05T00:00:00.000Z").unwrap();
        let w = &spend_windows(&dir, &[since])[0];
        assert_eq!(w.tokens, 2_000_000, "the August 1st turn is outside the window");
        assert!((w.cost_usd - 2.0).abs() < 1e-9);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn spend_window_groups_by_session_and_keeps_the_newest_cwd() {
        let dir = fixture(
            "group",
            &format!(
                "{}\n{}\n{}\n",
                dated("m1", "2026-08-09T09:00:00.000Z", "s1", "/wt/alpha", 1_000_000),
                dated("m2", "2026-08-09T10:00:00.000Z", "s1", "/wt/alpha", 500_000),
                dated("m3", "2026-08-09T11:00:00.000Z", "s2", "/wt/beta", 3_000_000),
            ),
        );
        let w = &spend_windows(&dir, &[0])[0];
        // Costliest first, so s2 leads.
        assert_eq!(w.sessions.len(), 2);
        assert_eq!(w.sessions[0].session_id, "s2");
        assert_eq!(w.sessions[1].session_id, "s1");
        assert_eq!(w.sessions[1].tokens, 1_500_000);
        assert_eq!(w.sessions[1].cwd, "/wt/alpha");
        assert_eq!(w.sessions[1].last_ms, iso_ms("2026-08-09T10:00:00.000Z").unwrap());
        // Rows account for the whole window: nothing lost, nothing doubled.
        let rows: f64 = w.sessions.iter().map(|s| s.cost_usd).sum();
        assert!((rows + w.unattributed_cost_usd - w.cost_usd).abs() < 1e-9);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A turn with no session id is still money spent. Dropping it would make
    /// the day's total smaller than the machine actually spent, which is the
    /// one direction a budget must never be wrong in.
    #[test]
    fn spend_without_a_session_id_counts_as_unattributed() {
        let orphan = r#"{"requestId":"r9","timestamp":"2026-08-09T10:00:00.000Z","message":{"id":"m9","model":"claude-haiku-4-5","usage":{"input_tokens":4000000,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}"#;
        let dir = fixture(
            "orphan",
            &format!(
                "{}\n{orphan}\n",
                dated("m1", "2026-08-09T09:00:00.000Z", "s1", "/repo", 1_000_000),
            ),
        );
        let w = &spend_windows(&dir, &[0])[0];
        assert!((w.cost_usd - 5.0).abs() < 1e-9, "cost was {}", w.cost_usd);
        assert_eq!(w.sessions.len(), 1);
        assert_eq!(w.unattributed_tokens, 4_000_000);
        assert!((w.unattributed_cost_usd - 4.0).abs() < 1e-9);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// An unparseable timestamp belongs to no window. Reporting it separately
    /// is what distinguishes "quiet day" from "today's transcripts are
    /// unreadable" — silently dating it 1970 would look like the former.
    #[test]
    fn spend_with_an_unparseable_timestamp_is_reported_as_undated() {
        let bad = r#"{"requestId":"r8","timestamp":"not-a-date","sessionId":"s1","cwd":"/repo","message":{"id":"m8","model":"claude-haiku-4-5","usage":{"input_tokens":7000000,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}"#;
        let dir = fixture("undated", &format!("{bad}\n"));
        let w = &spend_windows(&dir, &[0])[0];
        assert_eq!(w.tokens, 0, "an undated turn must not land in a window");
        assert!((w.undated_cost_usd - 7.0).abs() < 1e-9);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The whole reason the command takes a list: a day total that exceeds the
    /// month total containing it is the failure two separate scans produce.
    #[test]
    fn several_cutoffs_are_answered_from_one_consistent_pass() {
        let dir = fixture(
            "multi",
            &format!(
                "{}\n{}\n",
                dated("m1", "2026-07-15T09:00:00.000Z", "s1", "/repo", 1_000_000),
                dated("m2", "2026-08-09T09:00:00.000Z", "s1", "/repo", 2_000_000),
            ),
        );
        let month = iso_ms("2026-08-01T00:00:00.000Z").unwrap();
        let day = iso_ms("2026-08-09T00:00:00.000Z").unwrap();
        let ws = spend_windows(&dir, &[day, month]);
        assert_eq!(ws.len(), 2);
        assert_eq!(ws[0].since_ms, day);
        assert_eq!(ws[0].tokens, 2_000_000);
        assert_eq!(ws[1].tokens, 2_000_000, "July is outside August");
        assert!(ws[0].tokens <= ws[1].tokens, "a day cannot exceed its month");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The dedup that protects the lifetime total has to protect the window
    /// too — the windowed figure is what a budget fires on.
    #[test]
    fn spend_window_dedupes_the_same_turn_across_transcripts() {
        let dir = std::env::temp_dir().join(format!("cc-spend-dedup-{}", now_ms()));
        let proj = dir.join("proj");
        std::fs::create_dir_all(&proj).unwrap();
        let shared = dated("m1", "2026-08-09T09:00:00.000Z", "s1", "/repo", 1_000_000);
        std::fs::write(proj.join("a.jsonl"), format!("{shared}\n")).unwrap();
        std::fs::write(proj.join("b.jsonl"), format!("{shared}\n")).unwrap();
        let w = &spend_windows(&dir, &[0])[0];
        assert_eq!(w.tokens, 1_000_000);
        assert_eq!(w.sessions.len(), 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Archived transcripts spell it `session_id`; current ones carry both.
    #[test]
    fn the_legacy_session_id_spelling_still_attributes() {
        let legacy = r#"{"requestId":"r1","timestamp":"2026-08-09T09:00:00.000Z","session_id":"s-old","cwd":"/repo","message":{"id":"m1","model":"claude-haiku-4-5","usage":{"input_tokens":1000000,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}"#;
        let dir = fixture("legacy", &format!("{legacy}\n"));
        let w = &spend_windows(&dir, &[0])[0];
        assert_eq!(w.sessions.len(), 1);
        assert_eq!(w.sessions[0].session_id, "s-old");
        assert_eq!(w.unattributed_tokens, 0);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn iso_timestamps_parse_to_epoch_ms() {
        assert_eq!(iso_ms("1970-01-01T00:00:00.000Z"), Some(0));
        // Offsets are honored rather than treated as UTC — a turn logged at
        // 01:00+02:00 belongs to the previous UTC day.
        assert_eq!(
            iso_ms("2026-08-09T01:00:00.000+02:00"),
            iso_ms("2026-08-08T23:00:00.000Z")
        );
        assert_eq!(iso_ms(""), None);
        assert_eq!(iso_ms("2026-08-09"), None);
    }
}
