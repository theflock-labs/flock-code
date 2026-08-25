import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { graphListNodes, graphNodeNeighbors, graphSubgraph, type GraphKgNode, type GraphNeighbor, type GraphSubgraph } from "../lib/tauri";
import { getGraphUrl } from "../lib/graphSettings";
import ModalCloseButton from "./ModalCloseButton";
import GraphRecallView from "./GraphRecallView";
import { useFocusTrap } from "../lib/useFocusTrap";
import { DiamondIcon } from "./statusIcons";

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
 * Phase 1 Graph Explorer: a structured browser over the flock knowledge
 * graph, presented as a large modal in the app's own design language. A
 * catalog of nodes (grouped by kind) on the left; a record-style detail pane
 * on the right that shows the selected node's body and its typed connections
 * as clickable chips — so you can walk the graph edge by edge. Phase 2 layers
 * a hand-rolled force-directed view over the same data.
 */
export default function GraphExplorer({ workspaceId, workspaceName, onClose }: Props) {
  const [view, setView] = useState<"list" | "graph" | "recall">("graph");
  // Default to the full graph (every workspace) rather than scoping to the
  // focused one — the explorer opens on the whole universe; the toggle narrows.
  const [scopeToWs, setScopeToWs] = useState<boolean>(false);
  const [kind, setKind] = useState<Kind | null>(null);
  const [query, setQuery] = useState("");
  const [nodes, setNodes] = useState<GraphKgNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [offline, setOffline] = useState(false);
  const [graph, setGraph] = useState<GraphSubgraph | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [neighbors, setNeighbors] = useState<GraphNeighbor[]>([]);
  const selected = useMemo(
    () => nodes.find((n) => n.id === selectedId) ?? graph?.nodes.find((n) => n.id === selectedId) ?? null,
    [nodes, graph, selectedId],
  );
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await graphListNodes(
        { workspaceId: scopeToWs ? workspaceId : null, kind, query: query.trim() || null, limit: 250 },
        getGraphUrl(),
      );
      setNodes(list);
      setOffline(false);
    } catch {
      setOffline(true);
      setNodes([]);
    } finally {
      setLoading(false);
    }
  }, [scopeToWs, workspaceId, kind, query]);

  useEffect(() => {
    const t = setTimeout(load, query ? 220 : 0);
    return () => clearTimeout(t);
  }, [load, query]);

  // Graph view pulls the whole scoped subgraph (nodes + edges) once; search and
  // kind filters then highlight/dim within it rather than refetching.
  useEffect(() => {
    if (view !== "graph") return;
    let cancelled = false;
    graphSubgraph(scopeToWs ? workspaceId : null, 250, getGraphUrl())
      .then((g) => { if (!cancelled) { setGraph(g); setOffline(false); } })
      .catch(() => { if (!cancelled) setOffline(true); });
    return () => { cancelled = true; };
  }, [view, scopeToWs, workspaceId]);

  const openNode = useCallback(async (id: string) => {
    setSelectedId(id);
    setNeighbors([]);
    try {
      setNeighbors(await graphNodeNeighbors(id, getGraphUrl()));
    } catch { /* engine may be down; the node record still renders */ }
  }, []);

  const closeNode = useCallback(() => {
    setSelectedId(null);
    setNeighbors([]);
  }, []);

  // Group the catalog by kind (preserving KINDS order) for a structured read.
  const groups = useMemo(() => {
    const by = new Map<string, GraphKgNode[]>();
    for (const n of nodes) (by.get(n.kind) ?? by.set(n.kind, []).get(n.kind)!).push(n);
    return KINDS.filter((k) => by.has(k)).map((k) => [k, by.get(k)!] as const);
  }, [nodes]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal graph-modal" ref={modalRef} role="dialog" aria-modal="true" aria-label="Graph explorer" onClick={(e) => e.stopPropagation()}>
        <ModalCloseButton onClose={onClose} />

        <div className="modal-header gx-head">
          <div className="step">Graph</div>
          <div className="title">Graph Explorer</div>
          <div className="gx-subtitle">The shared memory your agents write as they work.</div>
        </div>

        <div className="gx-controls">
          <div className="gx-view-toggle">
            <button className={`gx-view-opt${view === "list" ? " active" : ""}`} onClick={() => setView("list")} title="Catalog">
              <ListIcon /> List
            </button>
            <button className={`gx-view-opt${view === "graph" ? " active" : ""}`} onClick={() => setView("graph")} title="Force-directed map">
              <MapIcon /> Graph
            </button>
            {/* The read side. List and Graph both show what has been written;
                only this one shows whether any of it came back out. */}
            <button className={`gx-view-opt${view === "recall" ? " active" : ""}`} onClick={() => setView("recall")} title="What grounding surfaced to your agents">
              <RecallIcon /> Recall
            </button>
          </div>
          {/* Recall is a log, not a catalog: neither the text filter nor the
              kind chips below have anything to act on there. */}
          <div className="gx-search-wrap" hidden={view === "recall"}>
            <SearchIcon />
            <input
              className="gx-search"
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
              <button className={`gx-scope-opt${scopeToWs ? " active" : ""}`} onClick={() => setScopeToWs(true)}>
                {workspaceName || "This workspace"}
              </button>
              <button className={`gx-scope-opt${!scopeToWs ? " active" : ""}`} onClick={() => setScopeToWs(false)}>
                Whole graph
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
          <div className="gx-body">
            <GraphRecallView workspaceId={scopeToWs ? workspaceId : null} />
          </div>
        ) : (
        <div className={`gx-body${view === "graph" ? " graph" : ""}`}>
          {view === "graph" ? (
            offline ? (
              <div className="gx-canvas-wrap"><div className="gx-empty">The graph engine is offline.<br />Start it from the sidebar to explore.</div></div>
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
          <div className="gx-catalog">
            {offline ? (
              <div className="gx-empty">The graph engine is offline.<br />Start it from the sidebar to explore.</div>
            ) : loading && nodes.length === 0 ? (
              <div className="gx-empty">Loading…</div>
            ) : nodes.length === 0 ? (
              <div className="gx-empty">
                {query ? <>No matches for “{query}”.</> : <>Nothing recorded yet.<br />Agents write here as they work.</>}
              </div>
            ) : (
              groups.map(([k, list]) => (
                <div className="gx-group" key={k}>
                  <div className="gx-group-head">
                    <span className="gx-group-dot" style={{ background: colorFor(k) }} />
                    <span className="gx-group-name">{k}</span>
                    <span className="gx-group-count">{list.length}</span>
                  </div>
                  {list.map((n) => (
                    <button
                      key={n.id}
                      className={`gx-row${selectedId === n.id ? " active" : ""}`}
                      onClick={() => openNode(n.id)}
                    >
                      <span className="gx-row-rail" style={{ background: colorFor(n.kind) }} />
                      <span className="gx-row-main">
                        <span className="gx-row-label">{n.label}</span>
                        <span className="gx-row-meta">
                          {n.created_by_agent ? `${n.created_by_agent} · ` : ""}{relTime(n.created_at)}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              ))
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
              <NodeDetail node={selected} neighbors={neighbors} onOpen={openNode} />
            )}
          </div>
        </div>
        )}
      </div>
    </div>
  );
}

function NodeDetail({ node, neighbors, onOpen }: {
  node: GraphKgNode;
  neighbors: GraphNeighbor[];
  onOpen: (id: string) => void;
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

      <div className="gx-record-section">
        <div className="gx-section-label">
          Connections{neighbors.length > 0 && <span className="gx-section-count">{neighbors.length}</span>}
        </div>
        {neighbors.length === 0 ? (
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
