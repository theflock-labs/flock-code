import { useMemo, useSyncExternalStore } from "react";
import { formatCompact as compact, formatUsdExact as money } from "../lib/format";
import {
  DEFAULT_WARN_AT,
  getDailyBudget,
  hasCeiling,
  onDailyBudgetChange,
  readBudget,
  setDailyBudget,
  warnFraction,
  type Budget,
  type BudgetPeriod,
} from "../lib/budgets";
import {
  attributeSpend,
  spendFor,
  type PaneRef,
  type Spend,
  type WorkspaceRef,
} from "../lib/spendAttribution";
import { useSpendWindows } from "../lib/spendStore";
import type { Workspace } from "../types";

/** Where budgets are set: one machine-wide daily ceiling, and one per open
 * workspace. Lives in Settings → Usage Details, beside the Claude/Codex limit
 * panels, because "how much have I used" and "how much am I allowed" are the
 * same question asked twice and should not be in two different places.
 *
 * Both ceilings are on an **estimate**. Token counts come from the transcripts
 * and are exact; the dollars are those tokens priced with the table in
 * `claude_code_usage.rs`, which drifts whenever Anthropic changes a price. The
 * hint under the header says so and should stay there. */
export default function BudgetSection({
  workspaces,
  onSetWorkspaceBudget,
}: {
  workspaces: Workspace[];
  /** Persisted into the workspace_state blob by App.tsx. */
  onSetWorkspaceBudget: (workspaceId: string, budget: Budget | undefined) => void;
}) {
  const spend = useSpendWindows();
  // Read through the same subscription the status-bar chip uses, so the two
  // cannot disagree about what the ceiling is.
  const daily = useSyncExternalStore(onDailyBudgetChange, getDailyBudget);

  const { today, month } = useMemo(() => {
    const panes: PaneRef[] = workspaces.flatMap((w) =>
      w.panes.map((p) => ({ id: p.id, workspaceId: w.id, sessionId: p.sessionId, cwd: p.cwd })),
    );
    const refs: WorkspaceRef[] = workspaces.map((w) => ({ id: w.id, repoPath: w.repo_path }));
    return {
      today: attributeSpend(spend.day, panes, refs),
      month: attributeSpend(spend.month, panes, refs),
    };
  }, [spend.day, spend.month, workspaces]);

  return (
    <div className="settings-section">
      <div className="settings-section-header">Budgets</div>
      <p className="settings-hint" style={{ marginTop: 0 }}>
        Ceilings on Claude Code spend, checked as agents work. flock notifies you at{" "}
        {Math.round(warnFraction(daily) * 100)}% and again when a ceiling is crossed; it does not
        stop an agent. Dollar figures are <strong>estimates</strong> — token counts from your local
        transcripts, priced with a built-in table that drifts when Anthropic changes prices.
      </p>

      {!spend.available && (
        <div className="usage-error">
          No Claude Code transcripts found on this machine, so there is nothing to measure a budget
          against yet.
        </div>
      )}

      <BudgetEditor
        label="All agents, per day"
        hint="Machine-wide: every claude session recorded under ~/.claude/projects, whether or not flock started it."
        budget={daily}
        spent={today.total}
        fixedPeriod="day"
        onChange={setDailyBudget}
      />

      <div className="usage-group" style={{ marginTop: 14 }}>
        <div className="usage-group-title">Per workspace</div>
        {workspaces.length === 0 && (
          <div className="usage-meter-reset">Open a workspace to give it a ceiling.</div>
        )}
        {workspaces.map((w) => (
          <BudgetEditor
            key={w.id}
            label={w.name}
            hint={`${money(spendFor(today.perWorkspace, w.id).costUsd)} today · ${money(
              spendFor(month.perWorkspace, w.id).costUsd,
            )} this month`}
            budget={w.budget}
            spent={
              (w.budget?.period ?? "day") === "month"
                ? spendFor(month.perWorkspace, w.id)
                : spendFor(today.perWorkspace, w.id)
            }
            onChange={(b) => onSetWorkspaceBudget(w.id, b)}
          />
        ))}
      </div>
    </div>
  );
}

/** One ceiling: a dollar field, a token field, and (where the caller allows a
 * choice) the period it resets on. Empty means no ceiling on that axis, which
 * is a real answer and not zero — see `hasCeiling`. */
function BudgetEditor({
  label,
  hint,
  budget,
  spent,
  fixedPeriod,
  onChange,
}: {
  label: string;
  hint?: string;
  budget: Budget | undefined;
  spent: Spend;
  /** When set, the period is not the user's to choose (the daily ceiling). */
  fixedPeriod?: BudgetPeriod;
  onChange: (b: Budget | undefined) => void;
}) {
  const period: BudgetPeriod = fixedPeriod ?? budget?.period ?? "day";
  const reading = readBudget(spent, budget);
  const pct = Math.min(100, Math.round(reading.fraction * 100));

  /** Rebuild the budget from the edited field. An empty or unparseable field
   * clears that ceiling rather than becoming NaN — a NaN limit compares false
   * against every threshold, which is a budget that silently never fires. */
  const edit = (patch: Partial<Budget>) => {
    const next: Budget = {
      period,
      limitUsd: budget?.limitUsd,
      limitTokens: budget?.limitTokens,
      warnAt: budget?.warnAt ?? DEFAULT_WARN_AT,
      ...patch,
    };
    onChange(hasCeiling(next) ? next : undefined);
  };

  const num = (raw: string): number | undefined => {
    const v = Number(raw.replace(/[,$\s]/g, ""));
    return raw.trim() === "" || !Number.isFinite(v) || v <= 0 ? undefined : v;
  };

  return (
    <div className="budget-row">
      <div className="budget-row-head">
        <span className="oc-stat-label">{label}</span>
        {hasCeiling(budget) && (
          <span className="usage-meter-pct">
            {reading.driver === "tokens" ? compact(reading.used) : money(reading.used)}{" "}
            <span className="usage-meter-of">of</span>{" "}
            {reading.driver === "tokens" ? compact(reading.limit) : money(reading.limit)}
          </span>
        )}
      </div>

      {hasCeiling(budget) && (
        <div className="usage-bar">
          <div
            className={`usage-bar-fill ${
              reading.level === "over" ? "sev-critical" : reading.level === "warn" ? "sev-warning" : "sev-normal"
            }`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}

      <div className="budget-row-fields">
        <label className="budget-field">
          <span>USD</span>
          <input
            className="modal-input"
            type="text"
            inputMode="decimal"
            placeholder="none"
            defaultValue={budget?.limitUsd ? String(budget.limitUsd) : ""}
            onBlur={(e) => edit({ limitUsd: num(e.target.value) })}
          />
        </label>
        <label className="budget-field">
          <span>Tokens</span>
          <input
            className="modal-input"
            type="text"
            inputMode="numeric"
            placeholder="none"
            defaultValue={budget?.limitTokens ? String(budget.limitTokens) : ""}
            onBlur={(e) => edit({ limitTokens: num(e.target.value) })}
          />
        </label>
        {!fixedPeriod && (
          <label className="budget-field">
            <span>Resets</span>
            <select className="modal-input" value={period} onChange={(e) => edit({ period: e.target.value as BudgetPeriod })}>
              <option value="day">Daily</option>
              <option value="month">Monthly</option>
            </select>
          </label>
        )}
      </div>

      {hint && <div className="settings-hint budget-row-hint">{hint}</div>}
    </div>
  );
}
