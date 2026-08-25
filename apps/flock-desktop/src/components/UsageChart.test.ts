import { describe, it, expect } from "vitest";
import { __testables } from "./UsageChart";

const { toDeltas } = __testables;

const pt = (day: string, tokens: number, cost: number) => ({
  day,
  tokens_total: tokens,
  cost_usd: cost,
});

describe("toDeltas", () => {
  it("drops the first point, which has nothing to diff against", () => {
    const rows = toDeltas([pt("2026-08-01", 100, 1), pt("2026-08-02", 150, 2)]);
    expect(rows).toHaveLength(1);
    expect(rows[0].day).toBe("2026-08-02");
  });

  it("diffs consecutive days on a clean rising series", () => {
    const rows = toDeltas([
      pt("2026-08-01", 100, 1),
      pt("2026-08-02", 150, 3),
      pt("2026-08-03", 175, 3.5),
    ]);
    expect(rows.map((r) => r.tokens)).toEqual([50, 25]);
    expect(rows.map((r) => r.cost)).toEqual([2, 0.5]);
  });

  /* The bug this replaced: a dip clamped to zero, then the climb back to the
   * true cumulative counted as fresh usage, so the same spend was billed twice
   * and a 22-day window could exceed the all-time total. */
  it("does not double-count when a machine reports a lower cumulative", () => {
    const rows = toDeltas([
      pt("2026-08-01", 1000, 10),
      pt("2026-08-02", 600, 6), // a machine seeing fewer transcripts
      pt("2026-08-03", 1000, 10), // back to the true cumulative: no new usage
    ]);
    expect(rows.map((r) => r.tokens)).toEqual([0, 0]);
    expect(rows.map((r) => r.cost)).toEqual([0, 0]);
  });

  it("still counts real growth that arrives after a dip", () => {
    const rows = toDeltas([
      pt("2026-08-01", 1000, 10),
      pt("2026-08-02", 600, 6),
      pt("2026-08-03", 1250, 12), // 250 tokens / $2 genuinely new
    ]);
    expect(rows.map((r) => r.tokens)).toEqual([0, 250]);
    expect(rows.map((r) => r.cost)).toEqual([0, 2]);
  });

  /* The invariant that makes the dialog internally consistent: the windowed
   * total can never exceed the growth in the underlying cumulative figure. */
  it("keeps the window total within the cumulative range it was taken from", () => {
    const series = [
      pt("2026-08-01", 1000, 10),
      pt("2026-08-02", 400, 4),
      pt("2026-08-03", 1500, 15),
      pt("2026-08-04", 900, 9),
      pt("2026-08-05", 1600, 16),
    ];
    const rows = toDeltas(series);
    const summed = rows.reduce((n, r) => n + r.cost, 0);
    const range = Math.max(...series.map((p) => p.cost_usd)) - series[0].cost_usd;
    expect(summed).toBeCloseTo(range, 10);
  });

  it("emits nothing for an empty or single-point series", () => {
    expect(toDeltas([])).toEqual([]);
    expect(toDeltas([pt("2026-08-01", 100, 1)])).toEqual([]);
  });
});
