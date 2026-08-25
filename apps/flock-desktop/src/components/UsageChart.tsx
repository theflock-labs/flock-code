import { useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipProps,
} from "recharts";
import { getEffectiveTheme, onThemeChange } from "../lib/theme";
import type { UsageDailyPoint } from "../lib/flockId";
import { formatCompact as fmtTokens, formatUsd as fmtUsd } from "../lib/format";

/**
 * Daily usage.
 *
 * WHY BARS AND NOT THE AREA THIS USED TO BE. The series is one number per day,
 * diffed out of cumulative snapshots — 22 discrete totals, not a sampled
 * continuous signal. A `type="monotone"` area interpolates between those
 * points, which means every pixel between two days is a value the data does
 * not contain: the curve bulged above days that were nearly zero and rounded
 * the top off the two days that were not, so the spikes read smaller and the
 * quiet days read busier than they were. Bars say what the data says, one mark
 * per day, nothing between them.
 *
 * The rest follows from that: a solid hairline grid instead of a dashed one
 * (dashes read as a threshold or a projection when they are only a grid), three
 * ticks instead of five, and the peak day emphasised and directly labelled
 * rather than leaving the single most interesting value reachable only by
 * hovering it.
 *
 * One series, so no legend: the title names it.
 */

type Metric = "tokens" | "cost";

interface DeltaRow {
  day: string;
  label: string;
  tokens: number;
  cost: number;
}

function fmtDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Per-day usage from the cumulative snapshots. The earliest windowed point has
 *  no predecessor to diff against — dropping it avoids inventing either a fake
 *  zero or a spike the size of the entire all-time total.
 *
 *  DIFFED AGAINST A RUNNING MAXIMUM, NOT AGAINST THE PREVIOUS ROW.
 *
 *  The underlying quantity only goes up: `usage_daily` stores a cumulative
 *  total, and lifetime spend does not fall. But the series can still dip,
 *  because the figure is a machine-wide transcript scan and a machine that
 *  sees fewer transcripts writes a smaller number that day (the same hazard
 *  `set_usage_totals` keeps a high-water mark to defend against).
 *
 *  The old form was `max(0, p - prev)`, which clamps the dip to zero and then
 *  counts the climb back to the true value as fresh usage. Every dip is
 *  therefore billed twice, and the visible symptom is a window total larger
 *  than the all-time total printed 200px above it: this dialog was showing
 *  $16,221 over the last 22 days against $14,756 all-time, which is not a
 *  rounding disagreement, it is the same dollars counted more than once.
 *
 *  Diffing the running maximum makes a dip contribute nothing and its recovery
 *  contribute nothing, which is the correct reading of a monotonic series
 *  sampled by an unreliable observer. A genuinely new day still counts in
 *  full. */
function toDeltas(series: UsageDailyPoint[]): DeltaRow[] {
  const rows: DeltaRow[] = [];
  let peakTokens = series.length > 0 ? series[0].tokens_total : 0;
  let peakCost = series.length > 0 ? series[0].cost_usd : 0;
  for (let i = 1; i < series.length; i++) {
    const p = series[i];
    const nextTokens = Math.max(peakTokens, p.tokens_total);
    const nextCost = Math.max(peakCost, p.cost_usd);
    rows.push({
      day: p.day,
      label: fmtDay(p.day),
      tokens: nextTokens - peakTokens,
      cost: nextCost - peakCost,
    });
    peakTokens = nextTokens;
    peakCost = nextCost;
  }
  return rows;
}

/** The delta arithmetic is the part of this file that can be wrong in a way
 *  nobody sees, so it is tested directly rather than through the chart. */
export const __testables = { toDeltas };

/** Axis ticks are read in a column, so they are abbreviated hard: the axis says
 *  the shape of the scale, the tooltip and the header say the amount. */
function fmtAxis(v: number, metric: Metric): string {
  if (v === 0) return "0";
  if (metric === "tokens") return fmtTokens(v);
  return v >= 1000 ? `$${Math.round(v / 1000)}k` : `$${Math.round(v)}`;
}

/** Resolve a CSS custom property to its concrete value, recomputed on theme
 *  change so the SVG (which can't read `var(--x)` from presentation attributes)
 *  tracks the palette. */
function useTokens() {
  const [theme, setTheme] = useState(getEffectiveTheme());
  useEffect(() => onThemeChange(() => setTheme(getEffectiveTheme())), []);
  return useMemo(() => {
    const cs = getComputedStyle(document.documentElement);
    const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
    return {
      accent: v("--mint", "#4fffb0"),
      grid: v("--rule-faint", "rgba(255,255,255,0.04)"),
      axis: v("--text-ghost", "#6b7280"),
      hover: v("--sel-quiet", "rgba(255,255,255,0.06)"),
    };
    // theme is the recompute trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme]);
}

function UsageTooltip({ active, payload, metric }: TooltipProps<number, string> & { metric: Metric }) {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0].payload as DeltaRow;
  const value = metric === "tokens" ? fmtTokens(row.tokens) : fmtUsd(row.cost);
  return (
    <div className="usage-chart-tip">
      <div className="usage-chart-tip-day">{row.label}</div>
      <div className="usage-chart-tip-value">
        {value}
        <span className="usage-chart-tip-unit">{metric === "tokens" ? "tokens" : "spend"}</span>
      </div>
    </div>
  );
}

export default function UsageChart({ series, loading }: { series: UsageDailyPoint[] | null; loading: boolean }) {
  const [metric, setMetric] = useState<Metric>("tokens");
  const tokens = useTokens();
  const rows = useMemo(() => (series ? toDeltas(series) : []), [series]);

  const fmt = metric === "tokens" ? fmtTokens : fmtUsd;

  /** Total, mean and peak in one pass. The mean and the peak are what make the
   *  total legible: "$16,221 over 22 days" is a number, "$738 a day, one day at
   *  $8,104" is a shape. Both were previously only inferable by squinting at
   *  the plot. */
  const stats = useMemo(() => {
    const pick = (r: DeltaRow) => (metric === "tokens" ? r.tokens : r.cost);
    let total = 0;
    let peak = 0;
    let peakDay = "";
    for (const r of rows) {
      const v = pick(r);
      total += v;
      if (v > peak) {
        peak = v;
        peakDay = r.label;
      }
    }
    return { total, peak, peakDay, mean: rows.length ? total / rows.length : 0 };
  }, [rows, metric]);

  const header = (
    <div className="usage-chart-head">
      <div className="usage-chart-title">
        <span className="stats-group-head">Usage over time</span>
        {rows.length >= 2 && (
          <span className="usage-chart-total">
            {fmt(stats.total)}
            <span className="usage-chart-total-sub"> · last {rows.length}d</span>
          </span>
        )}
      </div>
      <div className="usage-chart-toggle" role="tablist" aria-label="Chart metric">
        <button
          type="button"
          role="tab"
          aria-selected={metric === "tokens"}
          className={`usage-chart-seg${metric === "tokens" ? " active" : ""}`}
          onClick={() => setMetric("tokens")}
        >
          Tokens
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={metric === "cost"}
          className={`usage-chart-seg${metric === "cost" ? " active" : ""}`}
          onClick={() => setMetric("cost")}
        >
          Spend
        </button>
      </div>
    </div>
  );

  // Fewer than two points means no day can be diffed yet — the history is still
  // filling in (the daily snapshot runs on launch + every 10 min).
  if (rows.length < 2) {
    return (
      <div className="usage-chart">
        {header}
        <div className="usage-chart-empty">
          {loading
            ? "Loading usage history…"
            : "Your daily usage will chart here as it adds up over the coming days."}
        </div>
      </div>
    );
  }

  const key = metric;
  return (
    <div className="usage-chart">
      {header}

      {/* The two figures that give the total a shape. Plain text on the card's
          ground, not tiles: three numbers do not need three boxes. */}
      <div className="usage-chart-context">
        <span>
          <b>{fmt(stats.mean)}</b> a day
        </span>
        <span className="usage-chart-context-sep" />
        <span>
          peak <b>{fmt(stats.peak)}</b> on {stats.peakDay}
        </span>
      </div>

      <div className="usage-chart-canvas">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 8, right: 6, left: 0, bottom: 0 }} barCategoryGap={2}>
            <CartesianGrid stroke={tokens.grid} vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fill: tokens.axis, fontSize: 9, fontFamily: "var(--font-mono)" }}
              tickLine={false}
              axisLine={{ stroke: tokens.grid }}
              interval="preserveStartEnd"
              minTickGap={28}
            />
            <YAxis
              width={34}
              // Three ticks, not five. The y-axis on this series exists to say
              // "roughly how big", and five labelled rows of it were more chart
              // furniture than the 22 marks they were measuring.
              tickCount={3}
              tick={{ fill: tokens.axis, fontSize: 9, fontFamily: "var(--font-mono)" }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: number) => fmtAxis(v, metric)}
            />
            <Tooltip
              // A soft rect, not a line: the mark under the pointer is a bar, so
              // the cursor should be the bar's own footprint.
              cursor={{ fill: tokens.hover }}
              content={<UsageTooltip metric={metric} />}
            />
            <Bar dataKey={key} radius={[3, 3, 0, 0]} isAnimationActive={false}>
              {rows.map((r) => {
                const v = metric === "tokens" ? r.tokens : r.cost;
                // Emphasis, not a value ramp: every bar is the same hue, and the
                // single extreme is the only one at full strength. A darker-where-
                // bigger ramp would re-encode height as colour and say nothing new.
                const isPeak = stats.peak > 0 && v === stats.peak;
                return (
                  <Cell
                    key={r.day}
                    fill={tokens.accent}
                    fillOpacity={isPeak ? 0.95 : 0.42}
                  />
                );
              })}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
