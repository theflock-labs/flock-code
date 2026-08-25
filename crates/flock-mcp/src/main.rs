mod env;
mod protocol;
mod tools;

use anyhow::Result;
use flock_kg::{EventKind, EventReq, KnowledgeGraph};
use protocol::{JsonRpcRequest, JsonRpcResponse};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

// flock-mcp: MCP stdio server exposing kg.* tools.
//
// Agents configure it in CLAUDE.md / .claude/settings.json:
//   {
//     "mcpServers": {
//       "flock-graph": {
//         "command": "flock-mcp",
//         "env": { "FLOCK_KG_URL": "postgresql://..." }
//       }
//     }
//   }
//
// Transport: newline-delimited JSON-RPC 2.0 over stdio (MCP 2024-11-05).

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr) // keep stdout clean for JSON-RPC
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("flock_mcp=info".parse()?),
        )
        .init();

    // The Postgres role and database names predate the rename and stay: they
    // are baked into every already-initialized volume, and POSTGRES_USER only
    // takes effect on a fresh one. Renaming them here would lock existing
    // graphs out of their own data. Must match the engine's docker-compose.yml.
    let kg_url = env::var("FLOCK_KG_URL")
        .unwrap_or_else(|| "postgresql://flock:flock@localhost:15432/flock_kg".into());

    // `flock-mcp ground` — one-shot UserPromptSubmit hook mode: read the
    // hook JSON from stdin, print a compact context block for the prompt,
    // exit 0. `flock-mcp brief` — one-shot session-start mode: print the
    // graph protocol + this workspace's current knowledge. Both are for agents
    // (codex, opencode) that inject a hook/plugin's stdout into context but
    // have no `--append-system-prompt` equivalent. Everything else is the MCP
    // stdio server.
    match std::env::args().nth(1).as_deref() {
        // The three one-shot hook modes run the local embedder off. See
        // `flock_kg::embed::disable`: a process this short-lived can never
        // finish a warm, so the semantic leg was already inert here — and the
        // half-built ONNX session took the process down with it on roughly a
        // third of exits, which a UserPromptSubmit hook pays for by having its
        // output thrown away.
        Some("ground") => {
            flock_kg::embed::disable();
            ground(&kg_url).await;
            return Ok(());
        }
        Some("brief") => {
            flock_kg::embed::disable();
            brief(&kg_url).await;
            return Ok(());
        }
        Some("endturn") => {
            flock_kg::embed::disable();
            endturn(&kg_url).await;
            return Ok(());
        }
        // `flock-mcp export [path]` / `import <path>` — the graph lives in a
        // Docker volume, and a volume is one `docker volume rm` from being the
        // only copy of everything a team learned. These are plain files a person
        // can read, diff and put in a backup, and they run without the desktop
        // app so they can go in a cron.
        Some("export") => {
            let path = std::env::args().nth(2);
            return export(&kg_url, path.as_deref()).await;
        }
        Some("import") => {
            let Some(path) = std::env::args().nth(2) else {
                eprintln!("usage: flock-mcp import <path.jsonl>");
                std::process::exit(2);
            };
            return import(&kg_url, &path).await;
        }
        _ => {}
    }

    // Lazy: the server must come up (and answer initialize/tools-list) even
    // when the graph engine isn't running yet — agents register this MCP
    // server once, and the engine may start later. A down engine surfaces
    // as a clear per-tool-call error instead of a boot crash.
    let kg = Arc::new(KnowledgeGraph::connect_lazy(&kg_url)?);
    tracing::info!("flock-mcp ready (flock Graph at {kg_url})");

    // Best-effort: ensure the telemetry table exists on the live database (the
    // engine's schema.sql only runs on a fresh Docker volume). Spawned so a
    // down engine can't delay server readiness; failure is logged and ignored.
    {
        let kg = Arc::clone(&kg);
        tokio::spawn(async move {
            if let Err(e) = kg.ensure_event_schema().await {
                tracing::warn!("kg_event schema ensure skipped (engine down?): {e}");
            }
        });
    }

    let stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();
    let mut reader = BufReader::new(stdin);
    let mut line = String::new();

    loop {
        line.clear();
        let n = reader.read_line(&mut line).await?;
        if n == 0 {
            break; // stdin closed
        }

        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let response = handle_message(trimmed, &kg).await;

        if let Some(resp) = response {
            let mut out = serde_json::to_string(&resp)?;
            out.push('\n');
            stdout.write_all(out.as_bytes()).await?;
            stdout.flush().await?;
        }
    }

    Ok(())
}

async fn handle_message(msg: &str, kg: &Arc<KnowledgeGraph>) -> Option<JsonRpcResponse> {
    let req: JsonRpcRequest = match serde_json::from_str(msg) {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("invalid JSON-RPC: {e}");
            return Some(JsonRpcResponse::error(
                None,
                -32700,
                "Parse error",
                Some(e.to_string()),
            ));
        }
    };

    // Notifications have no id and require no response
    let id = match req.id.clone() {
        Some(id) => id,
        None => {
            handle_notification(&req.method);
            return None;
        }
    };

    let result = match req.method.as_str() {
        "initialize" => tools::initialize(req.params),
        "tools/list" => tools::tools_list(),
        "tools/call" => tools::tools_call(req.params, kg).await,
        other => {
            return Some(JsonRpcResponse::error(
                Some(id),
                -32601,
                "Method not found",
                Some(format!("unknown method: {other}")),
            ));
        }
    };

    match result {
        Ok(value) => Some(JsonRpcResponse::success(id, value)),
        Err(e) => {
            let msg = e.to_string();
            // Translate raw connection failures into something the agent can
            // relay usefully to the human.
            let detail = if msg.contains("Connection refused") || msg.contains("pool timed out") {
                format!(
                    "The flock Graph engine is not running. Start it from flock → Settings → flock Graph (or `docker compose -f ~/.flock/graph/docker-compose.yml up -d`). Underlying error: {msg}"
                )
            } else {
                msg
            };
            Some(JsonRpcResponse::error(Some(id), -32000, "Tool error", Some(detail)))
        }
    }
}

fn handle_notification(method: &str) {
    match method {
        "notifications/initialized" => tracing::info!("client initialized"),
        _ => tracing::debug!("notification: {method}"),
    }
}

/// UserPromptSubmit hook body: whatever this prints to stdout (exit 0) is
/// injected into the agent's context for that prompt. Grounding must never
/// get in the user's way, so every failure mode — engine down, bad JSON,
/// slow query — degrades to *no output*, never to an error or a stall. The
/// budget is hard-capped well under the hook timeout.
async fn ground(kg_url: &str) {
    use tokio::io::AsyncReadExt;

    let mut input = String::new();
    if tokio::io::stdin().read_to_string(&mut input).await.is_err() {
        return;
    }
    let prompt = serde_json::from_str::<serde_json::Value>(&input)
        .ok()
        .and_then(|v| v.get("prompt").and_then(|p| p.as_str()).map(str::to_owned))
        .unwrap_or_default();
    // Skip trivial prompts (bare "y", "continue", slash commands) — no signal
    // to search on, and injecting boilerplate on every keystroke is noise.
    if prompt.trim().len() < 12 || prompt.trim_start().starts_with('/') {
        return;
    }

    let workspace_id = env::var("FLOCK_WORKSPACE_ID");
    let Ok(kg) = KnowledgeGraph::connect_lazy(kg_url) else { return };

    let pack = tokio::time::timeout(
        std::time::Duration::from_millis(1500),
        kg.context_pack(workspace_id.as_deref(), &prompt),
    )
    .await;
    if let Ok(Ok(pack)) = pack {
        if !pack.text.is_empty() {
            println!("{}", pack.text);
        }
        // Log the grounding pass, time-boxed so a slow engine can't push this
        // one-shot hook past its budget. A zero-fact pass is the *important*
        // one to log: it is the denominator, and every readout built on this
        // table before now quietly dropped it, which is how a graph that
        // answered nothing all week still showed a rising number.
        //
        // `fact_ids` is what every recall figure is computed from.
        // `grounding_hits` is written as its length purely so old and new rows
        // agree; nothing reports it. The count used to be re-derived by
        // counting "- " bullets in the rendered text, which was correct about
        // the text and told you nothing about whether the graph was working.
        let mut ev = EventReq::new("ground", EventKind::Ground);
        ev.agent_id = env::var("FLOCK_AGENT_NAME").or_else(|| env::var("FLOCK_PANE_ID"));
        ev.person_id = env::var("FLOCK_PERSON_ID");
        ev.org_id = env::var("FLOCK_ORG_ID");
        ev.team_id = env::var("FLOCK_TEAM_ID");
        ev.grounding_hits = Some(pack.fact_ids.len() as i32);
        ev.fact_ids = pack.fact_ids;
        ev.workspace_id = workspace_id;
        let _ = tokio::time::timeout(std::time::Duration::from_millis(500), kg.log_event(ev)).await;
    }
}

/// Stop-hook body: log a single turn-end telemetry event and exit. Paired with
/// the per-write and per-ground events, this makes write-compliance measurable
/// — the share of turns in which an agent actually recorded something. Prints
/// nothing (the turn is already over; nothing to inject) and never errors.
async fn endturn(kg_url: &str) {
    let Ok(kg) = KnowledgeGraph::connect_lazy(kg_url) else { return };
    let mut ev = EventReq::new("turn_end", EventKind::Turn);
    ev.agent_id = env::var("FLOCK_AGENT_NAME").or_else(|| env::var("FLOCK_PANE_ID"));
    ev.person_id = env::var("FLOCK_PERSON_ID");
    ev.org_id = env::var("FLOCK_ORG_ID");
    ev.team_id = env::var("FLOCK_TEAM_ID");
    ev.workspace_id = env::var("FLOCK_WORKSPACE_ID");
    let _ = tokio::time::timeout(std::time::Duration::from_millis(500), kg.log_event(ev)).await;
}

/// The canonical graph-usage protocol injected into every agent's context.
/// Claude gets an equivalent string via `--append-system-prompt` (mirrored in
/// App.tsx `GRAPH_PROTOCOL` — keep the two in sync); codex/opencode, which have
/// no such flag, receive this via `flock-mcp brief` from a SessionStart hook
/// (codex) or a chat plugin (opencode).
const GRAPH_PROTOCOL: &str = "The flock-graph MCP tools are your shared, persistent memory for this project and the people on it. It is the source of truth for prior decisions, context, and preferences — shared live with every other agent and teammate on this project.\n\
This is NOT your built-in/session memory. When you are asked to recall anything (a past decision, someone's preference, earlier work, why something was done), query the graph with kg.query. Do not answer 'nothing is recorded' from any other memory feature without checking kg.query first. Relevant graph knowledge is also injected automatically with each of your prompts — treat an injected 'flock Graph' block as recall you should honor.\n\
Before significant changes to a file, run kg.about_file on it — it returns every decision, failed attempt, and note recorded about that file.\n\
Record continuously as you work, not just at the end:\n\
- kg.write_decision when you settle a non-trivial choice (library, pattern, API shape, trade-off), with your reasoning and what you rejected. ALWAYS pass `files` (paths it governs); pass `supersedes` (a label fragment is fine) when it replaces a differently-titled decision.\n\
- kg.record_attempt when something fails or only partly works, so nobody repeats it. Pass `files` and, when it was in service of a decision, `relates_to` with that decision's label.\n\
- kg.remember for reusable facts, conventions, invariants, and a person's stated preferences — with `files` when it concerns specific code.\n\
- kg.forget when recorded knowledge turns out to be wrong or obsolete and there is no replacement — it stops surfacing, with your reason kept.\n\
Titles are identity: writing a label that already exists UPDATES that note in place — re-use titles to keep knowledge current instead of piling up near-duplicates. Inside any body you can write [[another note's title]] to link it; `files` and `relates_to` draw ABOUT/RELATES_TO edges automatically, so you never look up node IDs. kg.link (labels work) is only for connections you notice after the fact.\n\
When you finish, make sure the decisions and dead ends from this session are in the graph so the next agent can pick up exactly where you left off.";

/// SessionStart hook / plugin body: print the graph protocol followed by this
/// workspace's current recorded knowledge, so an agent starts a session already
/// aware — the codex/opencode analogue of Claude's spawn-time system-prompt
/// injection. Like `ground`, every failure degrades to less output (or none),
/// never an error or a stall. Callers guard on FLOCK_PANE_ID.
async fn brief(kg_url: &str) {
    println!("{GRAPH_PROTOCOL}");

    let Some(workspace_id) = env::var("FLOCK_WORKSPACE_ID") else { return };
    let Ok(kg) = KnowledgeGraph::connect_lazy(kg_url) else { return };
    let brief = tokio::time::timeout(
        std::time::Duration::from_millis(1500),
        kg.workspace_brief(&workspace_id),
    )
    .await;
    if let Ok(Ok(text)) = brief {
        if !text.trim().is_empty() {
            println!("\n{}", text.trim());
        }
    }
}

/// `flock-mcp export [path]` — write the whole graph as JSONL.
///
/// Stdout when no path is given, so it composes (`flock-mcp export | gzip >
/// graph.jsonl.gz`). Stats go to stderr either way, so they never end up inside
/// the file being written.
///
/// `connect`, not `connect_lazy`: everything else in this binary has to survive
/// a graph that is not running yet, but an export that silently produces an
/// empty file is worse than one that says the engine is down.
async fn export(kg_url: &str, path: Option<&str>) -> anyhow::Result<()> {
    let kg = KnowledgeGraph::connect(kg_url).await?;
    let stats = match path {
        Some(p) => {
            // Write beside the destination and rename over it, so an export
            // interrupted halfway cannot replace a good backup with a truncated
            // one. Same reason the release script does it.
            let tmp = format!("{p}.partial");
            let mut f = std::io::BufWriter::new(std::fs::File::create(&tmp)?);
            let stats = kg.export_jsonl(&mut f).await?;
            drop(f);
            std::fs::rename(&tmp, p)?;
            eprintln!("wrote {p}");
            stats
        }
        None => {
            let stdout = std::io::stdout();
            let mut w = std::io::BufWriter::new(stdout.lock());
            kg.export_jsonl(&mut w).await?
        }
    };
    eprintln!(
        "exported {} nodes, {} snapshots, {} edges",
        stats.nodes, stats.snapshots, stats.edges
    );
    Ok(())
}

/// `flock-mcp import <path>` — read an export back in.
///
/// Additive: existing rows are left alone, so this fills an empty graph or the
/// gaps in a live one and never overwrites. See `KnowledgeGraph::import_jsonl`.
async fn import(kg_url: &str, path: &str) -> anyhow::Result<()> {
    let kg = KnowledgeGraph::connect(kg_url).await?;
    kg.ensure_event_schema().await?;
    let f = std::io::BufReader::new(std::fs::File::open(path)?);
    let s = kg.import_jsonl(f).await?;
    eprintln!(
        "imported {} nodes, {} snapshots, {} edges ({} already present, {} skipped)",
        s.nodes, s.snapshots, s.edges, s.existing, s.skipped
    );
    Ok(())
}
