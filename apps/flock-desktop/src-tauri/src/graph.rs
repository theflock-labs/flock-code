//! flock Graph — lifecycle management for the local knowledge-graph
//! engine (Postgres + pgvector in Docker) and discovery of the
//! flock-mcp server binary that agents connect to.
//!
//! The compose file + schema are embedded in the app and materialized to
//! ~/.flock/graph on demand, so the stack works identically from a dev
//! checkout and a packaged .app, and users can also drive it by hand with
//! plain `docker compose` from that directory.

use serde::Serialize;
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

const COMPOSE_YML: &str = include_str!("../graph/docker-compose.yml");
const SCHEMA_SQL: &str = include_str!("../graph/schema.sql");

pub const KG_URL: &str = "postgresql://flock:flock@127.0.0.1:15432/flock_kg";
const DB_ADDR: &str = "127.0.0.1:15432";
const CONTAINER: &str = "flock-graph-db";

#[derive(Debug, Serialize)]
pub struct GraphStatus {
    /// Absolute path to the docker CLI, or None when it isn't installed.
    /// Reported separately from `docker_ready` because "Docker isn't
    /// installed" and "Docker is installed but not running" need different
    /// things from the user, and a single boolean told them to do both.
    pub docker_cli: Option<String>,
    /// The daemon answers `docker info`.
    pub docker_ready: bool,
    /// The flock-graph-db container exists and is running.
    pub container_running: bool,
    /// Postgres accepts TCP connections on 127.0.0.1:15432.
    pub db_reachable: bool,
    /// Absolute path to the flock-mcp binary, if found.
    pub mcp_binary: Option<String>,
    /// Connection string agents should use (FLOCK_KG_URL).
    pub kg_url: String,
}

fn graph_dir() -> PathBuf {
    flock_core::paths::shared_data_dir().join("graph")
}

/// Write the embedded compose + schema to ~/.flock/graph (idempotent —
/// always overwrites so app upgrades propagate infra changes).
fn materialize_infra() -> Result<PathBuf, String> {
    let dir = graph_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("docker-compose.yml"), COMPOSE_YML).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("schema.sql"), SCHEMA_SQL).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Where to send a user who hasn't got Docker at all.
const DOCKER_INSTALL_URL: &str = "https://www.docker.com/products/docker-desktop/";

/// Locate the docker CLI the same way secure mode does. **Never
/// `Command::new("docker")`.** A Finder-launched .app inherits launchd's bare
/// `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, and Docker Desktop installs its CLI at
/// `/usr/local/bin/docker` — so a bare lookup fails with ENOENT on every
/// packaged install, forever, no matter how many times the user starts Docker
/// and presses the button. That is exactly what this module did until now: the
/// engine could not be started from the shipped app at all, and the only thing
/// on screen was "Docker isn't running" over a running Docker.
fn docker_bin() -> Option<PathBuf> {
    flock_pty::container::docker_path()
}

fn docker(args: &[&str]) -> Result<std::process::Output, String> {
    let bin = docker_bin().ok_or("docker CLI not found")?;
    Command::new(bin)
        .args(args)
        .output()
        .map_err(|e| format!("docker not available: {e}"))
}

fn docker_ready() -> bool {
    docker(&["info", "--format", "{{.ServerVersion}}"])
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Only the current container counts. A pre-rebrand `clarence-graph-db` was
/// probed here too until 2026-07-28, back when it held the same database under
/// a different container name. It no longer does: the role, the database and
/// the volume were all renamed before launch, so an old container that is up is
/// serving `clarence_kg` while `KG_URL` asks for `flock_kg`. Counting it as
/// running would report a healthy graph that every query then fails against.
fn container_running() -> bool {
    docker(&["inspect", "--format", "{{.State.Running}}", CONTAINER])
        .map(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == "true")
        .unwrap_or(false)
}

fn db_reachable(addr: &str) -> bool {
    let Ok(sock) = addr.parse() else { return false };
    std::net::TcpStream::connect_timeout(&sock, Duration::from_millis(600)).is_ok()
}

/// Find the flock-mcp server binary. Packaged builds ship it next to the
/// app executable; dev builds produce it as a sibling in target/{debug,release};
/// a cargo-installed copy lands in ~/.cargo/bin.
///
/// The `which` leg searches the *inherited* PATH, which for a Finder-launched
/// .app is launchd's bare four directories — so `~/.cargo/bin` is checked
/// explicitly rather than assumed to be on it. Same class of bug as
/// [`docker_bin`], with a quieter symptom: the wizard just says "binary not
/// found yet" and tells you to build a thing you already built.
fn find_mcp_binary() -> Option<String> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let sibling = dir.join("flock-mcp");
            if sibling.is_file() {
                return Some(sibling.to_string_lossy().into_owned());
            }
        }
    }
    if let Ok(which) = Command::new("/usr/bin/which").arg("flock-mcp").output() {
        if which.status.success() {
            let path = String::from_utf8_lossy(&which.stdout).trim().to_string();
            if !path.is_empty() {
                return Some(path);
            }
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        let cargo = PathBuf::from(home).join(".cargo/bin/flock-mcp");
        if cargo.is_file() {
            return Some(cargo.to_string_lossy().into_owned());
        }
    }
    None
}

/// Just the pieces needed to register the graph MCP server with a spawned
/// agent: the server binary path (if found) and the connection URL. Cheap (no
/// docker probes), so it's safe on the spawn hot path.
pub fn mcp_config(kg_url: Option<String>) -> (Option<String>, String) {
    (find_mcp_binary(), kg_url.unwrap_or_else(|| KG_URL.to_string()))
}

pub fn status(kg_url: Option<String>) -> GraphStatus {
    let url = kg_url.unwrap_or_else(|| KG_URL.to_string());
    let cli = docker_bin();
    let docker_ready = cli.is_some() && docker_ready();
    GraphStatus {
        docker_cli: cli.map(|p| p.to_string_lossy().into_owned()),
        docker_ready,
        container_running: docker_ready && container_running(),
        db_reachable: db_reachable(&db_addr_of(&url)),
        mcp_binary: find_mcp_binary(),
        kg_url: url,
    }
}

/// How long `up` waits for Postgres to start accepting connections after
/// compose reports success. `up -d` returns as soon as the container is
/// *created*; Postgres then initialises its data directory, which on a first
/// run (schema.sql included) is several seconds. Returning before that made
/// the button say "done" while the Database pill stayed grey with nothing
/// explaining why.
const DB_WARMUP: Duration = Duration::from_secs(90);

/// `docker compose up -d` for the graph stack, then wait until the database
/// actually answers. Blocking (image pull on first run can take minutes) —
/// callers run it via spawn_blocking.
///
/// Every failure path returns a message naming the next thing to do, because
/// this runs behind one button and the user cannot see the command.
pub fn up() -> Result<(), String> {
    let dir = materialize_infra()?;
    let Some(bin) = docker_bin() else {
        return Err(format!(
            "Can't find the docker command. Install Docker Desktop ({DOCKER_INSTALL_URL}), \
             then reopen this window. If it is already installed, its CLI isn't in \
             /usr/local/bin or /opt/homebrew/bin — open Docker Desktop → Settings → Advanced \
             and install the CLI tools."
        ));
    };
    if !docker_ready() {
        return Err(
            "Docker is installed but its daemon isn't answering. Start Docker Desktop, wait for \
             the whale icon to stop animating, then press Start the engine again. (Enable \
             'Start Docker Desktop at login' so the graph survives reboots.)"
                .into(),
        );
    }
    let compose = dir.join("docker-compose.yml");
    let out = Command::new(&bin)
        .args(["compose", "-f"])
        .arg(&compose)
        .args(["up", "-d"])
        .output()
        .map_err(|e| format!("failed to run docker compose: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(format!(
            "docker compose failed:\n{stderr}\n\nRun it by hand to see the full output:\n  \
             docker compose -f {} up",
            compose.display()
        ));
    }

    // Poll rather than trust the exit code: the pull and the container start
    // succeed well before Postgres is listening.
    let addr = db_addr_of(KG_URL);
    let deadline = std::time::Instant::now() + DB_WARMUP;
    while std::time::Instant::now() < deadline {
        if db_reachable(&addr) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    Err(format!(
        "The container started but Postgres never accepted a connection on {addr}. \
         Check what it logged:\n  docker compose -f {} logs db",
        compose.display()
    ))
}

/// Best-effort: apply the `kg_event` telemetry table to the live engine. The
/// engine's schema.sql only runs on a fresh Docker volume, so existing graphs
/// need this at runtime. Retries a few times to ride out the container warmup
/// after `up()`; every failure is swallowed (telemetry never gates the app).
pub async fn ensure_telemetry_schema(kg_url: Option<String>) {
    let url = kg_url.unwrap_or_else(|| KG_URL.to_string());
    for attempt in 0..5 {
        if let Ok(engine) = kg(&url) {
            if engine.ensure_event_schema().await.is_ok() {
                return;
            }
        }
        if attempt < 4 {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
    }
}

/// Best-effort: record one account-spend sample into the graph. Called from the
/// usage-fetch commands, which the UI already polls ~every 180s, so this gives
/// a spend curve at no extra network cost. Silently no-ops when the engine is
/// down or the telemetry table isn't there yet.
pub async fn record_usage_snapshot(
    source: &str,
    used_minor: i64,
    limit_minor: Option<i64>,
    currency: String,
    exponent: i32,
) {
    let Ok(engine) = kg(KG_URL) else { return };
    engine
        .record_usage_snapshot(flock_kg::UsageSnapshot {
            source: source.to_string(),
            used_minor,
            limit_minor,
            currency,
            exponent,
        })
        .await;
}

/// Best-effort: record an outcome (a merged PR). Idempotent in the graph layer,
/// so the caller can fire it every time it observes the merge.
pub async fn record_outcome(
    kind: &str,
    ref_id: String,
    title: Option<String>,
    workspace_id: Option<String>,
    files: Vec<String>,
) {
    let Ok(engine) = kg(KG_URL) else { return };
    let _ = engine
        .record_outcome(flock_kg::OutcomeReq {
            workspace_id,
            kind: kind.to_string(),
            ref_id,
            title,
            files,
        })
        .await;
}

/// The person's active org/team ids for stamping into a spawning agent
/// (phase 4). Time-boxed hard: this runs on every spawn, so a slow or down
/// graph must not stall it. None means "not in an org" or "couldn't resolve".
pub async fn primary_membership(person_id: &str) -> Option<(String, Option<String>)> {
    let engine = kg(KG_URL).ok()?;
    tokio::time::timeout(
        std::time::Duration::from_millis(400),
        engine.primary_membership(person_id),
    )
    .await
    .ok()?
    .ok()
    .flatten()
}

/// Mirror the signed-in user's active flock ID org/team into the graph
/// (same UUIDs as the server), making primary_membership — and therefore the
/// FLOCK_ORG_ID/TEAM_ID spawn env — reflect real membership. Returns false
/// when the engine is down or the write failed; the caller treats that as
/// "mirror later", never an error.
pub async fn mirror_membership(
    person_id: &str,
    org_id: uuid::Uuid,
    org_name: &str,
    team: Option<(uuid::Uuid, String)>,
    role: &str,
) -> bool {
    let Ok(engine) = kg(KG_URL) else { return false };
    let _ = engine.ensure_event_schema().await;
    let team_ref = team.as_ref().map(|(id, name)| (*id, name.as_str()));
    engine
        .mirror_membership(person_id, org_id, org_name, team_ref, role)
        .await
        .is_ok()
}

/// Phase-3 headline metrics over the trailing `days` window. Ensures the
/// telemetry tables first so a fresh reader (Insights panel opened before any
/// agent ran) gets zeros, not an error.
pub async fn insights(days: i64, kg_url: Option<String>) -> Result<flock_kg::InsightsSummary, String> {
    let engine = kg(kg_url.as_deref().unwrap_or(KG_URL))?;
    let _ = engine.ensure_event_schema().await;
    let since = chrono::Utc::now() - chrono::Duration::days(days.clamp(1, 3650));
    engine.insights_summary(since).await.map_err(|e| e.to_string())
}

// ─── Live graph reads (sidebar card) ─────────────────────────────────────────

/// Lazily-initialized pools for the app's own graph reads, keyed by
/// connection URL: the default is the local Docker engine, but teams can
/// point flock at a centrally hosted graph instead (Settings → Graph).
/// connect_lazy never touches the network at init, so creating an entry is
/// safe even when the target is down — queries fail fast (3s) instead.
static KG_POOLS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, flock_kg::KnowledgeGraph>>> =
    std::sync::OnceLock::new();

fn kg(url: &str) -> Result<flock_kg::KnowledgeGraph, String> {
    let pools = KG_POOLS.get_or_init(Default::default);
    let mut map = pools.lock().unwrap();
    if let Some(existing) = map.get(url) {
        return Ok(existing.clone());
    }
    let fresh = flock_kg::KnowledgeGraph::connect_lazy(url).map_err(|e| e.to_string())?;
    map.insert(url.to_string(), fresh.clone());
    Ok(fresh)
}

/// Host:port of a postgres:// URL, for the reachability probe. Falls back
/// to the local engine's address when parsing fails.
fn db_addr_of(url: &str) -> String {
    let after_at = url.rsplit('@').next().unwrap_or("");
    let hostport = after_at.split('/').next().unwrap_or("");
    if hostport.is_empty() {
        DB_ADDR.to_string()
    } else if hostport.contains(':') {
        hostport.to_string()
    } else {
        format!("{hostport}:5432")
    }
}

#[derive(Debug, Serialize)]
pub struct GraphOverview {
    pub stats: flock_kg::GraphStats,
}

/// Sidebar summary: workspace-scoped counts + latest activity.
pub async fn overview(workspace_id: Option<String>, kg_url: Option<String>) -> Result<GraphOverview, String> {
    let kg = kg(kg_url.as_deref().unwrap_or(KG_URL))?;
    let stats = kg
        .workspace_stats(workspace_id.as_deref())
        .await
        .map_err(|e| e.to_string())?;
    Ok(GraphOverview { stats })
}

/// Grounding brief for a workspace (empty when nothing's been recorded yet).
pub async fn brief(workspace_id: String, kg_url: Option<String>) -> Result<String, String> {
    let kg = kg(kg_url.as_deref().unwrap_or(KG_URL))?;
    kg.workspace_brief(&workspace_id).await.map_err(|e| e.to_string())
}

// ─── Graph Explorer reads ────────────────────────────────────────────────────

/// Browse/search nodes for the explorer. `query` empty → most recent;
/// `workspace_id`/`kind` are optional filters.
pub async fn list_nodes(
    workspace_id: Option<String>,
    kind: Option<String>,
    query: Option<String>,
    limit: Option<i64>,
    kg_url: Option<String>,
) -> Result<Vec<flock_kg::KgNode>, String> {
    let kg = kg(kg_url.as_deref().unwrap_or(KG_URL))?;
    kg.list_nodes(workspace_id.as_deref(), kind.as_deref(), query.as_deref(), limit.unwrap_or(100))
        .await
        .map_err(|e| e.to_string())
}

/// A node's immediate neighbors (both directions), for the detail pane.
pub async fn node_neighbors(
    node_id: String,
    kg_url: Option<String>,
) -> Result<Vec<flock_kg::KgNeighbor>, String> {
    let id = uuid::Uuid::parse_str(&node_id).map_err(|e| e.to_string())?;
    let kg = kg(kg_url.as_deref().unwrap_or(KG_URL))?;
    kg.neighbors(id).await.map_err(|e| e.to_string())
}

/// What grounding actually did, for the explorer's Recall view: the recent
/// passes with the facts each one injected, the recall leaderboard over the
/// same window, and the windowed counts behind coverage.
#[derive(Debug, Serialize)]
pub struct RecallReport {
    pub passes: Vec<flock_kg::GroundingPass>,
    pub top: Vec<flock_kg::RecallCount>,
    /// The same struct the Insights panel reads, from the same query, so the
    /// two surfaces cannot quote different coverage for one graph. It also
    /// carries the pass counts: the Recall list is capped at 40 rows, and
    /// deriving "how many passes found nothing" from a capped list would
    /// silently answer for the last 40 passes while the window selector said
    /// 90 days.
    pub stats: flock_kg::RecallStats,
}

/// Recall over the trailing `days`. Ensures the telemetry schema first so a
/// graph that predates the `fact_ids` column answers with an empty report
/// rather than a SQL error the UI would have to render as "offline".
pub async fn recall(
    workspace_id: Option<String>,
    days: i64,
    kg_url: Option<String>,
) -> Result<RecallReport, String> {
    let kg = kg(kg_url.as_deref().unwrap_or(KG_URL))?;
    let _ = kg.ensure_event_schema().await;
    let since = chrono::Utc::now() - chrono::Duration::days(days.clamp(1, 3650));
    let ws = workspace_id.as_deref();
    let passes = kg.recent_groundings(ws, 40).await.map_err(|e| e.to_string())?;
    let top = kg.recall_counts(ws, since, 200).await.map_err(|e| e.to_string())?;
    // Coverage's numerator comes from `recall_stats`, not from `top.len()`.
    // The leaderboard is capped at 200, so counting its rows quietly turned
    // coverage into a floor on any graph big enough for the question to matter
    // — and a metric that understates only on large graphs is the same class of
    // mistake as one that overstates on small ones.
    let stats = kg.recall_stats(ws, since).await.map_err(|e| e.to_string())?;
    Ok(RecallReport { passes, top, stats })
}

/// Nodes + edges for the force-directed map (scoped + capped).
pub async fn subgraph(
    workspace_id: Option<String>,
    limit: Option<i64>,
    kg_url: Option<String>,
) -> Result<flock_kg::Subgraph, String> {
    let kg = kg(kg_url.as_deref().unwrap_or(KG_URL))?;
    kg.subgraph(workspace_id.as_deref(), limit.unwrap_or(200))
        .await
        .map_err(|e| e.to_string())
}

/// `docker compose down` (data volume is preserved).
pub fn down() -> Result<(), String> {
    let dir = materialize_infra()?;
    let bin = docker_bin().ok_or("Can't find the docker command.")?;
    let out = Command::new(bin)
        .args(["compose", "-f"])
        .arg(dir.join("docker-compose.yml"))
        .arg("down")
        .output()
        .map_err(|e| format!("failed to run docker compose: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
}

/// Where the automatic backup lands. Through `shared_data_dir`, never a
/// hand-built `~/.flock` — whatever creates that directory first decides the
/// `~/.clarence` migration already happened, and three paths have made exactly
/// that mistake (see `flock_core::paths::shared_data_dir`'s docs).
fn backup_path() -> PathBuf {
    flock_core::paths::shared_data_dir().join("graph-backup.jsonl")
}

/// How often the graph is written out. Knowledge accrues over weeks, so the
/// question this answers is "did a year of it survive the volume being
/// removed", not "is it current to the minute".
const BACKUP_INTERVAL: Duration = Duration::from_secs(6 * 3600);
/// Long enough after launch that a cold start is never competing with a scan of
/// the whole graph.
const BACKUP_FIRST_DELAY: Duration = Duration::from_secs(120);

/// Keep a plain-text copy of the graph outside Docker, on a slow timer.
///
/// The engine is a container on a named volume, and a `docker volume rm`, a
/// Docker Desktop factory reset, or a compose file that drifts to a different
/// volume name takes every decision, attempt and note a team ever recorded with
/// it. There is no other copy. An export nobody has to remember to run is the
/// only version of this that actually protects anything, which is why it is a
/// timer here rather than only a button and a CLI verb.
///
/// Entirely best-effort: the graph is opt-in and usually not running at all, so
/// "cannot connect" is the normal case and must stay silent. Only a write that
/// fails after a successful read is worth a log line — that one means the disk
/// or the path is wrong, and the user has a backup they think exists.
pub fn spawn_auto_backup(kg_url: Option<String>) {
    let url = kg_url.unwrap_or_else(|| KG_URL.to_string());
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(BACKUP_FIRST_DELAY).await;
        loop {
            backup_once(&url).await;
            tokio::time::sleep(BACKUP_INTERVAL).await;
        }
    });
}

async fn backup_once(url: &str) {
    let Ok(engine) = kg(url) else { return };
    let path = backup_path();
    let tmp = path.with_extension("jsonl.partial");
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let Ok(file) = std::fs::File::create(&tmp) else { return };
    let mut w = std::io::BufWriter::new(file);

    // Read first, then move into place. A truncated or half-written file
    // replacing a good backup would be worse than no backup at all, because it
    // looks like one.
    match engine.export_jsonl(&mut w).await {
        Ok(stats) => {
            drop(w);
            match std::fs::rename(&tmp, &path) {
                Ok(()) => tracing::debug!(
                    target: "flock_desktop_lib",
                    nodes = stats.nodes,
                    edges = stats.edges,
                    path = %path.display(),
                    "backed up the graph"
                ),
                Err(e) => tracing::warn!(
                    target: "flock_desktop_lib",
                    error = %e,
                    path = %path.display(),
                    "read the graph but could not write its backup"
                ),
            }
        }
        // The overwhelmingly common case is a graph that is simply not running.
        Err(e) => {
            drop(w);
            let _ = std::fs::remove_file(&tmp);
            tracing::debug!(target: "flock_desktop_lib", error = %e, "graph backup skipped");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The bug this module shipped with: a Finder-launched .app inherits
    /// launchd's bare PATH, which has none of the directories Docker Desktop
    /// installs its CLI into. `docker_bin` must find it anyway, or the graph
    /// engine cannot be started from a packaged build at all — the symptom
    /// being "Docker isn't running" displayed over a running Docker, with the
    /// button appearing to do nothing however often it is pressed.
    #[test]
    fn docker_is_found_without_it_being_on_path() {
        let Some(real) = docker_bin() else {
            eprintln!("docker not installed on this machine; nothing to pin");
            return;
        };
        // Only meaningful if docker lives somewhere the bare PATH can't see.
        if real.starts_with("/usr/bin") || real.starts_with("/bin") {
            return;
        }
        let restore = std::env::var_os("PATH");
        std::env::set_var("PATH", "/usr/bin:/bin:/usr/sbin:/sbin");
        let found = docker_bin();
        match restore {
            Some(p) => std::env::set_var("PATH", p),
            None => std::env::remove_var("PATH"),
        }
        assert!(
            found.is_some(),
            "docker_bin() must fall back to the known install locations; \
             Command::new(\"docker\") is never acceptable here"
        );
    }

    /// The end-to-end proof, against a live Docker daemon and under the exact
    /// PATH a Finder-launched .app gets. Everything else here is a unit test of
    /// a lookup; this is the thing the user actually pressed.
    ///
    ///   cargo test -p flock-desktop --lib -- --ignored the_engine_starts
    ///
    /// Ignored because it starts a real container. It leaves the engine up —
    /// that being the point — so tear it down with Settings → Graph → Stop
    /// engine, or `down()`.
    #[test]
    #[ignore]
    fn the_engine_starts_from_a_finder_launched_app() {
        let restore = std::env::var_os("PATH");
        std::env::set_var("PATH", "/usr/bin:/bin:/usr/sbin:/sbin");
        let result = up();
        let after = status(None);
        match restore {
            Some(p) => std::env::set_var("PATH", p),
            None => std::env::remove_var("PATH"),
        }
        result.expect("up() must work with docker off PATH");
        assert!(after.container_running && after.db_reachable, "{after:?}");
    }

    /// `status` must be able to say "Docker isn't installed" and "Docker is
    /// installed but stopped" apart. One boolean for both is what produced a
    /// hint telling the user to install software they already had.
    #[test]
    fn status_separates_a_missing_cli_from_a_stopped_daemon() {
        let s = status(None);
        if s.docker_ready {
            assert!(s.docker_cli.is_some(), "a ready daemon implies a located CLI");
        }
        assert!(!s.container_running || s.docker_ready);
    }
}
