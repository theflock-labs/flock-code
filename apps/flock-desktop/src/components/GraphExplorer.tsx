import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { graphListNodes, graphNodeNeighbors, graphSubgraph, graphRecall, type GraphKgNode, type GraphNeighbor, type GraphSubgraph, type RecallReport } from "../lib/tauri";
import { OPEN_GRAPH_SETUP_EVENT, getGraphUrl, getGraphExplorerView, setGraphExplorerView, type GraphExplorerView } from "../lib/graphSettings";
import GraphRecallView from "./GraphRecallView";
import InsightsPanel from "./InsightsPanel";
import { Page, PageEmpty } from "../v2/Page";
import { Menu, useMenu, type MenuEntry } from "../v2/Menu";
import { ChevronDownIcon, FolderIcon, SearchIcon } from "../v2/icons";
import "./GraphExplorer.css";

// The 3D graph pulls in three.js (~1.4MB). Load it only when the graph view is
// actually opened, so it stays off the app's startup path.
const GraphCanvas = lazy(() => import("./GraphCanvas"));

interface Props {
  /** Focused workspace id — the explorer defaults to scoping the graph to it. */
  workspaceId: string | null;
  workspaceName?: string | null;
  onClose: () => void;
  /** Present while the app's sidebar is hidden. */
  onShowSidebar?: () => void;
  /** Open on this view instead of the last one used. */
  initialView?: GraphExplorerView;
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

/** How each edge type reads from the record you are on. */
function edgeLabel(edge: string, dir: string): string {
  const out = dir === "out";
  switch (edge) {
    case "ABOUT":
      return out ? "About" : "Written about it";
    case "RELATES_TO":
      return "Related";
    case "SUPERSEDES":
      return out ? "Replaces" : "Replaced by";
    case "CLAIMS":
      return out ? "Claims" : "Claimed by";
    default: {
      const words = edge.toLowerCase().replaceAll("_", " ");
      return `${words.charAt(0).toUpperCase()}${words.slice(1)}${out ? "" : " (from)"}`;
    }
  }
}

/**
 * The graph, as a page of the main panel: browse recent knowledge and search
 * it, see it as a map, see what grounding put in front of your agents (Recall)
 * and the windowed figures (Insights). List ordering comes from the graph:
 * recency for browsing and hybrid search order for queries.
 */
export default function GraphExplorer({ workspaceId, workspaceName, onClose, onShowSidebar, initialView }: Props) {
  const [view, setViewState] = useState<GraphExplorerView>(() => initialView ?? getGraphExplorerView());
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
  const scopeMenu = useMenu();
  const kindMenu = useMenu();

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

  const offlineMessage = (
    <PageEmpty>
      <span>
        The graph engine isn't answering.
        <br />
        <span className="v2-detail-actions" style={{ justifyContent: "center" }}>
          <button type="button" className="v2-btn" onClick={() => setRetry((n) => n + 1)}>Try again</button>
          <button type="button" className="v2-btn" onClick={() => window.dispatchEvent(new Event(OPEN_GRAPH_SETUP_EVENT))}>Graph setup</button>
        </span>
      </span>
    </PageEmpty>
  );

  const scopeName = workspaceName || "This project";
  const scopeEntries: MenuEntry[] = [
    { label: scopeName, hint: "and shared knowledge", checked: scopeToWs, onSelect: () => setScopeToWs(true) },
    { label: "All projects", checked: !scopeToWs, onSelect: () => setScopeToWs(false) },
  ];
  const kindEntries: MenuEntry[] = [
    { label: "All kinds", checked: kind === null, onSelect: () => setKind(null) },
    ...KINDS.map<MenuEntry>((k) => ({
      label: k,
      icon: <span className="v2-kind-dot" style={{ "--kind": colorFor(k) } as CSSProperties} />,
      checked: kind === k,
      onSelect: () => setKind(k),
    })),
  ];

  const tools = (
    <div className="v2-split-tools">
      <div className="v2-search" role="search">
        <SearchIcon size={14} />
        <input
          type="search"
          aria-label="Search the graph"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={view === "graph" ? "Highlight" : "Search"}
          autoComplete="off"
          spellCheck={false}
          autoFocus
        />
      </div>
      <button type="button" className="v2-chip" aria-haspopup="menu" aria-expanded={kindMenu.open} aria-label={`Kind: ${kind ?? "all"}`} onClick={kindMenu.toggle}>
        {kind && <span className="v2-kind-dot" style={{ "--kind": colorFor(kind) } as CSSProperties} />}
        <span>{kind ?? "All kinds"}</span>
        <ChevronDownIcon size={13} />
      </button>
    </div>
  );

  const detail = (
    <section className="v2-split-detail" aria-label="Record">
      {!selected ? (
        <PageEmpty>{view === "graph" ? "Click a node to read it." : "Pick something to read it and follow its connections."}</PageEmpty>
      ) : (
        <NodeDetail node={selected} neighbors={neighbors} neighborStatus={neighborStatus} onOpen={openNode} workspaceId={scopeId}
          onRecall={() => { setRecallFact({ id: selected.id, label: selected.label }); setView("recall"); }} />
      )}
    </section>
  );

  return (
    <Page<GraphExplorerView>
      title="Graph"
      meta={
        workspaceId ? (
          <button type="button" className="v2-chip" aria-haspopup="menu" aria-expanded={scopeMenu.open} aria-label={`Scope: ${scopeToWs ? scopeName : "all projects"}`} onClick={scopeMenu.toggle}>
            <FolderIcon size={14} />
            <span>{scopeToWs ? scopeName : "All projects"}</span>
            <ChevronDownIcon size={13} />
          </button>
        ) : undefined
      }
      tabs={[
        { id: "list", label: "Knowledge", title: "What your agents wrote down, newest first" },
        { id: "graph", label: "Map", title: "Everything and how it connects" },
        { id: "recall", label: "Recall", title: "What grounding put in front of your agents" },
        { id: "insights", label: "Insights", title: "Reads, writes and coverage over time" },
      ]}
      tab={view}
      onTab={(v) => { setRecallFact(null); setView(v); }}
      onClose={onClose}
      onShowSidebar={onShowSidebar}
      className="v2-graph"
    >
      {view === "insights" ? (
        <div className="v2-page-scroll">
          <InsightsPanel inline onClose={onClose} />
        </div>
      ) : view === "recall" ? (
        <div className="v2-page-scroll">
          <GraphRecallView workspaceId={scopeId} fact={recallFact} onClearFact={() => setRecallFact(null)} />
        </div>
      ) : view === "graph" ? (
        <div className="v2-split lead">
          <div className="v2-split-list" style={{ borderRight: 0 }}>
            {tools}
            <div className="gx-canvas-host">
              {offline ? (
                offlineMessage
              ) : !graph ? (
                <PageEmpty>Laying out the graph…</PageEmpty>
              ) : graph.nodes.length === 0 ? (
                <PageEmpty>Nothing recorded yet. Agents write here as they work.</PageEmpty>
              ) : (
                <Suspense fallback={<PageEmpty>Drawing the map…</PageEmpty>}>
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
              )}
            </div>
          </div>
          {detail}
        </div>
      ) : (
        <div className="v2-split">
          <aside className="v2-split-list" aria-label="Knowledge" aria-busy={loading}>
            {tools}
            {offline ? (
              offlineMessage
            ) : loading && nodes.length === 0 ? (
              <PageEmpty>Loading…</PageEmpty>
            ) : nodes.length === 0 ? (
              <PageEmpty>{query ? <>Nothing matches “{query}”.</> : <>Nothing recorded yet. Agents write here as they work.</>}</PageEmpty>
            ) : (
              <ul className="v2-list">
                <li className="v2-list-label">
                  {query.trim() ? "Matches" : "Recently updated"} · {nodes.length}{nodes.length === 250 ? "+" : ""}
                </li>
                {nodes.map((n) => (
                  <li key={n.id}>
                    <button type="button" className="v2-list-row" aria-current={selectedId === n.id || undefined} onClick={() => openNode(n.id)}>
                      <span className="v2-kind-dot" style={{ "--kind": colorFor(n.kind) } as CSSProperties} />
                      <span>
                        <span className="v2-list-title">{n.label}</span>
                        <span className="v2-list-meta">
                          {n.kind}{n.created_by_agent ? ` · ${n.created_by_agent}` : ""} · {relTime(n.updated_at)}
                        </span>
                      </span>
                      <span />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>
          {detail}
        </div>
      )}
      {scopeMenu.anchor && <Menu anchor={scopeMenu.anchor} entries={scopeEntries} onClose={scopeMenu.close} label="Scope" />}
      {kindMenu.anchor && <Menu anchor={kindMenu.anchor} entries={kindEntries} onClose={kindMenu.close} label="Kind" />}
    </Page>
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
    <div className="v2-detail">
      <div className="v2-detail-kicker">
        <span className="v2-kind-dot" style={{ "--kind": colorFor(node.kind) } as CSSProperties} />
        {node.kind}
        {node.outcome && <span className="v2-faint">· {node.outcome}</span>}
      </div>
      <h2>{node.label}</h2>
      <p className="v2-detail-sub">
        {node.created_by_agent || "An agent"} · {new Date(node.created_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
        {node.shipped_in && <> · shipped in {node.shipped_in}</>}
      </p>
      {node.body && <p className="v2-detail-body">{node.body}</p>}

      <section className="v2-detail-section">
        <h3>
          Connections {neighbors.length > 0 && <span className="v2-faint">{neighbors.length}</span>}
        </h3>
        {neighborStatus === "loading" ? (
          <p className="v2-note" role="status">Loading…</p>
        ) : neighborStatus === "error" ? (
          <p className="v2-note">Connections are unavailable; the graph engine may be offline.</p>
        ) : neighbors.length === 0 ? (
          <p className="v2-note">Nothing links to this yet.</p>
        ) : (
          groups.map(([key, list]) => {
            const [dir, edge] = key.split(":");
            return (
              <div key={key} className="gx-group">
                <div className="v2-list-label" style={{ paddingLeft: 0 }}>{edgeLabel(edge, dir)}</div>
                {list.map((nb) => (
                  <button
                    key={nb.node.id + key}
                    type="button"
                    className="v2-list-row"
                    onClick={() => onOpen(nb.node.id)}
                    title={nb.node.body ?? nb.node.label}
                  >
                    <span className="v2-kind-dot" style={{ "--kind": colorFor(nb.node.kind) } as CSSProperties} />
                    <span className="v2-list-title">{nb.node.label}</span>
                    <span />
                  </button>
                ))}
              </div>
            );
          })
        )}
      </section>

      <NodeRecallEvidence nodeId={node.id} workspaceId={workspaceId} onRecall={onRecall} />
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
    <section className="v2-detail-section">
      <h3>Recall <span className="v2-faint">· last 30 days</span></h3>
      <p className="v2-note" style={{ marginTop: 0 }}>
        {error ? "Recall is unavailable; the graph engine may be offline."
          : !report ? "Checking…"
          : latest ? <>Shown to {latest.agent_id || "an agent"} {relTime(latest.ts)}, in {matches.length} of the recent grounding passes.</>
          : "Not shown to an agent in the recent passes."}
      </p>
      <p className="v2-note">
        <button type="button" className="v2-link" onClick={onRecall}>See every time it was recalled</button>
      </p>
    </section>
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
