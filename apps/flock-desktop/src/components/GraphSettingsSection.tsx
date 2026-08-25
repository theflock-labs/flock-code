import { useEffect, useRef, useState } from "react";
import { graphStatus, graphDown, type GraphStatus } from "../lib/tauri";
import { copyText } from "../lib/clipboard";
import { getGraphEnabled, setGraphEnabled, getGraphUrl, setGraphUrl, isTeamGraph, DEFAULT_GRAPH_URL, OPEN_GRAPH_SETUP_EVENT } from "../lib/graphSettings";
import { graphSnippets, type AgentTool } from "../lib/graphSnippets";
import { CheckIcon } from "./friendIcons";

/** Settings → flock Graph. Compact management surface: the opt-in
 * toggle, live engine status, and entry points to the full setup wizard.
 * Self-contained so SettingsDialog only needs a one-line include. */
export default function GraphSettingsSection() {
  const [enabled, setEnabled] = useState(getGraphEnabled());
  const [status, setStatus] = useState<GraphStatus | null>(null);
  const [stopping, setStopping] = useState(false);
  const [teamMode, setTeamMode] = useState(isTeamGraph());
  const [urlInput, setUrlInput] = useState(isTeamGraph() ? getGraphUrl() : "");
  const [tool, setTool] = useState<AgentTool>("claude");
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const copy = (text: string) => {
    copyText(text).then(() => {
      setCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  };

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const poll = () => graphStatus(getGraphUrl()).then((s) => { if (!cancelled) setStatus(s); }).catch(() => {});
    poll();
    const interval = setInterval(poll, 4000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [enabled, teamMode]);

  const applyTeamUrl = () => {
    setGraphUrl(urlInput);
    setTeamMode(isTeamGraph());
    graphStatus(getGraphUrl()).then(setStatus).catch(() => {});
  };

  const useLocalEngine = () => {
    setGraphUrl(DEFAULT_GRAPH_URL);
    setUrlInput("");
    setTeamMode(false);
    graphStatus(getGraphUrl()).then(setStatus).catch(() => {});
  };

  const toggle = () => {
    const next = !enabled;
    setEnabled(next);
    setGraphEnabled(next);
  };

  const stopEngine = async () => {
    setStopping(true);
    try { await graphDown(); } catch (e) { console.error(e); }
    setStopping(false);
    graphStatus().then(setStatus).catch(() => {});
  };

  const engineUp = !!status && status.container_running && status.db_reachable;

  return (
    <div className="settings-section">
      <div className="settings-section-header">Graph</div>
      <div className="settings-row">
        <span className="settings-label">Shared agent memory</span>
        <button className="btn-ghost settings-btn" onClick={toggle}>
          {enabled ? "Enabled — disable" : "Off — enable"}
        </button>
      </div>
      {enabled ? (
        <>
          <div className="settings-row">
            <span className="settings-label">Location</span>
            <div style={{ display: "flex", gap: 6 }}>
              <button className={`btn-ghost settings-btn${!teamMode ? " active" : ""}`} onClick={useLocalEngine}>
                Local engine
              </button>
              <button
                className={`btn-ghost settings-btn${teamMode ? " active" : ""}`}
                onClick={() => setTeamMode(true)}
                title="Point every teammate's flock at one shared graph"
              >
                Team graph
              </button>
            </div>
          </div>

          {teamMode ? (
            <>
              <div className="settings-row">
                <input
                  className="modal-input"
                  style={{ flex: 1, fontSize: 11 }}
                  placeholder="postgresql://user:pass@graph.yourteam.dev:5432/flock_kg"
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                  spellCheck={false}
                />
                <button className="btn-ghost settings-btn" onClick={applyTeamUrl} disabled={!urlInput.trim()}>
                  Save
                </button>
              </div>
              <div className="settings-row">
                <span className="settings-label">Connection</span>
                {status === null ? (
                  <span className="text-ghost">checking…</span>
                ) : status.db_reachable ? (
                  <span className="settings-badge connected">team graph reachable</span>
                ) : (
                  <span className="settings-badge disconnected">unreachable</span>
                )}
              </div>
              <div className="settings-hint">
                One shared graph for the whole team: decisions, attempts, and file
                claims from every teammate's agents, readable by all of them.
                Search is hybrid — full-text plus semantic, with embeddings
                (bge-small) computed locally on each machine. Host any Postgres
                14+ with pgvector and load the schema from
                ~/.flock/graph/schema.sql. Agents connect with this same URL as
                FLOCK_KG_URL (snippets below update automatically).
              </div>
            </>
          ) : (
            <>
              <div className="settings-row">
                <span className="settings-label">Engine</span>
                {status === null ? (
                  <span className="text-ghost">checking…</span>
                ) : engineUp ? (
                  <span className="settings-badge connected">running · :15432</span>
                ) : status.docker_ready ? (
                  <span className="settings-badge disconnected">stopped</span>
                ) : status.docker_cli === null ? (
                  // Never "Docker not running" here: telling someone to start
                  // software they haven't installed is the one hint that
                  // guarantees they get nowhere.
                  <span className="settings-badge disconnected">Docker not installed</span>
                ) : (
                  <span className="settings-badge disconnected">Docker not running</span>
                )}
              </div>
              <div className="settings-row">
                <button
                  className="btn-ghost settings-btn"
                  onClick={() => window.dispatchEvent(new Event(OPEN_GRAPH_SETUP_EVENT))}
                >
                  Open setup guide
                </button>
                {engineUp && (
                  <button className="btn-ghost settings-btn" onClick={stopEngine} disabled={stopping}>
                    {stopping ? "Stopping…" : "Stop engine"}
                  </button>
                )}
              </div>
              <div className="settings-hint">
                Data lives in a local Docker volume; stopping the engine keeps it.
              </div>
            </>
          )}

          <div className="settings-row" style={{ marginTop: 10 }}>
            <span className="settings-label">Connect your tools</span>
          </div>
          <ConnectSnippets
            status={status}
            tool={tool}
            setTool={setTool}
            copied={copied}
            onCopy={copy}
          />
        </>
      ) : (
        <div className="settings-hint">
          A local knowledge graph agents share over MCP — decisions, failed
          attempts, and file ownership persist across agents and sessions, with
          hybrid full-text + semantic search (local bge-small embeddings).
          Opt-in; runs entirely on this machine.{" "}
          <span
            style={{ color: "var(--mint)", cursor: "pointer" }}
            onClick={() => window.dispatchEvent(new Event(OPEN_GRAPH_SETUP_EVENT))}
          >
            Open the setup guide →
          </span>
        </div>
      )}
    </div>
  );
}

function ConnectSnippets({ status, tool, setTool, copied, onCopy }: {
  status: GraphStatus | null;
  tool: AgentTool;
  setTool: (t: AgentTool) => void;
  copied: boolean;
  onCopy: (text: string) => void;
}) {
  const mcpPath = status?.mcp_binary ?? "/path/to/flock-mcp";
  // Role and database keep the old name on purpose: renaming them orphans every
  // existing local pgdata volume, and this literal has to match the engine's.
  const kgUrl = status?.kg_url ?? "postgresql://flock:flock@127.0.0.1:15432/flock_kg";
  const snippets = graphSnippets(mcpPath, kgUrl);
  return (
    <>
      <div className="graph-tool-tabs">
        {(Object.keys(snippets) as AgentTool[]).map((t) => (
          <button
            key={t}
            className={`graph-tool-tab${tool === t ? " active" : ""}`}
            onClick={() => setTool(t)}
          >
            {snippets[t].title}
          </button>
        ))}
      </div>
      <div className="settings-hint" style={{ marginTop: 6 }}>{snippets[tool].hint}</div>
      <div className="graph-snippet" style={{ marginTop: 4 }}>
        <pre>{snippets[tool].code}</pre>
        <button className="btn-ghost settings-btn graph-copy-btn" onClick={() => onCopy(snippets[tool].code)}>
          {copied ? <><CheckIcon size={10} /> copied</> : "copy"}
        </button>
      </div>
      {!status?.mcp_binary && (
        <div className="settings-hint">
          flock-mcp binary not found — build it with{" "}
          <code>cargo build --release -p flock-mcp</code> and this snippet will
          pick up the real path.
        </div>
      )}
    </>
  );
}
