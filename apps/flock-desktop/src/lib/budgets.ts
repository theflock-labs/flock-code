// Spend ceilings, the reading of one, and the decision to shout about it.
//
// A budget is a ceiling on estimated spend inside a period. The estimate comes
// from `PRICES` in `claude_code_usage.rs` — token counts are exact, the dollars
// are `tokens × a local table` and drift the moment Anthropic changes a price.
// **This is a guardrail, not an invoice**, and every surface that shows one of
// these numbers says so. A budget that presented itself as billing would be
// worse than no budget: it would be trusted at a precision it does not have.
//
// The threshold arithmetic lives here, pure and separate from the poller and
// the UI, because the failure modes are all silent ones — a ceiling of zero
// read as "instantly over", an alert that fires on every poll, an alert that
// never re-arms after midnight. Each has a test.
//
// Nothing here reads a clock: `now` is always a parameter. That is what lets
// "does this re-arm the next day" be a test rather than a thing you find out
// the day after shipping.
//
// Two things budgets deliberately do *not* touch:
//
//   * **flock ID's `user_stats` is not a spend source.** `set_usage_totals`
//     keeps the maximum forever by design, so a machine that has only ever
//     seen part of the picture cannot lower a higher figure synced from
//     another one. That makes it a high-water mark, not a running total, and
//     differencing two readings of it is not a spend delta — it is noise
//     bounded below by zero. Budgets read the transcripts directly, through
//     `claude_spend_windows`, and never the synced counters.
//   * **A debug build is not exempt.** `usageStats.ts` reports nothing from a
//     dev build because it *writes* machine-wide figures to a shared backend,
//     where a `tauri dev` instance beside the installed app credits the same
//     prompt to two accounts. Nothing here writes anywhere; a ceiling is a
//     local guardrail on the machine's own spend, and silencing it in dev
//     would mean the one build most likely to be running a dozen agents at
//     once is the one with no brakes.

import type { Spend } from "./spendAttribution";
import { periodKey } from "./spendAttribution";

export type BudgetPeriod = "day" | "month";

export interface Budget {
  /** Estimated-USD ceiling for the period. Absent or 0 = no dollar ceiling. */
  limitUsd?: number;
  /** Token ceiling for the period. Absent or 0 = no token ceiling. */
  limitTokens?: number;
  period: BudgetPeriod;
  /** Fraction of the ceiling that counts as "approaching" — 0.8 by default.
   * Clamped into (0, 1): a warn threshold at or above the ceiling would make
   * the approach alert indistinguishable from the breach alert. */
  warnAt?: number;
}

export type BudgetLevel = "ok" | "warn" | "over";

/** Default approach threshold. 80% of a daily ceiling still leaves room to
 * finish the turn in flight, which is the point of warning at all. */
export const DEFAULT_WARN_AT = 0.8;

export interface BudgetReading {
  level: BudgetLevel;
  /** Worst of the dollar and token fractions. 0 when there is no ceiling. */
  fraction: number;
  /** Which ceiling produced `fraction`, so the message can name it. */
  driver: "usd" | "tokens" | null;
  /** The ceiling `driver` refers to, in its own units. */
  limit: number;
  /** Spend against that same ceiling, in the same units. */
  used: number;
}

const NO_READING: BudgetReading = { level: "ok", fraction: 0, driver: null, limit: 0, used: 0 };

/** A finite, positive ceiling, or 0 for "none". Guards the whole file against
 * a NaN out of an empty text input, which would otherwise propagate into a
 * fraction and compare false against every threshold — a budget that silently
 * never fires. */
function ceiling(v: number | undefined): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/** Does this budget constrain anything? A budget with both ceilings cleared is
 * off, not breached — dividing by a zero ceiling would otherwise read as
 * Infinity and put every workspace permanently over. */
export function hasCeiling(b: Budget | undefined): boolean {
  return !!b && (ceiling(b.limitUsd) > 0 || ceiling(b.limitTokens) > 0);
}

/** Warn threshold, clamped to something that can actually fire before the
 * ceiling does. */
export function warnFraction(b: Budget | undefined): number {
  const raw = b?.warnAt;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_WARN_AT;
  return Math.min(0.99, Math.max(0.01, raw));
}

/** How a period's spend reads against a ceiling.
 *
 * With both a dollar and a token ceiling set, the *worse* fraction governs —
 * they are two expressions of the same limit ("don't burn more than this"), so
 * the tighter one is the one meant. Taking the dollar one alone would let a
 * cheap-model run blow through a token ceiling unremarked. */
export function readBudget(spent: Spend, b: Budget | undefined): BudgetReading {
  if (!b) return NO_READING;
  const usdLimit = ceiling(b.limitUsd);
  const tokLimit = ceiling(b.limitTokens);
  if (usdLimit === 0 && tokLimit === 0) return NO_READING;

  // Negative spend is not a thing, but a subtraction upstream could produce
  // one; floor it so a bad input reads as "nothing spent" rather than as a
  // negative fraction that suppresses a real breach on the other axis.
  const usd = Math.max(0, spent.costUsd);
  const tokens = Math.max(0, spent.tokens);

  const usdFrac = usdLimit > 0 ? usd / usdLimit : -1;
  const tokFrac = tokLimit > 0 ? tokens / tokLimit : -1;
  const usdWorse = usdFrac >= tokFrac;

  const fraction = Math.max(usdFrac, tokFrac);
  const warn = warnFraction(b);
  // `>= 1`, not `> 1`: spending exactly the ceiling has used the whole budget.
  const level: BudgetLevel = fraction >= 1 ? "over" : fraction >= warn ? "warn" : "ok";

  return {
    level,
    fraction,
    driver: usdWorse ? "usd" : "tokens",
    limit: usdWorse ? usdLimit : tokLimit,
    used: usdWorse ? usd : tokens,
  };
}

// ─── Alerting ────────────────────────────────────────────────────────────────

const RANK: Record<BudgetLevel, number> = { ok: 0, warn: 1, over: 2 };

/** One thing being watched: a workspace's ceiling, or the machine-wide daily
 * one. `key` must be stable across restarts — it is what the fired-log is
 * indexed by. */
export interface BudgetWatch {
  key: string;
  /** Human name for the notification: a workspace name, or "Today". */
  label: string;
  budget: Budget;
  spent: Spend;
}

export interface BudgetAlert {
  key: string;
  label: string;
  level: "warn" | "over";
  reading: BudgetReading;
}

/** Highest level already announced for a key, as `"<periodKey>|<level>"`.
 * The period is part of the value rather than the key so the log cannot grow
 * one entry per day forever. */
export type FiredLog = Record<string, string>;

function firedRank(entry: string | undefined, currentPeriod: string): number {
  if (!entry) return 0;
  const [period, level] = entry.split("|");
  // A different period means the ceiling has reset; whatever fired then says
  // nothing about now. This is the whole re-arming mechanism — no timer, no
  // midnight callback to miss if the app was asleep.
  if (period !== currentPeriod) return 0;
  return RANK[level as BudgetLevel] ?? 0;
}

/** Which watches have crossed a threshold they have not already announced.
 *
 * Escalation only, within a period: warn fires once, then over fires once, and
 * warn never fires again behind it. Spend inside a period only grows (the
 * transcripts are append-only), so a reading that *falls* is a rescan artifact
 * — re-arming on it would turn one noisy scan into a stream of duplicate
 * alerts. It re-arms when the period rolls over, and only then. */
export function dueAlerts(
  watches: BudgetWatch[],
  fired: FiredLog,
  now: number,
): { alerts: BudgetAlert[]; nextFired: FiredLog } {
  const alerts: BudgetAlert[] = [];
  const nextFired: FiredLog = { ...fired };

  for (const w of watches) {
    if (!hasCeiling(w.budget)) continue;
    const period = periodKey(now, w.budget.period);
    const reading = readBudget(w.spent, w.budget);
    if (reading.level === "ok") {
      // Carry the entry forward untouched: a watch that dipped back to ok is
      // still "already announced" for this period.
      continue;
    }
    if (RANK[reading.level] <= firedRank(nextFired[w.key], period)) continue;
    nextFired[w.key] = `${period}|${reading.level}`;
    alerts.push({ key: w.key, label: w.label, level: reading.level, reading });
  }

  return { alerts, nextFired };
}

/** Drop log entries for keys nobody is watching any more (a deleted
 * workspace), so a long-lived install's localStorage doesn't accumulate one
 * line per workspace ever created. */
export function pruneFired(fired: FiredLog, liveKeys: Iterable<string>): FiredLog {
  const live = new Set(liveKeys);
  const out: FiredLog = {};
  for (const [k, v] of Object.entries(fired)) if (live.has(k)) out[k] = v;
  return out;
}

/** The sentence a notification carries. Says "estimated" on the dollar figure
 * every time, on purpose: it is priced from a local table, and someone about
 * to stop an agent over it deserves to know it is not their bill. */
export function alertText(a: BudgetAlert, period: BudgetPeriod): string {
  // Lead with the state and the period rather than the label, so the sentence
  // reads the same whether the label is a workspace name or the machine-wide
  // "all agents" — and so the notification list scans by severity.
  const span = period === "day" ? "today" : "this month";
  const amount =
    a.reading.driver === "tokens"
      ? `${Math.round(a.reading.used).toLocaleString()} of ${a.reading.limit.toLocaleString()} tokens`
      : `$${a.reading.used.toFixed(2)} of $${a.reading.limit.toFixed(2)} estimated`;
  const head = a.level === "over" ? "Over budget" : "Approaching budget";
  return `${head} ${span}: ${a.label} — ${amount}`;
}

// ─── Persistence ─────────────────────────────────────────────────────────────
//
// Two homes, matching where the thing being limited already lives. A
// workspace's ceiling rides in the workspace_state blob alongside its panes
// and layout (see `Workspace.budget` in types.ts and `saveWorkspace` in
// App.tsx), so it survives with the workspace and travels with it. The
// machine-wide daily ceiling and the fired-log are app preferences with no
// workspace to belong to, so they sit in localStorage next to the rest
// (`worktreeSettings.ts`, `githubSettings.ts`).

const DAILY_KEY = "flock:budget-daily";
const FIRED_KEY = "flock:budget-fired";

function parseDaily(raw: string | null): Budget | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<Budget>;
    if (!parsed || typeof parsed !== "object") return undefined;
    const b: Budget = {
      period: "day",
      limitUsd: ceiling(parsed.limitUsd) || undefined,
      limitTokens: ceiling(parsed.limitTokens) || undefined,
      warnAt: typeof parsed.warnAt === "number" ? parsed.warnAt : undefined,
    };
    return hasCeiling(b) ? b : undefined;
  } catch {
    return undefined;
  }
}

// Memoized on the stored string. `getDailyBudget` is a `useSyncExternalStore`
// snapshot (BudgetChip), and that contract requires the same reference back
// when nothing has changed — parsing fresh JSON on every call hands React a
// new object each render and it re-renders forever looking for a fixed point.
let dailyRaw: string | null = null;
let dailyValue: Budget | undefined;
let dailyRead = false;

/** The machine-wide daily ceiling, or undefined when none is set.
 *
 * Machine-wide is the honest scope: the transcripts under `~/.claude/projects`
 * belong to the OS user, not to any one flock account or workspace — the same
 * caveat the usage totals carry. */
export function getDailyBudget(): Budget | undefined {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(DAILY_KEY);
  } catch {
    raw = null;
  }
  if (dailyRead && raw === dailyRaw) return dailyValue;
  dailyRead = true;
  dailyRaw = raw;
  dailyValue = parseDaily(raw);
  return dailyValue;
}

/** Fired when the daily ceiling changes. localStorage's own `storage` event
 * only fires in *other* documents, so a same-window listener would never hear
 * this — and the status-bar chip would keep showing no bar until something
 * else happened to re-render it, which reads as the setting not having
 * saved. */
const DAILY_CHANGED = "flock:budget-daily-changed";

export function setDailyBudget(b: Budget | undefined): void {
  try {
    if (!b || !hasCeiling(b)) localStorage.removeItem(DAILY_KEY);
    else localStorage.setItem(DAILY_KEY, JSON.stringify({ ...b, period: "day" }));
  } catch {
    // No localStorage (tests, a locked-down webview): the budget is simply
    // not remembered. Never worth throwing out of a settings keystroke.
  }
  try {
    window.dispatchEvent(new Event(DAILY_CHANGED));
  } catch {
    // No DOM (a node test importing this for the pure half).
  }
}

/** Subscribe to daily-ceiling changes. Returns an unsubscribe. */
export function onDailyBudgetChange(cb: () => void): () => void {
  window.addEventListener(DAILY_CHANGED, cb);
  return () => window.removeEventListener(DAILY_CHANGED, cb);
}

export function getFiredLog(): FiredLog {
  try {
    const parsed = JSON.parse(localStorage.getItem(FIRED_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as FiredLog) : {};
  } catch {
    return {};
  }
}

export function setFiredLog(log: FiredLog): void {
  try {
    localStorage.setItem(FIRED_KEY, JSON.stringify(log));
  } catch {
    // Losing the log means at worst one duplicate alert after a restart.
  }
}
