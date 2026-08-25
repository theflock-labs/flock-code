//! Provenance: the durable record of what the fleet did, and the two export
//! formats it leaves as an artifact.
//!
//! flock already knew all of this — `spawn_pane` stamps identity into every
//! pane's environment, the hooks log carries prompt submissions, the transcripts
//! carry tokens — but it knew it only while the app was open, in the shape of
//! live UI state. This module is where it lands so it can be queried after the
//! fact and handed to someone who was not watching.
//!
//! ## What is recorded, and what is not
//!
//! Recorded: identity (person, agent name), placement (workspace, repo, branch,
//! working directory, worktree/jail flags), timing (start, end, every status
//! transition), and volume (prompts submitted, tokens, estimated cost).
//!
//! Not recorded, deliberately: prompt text, agent output, file contents, diffs.
//! `prompts` is a count. There is no opt-in that turns the text on — see the
//! migration for the reasoning. An exported row is meant to prove *that* an
//! agent ran and what it cost, never to reproduce what was said.
//!
//! ## Attribution
//!
//! Writes are driven from the desktop app's live pane map, which by
//! construction only holds panes *this* process spawned. That matters because
//! the two upstream sources are machine-wide: `~/.flock/hooks.jsonl` is shared
//! by every flock on the machine, and `~/.claude/projects` belongs to the OS
//! user. A `tauri dev` build running beside the installed app sees both in
//! full. Recording from the pane map instead of from either source is what
//! stops this table inventing sessions that never happened here — the same
//! ownership check `App.tsx`'s hook handler makes for the social counters.
//!
//! ## Cost
//!
//! `cost_usd_micros` is an estimate. Transcripts record token counts, not
//! money; the dollars come from flock's own price table
//! (`claude_code_usage.rs`) and drift when Anthropic's prices change. Tokens
//! are exact. Both facts are stated in the export header so nobody reads the
//! total as an invoice.

use crate::workspace::WorkspaceManager;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use sqlx::Row;

/// One agent session: a pane from spawn to teardown.
///
/// Field order is the order the CSV writes them in, so the two cannot drift
/// apart without someone noticing in review.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AgentSession {
    pub id: String,
    pub pane_id: String,
    pub workspace_id: String,
    pub workspace_name: String,
    pub agent_name: String,
    pub agent_kind: String,
    pub person_id: String,
    pub person_name: String,
    pub repo_id: String,
    pub repo_name: String,
    pub cwd: String,
    pub branch: String,
    /// The agent worked in a git worktree of its own rather than in the
    /// workspace checkout.
    pub worktree: bool,
    /// The agent ran inside the Docker jail (Secure mode).
    pub secure: bool,
    /// Claude Code's `--session-id`, when flock imposed one. Empty otherwise,
    /// which is also why an opencode/codex row carries no tokens.
    pub transcript_ref: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub updated_at: i64,
    /// `running` | `closed` | `exited` | `interrupted`.
    pub outcome: String,
    pub prompts: i64,
    pub last_status: String,
    pub tokens_input: i64,
    pub tokens_output: i64,
    pub tokens_cache_read: i64,
    pub tokens_cache_write: i64,
    pub cost_usd_micros: i64,
    /// Filled in only by [`WorkspaceManager::provenance_history`] and the JSON
    /// export. The CSV carries a transition *count* instead: one row per
    /// session is what makes a spreadsheet legible, and the full timeline of a
    /// day's fleet is thousands of entries.
    #[serde(default)]
    pub status_history: Vec<StatusChange>,
}

impl AgentSession {
    pub fn tokens_total(&self) -> i64 {
        self.tokens_input + self.tokens_output + self.tokens_cache_read + self.tokens_cache_write
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatusChange {
    pub at: i64,
    pub status: String,
}

/// Tokens and estimated cost harvested from one session's transcript. Kept as a
/// separate struct so the caller that reads transcripts (which lives in the
/// desktop crate, next to the price table) and the caller that persists them
/// (here) share one shape.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct SessionTokens {
    pub input: i64,
    pub output: i64,
    pub cache_read: i64,
    pub cache_write: i64,
    pub cost_usd_micros: i64,
}

/// Every column, in the order both exports emit them.
const COLUMNS: &str = "id, pane_id, workspace_id, workspace_name, agent_name, agent_kind, \
     person_id, person_name, repo_id, repo_name, cwd, branch, worktree, secure, \
     transcript_ref, started_at, ended_at, updated_at, outcome, prompts, last_status, \
     tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, cost_usd_micros";

fn row_to_session(row: &sqlx::sqlite::SqliteRow) -> AgentSession {
    AgentSession {
        id: row.get("id"),
        pane_id: row.get("pane_id"),
        workspace_id: row.get("workspace_id"),
        workspace_name: row.get("workspace_name"),
        agent_name: row.get("agent_name"),
        agent_kind: row.get("agent_kind"),
        person_id: row.get("person_id"),
        person_name: row.get("person_name"),
        repo_id: row.get("repo_id"),
        repo_name: row.get("repo_name"),
        cwd: row.get("cwd"),
        branch: row.get("branch"),
        worktree: row.get::<i64, _>("worktree") != 0,
        secure: row.get::<i64, _>("secure") != 0,
        transcript_ref: row.get("transcript_ref"),
        started_at: row.get("started_at"),
        ended_at: row.get("ended_at"),
        updated_at: row.get("updated_at"),
        outcome: row.get("outcome"),
        prompts: row.get("prompts"),
        last_status: row.get("last_status"),
        tokens_input: row.get("tokens_input"),
        tokens_output: row.get("tokens_output"),
        tokens_cache_read: row.get("tokens_cache_read"),
        tokens_cache_write: row.get("tokens_cache_write"),
        cost_usd_micros: row.get("cost_usd_micros"),
        status_history: Vec::new(),
    }
}

impl WorkspaceManager {
    /// Open a session row. Called once per spawn, from the one place that knows
    /// the spawn is ours.
    pub async fn provenance_begin(&self, s: &AgentSession) -> Result<()> {
        sqlx::query(
            "INSERT INTO agent_sessions (
                id, pane_id, workspace_id, workspace_name, agent_name, agent_kind,
                person_id, person_name, repo_id, repo_name, cwd, branch, worktree, secure,
                transcript_ref, started_at, ended_at, updated_at, outcome, prompts, last_status,
                tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, cost_usd_micros
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'running', 0, ?, 0, 0, 0, 0, 0)",
        )
        .bind(&s.id)
        .bind(&s.pane_id)
        .bind(&s.workspace_id)
        .bind(&s.workspace_name)
        .bind(&s.agent_name)
        .bind(&s.agent_kind)
        .bind(&s.person_id)
        .bind(&s.person_name)
        .bind(&s.repo_id)
        .bind(&s.repo_name)
        .bind(&s.cwd)
        .bind(&s.branch)
        .bind(s.worktree as i64)
        .bind(s.secure as i64)
        .bind(&s.transcript_ref)
        .bind(s.started_at)
        .bind(s.started_at)
        .bind(&s.last_status)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// One prompt submitted to this agent. The text is not passed in and there
    /// is no parameter for it — see the module docs.
    ///
    /// Guarded on `ended_at IS NULL` so a late hook line (the log is tailed on
    /// an 800ms poll, and a pane can be closed inside that window) cannot
    /// reopen the accounting of a session that already closed.
    pub async fn provenance_count_prompt(&self, session_id: &str, at: i64) -> Result<()> {
        sqlx::query(
            "UPDATE agent_sessions SET prompts = prompts + 1, updated_at = ?
             WHERE id = ? AND ended_at IS NULL",
        )
        .bind(at)
        .bind(session_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Append a status transition. Callers only call this when the status
    /// actually changed, so the history is transitions and not a poll log.
    ///
    /// Guarded on `ended_at IS NULL` like the prompt counter: the pty output
    /// loop drains to EOF after `close_pane` has already ended the row, and a
    /// transition landing then would extend the timeline past `ended_at` and
    /// overwrite the closed row's final status.
    pub async fn provenance_record_status(
        &self,
        session_id: &str,
        at: i64,
        status: &str,
    ) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        let open = sqlx::query(
            "UPDATE agent_sessions SET last_status = ?, updated_at = ?
             WHERE id = ? AND ended_at IS NULL",
        )
        .bind(status)
        .bind(at)
        .bind(session_id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if open > 0 {
            sqlx::query("INSERT INTO agent_session_status (session_id, at, status) VALUES (?, ?, ?)")
                .bind(session_id)
                .bind(at)
                .bind(status)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    /// Tokens already banked by earlier sessions pointing at the same
    /// transcript. A resumed pane (`--resume <uuid>`) appends to the transcript
    /// its previous run left behind, so its new row must record only its own
    /// share: the whole file is the sum of every row that ever pointed at it,
    /// and this is what the new row's reading gets reduced by.
    pub async fn provenance_tokens_banked(&self, transcript_ref: &str) -> Result<SessionTokens> {
        let row: (i64, i64, i64, i64, i64) = sqlx::query_as(
            "SELECT COALESCE(SUM(tokens_input), 0), COALESCE(SUM(tokens_output), 0),
                    COALESCE(SUM(tokens_cache_read), 0), COALESCE(SUM(tokens_cache_write), 0),
                    COALESCE(SUM(cost_usd_micros), 0)
             FROM agent_sessions WHERE transcript_ref = ?",
        )
        .bind(transcript_ref)
        .fetch_one(&self.pool)
        .await?;
        Ok(SessionTokens {
            input: row.0,
            output: row.1,
            cache_read: row.2,
            cache_write: row.3,
            cost_usd_micros: row.4,
        })
    }

    /// Fold a fresh transcript reading into the row. Idempotent — the totals
    /// are absolute, not deltas, so re-harvesting a growing transcript is safe
    /// and is how a long-running session's numbers stay current.
    pub async fn provenance_set_tokens(&self, session_id: &str, t: SessionTokens) -> Result<()> {
        sqlx::query(
            "UPDATE agent_sessions SET tokens_input = ?, tokens_output = ?,
                tokens_cache_read = ?, tokens_cache_write = ?, cost_usd_micros = ?
             WHERE id = ?",
        )
        .bind(t.input)
        .bind(t.output)
        .bind(t.cache_read)
        .bind(t.cache_write)
        .bind(t.cost_usd_micros)
        .bind(session_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Close a session. The `ended_at IS NULL` guard makes this idempotent:
    /// `close_pane` and the pty exit loop both fire for a pane the user closed,
    /// in either order, and the first one to arrive is the truthful one.
    pub async fn provenance_end(
        &self,
        session_id: &str,
        at: i64,
        outcome: &str,
        last_status: &str,
    ) -> Result<()> {
        sqlx::query(
            "UPDATE agent_sessions SET ended_at = ?, updated_at = ?, outcome = ?, last_status = ?
             WHERE id = ? AND ended_at IS NULL",
        )
        .bind(at)
        .bind(at)
        .bind(outcome)
        .bind(last_status)
        .bind(session_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Close out sessions left open by a previous run, at their last recorded
    /// activity rather than at now.
    ///
    /// A crash, a force-quit or a machine that went to sleep and never came
    /// back all leave `ended_at` NULL. Left alone those rows read as sessions
    /// still running, and any duration computed from them grows forever — a
    /// three-minute agent from last March would export as five months of
    /// runtime. Marking them `interrupted` says exactly what is known: it ran,
    /// it stopped being observed, and the end time is a lower bound.
    ///
    /// Returns how many were closed, which is worth logging: a number that is
    /// never zero means something is not calling [`Self::provenance_end`].
    pub async fn provenance_close_orphans(&self) -> Result<u64> {
        let res = sqlx::query(
            "UPDATE agent_sessions SET ended_at = updated_at, outcome = 'interrupted'
             WHERE ended_at IS NULL",
        )
        .execute(&self.pool)
        .await?;
        Ok(res.rows_affected())
    }

    /// Sessions overlapping `[from, to)`, newest first.
    ///
    /// Overlap, not "started in the window": an agent left running overnight
    /// belongs in both days' reports, and a report of Tuesday that omitted the
    /// job that ran from Monday evening until Wednesday would be wrong in the
    /// direction that matters. A still-open session (`ended_at IS NULL`)
    /// overlaps anything that has not ended before it started.
    pub async fn provenance_list(
        &self,
        from: i64,
        to: i64,
        limit: i64,
    ) -> Result<Vec<AgentSession>> {
        let sql = format!(
            "SELECT {COLUMNS} FROM agent_sessions
             WHERE started_at < ? AND (ended_at IS NULL OR ended_at >= ?)
             ORDER BY started_at DESC LIMIT ?"
        );
        let rows = sqlx::query(&sql)
            .bind(to)
            .bind(from)
            .bind(limit)
            .fetch_all(&self.pool)
            .await?;
        Ok(rows.iter().map(row_to_session).collect())
    }

    /// One session's status transitions, oldest first.
    pub async fn provenance_history(&self, session_id: &str) -> Result<Vec<StatusChange>> {
        let rows = sqlx::query(
            "SELECT at, status FROM agent_session_status WHERE session_id = ? ORDER BY at ASC",
        )
        .bind(session_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .iter()
            .map(|r| StatusChange { at: r.get("at"), status: r.get("status") })
            .collect())
    }

    /// The sessions in a range with their transition histories attached. Used
    /// by the JSON export, which is the format that carries the timeline; the
    /// UI list and the CSV both take [`Self::provenance_list`] instead so a
    /// long window costs one query rather than one per session.
    pub async fn provenance_list_with_history(
        &self,
        from: i64,
        to: i64,
        limit: i64,
    ) -> Result<Vec<AgentSession>> {
        let mut sessions = self.provenance_list(from, to, limit).await?;
        for s in &mut sessions {
            s.status_history = self.provenance_history(&s.id).await?;
        }
        Ok(sessions)
    }
}

// ─── Export ─────────────────────────────────────────────────────────────────

/// Version stamp on the JSON envelope. Bump it when a field changes meaning, so
/// something reading an archived export can tell which contract it is holding.
pub const EXPORT_VERSION: u32 = 1;

/// Said in the export itself, both formats, because the artifact outlives the
/// conversation that produced it and the reader will not have this file.
const PRIVACY_NOTE: &str = "Records identity, placement, timing and volume for each agent session. \
Prompt text, agent output, file contents and diffs are never recorded; \"prompts\" is a count.";

const COST_NOTE: &str = "Token counts are exact, read from the agent's own session transcript. \
USD is an estimate: transcripts record tokens, not money, and the rates are flock's own table.";

/// Seconds → `2026-08-09T14:03:21Z`. UTC throughout: an export is read by
/// someone in another timezone often enough that a local-time column with no
/// offset is a liability.
pub fn iso8601(secs: i64) -> String {
    chrono::DateTime::from_timestamp(secs, 0)
        .map(|d| d.format("%Y-%m-%dT%H:%M:%SZ").to_string())
        .unwrap_or_default()
}

/// `1h 12m`, `4m 03s`, `12s` — a duration a person reads at a glance, which a
/// raw second count is not. Empty for a session with no end.
fn duration_label(from: i64, to: Option<i64>) -> String {
    let Some(to) = to else { return String::new() };
    let secs = (to - from).max(0);
    let (h, m, s) = (secs / 3600, (secs % 3600) / 60, secs % 60);
    if h > 0 {
        format!("{h}h {m:02}m")
    } else if m > 0 {
        format!("{m}m {s:02}s")
    } else {
        format!("{s}s")
    }
}

/// Quote a CSV field, and defuse it as a spreadsheet formula.
///
/// The leading-quote guard is not decoration. Every text column here is
/// attacker-influenced in the ordinary course of business — a branch name, a
/// repo name, an agent's display name — and a value beginning `=`, `+`, `-` or
/// `@` is executed as a formula when the file is opened in Excel, Numbers or
/// Sheets. This file's whole purpose is to be opened in one of those by
/// somebody in compliance, so a branch called `=HYPERLINK(...)` would be a
/// remote-content fetch (or worse) fired by the act of reviewing us. Prefixing
/// with an apostrophe is the standard defusal; it costs one visible character
/// in the rare cell that trips it. Numbers go through [`csv_num`] instead and
/// are never prefixed.
fn csv_field(value: &str) -> String {
    let dangerous = value
        .chars()
        .next()
        .is_some_and(|c| matches!(c, '=' | '+' | '-' | '@' | '\t' | '\r'));
    let body = if dangerous { format!("'{value}") } else { value.to_string() };
    if body.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", body.replace('"', "\"\""))
    } else {
        body
    }
}

/// A number, written plainly. Kept apart from [`csv_field`] so the formula
/// guard can be unconditional there without an apostrophe ever landing in front
/// of a figure someone wants to sum.
fn csv_num(n: i64) -> String {
    n.to_string()
}

/// The strongest confinement the agent ran under, as one word. The jail
/// subsumes the worktree, and it is the stronger claim — a reviewer asking "was
/// this agent able to touch anything else on the machine" is asking about this
/// field. The CSV keeps the two flags as separate yes/no columns instead, so a
/// spreadsheet can filter on either; this is the summary the JSON carries.
/// Mirrored by `isolationLabel` in `src/lib/provenance.ts` for the on-screen
/// table, which must say the same word as the file.
fn isolation_label(s: &AgentSession) -> &'static str {
    if s.secure {
        "container"
    } else if s.worktree {
        "worktree"
    } else {
        "checkout"
    }
}

fn usd(micros: i64) -> String {
    format!("{:.4}", micros as f64 / 1_000_000.0)
}

/// Header row. Written as words, not column names: the reader of this file is
/// a person deciding whether to let flock into their company, not a script.
const CSV_HEADER: &[&str] = &[
    "Session",
    "Agent",
    "Person",
    "Person ID",
    "Workspace",
    "Repository",
    "Branch",
    "Working directory",
    "Own worktree",
    "Container isolated",
    "Agent tool",
    "Started (UTC)",
    "Ended (UTC)",
    "Duration",
    "Outcome",
    "Prompts",
    "Status changes",
    "Last status",
    "Input tokens",
    "Output tokens",
    "Cache read tokens",
    "Cache write tokens",
    "Total tokens",
    "Estimated cost (USD)",
];

/// One row per session, wide enough to answer a reviewer's questions and narrow
/// enough to read. The status *timeline* is a count here and the full list in
/// the JSON — see [`AgentSession::status_history`].
///
/// `status_changes` is passed in rather than read off the session, because the
/// CSV is built from [`WorkspaceManager::provenance_list`], which deliberately
/// does not load histories.
pub fn to_csv(sessions: &[AgentSession], status_changes: &[i64]) -> String {
    let mut out = String::new();
    out.push_str(&CSV_HEADER.join(","));
    out.push('\n');
    for (i, s) in sessions.iter().enumerate() {
        let changes = status_changes.get(i).copied().unwrap_or(0);
        let cells = [
            csv_field(&s.id),
            csv_field(&s.agent_name),
            csv_field(&s.person_name),
            csv_field(&s.person_id),
            csv_field(&s.workspace_name),
            csv_field(&s.repo_name),
            csv_field(&s.branch),
            csv_field(&s.cwd),
            csv_field(if s.worktree { "yes" } else { "no" }),
            csv_field(if s.secure { "yes" } else { "no" }),
            csv_field(&s.agent_kind),
            csv_field(&iso8601(s.started_at)),
            csv_field(&s.ended_at.map(iso8601).unwrap_or_default()),
            csv_field(&duration_label(s.started_at, s.ended_at)),
            csv_field(&s.outcome),
            csv_num(s.prompts),
            csv_num(changes),
            csv_field(&s.last_status),
            csv_num(s.tokens_input),
            csv_num(s.tokens_output),
            csv_num(s.tokens_cache_read),
            csv_num(s.tokens_cache_write),
            csv_num(s.tokens_total()),
            usd(s.cost_usd_micros),
        ];
        out.push_str(&cells.join(","));
        out.push('\n');
    }
    out
}

/// The JSON export: the same rows, plus each session's status timeline, wrapped
/// in an envelope that states what the file is, what window it covers, and what
/// it does and does not contain. The envelope is the point — a bare array of
/// rows arriving by email is not something a reviewer can take at face value.
pub fn to_json(sessions: &[AgentSession], from: i64, to: i64, generated_at: i64) -> String {
    let totals = Totals::of(sessions);
    // Each session keeps its machine-readable fields (epoch seconds, cost in
    // micros) *and* gains the derived ones a person needs: the timestamps as
    // UTC strings, the duration in words, the token total and the dollars. A
    // JSON export gets read by people too, and `"started_at": 1754700000` is
    // not something anyone should have to convert by hand to check a claim.
    let rows: Vec<serde_json::Value> = sessions
        .iter()
        .map(|s| {
            let mut v = serde_json::to_value(s).unwrap_or_else(|_| serde_json::json!({}));
            if let Some(obj) = v.as_object_mut() {
                obj.insert("started_at_utc".into(), iso8601(s.started_at).into());
                obj.insert(
                    "ended_at_utc".into(),
                    match s.ended_at {
                        Some(e) => iso8601(e).into(),
                        None => serde_json::Value::Null,
                    },
                );
                obj.insert("duration".into(), duration_label(s.started_at, s.ended_at).into());
                obj.insert("isolation".into(), isolation_label(s).into());
                obj.insert("tokens_total".into(), s.tokens_total().into());
                obj.insert(
                    "estimated_cost_usd".into(),
                    (s.cost_usd_micros as f64 / 1_000_000.0).into(),
                );
            }
            v
        })
        .collect();
    let doc = serde_json::json!({
        "format": "flock.provenance",
        "version": EXPORT_VERSION,
        "generated_at": iso8601(generated_at),
        "range": { "from": iso8601(from), "to": iso8601(to) },
        "privacy": PRIVACY_NOTE,
        "cost_basis": COST_NOTE,
        "totals": {
            "sessions": totals.sessions,
            "prompts": totals.prompts,
            "tokens": totals.tokens,
            "estimated_cost_usd": totals.cost_usd_micros as f64 / 1_000_000.0,
        },
        "sessions": rows,
    });
    // Pretty, with a trailing newline: this file is read by humans and diffed
    // by git as often as it is parsed.
    let mut s = serde_json::to_string_pretty(&doc).unwrap_or_else(|_| "{}".into());
    s.push('\n');
    s
}

/// Range totals, for the export envelope and the settings readout.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct Totals {
    pub sessions: i64,
    pub prompts: i64,
    pub tokens: i64,
    pub cost_usd_micros: i64,
}

impl Totals {
    pub fn of(sessions: &[AgentSession]) -> Self {
        let mut t = Totals { sessions: sessions.len() as i64, ..Default::default() };
        for s in sessions {
            t.prompts += s.prompts;
            t.tokens += s.tokens_total();
            t.cost_usd_micros += s.cost_usd_micros;
        }
        t
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn scratch_db(label: &str) -> PathBuf {
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "flock-prov-{}-{}-{}",
            label,
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("flock.db")
    }

    async fn store(label: &str) -> (WorkspaceManager, PathBuf) {
        let path = scratch_db(label);
        let pool = db::init_pool(&path).await.unwrap();
        (WorkspaceManager::new(pool), path)
    }

    fn session(id: &str, started_at: i64) -> AgentSession {
        AgentSession {
            id: id.into(),
            pane_id: format!("pane-{id}"),
            workspace_id: "ws-1".into(),
            workspace_name: "flock".into(),
            agent_name: "Fern".into(),
            agent_kind: "claude".into(),
            person_id: "person-1".into(),
            person_name: "remi".into(),
            repo_id: "git@github.com:acme/flock".into(),
            repo_name: "flock".into(),
            cwd: "/Users/x/git/flock".into(),
            branch: "main".into(),
            worktree: false,
            secure: false,
            transcript_ref: "2f1c6bb5-d843-400e-a86c-70276cd12c33".into(),
            started_at,
            ended_at: None,
            updated_at: started_at,
            outcome: "running".into(),
            prompts: 0,
            last_status: "idle".into(),
            ..Default::default()
        }
    }

    // ─── Store ──────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn a_session_records_its_whole_life() {
        let (wm, path) = store("life").await;
        wm.provenance_begin(&session("s1", 1_000)).await.unwrap();

        wm.provenance_count_prompt("s1", 1_010).await.unwrap();
        wm.provenance_count_prompt("s1", 1_020).await.unwrap();
        wm.provenance_record_status("s1", 1_010, "working").await.unwrap();
        wm.provenance_record_status("s1", 1_040, "idle").await.unwrap();
        wm.provenance_set_tokens(
            "s1",
            SessionTokens { input: 10, output: 20, cache_read: 30, cache_write: 40, cost_usd_micros: 123_456 },
        )
        .await
        .unwrap();
        wm.provenance_end("s1", 1_100, "closed", "done").await.unwrap();

        let rows = wm.provenance_list(0, 10_000, 100).await.unwrap();
        assert_eq!(rows.len(), 1);
        let s = &rows[0];
        assert_eq!(s.prompts, 2);
        assert_eq!(s.ended_at, Some(1_100));
        assert_eq!(s.outcome, "closed");
        assert_eq!(s.last_status, "done");
        assert_eq!(s.tokens_total(), 100);
        assert_eq!(s.cost_usd_micros, 123_456);
        assert_eq!(s.agent_name, "Fern");
        assert_eq!(s.person_name, "remi");
        assert_eq!(s.branch, "main");

        let history = wm.provenance_history("s1").await.unwrap();
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].status, "working");
        assert_eq!(history[1].at, 1_040);

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// The hooks log is tailed on a poll, so a prompt line can arrive after the
    /// pane it belongs to is gone. It must not reopen a closed session's books.
    #[tokio::test]
    async fn a_late_prompt_cannot_reopen_a_closed_session() {
        let (wm, path) = store("late").await;
        wm.provenance_begin(&session("s1", 1_000)).await.unwrap();
        wm.provenance_count_prompt("s1", 1_010).await.unwrap();
        wm.provenance_end("s1", 1_050, "exited", "done").await.unwrap();

        wm.provenance_count_prompt("s1", 1_060).await.unwrap();

        let s = &wm.provenance_list(0, 10_000, 100).await.unwrap()[0];
        assert_eq!(s.prompts, 1, "a prompt after the end must not be counted");
        assert_eq!(s.ended_at, Some(1_050));

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// A resumed pane's row must be able to ask what its predecessors already
    /// recorded from the same transcript, so its own harvest can be a share
    /// rather than a recount of the whole file.
    #[tokio::test]
    async fn banked_tokens_sum_across_a_transcripts_rows() {
        let (wm, path) = store("banked").await;
        wm.provenance_begin(&session("s1", 1_000)).await.unwrap();
        wm.provenance_set_tokens(
            "s1",
            SessionTokens { input: 10, output: 20, cache_read: 30, cache_write: 40, cost_usd_micros: 1_000 },
        )
        .await
        .unwrap();
        wm.provenance_end("s1", 1_100, "interrupted", "working").await.unwrap();
        wm.provenance_begin(&session("s2", 2_000)).await.unwrap();
        wm.provenance_set_tokens(
            "s2",
            SessionTokens { input: 1, output: 2, cache_read: 3, cache_write: 4, cost_usd_micros: 100 },
        )
        .await
        .unwrap();

        let banked =
            wm.provenance_tokens_banked("2f1c6bb5-d843-400e-a86c-70276cd12c33").await.unwrap();
        assert_eq!(banked.input, 11);
        assert_eq!(banked.output, 22);
        assert_eq!(banked.cache_read, 33);
        assert_eq!(banked.cache_write, 44);
        assert_eq!(banked.cost_usd_micros, 1_100);

        let none = wm.provenance_tokens_banked("no-such-transcript").await.unwrap();
        assert_eq!(none.input + none.output + none.cost_usd_micros, 0);

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// The pty output loop keeps draining to EOF after `close_pane` has ended
    /// the row, so a final detected transition can land after the close. It
    /// must not extend the timeline past `ended_at` or overwrite the closed
    /// row's final status.
    #[tokio::test]
    async fn a_late_status_cannot_touch_a_closed_session() {
        let (wm, path) = store("late-status").await;
        wm.provenance_begin(&session("s1", 1_000)).await.unwrap();
        wm.provenance_record_status("s1", 1_020, "working").await.unwrap();
        wm.provenance_end("s1", 1_050, "closed", "working").await.unwrap();

        wm.provenance_record_status("s1", 1_060, "idle").await.unwrap();

        let s = &wm.provenance_list(0, 10_000, 100).await.unwrap()[0];
        assert_eq!(s.last_status, "working", "a status after the end must not overwrite the close");
        assert_eq!(s.updated_at, 1_050, "a status after the end must not push updated_at past ended_at");
        let history = wm.provenance_history("s1").await.unwrap();
        assert!(
            history.iter().all(|c| c.at <= 1_050),
            "the timeline must not extend past ended_at"
        );

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// `close_pane` and the pty exit loop both fire, in either order. The first
    /// one is the truth; the second must not overwrite the end time.
    #[tokio::test]
    async fn ending_twice_keeps_the_first_ending() {
        let (wm, path) = store("twice").await;
        wm.provenance_begin(&session("s1", 1_000)).await.unwrap();
        wm.provenance_end("s1", 1_050, "closed", "done").await.unwrap();
        wm.provenance_end("s1", 1_090, "exited", "failed").await.unwrap();

        let s = &wm.provenance_list(0, 10_000, 100).await.unwrap()[0];
        assert_eq!(s.ended_at, Some(1_050));
        assert_eq!(s.outcome, "closed");

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// A force-quit leaves the row open. The next launch must give it an end
    /// time it can defend — the last thing it saw — not "now", which would make
    /// a three-minute agent from March export as months of runtime.
    #[tokio::test]
    async fn a_crash_leaves_a_session_closed_at_its_last_activity() {
        let (wm, path) = store("orphan").await;
        wm.provenance_begin(&session("s1", 1_000)).await.unwrap();
        wm.provenance_record_status("s1", 1_200, "working").await.unwrap();
        wm.provenance_begin(&session("s2", 2_000)).await.unwrap();
        wm.provenance_end("s2", 2_500, "closed", "done").await.unwrap();

        assert_eq!(wm.provenance_close_orphans().await.unwrap(), 1);

        let rows = wm.provenance_list(0, 10_000, 100).await.unwrap();
        let s1 = rows.iter().find(|r| r.id == "s1").unwrap();
        assert_eq!(s1.ended_at, Some(1_200), "closed at its last recorded activity");
        assert_eq!(s1.outcome, "interrupted");
        // An already-closed session is left exactly as it was.
        let s2 = rows.iter().find(|r| r.id == "s2").unwrap();
        assert_eq!(s2.outcome, "closed");

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// A session spanning the window belongs in it. Reporting only sessions
    /// that *started* inside the range would drop the overnight job, which is
    /// exactly the one a reviewer asks about.
    #[tokio::test]
    async fn the_range_selects_by_overlap_not_by_start() {
        let (wm, path) = store("range").await;

        let mut before = session("before", 100);
        before.ended_at = Some(200);
        wm.provenance_begin(&before).await.unwrap();
        wm.provenance_end("before", 200, "closed", "done").await.unwrap();

        wm.provenance_begin(&session("spanning", 500)).await.unwrap();
        wm.provenance_end("spanning", 2_500, "closed", "done").await.unwrap();

        wm.provenance_begin(&session("inside", 1_500)).await.unwrap();
        wm.provenance_end("inside", 1_600, "closed", "done").await.unwrap();

        wm.provenance_begin(&session("still-open", 1_900)).await.unwrap();

        let ids: Vec<String> = wm
            .provenance_list(1_000, 2_000, 100)
            .await
            .unwrap()
            .into_iter()
            .map(|s| s.id)
            .collect();
        assert!(!ids.contains(&"before".to_string()));
        assert!(ids.contains(&"spanning".to_string()));
        assert!(ids.contains(&"inside".to_string()));
        assert!(ids.contains(&"still-open".to_string()));
        // Newest first.
        assert_eq!(ids.first().map(String::as_str), Some("still-open"));

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// Deleting a workspace erases its state everywhere else in this database.
    /// It must not erase the record that its agents ran.
    #[tokio::test]
    async fn deleting_a_workspace_leaves_its_sessions_behind() {
        let (wm, path) = store("survive").await;
        let ws = wm.create("flock", "/tmp/repo", "main").await.unwrap();
        let mut s = session("s1", 1_000);
        s.workspace_id = ws.id.0.clone();
        wm.provenance_begin(&s).await.unwrap();

        wm.delete(&ws.id).await.unwrap();

        let rows = wm.provenance_list(0, 10_000, 100).await.unwrap();
        assert_eq!(rows.len(), 1, "the audit row outlives the workspace");
        assert_eq!(rows[0].workspace_name, "flock", "and stays legible without it");

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[tokio::test]
    async fn histories_come_back_attached_for_the_json_export() {
        let (wm, path) = store("hist").await;
        wm.provenance_begin(&session("s1", 1_000)).await.unwrap();
        wm.provenance_record_status("s1", 1_010, "working").await.unwrap();
        wm.provenance_record_status("s1", 1_020, "awaiting_input").await.unwrap();

        let rows = wm.provenance_list_with_history(0, 10_000, 100).await.unwrap();
        assert_eq!(rows[0].status_history.len(), 2);
        assert_eq!(rows[0].status_history[1].status, "awaiting_input");

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    // ─── Export formatting ──────────────────────────────────────────────────

    fn finished(id: &str, start: i64, end: i64) -> AgentSession {
        let mut s = session(id, start);
        s.ended_at = Some(end);
        s.outcome = "closed".into();
        s.last_status = "done".into();
        s.prompts = 3;
        s.tokens_input = 1_000;
        s.tokens_output = 2_000;
        s.tokens_cache_read = 3_000;
        s.tokens_cache_write = 4_000;
        s.cost_usd_micros = 1_234_567;
        s
    }

    #[test]
    fn the_csv_header_and_row_line_up() {
        let csv = to_csv(&[finished("s1", 1_700_000_000, 1_700_003_723)], &[4]);
        let mut lines = csv.lines();
        let header: Vec<&str> = lines.next().unwrap().split(',').collect();
        assert_eq!(header.len(), CSV_HEADER.len());
        assert_eq!(header[0], "Session");
        assert_eq!(header[header.len() - 1], "Estimated cost (USD)");

        let row: Vec<&str> = lines.next().unwrap().split(',').collect();
        assert_eq!(row.len(), CSV_HEADER.len(), "every column gets a cell");
        assert_eq!(row[1], "Fern");
        assert_eq!(row[11], "2023-11-14T22:13:20Z");
        assert_eq!(row[13], "1h 02m");
        assert_eq!(row[15], "3", "prompts");
        assert_eq!(row[16], "4", "status changes");
        assert_eq!(row[22], "10000", "total tokens");
        assert_eq!(row[23], "1.2346", "estimated cost");
        assert!(lines.next().is_none());
    }

    /// A branch called `=HYPERLINK(...)` is a formula the moment this file is
    /// opened in Excel — and being opened in Excel by somebody in compliance is
    /// the entire purpose of the file.
    #[test]
    fn a_formula_in_a_branch_name_is_defused() {
        let mut s = finished("s1", 0, 10);
        s.branch = "=HYPERLINK(\"http://evil\",\"click\")".into();
        s.agent_name = "@SUM(A1:A9)".into();
        s.workspace_name = "plain, with a comma".into();

        let csv = to_csv(&[s], &[0]);
        let row = csv.lines().nth(1).unwrap();
        assert!(row.contains("\"'=HYPERLINK(\"\"http://evil\"\",\"\"click\"\")\""));
        assert!(row.contains("'@SUM(A1:A9)"));
        assert!(row.contains("\"plain, with a comma\""));
        // Numbers are never prefixed — a leading apostrophe would stop the
        // column summing, which is the one thing a finance reader does with it.
        assert!(row.ends_with(",1.2346"));
    }

    /// A newline in a field must not become a new record.
    #[test]
    fn a_newline_in_a_field_stays_inside_its_row() {
        let mut s = finished("s1", 0, 10);
        s.agent_name = "two\nlines".into();
        let csv = to_csv(&[s], &[0]);
        assert_eq!(csv.lines().count(), 3, "header + one wrapped row");
        assert!(csv.contains("\"two\nlines\""));
    }

    #[test]
    fn an_open_session_exports_with_no_end_and_no_duration() {
        let csv = to_csv(&[session("s1", 1_700_000_000)], &[1]);
        let row: Vec<&str> = csv.lines().nth(1).unwrap().split(',').collect();
        assert_eq!(row[12], "", "no end time");
        assert_eq!(row[13], "", "no duration");
        assert_eq!(row[14], "running");
    }

    #[test]
    fn an_empty_range_still_exports_a_header() {
        let csv = to_csv(&[], &[]);
        assert_eq!(csv.lines().count(), 1);
        assert!(csv.starts_with("Session,Agent,"));
    }

    #[test]
    fn the_json_envelope_says_what_the_file_is() {
        let mut s = finished("s1", 1_700_000_000, 1_700_003_723);
        s.status_history = vec![
            StatusChange { at: 1_700_000_010, status: "working".into() },
            StatusChange { at: 1_700_003_700, status: "idle".into() },
        ];
        let json = to_json(&[s], 1_699_000_000, 1_701_000_000, 1_701_000_001);
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();

        assert_eq!(v["format"], "flock.provenance");
        assert_eq!(v["version"], EXPORT_VERSION);
        assert_eq!(v["range"]["from"], "2023-11-03T08:26:40Z");
        assert_eq!(v["generated_at"], "2023-11-26T12:00:01Z");
        // The two claims the artifact has to carry on its own.
        assert!(v["privacy"].as_str().unwrap().contains("never recorded"));
        assert!(v["cost_basis"].as_str().unwrap().contains("estimate"));

        assert_eq!(v["totals"]["sessions"], 1);
        assert_eq!(v["totals"]["prompts"], 3);
        assert_eq!(v["totals"]["tokens"], 10_000);
        assert_eq!(v["totals"]["estimated_cost_usd"], 1.234567);

        // The timeline the CSV only counts.
        assert_eq!(v["sessions"][0]["status_history"].as_array().unwrap().len(), 2);
        assert_eq!(v["sessions"][0]["status_history"][0]["status"], "working");
        assert_eq!(v["sessions"][0]["agent_name"], "Fern");
        // Machine-readable and human-readable, side by side: a JSON export is
        // read by people too, and an epoch integer is not something anyone
        // should have to convert by hand to check a claim.
        assert_eq!(v["sessions"][0]["started_at"], 1_700_000_000_i64);
        assert_eq!(v["sessions"][0]["started_at_utc"], "2023-11-14T22:13:20Z");
        assert_eq!(v["sessions"][0]["duration"], "1h 02m");
        assert_eq!(v["sessions"][0]["tokens_total"], 10_000);
        assert_eq!(v["sessions"][0]["estimated_cost_usd"], 1.234567);
        assert_eq!(v["sessions"][0]["isolation"], "checkout");
        // Nothing resembling prompt text is in the shape at all.
        assert!(v["sessions"][0].get("prompt_text").is_none());
        assert!(json.ends_with("\n"));
    }

    /// The one word a reviewer reads first. The jail subsumes the worktree.
    #[test]
    fn the_json_names_the_strongest_confinement() {
        let mut s = finished("s1", 0, 10);
        s.worktree = true;
        assert_eq!(isolation_label(&s), "worktree");
        s.secure = true;
        assert_eq!(isolation_label(&s), "container");
        s.secure = false;
        s.worktree = false;
        assert_eq!(isolation_label(&s), "checkout");
    }

    /// A session with no end must not acquire one in the JSON either.
    #[test]
    fn an_open_session_has_a_null_end_in_the_json() {
        let json = to_json(&[session("s1", 1_700_000_000)], 0, i64::MAX, 0);
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert!(v["sessions"][0]["ended_at_utc"].is_null());
        assert_eq!(v["sessions"][0]["duration"], "");
        assert_eq!(v["sessions"][0]["outcome"], "running");
    }

    #[test]
    fn durations_read_as_words() {
        assert_eq!(duration_label(0, Some(9)), "9s");
        assert_eq!(duration_label(0, Some(63)), "1m 03s");
        assert_eq!(duration_label(0, Some(3_723)), "1h 02m");
        assert_eq!(duration_label(100, None), "");
        // Clocks move backwards (NTP, sleep). A negative duration is never
        // printed as one.
        assert_eq!(duration_label(100, Some(50)), "0s");
    }
}
