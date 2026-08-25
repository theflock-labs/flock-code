//! PR watch / auto-review / merge queue persistence.
//!
//! One JSON blob at `~/.flock/pr_watch.json` holds the watch config, the
//! seen-PR set (so "fresh" PRs can be flagged exactly once), stored review
//! summaries, and the ordered merge queue. Like the GitHub token, the file
//! lives in `~/.flock` directly (not the dev-isolated data dir): it's
//! machine-level state shared by every instance.
//!
//! Traffic is one poll per minute, so every operation is a full
//! load-mutate-save under a process-wide mutex — no in-memory cache to drift.

use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::Mutex,
};

// ─── Types ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrWatchConfig {
    #[serde(default)]
    pub repos: Vec<String>,
    #[serde(default)]
    pub auto_review: bool,
    #[serde(default = "default_merge_method")]
    pub merge_method: String,
    /// Queue tick: when the head PR is merely behind its base, request a
    /// GitHub branch update instead of blocking. Defaults false (it pushes
    /// commits to the PR branch). `#[serde(default)]` so configs saved before
    /// this field existed still deserialize.
    #[serde(default)]
    pub auto_update_branch: bool,
}

fn default_merge_method() -> String {
    "squash".to_string()
}

impl Default for PrWatchConfig {
    fn default() -> Self {
        Self {
            repos: Vec::new(),
            auto_review: false,
            merge_method: default_merge_method(),
            auto_update_branch: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewSummary {
    pub summary: String,
    /// ISO8601 timestamp of the last write.
    pub updated_at: String,
    pub pane_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MergeQueueItem {
    pub repo: String,
    pub number: u64,
    pub title: String,
    pub position: u32,
    pub status: String,
    pub note: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct PrWatchState {
    #[serde(default)]
    config: PrWatchConfig,
    /// Repos whose pre-existing PRs have been seeded into `seen` — a repo's
    /// first poll must not report every open PR as fresh.
    #[serde(default)]
    seeded_repos: HashSet<String>,
    /// "repo#number" keys already surfaced to the user.
    #[serde(default)]
    seen: HashSet<String>,
    /// Review summaries keyed "repo#number".
    #[serde(default)]
    summaries: HashMap<String, ReviewSummary>,
    #[serde(default)]
    queue: Vec<MergeQueueItem>,
}

// ─── Persistence ──────────────────────────────────────────────────────────

fn state_path() -> PathBuf {
    flock_core::paths::shared_data_dir().join("pr_watch.json")
}

fn load_state() -> PrWatchState {
    // Missing or corrupt file → defaults; the next save rewrites it.
    std::fs::read_to_string(state_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_state(state: &PrWatchState) -> Result<(), String> {
    let path = state_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

static STATE_LOCK: Mutex<()> = Mutex::new(());

/// Read-only access; no save.
fn read<T>(f: impl FnOnce(&PrWatchState) -> T) -> T {
    let _guard = STATE_LOCK.lock().unwrap();
    f(&load_state())
}

/// Load-mutate-save. Never held across an await — GitHub calls happen
/// outside, with the results folded in here.
fn mutate<T>(f: impl FnOnce(&mut PrWatchState) -> T) -> Result<T, String> {
    let _guard = STATE_LOCK.lock().unwrap();
    let mut state = load_state();
    let out = f(&mut state);
    save_state(&state)?;
    Ok(out)
}

pub fn key(repo: &str, number: u64) -> String {
    format!("{}#{}", repo, number)
}

// ─── Config ───────────────────────────────────────────────────────────────

pub fn get_config() -> PrWatchConfig {
    read(|s| s.config.clone())
}

pub fn set_config(config: PrWatchConfig) -> Result<(), String> {
    mutate(|s| s.config = config)
}

// ─── Poll bookkeeping ─────────────────────────────────────────────────────

/// Fold one poll's results into `seen`/`seeded_repos` and return the fresh
/// keys. `by_repo` holds only repos whose fetch succeeded — a repo that
/// 404'd must not get seeded off an empty list.
pub fn record_poll(by_repo: &HashMap<String, Vec<String>>) -> Result<Vec<String>, String> {
    mutate(|s| {
        let mut fresh = Vec::new();
        for (repo, keys) in by_repo {
            if s.seeded_repos.contains(repo) {
                for k in keys {
                    if s.seen.insert(k.clone()) {
                        fresh.push(k.clone());
                    }
                }
            } else {
                // First successful poll of this repo: seed everything as seen
                // so adding a busy repo doesn't storm the user with "new" PRs.
                s.seen.extend(keys.iter().cloned());
                s.seeded_repos.insert(repo.clone());
            }
        }
        fresh
    })
}

// ─── Review summaries ─────────────────────────────────────────────────────

pub fn set_summary(
    repo: &str,
    number: u64,
    summary: String,
    pane_id: Option<String>,
) -> Result<(), String> {
    let entry = ReviewSummary {
        summary,
        updated_at: chrono::Utc::now().to_rfc3339(),
        pane_id,
    };
    mutate(|s| {
        s.summaries.insert(key(repo, number), entry);
    })
}

pub fn get_summaries() -> HashMap<String, ReviewSummary> {
    read(|s| s.summaries.clone())
}

// ─── Merge queue ──────────────────────────────────────────────────────────

fn normalize_positions(queue: &mut [MergeQueueItem]) {
    for (i, item) in queue.iter_mut().enumerate() {
        item.position = i as u32;
    }
}

pub fn queue_list() -> Vec<MergeQueueItem> {
    read(|s| s.queue.clone())
}

/// Idempotent per repo#number; new items join the tail as "waiting".
pub fn queue_add(repo: &str, number: u64, title: &str) -> Result<Vec<MergeQueueItem>, String> {
    mutate(|s| {
        if !s.queue.iter().any(|i| i.repo == repo && i.number == number) {
            s.queue.push(MergeQueueItem {
                repo: repo.to_string(),
                number,
                title: title.to_string(),
                position: 0,
                status: "waiting".to_string(),
                note: None,
            });
        }
        normalize_positions(&mut s.queue);
        s.queue.clone()
    })
}

pub fn queue_remove(repo: &str, number: u64) -> Result<Vec<MergeQueueItem>, String> {
    mutate(|s| {
        s.queue.retain(|i| !(i.repo == repo && i.number == number));
        normalize_positions(&mut s.queue);
        s.queue.clone()
    })
}

/// Move an item to a 0-based position (clamped); the rest shift around it.
pub fn queue_reorder(
    repo: &str,
    number: u64,
    position: u32,
) -> Result<Vec<MergeQueueItem>, String> {
    mutate(|s| {
        if let Some(from) = s.queue.iter().position(|i| i.repo == repo && i.number == number) {
            let item = s.queue.remove(from);
            let to = (position as usize).min(s.queue.len());
            s.queue.insert(to, item);
        }
        normalize_positions(&mut s.queue);
        s.queue.clone()
    })
}

/// The head item's identity plus the configured merge method — what a tick
/// needs before it goes to the network.
pub fn queue_head() -> Option<(String, u64, String)> {
    read(|s| {
        s.queue
            .first()
            .map(|i| (i.repo.clone(), i.number, s.config.merge_method.clone()))
    })
}

/// Apply a tick's verdict for the head item. The head may have been removed
/// or reordered while the network calls ran, so it's re-identified by
/// repo#number rather than position. Non-head items are reset to "waiting".
pub enum TickOutcome {
    /// Merged (or found already closed/merged) — drop it from the queue.
    Remove,
    /// Still queued; record status + note.
    Status(String, Option<String>),
}

pub fn queue_apply_tick(
    repo: &str,
    number: u64,
    outcome: TickOutcome,
) -> Result<Vec<MergeQueueItem>, String> {
    mutate(|s| {
        match outcome {
            TickOutcome::Remove => {
                s.queue.retain(|i| !(i.repo == repo && i.number == number));
            }
            TickOutcome::Status(status, note) => {
                if let Some(item) = s
                    .queue
                    .iter_mut()
                    .find(|i| i.repo == repo && i.number == number)
                {
                    item.status = status;
                    item.note = note;
                }
            }
        }
        normalize_positions(&mut s.queue);
        for item in s.queue.iter_mut().skip(1) {
            item.status = "waiting".to_string();
            item.note = None;
        }
        s.queue.clone()
    })
}
