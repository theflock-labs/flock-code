use crate::env;
use anyhow::Result;
use flock_kg::{
    AboutFileReq, CompactReq, EventKind, EventReq, ForgetReq, KnowledgeGraph, LinkByRefReq,
    LinkReq, NodeKind, QueryReq, RecordAttemptReq, RelatedReq, RememberReq, WriteDecisionReq,
    GLOBAL_SCOPE,
};
use serde_json::{json, Value};
use std::sync::Arc;

// ─── initialize ───────────────────────────────────────────────────────────────

pub fn initialize(_params: Value) -> Result<Value> {
    Ok(json!({
        "protocolVersion": "2024-11-05",
        "capabilities": {
            "tools": {}
        },
        "serverInfo": {
            "name": "flock-graph",
            "version": env!("CARGO_PKG_VERSION")
        }
    }))
}

// ─── tools/list ───────────────────────────────────────────────────────────────

pub fn tools_list() -> Result<Value> {
    Ok(json!({
        "tools": [
            {
                "name": "kg.write_decision",
                "description": "Record a design or architectural decision in the shared knowledge graph. Call this every time you settle a non-trivial choice (a library, a pattern, an API shape, a trade-off) so the next agent doesn't re-litigate it. Include the reasoning and what you rejected. ALWAYS pass `files` with the paths the decision governs — that's what makes it discoverable when someone later works on that code. One note per title: writing a label that already exists UPDATES that decision in place, so re-use the same title to keep a decision current, and pass `supersedes` only when replacing a differently-titled decision. Inside the body you can write [[another note's title]] to link it.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "label": {"type": "string", "description": "Short title for the decision. Titles are identity: the same title updates the existing decision instead of creating a duplicate."},
                        "body": {"type": "string", "description": "Full description, rationale, and trade-offs. [[Wikilinks]] to other notes' titles are resolved into links automatically."},
                        "files": {"type": "array", "items": {"type": "string"}, "description": "File paths this decision governs — linked automatically (ABOUT edges)"},
                        "relates_to": {"type": "array", "items": {"type": "string"}, "description": "Labels (or fragments) of existing nodes this connects to — resolved and linked automatically (RELATES_TO)"},
                        "supersedes": {"type": "string", "description": "UUID or label fragment of an older, differently-titled decision this replaces; the old one stops surfacing in queries"},
                        "scope": {"type": "string", "enum": ["workspace", "global"], "default": "workspace", "description": "'global' if this decision applies across every workspace (a durable design principle, naming convention, or stack choice) rather than being specific to the current branch/workspace"},
                        "workspace_id": {"type": "string", "description": "ID of the workspace making this decision (ignored when scope is 'global')"},
                        "agent_id": {"type": "string", "description": "ID of the agent making this decision"}
                    },
                    "required": ["label", "body"]
                }
            },
            {
                "name": "kg.record_attempt",
                "description": "Log an approach you tried and how it turned out. Call this whenever something fails or only partly works, so no other agent burns time repeating it. Say what you tried, why it failed, and what you learned — the notes are fully searchable. Pass `files` for the code involved and `relates_to` for the decision it was in service of.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "label": {"type": "string", "description": "Short description of what was attempted"},
                        "outcome": {"type": "string", "enum": ["success", "failure", "partial"]},
                        "notes": {"type": "string", "description": "What happened, why it failed, what was learned"},
                        "files": {"type": "array", "items": {"type": "string"}, "description": "File paths involved — linked automatically (ABOUT edges)"},
                        "relates_to": {"type": "array", "items": {"type": "string"}, "description": "Labels of related nodes, e.g. the Decision being attempted — linked automatically"},
                        "workspace_id": {"type": "string"},
                        "agent_id": {"type": "string"}
                    },
                    "required": ["label", "outcome"]
                }
            },
            {
                "name": "kg.query",
                "description": "Search the shared knowledge graph. Use this before starting work to check what is already known. Hybrid full-text + semantic search; results are relevance-ranked, scoped to your workspace + global knowledge, hide superseded and forgotten knowledge, and come back with their connections (which files they concern, what they relate to, whether a decision shipped).",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "Natural language search query"},
                        "limit": {"type": "integer", "default": 10, "maximum": 50},
                        "kind": {"type": "string", "description": "Filter by node kind: Decision, Attempt, Note, Interface, File"},
                        "scope": {"type": "string", "enum": ["workspace", "all"], "default": "workspace", "description": "'all' searches every workspace instead of just yours + global"},
                        "include_superseded": {"type": "boolean", "default": false, "description": "Also return decisions that have been superseded"}
                    },
                    "required": ["query"]
                }
            },
            {
                "name": "kg.about_file",
                "description": "Everything the graph knows about one file: every decision, failed attempt, and note recorded about it. Call this before making significant changes to a file — it's the fastest way to inherit its history.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "file_path": {"type": "string", "description": "Path to the file (relative or absolute; suffix-matched)"}
                    },
                    "required": ["file_path"]
                }
            },
            {
                "name": "kg.related",
                "description": "Find nodes related to a given node by traversing edges in the knowledge graph. Use this to expand from a decision, attempt, note, or file to everything connected to it.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "node_id": {"type": "string", "format": "uuid", "description": "Starting node ID"},
                        "edge_type": {"type": "string", "description": "Filter traversal to this edge type: ABOUT, RELATES_TO, SUPERSEDES"},
                        "depth": {"type": "integer", "default": 2, "maximum": 5}
                    },
                    "required": ["node_id"]
                }
            },
            {
                "name": "kg.remember",
                "description": "Store a piece of knowledge worth keeping that isn't a decision or a failed attempt: a convention, a gotcha, an invariant, a domain fact, an API contract, a person's stated preference. This is what turns the graph into a knowledge base the whole team's agents can draw on. One note per title: re-using an existing title UPDATES that note in place — the natural way to keep a fact current. To CORRECT a differently-titled note, pass `supersedes` with the old one's label. Inside the body you can write [[another note's title]] to link it.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "label": {"type": "string", "description": "Short title for the note. Titles are identity: the same title updates the existing note instead of creating a duplicate."},
                        "body": {"type": "string", "description": "The knowledge itself, in full. [[Wikilinks]] to other notes' titles are resolved into links automatically."},
                        "kind": {"type": "string", "description": "Node kind, default Note. Use Interface for an API/type contract."},
                        "files": {"type": "array", "items": {"type": "string"}, "description": "File paths this knowledge concerns — linked automatically (ABOUT edges)"},
                        "relates_to": {"type": "array", "items": {"type": "string"}, "description": "Labels of existing nodes this connects to — linked automatically"},
                        "supersedes": {"type": "string", "description": "UUID or label fragment of an earlier, differently-titled note/interface this corrects or replaces; the old one stops surfacing in queries (SUPERSEDES)"},
                        "scope": {"type": "string", "enum": ["workspace", "global"], "default": "workspace", "description": "'global' if this is a durable cross-cutting fact (a team-wide convention, gotcha, or invariant) rather than something specific to the current branch/workspace"},
                        "workspace_id": {"type": "string", "description": "ID of the workspace this note belongs to (ignored when scope is 'global')"},
                        "agent_id": {"type": "string"}
                    },
                    "required": ["label", "body"]
                }
            },
            {
                "name": "kg.forget",
                "description": "Archive knowledge that turned out to be wrong or obsolete — it stops surfacing everywhere (queries, briefs, grounding), with your reason kept for the audit trail. Use this when there's no replacement to record; when there IS a replacement, prefer writing it with `supersedes` instead.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "ref": {"type": "string", "description": "UUID or label fragment of the decision/attempt/note to forget"},
                        "reason": {"type": "string", "description": "Why it's wrong or obsolete"}
                    },
                    "required": ["ref"]
                }
            },
            {
                "name": "kg.compact_candidates",
                "description": "List old, long knowledge worth summarizing, biggest first, with the full text of each. Nothing is changed by calling this — you read a candidate, write a much shorter version that keeps the technical decisions and the outcome, and send it back with kg.compact. The original is kept and can be restored, so a summary that loses something is recoverable. Only knowledge that is still live and has never been compacted is offered.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "limit": {"type": "integer", "default": 3, "maximum": 20, "description": "How many candidates to return. Summarizing well takes attention — take a few, not all of them."}
                    }
                }
            },
            {
                "name": "kg.compact",
                "description": "Replace a node's body with your summary, keeping the original so it can be restored. The summary must keep what a future reader needs — the decision, why, what was rejected, how it turned out — and drop the retelling. It has to be at most three quarters the length of what it replaces, and should aim far shorter; a summary that saves almost nothing is refused. This is for knowledge that is still true but overlong, not for knowledge that is wrong: use kg.forget for that.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "ref": {"type": "string", "description": "UUID or label fragment of the node to compact"},
                        "summary": {"type": "string", "description": "The shorter body to store in its place"}
                    },
                    "required": ["ref", "summary"]
                }
            },
            {
                "name": "kg.restore",
                "description": "Put back the text a compaction replaced, one level at a time. Use this the moment a compacted note reads as if something load-bearing was dropped — the original is kept precisely so that is a recoverable mistake rather than a permanent one.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "ref": {"type": "string", "description": "UUID or label fragment of the node to restore"}
                    },
                    "required": ["ref"]
                }
            },
            {
                "name": "kg.link",
                "description": "Draw an association between two existing nodes. Both endpoints accept a node UUID or a label fragment (resolved to the newest match) — no ID lookup needed. Prefer the `files`/`relates_to` parameters and [[wikilinks]] on the write tools; use kg.link for connections you notice after the fact.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "from": {"type": "string", "description": "Source node: UUID or label fragment"},
                        "to": {"type": "string", "description": "Target node: UUID or label fragment"},
                        "edge_type": {"type": "string", "enum": ["RELATES_TO", "ABOUT", "SUPERSEDES"], "description": "RELATES_TO: associated ideas. ABOUT: knowledge → file. SUPERSEDES: newer knowledge replaces older."}
                    },
                    "required": ["from", "to", "edge_type"]
                }
            }
        ]
    }))
}

// ─── tools/call ───────────────────────────────────────────────────────────────

/// Fill workspace_id / agent_id from the environment flock exports into
/// every agent pane (and which this server inherits, since agent CLIs spawn
/// their MCP servers as child processes). Agents get correct attribution
/// with zero prompt engineering; explicit arguments still win. A caller that
/// passes `scope: "global"` gets the `GLOBAL_SCOPE` sentinel instead, so the
/// node reads back in every workspace instead of just the current one.
fn apply_identity_defaults(args: &mut Value) {
    let Some(obj) = args.as_object_mut() else { return };
    let is_global = obj.get("scope").and_then(|v| v.as_str()) == Some("global");
    if is_global {
        obj.insert("workspace_id".into(), json!(GLOBAL_SCOPE));
    } else if !obj.contains_key("workspace_id") {
        if let Some(ws) = env::var("FLOCK_WORKSPACE_ID") {
            obj.insert("workspace_id".into(), json!(ws));
        }
    }
    if !obj.contains_key("agent_id") {
        if let Some(name) = env::var("FLOCK_AGENT_NAME") {
            obj.insert("agent_id".into(), json!(name));
        } else if let Some(pane) = env::var("FLOCK_PANE_ID") {
            obj.insert("agent_id".into(), json!(pane));
        }
    }
    // Tenant tag (phase 4): stamp the agent's org/team onto knowledge writes so
    // the node itself is tenant-scoped, not just its telemetry. Ignored by tools
    // whose req type has no org_id/team_id field.
    if !obj.contains_key("org_id") {
        if let Some(org) = env::var("FLOCK_ORG_ID") {
            obj.insert("org_id".into(), json!(org));
        }
    }
    if !obj.contains_key("team_id") {
        if let Some(team) = env::var("FLOCK_TEAM_ID") {
            obj.insert("team_id".into(), json!(team));
        }
    }
    // Provenance spine: the author and codebase every knowledge write is
    // auto-linked to (AUTHORED_BY → Person, IN_REPO → Repo). Injecting these
    // here is what guarantees the ≥2-associations invariant with zero prompt
    // engineering — an agent never has to think about who or where. Ignored by
    // tools whose req type has no such field (query, forget, link).
    for (key, var) in [
        ("person_id", "FLOCK_PERSON_ID"),
        ("person_name", "FLOCK_PERSON_NAME"),
        ("repo_key", "FLOCK_REPO_ID"),
        ("repo_name", "FLOCK_REPO_NAME"),
    ] {
        if !obj.contains_key(key) {
            if let Some(val) = env::var(var) {
                obj.insert(key.into(), json!(val));
            }
        }
    }
}

pub async fn tools_call(params: Value, kg: &Arc<KnowledgeGraph>) -> Result<Value> {
    let name = params
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("missing tool name"))?;

    let mut args = params.get("arguments").cloned().unwrap_or(json!({}));
    apply_identity_defaults(&mut args);

    // Telemetry context captured before dispatch (flock Enterprise phase 1):
    // identity is already resolved into `args`, and `op`/`ev_kind` classify the
    // call for the event log. The dispatch itself runs inside an async block so
    // both success and failure are logged before we return or propagate.
    let started = std::time::Instant::now();
    let workspace_id = args.get("workspace_id").and_then(|v| v.as_str()).map(String::from);
    let agent_id = args.get("agent_id").and_then(|v| v.as_str()).map(String::from);
    let person_id = env::var("FLOCK_PERSON_ID");
    let org_id = env::var("FLOCK_ORG_ID");
    let team_id = env::var("FLOCK_TEAM_ID");
    let op = name.strip_prefix("kg.").unwrap_or(name).to_string();
    // Write is the default because the cost of misclassifying a write as a read
    // is losing it from the write-compliance signal entirely. `compact_candidates`
    // has to be listed: it returns bodies and changes nothing, and counting it as
    // a write would inflate the very number that says whether the graph is being
    // fed with new knowledge.
    let ev_kind = match name {
        "kg.query" | "kg.about_file" | "kg.related" | "kg.compact_candidates" => EventKind::Read,
        _ => EventKind::Write,
    };

    // Each arm yields (text, node_count): rows returned for reads, nodes
    // touched for writes.
    let dispatch: Result<(String, Option<i32>)> = async {
    Ok(match name {
        "kg.write_decision" => {
            let req: WriteDecisionReq = serde_json::from_value(args)?;
            let w = kg.write_decision(req).await?;
            let verb = if w.updated { "Decision updated (same title)" } else { "Decision recorded" };
            (format!("{verb}. id={} label=\"{}\"", w.node.id, w.node.label), Some(1))
        }

        "kg.record_attempt" => {
            let req: RecordAttemptReq = serde_json::from_value(args)?;
            let node = kg.record_attempt(req).await?;
            (format!("Attempt recorded. id={} label=\"{}\"", node.id, node.label), Some(1))
        }

        "kg.query" => {
            let req: QueryReq = serde_json::from_value(args)?;
            let nodes = kg.query(req).await?;
            let count = nodes.len() as i32;
            let text = if nodes.is_empty() {
                "No matching nodes found.".to_string()
            } else {
                // Enrich each hit with its connections so results carry their
                // context (governed files, associations, supersession, shipped
                // artifact) instead of arriving as disconnected rows.
                let ids: Vec<_> = nodes.iter().map(|n| n.id).collect();
                let links = kg.links_for(&ids).await.unwrap_or_default();
                let lines: Vec<String> = nodes
                    .iter()
                    .map(|n| {
                        let kind = match (&n.kind, n.outcome.as_deref()) {
                            (NodeKind::Attempt, Some(o)) if !o.is_empty() => format!("Attempt·{o}"),
                            (k, _) => k.as_str().to_string(),
                        };
                        let mut line = format!(
                            "[{}] {} — {} ({})",
                            kind,
                            n.label,
                            n.body.as_deref().unwrap_or(""),
                            n.id
                        );
                        let mut ctx: Vec<String> = Vec::new();
                        if let Some(by) = n.created_by_agent.as_deref().filter(|a| !a.is_empty()) {
                            ctx.push(format!("by {by}"));
                        }
                        if let Some(s) = n.shipped_in.as_deref().filter(|s| !s.is_empty()) {
                            ctx.push(format!("shipped: {s}"));
                        }
                        for l in links.iter().filter(|l| l.node_id == n.id) {
                            match (l.edge_type.as_str(), l.direction.as_str()) {
                                ("ABOUT", "out") => ctx.push(format!("about {}", l.other_label)),
                                ("SUPERSEDES", "out") => ctx.push(format!("supersedes \"{}\"", l.other_label)),
                                ("SUPERSEDES", "in") => ctx.push(format!("SUPERSEDED by \"{}\"", l.other_label)),
                                ("RELATES_TO", _) => ctx.push(format!("relates to \"{}\"", l.other_label)),
                                ("IN_REPO", "out") => ctx.push(format!("in {}", l.other_label)),
                                _ => {}
                            }
                        }
                        ctx.truncate(7);
                        if !ctx.is_empty() {
                            line.push_str(&format!("\n    ↳ {}", ctx.join(" · ")));
                        }
                        line
                    })
                    .collect();
                lines.join("\n")
            };
            (text, Some(count))
        }

        "kg.about_file" => {
            let req: AboutFileReq = serde_json::from_value(args)?;
            let known = kg.about_file(&req.file_path).await?;
            let count = known.len() as i32;
            let text = if known.is_empty() {
                format!("Nothing recorded about \"{}\" yet.", req.file_path)
            } else {
                let mut out = String::new();
                for fk in &known {
                    out.push_str(&format!("{}:\n", fk.file.label));
                    let mut any = false;
                    for nb in &fk.neighbors {
                        if nb.edge_type != "ABOUT" || nb.direction != "in" {
                            continue;
                        }
                        let kind = match (&nb.node.kind, nb.node.outcome.as_deref()) {
                            (NodeKind::Attempt, Some(o)) if !o.is_empty() => format!("Attempt·{o}"),
                            (k, _) => k.as_str().to_string(),
                        };
                        out.push_str(&format!(
                            "  - [{}] {} — {}\n",
                            kind,
                            nb.node.label,
                            nb.node.body.as_deref().unwrap_or("")
                        ));
                        any = true;
                    }
                    if !any {
                        out.push_str("  - known in the graph, but nothing recorded about it yet\n");
                    }
                }
                out.trim_end().to_string()
            };
            (text, Some(count))
        }

        "kg.related" => {
            let req: RelatedReq = serde_json::from_value(args)?;
            let nodes = kg.related(req).await?;
            let count = nodes.len() as i32;
            let text = if nodes.is_empty() {
                "No related nodes found.".to_string()
            } else {
                let lines: Vec<String> = nodes
                    .iter()
                    .map(|n| {
                        format!(
                            "[{}] {} ({})",
                            n.kind.as_str(),
                            n.label,
                            n.id
                        )
                    })
                    .collect();
                lines.join("\n")
            };
            (text, Some(count))
        }

        "kg.remember" => {
            let req: RememberReq = serde_json::from_value(args)?;
            let w = kg.remember(req).await?;
            let verb = if w.updated { "Updated (same title)" } else { "Noted" };
            (format!("{verb}. id={} label=\"{}\"", w.node.id, w.node.label), Some(1))
        }

        "kg.forget" => {
            let req: ForgetReq = serde_json::from_value(args)?;
            let reference = req.reference.clone();
            match kg.forget(req).await? {
                Some(label) => (format!("Forgotten: \"{label}\" — it will no longer surface."), Some(1)),
                None => (format!("No live node matched \"{reference}\" — nothing forgotten. Try kg.query to find the exact label."), Some(0)),
            }
        }

        "kg.compact_candidates" => {
            let limit = args.get("limit").and_then(|v| v.as_i64()).unwrap_or(3);
            let ws = args.get("workspace_id").and_then(|v| v.as_str());
            let cands = kg.compaction_candidates(ws, limit).await?;
            let n = cands.len();
            if cands.is_empty() {
                ("Nothing is due for compaction — no live knowledge is both old enough and long enough to be worth summarizing.".to_string(), Some(0))
            } else {
                let mut out = format!(
                    "{n} candidate{} for compaction. Summarize each and send it back with kg.compact (ref, summary); the original is kept.\n",
                    if n == 1 { "" } else { "s" }
                );
                for c in &cands {
                    out.push_str(&format!(
                        "\n─── {} · {} · {} bytes · last edited {}\n{}\n",
                        c.kind,
                        c.label,
                        c.bytes,
                        c.updated_at.format("%Y-%m-%d"),
                        c.body
                    ));
                }
                (out, Some(n as i32))
            }
        }

        "kg.compact" => {
            let req: CompactReq = serde_json::from_value(args)?;
            let reference = req.reference.clone();
            match kg.compact(req).await? {
                Some(r) => {
                    let saved = r.before_bytes - r.after_bytes;
                    let pct = if r.before_bytes > 0 {
                        saved * 100 / r.before_bytes
                    } else {
                        0
                    };
                    (
                        format!(
                            "Compacted \"{}\": {} → {} bytes ({pct}% smaller). The original is kept — kg.restore puts it back.",
                            r.label, r.before_bytes, r.after_bytes
                        ),
                        Some(1),
                    )
                }
                None => (
                    format!("No live node matched \"{reference}\" — nothing compacted. Try kg.query to find the exact label."),
                    Some(0),
                ),
            }
        }

        "kg.restore" => {
            let reference = args
                .get("ref")
                .or_else(|| args.get("reference"))
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            match kg.restore(&reference).await? {
                Some(label) => (
                    format!("Restored \"{label}\" — the text a compaction replaced is back."),
                    Some(1),
                ),
                None => (
                    format!("Nothing to restore for \"{reference}\" — it has no compaction left to undo."),
                    Some(0),
                ),
            }
        }

        "kg.link" => {
            // Accept both shapes: the new by-ref {from, to} (UUID or label
            // fragment) and the legacy {from_node_id, to_node_id} UUIDs.
            let text = if args.get("from").is_some() {
                let req: LinkByRefReq = serde_json::from_value(args)?;
                let from = kg.resolve_ref(&req.from, &[]).await?;
                let to = kg.resolve_ref(&req.to, &[]).await?;
                match (from, to) {
                    (Some(f), Some(t)) => {
                        kg.link(LinkReq { from_node_id: f, to_node_id: t, edge_type: req.edge_type.clone() }).await?;
                        format!("Linked ({}).", req.edge_type)
                    }
                    (None, _) => format!("No node matched \"{}\" — nothing linked. Try kg.query to find the exact label.", req.from),
                    (_, None) => format!("No node matched \"{}\" — nothing linked. Try kg.query to find the exact label.", req.to),
                }
            } else {
                let req: LinkReq = serde_json::from_value(args)?;
                let edge = req.edge_type.clone();
                kg.link(req).await?;
                format!("Linked ({edge}).")
            };
            (text, Some(1))
        }

        other => anyhow::bail!("unknown tool: {other}"),
    })
    }
    .await;

    // Telemetry, best-effort: a logging failure must never change the tool's
    // result. Records latency and node count on success, the error on failure.
    let mut ev = EventReq::new(op, ev_kind);
    ev.workspace_id = workspace_id;
    ev.agent_id = agent_id;
    ev.person_id = person_id;
    ev.org_id = org_id;
    ev.team_id = team_id;
    ev.latency_ms = Some(started.elapsed().as_millis() as i32);
    match &dispatch {
        Ok((_, node_count)) => ev.node_count = *node_count,
        Err(e) => {
            ev.ok = false;
            ev.error = Some(e.to_string());
        }
    }
    kg.log_event(ev).await;

    let (text, _) = dispatch?;
    Ok(json!({
        "content": [{"type": "text", "text": text}]
    }))
}
