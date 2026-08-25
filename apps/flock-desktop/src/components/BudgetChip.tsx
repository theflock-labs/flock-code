import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { onActivateKey } from "../lib/a11y";
import { formatCompact as compact, formatUsdExact as money } from "../lib/format";
import { getDailyBudget, hasCeiling, onDailyBudgetChange, readBudget, type BudgetLevel } from "../lib/budgets";
import {
  attributeSpend,
  spendFor,
  type PaneRef,
  type Spend,
  type WorkspaceRef,
} from "../lib/spendAttribution";
import { refreshSpend, useSpendWindows } from "../lib/spendStore";
import type { Workspace } from "../types";
import { RefreshIcon } from "./statusIcons";

/** Today's Claude Code spend in the status bar, and where it went.
 *
 * Deliberately the same chip vocabulary as `OpencodeSpendChip` beside it — a
 * label, a value, a popover — rather than a new visual system. What is
 * different is that this one is *governed*: with a daily ceiling set it grows
 * a bar and takes on the warn/over tint, so the same glance that reads "$42
 * today" also reads "and that is most of the day's budget".
 *
 * The dollar figure is priced from a local table in `claude_code_usage.rs`.
 * The popover says so, every time, because someone about to kill an agent over
 * this number needs to know it is an estimate and not their invoice.
 *
 * Attribution is per session id — every claude pane is launched with one — so
 * the breakdown is per workspace rather than one machine-wide lump. Spend that
 * no open workspace can claim (an agent from a closed workspace, a `claude`
 * run in a terminal outside flock) is shown as "elsewhere" rather than
 * dropped: it is still on the machine's bill. */
export default function BudgetChip({ workspaces }: { workspaces: Workspace[] }) {
  const spend = useSpendWindows();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

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

  // Subscribed rather than read once, so setting a ceiling in Settings shows
  // up on the chip immediately instead of at the next 60-second spend poll.
  const daily = useSyncExternalStore(onDailyBudgetChange, getDailyBudget);
  const attribution = useMemo(() => {
    const panes: PaneRef[] = workspaces.flatMap((w) =>
      w.panes.map((p) => ({ id: p.id, workspaceId: w.id, sessionId: p.sessionId, cwd: p.cwd })),
    );
    const refs: WorkspaceRef[] = workspaces.map((w) => ({ id: w.id, repoPath: w.repo_path }));
    return attributeSpend(spend.day, panes, refs);
  }, [spend.day, workspaces]);

  // Nothing to say before the first successful scan, or on a machine with no
  // Claude Code transcripts at all. An empty chip reading "$0.00" would be a
  // claim we cannot make — see the `available` note in spendStore.
  if (!spend.available || !spend.day) return null;
  const today = attribution.total;
  if (today.costUsd < 0.005 && today.tokens === 0) return null;

  const reading = readBudget(today, daily);
  const level: BudgetLevel = hasCeiling(daily) ? reading.level : "ok";
  const pct = Math.min(100, Math.round(reading.fraction * 100));

  const rows = workspaces
    .map((w) => ({ id: w.id, name: w.name, spent: spendFor(attribution.perWorkspace, w.id) }))
    .filter((r) => r.spent.costUsd > 0.005 || r.spent.tokens > 0)
    .sort((a, b) => b.spent.costUsd - a.spent.costUsd);

  // `reading.limit`/`reading.used` are in the governing axis's own units — a
  // token ceiling printed through money() would read "$5000000.00".
  const tip = hasCeiling(daily)
    ? reading.driver === "tokens"
      ? `Today — ${compact(reading.used)} of ${compact(reading.limit)} tokens (${pct}%)`
      : `Today — ${money(reading.used)} of ${money(reading.limit)} estimated (${pct}%)`
    : `Today — ${money(today.costUsd)} estimated Claude Code spend`;

  return (
    <div className="oc-mount" ref={ref}>
      <div
        className={`oc-chip clickable budget-chip lvl-${level}`}
        title={tip}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onActivateKey(() => setOpen((o) => !o))}
      >
        <span className="oc-label">today</span>
        <span className="oc-value">{money(today.costUsd)}</span>
        {hasCeiling(daily) && (
          <span className="budget-chip-track" aria-hidden>
            <span className={`budget-chip-fill lvl-${level}`} style={{ width: `${pct}%` }} />
          </span>
        )}
      </div>

      {open && (
        <div className="usage-popover" role="dialog">
          <div className="settings-section-header usage-header">
            <span>Spend today</span>
            <span className="spacer" />
            <button className="usage-refresh" title="Rescan transcripts" onClick={refreshSpend}>
              <RefreshIcon size={12} />
            </button>
          </div>

          {hasCeiling(daily) && (
            <div className="usage-group">
              <div className="usage-meter">
                <div className="usage-meter-head">
                  <span className="usage-meter-label">Daily budget</span>
                  <span className="usage-meter-pct">
                    {reading.driver === "tokens" ? compact(reading.used) : money(reading.used)}{" "}
                    <span className="usage-meter-of">of</span>{" "}
                    {reading.driver === "tokens" ? compact(reading.limit) : money(reading.limit)}
                  </span>
                </div>
                <div className="usage-bar">
                  <div className={`usage-bar-fill ${severityClass(level)}`} style={{ width: `${pct}%` }} />
                </div>
              </div>
            </div>
          )}

          <div className="usage-group">
            <div className="usage-group-title">By workspace</div>
            {rows.length === 0 && <div className="usage-meter-reset">No agent spend recorded today.</div>}
            {rows.map((r) => (
              <SpendRow key={r.id} label={r.name} spent={r.spent} />
            ))}
            {(attribution.unclaimed.costUsd > 0.005 || attribution.unclaimed.tokens > 0) && (
              <SpendRow
                label="Elsewhere"
                spent={attribution.unclaimed}
                hint="Sessions no open workspace claims — a closed workspace, or claude run outside flock."
              />
            )}
          </div>

          <div className="usage-footer">
            <span>
              Estimated from local transcripts and a built-in price table — a guardrail, not a bill.
            </span>
          </div>
          {spend.day.undated_cost_usd > 0.005 && (
            <div className="usage-footer usage-footer-err">
              <span>
                {money(spend.day.undated_cost_usd)} of spend has no readable timestamp and is in no
                window.
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Reuse the usage panel's severity palette rather than minting a third one:
 * these bars sit inches from the Claude/Codex limit bars and must read as the
 * same scale. */
function severityClass(level: BudgetLevel): string {
  if (level === "over") return "sev-critical";
  if (level === "warn") return "sev-warning";
  return "sev-normal";
}

function SpendRow({ label, spent, hint }: { label: string; spent: Spend; hint?: string }) {
  return (
    <div className="oc-stat" title={hint ?? `${compact(spent.tokens)} tokens`}>
      <span className="oc-stat-label">{label}</span>
      <span className="oc-stat-value">{money(spent.costUsd)}</span>
    </div>
  );
}
