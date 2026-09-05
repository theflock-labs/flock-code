import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { graphListNodes, graphNodeNeighbors, graphSubgraph, graphRecall, type GraphKgNode, type GraphNeighbor, type GraphSubgraph, type RecallReport } from "../lib/tauri";
import { getGraphUrl, getGraphExplorerView, setGraphExplorerView, type GraphExplorerView } from "../lib/graphSettings";
import ModalCloseButton from "./ModalCloseButton";
import GraphRecallView from "./GraphRecallView";
import { useFocusTrap } from "../lib/useFocusTrap";
import { DiamondIcon } from "./statusIcons";
import "./GraphExplorer.css";

// The 3D graph pulls in three.js (~1.4MB). Load it only when the graph view is
// actually opened, so it stays off the app's startup path.
const GraphCanvas = lazy(() => import("./GraphCanvas"));

interface Props {
  /** Focused workspace id — the explorer defaults to scoping the graph to it. */
  workspaceId: string | null;
  workspaceName?: string | null;
  onClose: () => void;
}

// Every node kind, ordered as they matter to a person reading the graph, each
// with a stable accent so a node reads the same in the catalog, the detail
// header, and (Phase 2) the force-directed view.
const KINDS = [
  "Decision", "Attempt", "File", "Note", "Interface", "Person", "Repo",
] as const;
type Kind = (typeof KINDS)[number];

const KIND_COLOR: Record<string, string> = {
  Decision: "#7fb4f0", Attempt: "#f6c6d8", File: "#9fc4f5", Note: "#f4d49b",
  Interface: "#5ad1e6", Person: "#c9a2ff", Repo: "#ffb59e",
};
const colorFor = (kind: string) => KIND_COLOR[kind] ?? "var(--text-mid)";

/**
 * Browse recent knowledge, search it, and follow the selected record's
 * connections and actual recall evidence. List ordering comes from the graph:
 * recency for browsing and hybrid search order for queries.
 */
export default function GraphExplorer({ workspaceId, workspaceName, onClose }: Props) {
  const [view, setViewState] = useState<GraphExplorerView>(getGraphExplorerView);
  const setView = (next: GraphExplorerView) => { setViewState(next); setGraphExplorerView(next); };
  const [scopeToWs, setScopeToWs] = useState<boolean>(workspaceId !== null);
  const [retry, setRetry] = useState(0);
  const [recallFact, setRecallFact] = useState<{ id: string; label: string } | null>(null);
  const [kind, setKind] = useState<Kind | null>(null);
  const [query, setQuery] = useState("");
  const [nodes, setNodes] = useState<GraphKgNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [offline, setOffline] = useState(false);
  const [graph, setGraph] = useState<GraphSubgraph | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [neighbors, setNeighbors] = useState<GraphNeighbor[]>([]);
  const [selected, setSelected] = useState<GraphKgNode | null>(null);
  const neighborRequest = useRef(0);
  const [neighborStatus, setNeighborStatus] = useState<"loading" | "ready" | "error">("ready");
  const scopeId = scopeToWs ? workspaceId : null;
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (view !== "list") return;
    let cancelled = false;
    setLoading(true);
    setNodes([]);
    setOffline(false);
    const timer = setTimeout(() => {
      graphListNodes(
        { workspaceId: scopeId, kind, query: query.trim() || null, limit: 250 },
        getGraphUrl(),
      ).then((list) => {
        if (!cancelled) { setNodes(list); setLoading(false); }
      }).catch(() => {
        if (!cancelled) { setOffline(true); setLoading(false); }
      });
    }, query ? 220 : 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [view, scopeId, kind, query, retry]);

  // Graph view pulls the whole scoped subgraph (nodes + edges) once; search and
  // kind filters then highlight/dim within it rather than refetching.
  useEffect(() => {
    if (view !== "graph") return;
    let cancelled = false;
    setGraph(null);
    setOffline(false);
    graphSubgraph(scopeId, 250, getGraphUrl())
      .then((g) => { if (!cancelled) { setGraph(g); setOffline(false); } })
      .catch(() => { if (!cancelled) setOffline(true); });
    return () => { cancelled = true; };
  }, [view, scopeId, retry]);

  const openNode = useCallback(async (id: string) => {
    const node = (view === "graph" ? graph?.nodes : nodes)?.find((n) => n.id === id)
      ?? neighbors.find((n) => n.node.id === id)?.node;
    if (!node) return;
    const request = ++neighborRequest.current;
    setSelectedId(id);
    setSelected(node);
    setNeighbors([]);
    setNeighborStatus("loading");
    try {
      const result = await graphNodeNeighbors(id, getGraphUrl());
      if (request === neighborRequest.current) { setNeighbors(result); setNeighborStatus("ready"); }
    } catch {
      if (request === neighborRequest.current) setNeighborStatus("error");
    }
  }, [nodes, graph, neighbors, view]);

  const closeNode = useCallback(() => {
    neighborRequest.current += 1;
    setSelectedId(null);
    setSelected(null);
    setNeighbors([]);
  }, []);

  useEffect(() => {
    closeNode();
    setRecallFact(null);
    return () => { neighborRequest.current += 1; };
  }, [scopeId, closeNode]);

  const offlineMessage = <div className="gx-empty" role="status">
    The graph engine is offline.<br />Start it from the sidebar to explore.
    <button className="gx-retry" onClick={() => setRetry((n) => n + 1)}>Try again</button>
  </div>;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal graph-modal" ref={modalRef} role="dialog" aria-modal="true" aria-label="Graph explorer" onClick={(e) => e.stopPropagation()}>
        <ModalCloseButton onClose={onClose} />

        <div className="modal-header gx-head">
          <div className="step">Graph</div>
          <div className="title">Graph Explorer</div>
          <div className="gx-subtitle">The shared memory your agents write as they work.</div>
          <div className="gx-scope-label">Scope: <strong>{scopeId ? workspaceName || "This workspace" : "All workspaces"}</strong>{scopeId && view !== "recall" && " + shared knowledge"}</div>
        </div>

        <div className="gx-controls">
          <div className="gx-view-toggle">
            <button className={`gx-view-opt${view === "list" ? " active" : ""}`} onClick={() => { setRecallFact(null); setView("list"); }} aria-pressed={view === "list"} title="Recent knowledge">
              <ListIcon /> List
            </button>
            <button className={`gx-view-opt${view === "graph" ? " active" : ""}`} onClick={() => { setRecallFact(null); setView("graph"); }} aria-pressed={view === "graph"} title="Force-directed map">
              <MapIcon /> Graph
            </button>
            {/* The read side. List and Graph both show what has been written;
                only this one shows whether any of it came back out. */}
            <button className={`gx-view-opt${view === "recall" ? " active" : ""}`} onClick={() => { setRecallFact(null); setView("recall"); }} aria-pressed={view === "recall"} title="What grounding surfaced to your agents">
              <RecallIcon /> Recall
            </button>
          </div>
          {/* Recall is a log, not a catalog: neither the text filter nor the
              kind chips below have anything to act on there. */}
          <div className="gx-search-wrap" hidden={view === "recall"}>
            <SearchIcon />
            <input
              className="gx-search"
              aria-label="Search shared memory"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={view === "graph" ? "Highlight nodes…" : "Search decisions, attempts, files, notes…"}
              autoComplete="off"
              spellCheck={false}
              autoFocus
            />
          </div>
          {workspaceId && (
            <div className="gx-scope-toggle">
              <button className={`gx-scope-opt${scopeToWs ? " active" : ""}`} onClick={() => setScopeToWs(true)} aria-pressed={scopeToWs} title={workspaceName || "This workspace"}>
                {workspaceName || "This workspace"}
              </button>
              <button className={`gx-scope-opt${!scopeToWs ? " active" : ""}`} onClick={() => setScopeToWs(false)} aria-pressed={!scopeToWs}>
                All workspaces
              </button>
            </div>
          )}
        </div>

        <div className="gx-kinds" hidden={view === "recall"}>
          <button className={`gx-kind-chip${kind === null ? " active" : ""}`} onClick={() => setKind(null)}>
            All
          </button>
          {KINDS.map((k) => (
            <button
              key={k}
              className={`gx-kind-chip${kind === k ? " active" : ""}`}
              style={{ ["--k" as never]: colorFor(k) }}
              onClick={() => setKind(kind === k ? null : k)}
            >
              <span className="gx-kind-dot" /> {k}
            </button>
          ))}
        </div>

        {view === "recall" ? (
          <div className="gx-body gx-body-recall">
            <GraphRecallView workspaceId={scopeId} fact={recallFact} onClearFact={() => setRecallFact(null)} />
          </div>
        ) : (
        <div className={`gx-body${view === "graph" ? " graph" : ""}`}>
          {view === "graph" ? (
            offline ? (
              <div className="gx-canvas-wrap">{offlineMessage}</div>
            ) : !graph ? (
              <div className="gx-canvas-wrap"><div className="gx-empty">Laying out the graph…</div></div>
            ) : graph.nodes.length === 0 ? (
              <div className="gx-canvas-wrap"><div className="gx-empty">Nothing recorded yet.<br />Agents write here as they work.</div></div>
            ) : (
              <Suspense fallback={<div className="gx-canvas-wrap"><div className="gx-empty">Warming up the 3D engine…</div></div>}>
                <GraphCanvas
                  nodes={graph.nodes}
                  edges={graph.edges}
                  selectedId={selectedId}
                  onSelect={openNode}
                  onDeselect={closeNode}
                  colorFor={colorFor}
                  activeKind={kind}
                  query={query}
                />
              </Suspense>
            )
          ) : (
          <div className="gx-catalog" aria-busy={loading}>
            {offline ? (
              offlineMessage
            ) : loading && nodes.length === 0 ? (
              <div className="gx-empty">Loading…</div>
            ) : nodes.length === 0 ? (
              <div className="gx-empty">
                {query ? <>No matches for “{query}”.</> : <>Nothing recorded yet.<br />Agents write here as they work.</>}
              </div>
            ) : (
              <>
                <div className="gx-catalog-label">{query.trim() ? "Search results" : "Recently updated"} · {nodes.length}{nodes.length === 250 ? "+" : ""}</div>
                {nodes.map((n) => (
                  <button
                    key={n.id}
                    className={`gx-row${selectedId === n.id ? " active" : ""}`}
                    onClick={() => openNode(n.id)}
                    aria-pressed={selectedId === n.id}
                  >
                    <span className="gx-row-rail" style={{ background: colorFor(n.kind) }} />
                    <span className="gx-row-main">
                      <span className="gx-row-label">{n.label}</span>
                      <span className="gx-row-meta">
                        {n.kind} · {n.created_by_agent ? `${n.created_by_agent} · ` : ""}{relTime(n.updated_at)}
                      </span>
                    </span>
                  </button>
                ))}
              </>
            )}
          </div>
          )}

          <div className="gx-detail">
            {!selected ? (
              <div className="gx-detail-placeholder">
                <div className="gx-detail-placeholder-mark"><DiamondIcon size={20} /></div>
                {view === "graph" ? "Click a node to read it and walk its connections." : "Select a node to read it and walk its connections."}
              </div>
            ) : (
              <NodeDetail node={selected} neighbors={neighbors} neighborStatus={neighborStatus} onOpen={openNode} workspaceId={scopeId}
                onRecall={() => { setRecallFact({ id: selected.id, label: selected.label }); setView("recall"); }} />
            )}
          </div>
        </div>
        )}
      </div>
    </div>
  );
}

function NodeDetail({ node, neighbors, neighborStatus, onOpen, workspaceId, onRecall }: {
  node: GraphKgNode;
  neighbors: GraphNeighbor[];
  neighborStatus: "loading" | "ready" | "error";
  onOpen: (id: string) => void;
  workspaceId: string | null;
  onRecall: () => void;
}) {
  const groups = useMemo(() => {
    const by = new Map<string, GraphNeighbor[]>();
    for (const nb of neighbors) {
      const key = `${nb.direction}:${nb.edge_type}`;
      (by.get(key) ?? by.set(key, []).get(key)!).push(nb);
    }
    return [...by.entries()];
  }, [neighbors]);

  return (
    <div className="gx-record">
      <div className="gx-record-head">
        <span className="gx-record-kind" style={{ color: colorFor(node.kind), borderColor: colorFor(node.kind) }}>
          {node.kind}
        </span>
        <h2 className="gx-record-label">{node.label}</h2>
      </div>

      <dl className="gx-meta-grid">
        <div className="gx-meta-cell">
          <dt>Author</dt>
          <dd>{node.created_by_agent || "—"}</dd>
        </div>
        <div className="gx-meta-cell">
          <dt>Recorded</dt>
          <dd>{new Date(node.created_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</dd>
        </div>
        {node.workspace_id && (
          <div className="gx-meta-cell">
            <dt>Workspace</dt>
            <dd className="gx-mono">{node.workspace_id.slice(0, 8)}</dd>
          </div>
        )}
      </dl>

      {node.body && (
        <div className="gx-record-section">
          <div className="gx-section-label">Detail</div>
          <div className="gx-record-body">{node.body}</div>
        </div>
      )}

      <NodeRecallEvidence nodeId={node.id} workspaceId={workspaceId} onRecall={onRecall} />

      <div className="gx-record-section">
        <div className="gx-section-label">
          Connections{neighbors.length > 0 && <span className="gx-section-count">{neighbors.length}</span>}
        </div>
        {neighborStatus === "loading" ? <div className="gx-none" role="status">Loading connections…</div>
        : neighborStatus === "error" ? <div className="gx-none">Connections unavailable. The graph engine may be offline.</div>
        : neighbors.length === 0 ? (
          <div className="gx-none">No edges recorded for this node.</div>
        ) : (
          <div className="gx-edges">
            {groups.map(([key, list]) => {
              const [dir, edge] = key.split(":");
              return (
                <div className="gx-edge-row" key={key}>
                  <span className={`gx-edge-tag ${dir === "out" ? "out" : "in"}`}>
                    {dir === "out" ? "→" : "←"} {edge}
                  </span>
                  <div className="gx-edge-nodes">
                    {list.map((nb) => (
                      <button
                        key={nb.node.id + key}
                        className="gx-neighbor"
                        onClick={() => onOpen(nb.node.id)}
                        title={nb.node.body ?? nb.node.label}
                      >
                        <span className="gx-neighbor-dot" style={{ background: colorFor(nb.node.kind) }} />
                        <span className="gx-neighbor-label">{nb.node.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function NodeRecallEvidence({ nodeId, workspaceId, onRecall }: { nodeId: string; workspaceId: string | null; onRecall: () => void }) {
  const [report, setReport] = useState<RecallReport | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let live = true;
    setReport(null);
    setError(false);
    graphRecall(workspaceId, 30, getGraphUrl())
      .then((data) => { if (live) setReport(data); })
      .catch(() => { if (live) setError(true); });
    return () => { live = false; };
  }, [workspaceId]);
  // The backend returns the latest 40 passes irrespective of its stats window.
  const since = Date.now() - 30 * 86400000;
  const matches = report?.passes.filter((pass) => Date.parse(pass.ts) >= since && pass.facts.some((fact) => fact.id === nodeId)) ?? [];
  const latest = matches[0];
  return (
    <div className="gx-record-section gx-recall-evidence">
      <div className="gx-section-label">Recall evidence · last 30 days</div>
      <div className="gx-none">
        {error ? "Recall evidence unavailable. The graph engine may be offline."
          : !report ? "Checking the recent recall log…"
          : latest ? <>Surfaced to {latest.agent_id || "an unnamed agent"} · {relTime(latest.ts)}. Found in {matches.length} of the recent recorded recalls.</>
          : "No matching entry in the recent recall log. Older recalls may be outside this limited log."}
      </div>
      <button className="gx-recall-link" onClick={onRecall}>View recall evidence for this record →</button>
    </div>
  );
}

function SearchIcon() {
  return (
    <svg className="gx-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

function ListIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
    </svg>
  );
}

function RecallIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /><path d="M12 8v4l3 2" />
    </svg>
  );
}

function MapIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="9" r="2.5" /><circle cx="9" cy="18" r="2.5" />
      <path d="M8 7.3 15.6 8.4M8.2 16 16.2 10.6" />
    </svg>
  );
}

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
