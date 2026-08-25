import { useEffect, useState } from "react";
import { graphOverview, type GraphOverview } from "../lib/tauri";
import { getGraphEnabled, onGraphEnabledChange, getGraphUrl, isTeamGraph, OPEN_GRAPH_SETUP_EVENT, OPEN_GRAPH_EXPLORER_EVENT } from "../lib/graphSettings";
import CollapsibleSection from "./CollapsibleSection";
import IconButton from "./IconButton";
import InsightsPanel from "./InsightsPanel";
import { PopOutIcon } from "./paneIcons";
import { isWindowActive, onWindowActiveChange } from "../lib/windowActive";
import { BlockedIcon } from "./statusIcons";

interface Props {
  /** Focused workspace id — stats are scoped to it. */
  workspaceId: string | null;
}

/** Sidebar pulse for the flock Graph: what the agents collectively know
 * (decisions / attempts / notes) and the most recent thing any of them
 * recorded. Hidden entirely unless the graph is opted in. */
export default function GraphSidebarCard({ workspaceId }: Props) {
  const [enabled, setEnabled] = useState(getGraphEnabled());
  const [overview, setOverview] = useState<GraphOverview | null>(null);
  const [offline, setOffline] = useState(false);
  const [showInsights, setShowInsights] = useState(false);

  useEffect(() => onGraphEnabledChange(setEnabled), []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const poll = () => {
      graphOverview(workspaceId ?? undefined, getGraphUrl())
        .then((o) => { if (!cancelled) { setOverview(o); setOffline(false); } })
        .catch(() => { if (!cancelled) setOffline(true); });
    };
    poll();
    // Pause the overview poll (a local or team-hosted graph query) while the
    // app is hidden; refresh once on return so the pulse is current.
    const interval = setInterval(() => { if (isWindowActive()) poll(); }, 10000);
    const unsub = onWindowActiveChange((active) => { if (active) poll(); });
    return () => { cancelled = true; clearInterval(interval); unsub(); };
  }, [enabled, workspaceId]);

  if (!enabled) return null;

  const stats = overview?.stats;

  return (
    <>
    <CollapsibleSection
      id="graph"
      title={
        <>
          Graph
          <span
            className={`graph-conn-dot${offline ? " offline" : ""}`}
            title={offline ? "Graph — engine offline" : "Graph"}
            aria-label={offline ? "Graph — engine offline" : "Graph"}
          />
          {stats && stats.total > 0 && <span className="count"> {stats.total}</span>}
        </>
      }
      actions={
        <>
          {/* Graph Insights — whether the graph is being read back. Not "Team
              Insights": the panel reads whichever graph is configured, which
              for most users is the local one, and a solo user was being shown
              a button naming a team they do not have. A down engine just shows
              an error inside the panel. */}
          <IconButton
            className="add-btn ghost"
            icon={
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <rect x="3" y="11" width="4" height="10" rx="1" />
                <rect x="10" y="6" width="4" height="15" rx="1" />
                <rect x="17" y="14" width="4" height="7" rx="1" />
              </svg>
            }
            label="Graph Insights"
            onClick={() => setShowInsights(true)}
          />
          {!offline && stats ? (
            // Pop-out, not an eye: this navigates to the full explorer, it
            // doesn't toggle visibility or "watch" the agents. Same glyph,
            // size, and box as the PR header's Manage PRs button so the two
            // section pop-outs read as one control in two places.
            <IconButton
              className="add-btn ghost"
              icon={<PopOutIcon size={13} />}
              label="Open the Graph Explorer"
              onClick={() => window.dispatchEvent(new Event(OPEN_GRAPH_EXPLORER_EVENT))}
            />
          ) : null}
        </>
      }
    >
      {/* One-line descriptor so the item explains itself: what it is (shared
          memory the agents read + write) and its scope (just this machine, or
          synced with the whole team on a hosted graph). */}
      <div className="graph-subtitle">
        Shared agent memory
        <span className={`graph-scope${isTeamGraph() ? " team" : ""}`}>
          {isTeamGraph() ? " · your team" : " · this machine"}
        </span>
      </div>

      {offline ? (
        <div className="empty-state">
          <BlockedIcon size={12} /> engine offline —{" "}
          <span
            style={{ color: "var(--mint)", cursor: "pointer" }}
            onClick={() => window.dispatchEvent(new Event(OPEN_GRAPH_SETUP_EVENT))}
          >
            start it →
          </span>
        </div>
      ) : !stats ? (
        <div className="empty-state">connecting…</div>
      ) : (
        <>
          {/* Once there's memory, show a light one-line stat strip + the most
              recent entry. When it's all zero we skip this entirely and fall
              through to a single honest empty state below — no row of zeros. */}
          {stats.total > 0 && (
            <>
              <div className="graph-stats-line">
                <span title="Decisions recorded"><b>{stats.decisions}</b> decisions</span>
                <span title="Attempts logged, including failures other agents will skip"><b>{stats.attempts}</b> attempts</span>
                <span title="Files with recorded knowledge"><b>{stats.files}</b> files</span>
                <span title="Notes and interface contracts remembered"><b>{stats.notes}</b> notes</span>
                <span title="Distinct authors of this knowledge"><b>{stats.contributors}</b> authors</span>
              </div>
              {stats.latest && (
                <div className="graph-latest" title={stats.latest.body ?? stats.latest.label}>
                  <span className="graph-latest-kind">{stats.latest.kind}</span>
                  <span className="graph-latest-label">{stats.latest.label}</span>
                  <span className="graph-latest-meta">
                    {stats.latest.created_by_agent ?? "unknown"} · {relTime(stats.latest.updated_at)}
                  </span>
                </div>
              )}
            </>
          )}

          {stats.total === 0 && (
            <div className="graph-empty">
              <span className="graph-empty-icon"><span className="status-mark" /></span>
              Nothing recorded yet. Agents write decisions, attempts, and notes here as they work.
            </div>
          )}
        </>
      )}
    </CollapsibleSection>
    {showInsights && <InsightsPanel onClose={() => setShowInsights(false)} />}
    </>
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
