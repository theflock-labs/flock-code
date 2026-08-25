//! Knowledge graph client for flock.
//!
//! The graph is knowledge-first: every node is something a teammate's agent
//! would want to read later — a Decision (with rationale), an Attempt (what
//! was tried and how it went), a Note or Interface (facts, conventions,
//! contracts), or a File anchor that knowledge attaches to. Provenance (who
//! wrote it, which workspace, when) is metadata on the node, not graph
//! structure, so the graph itself stays pure signal.
//!
//! Three behaviors keep it healthy over time, borrowed from the best
//! personal-knowledge tools:
//! - One note per title: writing a label that already exists *updates* that
//!   node in place instead of piling up duplicates.
//! - Wikilinks: `[[some other note]]` inside any body auto-resolves to a
//!   RELATES_TO edge, so linking costs nothing.
//! - Corrections: SUPERSEDES hides replaced knowledge, and `forget` archives
//!   knowledge that turned out to be wrong — every read filters both.
//!
//! Search is hybrid: Postgres full-text (with keyword-OR and ILIKE fallbacks)
//! reciprocal-rank-fused with pgvector cosine neighbors over local bge-small
//! embeddings (see [`embed`]). The semantic leg is strictly additive — while
//! the embedder is cold, failed, or the engine predates the vector DDL, every
//! search path behaves as pure FTS.

pub mod embed;

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use uuid::Uuid;

/// Sentinel `workspace_id` for nodes that apply across every workspace —
/// durable cross-cutting facts (design principles, naming conventions, stack
/// choices) rather than in-flight decisions tied to one branch. Queries that
/// scope to a workspace also include this sentinel so global knowledge always
/// surfaces alongside workspace-local knowledge.
pub const GLOBAL_SCOPE: &str = "global";

/// Canonical edge vocabulary — five edges, all drawn automatically:
///
///   ABOUT       knowledge → File       the code it concerns (`files` param)
///   RELATES_TO  knowledge ↔ knowledge  associations (`relates_to` param and
///                                      `[[wikilinks]]` inside body text)
///   SUPERSEDES  knowledge → knowledge  newer replaces older; the old one
///                                      stops surfacing in every default read
///   AUTHORED_BY knowledge → Person     who recorded it (from FLOCK_PERSON_ID)
///   IN_REPO     knowledge/File → Repo  the codebase it belongs to
///
/// AUTHORED_BY and IN_REPO are the provenance spine: every knowledge write
/// attaches both automatically, so nothing lands isolated — the invariant is
/// that a knowledge node always has at least these two associations (author +
/// repo), on top of any files/relates_to. Provenance used to be plain columns
/// (who/where as scalars), which left knowledge with no files or wikilinks
/// stranded with zero edges; materializing author and repo as hub nodes is what
/// makes those hubs the connective tissue of the graph.
pub const EDGE_VOCABULARY: [&str; 5] =
    ["ABOUT", "RELATES_TO", "SUPERSEDES", "AUTHORED_BY", "IN_REPO"];

/// Node kinds that carry recorded knowledge (File nodes are anchors, not
/// knowledge). Reads that answer "what do we know" filter to these.
const KNOWLEDGE_KINDS: [&str; 4] = ["Decision", "Attempt", "Note", "Interface"];

// ─── Public types ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KgNode {
    pub id: Uuid,
    pub kind: NodeKind,
    pub label: String,
    pub body: Option<String>,
    pub workspace_id: Option<String>,
    pub created_by_agent: Option<String>,
    pub created_at: DateTime<Utc>,
    /// Last content edit (title-upsert bumps this; creation initializes it).
    pub updated_at: DateTime<Utc>,
    /// Set by `forget` — archived knowledge is hidden from every read.
    pub archived_at: Option<DateTime<Utc>>,
    /// Attempt outcome ("success" | "failure" | "partial"); None for other kinds.
    pub outcome: Option<String>,
    /// For a Decision: the shipped artifact (PR title · url) that realized it,
    /// stamped when a merged PR touches the decision's files.
    pub shipped_in: Option<String>,
}

/// What class of graph interaction an event records. `Ground` is the
/// UserPromptSubmit grounding pass; its `fact_ids` are what every recall
/// figure is computed from. Its `grounding_hits` column is retained for old
/// rows and written for symmetry, but nothing reports it any more — summed
/// over a lifetime it only ever rose, including through the releases where the
/// graph had stopped recording anything (see [`RecallStats`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventKind {
    Read,
    Write,
    Ground,
    /// An agent turn ended. The denominator for write-compliance: writes and
    /// grounds per turn tell you whether the graph is actually being fed.
    Turn,
}

impl EventKind {
    pub fn as_str(self) -> &'static str {
        match self {
            EventKind::Read => "read",
            EventKind::Write => "write",
            EventKind::Ground => "ground",
            EventKind::Turn => "turn",
        }
    }
}

/// One telemetry row for `log_event`. Construct via [`EventReq::new`] so `ok`
/// defaults to true; set the optional counts as they're known.
#[derive(Debug, Clone)]
pub struct EventReq {
    pub operation: String,
    pub kind: EventKind,
    pub workspace_id: Option<String>,
    pub agent_id: Option<String>,
    /// Persistent person identity (flock ID), the phase-4 attribution spine.
    pub person_id: Option<String>,
    /// Tenancy (phase 4): the person's active org and team, when they belong to one.
    pub org_id: Option<String>,
    pub team_id: Option<String>,
    pub node_count: Option<i32>,
    pub grounding_hits: Option<i32>,
    /// Ground events only: the nodes this pass actually put in front of the
    /// agent, in the order it saw them. `grounding_hits` is this list's length
    /// — the count alone could only ever say *that* recall happened, never
    /// *what* was recalled, which is the difference between a number nobody can
    /// check and a claim a person can read back against their own graph.
    /// Stored as ids, not text: the node is the record, and it may since have
    /// been edited, superseded or forgotten — a reader deserves the current
    /// state of the thing that was quoted at them, not a stale copy.
    pub fact_ids: Vec<Uuid>,
    pub latency_ms: Option<i32>,
    pub ok: bool,
    pub error: Option<String>,
}

/// One account-spend sample for `record_usage_snapshot`. Amounts are in the
/// currency's minor unit (cents) with `exponent` decimals, matching the
/// provider usage endpoints the desktop app already fetches.
#[derive(Debug, Clone)]
pub struct UsageSnapshot {
    pub source: String,
    pub used_minor: i64,
    pub limit_minor: Option<i64>,
    pub currency: String,
    pub exponent: i32,
}

/// An outcome a team ships, for `record_outcome`. `kind` is "merged_pr" or
/// "closed_task"; `ref_id` is the PR url/number or task id (the idempotency
/// key alongside kind).
#[derive(Debug, Clone)]
pub struct OutcomeReq {
    pub workspace_id: Option<String>,
    pub kind: String,
    pub ref_id: String,
    pub title: Option<String>,
    /// Files the shipped change touched. Each live Decision recorded ABOUT one
    /// of these gets its `shipped_in` stamped — the decision→shipped feedback
    /// loop: reading a decision shows whether it actually made it into a
    /// merged PR.
    pub files: Vec<String>,
}

/// What recall did over a trailing window, in the only terms that can fall
/// when the graph stops working.
///
/// This exists because `sum(grounding_hits)` did not. That number counted
/// bullet lines the hook printed, lifetime, so it could only ever rise — it
/// rose right through the release in which the write half of the graph was
/// dead on every relaunch, and a stress run scored 300 of it against a
/// three-node graph and one repeated prompt. Every field here is windowed, and
/// `facts_recalled` / `knowledge_total` falls the moment recall stops or the
/// graph grows without being read.
///
/// What none of it proves: that grounding changed an agent's *output*. These
/// count what was retrieved and put in front of a model. Whether the model read
/// it, and whether the answer was better for it, needs an A/B against the same
/// prompts with grounding off. **We have not run one.** Any surface that shows
/// these numbers has to say so.
#[derive(Debug, Clone, Default, Serialize)]
pub struct RecallStats {
    /// Grounding passes in the window that can name what they surfaced
    /// (`fact_ids IS NOT NULL`). The denominator for everything below.
    pub ground_passes: i64,
    /// Of those, the ones that surfaced at least one fact.
    pub passes_with_facts: i64,
    /// Of those, the ones that surfaced nothing. Kept as its own field rather
    /// than left as a subtraction, because it is the number every version of
    /// this readout has omitted, and omitting it is what made an idle graph
    /// look busy.
    pub silent_passes: i64,
    /// Facts injected across the window (`sum(cardinality(fact_ids))`). Volume,
    /// not value: the same three facts fed to a hundred prompts is 300 here.
    /// Honest only because it is windowed and labelled as injections.
    pub facts_injected: i64,
    /// Distinct *live* knowledge nodes injected at least once in the window —
    /// the numerator of coverage. Restricted to nodes that still exist, are not
    /// archived, and are in scope, so coverage can never exceed 100%.
    pub facts_recalled: i64,
    /// Live knowledge nodes in scope right now (Decision/Attempt/Note/
    /// Interface). The denominator of coverage: the graph as recorded, whether
    /// or not anything ever reads it.
    pub knowledge_total: i64,
    /// Ground passes in the window predating the `fact_ids` column. Their hit
    /// count is real and their contents are gone, so they are excluded from
    /// every figure above and reported separately — folding them in either way
    /// would be a guess presented as a measurement.
    pub passes_unrecorded: i64,
}

/// The phase-3 headline numbers over a trailing window.
///
/// `grounding_hits` (lifetime bullets injected, shown as "rediscoveries
/// avoided") was removed from here rather than relabelled: see [`RecallStats`],
/// which replaces it with figures that can go down. Cost-per-outcome was
/// removed from the graph surfaces for the same reason — `cost_minor` is
/// whole-account model spend and `outcomes` is merged PRs, so their ratio moves
/// when you use Claude outside flock and when you merge a typo fix, and is not
/// attributable to the graph in either direction. Both fields stay here because
/// they are honest counts of their own subject.
#[derive(Debug, Clone, Serialize)]
pub struct InsightsSummary {
    pub since: DateTime<Utc>,
    pub recall: RecallStats,
    pub reads: i64,
    pub writes: i64,
    pub outcomes: i64,
    pub cost_minor: i64,
    pub currency: String,
    pub exponent: i32,
}

impl EventReq {
    pub fn new(operation: impl Into<String>, kind: EventKind) -> Self {
        Self {
            operation: operation.into(),
            kind,
            workspace_id: None,
            agent_id: None,
            person_id: None,
            org_id: None,
            team_id: None,
            node_count: None,
            grounding_hits: None,
            fact_ids: Vec::new(),
            latency_ms: None,
            ok: true,
            error: None,
        }
    }
}

/// One fact a grounding pass put in front of an agent, resolved back to the
/// node's *current* state. `archived` / `superseded` are why this is a join
/// rather than stored text: a fact that has since been retracted is the most
/// interesting row in the list, and it can only be spotted by re-reading the
/// node.
#[derive(Debug, Clone, Serialize)]
pub struct GroundedFact {
    pub id: Uuid,
    pub kind: String,
    pub label: String,
    pub body: Option<String>,
    pub archived: bool,
    pub superseded: bool,
}

/// One grounding pass, as a person would read it: when it fired, which agent
/// it fed, and exactly what it injected. Passes that surfaced nothing are kept
/// — a run of empty passes is the honest shape of a graph with nothing to say
/// yet, and hiding them would make an idle graph look like a busy one.
#[derive(Debug, Clone, Serialize)]
pub struct GroundingPass {
    pub ts: DateTime<Utc>,
    pub workspace_id: Option<String>,
    pub agent_id: Option<String>,
    pub facts: Vec<GroundedFact>,
}

/// The grounding block for one prompt, plus the ids behind it. The text is
/// what the agent reads; the ids are what makes the same pass reviewable
/// afterwards by a person who wants to know whether the recall was any good.
#[derive(Debug, Clone, Default)]
pub struct ContextPack {
    pub text: String,
    pub fact_ids: Vec<Uuid>,
}

/// How often each fact has been recalled over a window, most-recalled first.
/// The one thing in the graph that is about *value* rather than volume: a note
/// nothing ever retrieves is costing storage and review attention and giving
/// nothing back, and until this existed there was no way to tell it apart from
/// the note that answers a question every day.
#[derive(Debug, Clone, Serialize)]
pub struct RecallCount {
    pub id: Uuid,
    pub kind: String,
    pub label: String,
    pub recalls: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub enum NodeKind {
    /// A settled choice with rationale and rejected alternatives.
    Decision,
    /// Something that was tried, with its outcome — especially failures.
    Attempt,
    /// Free-form knowledge: a fact, convention, gotcha, or invariant.
    Note,
    /// A remembered API/type contract.
    Interface,
    /// A file-path anchor knowledge attaches to (via ABOUT edges).
    File,
    /// A person anchor — the author knowledge attaches to (via AUTHORED_BY).
    /// A connective hub, not knowledge: it never answers "what do we know".
    Person,
    /// A codebase anchor — the repo knowledge and files attach to (via
    /// IN_REPO). Like File and Person, a hub rather than knowledge.
    Repo,
}

impl NodeKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Decision => "Decision",
            Self::Attempt => "Attempt",
            Self::Note => "Note",
            Self::Interface => "Interface",
            Self::File => "File",
            Self::Person => "Person",
            Self::Repo => "Repo",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "Decision" => Self::Decision,
            "Attempt" => Self::Attempt,
            "Interface" => Self::Interface,
            "File" => Self::File,
            "Person" => Self::Person,
            "Repo" => Self::Repo,
            _ => Self::Note,
        }
    }
}

/// The author + codebase a knowledge write attaches to. Both become hub nodes
/// (Person, Repo) and edges (AUTHORED_BY, IN_REPO), so every write lands with at
/// least these two associations even when it names no files or relations. Built
/// from each request's injected identity fields; empty parts are simply skipped.
#[derive(Default)]
pub(crate) struct Provenance {
    pub person_id: Option<String>,
    pub person_name: Option<String>,
    pub repo_key: Option<String>,
    pub repo_name: Option<String>,
}

// ─── Request types ────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct WriteDecisionReq {
    pub label: String,
    pub body: String,
    pub workspace_id: Option<String>,
    pub agent_id: Option<String>,
    /// Tenant tag (phase 4), injected by the MCP identity defaults from the
    /// agent's org/team env. None in single-tenant / pre-org use.
    pub org_id: Option<String>,
    pub team_id: Option<String>,
    /// Provenance spine (injected by the MCP identity defaults): the author and
    /// codebase this write is auto-linked to (AUTHORED_BY / IN_REPO), so every
    /// knowledge node lands with ≥2 associations. None only in a no-identity /
    /// detached context.
    pub person_id: Option<String>,
    pub person_name: Option<String>,
    pub repo_key: Option<String>,
    pub repo_name: Option<String>,
    /// UUID or label fragment of the decision this one replaces.
    pub supersedes: Option<String>,
    /// File paths this decision governs → ABOUT edges (File nodes upserted).
    #[serde(default)]
    pub files: Vec<String>,
    /// Labels (fragments) of existing nodes this connects to → RELATES_TO.
    #[serde(default)]
    pub relates_to: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct RecordAttemptReq {
    pub label: String,
    pub outcome: AttemptOutcome,
    pub notes: Option<String>,
    pub workspace_id: Option<String>,
    pub agent_id: Option<String>,
    /// Tenant tag (phase 4), injected by the MCP identity defaults.
    pub org_id: Option<String>,
    pub team_id: Option<String>,
    /// Provenance spine (author + codebase), injected by the MCP identity
    /// defaults → AUTHORED_BY / IN_REPO. See [`WriteDecisionReq`].
    pub person_id: Option<String>,
    pub person_name: Option<String>,
    pub repo_key: Option<String>,
    pub repo_name: Option<String>,
    /// File paths involved in the attempt → ABOUT edges.
    #[serde(default)]
    pub files: Vec<String>,
    /// Labels of related nodes (e.g. the Decision being attempted) → RELATES_TO.
    #[serde(default)]
    pub relates_to: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AttemptOutcome {
    Success,
    Failure,
    Partial,
}

impl AttemptOutcome {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Success => "success",
            Self::Failure => "failure",
            Self::Partial => "partial",
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct QueryReq {
    pub query: String,
    pub limit: Option<i64>,
    pub kind: Option<String>,
    /// Injected by the MCP identity defaults; results are scoped to this
    /// workspace + global + unscoped nodes unless `scope` is "all".
    pub workspace_id: Option<String>,
    pub scope: Option<String>,
    /// Superseded decisions are hidden by default — stale choices resurfacing
    /// as if current was a top source of graph noise.
    #[serde(default)]
    pub include_superseded: bool,
}

#[derive(Debug, Deserialize)]
pub struct AboutFileReq {
    pub file_path: String,
}

#[derive(Debug, Deserialize)]
pub struct RelatedReq {
    pub node_id: Uuid,
    pub edge_type: Option<String>,
    pub depth: Option<i32>,
}

#[derive(Debug, Deserialize)]
pub struct RememberReq {
    pub label: String,
    pub body: String,
    /// Node kind for this memory. Defaults to "Note"; may be "Interface" for
    /// an API contract.
    pub kind: Option<String>,
    pub workspace_id: Option<String>,
    pub agent_id: Option<String>,
    /// Tenant tag (phase 4), injected by the MCP identity defaults.
    pub org_id: Option<String>,
    pub team_id: Option<String>,
    /// Provenance spine (author + codebase), injected by the MCP identity
    /// defaults → AUTHORED_BY / IN_REPO. See [`WriteDecisionReq`].
    pub person_id: Option<String>,
    pub person_name: Option<String>,
    pub repo_key: Option<String>,
    pub repo_name: Option<String>,
    /// File paths this knowledge concerns → ABOUT edges.
    #[serde(default)]
    pub files: Vec<String>,
    /// Labels of related nodes → RELATES_TO.
    #[serde(default)]
    pub relates_to: Vec<String>,
    /// UUID or label fragment of an earlier note/interface this corrects; the
    /// old one stops surfacing (SUPERSEDES). The correction path for knowledge
    /// that isn't a Decision.
    pub supersedes: Option<String>,
}

/// Archive knowledge that turned out to be wrong or obsolete — the retraction
/// path when there is no replacement to supersede it with.
#[derive(Debug, Deserialize)]
pub struct ForgetReq {
    /// UUID or label fragment of the node to archive.
    #[serde(alias = "ref")]
    pub reference: String,
    /// Why it's being forgotten — appended to the archived body for the audit
    /// trail (archived nodes stay in the database, just hidden from reads).
    pub reason: Option<String>,
}

/// A node worth compacting, with enough of its text to summarize from.
///
/// Handed to an agent rather than to a summarization API. flock already has
/// models running in every pane, so the thing that would otherwise need an
/// API key, a billing relationship and a hard dependency on one vendor is
/// instead a tool call the agent already has.
#[derive(Debug, Clone, Serialize)]
pub struct CompactionCandidate {
    pub id: Uuid,
    pub kind: String,
    pub label: String,
    pub body: String,
    /// How long the body is now — the saving on offer.
    pub bytes: i32,
    /// Last content edit. Age is most of why a node is a candidate.
    pub updated_at: DateTime<Utc>,
}

/// Replace a node's body with a summary, keeping the original.
#[derive(Debug, Deserialize)]
pub struct CompactReq {
    /// UUID or label fragment of the node to compact.
    #[serde(alias = "ref")]
    pub reference: String,
    /// The summary to store in place of the current body.
    pub summary: String,
}

/// What a compaction did, so the caller can report it honestly.
#[derive(Debug, Clone, Serialize)]
pub struct CompactResult {
    pub label: String,
    pub level: i32,
    pub before_bytes: i32,
    pub after_bytes: i32,
}

// ─── Export / import wire rows ────────────────────────────────────────────────
//
// One struct per exported table, used for both directions so the writer and the
// reader cannot disagree about a column name. Deliberately separate from
// [`KgNode`]: that type is the read model the tools return (kind as an enum,
// no tenancy, no compaction bookkeeping), and a backup has to carry the columns
// verbatim rather than whatever the UI happens to need.

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct ExportNode {
    pub id: Uuid,
    pub kind: String,
    pub label: String,
    pub body: Option<String>,
    pub workspace_id: Option<String>,
    pub created_by_agent: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub archived_at: Option<DateTime<Utc>>,
    pub outcome: Option<String>,
    pub shipped_in: Option<String>,
    pub org_id: Option<String>,
    pub team_id: Option<String>,
    pub anchor_key: Option<String>,
    pub compaction_level: i32,
    pub compacted_at: Option<DateTime<Utc>>,
    pub original_bytes: Option<i32>,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct ExportSnapshot {
    pub id: Uuid,
    pub node_id: Uuid,
    pub compaction_level: i32,
    pub label: String,
    pub body: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct ExportEdge {
    pub id: Uuid,
    pub from_node_id: Uuid,
    pub to_node_id: Uuid,
    pub edge_type: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct ExportStats {
    pub nodes: u64,
    pub snapshots: u64,
    pub edges: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct ImportStats {
    pub nodes: u64,
    pub snapshots: u64,
    pub edges: u64,
    /// Rows already present, left untouched.
    pub existing: u64,
    /// Lines that could not be read or inserted. Counted rather than fatal: a
    /// backup that is 99% readable should restore 99%.
    pub skipped: u64,
}

#[derive(Debug, Deserialize)]
pub struct LinkReq {
    pub from_node_id: Uuid,
    pub to_node_id: Uuid,
    pub edge_type: String,
}

/// kg.link by UUID *or* label fragment — requiring two UUIDs was the reason
/// agents never drew associations by hand.
#[derive(Debug, Deserialize)]
pub struct LinkByRefReq {
    pub from: String,
    pub to: String,
    pub edge_type: String,
}

/// The result of a knowledge write: the node, and whether an existing node
/// with the same title was updated in place (vs. a new one created).
#[derive(Debug, Clone, Serialize)]
pub struct Written {
    pub node: KgNode,
    pub updated: bool,
}

// ─── Knowledge graph client ───────────────────────────────────────────────────

#[derive(Clone)]
pub struct KnowledgeGraph {
    pool: PgPool,
}

/// The SELECT list every node read shares — kept in one place so adding a
/// column can't silently miss a query.
const NODE_COLS: &str =
    "id, kind, label, body, workspace_id, created_by_agent, created_at, updated_at, archived_at, outcome, shipped_in";

impl KnowledgeGraph {
    pub async fn connect(url: &str) -> Result<Self> {
        let pool = PgPoolOptions::new()
            .max_connections(8)
            .connect(url)
            .await?;
        let kg = Self { pool };
        kg.init_embeddings();
        Ok(kg)
    }

    /// Like `connect`, but doesn't require the database to be up yet —
    /// connections are established on first use. Lets the MCP server start
    /// (and answer initialize/tools-list) before the graph engine is
    /// running, turning a fatal boot error into a clear per-call one.
    /// The short acquire timeout matters: with the engine down, a tool call
    /// should fail with guidance in ~3s, not hang for sqlx's 30s default.
    pub fn connect_lazy(url: &str) -> Result<Self> {
        let pool = PgPoolOptions::new()
            .max_connections(8)
            .acquire_timeout(std::time::Duration::from_secs(3))
            .connect_lazy(url)?;
        let kg = Self { pool };
        kg.init_embeddings();
        Ok(kg)
    }

    /// Kick off the background embedder warm and — once per process, and only
    /// when a Tokio runtime exists to host it — the embedding backfill task.
    /// Both are fire-and-forget: nothing here blocks construction, and a
    /// process with no runtime (or one that exits early, like the one-shot
    /// `ground` hook) just skips the backfill.
    fn init_embeddings(&self) {
        embed::warm();
        use std::sync::atomic::{AtomicBool, Ordering};
        static BACKFILL_SPAWNED: AtomicBool = AtomicBool::new(false);
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            if !BACKFILL_SPAWNED.swap(true, Ordering::SeqCst) {
                handle.spawn(backfill_embeddings(self.pool.clone()));
            }
        }
    }

    /// Best-effort, off the write path: embed `label + "\n" + body` and store
    /// it on the node. Spawned so the caller's write returns immediately; if
    /// the embedder isn't warm — or anything else fails — the node keeps a
    /// NULL embedding for the backfill to fill later. By contract this can
    /// never fail the node write that triggered it.
    fn spawn_embed(&self, node_id: Uuid, label: &str, body: Option<&str>) {
        let Ok(handle) = tokio::runtime::Handle::try_current() else { return };
        let pool = self.pool.clone();
        let text = embed::embed_input(label, body);
        handle.spawn(async move {
            let Some(v) = embed::try_embed(&text).await else { return };
            let _ = sqlx::query("UPDATE kg_node SET embedding = $1 WHERE id = $2")
                .bind(pgvector::Vector::from(v))
                .bind(node_id)
                .execute(&pool)
                .await;
        });
    }

    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    // ── schema (idempotent, applied at runtime) ───────────────────────────────

    /// Idempotently bring the live database up to the current schema. The
    /// engine's schema.sql only runs on a fresh Docker volume, so existing
    /// graphs are upgraded here at runtime; safe to call on every startup.
    /// Kept in sync with `apps/flock-desktop/src-tauri/graph/schema.sql`.
    ///
    /// Includes the one-time v2 renovation (guarded by `kg_meta.schema_version`)
    /// that rebuilt the graph knowledge-first: identity scaffolding nodes
    /// (Agent/Person/Workspace/Project/Task) and their edges deleted, attempt
    /// details folded into the node (making them searchable), Outcome nodes
    /// converted to `shipped_in` stamps, duplicate titles archived.
    pub async fn ensure_event_schema(&self) -> Result<()> {
        // Core tables first, so a team-hosted Postgres without the Docker
        // init script still self-provisions.
        for ddl in [
            "CREATE EXTENSION IF NOT EXISTS pgcrypto",
            r#"CREATE TABLE IF NOT EXISTS kg_node (
                id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                kind             TEXT NOT NULL,
                label            TEXT NOT NULL,
                body             TEXT,
                workspace_id     TEXT,
                created_by_agent TEXT,
                created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
            )"#,
            r#"CREATE TABLE IF NOT EXISTS kg_edge (
                id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                from_node_id UUID NOT NULL REFERENCES kg_node(id) ON DELETE CASCADE,
                to_node_id   UUID NOT NULL REFERENCES kg_node(id) ON DELETE CASCADE,
                edge_type    TEXT NOT NULL,
                created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
                UNIQUE (from_node_id, to_node_id, edge_type)
            )"#,
            "CREATE TABLE IF NOT EXISTS kg_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
            // Tenant tag on knowledge nodes (phase 4). Nullable, so
            // pre-tenancy nodes and single-tenant use are unaffected.
            "ALTER TABLE kg_node ADD COLUMN IF NOT EXISTS org_id TEXT",
            "ALTER TABLE kg_node ADD COLUMN IF NOT EXISTS team_id TEXT",
            // v2 knowledge-first columns: edit time, retraction, attempt
            // outcome, decision→shipped stamp.
            "ALTER TABLE kg_node ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()",
            "ALTER TABLE kg_node ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ",
            "ALTER TABLE kg_node ADD COLUMN IF NOT EXISTS outcome TEXT",
            "ALTER TABLE kg_node ADD COLUMN IF NOT EXISTS shipped_in TEXT",
            // Stable dedupe key for hub anchors (Person, Repo): the person_id or
            // repo key, distinct from the human-readable `label`. File keeps
            // using label=path for its own uniqueness; hubs need an identity that
            // survives a display-name change (a person's handle, a repo rename).
            "ALTER TABLE kg_node ADD COLUMN IF NOT EXISTS anchor_key TEXT",
            // Compaction. `compaction_level` is 0 for everything ever written
            // and only moves through `compact`/`restore`, so the column reads
            // as "how many times has this been summarized away from what was
            // actually said".
            "ALTER TABLE kg_node ADD COLUMN IF NOT EXISTS compaction_level INT NOT NULL DEFAULT 0",
            "ALTER TABLE kg_node ADD COLUMN IF NOT EXISTS compacted_at TIMESTAMPTZ",
            // What the body weighed before the first compaction, kept so the
            // saving can be reported without reading the snapshot back.
            "ALTER TABLE kg_node ADD COLUMN IF NOT EXISTS original_bytes INT",
            // The original text, one row per compaction. This is what makes
            // compaction a decision the graph can take back: a summary that
            // turns out to have dropped the load-bearing sentence is recoverable
            // rather than a permanent edit to the record. Deliberately NOT
            // indexed for search — a snapshot is history, and surfacing both it
            // and its summary would double every hit.
            r#"CREATE TABLE IF NOT EXISTS kg_node_snapshot (
                id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                node_id          UUID NOT NULL REFERENCES kg_node(id) ON DELETE CASCADE,
                compaction_level INT NOT NULL,
                label            TEXT NOT NULL,
                body             TEXT,
                created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
            )"#,
            "CREATE INDEX IF NOT EXISTS kg_node_snapshot_node ON kg_node_snapshot (node_id, compaction_level DESC)",
        ] {
            sqlx::query(ddl).execute(&self.pool).await?;
        }
        // Semantic-search DDL (hybrid retrieval). Best-effort as a group: a
        // team-hosted Postgres role may lack CREATE EXTENSION rights, and
        // without the extension the column/index can't apply either — search
        // then stays FTS-only, which every read path tolerates.
        for ddl in [
            "CREATE EXTENSION IF NOT EXISTS vector",
            "ALTER TABLE kg_node ADD COLUMN IF NOT EXISTS embedding vector(384)",
            "CREATE INDEX IF NOT EXISTS kg_node_embedding ON kg_node USING hnsw (embedding vector_cosine_ops)",
        ] {
            if let Err(e) = sqlx::query(ddl).execute(&self.pool).await {
                tracing::warn!("semantic-search DDL skipped ({ddl}): {e}");
                break;
            }
        }
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS kg_event (
                id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                ts             TIMESTAMPTZ NOT NULL DEFAULT now(),
                operation      TEXT NOT NULL,
                kind           TEXT NOT NULL,
                workspace_id   TEXT,
                agent_id       TEXT,
                org_id         TEXT,
                team_id        TEXT,
                person_id      TEXT,
                node_count     INT,
                grounding_hits INT,
                latency_ms     INT,
                ok             BOOLEAN NOT NULL DEFAULT true,
                tokens_in      INT,
                tokens_out     INT,
                prompt_sha     TEXT,
                error          TEXT
            )
            "#,
        )
        .execute(&self.pool)
        .await?;
        // Which nodes a grounding pass actually surfaced. Added after the
        // event table shipped, so it is an ALTER rather than part of the
        // CREATE above — every graph in the field already has a kg_event.
        sqlx::query("ALTER TABLE kg_event ADD COLUMN IF NOT EXISTS fact_ids UUID[]")
            .execute(&self.pool)
            .await?;
        // Periodic account-spend samples (sampled token/cost source). Kept in
        // the same store as events so the phase-3 analytics can join cost to
        // activity over a time window.
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS kg_usage_snapshot (
                id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
                source      TEXT NOT NULL,
                used_minor  BIGINT NOT NULL,
                limit_minor BIGINT,
                currency    TEXT NOT NULL,
                exponent    INT NOT NULL DEFAULT 2,
                org_id      TEXT,
                person_id   TEXT
            )
            "#,
        )
        .execute(&self.pool)
        .await?;
        // Outcomes a team ships (merged PRs, closed tasks). The unique key makes
        // recording idempotent, so the same merge observed repeatedly lands once.
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS kg_outcome (
                id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                ts           TIMESTAMPTZ NOT NULL DEFAULT now(),
                workspace_id TEXT,
                kind         TEXT NOT NULL,
                ref_id       TEXT NOT NULL,
                title        TEXT,
                org_id       TEXT,
                person_id    TEXT,
                UNIQUE (kind, ref_id)
            )
            "#,
        )
        .execute(&self.pool)
        .await?;
        // Tenancy model (flock Enterprise phase 4). An org has many teams; a
        // person's membership in an org (optionally a team) carries a role.
        // `source` records how the org formed: an explicit "create org, invite"
        // flow, or one derived from the referral graph. Both are first-class.
        for ddl in [
            r#"CREATE TABLE IF NOT EXISTS kg_org (
                id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                name       TEXT NOT NULL,
                source     TEXT NOT NULL DEFAULT 'explicit',
                created_by TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )"#,
            r#"CREATE TABLE IF NOT EXISTS kg_team (
                id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                org_id     UUID NOT NULL REFERENCES kg_org(id) ON DELETE CASCADE,
                name       TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )"#,
            r#"CREATE TABLE IF NOT EXISTS kg_membership (
                id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                person_id  TEXT NOT NULL,
                org_id     UUID NOT NULL REFERENCES kg_org(id) ON DELETE CASCADE,
                team_id    UUID REFERENCES kg_team(id) ON DELETE SET NULL,
                role       TEXT NOT NULL DEFAULT 'member',
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                UNIQUE (person_id, org_id)
            )"#,
        ] {
            sqlx::query(ddl).execute(&self.pool).await?;
        }
        // Indexes in one batch; each is independently idempotent.
        for ddl in [
            "CREATE UNIQUE INDEX IF NOT EXISTS kg_node_file_path ON kg_node (label) WHERE kind = 'File'",
            // One hub node per (kind, anchor_key): one Person per person_id, one
            // Repo per repo key — so every write links the same shared hub.
            "CREATE UNIQUE INDEX IF NOT EXISTS kg_node_anchor_key ON kg_node (kind, anchor_key) WHERE anchor_key IS NOT NULL",
            "CREATE INDEX IF NOT EXISTS kg_node_fts ON kg_node USING GIN (to_tsvector('english', coalesce(label,'') || ' ' || coalesce(body,'')))",
            "CREATE INDEX IF NOT EXISTS kg_node_kind ON kg_node (kind)",
            "CREATE INDEX IF NOT EXISTS kg_node_workspace ON kg_node (workspace_id)",
            "CREATE INDEX IF NOT EXISTS kg_edge_from ON kg_edge (from_node_id)",
            "CREATE INDEX IF NOT EXISTS kg_edge_to ON kg_edge (to_node_id)",
            "CREATE INDEX IF NOT EXISTS kg_event_ts ON kg_event (ts)",
            "CREATE INDEX IF NOT EXISTS kg_event_workspace ON kg_event (workspace_id)",
            "CREATE INDEX IF NOT EXISTS kg_event_operation ON kg_event (operation)",
            "CREATE INDEX IF NOT EXISTS kg_event_org ON kg_event (org_id)",
            "CREATE INDEX IF NOT EXISTS kg_usage_snapshot_ts ON kg_usage_snapshot (ts)",
            "CREATE INDEX IF NOT EXISTS kg_usage_snapshot_source ON kg_usage_snapshot (source)",
            "CREATE INDEX IF NOT EXISTS kg_outcome_ts ON kg_outcome (ts)",
            "CREATE INDEX IF NOT EXISTS kg_outcome_workspace ON kg_outcome (workspace_id)",
            "CREATE INDEX IF NOT EXISTS kg_team_org ON kg_team (org_id)",
            "CREATE INDEX IF NOT EXISTS kg_membership_person ON kg_membership (person_id)",
            "CREATE INDEX IF NOT EXISTS kg_membership_org ON kg_membership (org_id)",
            "CREATE INDEX IF NOT EXISTS kg_node_org ON kg_node (org_id)",
        ] {
            sqlx::query(ddl).execute(&self.pool).await?;
        }

        // One-time v2 renovation of pre-existing data, guarded by a version
        // marker so it can never run twice.
        let version: Option<String> =
            sqlx::query_scalar("SELECT value FROM kg_meta WHERE key = 'schema_version'")
                .fetch_optional(&self.pool)
                .await?;
        if version.as_deref() != Some("2") {
            self.renovate_v2().await?;
            sqlx::query(
                "INSERT INTO kg_meta (key, value) VALUES ('schema_version', '2')
                 ON CONFLICT (key) DO UPDATE SET value = '2'",
            )
            .execute(&self.pool)
            .await?;
        }
        Ok(())
    }

    /// The one-time knowledge-first renovation of a v1 graph. Everything here
    /// either preserves information in a better place (attempt details onto
    /// the node, Outcome nodes into `shipped_in` stamps) or deletes structure
    /// that carried none (identity scaffolding, file claims). Duplicate titles
    /// are archived (not deleted) so nothing is lost, just hidden.
    async fn renovate_v2(&self) -> Result<()> {
        // updated_at was just defaulted to now() for old rows — restore the
        // honest edit time.
        sqlx::query("UPDATE kg_node SET updated_at = created_at")
            .execute(&self.pool)
            .await?;

        // Fold the attempt sidecar into the node itself: outcome becomes a
        // column and notes become the body, which makes attempt lessons
        // full-text and semantically searchable (they never were before).
        let has_sidecar: bool =
            sqlx::query_scalar("SELECT to_regclass('kg_attempt_detail') IS NOT NULL")
                .fetch_one(&self.pool)
                .await?;
        if has_sidecar {
            sqlx::query(
                r#"
                UPDATE kg_node n
                SET outcome = d.outcome,
                    body = CASE WHEN n.body IS NULL OR n.body = '' THEN d.notes ELSE n.body END
                FROM kg_attempt_detail d
                WHERE d.node_id = n.id
                "#,
            )
            .execute(&self.pool)
            .await?;
            sqlx::query("DROP TABLE kg_attempt_detail")
                .execute(&self.pool)
                .await?;
        }

        // Outcome nodes → shipped_in stamps on the decisions they realized
        // (the RESULTED_IN edges drawn by v1's record_outcome).
        sqlx::query(
            r#"
            UPDATE kg_node d
            SET shipped_in = coalesce(d.shipped_in, o.label || ' · ' || coalesce(o.body, ''))
            FROM kg_edge e
            JOIN kg_node o ON o.id = e.to_node_id AND o.kind = 'Outcome'
            WHERE e.from_node_id = d.id AND e.edge_type = 'RESULTED_IN'
            "#,
        )
        .execute(&self.pool)
        .await?;

        // Delete scaffolding: every edge type outside the v2 vocabulary, then
        // every identity node (their remaining edges cascade).
        sqlx::query("DELETE FROM kg_edge WHERE edge_type NOT IN ('ABOUT','RELATES_TO','SUPERSEDES')")
            .execute(&self.pool)
            .await?;
        sqlx::query(
            "DELETE FROM kg_node WHERE kind IN ('Agent','Person','Workspace','Project','Task','Outcome')",
        )
        .execute(&self.pool)
        .await?;

        // One note per title: archive older exact-title duplicates (newest
        // wins). Attempts are excluded — repeated attempts are real history.
        sqlx::query(
            r#"
            UPDATE kg_node SET archived_at = now() WHERE id IN (
                SELECT id FROM (
                    SELECT id, row_number() OVER (
                        PARTITION BY kind, lower(label), coalesce(workspace_id, '')
                        ORDER BY created_at DESC
                    ) AS rn
                    FROM kg_node
                    WHERE kind IN ('Decision','Note','Interface') AND archived_at IS NULL
                ) t WHERE rn > 1
            )
            "#,
        )
        .execute(&self.pool)
        .await?;

        // File nodes that lost their only reason to exist (claims) — drop the
        // orphans; files with knowledge attached keep their ABOUT edges.
        sqlx::query(
            r#"
            DELETE FROM kg_node f
            WHERE f.kind = 'File'
              AND NOT EXISTS (SELECT 1 FROM kg_edge e
                              WHERE e.from_node_id = f.id OR e.to_node_id = f.id)
            "#,
        )
        .execute(&self.pool)
        .await?;
        tracing::info!("knowledge graph renovated to schema v2");
        Ok(())
    }

    // ── tenancy: orgs, teams, membership (flock Enterprise phase 4) ───────────

    /// Create an org and make its creator the owner. `source` is "explicit"
    /// (create-org flow) or "referral" (derived from the referral graph).
    /// Returns the new org id.
    pub async fn create_org(&self, name: &str, source: &str, created_by: Option<&str>) -> Result<Uuid> {
        let org_id: Uuid = sqlx::query_scalar(
            "INSERT INTO kg_org (name, source, created_by) VALUES ($1, $2, $3) RETURNING id",
        )
        .bind(name)
        .bind(source)
        .bind(created_by)
        .fetch_one(&self.pool)
        .await?;
        if let Some(person) = created_by {
            self.add_member(person, org_id, None, "owner").await?;
        }
        Ok(org_id)
    }

    /// Create a team within an org. Returns the new team id.
    pub async fn create_team(&self, org_id: Uuid, name: &str) -> Result<Uuid> {
        let team_id: Uuid = sqlx::query_scalar(
            "INSERT INTO kg_team (org_id, name) VALUES ($1, $2) RETURNING id",
        )
        .bind(org_id)
        .bind(name)
        .fetch_one(&self.pool)
        .await?;
        Ok(team_id)
    }

    /// Add (or move) a person's membership in an org, optionally into a team.
    /// Upserts on (person_id, org_id) so re-invites and team moves are safe.
    pub async fn add_member(
        &self,
        person_id: &str,
        org_id: Uuid,
        team_id: Option<Uuid>,
        role: &str,
    ) -> Result<()> {
        sqlx::query(
            r#"
            INSERT INTO kg_membership (person_id, org_id, team_id, role)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (person_id, org_id)
            DO UPDATE SET team_id = EXCLUDED.team_id, role = EXCLUDED.role
            "#,
        )
        .bind(person_id)
        .bind(org_id)
        .bind(team_id)
        .bind(role)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// The person's primary (earliest) org and team, as id strings for stamping
    /// into agent env / events. None when the person belongs to no org yet.
    pub async fn primary_membership(&self, person_id: &str) -> Result<Option<(String, Option<String>)>> {
        let row: Option<(Uuid, Option<Uuid>)> = sqlx::query_as(
            r#"
            SELECT org_id, team_id FROM kg_membership
            WHERE person_id = $1 ORDER BY created_at ASC LIMIT 1
            "#,
        )
        .bind(person_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|(org, team)| (org.to_string(), team.map(|t| t.to_string()))))
    }

    /// Mirror a flock ID (Supabase) membership into the graph, preserving
    /// the server's UUIDs so every teammate's mirror agrees on org/team
    /// identity. Idempotent upserts; org/team renames follow the server.
    pub async fn mirror_membership(
        &self,
        person_id: &str,
        org_id: Uuid,
        org_name: &str,
        team: Option<(Uuid, &str)>,
        role: &str,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO kg_org (id, name, source) VALUES ($1, $2, 'flock-id')
             ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name",
        )
        .bind(org_id)
        .bind(org_name)
        .execute(&self.pool)
        .await?;
        if let Some((team_id, team_name)) = team {
            sqlx::query(
                "INSERT INTO kg_team (id, org_id, name) VALUES ($1, $2, $3)
                 ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, org_id = EXCLUDED.org_id",
            )
            .bind(team_id)
            .bind(org_id)
            .bind(team_name)
            .execute(&self.pool)
            .await?;
        }
        self.add_member(person_id, org_id, team.map(|(t, _)| t), role)
            .await
    }

    /// Record an outcome (a merged PR, a closed task). Idempotent via the
    /// unique key, so a caller can fire it every time it observes the merge.
    /// Returns true when a new row was written (first observation).
    pub async fn record_outcome(&self, o: OutcomeReq) -> Result<bool> {
        let res = sqlx::query(
            r#"
            INSERT INTO kg_outcome (workspace_id, kind, ref_id, title)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (kind, ref_id) DO NOTHING
            "#,
        )
        .bind(&o.workspace_id)
        .bind(&o.kind)
        .bind(&o.ref_id)
        .bind(&o.title)
        .execute(&self.pool)
        .await?;
        let newly = res.rows_affected() > 0;

        // On first observation, stamp every live Decision recorded ABOUT one
        // of the changed files with the shipped artifact — the decision→
        // shipped feedback loop, as metadata on the decision itself rather
        // than extra graph structure. Best-effort: a failure here must not
        // drop the outcome row above.
        if newly {
            if let Err(e) = self.stamp_shipped(&o).await {
                tracing::warn!("decision shipped-stamping skipped: {e}");
            }
        }
        Ok(newly)
    }

    /// Stamp `shipped_in` on every non-superseded, non-archived Decision
    /// ABOUT one of the outcome's changed files. First shipped artifact wins
    /// (COALESCE) — a decision ships once; later touches don't rewrite history.
    async fn stamp_shipped(&self, o: &OutcomeReq) -> Result<()> {
        if o.files.is_empty() {
            return Ok(());
        }
        let stamp = match o.title.as_deref().filter(|t| !t.is_empty()) {
            Some(t) => format!("{t} · {}", o.ref_id),
            None => o.ref_id.clone(),
        };
        let paths: Vec<String> = o.files.iter().map(|f| normalize_path(f)).collect();
        sqlx::query(
            r#"
            UPDATE kg_node d
            SET shipped_in = coalesce(d.shipped_in, $1)
            WHERE d.kind = 'Decision'
              AND d.archived_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM kg_edge se
                              WHERE se.to_node_id = d.id AND se.edge_type = 'SUPERSEDES')
              AND EXISTS (
                    SELECT 1 FROM kg_edge a
                    JOIN kg_node f ON f.id = a.to_node_id AND f.kind = 'File'
                    WHERE a.from_node_id = d.id AND a.edge_type = 'ABOUT'
                      AND f.label = ANY($2)
              )
            "#,
        )
        .bind(&stamp)
        .bind(&paths)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// The phase-3 headline numbers over the trailing window since `since`:
    /// what recall did ([`RecallStats`]), read/write volume, outcomes shipped,
    /// and the account spend delta. All computed from the telemetry tables, no
    /// external calls.
    pub async fn insights_summary(&self, since: DateTime<Utc>) -> Result<InsightsSummary> {
        // Machine-wide, not workspace-scoped: this is the account-level panel.
        let recall = self.recall_stats(None, since).await?;
        let (reads, writes): (i64, i64) = sqlx::query_as(
            r#"
                SELECT
                  count(*) FILTER (WHERE kind = 'read'),
                  count(*) FILTER (WHERE kind = 'write')
                FROM kg_event
                WHERE ts >= $1
                "#,
        )
        .bind(since)
        .fetch_one(&self.pool)
        .await?;

        let outcomes: i64 = sqlx::query_scalar("SELECT count(*) FROM kg_outcome WHERE ts >= $1")
            .bind(since)
            .fetch_one(&self.pool)
            .await?;

        // Spend delta per source (max - min over the window), summed. Currency
        // and exponent come from whichever source has samples.
        let cost_rows: Vec<(i64, i64, String, i32)> = sqlx::query_as(
            r#"
            SELECT coalesce(max(used_minor), 0), coalesce(min(used_minor), 0),
                   coalesce(max(currency), 'USD'), coalesce(max(exponent), 2)
            FROM kg_usage_snapshot
            WHERE ts >= $1
            GROUP BY source
            "#,
        )
        .bind(since)
        .fetch_all(&self.pool)
        .await?;
        let cost_minor: i64 = cost_rows.iter().map(|(mx, mn, _, _)| (mx - mn).max(0)).sum();
        let (currency, exponent) = cost_rows
            .first()
            .map(|(_, _, c, e)| (c.clone(), *e))
            .unwrap_or_else(|| ("USD".to_string(), 2));

        Ok(InsightsSummary {
            since,
            recall,
            reads,
            writes,
            outcomes,
            cost_minor,
            currency,
            exponent,
        })
    }

    /// Record one account-spend sample. De-duped: the provider usage endpoint
    /// is cached ~180s, so consecutive polls repeat the same figure; only a
    /// changed `used_minor` is stored, keeping the curve compact. Best-effort,
    /// like [`log_event`].
    pub async fn record_usage_snapshot(&self, s: UsageSnapshot) {
        let last: Option<i64> = sqlx::query_scalar(
            "SELECT used_minor FROM kg_usage_snapshot WHERE source = $1 ORDER BY ts DESC LIMIT 1",
        )
        .bind(&s.source)
        .fetch_optional(&self.pool)
        .await
        .ok()
        .flatten();
        if last == Some(s.used_minor) {
            return;
        }
        let res = sqlx::query(
            r#"
            INSERT INTO kg_usage_snapshot (source, used_minor, limit_minor, currency, exponent)
            VALUES ($1, $2, $3, $4, $5)
            "#,
        )
        .bind(&s.source)
        .bind(s.used_minor)
        .bind(s.limit_minor)
        .bind(&s.currency)
        .bind(s.exponent)
        .execute(&self.pool)
        .await;
        if let Err(e) = res {
            tracing::warn!("kg_usage_snapshot dropped: {e}");
        }
    }

    /// Record one telemetry event. Best-effort by contract: callers must not
    /// let a logging failure break the tool call that produced it, so this
    /// swallows errors into a warning rather than propagating them. A missing
    /// `kg_event` table (engine not yet upgraded) simply drops the event.
    pub async fn log_event(&self, ev: EventReq) {
        let res = sqlx::query(
            r#"
            INSERT INTO kg_event
                (operation, kind, workspace_id, agent_id, person_id, org_id, team_id,
                 node_count, grounding_hits, fact_ids, latency_ms, ok, error)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            "#,
        )
        .bind(&ev.operation)
        .bind(ev.kind.as_str())
        .bind(&ev.workspace_id)
        .bind(&ev.agent_id)
        .bind(&ev.person_id)
        .bind(&ev.org_id)
        .bind(&ev.team_id)
        .bind(ev.node_count)
        .bind(ev.grounding_hits)
        // Every ground event binds an array, empty included; everything else
        // binds NULL. That makes `fact_ids IS NOT NULL` mean exactly "this
        // pass can say what it surfaced" — which separates a pass that
        // genuinely found nothing (empty array, and worth showing as such)
        // from one recorded before this column existed, whose hit count is
        // real but whose facts are gone for good.
        .bind(match ev.kind {
            EventKind::Ground => Some(&ev.fact_ids),
            _ => None,
        })
        .bind(ev.latency_ms)
        .bind(ev.ok)
        .bind(&ev.error)
        .execute(&self.pool)
        .await;
        if let Err(e) = res {
            tracing::warn!("kg_event log dropped: {e}");
        }
    }

    // ── ref resolution & anchoring helpers ────────────────────────────────────

    /// Resolve a caller-supplied reference — a UUID string or a label
    /// fragment — to an existing live node. Fragments match case-insensitively,
    /// newest node first, optionally constrained to `kinds` (empty = any).
    /// Returns None rather than erroring so unresolved refs degrade to
    /// "no edge", never to a failed write.
    pub async fn resolve_ref(&self, r: &str, kinds: &[&str]) -> Result<Option<Uuid>> {
        let r = r.trim();
        if r.is_empty() {
            return Ok(None);
        }
        if let Ok(id) = Uuid::parse_str(r) {
            let exists = sqlx::query_scalar::<_, Uuid>("SELECT id FROM kg_node WHERE id = $1")
                .bind(id)
                .fetch_optional(&self.pool)
                .await?;
            return Ok(exists);
        }
        // Escape LIKE wildcards so a fragment is always a literal match.
        let fragment = r.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
        let kinds: Vec<String> = kinds.iter().map(|k| k.to_string()).collect();
        let id = sqlx::query_scalar::<_, Uuid>(
            r#"SELECT id FROM kg_node
               WHERE (cardinality($2::text[]) = 0 OR kind = ANY($2))
                 AND archived_at IS NULL
                 AND label ILIKE '%' || $1 || '%'
               ORDER BY updated_at DESC LIMIT 1"#,
        )
        .bind(&fragment)
        .bind(&kinds)
        .fetch_optional(&self.pool)
        .await?;
        Ok(id)
    }

    /// Get-or-create the File node for a path (one node per path — the
    /// partial unique index on kind='File' labels enforces it).
    async fn upsert_file(&self, path: &str, workspace_id: Option<&str>) -> Result<Uuid> {
        let inserted = sqlx::query_scalar::<_, Uuid>(
            r#"INSERT INTO kg_node (kind, label, workspace_id)
               VALUES ('File', $1, $2)
               ON CONFLICT DO NOTHING
               RETURNING id"#,
        )
        .bind(path)
        .bind(workspace_id)
        .fetch_optional(&self.pool)
        .await?;
        if let Some(id) = inserted {
            self.spawn_embed(id, path, None);
        }
        match inserted {
            Some(id) => Ok(id),
            None => Ok(sqlx::query_scalar::<_, Uuid>(
                "SELECT id FROM kg_node WHERE kind='File' AND label=$1 LIMIT 1",
            )
            .bind(path)
            .fetch_one(&self.pool)
            .await?),
        }
    }

    /// Upsert a hub anchor (Person or Repo) keyed by `anchor_key`, returning its
    /// id. `label` is the display name; a later write with a fresh name updates
    /// the label in place, but the same key always resolves the one shared hub.
    /// Mirrors `upsert_file`'s two-step (insert-or-select) so a concurrent
    /// writer that lost the ON CONFLICT race still gets the winner's id.
    async fn upsert_anchor(&self, kind: &str, key: &str, label: &str) -> Result<Uuid> {
        let row = sqlx::query_scalar::<_, Uuid>(
            r#"INSERT INTO kg_node (kind, label, anchor_key)
               VALUES ($1, $2, $3)
               ON CONFLICT (kind, anchor_key) WHERE anchor_key IS NOT NULL
               DO UPDATE SET label = EXCLUDED.label, updated_at = now()
               RETURNING id"#,
        )
        .bind(kind)
        .bind(label)
        .bind(key)
        .fetch_optional(&self.pool)
        .await?;
        match row {
            Some(id) => Ok(id),
            None => Ok(sqlx::query_scalar::<_, Uuid>(
                "SELECT id FROM kg_node WHERE kind=$1 AND anchor_key=$2 LIMIT 1",
            )
            .bind(kind)
            .bind(key)
            .fetch_one(&self.pool)
            .await?),
        }
    }

    /// Anchor a freshly written knowledge node into the graph with zero agent
    /// effort: ABOUT → each named file, RELATES_TO → each resolved label ref and
    /// each `[[wikilink]]` in the body, plus the provenance spine — AUTHORED_BY →
    /// the author hub and IN_REPO → the codebase hub (and every named file joins
    /// that same repo). The provenance edges are what guarantee ≥2 associations
    /// on a node that named no files and no relations. Best-effort by design — a
    /// bad ref must never fail the write that carried the actual knowledge.
    async fn anchor_node(
        &self,
        node_id: Uuid,
        workspace_id: Option<&str>,
        files: &[String],
        relates_to: &[String],
        body: Option<&str>,
        prov: &Provenance,
    ) {
        // Repo hub first, so each file can also be tied into the codebase.
        let repo_id = self.anchor_repo(node_id, prov).await;
        for f in files.iter().map(|f| normalize_path(f)).filter(|f| !f.is_empty()) {
            if let Ok(fid) = self.upsert_file(&f, workspace_id).await {
                self.link(LinkReq { from_node_id: node_id, to_node_id: fid, edge_type: "ABOUT".into() }).await.ok();
                if let Some(rid) = repo_id {
                    // The file belongs to the same codebase — a File anchor then
                    // has its ABOUT (in) plus IN_REPO (out), never isolated.
                    self.link(LinkReq { from_node_id: fid, to_node_id: rid, edge_type: "IN_REPO".into() }).await.ok();
                }
            }
        }
        self.anchor_author(node_id, prov).await;
        let wikilinks = body.map(extract_wikilinks).unwrap_or_default();
        for r in relates_to.iter().chain(wikilinks.iter()) {
            // Knowledge kinds only: a fragment like "spawn" must never link an
            // identity-ish anchor (File) by accident.
            if let Ok(Some(rid)) = self.resolve_ref(r, &KNOWLEDGE_KINDS).await {
                if rid != node_id {
                    self.link(LinkReq { from_node_id: node_id, to_node_id: rid, edge_type: "RELATES_TO".into() }).await.ok();
                }
            }
        }
    }

    /// Upsert the Repo hub for this write and link `node → IN_REPO → repo`.
    /// Returns the repo id so callers can tie files into the same codebase.
    async fn anchor_repo(&self, node_id: Uuid, prov: &Provenance) -> Option<Uuid> {
        let key = prov.repo_key.as_deref().filter(|k| !k.is_empty())?;
        let label = prov.repo_name.as_deref().filter(|n| !n.is_empty()).unwrap_or(key);
        let rid = self.upsert_anchor("Repo", key, label).await.ok()?;
        self.link(LinkReq { from_node_id: node_id, to_node_id: rid, edge_type: "IN_REPO".into() }).await.ok();
        Some(rid)
    }

    /// Upsert the Person hub for this write and link `node → AUTHORED_BY → person`.
    async fn anchor_author(&self, node_id: Uuid, prov: &Provenance) {
        let Some(pid) = prov.person_id.as_deref().filter(|p| !p.is_empty()) else { return };
        let label = prov.person_name.as_deref().filter(|n| !n.is_empty()).unwrap_or(pid);
        if let Ok(aid) = self.upsert_anchor("Person", pid, label).await {
            self.link(LinkReq { from_node_id: node_id, to_node_id: aid, edge_type: "AUTHORED_BY".into() }).await.ok();
        }
    }

    /// One note per title: find the live (non-archived, non-superseded) node
    /// with this exact kind + title in the same scope, if any — the node a
    /// same-title write updates in place.
    async fn find_by_title(
        &self,
        kind: &str,
        label: &str,
        workspace_id: Option<&str>,
    ) -> Result<Option<Uuid>> {
        Ok(sqlx::query_scalar::<_, Uuid>(
            r#"
            SELECT id FROM kg_node n
            WHERE kind = $1 AND lower(label) = lower($2)
              AND workspace_id IS NOT DISTINCT FROM $3
              AND archived_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM kg_edge se
                              WHERE se.to_node_id = n.id AND se.edge_type = 'SUPERSEDES')
            ORDER BY updated_at DESC LIMIT 1
            "#,
        )
        .bind(kind)
        .bind(label)
        .bind(workspace_id)
        .fetch_optional(&self.pool)
        .await?)
    }

    /// Shared body of every knowledge write: title-upsert (same kind + title
    /// + scope updates in place, bumping `updated_at` and re-embedding),
    /// otherwise insert. Returns the node and whether it was an update.
    async fn write_knowledge(
        &self,
        kind: &str,
        label: &str,
        body: Option<&str>,
        outcome: Option<&str>,
        workspace_id: Option<&str>,
        agent_id: Option<&str>,
        org_id: Option<&str>,
        team_id: Option<&str>,
        upsert_by_title: bool,
    ) -> Result<Written> {
        if upsert_by_title {
            if let Some(id) = self.find_by_title(kind, label, workspace_id).await? {
                let node = sqlx::query_as::<_, RawNode>(&format!(
                    r#"
                    UPDATE kg_node
                    SET body = $2, updated_at = now(),
                        created_by_agent = coalesce($3, created_by_agent)
                    WHERE id = $1
                    RETURNING {NODE_COLS}
                    "#
                ))
                .bind(id)
                .bind(body)
                .bind(agent_id)
                .fetch_one(&self.pool)
                .await?;
                self.spawn_embed(node.id, &node.label, node.body.as_deref());
                return Ok(Written { node: node.into_kg_node(), updated: true });
            }
        }
        let node = sqlx::query_as::<_, RawNode>(&format!(
            r#"
            INSERT INTO kg_node (kind, label, body, outcome, workspace_id, created_by_agent, org_id, team_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING {NODE_COLS}
            "#
        ))
        .bind(kind)
        .bind(label)
        .bind(body)
        .bind(outcome)
        .bind(workspace_id)
        .bind(agent_id)
        .bind(org_id)
        .bind(team_id)
        .fetch_one(&self.pool)
        .await?;
        self.spawn_embed(node.id, &node.label, node.body.as_deref());
        Ok(Written { node: node.into_kg_node(), updated: false })
    }

    // ── write_decision ────────────────────────────────────────────────────────

    pub async fn write_decision(&self, req: WriteDecisionReq) -> Result<Written> {
        let written = self
            .write_knowledge(
                "Decision",
                &req.label,
                Some(&req.body),
                None,
                req.workspace_id.as_deref(),
                req.agent_id.as_deref(),
                req.org_id.as_deref(),
                req.team_id.as_deref(),
                true,
            )
            .await?;
        let node = &written.node;

        if let Some(prev) = req.supersedes.as_deref() {
            if let Some(prev_id) = self.resolve_ref(prev, &["Decision"]).await? {
                if prev_id != node.id {
                    self.link(LinkReq { from_node_id: node.id, to_node_id: prev_id, edge_type: "SUPERSEDES".into() }).await.ok();
                }
            }
        }
        let prov = Provenance {
            person_id: req.person_id.clone(),
            person_name: req.person_name.clone(),
            repo_key: req.repo_key.clone(),
            repo_name: req.repo_name.clone(),
        };
        self.anchor_node(node.id, req.workspace_id.as_deref(), &req.files, &req.relates_to, node.body.as_deref(), &prov)
            .await;
        Ok(written)
    }

    // ── record_attempt ────────────────────────────────────────────────────────

    /// Attempts are events, not documents — every attempt is a fresh node
    /// (no title-upsert), and its notes live in the body so search finds them.
    pub async fn record_attempt(&self, req: RecordAttemptReq) -> Result<KgNode> {
        let written = self
            .write_knowledge(
                "Attempt",
                &req.label,
                req.notes.as_deref(),
                Some(req.outcome.as_str()),
                req.workspace_id.as_deref(),
                req.agent_id.as_deref(),
                req.org_id.as_deref(),
                req.team_id.as_deref(),
                false,
            )
            .await?;
        let prov = Provenance {
            person_id: req.person_id.clone(),
            person_name: req.person_name.clone(),
            repo_key: req.repo_key.clone(),
            repo_name: req.repo_name.clone(),
        };
        self.anchor_node(
            written.node.id,
            req.workspace_id.as_deref(),
            &req.files,
            &req.relates_to,
            written.node.body.as_deref(),
            &prov,
        )
        .await;
        Ok(written.node)
    }

    // ── remember (free-form knowledge) ────────────────────────────────────────

    pub async fn remember(&self, req: RememberReq) -> Result<Written> {
        let kind = match req.kind.as_deref() {
            Some("Interface") => "Interface",
            _ => "Note",
        };
        let written = self
            .write_knowledge(
                kind,
                &req.label,
                Some(&req.body),
                None,
                req.workspace_id.as_deref(),
                req.agent_id.as_deref(),
                req.org_id.as_deref(),
                req.team_id.as_deref(),
                true,
            )
            .await?;
        let node = &written.node;

        // Correction path: a note/interface can supersede an earlier one, which
        // the default read filters then hide (the SUPERSEDES filter is generic
        // over kind, not Decision-only). Resolve against any knowledge kind.
        if let Some(prev) = req.supersedes.as_deref() {
            if let Some(prev_id) = self.resolve_ref(prev, &KNOWLEDGE_KINDS).await? {
                if prev_id != node.id {
                    self.link(LinkReq { from_node_id: node.id, to_node_id: prev_id, edge_type: "SUPERSEDES".into() }).await.ok();
                }
            }
        }
        let prov = Provenance {
            person_id: req.person_id.clone(),
            person_name: req.person_name.clone(),
            repo_key: req.repo_key.clone(),
            repo_name: req.repo_name.clone(),
        };
        self.anchor_node(node.id, req.workspace_id.as_deref(), &req.files, &req.relates_to, node.body.as_deref(), &prov)
            .await;
        Ok(written)
    }

    // ── forget (archive wrong/obsolete knowledge) ─────────────────────────────

    /// Archive a knowledge node: it stops surfacing in every read, but stays
    /// in the database with the reason appended — an audit trail, not a
    /// deletion. Returns the archived node's label, or None if no live node
    /// matched the reference.
    pub async fn forget(&self, req: ForgetReq) -> Result<Option<String>> {
        let Some(id) = self.resolve_ref(&req.reference, &KNOWLEDGE_KINDS).await? else {
            return Ok(None);
        };
        let label = sqlx::query_scalar::<_, String>(
            r#"
            UPDATE kg_node
            SET archived_at = now(),
                body = CASE WHEN $2::text IS NULL THEN body
                            ELSE coalesce(body, '') || E'\n\n[forgotten: ' || $2 || ']' END
            WHERE id = $1 AND archived_at IS NULL
            RETURNING label
            "#,
        )
        .bind(id)
        .bind(req.reason.as_deref())
        .fetch_optional(&self.pool)
        .await?;
        Ok(label)
    }

    // ── compaction (reversible summarization of old, long knowledge) ──────────

    /// Minimum body length worth compacting. Below this a summary saves nothing
    /// and costs a round trip plus a level of remove from what was said.
    const COMPACT_MIN_BYTES: i32 = 800;
    /// How long knowledge must have sat unedited before it is a candidate.
    /// Recent knowledge is the knowledge being actively argued with, and a
    /// summary of an argument still in progress is worse than the argument.
    const COMPACT_MIN_AGE_DAYS: i32 = 30;

    /// Knowledge old enough and long enough to be worth summarizing, biggest
    /// first — the ordering is the saving, so a caller taking the first N takes
    /// the N that free the most.
    ///
    /// Archived and superseded nodes are excluded even though they are the
    /// fattest targets: both are already hidden from every read, so compacting
    /// them buys nothing a reader would ever notice while still spending a
    /// summarization and putting the original one step further away.
    pub async fn compaction_candidates(
        &self,
        workspace_id: Option<&str>,
        limit: i64,
    ) -> Result<Vec<CompactionCandidate>> {
        let rows = sqlx::query_as::<_, (Uuid, String, String, String, i32, DateTime<Utc>)>(
            r#"
            SELECT n.id, n.kind, n.label, n.body, length(n.body)::int, n.updated_at
            FROM kg_node n
            WHERE n.kind = ANY($1)
              AND n.archived_at IS NULL
              AND n.compaction_level = 0
              AND n.body IS NOT NULL
              AND length(n.body) >= $2
              AND n.updated_at < now() - make_interval(days => $3)
              AND ($4::text IS NULL OR n.workspace_id = $4 OR n.workspace_id = 'global')
              AND NOT EXISTS (
                  SELECT 1 FROM kg_edge e
                  WHERE e.to_node_id = n.id AND e.edge_type = 'SUPERSEDES'
              )
            ORDER BY length(n.body) DESC
            LIMIT $5
            "#,
        )
        .bind(KNOWLEDGE_KINDS)
        .bind(Self::COMPACT_MIN_BYTES)
        .bind(Self::COMPACT_MIN_AGE_DAYS)
        .bind(workspace_id)
        .bind(limit.clamp(1, 50))
        .fetch_all(&self.pool)
        .await?;

        Ok(rows
            .into_iter()
            .map(|(id, kind, label, body, bytes, updated_at)| CompactionCandidate {
                id,
                kind,
                label,
                body,
                bytes,
                updated_at,
            })
            .collect())
    }

    /// The most a summary may weigh, as a fraction of what it replaces. The
    /// failure mode of asking a model to summarize is a "summary" that restates
    /// the original at nearly the same length — which costs a round trip, adds a
    /// level of remove from what was said, and saves nothing. Requiring a real
    /// saving turns that from a silent non-event into a refusal the caller can
    /// act on. A quarter off is the floor, not the target; the prompt asks for
    /// far more.
    const COMPACT_MAX_RATIO: f64 = 0.75;

    /// How many times a node may be summarized. One.
    ///
    /// The ratio check above compares a summary against whatever the body is
    /// *now*, so on an already-compacted node it happily accepts a summary of a
    /// summary — and again, and again, each pass another step away from what was
    /// actually said and each one looking like a 90% saving. `compaction_candidates`
    /// never offers a compacted node, but nothing stops a caller naming one
    /// directly, so the invariant belongs here rather than in the query.
    ///
    /// A second tier is a real idea (beads runs one at 30 days and another at 90)
    /// but it needs its own age threshold and its own prompt. The column and the
    /// snapshot table already carry levels, so raising this is all it would take.
    const COMPACT_MAX_LEVEL: i32 = 1;

    /// Replace a node's body with `summary`, keeping the original in
    /// `kg_node_snapshot` so [`restore`] can put it back.
    ///
    /// Refuses a summary that does not actually save anything (see
    /// [`Self::COMPACT_MAX_RATIO`]) — an error rather than a no-op, because a
    /// caller that thinks it compacted something and did not will keep offering
    /// the same node forever.
    ///
    /// Snapshot and update in one transaction: a snapshot without the update
    /// leaves a phantom history entry, and an update without the snapshot is
    /// the exact irreversible edit this whole feature exists to avoid.
    pub async fn compact(&self, req: CompactReq) -> Result<Option<CompactResult>> {
        let summary = req.summary.trim();
        if summary.is_empty() {
            anyhow::bail!("refusing to compact to an empty body");
        }
        let Some(id) = self.resolve_ref(&req.reference, &KNOWLEDGE_KINDS).await? else {
            return Ok(None);
        };

        let mut tx = self.pool.begin().await?;
        let Some((label, body, level)) = sqlx::query_as::<_, (String, Option<String>, i32)>(
            "SELECT label, body, compaction_level FROM kg_node WHERE id = $1 AND archived_at IS NULL FOR UPDATE",
        )
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        else {
            return Ok(None);
        };

        if level >= Self::COMPACT_MAX_LEVEL {
            anyhow::bail!(
                "\"{label}\" has already been compacted — summarizing a summary drifts further \
                 from what was actually said with nothing to show for it. kg.restore puts the \
                 original back if this one lost something."
            );
        }

        let before = body.as_deref().unwrap_or("");
        let before_bytes = before.len() as i32;
        let ceiling = (before_bytes as f64 * Self::COMPACT_MAX_RATIO) as usize;
        if summary.len() > ceiling {
            anyhow::bail!(
                "summary saves too little to be worth a level of remove: {} bytes against {} — \
                 needs to be {ceiling} or under. Summarize harder, or leave it alone.",
                summary.len(),
                before_bytes
            );
        }

        sqlx::query(
            "INSERT INTO kg_node_snapshot (node_id, compaction_level, label, body) VALUES ($1, $2, $3, $4)",
        )
        .bind(id)
        .bind(level)
        .bind(&label)
        .bind(before)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            r#"
            UPDATE kg_node
            SET body = $2,
                compaction_level = compaction_level + 1,
                compacted_at = now(),
                original_bytes = coalesce(original_bytes, $3)
            WHERE id = $1
            "#,
        )
        .bind(id)
        .bind(summary)
        .bind(before_bytes)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;

        // `updated_at` is deliberately NOT bumped. It means "when did someone
        // last change what we know", and compaction changes how it is said, not
        // what it says — bumping it would make every compacted node look freshly
        // authored and reset its own eligibility for the next pass.
        Ok(Some(CompactResult {
            label,
            level: level + 1,
            before_bytes,
            after_bytes: summary.len() as i32,
        }))
    }

    /// Put back the text a compaction replaced, one level at a time.
    ///
    /// Consumes the snapshot it restores from: the row it puts back is the row
    /// that would otherwise be restored again, and leaving it would make a
    /// second restore silently a no-op that looked like a success.
    pub async fn restore(&self, reference: &str) -> Result<Option<String>> {
        let Some(id) = self.resolve_ref(reference, &KNOWLEDGE_KINDS).await? else {
            return Ok(None);
        };
        let mut tx = self.pool.begin().await?;
        let Some((snap_id, label, body)) = sqlx::query_as::<_, (Uuid, String, Option<String>)>(
            r#"
            SELECT id, label, body FROM kg_node_snapshot
            WHERE node_id = $1
            ORDER BY compaction_level DESC, created_at DESC
            LIMIT 1
            "#,
        )
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        else {
            return Ok(None);
        };

        sqlx::query(
            r#"
            UPDATE kg_node
            SET label = $2,
                body = $3,
                compaction_level = greatest(compaction_level - 1, 0),
                compacted_at = CASE WHEN compaction_level - 1 <= 0 THEN NULL ELSE compacted_at END,
                original_bytes = CASE WHEN compaction_level - 1 <= 0 THEN NULL ELSE original_bytes END
            WHERE id = $1
            "#,
        )
        .bind(id)
        .bind(&label)
        .bind(&body)
        .execute(&mut *tx)
        .await?;
        sqlx::query("DELETE FROM kg_node_snapshot WHERE id = $1")
            .bind(snap_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(Some(label))
    }

    // ── export / import (the graph is not only in Docker) ─────────────────────

    /// Rows read per round trip. Keeps a large graph off the heap in one go
    /// without making the export a thousand tiny queries.
    const EXPORT_PAGE: i64 = 500;

    /// Write the whole graph as JSONL — one object per line, `type`-tagged so a
    /// single file carries nodes, snapshots and edges.
    ///
    /// This exists because the engine is a Docker volume, and a Docker volume is
    /// one `docker volume rm` away from being the only copy of everything a team
    /// ever learned. The format is deliberately dull: no compression, no binary,
    /// one JSON object per line, readable with `grep` and restorable with
    /// [`import_jsonl`](Self::import_jsonl).
    ///
    /// Read inside one REPEATABLE READ transaction, so a write landing halfway
    /// through cannot produce a file with an edge whose node is missing.
    ///
    /// Embeddings are omitted. They are 384 floats per node, derived from the
    /// text in the same row, and regenerated by the local embedder on demand —
    /// carrying them would multiply the file size to preserve nothing.
    /// Telemetry (`kg_event`, `kg_usage_snapshot`, `kg_outcome`) is omitted too:
    /// it is analytics about the graph rather than the knowledge in it.
    pub async fn export_jsonl<W: std::io::Write>(&self, out: &mut W) -> Result<ExportStats> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            .execute(&mut *tx)
            .await?;

        let mut stats = ExportStats::default();
        writeln!(
            out,
            "{}",
            json!({
                "type": "meta",
                "format": "flock-kg-jsonl",
                "version": 1,
                "exported_at": Utc::now().to_rfc3339(),
            })
        )?;

        let mut after: Option<Uuid> = None;
        loop {
            let rows = sqlx::query_as::<_, ExportNode>(
                r#"
                SELECT id, kind, label, body, workspace_id, created_by_agent, created_at,
                       updated_at, archived_at, outcome, shipped_in, org_id, team_id,
                       anchor_key, compaction_level, compacted_at, original_bytes
                FROM kg_node
                WHERE ($1::uuid IS NULL OR id > $1)
                ORDER BY id
                LIMIT $2
                "#,
            )
            .bind(after)
            .bind(Self::EXPORT_PAGE)
            .fetch_all(&mut *tx)
            .await?;
            let Some(last) = rows.last().map(|n| n.id) else { break };
            for n in &rows {
                let mut v = serde_json::to_value(n)?;
                v["type"] = json!("node");
                writeln!(out, "{v}")?;
                stats.nodes += 1;
            }
            after = Some(last);
        }

        // Snapshots ride along, and they are not optional: without them an
        // exported graph keeps every compacted summary and none of the originals
        // they replaced, quietly turning a reversible compaction into a
        // permanent one at the exact moment the backup is relied on.
        let mut after: Option<Uuid> = None;
        loop {
            let rows = sqlx::query_as::<_, ExportSnapshot>(
                r#"
                SELECT id, node_id, compaction_level, label, body, created_at
                FROM kg_node_snapshot
                WHERE ($1::uuid IS NULL OR id > $1)
                ORDER BY id
                LIMIT $2
                "#,
            )
            .bind(after)
            .bind(Self::EXPORT_PAGE)
            .fetch_all(&mut *tx)
            .await?;
            let Some(last) = rows.last().map(|s| s.id) else { break };
            for s in &rows {
                let mut v = serde_json::to_value(s)?;
                v["type"] = json!("snapshot");
                writeln!(out, "{v}")?;
                stats.snapshots += 1;
            }
            after = Some(last);
        }

        let mut after: Option<Uuid> = None;
        loop {
            let rows = sqlx::query_as::<_, ExportEdge>(
                r#"
                SELECT id, from_node_id, to_node_id, edge_type, created_at
                FROM kg_edge
                WHERE ($1::uuid IS NULL OR id > $1)
                ORDER BY id
                LIMIT $2
                "#,
            )
            .bind(after)
            .bind(Self::EXPORT_PAGE)
            .fetch_all(&mut *tx)
            .await?;
            let Some(last) = rows.last().map(|e| e.id) else { break };
            for e in &rows {
                let mut v = serde_json::to_value(e)?;
                v["type"] = json!("edge");
                writeln!(out, "{v}")?;
                stats.edges += 1;
            }
            after = Some(last);
        }

        tx.commit().await?;
        out.flush()?;
        Ok(stats)
    }

    /// Read a file written by [`export_jsonl`](Self::export_jsonl) back in.
    ///
    /// Additive and non-destructive: rows are inserted under their original
    /// UUIDs and anything already present is left exactly as it is. Restoring
    /// into an empty graph rebuilds it; restoring into a live one fills the gaps
    /// and touches nothing else. That asymmetry is deliberate — a restore is
    /// reached for when something has already gone wrong, which is the worst
    /// moment to also be overwriting whatever survived.
    ///
    /// Nodes before edges, because an edge references two nodes and the
    /// foreign keys are real. Malformed lines are counted and skipped rather
    /// than aborting: a backup that is 99% readable should restore 99%, not
    /// nothing.
    pub async fn import_jsonl<R: std::io::BufRead>(&self, input: R) -> Result<ImportStats> {
        let mut stats = ImportStats::default();
        let mut edges: Vec<Value> = Vec::new();
        let mut snapshots: Vec<Value> = Vec::new();

        for line in input.lines() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            let Ok(v) = serde_json::from_str::<Value>(&line) else {
                stats.skipped += 1;
                continue;
            };
            match v.get("type").and_then(|t| t.as_str()) {
                Some("meta") => {}
                // Held back until every node is in: an edge inserted first would
                // fail its foreign key even though its node is three lines away.
                Some("edge") => edges.push(v),
                Some("snapshot") => snapshots.push(v),
                Some("node") => match self.import_node(&v).await {
                    Ok(true) => stats.nodes += 1,
                    Ok(false) => stats.existing += 1,
                    Err(e) => {
                        tracing::warn!("skipped a node on import: {e}");
                        stats.skipped += 1;
                    }
                },
                _ => stats.skipped += 1,
            }
        }

        for v in &snapshots {
            match self.import_snapshot(v).await {
                Ok(true) => stats.snapshots += 1,
                Ok(false) => stats.existing += 1,
                Err(e) => {
                    tracing::warn!("skipped a snapshot on import: {e}");
                    stats.skipped += 1;
                }
            }
        }
        for v in &edges {
            match self.import_edge(v).await {
                Ok(true) => stats.edges += 1,
                Ok(false) => stats.existing += 1,
                Err(e) => {
                    tracing::warn!("skipped an edge on import: {e}");
                    stats.skipped += 1;
                }
            }
        }
        Ok(stats)
    }

    /// True when the row was inserted, false when it was already there.
    async fn import_node(&self, v: &Value) -> Result<bool> {
        let n: ExportNode = serde_json::from_value(v.clone())?;
        let done = sqlx::query(
            r#"
            INSERT INTO kg_node (id, kind, label, body, workspace_id, created_by_agent,
                created_at, updated_at, archived_at, outcome, shipped_in, org_id, team_id,
                anchor_key, compaction_level, compacted_at, original_bytes)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
            ON CONFLICT (id) DO NOTHING
            "#,
        )
        .bind(n.id)
        .bind(&n.kind)
        .bind(&n.label)
        .bind(&n.body)
        .bind(&n.workspace_id)
        .bind(&n.created_by_agent)
        .bind(n.created_at)
        .bind(n.updated_at)
        .bind(n.archived_at)
        .bind(&n.outcome)
        .bind(&n.shipped_in)
        .bind(&n.org_id)
        .bind(&n.team_id)
        .bind(&n.anchor_key)
        .bind(n.compaction_level)
        .bind(n.compacted_at)
        .bind(n.original_bytes)
        .execute(&self.pool)
        .await?;
        Ok(done.rows_affected() > 0)
    }

    async fn import_snapshot(&self, v: &Value) -> Result<bool> {
        let s: ExportSnapshot = serde_json::from_value(v.clone())?;
        let done = sqlx::query(
            r#"
            INSERT INTO kg_node_snapshot (id, node_id, compaction_level, label, body, created_at)
            VALUES ($1,$2,$3,$4,$5,$6)
            ON CONFLICT (id) DO NOTHING
            "#,
        )
        .bind(s.id)
        .bind(s.node_id)
        .bind(s.compaction_level)
        .bind(&s.label)
        .bind(&s.body)
        .bind(s.created_at)
        .execute(&self.pool)
        .await?;
        Ok(done.rows_affected() > 0)
    }

    async fn import_edge(&self, v: &Value) -> Result<bool> {
        let e: ExportEdge = serde_json::from_value(v.clone())?;
        // Two conflict targets in play: the primary key, and the
        // (from, to, edge_type) uniqueness that stops a duplicate association.
        // A bare DO NOTHING covers both.
        let done = sqlx::query(
            r#"
            INSERT INTO kg_edge (id, from_node_id, to_node_id, edge_type, created_at)
            VALUES ($1,$2,$3,$4,$5)
            ON CONFLICT DO NOTHING
            "#,
        )
        .bind(e.id)
        .bind(e.from_node_id)
        .bind(e.to_node_id)
        .bind(&e.edge_type)
        .bind(e.created_at)
        .execute(&self.pool)
        .await?;
        Ok(done.rows_affected() > 0)
    }

    // ── link (arbitrary association between two nodes) ─────────────────────────

    pub async fn link(&self, req: LinkReq) -> Result<()> {
        sqlx::query(
            r#"
            INSERT INTO kg_edge (from_node_id, to_node_id, edge_type)
            VALUES ($1, $2, $3)
            ON CONFLICT DO NOTHING
            "#,
        )
        .bind(req.from_node_id)
        .bind(req.to_node_id)
        .bind(&req.edge_type)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    // ── workspace_brief (grounding text injected at session start) ─────────────

    /// A compact, human-readable brief of what's already known in this
    /// workspace: current decisions (with shipped markers), conventions, and
    /// approaches that failed. Returned as plain text to drop straight into
    /// an agent's context.
    pub async fn workspace_brief(&self, workspace_id: &str) -> Result<String> {
        // Current decisions only (superseded/archived filtered), each with the
        // files it governs so the agent knows where it bites, and its shipped
        // stamp when the decision made it into a merged PR.
        let decisions = sqlx::query_as::<_, (String, Option<String>, String, Option<String>)>(
            r#"SELECT n.label, n.body,
                      coalesce(string_agg(DISTINCT f.label, ', ') FILTER (WHERE f.id IS NOT NULL), ''),
                      n.shipped_in
               FROM kg_node n
               LEFT JOIN kg_edge e ON e.from_node_id = n.id AND e.edge_type = 'ABOUT'
               LEFT JOIN kg_node f ON f.id = e.to_node_id
               WHERE n.kind='Decision' AND (n.workspace_id=$1 OR n.workspace_id='global')
                 AND n.archived_at IS NULL
                 AND NOT EXISTS (SELECT 1 FROM kg_edge se
                                 WHERE se.to_node_id = n.id AND se.edge_type='SUPERSEDES')
               GROUP BY n.id, n.label, n.body, n.shipped_in, n.updated_at
               ORDER BY n.updated_at DESC LIMIT 6"#,
        )
        .bind(workspace_id)
        .fetch_all(&self.pool)
        .await
        .unwrap_or_default();

        let notes = sqlx::query_as::<_, (String, Option<String>)>(
            r#"SELECT label, body FROM kg_node n
               WHERE kind IN ('Note','Interface') AND (workspace_id=$1 OR workspace_id='global')
                 AND archived_at IS NULL
                 AND NOT EXISTS (SELECT 1 FROM kg_edge se
                                 WHERE se.to_node_id = n.id AND se.edge_type='SUPERSEDES')
               ORDER BY updated_at DESC LIMIT 5"#,
        )
        .bind(workspace_id)
        .fetch_all(&self.pool)
        .await
        .unwrap_or_default();

        let attempts = sqlx::query_as::<_, (String, Option<String>, Option<String>)>(
            r#"SELECT label, body, outcome FROM kg_node
               WHERE kind='Attempt' AND workspace_id=$1
                 AND archived_at IS NULL
                 AND coalesce(outcome, '') != 'success'
               ORDER BY updated_at DESC LIMIT 6"#,
        )
        .bind(workspace_id)
        .fetch_all(&self.pool)
        .await
        .unwrap_or_default();

        if decisions.is_empty() && attempts.is_empty() && notes.is_empty() {
            return Ok(String::new());
        }

        let mut out = String::from("Shared knowledge graph. What's already known in this workspace:\n");
        if !decisions.is_empty() {
            out.push_str("\nDecisions on record (current — superseded ones excluded):\n");
            for (label, body, about, shipped) in &decisions {
                match body {
                    Some(b) if !b.is_empty() => out.push_str(&format!("- {label}: {b}")),
                    _ => out.push_str(&format!("- {label}")),
                }
                if !about.is_empty() {
                    out.push_str(&format!(" [re {about}]"));
                }
                if let Some(s) = shipped.as_deref().filter(|s| !s.is_empty()) {
                    out.push_str(&format!(" [shipped: {s}]"));
                }
                out.push('\n');
            }
        }
        if !notes.is_empty() {
            out.push_str("\nConventions & facts on record:\n");
            for (label, body) in &notes {
                match body {
                    Some(b) if !b.is_empty() => out.push_str(&format!("- {label}: {b}\n")),
                    _ => out.push_str(&format!("- {label}\n")),
                }
            }
        }
        if !attempts.is_empty() {
            out.push_str("\nApproaches already tried (don't repeat these):\n");
            for (label, notes, outcome) in &attempts {
                let outcome = outcome.as_deref().unwrap_or("unknown");
                match notes {
                    Some(n) if !n.is_empty() => out.push_str(&format!("- {label} ({outcome}): {n}\n")),
                    _ => out.push_str(&format!("- {label} ({outcome})\n")),
                }
            }
        }
        Ok(out)
    }

    // ── query (hybrid: FTS tiers + semantic neighbors, RRF-fused) ─────────────

    pub async fn query(&self, req: QueryReq) -> Result<Vec<KgNode>> {
        let limit = req.limit.unwrap_or(10).min(50);
        // scope:"all" searches every workspace; default scopes to the caller's
        // workspace + global + unscoped (file-anchor) nodes.
        let ws = if req.scope.as_deref() == Some("all") {
            None
        } else {
            req.workspace_id.as_deref().filter(|w| !w.is_empty())
        };

        // Relevance-ranked FTS. plainto/websearch AND all terms together, so
        // a no-hit result falls back to an OR of the distinctive words, then
        // to a plain label substring match — a query should degrade towards
        // recall, not return nothing because one word missed.
        let mut rows = self
            .query_fts(&req.query, req.kind.as_deref(), ws, req.include_superseded, limit)
            .await?;
        if rows.is_empty() {
            let or_query = keywords(&req.query, 8).join(" OR ");
            if !or_query.is_empty() {
                rows = self
                    .query_fts(&or_query, req.kind.as_deref(), ws, req.include_superseded, limit)
                    .await?;
            }
        }
        if rows.is_empty() {
            rows = sqlx::query_as::<_, RawNode>(&format!(
                r#"
                SELECT {NODE_COLS}
                FROM kg_node n
                WHERE ($1::text IS NULL OR kind = $1)
                  AND ($2::text IS NULL OR workspace_id = $2 OR workspace_id = 'global' OR workspace_id IS NULL)
                  AND archived_at IS NULL
                  AND ($3::bool OR NOT EXISTS (
                        SELECT 1 FROM kg_edge se
                        WHERE se.to_node_id = n.id AND se.edge_type = 'SUPERSEDES'))
                  AND label ILIKE '%' || $4 || '%'
                ORDER BY updated_at DESC
                LIMIT $5
                "#
            ))
            .bind(req.kind.as_deref())
            .bind(ws)
            .bind(req.include_superseded)
            .bind(req.query.trim())
            .bind(limit)
            .fetch_all(&self.pool)
            .await?;
        }

        // Semantic leg: embed the query iff the local embedder is already
        // warm (try_embed never blocks) and reciprocal-rank-fuse the cosine
        // neighbors with the FTS tiers above. A cold/failed embedder, or a
        // vector-side error (engine predating the embedding DDL), keeps
        // exactly the FTS result.
        if let Some(qvec) = embed::try_embed(req.query.trim()).await {
            let semantic = self
                .query_vector(
                    pgvector::Vector::from(qvec),
                    req.kind.as_deref(),
                    ws,
                    req.include_superseded,
                    limit,
                )
                .await
                .unwrap_or_default();
            rows = fuse_by_rrf(rows, semantic, limit as usize);
        }

        Ok(rows.into_iter().map(|r| r.into_kg_node()).collect())
    }

    async fn query_fts(
        &self,
        query: &str,
        kind: Option<&str>,
        ws: Option<&str>,
        include_superseded: bool,
        limit: i64,
    ) -> Result<Vec<RawNode>> {
        Ok(sqlx::query_as::<_, RawNode>(&format!(
            r#"
            SELECT {NODE_COLS}
            FROM kg_node n
            WHERE ($1::text IS NULL OR kind = $1)
              AND ($2::text IS NULL OR workspace_id = $2 OR workspace_id = 'global' OR workspace_id IS NULL)
              AND archived_at IS NULL
              AND ($3::bool OR NOT EXISTS (
                    SELECT 1 FROM kg_edge se
                    WHERE se.to_node_id = n.id AND se.edge_type = 'SUPERSEDES'))
              AND to_tsvector('english', coalesce(label,'') || ' ' || coalesce(body,''))
                  @@ websearch_to_tsquery('english', $4)
            ORDER BY ts_rank(
                       to_tsvector('english', coalesce(label,'') || ' ' || coalesce(body,'')),
                       websearch_to_tsquery('english', $4)) DESC,
                     updated_at DESC
            LIMIT $5
            "#
        ))
        .bind(kind)
        .bind(ws)
        .bind(include_superseded)
        .bind(query)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?)
    }

    /// The semantic leg of hybrid search: nearest neighbors by cosine
    /// distance over embedded nodes, under the same kind/scope/superseded
    /// filters as `query_fts`. Nodes without an embedding (written before
    /// the embedder warmed, backfill pending) can't appear here — the FTS
    /// leg still covers them.
    async fn query_vector(
        &self,
        query_vec: pgvector::Vector,
        kind: Option<&str>,
        ws: Option<&str>,
        include_superseded: bool,
        limit: i64,
    ) -> Result<Vec<RawNode>> {
        Ok(sqlx::query_as::<_, RawNode>(&format!(
            r#"
            SELECT {NODE_COLS}
            FROM kg_node n
            WHERE embedding IS NOT NULL
              AND ($1::text IS NULL OR kind = $1)
              AND ($2::text IS NULL OR workspace_id = $2 OR workspace_id = 'global' OR workspace_id IS NULL)
              AND archived_at IS NULL
              AND ($3::bool OR NOT EXISTS (
                    SELECT 1 FROM kg_edge se
                    WHERE se.to_node_id = n.id AND se.edge_type = 'SUPERSEDES'))
            ORDER BY embedding <=> $4
            LIMIT $5
            "#
        ))
        .bind(kind)
        .bind(ws)
        .bind(include_superseded)
        .bind(query_vec)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?)
    }

    // ── related (recursive CTE graph traversal) ───────────────────────────────

    pub async fn related(&self, req: RelatedReq) -> Result<Vec<KgNode>> {
        let depth = req.depth.unwrap_or(2).min(5) as i64;

        let rows = if let Some(edge_type) = &req.edge_type {
            sqlx::query_as::<_, RawNode>(&format!(
                r#"
                WITH RECURSIVE reachable (node_id, depth) AS (
                    SELECT to_node_id, 1 FROM kg_edge
                    WHERE from_node_id = $1 AND edge_type = $2
                    UNION ALL
                    SELECT e.to_node_id, r.depth + 1
                    FROM kg_edge e
                    JOIN reachable r ON e.from_node_id = r.node_id
                    WHERE r.depth < $3 AND e.edge_type = $2
                )
                SELECT DISTINCT {COLS}
                FROM kg_node n
                JOIN reachable r ON n.id = r.node_id
                "#,
                COLS = node_cols_prefixed("n")
            ))
            .bind(req.node_id)
            .bind(edge_type)
            .bind(depth)
            .fetch_all(&self.pool)
            .await?
        } else {
            sqlx::query_as::<_, RawNode>(&format!(
                r#"
                WITH RECURSIVE reachable (node_id, depth) AS (
                    SELECT to_node_id, 1 FROM kg_edge WHERE from_node_id = $1
                    UNION ALL
                    SELECT e.to_node_id, r.depth + 1
                    FROM kg_edge e
                    JOIN reachable r ON e.from_node_id = r.node_id
                    WHERE r.depth < $2
                )
                SELECT DISTINCT {COLS}
                FROM kg_node n
                JOIN reachable r ON n.id = r.node_id
                "#,
                COLS = node_cols_prefixed("n")
            ))
            .bind(req.node_id)
            .bind(depth)
            .fetch_all(&self.pool)
            .await?
        };

        Ok(rows.into_iter().map(|r| r.into_kg_node()).collect())
    }

    // ── links_for (edge enrichment for query results) ─────────────────────────

    /// Every edge touching any of `ids`, with the far node's kind + label.
    /// Lets a caller render a hit *with its context* ("about src/App.tsx ·
    /// superseded by …") in one extra round-trip.
    pub async fn links_for(&self, ids: &[Uuid]) -> Result<Vec<NodeLink>> {
        if ids.is_empty() {
            return Ok(vec![]);
        }
        let rows = sqlx::query_as::<_, (Uuid, String, String, String, String)>(
            r#"
            SELECT e.from_node_id, e.edge_type, 'out', n.kind, n.label
            FROM kg_edge e JOIN kg_node n ON n.id = e.to_node_id
            WHERE e.from_node_id = ANY($1)
            UNION ALL
            SELECT e.to_node_id, e.edge_type, 'in', n.kind, n.label
            FROM kg_edge e JOIN kg_node n ON n.id = e.from_node_id
            WHERE e.to_node_id = ANY($1)
            "#,
        )
        .bind(ids)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|(node_id, edge_type, direction, kind, label)| NodeLink {
                node_id,
                edge_type,
                direction,
                other_kind: NodeKind::from_str(&kind),
                other_label: label,
            })
            .collect())
    }

    // ── about_file (everything known about a path) ────────────────────────────

    /// The file-centric pivot: File nodes matching `path` (exact, or
    /// suffix-matched in either direction so relative and absolute spellings
    /// meet), each with its immediate neighborhood — every decision, attempt,
    /// and note recorded ABOUT it.
    pub async fn about_file(&self, path: &str) -> Result<Vec<FileKnowledge>> {
        let path = normalize_path(path);
        if path.is_empty() {
            return Ok(vec![]);
        }
        let files = sqlx::query_as::<_, RawNode>(&format!(
            r#"
            SELECT {NODE_COLS}
            FROM kg_node
            WHERE kind = 'File'
              AND (label = $1 OR label LIKE '%/' || $1 OR $1 LIKE '%/' || label)
            ORDER BY created_at DESC
            LIMIT 5
            "#
        ))
        .bind(&path)
        .fetch_all(&self.pool)
        .await?;

        let mut out = Vec::new();
        for f in files {
            let mut neighbors = self.neighbors(f.id).await?;
            // Archived knowledge stays out of the file's story.
            neighbors.retain(|nb| nb.node.archived_at.is_none());
            neighbors.truncate(24);
            out.push(FileKnowledge { file: f.into_kg_node(), neighbors });
        }
        Ok(out)
    }

    // ── context_pack (per-prompt grounding for the UserPromptSubmit hook) ─────

    /// A compact context block for one user prompt: knowledge attached to any
    /// file path the prompt mentions, plus relevance-ranked hits on its
    /// distinctive keywords. Empty string when the graph has nothing useful —
    /// callers inject nothing rather than noise. Designed to run on every
    /// prompt, so it stays a handful of indexed queries.
    pub async fn context_pack(&self, workspace_id: Option<&str>, prompt: &str) -> Result<ContextPack> {
        let mut lines: Vec<(Uuid, String)> = Vec::new();
        let mut seen: std::collections::HashSet<Uuid> = std::collections::HashSet::new();

        // Files named in the prompt → their attached knowledge.
        for tok in extract_path_tokens(prompt, 4) {
            for fk in self.about_file(&tok).await.unwrap_or_default().into_iter().take(2) {
                for nb in fk.neighbors.iter().take(8) {
                    if nb.edge_type == "ABOUT" && seen.insert(nb.node.id) {
                        lines.push((nb.node.id, render_node_line(&nb.node, Some(&fk.file.label))));
                    }
                }
            }
        }

        // Distinctive prompt keywords → ranked FTS hits, fused with cosine
        // neighbors of the whole prompt when the local embedder is warm.
        // try_embed never blocks and a warm bge-small embeds a prompt in
        // single-digit ms, so this stays well inside the grounding hook's
        // 1.5s budget; a cold embedder means FTS-only, the old behavior.
        let kw = keywords(prompt, 8);
        let fts_hits = if kw.is_empty() {
            Vec::new()
        } else {
            self.query_fts(&kw.join(" OR "), None, workspace_id, false, PACK_PROBE)
                .await
                .unwrap_or_default()
        };
        let semantic_hits = match embed::try_embed(prompt).await {
            Some(qvec) => self
                .query_vector(pgvector::Vector::from(qvec), None, workspace_id, false, PACK_PROBE)
                .await
                .unwrap_or_default(),
            None => Vec::new(),
        };
        for n in fuse_by_rrf(fts_hits, semantic_hits, PACK_PROBE as usize) {
            if KNOWLEDGE_KINDS.contains(&n.kind.as_str()) && seen.insert(n.id) {
                let node = n.into_kg_node();
                lines.push((node.id, render_node_line(&node, None)));
            }
        }

        let texts: Vec<String> = lines.iter().map(|(_, l)| l.clone()).collect();
        let (text, shown) = render_context_pack(&texts);
        // The ids recorded are the ones that *fit*, never the ones retrieved.
        // A pass that matched twenty and showed ten grounded the agent in ten;
        // logging all twenty would inflate every recall count with facts the
        // agent never saw, which is exactly the kind of flattering number this
        // whole readout exists to replace.
        Ok(ContextPack {
            text,
            fact_ids: lines.into_iter().take(shown).map(|(id, _)| id).collect(),
        })
    }

    // ── recall (what grounding actually put in front of agents) ───────────────

    /// The last `limit` grounding passes, newest first, each with the facts it
    /// injected resolved to their current state.
    ///
    /// Only passes recorded since `fact_ids` existed are returned (`IS NOT
    /// NULL`). An older graph has rows whose `grounding_hits` says five facts
    /// were shown and cannot say which — rendering those as empty passes would
    /// claim recall found nothing, which is the opposite of what happened.
    ///
    /// Two round trips rather than a lateral join: the ids arrive as arrays,
    /// and resolving them in one `= ANY` keeps the per-pass ordering (the order
    /// the agent read them in) instead of letting the join decide it.
    pub async fn recent_groundings(
        &self,
        workspace_id: Option<&str>,
        limit: i64,
    ) -> Result<Vec<GroundingPass>> {
        let rows: Vec<(DateTime<Utc>, Option<String>, Option<String>, Vec<Uuid>)> =
            sqlx::query_as(
                r#"
                SELECT ts, workspace_id, agent_id, fact_ids
                FROM kg_event
                WHERE kind = 'ground' AND fact_ids IS NOT NULL
                  AND ($1::text IS NULL OR workspace_id = $1)
                ORDER BY ts DESC
                LIMIT $2
                "#,
            )
            .bind(workspace_id)
            .bind(limit.clamp(1, 200))
            .fetch_all(&self.pool)
            .await?;

        let ids: Vec<Uuid> = {
            let mut seen = std::collections::HashSet::new();
            rows.iter().flat_map(|(_, _, _, f)| f.iter().copied()).filter(|id| seen.insert(*id)).collect()
        };
        if ids.is_empty() {
            return Ok(rows
                .into_iter()
                .map(|(ts, workspace_id, agent_id, _)| GroundingPass { ts, workspace_id, agent_id, facts: Vec::new() })
                .collect());
        }

        let facts: Vec<(Uuid, String, String, Option<String>, bool, bool)> = sqlx::query_as(
            r#"
            SELECT n.id, n.kind, n.label, n.body,
                   n.archived_at IS NOT NULL,
                   EXISTS (SELECT 1 FROM kg_edge se
                           WHERE se.to_node_id = n.id AND se.edge_type = 'SUPERSEDES')
            FROM kg_node n
            WHERE n.id = ANY($1)
            "#,
        )
        .bind(&ids)
        .fetch_all(&self.pool)
        .await?;
        let by_id: std::collections::HashMap<Uuid, GroundedFact> = facts
            .into_iter()
            .map(|(id, kind, label, body, archived, superseded)| {
                (id, GroundedFact { id, kind, label, body, archived, superseded })
            })
            .collect();

        Ok(rows
            .into_iter()
            .map(|(ts, workspace_id, agent_id, fact_ids)| GroundingPass {
                ts,
                workspace_id,
                agent_id,
                // A hard-deleted node drops out rather than rendering as a
                // blank row; the pass still counts, it just has one fewer fact
                // than it did on the day.
                facts: fact_ids.into_iter().filter_map(|id| by_id.get(&id).cloned()).collect(),
            })
            .collect())
    }

    /// Recall counts per fact since `since`, most-recalled first. Facts nothing
    /// has retrieved are simply absent — the caller compares against the live
    /// node count to say how much of the graph is dead weight.
    pub async fn recall_counts(
        &self,
        workspace_id: Option<&str>,
        since: DateTime<Utc>,
        limit: i64,
    ) -> Result<Vec<RecallCount>> {
        Ok(sqlx::query_as::<_, (Uuid, String, String, i64)>(
            r#"
            SELECT n.id, n.kind, n.label, count(*)
            FROM kg_event e
            CROSS JOIN LATERAL unnest(e.fact_ids) AS f(id)
            JOIN kg_node n ON n.id = f.id
            WHERE e.kind = 'ground' AND e.fact_ids IS NOT NULL AND e.ts >= $2
              AND ($1::text IS NULL OR e.workspace_id = $1)
            GROUP BY n.id, n.kind, n.label
            ORDER BY count(*) DESC, max(e.ts) DESC
            LIMIT $3
            "#,
        )
        .bind(workspace_id)
        .bind(since)
        .bind(limit.clamp(1, 200))
        .fetch_all(&self.pool)
        .await?
        .into_iter()
        .map(|(id, kind, label, recalls)| RecallCount { id, kind, label, recalls })
        .collect())
    }

    /// The honest recall figures over a window — see [`RecallStats`] for what
    /// each one counts and, more importantly, what none of them proves.
    ///
    /// Three round trips because they answer three different questions and one
    /// clever query would tie them together wrongly: the pass counts come from
    /// the event log, coverage's numerator is a join from events into nodes,
    /// and its denominator is a property of the graph *now*, with no reference
    /// to the window at all. That last one is the point — knowledge recorded
    /// and never read has to stay in the denominator, or coverage measures
    /// recall against recall and prints 100% forever.
    ///
    /// The numerator is filtered to live, in-scope knowledge nodes so it is a
    /// strict subset of the denominator. Without that, injecting a fact that
    /// was afterwards forgotten would push coverage past 100% precisely when
    /// the graph was at its least trustworthy.
    pub async fn recall_stats(
        &self,
        workspace_id: Option<&str>,
        since: DateTime<Utc>,
    ) -> Result<RecallStats> {
        let (ground_passes, passes_with_facts, facts_injected, passes_unrecorded): (i64, i64, i64, i64) =
            sqlx::query_as(
                r#"
                SELECT
                  count(*) FILTER (WHERE fact_ids IS NOT NULL),
                  count(*) FILTER (WHERE fact_ids IS NOT NULL AND cardinality(fact_ids) > 0),
                  coalesce(sum(cardinality(fact_ids)), 0),
                  count(*) FILTER (WHERE fact_ids IS NULL)
                FROM kg_event
                WHERE kind = 'ground' AND ts >= $2
                  AND ($1::text IS NULL OR workspace_id = $1)
                "#,
            )
            .bind(workspace_id)
            .bind(since)
            .fetch_one(&self.pool)
            .await?;

        let facts_recalled: i64 = sqlx::query_scalar(
            r#"
            SELECT count(DISTINCT n.id)
            FROM kg_event e
            CROSS JOIN LATERAL unnest(e.fact_ids) AS f(id)
            JOIN kg_node n ON n.id = f.id
            WHERE e.kind = 'ground' AND e.fact_ids IS NOT NULL AND e.ts >= $2
              AND ($1::text IS NULL OR e.workspace_id = $1)
              AND n.archived_at IS NULL
              AND n.kind = ANY($3)
              AND ($1::text IS NULL OR n.workspace_id = $1)
            "#,
        )
        .bind(workspace_id)
        .bind(since)
        .bind(KNOWLEDGE_KINDS)
        .fetch_one(&self.pool)
        .await?;

        let knowledge_total: i64 = sqlx::query_scalar(
            r#"
            SELECT count(*) FROM kg_node
            WHERE archived_at IS NULL AND kind = ANY($2)
              AND ($1::text IS NULL OR workspace_id = $1)
            "#,
        )
        .bind(workspace_id)
        .bind(KNOWLEDGE_KINDS)
        .fetch_one(&self.pool)
        .await?;

        Ok(RecallStats {
            ground_passes,
            passes_with_facts,
            silent_passes: ground_passes - passes_with_facts,
            facts_injected,
            facts_recalled,
            knowledge_total,
            passes_unrecorded,
        })
    }

    /// Aggregate stats for a sidebar-sized summary. When `workspace_id` is
    /// given, counts are scoped to that workspace; the latest node is
    /// workspace-scoped too so the "pulse" reflects what *these* agents are
    /// doing, not global noise. Archived knowledge is excluded everywhere.
    pub async fn workspace_stats(&self, workspace_id: Option<&str>) -> Result<GraphStats> {
        let counts = sqlx::query_as::<_, (String, i64)>(
            r#"
            SELECT kind, count(*) FROM kg_node
            WHERE ($1::text IS NULL OR workspace_id = $1)
              AND archived_at IS NULL
            GROUP BY kind
            "#,
        )
        .bind(workspace_id)
        .fetch_all(&self.pool)
        .await?;

        let mut stats = GraphStats::default();
        for (kind, n) in counts {
            stats.total += n;
            match kind.as_str() {
                "Decision" => stats.decisions = n,
                "Attempt" => stats.attempts = n,
                "File" => stats.files = n,
                // Free-form knowledge agents remember (kg_remember defaults to
                // Note; Interface is a remembered API/type contract).
                "Note" | "Interface" => stats.notes += n,
                _ => {}
            }
        }

        // Distinct authors of knowledge in scope — provenance metadata, not
        // graph structure, so it's a column aggregate.
        stats.contributors = sqlx::query_scalar(
            r#"
            SELECT count(DISTINCT created_by_agent) FROM kg_node
            WHERE ($1::text IS NULL OR workspace_id = $1)
              AND archived_at IS NULL
              AND created_by_agent IS NOT NULL AND created_by_agent != ''
              AND kind IN ('Decision','Attempt','Note','Interface')
            "#,
        )
        .bind(workspace_id)
        .fetch_one(&self.pool)
        .await
        .unwrap_or(0);

        stats.latest = sqlx::query_as::<_, RawNode>(&format!(
            r#"
            SELECT {NODE_COLS}
            FROM kg_node
            WHERE ($1::text IS NULL OR workspace_id = $1)
              AND archived_at IS NULL
              AND kind IN ('Decision', 'Attempt', 'File', 'Note', 'Interface')
            ORDER BY updated_at DESC
            LIMIT 1
            "#
        ))
        .bind(workspace_id)
        .fetch_optional(&self.pool)
        .await?
        .map(|r| r.into_kg_node());

        Ok(stats)
    }
}

/// Sidebar-sized graph summary (see workspace_stats).
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct GraphStats {
    pub total: i64,
    pub decisions: i64,
    pub attempts: i64,
    pub files: i64,
    /// Free-form remembered knowledge (Note + Interface nodes).
    pub notes: i64,
    /// Distinct authors (agents) of knowledge in this scope.
    pub contributors: i64,
    pub latest: Option<KgNode>,
}

/// A node reached from another, with the edge that connects them. `direction`
/// is "out" when the anchor node is the edge's source, "in" when it's the
/// target — so the explorer can render "SUPERSEDES →" vs "← ABOUT".
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KgNeighbor {
    pub node: KgNode,
    pub edge_type: String,
    pub direction: String,
}

/// A directed edge between two nodes (for the force-graph view).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KgEdge {
    pub from: Uuid,
    pub to: Uuid,
    pub edge_type: String,
}

/// One edge touching an anchor node, with the far node's identity — the unit
/// of query-result enrichment (see links_for).
#[derive(Debug, Clone, Serialize)]
pub struct NodeLink {
    pub node_id: Uuid,
    pub edge_type: String,
    /// "out" when the anchor is the edge source, "in" when it's the target.
    pub direction: String,
    pub other_kind: NodeKind,
    pub other_label: String,
}

/// A File node plus its immediate neighborhood (see about_file).
#[derive(Debug, Clone, Serialize)]
pub struct FileKnowledge {
    pub file: KgNode,
    pub neighbors: Vec<KgNeighbor>,
}

/// A bounded slice of the graph: a set of nodes plus every edge that runs
/// between two of them. Feeds the explorer's force-directed map.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Subgraph {
    pub nodes: Vec<KgNode>,
    pub edges: Vec<KgEdge>,
}

impl KnowledgeGraph {
    /// Browse or search nodes for the Graph Explorer. With `query` set it's a
    /// hybrid search (full-text fused with semantic neighbors when the local
    /// embedder is warm); without, it's the most recently touched nodes.
    /// `workspace_id` and `kind` are optional filters; archived knowledge is
    /// excluded.
    pub async fn list_nodes(
        &self,
        workspace_id: Option<&str>,
        kind: Option<&str>,
        query: Option<&str>,
        limit: i64,
    ) -> Result<Vec<KgNode>> {
        let limit = limit.clamp(1, 500);
        // Treat an empty/whitespace query as "no query" (browse mode).
        let query = query.map(str::trim).filter(|q| !q.is_empty());
        let mut rows = sqlx::query_as::<_, RawNode>(&format!(
            r#"
            SELECT {NODE_COLS}
            FROM kg_node
            WHERE ($1::text IS NULL OR workspace_id = $1 OR workspace_id = 'global')
              AND ($2::text IS NULL OR kind = $2)
              AND archived_at IS NULL
              AND ($3::text IS NULL
                   OR to_tsvector('english', coalesce(label,'') || ' ' || coalesce(body,''))
                      @@ plainto_tsquery('english', $3))
            ORDER BY updated_at DESC
            LIMIT $4
            "#
        ))
        .bind(workspace_id)
        .bind(kind)
        .bind(query)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        // Semantic leg, search mode only. Mirrors the filter semantics of the
        // FTS arm above (explorer scope: workspace + global, no unscoped
        // rows); a cold embedder or vector-side error keeps the FTS result.
        if let Some(q) = query {
            if let Some(qvec) = embed::try_embed(q).await {
                let semantic = sqlx::query_as::<_, RawNode>(&format!(
                    r#"
                    SELECT {NODE_COLS}
                    FROM kg_node
                    WHERE embedding IS NOT NULL
                      AND ($1::text IS NULL OR workspace_id = $1 OR workspace_id = 'global')
                      AND ($2::text IS NULL OR kind = $2)
                      AND archived_at IS NULL
                    ORDER BY embedding <=> $3
                    LIMIT $4
                    "#
                ))
                .bind(workspace_id)
                .bind(kind)
                .bind(pgvector::Vector::from(qvec))
                .bind(limit)
                .fetch_all(&self.pool)
                .await
                .unwrap_or_default();
                rows = fuse_by_rrf(rows, semantic, limit as usize);
            }
        }
        Ok(rows.into_iter().map(|r| r.into_kg_node()).collect())
    }

    /// One node by id (with body), for the explorer's detail pane.
    pub async fn node(&self, id: Uuid) -> Result<Option<KgNode>> {
        let row = sqlx::query_as::<_, RawNode>(&format!(
            "SELECT {NODE_COLS} FROM kg_node WHERE id = $1"
        ))
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|r| r.into_kg_node()))
    }

    /// Immediate neighbors of a node in both directions, each tagged with the
    /// connecting edge type and whether it points out from or into the node.
    pub async fn neighbors(&self, id: Uuid) -> Result<Vec<KgNeighbor>> {
        let cols = node_cols_prefixed("n");
        let rows = sqlx::query_as::<_, RawNeighbor>(&format!(
            r#"
            SELECT {cols}, e.edge_type, 'out' AS direction
            FROM kg_edge e JOIN kg_node n ON n.id = e.to_node_id
            WHERE e.from_node_id = $1
            UNION ALL
            SELECT {cols}, e.edge_type, 'in' AS direction
            FROM kg_edge e JOIN kg_node n ON n.id = e.from_node_id
            WHERE e.to_node_id = $1
            "#
        ))
        .bind(id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| KgNeighbor {
                edge_type: r.edge_type,
                direction: r.direction,
                node: RawNode {
                    id: r.id,
                    kind: r.kind,
                    label: r.label,
                    body: r.body,
                    workspace_id: r.workspace_id,
                    created_by_agent: r.created_by_agent,
                    created_at: r.created_at,
                    updated_at: r.updated_at,
                    archived_at: r.archived_at,
                    outcome: r.outcome,
                    shipped_in: r.shipped_in,
                }
                .into_kg_node(),
            })
            .collect())
    }

    /// A bounded slice of the graph for the force-directed view: the most
    /// recent `limit` nodes in scope, plus every edge whose endpoints are both
    /// in that set. `workspace_id` optionally scopes to one workspace.
    pub async fn subgraph(&self, workspace_id: Option<&str>, limit: i64) -> Result<Subgraph> {
        let limit = limit.clamp(1, 400);
        let mut nodes = self.list_nodes(workspace_id, None, None, limit).await?;
        if nodes.is_empty() {
            return Ok(Subgraph { nodes, edges: vec![] });
        }
        let base_ids: Vec<Uuid> = nodes.iter().map(|n| n.id).collect();
        // Pull in the provenance hubs (Person, Repo) adjacent to the visible
        // nodes even though they fall outside the recency window list_nodes
        // returns. Without this the author/repo edges would have one endpoint
        // off-canvas and vanish — leaving the very isolation this fixes. Hubs
        // are the connective tissue, so they always ride along with their
        // neighbours.
        let hubs = sqlx::query_as::<_, RawNode>(&format!(
            r#"
            SELECT DISTINCT {COLS}
            FROM kg_node n
            JOIN kg_edge e ON e.to_node_id = n.id
            WHERE n.kind IN ('Person','Repo')
              AND n.archived_at IS NULL
              AND e.from_node_id = ANY($1)
            "#,
            COLS = node_cols_prefixed("n")
        ))
        .bind(&base_ids)
        .fetch_all(&self.pool)
        .await
        .unwrap_or_default();
        let mut seen: std::collections::HashSet<Uuid> = base_ids.iter().copied().collect();
        for h in hubs {
            let node = h.into_kg_node();
            if seen.insert(node.id) {
                nodes.push(node);
            }
        }
        let ids: Vec<Uuid> = nodes.iter().map(|n| n.id).collect();
        let edges = sqlx::query_as::<_, (Uuid, Uuid, String)>(
            r#"SELECT from_node_id, to_node_id, edge_type FROM kg_edge
               WHERE from_node_id = ANY($1) AND to_node_id = ANY($1)"#,
        )
        .bind(&ids)
        .fetch_all(&self.pool)
        .await?
        .into_iter()
        .map(|(from, to, edge_type)| KgEdge { from, to, edge_type })
        .collect();
        Ok(Subgraph { nodes, edges })
    }
}

// ─── Embedding backfill ───────────────────────────────────────────────────────

/// Fill `kg_node.embedding` where NULL, in small batches with a pause between
/// them, once the embedder has warmed. Spawned at most once per process (see
/// `init_embeddings`). Quiet by contract: only NULL rows are ever selected, so
/// any error simply ends the pass and the next process start resumes it, and
/// the per-pass batch cap keeps one process from grinding through a huge
/// graph in one sitting.
async fn backfill_embeddings(pool: PgPool) {
    // Wait out the warm (the first ever warm downloads the model weights).
    // A failed init means no embeddings this process — give up silently.
    loop {
        if embed::is_failed() {
            return;
        }
        if embed::is_ready() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
    for _ in 0..512 {
        // Newest first, so fresh knowledge becomes semantically searchable
        // before the archive does.
        let rows: Vec<(Uuid, String, Option<String>)> = match sqlx::query_as(
            "SELECT id, label, body FROM kg_node WHERE embedding IS NULL ORDER BY created_at DESC LIMIT 64",
        )
        .fetch_all(&pool)
        .await
        {
            Ok(r) => r,
            // Engine down or embedding column absent — nothing to do here.
            Err(_) => return,
        };
        if rows.is_empty() {
            return;
        }
        let texts: Vec<String> = rows
            .iter()
            .map(|(_, label, body)| embed::embed_input(label, body.as_deref()))
            .collect();
        let Some(vecs) = embed::try_embed_batch(texts).await else { return };
        for ((id, _, _), v) in rows.iter().zip(vecs) {
            // The IS NULL guard makes concurrent backfills (one per flock
            // process) idempotent rather than redundant writers.
            if sqlx::query("UPDATE kg_node SET embedding = $1 WHERE id = $2 AND embedding IS NULL")
                .bind(pgvector::Vector::from(v))
                .bind(*id)
                .execute(&pool)
                .await
                .is_err()
            {
                return;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(750)).await;
    }
}

// ─── Reciprocal-rank fusion (hybrid search) ───────────────────────────────────

/// RRF constant, k = 60 per Cormack et al. Larger k flattens rank positions
/// so appearing in both lists dominates; smaller k lets a single top rank
/// dominate instead.
const RRF_K: f64 = 60.0;

/// Pure reciprocal-rank fusion of two ranked id lists:
/// score(id) = Σ 1 / (k + rank) over the lists it appears in, rank 1-based.
/// Returns ids sorted by fused score, deduped; ties break toward earlier
/// first appearance so the result is deterministic.
fn rrf_ranks(first: &[Uuid], second: &[Uuid], k: f64) -> Vec<Uuid> {
    use std::collections::HashMap;
    let mut score: HashMap<Uuid, f64> = HashMap::new();
    let mut order: Vec<Uuid> = Vec::new();
    for list in [first, second] {
        for (i, id) in list.iter().enumerate() {
            let contrib = 1.0 / (k + (i + 1) as f64);
            if let Some(s) = score.get_mut(id) {
                *s += contrib;
            } else {
                score.insert(*id, contrib);
                order.push(*id);
            }
        }
    }
    let first_seen: HashMap<Uuid, usize> =
        order.iter().enumerate().map(|(i, id)| (*id, i)).collect();
    let mut out = order;
    out.sort_by(|a, b| {
        score[b]
            .partial_cmp(&score[a])
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| first_seen[a].cmp(&first_seen[b]))
    });
    out
}

/// Fuse the FTS and semantic result lists by RRF, deduping by node id and
/// capping at `limit`. Either list empty degrades to the other unchanged
/// (truncated), so a cold embedder or an FTS miss costs nothing.
fn fuse_by_rrf(fts: Vec<RawNode>, semantic: Vec<RawNode>, limit: usize) -> Vec<RawNode> {
    if semantic.is_empty() {
        let mut out = fts;
        out.truncate(limit);
        return out;
    }
    if fts.is_empty() {
        let mut out = semantic;
        out.truncate(limit);
        return out;
    }
    let fts_ids: Vec<Uuid> = fts.iter().map(|n| n.id).collect();
    let sem_ids: Vec<Uuid> = semantic.iter().map(|n| n.id).collect();
    // Duplicates across lists are the same DB row; either copy serves.
    let mut by_id: std::collections::HashMap<Uuid, RawNode> = semantic
        .into_iter()
        .chain(fts)
        .map(|n| (n.id, n))
        .collect();
    rrf_ranks(&fts_ids, &sem_ids, RRF_K)
        .into_iter()
        .filter_map(|id| by_id.remove(&id))
        .take(limit)
        .collect()
}

/// Light path normalization so "./src/App.tsx" and "src/App.tsx" land on the
/// same File node. Absolute vs. repo-relative can't be reconciled here (the
/// graph spans machines); suffix matching at read time bridges those.
fn normalize_path(p: &str) -> String {
    let p = p.trim().trim_end_matches('/');
    p.strip_prefix("./").unwrap_or(p).to_string()
}

/// `[[wikilink]]` targets inside body text — the zero-effort way to link
/// knowledge, borrowed from Obsidian. Each target is resolved as a label
/// fragment; unresolved links simply draw nothing (they may resolve when the
/// note they name is written later and someone re-saves).
fn extract_wikilinks(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("[[") {
        let after = &rest[start + 2..];
        let Some(end) = after.find("]]") else { break };
        let target = after[..end].trim();
        // Obsidian alias syntax "[[target|shown text]]" — link the target.
        let target = target.split('|').next().unwrap_or(target).trim();
        if !target.is_empty() && target.len() <= 120 && !out.iter().any(|t| t == target) {
            out.push(target.to_string());
            if out.len() >= 8 {
                break;
            }
        }
        rest = &after[end + 2..];
    }
    out
}

/// Tokens in free text that look like file paths ("src/App.tsx",
/// "Terminal.tsx") — the pivot the grounding hook uses to pull file-attached
/// knowledge. URLs and bare version numbers are excluded.
fn extract_path_tokens(text: &str, max: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw in text.split(|c: char| c.is_whitespace() || "\"'`()[]{}<>,;".contains(c)) {
        let t = raw.trim_matches(|c: char| ":?!*".contains(c));
        if t.len() < 3 || t.len() > 200 || t.starts_with("http") {
            continue;
        }
        let has_slash = t.contains('/') && !t.starts_with("//");
        let has_code_ext = t.rsplit_once('.').is_some_and(|(stem, ext)| {
            !stem.is_empty()
                && (1..=5).contains(&ext.len())
                && ext.chars().all(|c| c.is_ascii_alphanumeric())
                && ext.chars().any(|c| c.is_ascii_alphabetic())
        });
        if (has_slash || has_code_ext) && !out.iter().any(|o| o == t) {
            out.push(t.to_string());
            if out.len() >= max {
                break;
            }
        }
    }
    out
}

/// Distinctive lowercase words from free text, for OR full-text queries.
fn keywords(text: &str, max: usize) -> Vec<String> {
    const STOP: [&str; 48] = [
        "the", "and", "for", "with", "that", "this", "from", "have", "what", "when", "where",
        "how", "why", "can", "you", "your", "are", "was", "were", "will", "would", "should",
        "could", "into", "about", "them", "then", "than", "its", "not", "but", "all", "use",
        "using", "make", "also", "get", "one", "new", "just", "like", "some", "more", "very",
        "been", "does", "please", "there",
    ];
    let mut out: Vec<String> = Vec::new();
    for w in text.split(|c: char| !c.is_ascii_alphanumeric() && c != '_' && c != '-') {
        let w = w.to_ascii_lowercase();
        if w.len() < 3 || w.chars().all(|c| c.is_ascii_digit()) || STOP.contains(&w.as_str()) {
            continue;
        }
        if !out.contains(&w) {
            out.push(w);
            if out.len() >= max {
                break;
            }
        }
    }
    out
}

/// One compact context line for a node: kind (with attempt outcome), label,
/// trimmed body, author, age, shipped marker — and the file it was reached
/// through, when that adds signal.
/// Most lines a grounding block may carry, and the byte budget it must fit.
/// Both are context the agent pays for on every single prompt, so the block
/// stays small on purpose.
const PACK_MAX_LINES: usize = 10;
const PACK_MAX_BYTES: usize = 1800;

/// How many hits retrieval fetches, against the ten the block can show.
///
/// Fetching exactly what fits makes the overflow invisible: the count the agent
/// is told about can only come from hits that were actually retrieved, so a
/// query capped at the display size always reports "nothing withheld" no matter
/// how much matched. Reaching a little past the cap is what makes the number
/// true. The extra rows are ranked and discarded, which costs one wider query
/// on a path already budgeted at 1.5 seconds.
const PACK_PROBE: i64 = 20;

/// Render the grounding block, saying what did not fit.
///
/// The caps used to be applied silently, which meant an agent that matched
/// twenty pieces of knowledge saw ten and had no way to know the other ten
/// existed — the closing line offers `kg.query` but reads as boilerplate when
/// nothing suggests there is more to find. Naming the number turns a hidden
/// truncation into something the agent can act on.
///
/// Split out from `context_pack` so the budget arithmetic is testable without a
/// database behind it.
/// Returns the block and how many lines survived the budget — the caller needs
/// the count to record exactly the facts the agent was shown.
fn render_context_pack(lines: &[String]) -> (String, usize) {
    if lines.is_empty() {
        return (String::new(), 0);
    }
    let mut out = String::from("flock Graph — prior team knowledge relevant to this prompt:\n");
    let mut shown = 0usize;
    for l in lines.iter().take(PACK_MAX_LINES) {
        if out.len() + l.len() > PACK_MAX_BYTES {
            break;
        }
        out.push_str(l);
        out.push('\n');
        shown += 1;
    }
    // "matched", not "exist": these are the hits this prompt turned up that did
    // not fit, which is a smaller and more honest claim than what the graph
    // holds on the subject.
    let withheld = lines.len().saturating_sub(shown);
    if withheld > 0 {
        out.push_str(&format!(
            "(+{withheld} more matched this prompt but did not fit — kg.query for the rest.)\n"
        ));
    }
    out.push_str("(Shared agent memory — verify against the code. kg.query / kg.about_file for more; record new decisions and failed attempts as you work.)");
    (out, shown)
}

fn render_node_line(n: &KgNode, via_file: Option<&str>) -> String {
    let kind = match (n.kind == NodeKind::Attempt, n.outcome.as_deref()) {
        (true, Some(o)) if !o.is_empty() => format!("Attempt·{o}"),
        _ => n.kind.as_str().to_string(),
    };
    let mut line = format!("- [{kind}] {}", n.label);
    if let Some(body) = n.body.as_deref().filter(|b| !b.is_empty()) {
        let trimmed: String = body.chars().take(140).collect();
        let ellipsis = if body.chars().count() > 140 { "…" } else { "" };
        line.push_str(&format!(": {trimmed}{ellipsis}"));
    }
    let mut meta: Vec<String> = Vec::new();
    if let Some(agent) = n.created_by_agent.as_deref().filter(|a| !a.is_empty()) {
        meta.push(format!("by {agent}"));
    }
    meta.push(rel_time(n.updated_at));
    if let Some(s) = n.shipped_in.as_deref().filter(|s| !s.is_empty()) {
        meta.push(format!("shipped: {s}"));
    }
    if let Some(f) = via_file {
        meta.push(format!("re {f}"));
    }
    line.push_str(&format!(" ({})", meta.join(", ")));
    line
}

fn rel_time(t: DateTime<Utc>) -> String {
    let mins = (Utc::now() - t).num_minutes().max(0);
    match mins {
        0..=59 => format!("{mins}m ago"),
        60..=1439 => format!("{}h ago", mins / 60),
        _ => format!("{}d ago", mins / 1440),
    }
}

/// The shared node column list with a table alias prefix, for joins.
fn node_cols_prefixed(alias: &str) -> String {
    NODE_COLS
        .split(", ")
        .map(|c| format!("{alias}.{c}"))
        .collect::<Vec<_>>()
        .join(", ")
}

// ─── Internal row type ────────────────────────────────────────────────────────

#[derive(sqlx::FromRow)]
struct RawNode {
    id: Uuid,
    kind: String,
    label: String,
    body: Option<String>,
    workspace_id: Option<String>,
    created_by_agent: Option<String>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    archived_at: Option<DateTime<Utc>>,
    outcome: Option<String>,
    shipped_in: Option<String>,
}

/// A node row plus the joined edge columns from `neighbors`.
#[derive(sqlx::FromRow)]
struct RawNeighbor {
    id: Uuid,
    kind: String,
    label: String,
    body: Option<String>,
    workspace_id: Option<String>,
    created_by_agent: Option<String>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    archived_at: Option<DateTime<Utc>>,
    outcome: Option<String>,
    shipped_in: Option<String>,
    edge_type: String,
    direction: String,
}

impl RawNode {
    fn into_kg_node(self) -> KgNode {
        KgNode {
            id: self.id,
            kind: NodeKind::from_str(&self.kind),
            label: self.label,
            body: self.body,
            workspace_id: self.workspace_id,
            created_by_agent: self.created_by_agent,
            created_at: self.created_at,
            updated_at: self.updated_at,
            archived_at: self.archived_at,
            outcome: self.outcome,
            shipped_in: self.shipped_in,
        }
    }
}

#[cfg(test)]
mod fusion_tests {
    use super::*;

    fn ids(n: usize) -> Vec<Uuid> {
        (0..n).map(|_| Uuid::new_v4()).collect()
    }

    fn raw(id: Uuid, label: &str) -> RawNode {
        RawNode {
            id,
            kind: "Note".into(),
            label: label.into(),
            body: None,
            workspace_id: None,
            created_by_agent: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            archived_at: None,
            outcome: None,
            shipped_in: None,
        }
    }

    #[test]
    fn rrf_both_empty_is_empty() {
        assert!(rrf_ranks(&[], &[], RRF_K).is_empty());
    }

    #[test]
    fn rrf_one_list_empty_preserves_the_other_order() {
        let a = ids(4);
        assert_eq!(rrf_ranks(&a, &[], RRF_K), a);
        assert_eq!(rrf_ranks(&[], &a, RRF_K), a);
    }

    #[test]
    fn rrf_shared_id_outranks_single_list_ids() {
        // y appears at rank 2 in both lists; x and z each lead one list.
        // 2/(k+2) > 1/(k+1) for k = 60, so consensus wins.
        let (x, y, z) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        let fused = rrf_ranks(&[x, y], &[z, y], RRF_K);
        assert_eq!(fused[0], y);
        // x and z tie on score; earlier first appearance (x) breaks it.
        assert_eq!(fused[1], x);
        assert_eq!(fused[2], z);
    }

    #[test]
    fn rrf_dedupes_ids_present_in_both_lists() {
        let shared = ids(3);
        let fused = rrf_ranks(&shared, &shared, RRF_K);
        assert_eq!(fused.len(), 3);
        assert_eq!(fused, shared); // identical ranks → original order
    }

    #[test]
    fn rrf_k_governs_consensus_vs_top_rank() {
        // x: rank 1 in one list only. y: rank 3 in both lists.
        let (x, y) = (Uuid::new_v4(), Uuid::new_v4());
        let (f1, f2, f3) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        let a = vec![x, f1, y];
        let b = vec![f2, f3, y];
        // k = 60 flattens ranks: two appearances (2/63) beat one top rank (1/61).
        let flat = rrf_ranks(&a, &b, 60.0);
        assert!(flat.iter().position(|i| *i == y) < flat.iter().position(|i| *i == x));
        // k = 0 lets the top rank dominate: 1/1 beats 2/3.
        let sharp = rrf_ranks(&a, &b, 0.0);
        assert!(sharp.iter().position(|i| *i == x) < sharp.iter().position(|i| *i == y));
    }

    #[test]
    fn fuse_empty_semantic_degrades_to_fts_truncated() {
        let a = ids(5);
        let fts: Vec<RawNode> = a.iter().map(|id| raw(*id, "n")).collect();
        let out = fuse_by_rrf(fts, vec![], 3);
        assert_eq!(out.iter().map(|n| n.id).collect::<Vec<_>>(), a[..3].to_vec());
    }

    #[test]
    fn fuse_empty_fts_degrades_to_semantic_truncated() {
        let b = ids(5);
        let sem: Vec<RawNode> = b.iter().map(|id| raw(*id, "n")).collect();
        let out = fuse_by_rrf(vec![], sem, 2);
        assert_eq!(out.iter().map(|n| n.id).collect::<Vec<_>>(), b[..2].to_vec());
    }

    #[test]
    fn fuse_dedupes_by_id_and_respects_limit() {
        let (x, y, z) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        let fts = vec![raw(x, "x"), raw(y, "y")];
        let sem = vec![raw(y, "y"), raw(z, "z")];
        let out = fuse_by_rrf(fts, sem, 10);
        let got: Vec<Uuid> = out.iter().map(|n| n.id).collect();
        assert_eq!(got.len(), 3, "y must appear once");
        // y: 1/62 + 1/61 in the two lists; x, z: one appearance each.
        assert_eq!(got[0], y);

        let capped = fuse_by_rrf(
            vec![raw(x, "x"), raw(y, "y")],
            vec![raw(y, "y"), raw(z, "z")],
            2,
        );
        assert_eq!(capped.len(), 2);
    }
}

#[cfg(test)]
mod wikilink_tests {
    use super::*;

    #[test]
    fn extracts_simple_and_aliased_links() {
        let got = extract_wikilinks("see [[Pane header toggles]] and [[graph v2|the revamp]].");
        assert_eq!(got, vec!["Pane header toggles".to_string(), "graph v2".to_string()]);
    }

    #[test]
    fn ignores_empty_unclosed_and_duplicate_links() {
        assert!(extract_wikilinks("[[ ]] [[unclosed").is_empty());
        assert_eq!(extract_wikilinks("[[a]] [[a]]").len(), 1);
    }
}


#[cfg(test)]
mod pack_tests {
    use super::*;

    fn lines(n: usize) -> Vec<String> {
        (0..n).map(|i| format!("- Decision · thing number {i}")).collect()
    }

    #[test]
    fn nothing_found_renders_nothing() {
        assert_eq!(render_context_pack(&[]), (String::new(), 0));
    }

    #[test]
    fn everything_that_fits_is_shown_with_no_elision_line() {
        let (out, shown) = render_context_pack(&lines(4));
        assert_eq!(out.matches("thing number").count(), 4);
        assert_eq!(shown, 4);
        assert!(!out.contains("did not fit"), "nothing was withheld, so say nothing");
    }

    #[test]
    fn the_line_cap_is_reported() {
        let (out, shown) = render_context_pack(&lines(PACK_MAX_LINES + 6));
        assert_eq!(out.matches("thing number").count(), PACK_MAX_LINES);
        assert_eq!(shown, PACK_MAX_LINES);
        assert!(out.contains("+6 more matched"), "got: {out}");
    }

    /// The byte budget bites before the line cap when the hits are long, and it
    /// used to be the quieter of the two truncations — a `break` mid-loop with
    /// nothing said.
    #[test]
    fn the_byte_budget_is_reported_too() {
        let fat: Vec<String> = (0..PACK_MAX_LINES).map(|i| format!("- {i} {}", "x".repeat(400))).collect();
        let (out, shown) = render_context_pack(&fat);
        assert!(out.len() < PACK_MAX_BYTES + 400, "budget still holds: {} bytes", out.len());
        assert!(shown < PACK_MAX_LINES, "the byte budget cut the list short");
        assert!(out.contains("more matched"), "got: {out}");
    }

    #[test]
    fn the_block_still_ends_with_its_instructions() {
        for n in [1, PACK_MAX_LINES + 3] {
            let (out, _) = render_context_pack(&lines(n));
            assert!(out.trim_end().ends_with("as you work.)"), "n={n}: {out}");
        }
    }

    /// The count the caller records facts against is the number of bullets the
    /// agent can actually read, under either cap. A `shown` that outran the
    /// rendered lines would log recalls for knowledge nobody was shown, and
    /// every "most recalled" figure downstream would inherit the lie.
    #[test]
    fn shown_always_equals_the_bullets_in_the_block() {
        let fat: Vec<String> = (0..PACK_MAX_LINES).map(|i| format!("- {i} {}", "x".repeat(400))).collect();
        for case in [lines(1), lines(4), lines(PACK_MAX_LINES + 6), fat] {
            let (out, shown) = render_context_pack(&case);
            let bullets = out.lines().filter(|l| l.starts_with("- ")).count();
            assert_eq!(shown, bullets, "shown={shown} bullets={bullets} in: {out}");
        }
    }
}

#[cfg(test)]
mod compaction_tests {
    use super::*;

    /// These need a real Postgres — the queries use pgvector types, arrays and
    /// `FOR UPDATE`, none of which a mock would tell the truth about. Point
    /// FLOCK_KG_TEST_URL at a throwaway database to run them:
    ///
    ///   docker run -d -e POSTGRES_USER=flock -e POSTGRES_PASSWORD=flock \
    ///     -e POSTGRES_DB=flock_kg -p 15433:5432 pgvector/pgvector:pg16
    ///   FLOCK_KG_TEST_URL=postgresql://flock:flock@127.0.0.1:15433/flock_kg \
    ///     cargo test -p flock-kg -- --ignored --test-threads=1
    ///
    /// Serially, and that is not optional: the helper below truncates the whole
    /// node table, so two of these running at once delete each other's
    /// fixtures and fail with assertions that look like real bugs.
    async fn kg() -> KnowledgeGraph {
        // Nothing in these tests is semantic, and `connect` warms the local
        // embedder — an ort session init that the test binary then exits out
        // from under, taking the whole run down with SIGSEGV *after* every
        // assertion passed. Same teardown crash the one-shot grounding hook
        // hit; same fix (see `embed::disable`).
        embed::disable();
        let url = std::env::var("FLOCK_KG_TEST_URL").expect("FLOCK_KG_TEST_URL");
        let kg = KnowledgeGraph::connect(&url).await.unwrap();
        kg.ensure_event_schema().await.unwrap();
        sqlx::query("TRUNCATE kg_node CASCADE").execute(kg.pool()).await.unwrap();
        kg
    }

    /// A node old and long enough to be a candidate. `updated_at` is pushed
    /// back explicitly: everything written now is by definition too recent.
    async fn seed(kg: &KnowledgeGraph, label: &str, body: &str, age_days: i32) -> Uuid {
        sqlx::query_scalar::<_, Uuid>(
            "INSERT INTO kg_node (kind, label, body, workspace_id, updated_at)
             VALUES ('Note', $1, $2, 'ws', now() - make_interval(days => $3)) RETURNING id",
        )
        .bind(label)
        .bind(body)
        .bind(age_days)
        .fetch_one(kg.pool())
        .await
        .unwrap()
    }

    fn long(n: usize) -> String {
        "the original text that says something load-bearing. ".repeat(n)
    }

    #[tokio::test]
    #[ignore = "needs FLOCK_KG_TEST_URL"]
    async fn candidates_are_old_long_and_biggest_first() {
        let kg = kg().await;
        seed(&kg, "big and old", &long(40), 60).await;
        seed(&kg, "small and old", &long(60), 40).await;
        seed(&kg, "short", "too short to be worth it", 60).await;
        seed(&kg, "recent", &long(40), 1).await;

        let c = kg.compaction_candidates(Some("ws"), 10).await.unwrap();
        let labels: Vec<_> = c.iter().map(|x| x.label.as_str()).collect();
        assert_eq!(labels, ["small and old", "big and old"], "biggest body first");
    }

    #[tokio::test]
    #[ignore = "needs FLOCK_KG_TEST_URL"]
    async fn superseded_and_archived_knowledge_is_not_a_candidate() {
        let kg = kg().await;
        let old = seed(&kg, "superseded", &long(40), 60).await;
        let new = seed(&kg, "replacement", &long(40), 60).await;
        sqlx::query("INSERT INTO kg_edge (from_node_id, to_node_id, edge_type) VALUES ($1, $2, 'SUPERSEDES')")
            .bind(new)
            .bind(old)
            .execute(kg.pool())
            .await
            .unwrap();
        let gone = seed(&kg, "archived", &long(40), 60).await;
        sqlx::query("UPDATE kg_node SET archived_at = now() WHERE id = $1")
            .bind(gone)
            .execute(kg.pool())
            .await
            .unwrap();

        let labels: Vec<_> = kg
            .compaction_candidates(Some("ws"), 10)
            .await
            .unwrap()
            .into_iter()
            .map(|c| c.label)
            .collect();
        assert_eq!(labels, ["replacement"], "both are already hidden from reads");
    }

    #[tokio::test]
    #[ignore = "needs FLOCK_KG_TEST_URL"]
    async fn compaction_round_trips() {
        let kg = kg().await;
        let body = long(40);
        seed(&kg, "round trip", &body, 60).await;

        let r = kg
            .compact(CompactReq { reference: "round trip".into(), summary: "the short version".into() })
            .await
            .unwrap()
            .expect("node resolved");
        assert_eq!(r.level, 1);
        assert!(r.after_bytes < r.before_bytes);

        let (stored, level, original): (String, i32, Option<i32>) = sqlx::query_as(
            "SELECT body, compaction_level, original_bytes FROM kg_node WHERE label = 'round trip'",
        )
        .fetch_one(kg.pool())
        .await
        .unwrap();
        assert_eq!(stored, "the short version");
        assert_eq!(level, 1);
        assert_eq!(original, Some(body.len() as i32));

        let restored = kg.restore("round trip").await.unwrap();
        assert_eq!(restored.as_deref(), Some("round trip"));

        let (back, level, original): (String, i32, Option<i32>) = sqlx::query_as(
            "SELECT body, compaction_level, original_bytes FROM kg_node WHERE label = 'round trip'",
        )
        .fetch_one(kg.pool())
        .await
        .unwrap();
        assert_eq!(back, body, "the original text came back verbatim");
        assert_eq!(level, 0);
        assert_eq!(original, None, "back to never-compacted");
    }

    /// The degenerate summary: same content, trivially fewer bytes. Left
    /// unguarded this passes as a compaction, spending a round trip and a level
    /// of remove to save nothing — which is exactly how a summarization loop
    /// quietly ruins a record.
    #[tokio::test]
    #[ignore = "needs FLOCK_KG_TEST_URL"]
    async fn a_summary_that_saves_almost_nothing_is_refused() {
        let kg = kg().await;
        let body = long(40);
        seed(&kg, "no saving", &body, 60).await;

        let barely_shorter = body[..body.len() - 10].to_string();
        let err = kg
            .compact(CompactReq { reference: "no saving".into(), summary: barely_shorter })
            .await
            .unwrap_err();
        assert!(err.to_string().contains("saves too little"), "got: {err}");

        // And the record is untouched — a refused compaction must not leave a
        // snapshot behind or a level bumped.
        let (stored, level): (String, i32) =
            sqlx::query_as("SELECT body, compaction_level FROM kg_node WHERE label = 'no saving'")
                .fetch_one(kg.pool())
                .await
                .unwrap();
        assert_eq!(stored, body);
        assert_eq!(level, 0);
        let snaps: i64 = sqlx::query_scalar("SELECT count(*) FROM kg_node_snapshot")
            .fetch_one(kg.pool())
            .await
            .unwrap();
        assert_eq!(snaps, 0);
    }

    #[tokio::test]
    #[ignore = "needs FLOCK_KG_TEST_URL"]
    async fn restoring_twice_does_not_invent_history() {
        let kg = kg().await;
        seed(&kg, "once", &long(40), 60).await;
        kg.compact(CompactReq { reference: "once".into(), summary: "short".into() })
            .await
            .unwrap()
            .unwrap();

        assert!(kg.restore("once").await.unwrap().is_some());
        // The snapshot was consumed, so there is nothing left to put back and
        // the second call has to say so rather than reporting a success.
        assert!(kg.restore("once").await.unwrap().is_none());
    }

    #[tokio::test]
    #[ignore = "needs FLOCK_KG_TEST_URL"]
    async fn compacting_does_not_make_a_node_look_freshly_written() {
        let kg = kg().await;
        seed(&kg, "age", &long(40), 60).await;
        let before: DateTime<Utc> =
            sqlx::query_scalar("SELECT updated_at FROM kg_node WHERE label = 'age'")
                .fetch_one(kg.pool())
                .await
                .unwrap();

        kg.compact(CompactReq { reference: "age".into(), summary: "short".into() })
            .await
            .unwrap()
            .unwrap();

        let after: DateTime<Utc> =
            sqlx::query_scalar("SELECT updated_at FROM kg_node WHERE label = 'age'")
                .fetch_one(kg.pool())
                .await
                .unwrap();
        assert_eq!(before, after, "compaction changes how it is said, not what it says");
    }

    #[tokio::test]
    #[ignore = "needs FLOCK_KG_TEST_URL"]
    async fn an_already_compacted_node_is_not_offered_again() {
        let kg = kg().await;
        seed(&kg, "done once", &long(40), 60).await;
        kg.compact(CompactReq { reference: "done once".into(), summary: long(20) })
            .await
            .unwrap()
            .unwrap();

        let c = kg.compaction_candidates(Some("ws"), 10).await.unwrap();
        assert!(c.is_empty(), "still long and old, but already compacted");
    }


    /// The compounding case: nothing stops a caller naming an already-compacted
    /// node directly, and the ratio guard cannot catch it because it measures
    /// against the summary rather than the original.
    #[tokio::test]
    #[ignore = "needs FLOCK_KG_TEST_URL"]
    async fn a_summary_cannot_itself_be_summarized() {
        let kg = kg().await;
        seed(&kg, "twice", &long(40), 60).await;
        kg.compact(CompactReq { reference: "twice".into(), summary: long(5) })
            .await
            .unwrap()
            .unwrap();

        let err = kg
            .compact(CompactReq { reference: "twice".into(), summary: "shorter still".into() })
            .await
            .unwrap_err();
        assert!(err.to_string().contains("already been compacted"), "got: {err}");

        let (body, level): (String, i32) =
            sqlx::query_as("SELECT body, compaction_level FROM kg_node WHERE label = 'twice'")
                .fetch_one(kg.pool())
                .await
                .unwrap();
        assert_eq!(body, long(5).trim(), "the first summary is untouched");
        assert_eq!(level, 1);
    }


    // ── export / import ──────────────────────────────────────────────────

    /// Everything that distinguishes one graph from another, as one string.
    async fn fingerprint(kg: &KnowledgeGraph) -> String {
        sqlx::query_scalar::<_, Option<String>>(
            r#"SELECT md5(string_agg(x, '|' ORDER BY x)) FROM (
                 SELECT id::text||kind||label||coalesce(body,'')||compaction_level::text AS x FROM kg_node
                 UNION ALL SELECT from_node_id::text||to_node_id::text||edge_type FROM kg_edge
                 UNION ALL SELECT node_id::text||coalesce(body,'') FROM kg_node_snapshot
               ) t"#,
        )
        .fetch_one(kg.pool())
        .await
        .unwrap()
        .unwrap_or_default()
    }

    async fn seed_a_small_graph(kg: &KnowledgeGraph) {
        let a = seed(kg, "a decision", &long(40), 60).await;
        let b = seed(kg, "a file it governs", "", 1).await;
        sqlx::query("INSERT INTO kg_edge (from_node_id, to_node_id, edge_type) VALUES ($1,$2,'ABOUT')")
            .bind(a)
            .bind(b)
            .execute(kg.pool())
            .await
            .unwrap();
    }

    /// The scenario the export exists for: the volume is gone and the file is
    /// all that is left.
    #[tokio::test]
    #[ignore = "needs FLOCK_KG_TEST_URL"]
    async fn a_wiped_graph_is_rebuilt_from_its_export() {
        let kg = kg().await;
        seed_a_small_graph(&kg).await;
        kg.compact(CompactReq { reference: "a decision".into(), summary: "the short version".into() })
            .await
            .unwrap()
            .unwrap();
        let before = fingerprint(&kg).await;

        let mut buf = Vec::new();
        let stats = kg.export_jsonl(&mut buf).await.unwrap();
        assert_eq!((stats.nodes, stats.snapshots, stats.edges), (2, 1, 1));

        sqlx::query("TRUNCATE kg_node CASCADE").execute(kg.pool()).await.unwrap();
        assert_ne!(fingerprint(&kg).await, before, "the wipe really happened");

        let s = kg.import_jsonl(std::io::Cursor::new(buf)).await.unwrap();
        assert_eq!((s.nodes, s.snapshots, s.edges, s.skipped), (2, 1, 1, 0));
        assert_eq!(fingerprint(&kg).await, before, "rebuilt exactly");
    }

    /// A restore is reached for when something has already gone wrong, which is
    /// the worst possible moment to also be overwriting whatever survived.
    #[tokio::test]
    #[ignore = "needs FLOCK_KG_TEST_URL"]
    async fn importing_over_a_live_graph_changes_nothing() {
        let kg = kg().await;
        seed_a_small_graph(&kg).await;
        let mut buf = Vec::new();
        kg.export_jsonl(&mut buf).await.unwrap();

        sqlx::query("UPDATE kg_node SET body = 'edited since the backup' WHERE label = 'a decision'")
            .execute(kg.pool())
            .await
            .unwrap();
        let live = fingerprint(&kg).await;

        let s = kg.import_jsonl(std::io::Cursor::new(buf)).await.unwrap();
        assert_eq!((s.nodes, s.edges), (0, 0), "nothing was inserted");
        assert!(s.existing > 0, "and it said so");
        assert_eq!(fingerprint(&kg).await, live, "the newer edit stands");
    }

    /// Without the snapshots, an export preserves every summary and none of the
    /// originals — turning a reversible compaction into a permanent one at the
    /// exact moment the backup is being relied on.
    #[tokio::test]
    #[ignore = "needs FLOCK_KG_TEST_URL"]
    async fn compaction_is_still_reversible_after_a_round_trip() {
        let kg = kg().await;
        let body = long(40);
        seed(&kg, "round trip", &body, 60).await;
        kg.compact(CompactReq { reference: "round trip".into(), summary: "short".into() })
            .await
            .unwrap()
            .unwrap();

        let mut buf = Vec::new();
        kg.export_jsonl(&mut buf).await.unwrap();
        sqlx::query("TRUNCATE kg_node CASCADE").execute(kg.pool()).await.unwrap();
        kg.import_jsonl(std::io::Cursor::new(buf)).await.unwrap();

        assert!(kg.restore("round trip").await.unwrap().is_some());
        let restored: String =
            sqlx::query_scalar("SELECT body FROM kg_node WHERE label = 'round trip'")
                .fetch_one(kg.pool())
                .await
                .unwrap();
        assert_eq!(restored, body, "the original survived the backup");
    }

    /// A backup that is 99% readable should restore 99%, not nothing.
    #[tokio::test]
    #[ignore = "needs FLOCK_KG_TEST_URL"]
    async fn a_damaged_line_costs_only_itself() {
        let kg = kg().await;
        seed_a_small_graph(&kg).await;
        let mut buf = Vec::new();
        kg.export_jsonl(&mut buf).await.unwrap();
        sqlx::query("TRUNCATE kg_node CASCADE").execute(kg.pool()).await.unwrap();

        let mut text = String::from_utf8(buf).unwrap();
        text.push_str("{ this line is not json\n");
        text.push_str("{\"type\":\"node\",\"id\":\"not-a-uuid\"}\n");

        let s = kg.import_jsonl(std::io::Cursor::new(text)).await.unwrap();
        assert_eq!(s.skipped, 2);
        assert_eq!((s.nodes, s.edges), (2, 1), "the intact rows still landed");
    }

}

#[cfg(test)]
mod recall_tests {
    use super::*;

    /// Recall is entirely a story about `UUID[]` columns, `unnest`, and a join
    /// onto live node state — none of which a mock would tell the truth about.
    /// Same contract as `compaction_tests`:
    ///
    ///     FLOCK_KG_TEST_URL=postgresql://flock:flock@127.0.0.1:15432/flock_kg \
    ///     cargo test -p flock-kg -- --ignored recall
    ///
    /// Each test gets a fresh workspace id instead of truncating, so the six of
    /// them can run in parallel against one database — which is what cargo does
    /// by default, and what makes a shared `TRUNCATE` helper delete another
    /// test's fixtures mid-run. Every read here is workspace-scoped anyway, so
    /// isolation costs nothing but the id.
    async fn kg() -> (KnowledgeGraph, String) {
        // Nothing in these tests is semantic, and `connect` warms the local
        // embedder — an ort session init that the test binary then exits out
        // from under, taking the whole run down with SIGSEGV *after* every
        // assertion passed. Same teardown crash the one-shot grounding hook
        // hit; same fix (see `embed::disable`).
        embed::disable();
        let url = std::env::var("FLOCK_KG_TEST_URL").expect("FLOCK_KG_TEST_URL");
        let kg = KnowledgeGraph::connect(&url).await.unwrap();
        kg.ensure_event_schema().await.unwrap();
        (kg, format!("recall-test-{}", Uuid::new_v4()))
    }

    async fn note(kg: &KnowledgeGraph, ws: &str, label: &str) -> Uuid {
        sqlx::query_scalar::<_, Uuid>(
            "INSERT INTO kg_node (kind, label, body, workspace_id)
             VALUES ('Note', $1, 'body', $2) RETURNING id",
        )
        .bind(label)
        .bind(ws)
        .fetch_one(kg.pool())
        .await
        .unwrap()
    }

    async fn ground(kg: &KnowledgeGraph, ws: &str, facts: Vec<Uuid>) {
        let mut ev = EventReq::new("ground", EventKind::Ground);
        ev.workspace_id = Some(ws.to_string());
        ev.agent_id = Some("agent-1".into());
        ev.grounding_hits = Some(facts.len() as i32);
        ev.fact_ids = facts;
        kg.log_event(ev).await;
    }

    #[tokio::test]
    #[ignore = "needs FLOCK_KG_TEST_URL"]
    async fn a_pass_reports_the_facts_it_surfaced_in_order() {
        let (kg, ws) = kg().await;
        let (a, b) = (note(&kg, &ws, "first").await, note(&kg, &ws, "second").await);
        ground(&kg, &ws, vec![b, a]).await;

        let passes = kg.recent_groundings(Some(&ws), 10).await.unwrap();
        assert_eq!(passes.len(), 1);
        let labels: Vec<_> = passes[0].facts.iter().map(|f| f.label.as_str()).collect();
        // The order the agent read them in, not whatever the join returns.
        assert_eq!(labels, ["second", "first"]);
        assert_eq!(passes[0].agent_id.as_deref(), Some("agent-1"));
    }

    /// A pass that found nothing is a real observation and has to survive the
    /// round trip as one — it is the denominator for "is recall working". A row
    /// from before the column existed is the opposite: its count is real but
    /// its contents are gone, and showing it as empty would be a lie.
    #[tokio::test]
    #[ignore = "needs FLOCK_KG_TEST_URL"]
    async fn an_empty_pass_is_kept_but_a_pre_column_pass_is_not() {
        let (kg, ws) = kg().await;
        ground(&kg, &ws, vec![]).await;
        sqlx::query(
            "INSERT INTO kg_event (operation, kind, workspace_id, grounding_hits, fact_ids)
             VALUES ('ground', 'ground', $1, 4, NULL)",
        )
        .bind(&ws)
        .execute(kg.pool())
        .await
        .unwrap();

        let passes = kg.recent_groundings(Some(&ws), 10).await.unwrap();
        assert_eq!(passes.len(), 1, "the legacy row cannot say what it surfaced");
        assert!(passes[0].facts.is_empty());
    }

    /// The whole reason facts are stored as ids: a node retracted since the
    /// pass has to read as retracted, not as the text it carried on the day.
    #[tokio::test]
    #[ignore = "needs FLOCK_KG_TEST_URL"]
    async fn retracted_and_superseded_facts_are_flagged() {
        let (kg, ws) = kg().await;
        let (gone, old, new) = (
            note(&kg, &ws, "retracted later").await,
            note(&kg, &ws, "replaced later").await,
            note(&kg, &ws, "the replacement").await,
        );
        ground(&kg, &ws, vec![gone, old]).await;
        sqlx::query("UPDATE kg_node SET archived_at = now() WHERE id = $1")
            .bind(gone)
            .execute(kg.pool())
            .await
            .unwrap();
        sqlx::query("INSERT INTO kg_edge (from_node_id, to_node_id, edge_type) VALUES ($1, $2, 'SUPERSEDES')")
            .bind(new)
            .bind(old)
            .execute(kg.pool())
            .await
            .unwrap();

        let passes = kg.recent_groundings(Some(&ws), 10).await.unwrap();
        let f = &passes[0].facts;
        assert!(f[0].archived && !f[0].superseded);
        assert!(f[1].superseded && !f[1].archived);
    }

    /// A hard-deleted node drops out of its pass rather than rendering blank;
    /// the pass itself still counts.
    #[tokio::test]
    #[ignore = "needs FLOCK_KG_TEST_URL"]
    async fn a_deleted_fact_leaves_its_pass_standing() {
        let (kg, ws) = kg().await;
        let (kept, doomed) = (note(&kg, &ws, "kept").await, note(&kg, &ws, "doomed").await);
        ground(&kg, &ws, vec![kept, doomed]).await;
        sqlx::query("DELETE FROM kg_node WHERE id = $1")
            .bind(doomed)
            .execute(kg.pool())
            .await
            .unwrap();

        let passes = kg.recent_groundings(Some(&ws), 10).await.unwrap();
        assert_eq!(passes.len(), 1);
        assert_eq!(passes[0].facts.len(), 1);
        assert_eq!(passes[0].facts[0].label, "kept");
    }

    #[tokio::test]
    #[ignore = "needs FLOCK_KG_TEST_URL"]
    async fn recall_counts_rank_by_how_often_a_fact_came_back() {
        let (kg, ws) = kg().await;
        let (hot, warm, cold) = (
            note(&kg, &ws, "recalled thrice").await,
            note(&kg, &ws, "recalled once").await,
            note(&kg, &ws, "never recalled").await,
        );
        for _ in 0..3 {
            ground(&kg, &ws, vec![hot]).await;
        }
        ground(&kg, &ws, vec![warm]).await;

        let since = Utc::now() - chrono::Duration::days(1);
        let top = kg.recall_counts(Some(&ws), since, 50).await.unwrap();
        assert_eq!(
            top.iter().map(|t| (t.label.as_str(), t.recalls)).collect::<Vec<_>>(),
            [("recalled thrice", 3), ("recalled once", 1)],
        );
        // Dead weight is absent, not zero — that absence is what the coverage
        // figure counts against the live knowledge total.
        assert!(!top.iter().any(|t| t.id == cold), "never-recalled knowledge does not appear");
    }

    /// Only ground events carry facts. A write logged in the same window must
    /// not leak into the recall log through a stray empty array.
    #[tokio::test]
    #[ignore = "needs FLOCK_KG_TEST_URL"]
    async fn non_ground_events_never_appear_as_passes() {
        let (kg, ws) = kg().await;
        let mut ev = EventReq::new("write_decision", EventKind::Write);
        ev.workspace_id = Some(ws.clone());
        kg.log_event(ev).await;

        assert!(kg.recent_groundings(Some(&ws), 10).await.unwrap().is_empty());
    }

    /// The replacement for `sum(grounding_hits)`, pinned on the two properties
    /// that number lacked: an empty pass is counted as one, and coverage is
    /// taken against everything recorded rather than against what came back.
    #[tokio::test]
    #[ignore = "needs FLOCK_KG_TEST_URL"]
    async fn recall_stats_count_the_silent_passes_and_the_unread_knowledge() {
        let (kg, ws) = kg().await;
        let hot = note(&kg, &ws, "read every day").await;
        note(&kg, &ws, "never read").await;
        note(&kg, &ws, "also never read").await;
        for _ in 0..4 {
            ground(&kg, &ws, vec![hot]).await;
        }
        ground(&kg, &ws, vec![]).await;
        ground(&kg, &ws, vec![]).await;

        let s = kg.recall_stats(Some(&ws), Utc::now() - chrono::Duration::days(1)).await.unwrap();
        assert_eq!(s.ground_passes, 6);
        assert_eq!(s.passes_with_facts, 4);
        assert_eq!(s.silent_passes, 2, "the denominator every readout dropped");
        // Volume: one fact, four injections. The old headline would have called
        // this four rediscoveries avoided.
        assert_eq!(s.facts_injected, 4);
        assert_eq!((s.facts_recalled, s.knowledge_total), (1, 3), "coverage is 1 in 3, not 1 in 1");
    }

    /// Coverage must not be able to exceed 100%, and the way in is a fact that
    /// was injected and afterwards forgotten: it stays in the numerator's raw
    /// event rows while leaving the live denominator. A graph reporting 120%
    /// read-back at the exact moment its knowledge is being retracted is worse
    /// than no figure at all.
    #[tokio::test]
    #[ignore = "needs FLOCK_KG_TEST_URL"]
    async fn a_retracted_fact_leaves_both_sides_of_coverage() {
        let (kg, ws) = kg().await;
        let (kept, gone) = (note(&kg, &ws, "kept").await, note(&kg, &ws, "retracted").await);
        ground(&kg, &ws, vec![kept, gone]).await;
        sqlx::query("UPDATE kg_node SET archived_at = now() WHERE id = $1")
            .bind(gone)
            .execute(kg.pool())
            .await
            .unwrap();

        let s = kg.recall_stats(Some(&ws), Utc::now() - chrono::Duration::days(1)).await.unwrap();
        assert_eq!((s.facts_recalled, s.knowledge_total), (1, 1), "100%, never 200%");
        // The injection itself still happened and is still counted as volume.
        assert_eq!(s.facts_injected, 2);
    }

    /// A pass recorded before `fact_ids` existed knows how many facts it showed
    /// and not which. Counting it as a pass that found nothing would invent a
    /// failure; counting it as one that found something would invent a success.
    /// It is reported on its own and excluded from both.
    #[tokio::test]
    #[ignore = "needs FLOCK_KG_TEST_URL"]
    async fn legacy_passes_are_excluded_rather_than_guessed_at() {
        let (kg, ws) = kg().await;
        ground(&kg, &ws, vec![]).await;
        sqlx::query(
            "INSERT INTO kg_event (operation, kind, workspace_id, grounding_hits, fact_ids)
             VALUES ('ground', 'ground', $1, 9, NULL)",
        )
        .bind(&ws)
        .execute(kg.pool())
        .await
        .unwrap();

        let s = kg.recall_stats(Some(&ws), Utc::now() - chrono::Duration::days(1)).await.unwrap();
        assert_eq!(s.ground_passes, 1);
        assert_eq!(s.passes_unrecorded, 1);
        assert_eq!(s.facts_injected, 0, "the nine bullets it printed are not evidence of anything");
    }
}

#[cfg(test)]
mod schema_sync {
    /// docker/init/002_schema.sql runs on a fresh team-graph volume.
    /// The app's schema.sql is what `ensure_event_schema` is kept in step
    /// with. They drifted once (`anchor_key`, compaction, fact_ids) and a
    /// graph brought up by hand had no such columns.
    #[test]
    fn docker_init_schema_matches_app_schema() {
        let app = include_str!("../../../apps/flock-desktop/src-tauri/graph/schema.sql");
        let docker = include_str!("../../../docker/init/002_schema.sql");
        assert_eq!(
            app, docker,
            "docker/init/002_schema.sql must be a copy of apps/flock-desktop/src-tauri/graph/schema.sql"
        );
    }
}
