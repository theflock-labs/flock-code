import { useCallback, useEffect, useState } from "react";
import { opencodeStats, type OpencodeStats } from "../lib/tauri";
import { formatCompact as compact, formatUsdExact as money } from "../lib/format";
import { RefreshIcon } from "./statusIcons";

/** opencode's spend-to-date as a Settings section. opencode has no plan limit
 * (it's a provider pass-through), so this shows cumulative cost + tokens read
 * from its local DB rather than a usage bar. */
export default function OpencodeUsageSection() {
  const [stats, setStats] = useState<OpencodeStats | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setStats(await opencodeStats());
    } catch {
      setStats(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const modelTokens = stats ? stats.tokens_input + stats.tokens_output + stats.tokens_reasoning : 0;

  return (
    <div className="settings-section">
      <div className="settings-section-header usage-header">
        <span>opencode usage</span>
        <div className="spacer" />
        <button className="usage-refresh" onClick={load} disabled={loading} title="Refresh">
          {loading ? "…" : <RefreshIcon size={12} />}
        </button>
      </div>

      {!stats?.available ? (
        <div className="settings-hint">
          {loading ? "Loading…" : "opencode isn't set up, or has no sessions yet."}
        </div>
      ) : (
        <>
          <div className="settings-hint" style={{ margin: 0 }}>
            opencode has no plan limit — it's a pass-through to whatever provider you configure. This is
            spend to date across all sessions.
          </div>
          <div className="usage-group">
            <Row label="Sessions" value={String(stats.sessions)} />
            <Row label="Cost" value={money(stats.cost)} />
            <Row label="Input tokens" value={compact(stats.tokens_input)} />
            <Row label="Output tokens" value={compact(stats.tokens_output)} />
            {stats.tokens_reasoning > 0 && <Row label="Reasoning tokens" value={compact(stats.tokens_reasoning)} />}
            {stats.tokens_cache_read > 0 && <Row label="Cache reads" value={compact(stats.tokens_cache_read)} />}
            {stats.tokens_cache_write > 0 && <Row label="Cache writes" value={compact(stats.tokens_cache_write)} />}
            <Row label="Total model tokens" value={compact(modelTokens)} />
          </div>
        </>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="oc-stat">
      <span className="oc-stat-label">{label}</span>
      <span className="oc-stat-value">{value}</span>
    </div>
  );
}

