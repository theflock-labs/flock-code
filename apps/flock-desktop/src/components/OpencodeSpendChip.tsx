import { useEffect, useRef, useState } from "react";
import { onActivateKey } from "../lib/a11y";
import { opencodeStats, type OpencodeStats } from "../lib/tauri";
import { formatCompact as compact, formatUsdExact as money } from "../lib/format";

/** Status-bar chip for opencode. opencode has no remaining-limit endpoint (it's
 * a pass-through to whatever provider you configure), so unlike the Claude/Codex
 * bars this shows *spend-to-date* read from opencode's local SQLite DB: total
 * cost (when the provider reports it) or model tokens across all sessions.
 * Clicking opens a small breakdown. Hides entirely when opencode isn't set up or
 * has no sessions yet. */
export default function OpencodeSpendChip() {
  const [stats, setStats] = useState<OpencodeStats | null>(null);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    const pull = () =>
      opencodeStats()
        .then((s) => alive && setStats(s))
        .catch(() => alive && setStats(null));
    pull();
    // Local DB read is cheap; refresh often enough to feel live as you work.
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

  if (!stats?.available || stats.sessions === 0) return null;

  const modelTokens = stats.tokens_input + stats.tokens_output + stats.tokens_reasoning;
  // Lead with cost when the provider reports it; fall back to tokens (free/local
  // models report $0 but real token counts).
  const showCost = stats.cost > 0.005;
  const primary = showCost ? money(stats.cost) : compact(modelTokens);
  const tip = `opencode — ${stats.sessions} session${stats.sessions === 1 ? "" : "s"}, ${compact(
    modelTokens,
  )} tokens${showCost ? "" : ` · $${stats.cost.toFixed(2)}`} (spend to date, not a limit)`;

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
        <span className="oc-label">opencode</span>
        <span className="oc-value">{primary}</span>
      </div>

      {open && (
        <div className="usage-popover" role="dialog">
          <div className="settings-section-header usage-header">
            <span>opencode usage</span>
          </div>
          <div className="usage-group">
            <div className="usage-group-title">Cumulative — all sessions</div>
            <Row label="Sessions" value={String(stats.sessions)} />
            <Row label="Cost" value={money(stats.cost)} />
            <Row label="Input tokens" value={compact(stats.tokens_input)} />
            <Row label="Output tokens" value={compact(stats.tokens_output)} />
            {stats.tokens_reasoning > 0 && (
              <Row label="Reasoning tokens" value={compact(stats.tokens_reasoning)} />
            )}
            {stats.tokens_cache_read > 0 && (
              <Row label="Cache reads" value={compact(stats.tokens_cache_read)} />
            )}
          </div>
          <div className="usage-footer">
            <span>Spend to date — opencode has no plan limit.</span>
          </div>
        </div>
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

