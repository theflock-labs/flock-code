// @vitest-environment jsdom
// jsdom for the storage half only — the threshold arithmetic below is pure and
// needs no DOM, but `getDailyBudget` is a useSyncExternalStore snapshot backed
// by localStorage, and its reference-stability contract is exactly the kind of
// thing that is only found in production if it is not pinned here.
import { beforeAll, describe, expect, it } from "vitest";
import {
  alertText,
  dueAlerts,
  getDailyBudget,
  hasCeiling,
  pruneFired,
  readBudget,
  setDailyBudget,
  warnFraction,
  type Budget,
  type BudgetWatch,
  type FiredLog,
} from "./budgets";
import type { Spend } from "./spendAttribution";

const spend = (costUsd: number, tokens = 0): Spend => ({ costUsd, tokens });
const usd = (limitUsd: number, warnAt?: number): Budget => ({ period: "day", limitUsd, warnAt });

describe("readBudget", () => {
  it("reads ok, warn and over off the default 80% threshold", () => {
    const b = usd(100);
    expect(readBudget(spend(10), b).level).toBe("ok");
    expect(readBudget(spend(79.99), b).level).toBe("ok");
    expect(readBudget(spend(80), b).level).toBe("warn");
    expect(readBudget(spend(99.99), b).level).toBe("warn");
    expect(readBudget(spend(150), b).level).toBe("over");
  });

  it("treats spending exactly the ceiling as over, not as still inside it", () => {
    expect(readBudget(spend(100), usd(100)).level).toBe("over");
  });

  it("reads a budget with no ceiling as off, not as instantly breached", () => {
    // The division-by-zero trap: `spent / 0` is Infinity, which compares >= 1
    // and would put every workspace permanently over the moment budgets
    // shipped with an empty default.
    for (const b of [
      { period: "day" } as Budget,
      { period: "day", limitUsd: 0 } as Budget,
      { period: "day", limitUsd: Number.NaN } as Budget,
      { period: "day", limitUsd: -5 } as Budget,
    ]) {
      expect(hasCeiling(b)).toBe(false);
      const r = readBudget(spend(9999), b);
      expect(r.level).toBe("ok");
      expect(r.fraction).toBe(0);
      expect(r.driver).toBeNull();
    }
    expect(readBudget(spend(1), undefined).level).toBe("ok");
  });

  it("lets the tighter of a dollar and a token ceiling govern", () => {
    // A cheap model can blow a token ceiling while barely moving the dollar
    // one; reading only the dollars would never notice.
    const b: Budget = { period: "day", limitUsd: 100, limitTokens: 1_000_000 };
    const r = readBudget(spend(10, 950_000), b);
    expect(r.level).toBe("warn");
    expect(r.driver).toBe("tokens");
    expect(r.limit).toBe(1_000_000);
    expect(r.used).toBe(950_000);

    const r2 = readBudget(spend(90, 10_000), b);
    expect(r2.level).toBe("warn");
    expect(r2.driver).toBe("usd");
  });

  it("does not let one slack axis mask a breach on the other", () => {
    const b: Budget = { period: "day", limitUsd: 1000, limitTokens: 1000 };
    expect(readBudget(spend(1, 5000), b).level).toBe("over");
  });

  it("clamps a warn threshold that could never fire before the ceiling", () => {
    expect(warnFraction(usd(100, 1.5))).toBe(0.99);
    expect(warnFraction(usd(100, 0))).toBe(0.01);
    expect(warnFraction(usd(100, -1))).toBe(0.01);
    expect(warnFraction(usd(100, Number.NaN))).toBe(0.8);
    expect(warnFraction(usd(100))).toBe(0.8);
    // A 0.5 threshold is honored as given.
    expect(readBudget(spend(50), usd(100, 0.5)).level).toBe("warn");
    expect(readBudget(spend(49), usd(100, 0.5)).level).toBe("ok");
  });

  it("floors negative spend rather than letting it suppress a real breach", () => {
    const b: Budget = { period: "day", limitUsd: 100, limitTokens: 100 };
    const r = readBudget({ costUsd: -50, tokens: 200 }, b);
    expect(r.level).toBe("over");
    expect(r.driver).toBe("tokens");
  });
});

describe("dueAlerts", () => {
  const NOW = new Date(2026, 7, 9, 12, 0).getTime();
  const NEXT_DAY = new Date(2026, 7, 10, 9, 0).getTime();

  const watch = (costUsd: number, budget: Budget = usd(100)): BudgetWatch[] => [
    { key: "ws:a", label: "flock", budget, spent: spend(costUsd) },
  ];

  it("fires warn once, not on every poll", () => {
    const first = dueAlerts(watch(85), {}, NOW);
    expect(first.alerts.map((a) => a.level)).toEqual(["warn"]);

    const second = dueAlerts(watch(85), first.nextFired, NOW);
    expect(second.alerts).toEqual([]);
    // The poll after that, still nothing.
    expect(dueAlerts(watch(90), second.nextFired, NOW).alerts).toEqual([]);
  });

  it("escalates from warn to over, and does not fall back to warn behind it", () => {
    const warned = dueAlerts(watch(85), {}, NOW);
    const crossed = dueAlerts(watch(120), warned.nextFired, NOW);
    expect(crossed.alerts.map((a) => a.level)).toEqual(["over"]);

    // A rescan that reports less must not re-arm warn: spend inside a period
    // only grows, so a dip is an artifact, and re-arming turns one noisy scan
    // into a stream of duplicates.
    expect(dueAlerts(watch(85), crossed.nextFired, NOW).alerts).toEqual([]);
  });

  it("fires over directly when spend jumps past both thresholds between polls", () => {
    const r = dueAlerts(watch(500), {}, NOW);
    expect(r.alerts.map((a) => a.level)).toEqual(["over"]);
    // Having announced "over", the skipped "warn" must not arrive afterwards.
    expect(dueAlerts(watch(85), r.nextFired, NOW).alerts).toEqual([]);
  });

  it("re-arms when the period rolls over", () => {
    const today = dueAlerts(watch(120), {}, NOW);
    expect(today.alerts).toHaveLength(1);
    // Same ceiling, same reading, next day: the budget reset, so it fires
    // again. No midnight timer is involved — the period label simply changed,
    // which also means an app that was closed at midnight still re-arms.
    const tomorrow = dueAlerts(watch(120), today.nextFired, NEXT_DAY);
    expect(tomorrow.alerts.map((a) => a.level)).toEqual(["over"]);
  });

  it("keeps a monthly budget armed across a day boundary", () => {
    const monthly: Budget = { period: "month", limitUsd: 100 };
    const first = dueAlerts(watch(120, monthly), {}, NOW);
    expect(first.alerts).toHaveLength(1);
    expect(dueAlerts(watch(120, monthly), first.nextFired, NEXT_DAY).alerts).toEqual([]);
    // A new month does re-arm it.
    const nextMonth = new Date(2026, 8, 1, 9, 0).getTime();
    expect(dueAlerts(watch(120, monthly), first.nextFired, nextMonth).alerts).toHaveLength(1);
  });

  it("ignores watches with no ceiling set", () => {
    const r = dueAlerts(
      [{ key: "ws:a", label: "flock", budget: { period: "day" }, spent: spend(9999) }],
      {},
      NOW,
    );
    expect(r.alerts).toEqual([]);
    expect(r.nextFired).toEqual({});
  });

  it("tracks each watch independently", () => {
    const watches: BudgetWatch[] = [
      { key: "ws:a", label: "A", budget: usd(100), spent: spend(120) },
      { key: "ws:b", label: "B", budget: usd(100), spent: spend(10) },
      { key: "daily", label: "Today", budget: usd(500), spent: spend(450) },
    ];
    const r = dueAlerts(watches, {}, NOW);
    expect(r.alerts.map((a) => `${a.key}:${a.level}`)).toEqual(["ws:a:over", "daily:warn"]);
  });

  it("leaves an already-fired entry alone when the reading returns to ok", () => {
    const fired: FiredLog = { "ws:a": `2026-08-09|over` };
    const r = dueAlerts(watch(1), fired, NOW);
    expect(r.alerts).toEqual([]);
    expect(r.nextFired["ws:a"]).toBe("2026-08-09|over");
  });

  it("survives a corrupt log entry rather than throwing", () => {
    const r = dueAlerts(watch(85), { "ws:a": "garbage" }, NOW);
    expect(r.alerts.map((a) => a.level)).toEqual(["warn"]);
  });
});

describe("getDailyBudget", () => {
  // Node 22 puts its own half-configured `localStorage` on globalThis, which
  // shadows jsdom's and throws on setItem. Substitute a plain map so these
  // exercise the parse/memo logic rather than the runner's environment.
  beforeAll(() => {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
        clear: () => store.clear(),
      },
    });
  });

  // `getDailyBudget` is a useSyncExternalStore snapshot. That contract requires
  // the same reference back when nothing has changed; parsing fresh JSON every
  // call hands React a new object each render and it re-renders forever
  // looking for a fixed point.
  it("returns a stable reference until the stored value changes", () => {
    setDailyBudget({ period: "day", limitUsd: 25 });
    const a = getDailyBudget();
    expect(a?.limitUsd).toBe(25);
    expect(getDailyBudget()).toBe(a);

    setDailyBudget({ period: "day", limitUsd: 50 });
    const b = getDailyBudget();
    expect(b).not.toBe(a);
    expect(b?.limitUsd).toBe(50);
    expect(getDailyBudget()).toBe(b);
  });

  it("round-trips through storage and clears on a budget with no ceiling", () => {
    setDailyBudget({ period: "day", limitUsd: 10, limitTokens: 2_000_000, warnAt: 0.5 });
    const b = getDailyBudget();
    expect(b).toEqual({ period: "day", limitUsd: 10, limitTokens: 2_000_000, warnAt: 0.5 });

    // Both ceilings cleared is "off", which must persist as absent rather than
    // as a stored budget of zero that reads as instantly breached.
    setDailyBudget({ period: "day" });
    expect(getDailyBudget()).toBeUndefined();
  });

  it("reads a corrupt stored value as no budget", () => {
    localStorage.setItem("flock:budget-daily", "{not json");
    expect(getDailyBudget()).toBeUndefined();
    localStorage.removeItem("flock:budget-daily");
  });
});

describe("pruneFired", () => {
  it("drops entries for keys nobody watches any more", () => {
    const out = pruneFired({ "ws:a": "x", "ws:gone": "y", daily: "z" }, ["ws:a", "daily"]);
    expect(Object.keys(out).sort()).toEqual(["daily", "ws:a"]);
  });
});

describe("alertText", () => {
  it("always marks the dollar figure as an estimate", () => {
    const a = dueAlerts([{ key: "k", label: "flock", budget: usd(100), spent: spend(120) }], {}, Date.now())
      .alerts[0];
    const text = alertText(a, "day");
    expect(text).toBe("Over budget today: flock — $120.00 of $100.00 estimated");
  });

  it("names tokens rather than dollars when the token ceiling is the tighter one", () => {
    const a = dueAlerts(
      [
        {
          key: "k",
          label: "flock",
          budget: { period: "month", limitUsd: 1000, limitTokens: 1000 },
          spent: { costUsd: 1, tokens: 2000 },
        },
      ],
      {},
      Date.now(),
    ).alerts[0];
    const text = alertText(a, "month");
    expect(text).toContain("2,000 of 1,000 tokens");
    expect(text).toContain("this month");
  });
});
