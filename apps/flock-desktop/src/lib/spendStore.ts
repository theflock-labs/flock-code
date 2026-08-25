// One poller for today's and this month's Claude Code spend.
//
// A module store rather than a hook per component, for the same reason
// `contextUsage.ts` is one: the status-bar chip, the settings panel and the
// budget-alert effect all want the same two numbers, and three independent
// timers would mean three transcript walks a minute for one answer.
//
// The cutoffs are recomputed on every pull rather than captured once, so the
// day window rolls over at local midnight on its own. Capturing them at module
// load meant an app left open overnight kept reporting yesterday's total as
// "today" — and a daily budget that has already fired never re-arms, so the
// morning's spend would have run unwatched.

import { useEffect, useSyncExternalStore } from "react";
import { claudeSpendWindows, type SpendWindow } from "./tauri";
import { dayStartMs, monthStartMs } from "./spendAttribution";
import { isWindowActive, onWindowActiveChange } from "./windowActive";

/** Slow on purpose. A transcript walk is the most expensive read in the app,
 * and spend is a number you act on over minutes, not seconds. */
const POLL_MS = 60_000;

export interface SpendSnapshot {
  /** False until the first successful pull, and whenever `~/.claude/projects`
   * is missing. Budget code must read this as "unknown", never as "$0 spent":
   * a budget that reads an unreadable directory as zero is a budget that never
   * fires. */
  available: boolean;
  /** Since local midnight. Null until the first successful pull. */
  day: SpendWindow | null;
  /** Since the first of the local month. */
  month: SpendWindow | null;
  fetchedAtMs: number;
}

const EMPTY: SpendSnapshot = { available: false, day: null, month: null, fetchedAtMs: 0 };

let snapshot: SpendSnapshot = EMPTY;
let subscribers = 0;
const subs = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

function emit() {
  for (const cb of subs) cb();
}

async function pull(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const now = Date.now();
    const res = await claudeSpendWindows([dayStartMs(now), monthStartMs(now)]);
    snapshot = {
      available: res.available,
      day: res.windows[0] ?? null,
      month: res.windows[1] ?? null,
      fetchedAtMs: res.fetched_at_ms,
    };
    emit();
  } catch {
    // Keep the last reading rather than blanking the chip: a failed tick is
    // almost always a transient file read, and a meter that flickers to
    // "unavailable" and back reads as a bug in the budget.
  } finally {
    inFlight = false;
  }
}

/** Force a refresh — used by the "refresh" affordance in the spend panel. */
export function refreshSpend(): void {
  void pull();
}

function ensureTimer() {
  if (timer !== null || subscribers === 0) return;
  timer = setInterval(() => {
    if (isWindowActive()) void pull();
  }, POLL_MS);
  void pull();
}

onWindowActiveChange((active) => {
  if (active && subscribers > 0) void pull();
});

function subscribe(cb: () => void): () => void {
  subs.add(cb);
  return () => {
    subs.delete(cb);
  };
}

/** Today's and this month's spend, polled while anything is watching. */
export function useSpendWindows(): SpendSnapshot {
  useEffect(() => {
    subscribers += 1;
    ensureTimer();
    return () => {
      subscribers -= 1;
      if (subscribers === 0 && timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
  }, []);

  return useSyncExternalStore(subscribe, () => snapshot);
}
