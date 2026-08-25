import { useEffect, useRef, useState, type ReactNode } from "react";
import ModalCloseButton from "./ModalCloseButton";
import { Avatar } from "./Avatar";
import { useFocusTrap } from "../lib/useFocusTrap";
import { getUsageSeries, getUserStats, type UsageDailyPoint, type UserStats } from "../lib/flockId";
import { graphOverview, type GraphOverview } from "../lib/tauri";
import { getGraphEnabled, getGraphUrl } from "../lib/graphSettings";
import UsageChart from "./UsageChart";
import AchievementWall from "./AchievementWall";
import { resolveAll, type AchievementStats } from "../lib/achievements";
import { formatCompact, formatCount, formatUsd } from "../lib/format";

// Shared body of the usage-stats modal: MyInfoModal (own profile) and
// FriendStatsModal (a friend, RLS-scoped) render the same hero + usage band +
// chart + activity tiles and only differ in the presence line, error copy,
// the opt-in graph section, and the footer.

interface Props {
  profileId: string;
  handle: string;
  avatarUrl: string | null;
  ariaLabel: string;
  /** Class suffix for the presence line under the handle (e.g. "online"). */
  presenceClass: string;
  presenceText: ReactNode;
  errorText: string;
  /** Include the opt-in knowledge-graph section. Own profile only — the
   * local graph holds no data about a friend. */
  showGraph?: boolean;
  footer?: ReactNode;
  onClose: () => void;
}

const SOCIAL_TILES: { key: keyof Omit<UserStats, "member_since">; label: string; hint: string }[] = [
  { key: "prompts_sent", label: "Prompts", hint: "sent to agents" },
  { key: "agents_launched", label: "Agents", hint: "launched" },
  { key: "workspaces_created", label: "Workspaces", hint: "created" },
];

type GraphStats = GraphOverview["stats"];
const GRAPH_TILES: { key: keyof GraphStats; label: string; hint: string }[] = [
  { key: "decisions", label: "Decisions", hint: "recorded" },
  { key: "attempts", label: "Attempts", hint: "logged" },
  { key: "files", label: "Files", hint: "tracked" },
  { key: "notes", label: "Knowledge", hint: "notes saved" },
];

function formatMemberSince(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

export default function StatsModal({
  profileId, handle, avatarUrl, ariaLabel, presenceClass, presenceText, errorText, showGraph, footer, onClose,
}: Props) {
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef);

  const [stats, setStats] = useState<UserStats | null>(null);
  const [statsError, setStatsError] = useState(false);
  const [graph, setGraph] = useState<GraphStats | null>(null);
  const [series, setSeries] = useState<UsageDailyPoint[] | null>(null);
  const [seriesLoading, setSeriesLoading] = useState(true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let alive = true;
    setStats(null);
    setStatsError(false);
    setSeries(null);
    setSeriesLoading(true);
    getUserStats(profileId)
      .then((s) => { if (alive) setStats(s); })
      .catch(() => { if (alive) setStatsError(true); });
    // Daily usage history for the chart. Best-effort: an empty/failed series
    // just leaves the chart in its "building up" state, never blocks the modal.
    getUsageSeries(profileId, 30)
      .then((rows) => { if (alive) setSeries(rows); })
      .catch(() => { if (alive) setSeries([]); })
      .finally(() => { if (alive) setSeriesLoading(false); });
    // Knowledge-graph metrics are opt-in and only present when the local (or
    // team) graph is enabled and reachable. Best-effort: a disabled or offline
    // graph just hides the section.
    if (showGraph && getGraphEnabled()) {
      graphOverview(undefined, getGraphUrl())
        .then((o) => { if (alive) setGraph(o.stats); })
        .catch(() => { /* graph down — omit the section */ });
    }
    return () => { alive = false; };
  }, [profileId, showGraph]);

  const memberSince = stats ? formatMemberSince(stats.member_since) : null;

  // Resolve the trophy wall from data already loaded: shared seals from the
  // social stats (work for you and any friend), graph seals folded in only when
  // the local graph is present (your own wall). `graph` gates includeSelf.
  const achStats: AchievementStats | null = stats
    ? {
        prompts: stats.prompts_sent,
        agents: stats.agents_launched,
        workspaces: stats.workspaces_created,
        tokens: stats.tokens_total,
        memberSince: stats.member_since,
        decisions: graph?.decisions,
        notes: graph?.notes,
        files: graph?.files,
      }
    : null;
  const achievements = achStats ? resolveAll(achStats, !!graph) : [];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal stats-modal" ref={modalRef} role="dialog" aria-modal="true" aria-label={ariaLabel} onClick={(e) => e.stopPropagation()}>
        <ModalCloseButton onClose={onClose} />

        <div className="stats-hero">
          <Avatar
            url={avatarUrl}
            seed={handle}
            imgClassName="stats-avatar"
            fallbackClassName="stats-avatar stats-avatar-placeholder"
          />
          <div className="stats-identity">
            <div className="stats-handle"><span className="stats-at">@</span>{handle}</div>
            <div className={`stats-presence ${presenceClass}`}>
              <span className="stats-presence-dot" />{presenceText}
              {memberSince && <span className="stats-since-inline">since {memberSince}</span>}
            </div>
          </div>
        </div>

        <div className="stats-body">
          {statsError ? (
            <div className="stats-empty">{errorText}</div>
          ) : (
            <>
              {stats && stats.tokens_total > 0 && (
                <div className="stats-usage-band">
                  <div className="stats-usage-cell">
                    <div className="stats-usage-number">{formatCompact(stats.tokens_total)}</div>
                    <div className="stats-usage-label">Tokens</div>
                    <div className="stats-usage-sub">all-time across agents</div>
                  </div>
                  <div className="stats-usage-cell">
                    <div className="stats-usage-number">{formatUsd(stats.cost_usd)}</div>
                    <div className="stats-usage-label">Spend</div>
                    <div className="stats-usage-sub">estimated</div>
                  </div>
                </div>
              )}

              <UsageChart series={series} loading={seriesLoading} />

              <div className="stats-group">
                <div className="stats-group-head">Activity</div>
                <div className="stats-cells stats-cells-3">
                  {SOCIAL_TILES.map((t) => (
                    <div className="stats-cell" key={t.key} title={`${t.label} ${t.hint}`}>
                      <div className="stats-cell-number">{stats ? formatCount(stats[t.key]) : "—"}</div>
                      <div className="stats-cell-label">{t.label}</div>
                    </div>
                  ))}
                </div>
              </div>

              {graph && (
                <div className="stats-group">
                  <div className="stats-group-head">Knowledge graph</div>
                  <div className="stats-cells stats-cells-4">
                    {GRAPH_TILES.map((t) => (
                      <div className="stats-cell" key={t.key} title={`${t.label} ${t.hint}`}>
                        <div className="stats-cell-number">{formatCount(graph[t.key] as number)}</div>
                        <div className="stats-cell-label">{t.label}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {achievements.length > 0 && <AchievementWall items={achievements} />}
            </>
          )}

          {footer}
        </div>
      </div>
    </div>
  );
}
