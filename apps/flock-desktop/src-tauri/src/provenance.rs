//! The desktop half of provenance: opening and closing a session record around
//! a real pane, harvesting that pane's token spend, and writing the export.
//!
//! The store, the record shape and both export formats live in
//! `flock_core::provenance`, which has no idea what a pane is. This module is
//! the part that does — and, crucially, it is the part that decides *which*
//! activity is ours to record.
//!
//! ## Why every write goes through the pane map
//!
//! Both upstream sources of activity are machine-wide:
//!
//!   * `~/.flock/hooks.jsonl` is appended to by every agent on the machine, and
//!     `hooks::spawn_watcher` tails all of it — deliberately, since the log path
//!     resolves through `shared_data_dir()` and not the dev-aware `data_dir()`.
//!     A `tauri dev` build therefore sees the installed app's prompt events.
//!   * `~/.claude/projects` belongs to the OS user, not to any flock instance.
//!
//! So a session row is only ever opened by [`begin`], from `spawn_pane`, and
//! only ever advanced through a [`Recorder`] hung off the resulting `PaneEntry`.
//! A hook line for a pane id this process never spawned finds nothing in
//! `state.panes`, so there is no recorder to advance and no row to touch. That
//! is the same ownership check `App.tsx` makes before crediting a prompt to a
//! flock ID, applied one layer down where it cannot be forgotten.
//!
//! ## What is recorded
//!
//! Identity, placement, timing, counts, tokens. Never prompt text, agent
//! output, file contents or diffs — see `flock_core::provenance` and migration
//! 008 for the full statement, which is also embedded in every export.

use flock_core::{provenance, AgentSession, SessionTokens, WorkspaceManager};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::State;

use crate::state::AppState;

/// Ceiling on how many sessions one export or listing may carry. A year of
/// heavy use is on the order of tens of thousands of rows; this is well past
/// any real window and stops a bad `from`/`to` pair turning into an unbounded
/// query behind a button click.
const MAX_ROWS: i64 = 50_000;

/// The handle a live pane holds onto its provenance row. Cloneable and cheap:
/// the pty output loop, the hook watcher and `close_pane` all need one, and
/// they run on different tasks.
#[derive(Clone)]
pub struct Recorder {
    wm: Arc<WorkspaceManager>,
    session_id: String,
    /// Claude Code's session id — imposed with `--session-id` on a fresh pane,
    /// carried back in with `--resume` on a restored one. Empty for
    /// opencode/codex, whose stores record usage in a different shape — those
    /// sessions get every column except the token ones.
    transcript_ref: String,
    /// What earlier session rows already banked from this same transcript. A
    /// resumed pane appends to the file its previous run left, so a whole-file
    /// reading counts the previous run's spend a second time; this row's share
    /// is the reading minus this. Zero for a fresh session.
    banked: SessionTokens,
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

impl Recorder {
    /// One prompt submitted. Called from the hook watcher, which has already
    /// established the pane is ours by finding it in `state.panes`.
    pub async fn prompt(&self) {
        if let Err(e) = self.wm.provenance_count_prompt(&self.session_id, now()).await {
            warn(&e);
        }
    }

    /// A status transition. Callers only reach here when the status actually
    /// changed, so the stored history is transitions and not a poll log.
    pub async fn status(&self, status: &str) {
        if let Err(e) = self.wm.provenance_record_status(&self.session_id, now(), status).await {
            warn(&e);
        }
    }

    /// Re-read this session's transcript and store this session's share of it
    /// (the whole-file reading minus what earlier rows already banked — see
    /// `banked`). Absolute, not incremental, so calling it repeatedly on a
    /// growing transcript is how a long-running session's numbers stay
    /// current. No-op for a pane with no transcript of its own.
    pub async fn harvest_tokens(&self) {
        let Some(tokens) = read_transcript_tokens(&self.transcript_ref) else {
            return;
        };
        // Saturating: a transcript that shrank below what was already banked
        // (rotated, hand-edited) must read as "nothing new", not go negative.
        let own = SessionTokens {
            input: (tokens.input - self.banked.input).max(0),
            output: (tokens.output - self.banked.output).max(0),
            cache_read: (tokens.cache_read - self.banked.cache_read).max(0),
            cache_write: (tokens.cache_write - self.banked.cache_write).max(0),
            cost_usd_micros: (tokens.cost_usd_micros - self.banked.cost_usd_micros).max(0),
        };
        if let Err(e) = self.wm.provenance_set_tokens(&self.session_id, own).await {
            warn(&e);
        }
    }

    /// Close the row. Harvests tokens first: the transcript is complete at this
    /// point, and this is the last chance to read it before the pane is gone.
    ///
    /// `outcome` is `closed` when the user closed the pane and `exited` when
    /// the process ended on its own. Both paths fire for a pane the user
    /// closed, in either order — the store keeps whichever arrives first.
    pub async fn finish(&self, outcome: &str, last_status: &str) {
        self.harvest_tokens().await;
        if let Err(e) = self.wm.provenance_end(&self.session_id, now(), outcome, last_status).await
        {
            warn(&e);
        }
    }
}

/// Provenance is bookkeeping. It must never take a pane down with it, so every
/// failure is a log line and nothing else.
fn warn(e: &anyhow::Error) {
    tracing::warn!(target: "flock_desktop_lib::provenance", error = %e, "could not write the provenance record");
}

/// Read one session's tokens out of its Claude Code transcript.
///
/// Guarded by `is_session_id` for the same reason `claude_context` is: the id
/// originates in the webview and is interpolated into a filename that gets
/// joined onto a directory, so anything that is not literally a UUID is refused
/// rather than sanitized. Jailed panes resolve too — secure mode mounts their
/// transcripts back out under `projects/flock-secure-<ws>/`, and
/// `find_transcript` knows about that layout.
fn read_transcript_tokens(transcript_ref: &str) -> Option<SessionTokens> {
    if !crate::claude_context::is_session_id(transcript_ref) {
        return None;
    }
    let path = crate::claude_context::find_transcript(transcript_ref)?;
    Some(crate::claude_code_usage::transcript_totals(&path))
}

/// Claude Code's session id, dug out of the launch arguments.
///
/// Read from `args` rather than accepted as its own IPC parameter on purpose:
/// the frontend already passes `--session-id <uuid>` (see `withClaudeSession`
/// in App.tsx), and a second parameter carrying the same value is a second
/// thing that can disagree with the command actually being run. What ends up in
/// the record is what the agent was told, or nothing.
///
/// `--resume <uuid>` counts too: that is how a restored pane is launched back
/// into the very session flock imposed on it the first time. Missing it left
/// every post-relaunch session with no transcript and zero tokens — the
/// overnight agent, the one an audit is most likely to ask about, exported as
/// free.
pub fn session_id_from_args(args: &[String]) -> String {
    args.iter()
        .position(|a| a == "--session-id" || a == "--resume")
        .and_then(|i| args.get(i + 1))
        .filter(|v| crate::claude_context::is_session_id(v))
        .cloned()
        .unwrap_or_default()
}

/// Everything `spawn_pane` knows about a pane at the moment it starts it.
/// A struct rather than fifteen positional arguments, and it is the same shape
/// the row has, so a new column is one edit here and one in the caller.
pub struct SpawnFacts<'a> {
    pub pane_id: &'a str,
    pub workspace_id: &'a str,
    pub agent_name: Option<&'a str>,
    pub agent_kind: &'a str,
    pub person_id: Option<&'a str>,
    pub person_name: Option<&'a str>,
    pub repo_id: Option<&'a str>,
    pub repo_name: Option<&'a str>,
    pub cwd: Option<&'a Path>,
    pub secure: bool,
    pub transcript_ref: String,
}

/// Open a session row for a pane this process just spawned, and hand back the
/// recorder it should carry for the rest of its life.
///
/// Returns `None` rather than failing the spawn when anything goes wrong: an
/// agent the user asked for must start even if the audit trail cannot be
/// written, and a pane with no recorder simply records nothing.
pub async fn begin(wm: &Arc<WorkspaceManager>, facts: SpawnFacts<'_>) -> Option<Recorder> {
    let started_at = now();
    let cwd = facts.cwd.map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    // The branch and the workspace's own checkout, both read here so the row
    // stays true to the moment the agent started: an agent that ran on
    // `feature/x` must not read as having run on `main` because the worktree
    // was moved on afterwards.
    let branch = if cwd.is_empty() { String::new() } else { crate::git::current_branch(&cwd).unwrap_or_default() };
    let workspace = workspace_facts(wm, facts.workspace_id).await;
    // "Own worktree" means the agent was not working in the workspace's own
    // checkout — which is what makes its changes isolated from everyone else's.
    // Compared as canonical paths because `cwd` has already been canonicalized
    // and the stored `repo_path` has not.
    let worktree = match (&workspace.repo_path, facts.cwd) {
        (repo, Some(c)) if !repo.is_empty() => {
            PathBuf::from(repo).canonicalize().map(|r| r != c).unwrap_or(false)
        }
        _ => false,
    };

    let session = AgentSession {
        id: uuid::Uuid::new_v4().to_string(),
        pane_id: facts.pane_id.to_string(),
        workspace_id: facts.workspace_id.to_string(),
        workspace_name: workspace.name,
        agent_name: facts.agent_name.unwrap_or_default().to_string(),
        agent_kind: facts.agent_kind.to_string(),
        person_id: facts.person_id.unwrap_or_default().to_string(),
        person_name: facts.person_name.unwrap_or_default().to_string(),
        repo_id: facts.repo_id.unwrap_or_default().to_string(),
        repo_name: facts.repo_name.unwrap_or_default().to_string(),
        cwd,
        branch,
        worktree,
        secure: facts.secure,
        transcript_ref: facts.transcript_ref.clone(),
        started_at,
        ended_at: None,
        updated_at: started_at,
        outcome: "running".into(),
        prompts: 0,
        last_status: "idle".into(),
        ..Default::default()
    };

    // Read before the new row is inserted (its token columns start at zero, so
    // the order is belt-and-braces): what earlier rows of this transcript have
    // already accounted for. Non-empty only for a resumed session.
    let banked = if facts.transcript_ref.is_empty() {
        SessionTokens::default()
    } else {
        wm.provenance_tokens_banked(&facts.transcript_ref).await.unwrap_or_default()
    };

    if let Err(e) = wm.provenance_begin(&session).await {
        warn(&e);
        return None;
    }
    Some(Recorder {
        wm: Arc::clone(wm),
        session_id: session.id,
        transcript_ref: facts.transcript_ref,
        banked,
    })
}

struct WorkspaceFacts {
    name: String,
    repo_path: String,
}

/// Name + checkout path for a workspace, snapshotted into the row.
///
/// Snapshotted rather than joined at read time because the audit row has to
/// outlive the workspace: `agent_sessions` has no foreign key to `workspaces`
/// precisely so that deleting a workspace cannot erase the evidence its agents
/// ran, and a row that then said only `workspace_id` would be unreadable.
///
/// Empty for the ephemeral `copilot:`/`observe:` pseudo-workspaces, which have
/// no row of their own — the same ones `spawn_pane` skips `register_agent` for.
async fn workspace_facts(wm: &Arc<WorkspaceManager>, workspace_id: &str) -> WorkspaceFacts {
    let found = wm
        .list()
        .await
        .ok()
        .and_then(|list| list.into_iter().find(|w| w.id.0 == workspace_id));
    match found {
        Some(w) => WorkspaceFacts { name: w.name, repo_path: w.repo_path },
        None => WorkspaceFacts { name: String::new(), repo_path: String::new() },
    }
}

/// Close out rows left open by a previous run. Called once at startup, before
/// anything can spawn a pane.
pub async fn close_orphans(wm: &Arc<WorkspaceManager>) {
    match wm.provenance_close_orphans().await {
        Ok(0) => {}
        Ok(n) => tracing::info!(
            target: "flock_desktop_lib::provenance",
            sessions = n,
            "closed provenance sessions left open by a previous run"
        ),
        Err(e) => warn(&e),
    }
}

// ─── Commands ───────────────────────────────────────────────────────────────

/// What the settings readout draws: the rows plus the totals for the window,
/// so the summary line and the table can never disagree.
#[derive(Serialize)]
pub struct ProvenanceReport {
    pub sessions: Vec<AgentSession>,
    pub totals: provenance::Totals,
    /// True when the window held more sessions than the requested limit, so
    /// the UI can say the list is cut. `totals` still covers the whole window.
    pub truncated: bool,
}

/// Bring every live pane's token figures up to date before anything is read.
///
/// A session's tokens are otherwise only harvested when it ends, which would
/// make the current day's report read as free. Bounded by the number of live
/// panes (a dozen at most), and each harvest is one transcript parse.
async fn refresh_live(state: &State<'_, AppState>) {
    let recorders: Vec<Recorder> = {
        let panes = state.panes.read().await;
        panes.values().filter_map(|p| p.provenance.clone()).collect()
    };
    for r in recorders {
        r.harvest_tokens().await;
    }
}

fn clamp_limit(limit: Option<i64>) -> i64 {
    limit.unwrap_or(MAX_ROWS).clamp(1, MAX_ROWS)
}

/// Sessions overlapping `[from, to)`, newest first, with the window's totals.
#[tauri::command]
pub async fn provenance_report(
    state: State<'_, AppState>,
    from: i64,
    to: i64,
    limit: Option<i64>,
) -> Result<ProvenanceReport, String> {
    refresh_live(&state).await;
    let limit = clamp_limit(limit);
    // The totals are the window's, not the page's: the tiles above the table
    // present themselves as "this window's sessions/prompts/tokens/cost", and
    // the truncation hint says only the list is cut. So fetch the whole window
    // (bounded by the same cap as the export), total it, and cut the list
    // afterwards.
    let mut sessions = state
        .wm
        .provenance_list(from, to, MAX_ROWS)
        .await
        .map_err(|e| e.to_string())?;
    let totals = provenance::Totals::of(&sessions);
    let truncated = sessions.len() as i64 > limit;
    sessions.truncate(limit as usize);
    Ok(ProvenanceReport { sessions, totals, truncated })
}

#[derive(Serialize)]
pub struct ExportResult {
    pub path: String,
    pub sessions: i64,
    pub bytes: usize,
}

/// Screen an export destination before anything is written to it.
///
/// The path comes from the native save dialog, so the user has already chosen
/// it — but it still arrives over IPC from the webview, which this codebase
/// treats as potentially compromised (see the secure-mode reasoning in
/// `spawn_pane`). These checks are what stop this command being a
/// write-anywhere primitive dressed as an export: the path must be absolute,
/// its extension must match the format being written (so it cannot be used to
/// drop a `.command`, a `.zshrc` or a launch-agent plist somewhere that runs
/// it), and its parent must already be a directory (so no tree is created, and
/// `..` in the middle of the path has to resolve to somewhere real). It can
/// still overwrite a file the user could overwrite themselves, which is exactly
/// what a save dialog is for.
fn validate_export_path(dest: &str, format: &str) -> Result<(PathBuf, &'static str), String> {
    let expected_ext = match format {
        "csv" => "csv",
        "json" => "json",
        other => return Err(format!("unknown export format '{other}'")),
    };
    let path = PathBuf::from(dest);
    if !path.is_absolute() {
        return Err("export path must be absolute".into());
    }
    if path.extension().and_then(|e| e.to_str()) != Some(expected_ext) {
        return Err(format!("a {format} export must be written to a .{expected_ext} file"));
    }
    match path.parent() {
        Some(dir) if dir.is_dir() => {}
        _ => return Err("the folder to export into does not exist".into()),
    }
    Ok((path, expected_ext))
}

/// Write the provenance export for `[from, to)` to `dest`. See
/// [`validate_export_path`] for what the destination has to satisfy.
#[tauri::command]
pub async fn provenance_export(
    state: State<'_, AppState>,
    from: i64,
    to: i64,
    format: String,
    dest: String,
) -> Result<ExportResult, String> {
    let (path, expected_ext) = validate_export_path(&dest, &format)?;

    refresh_live(&state).await;
    let limit = MAX_ROWS;
    let body = if expected_ext == "json" {
        let sessions = state
            .wm
            .provenance_list_with_history(from, to, limit)
            .await
            .map_err(|e| e.to_string())?;
        let out = provenance::to_json(&sessions, from, to, now());
        (out, sessions.len())
    } else {
        let sessions = state.wm.provenance_list(from, to, limit).await.map_err(|e| e.to_string())?;
        // Transition counts, not the transitions themselves: the CSV is one row
        // per session so a spreadsheet stays readable, and the timeline lives
        // in the JSON export instead.
        let mut counts = Vec::with_capacity(sessions.len());
        for s in &sessions {
            counts.push(state.wm.provenance_history(&s.id).await.map(|h| h.len() as i64).unwrap_or(0));
        }
        (provenance::to_csv(&sessions, &counts), sessions.len())
    };
    let (text, count) = body;

    std::fs::write(&path, text.as_bytes()).map_err(|e| format!("could not write {dest}: {e}"))?;
    tracing::info!(
        target: "flock_desktop_lib::provenance",
        path = %dest, sessions = count, "wrote a provenance export"
    );
    Ok(ExportResult { path: dest, sessions: count as i64, bytes: text.len() })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(label: &str) -> PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "flock-prov-desktop-{}-{}-{}",
            label,
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The path `spawn_pane` actually takes, minus Tauri: open a row from the
    /// facts a spawn knows, drive it through the recorder the pane would hold,
    /// and read it back. Compilation proves the wiring type-checks; this proves
    /// a session that happened is a session that can be exported.
    #[tokio::test]
    async fn a_spawn_becomes_a_readable_record() {
        let dir = scratch("spawn");
        let pool = flock_core::db::init_pool(&dir.join("flock.db")).await.unwrap();
        let wm = Arc::new(WorkspaceManager::new(pool));
        let ws = wm.create("flock", dir.to_str().unwrap(), "main").await.unwrap();

        let work = dir.join("worktree-a");
        std::fs::create_dir_all(&work).unwrap();

        let rec = begin(
            &wm,
            SpawnFacts {
                pane_id: "pane-1",
                workspace_id: &ws.id.0,
                agent_name: Some("Fern"),
                agent_kind: "claude",
                person_id: Some("person-1"),
                person_name: Some("remi"),
                repo_id: Some("git@github.com:acme/flock"),
                repo_name: Some("flock"),
                cwd: Some(&work),
                secure: true,
                // Not a session that exists on disk, so the harvest is a no-op
                // and the token columns stay zero rather than picking up some
                // other agent's transcript.
                transcript_ref: "00000000-0000-0000-0000-0000000000ff".into(),
            },
        )
        .await
        .expect("a recorder");

        rec.prompt().await;
        rec.prompt().await;
        rec.status("working").await;
        rec.status("awaiting_input").await;
        rec.finish("closed", "done").await;

        let rows = wm.provenance_list_with_history(0, i64::MAX, 10).await.unwrap();
        assert_eq!(rows.len(), 1);
        let s = &rows[0];
        assert_eq!(s.pane_id, "pane-1");
        assert_eq!(s.workspace_name, "flock", "snapshotted, so it outlives the workspace");
        assert_eq!(s.agent_name, "Fern");
        assert_eq!(s.person_name, "remi");
        assert_eq!(s.repo_name, "flock");
        assert!(s.secure);
        assert!(s.worktree, "a cwd that is not the workspace checkout is a worktree");
        assert_eq!(s.prompts, 2);
        assert_eq!(s.outcome, "closed");
        assert_eq!(s.last_status, "done");
        assert_eq!(s.status_history.len(), 2);
        assert_eq!(s.tokens_input, 0, "no transcript, no tokens invented");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An agent working directly in the workspace checkout is not isolated, and
    /// the row has to say so — it is the column a reviewer reads first.
    #[tokio::test]
    async fn the_workspace_checkout_is_not_recorded_as_a_worktree() {
        let dir = scratch("checkout");
        let pool = flock_core::db::init_pool(&dir.join("flock.db")).await.unwrap();
        let wm = Arc::new(WorkspaceManager::new(pool));
        let repo = dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let ws = wm.create("flock", repo.to_str().unwrap(), "main").await.unwrap();

        // Canonicalized, as spawn_pane hands it over — on macOS the temp dir is
        // a symlink, so comparing the raw strings would call every pane a
        // worktree.
        let canon = repo.canonicalize().unwrap();
        begin(
            &wm,
            SpawnFacts {
                pane_id: "pane-1",
                workspace_id: &ws.id.0,
                agent_name: None,
                agent_kind: "claude",
                person_id: None,
                person_name: None,
                repo_id: None,
                repo_name: None,
                cwd: Some(&canon),
                secure: false,
                transcript_ref: String::new(),
            },
        )
        .await
        .expect("a recorder");

        let s = &wm.provenance_list(0, i64::MAX, 10).await.unwrap()[0];
        assert!(!s.worktree);
        assert!(!s.secure);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_transcript_id_comes_from_the_launch_arguments() {
        let args: Vec<String> = ["--session-id", "2f1c6bb5-d843-400e-a86c-70276cd12c33", "-p"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(session_id_from_args(&args), "2f1c6bb5-d843-400e-a86c-70276cd12c33");
    }

    /// A restored pane is launched with `--resume <the id flock imposed>`, and
    /// its row must find the same transcript — otherwise every post-relaunch
    /// session exports with zero tokens.
    #[test]
    fn a_resumed_launch_keeps_its_transcript() {
        let args: Vec<String> = ["--resume", "2f1c6bb5-d843-400e-a86c-70276cd12c33", "-p"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(session_id_from_args(&args), "2f1c6bb5-d843-400e-a86c-70276cd12c33");
        assert_eq!(session_id_from_args(&["--resume".into(), "not-a-uuid".into()]), "");
    }

    #[test]
    fn a_launch_without_a_session_id_records_none() {
        let args: Vec<String> = vec!["--dangerously-skip-permissions".into()];
        assert_eq!(session_id_from_args(&args), "");
        assert_eq!(session_id_from_args(&[]), "");
        // The flag with nothing after it, and with something that isn't a uuid:
        // both have to yield an empty ref rather than a value that would later
        // be pasted into a filename.
        assert_eq!(session_id_from_args(&["--session-id".to_string()]), "");
        assert_eq!(
            session_id_from_args(&["--session-id".into(), "../../etc/passwd".into()]),
            ""
        );
    }

    #[test]
    fn a_transcript_ref_that_is_not_a_uuid_never_reaches_the_filesystem() {
        assert!(read_transcript_tokens("../../../../etc/passwd").is_none());
        assert!(read_transcript_tokens("").is_none());
    }

    /// The one place a webview-supplied string reaches `fs::write`. A save
    /// dialog produced it in the normal case; these are what happens when
    /// something else did.
    #[test]
    fn an_export_destination_is_screened_before_anything_is_written() {
        let dir = scratch("dest");
        let ok = dir.join("report.csv");
        assert!(validate_export_path(ok.to_str().unwrap(), "csv").is_ok());
        assert!(validate_export_path(dir.join("r.json").to_str().unwrap(), "json").is_ok());

        // A relative path would resolve against whatever the app's cwd happens
        // to be, which is not something the user chose.
        assert!(validate_export_path("report.csv", "csv").is_err());
        // The extension is the format, so an export cannot be used to drop a
        // file somewhere that executes it.
        assert!(validate_export_path("/tmp/evil.command", "csv").is_err());
        assert!(validate_export_path(
            &dir.join(".zshrc").to_string_lossy(), "csv").is_err());
        assert!(validate_export_path(ok.to_str().unwrap(), "json").is_err());
        assert!(validate_export_path(ok.to_str().unwrap(), "yaml").is_err());
        // No directory tree gets created on our way to writing a report.
        assert!(validate_export_path(
            &dir.join("nope/deeper/report.csv").to_string_lossy(), "csv").is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_row_limit_is_clamped_in_both_directions() {
        assert_eq!(clamp_limit(None), MAX_ROWS);
        assert_eq!(clamp_limit(Some(0)), 1);
        assert_eq!(clamp_limit(Some(-5)), 1);
        assert_eq!(clamp_limit(Some(10)), 10);
        assert_eq!(clamp_limit(Some(i64::MAX)), MAX_ROWS);
    }
}
