import { useEffect, useRef, useState } from "react";
import { onActivateKey } from "../lib/a11y";
import { grokUsage, type GrokUsage } from "../lib/tauri";
import { formatCompact as compact } from "../lib/format";
import { RefreshIcon } from "./statusIcons";

/** Status-bar chip for grok. grok has no remaining-quota endpoint, and its
 *  build-agent `inputTokens` can be a tens-of-millions running total, so this
 *  is spend-to-date for today — same shape as the opencode chip — not a
 *  percentage of a window. Click for the breakdown. Hidden until grok has
 *  written a session. */
export default function GrokUsageChip() {
  const [stats, setStats] = useState<GrokUsage | null>(null);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    const pull = () =>
      grokUsage(false)
        .then((s) => alive && setStats(s))
        .catch(() => alive && setStats(null));
    pull();
    const t = setInterval(pull, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!stats?.available) return null;

  const primary = stats.today_tokens > 0
    ? compact(stats.today_tokens)
    : stats.context_percent != null
      ? `${Math.round(stats.context_percent)}%`
      : "—";
  const tip = stats.today_tokens > 0
    ? `grok — ${compact(stats.today_tokens)} tokens today`
    : `grok — conversation ${Math.round(stats.context_percent ?? 0)}% of window`;

  return (
    <div className="oc-mount" ref={ref}>
      <div
        className="oc-chip clickable"
        title={tip}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onActivateKey(() => setOpen((o) => !o))}
      >
        <span className="oc-label">grok</span>
        <span className="oc-value">{primary}</span>
      </div>

      {open && (
        <div className="usage-popover" role="dialog">
          <div className="settings-section-header usage-header">
            <span>grok usage</span>
            {stats.model && <span className="usage-plan">{stats.model}</span>}
          </div>
          <div className="usage-group">
            <div className="usage-group-title">Today</div>
            <div className="oc-stat">
              <span className="oc-stat-label">Tokens</span>
              <span className="oc-stat-value">{compact(stats.today_tokens)}</span>
            </div>
          </div>
          {stats.context_percent != null && stats.context_used != null && stats.context_window != null && (
            <div className="usage-group">
              <div className="usage-group-title">Conversation context</div>
              <div className="oc-stat">
                <span className="oc-stat-label">Fullest session</span>
                <span className="oc-stat-value">
                  {compact(stats.context_used)} / {compact(stats.context_window)}
                  {" · "}
                  {Math.round(stats.context_percent)}%
                </span>
              </div>
            </div>
          )}
          <div className="usage-footer">
            <span>Tokens today from local sessions. grok has no plan quota flock can read.</span>
          </div>
        </div>
      )}
    </div>
  );
}

/** Settings → Usage counterpart of the status-bar chip. */
export function GrokUsageSection() {
  const [stats, setStats] = useState<GrokUsage | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      setStats(await grokUsage(true));
    } catch {
      setStats(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <div className="settings-section">
      <div className="settings-section-header usage-header">
        <span>grok usage</span>
        {stats?.model && <span className="usage-plan">{stats.model}</span>}
        <div className="spacer" />
        <button className="usage-refresh" onClick={() => void load()} disabled={loading} title="Refresh">
          {loading ? "…" : <RefreshIcon size={12} />}
        </button>
      </div>
      {!stats?.available ? (
        <div className="settings-hint">{loading ? "Loading…" : "No grok sessions on this machine yet."}</div>
      ) : (
        <>
          <div className="usage-group">
            <div className="usage-group-title">Today</div>
            <div className="oc-stat">
              <span className="oc-stat-label">Tokens</span>
              <span className="oc-stat-value">{compact(stats.today_tokens)}</span>
            </div>
          </div>
          {stats.context_percent != null && stats.context_used != null && stats.context_window != null && (
            <div className="usage-group">
              <div className="usage-group-title">Conversation context</div>
              <div className="oc-stat">
                <span className="oc-stat-label">Fullest session</span>
                <span className="oc-stat-value">
                  {compact(stats.context_used)} / {compact(stats.context_window)}
                  {" · "}
                  {Math.round(stats.context_percent)}%
                </span>
              </div>
            </div>
          )}
          <div className="settings-hint">
            Tokens today from local sessions. grok has no plan quota flock can read — a
            percentage here is conversation context, not a subscription limit.
          </div>
        </>
      )}
    </div>
  );
}
