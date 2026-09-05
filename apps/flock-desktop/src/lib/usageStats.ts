import { bumpStats, recordUsageDaily, setUsageTotals } from "./flockId";
import { claudeCodeUsage } from "./tauri";

// Local buffer of usage deltas, flushed to the flock ID backend on a short
// timer so a burst of prompts/spawns collapses into one network call instead of
// one per event. Best-effort throughout: these are social vanity counters, so a
// failed flush is dropped silently and never blocks the action that produced it.

// Explicit account consent comes from the server profile. A previous account's
// choice and the legacy developer override can never opt a new account in.
let consent = false;
let consentGeneration = 0;
const DEV_OVERRIDE_KEY = "flock:sync-stats";
export function shouldReport(isDevBuild: boolean, override: string | null, optedIn = false): boolean {
  return optedIn && (!isDevBuild || override === "1");
}
function reportingEnabled(): boolean {
  let override: string | null = null;
  try { override = localStorage.getItem(DEV_OVERRIDE_KEY); } catch { /* private by default */ }
  return shouldReport((import.meta as { env?: Record<string, unknown> }).env?.DEV === true, override, consent);
}
export function setUsageConsent(enabled: boolean): void {
  if (consent === enabled) return;
  consentGeneration++;
  consent = enabled;
  stopUsageSync();
  if (enabled) startUsageSync();
}

interface Pending {
  prompts: number;
  agents: number;
  workspaces: number;
}

const pending: Pending = { prompts: 0, agents: 0, workspaces: 0 };
let timer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_DELAY_MS = 15_000;

function hasPending(): boolean {
  return pending.prompts > 0 || pending.agents > 0 || pending.workspaces > 0;
}

async function flush(): Promise<void> {
  timer = null;
  if (!hasPending() || !reportingEnabled()) return;
  const d = { prompts: pending.prompts, agents: pending.agents, workspaces: pending.workspaces };
  pending.prompts = 0;
  pending.agents = 0;
  pending.workspaces = 0;
  try {
    await bumpStats(d);
  } catch {
    // Swallow: vanity stats are not worth retrying or surfacing. The next
    // event re-arms the timer; a dropped batch just under-counts slightly.
  }
}

/** Record usage to be flushed to the backend shortly. Fire-and-forget. */
export function recordUsage(d: { prompts?: number; agents?: number; workspaces?: number }): void {
  if (!reportingEnabled()) return;
  pending.prompts += d.prompts ?? 0;
  pending.agents += d.agents ?? 0;
  pending.workspaces += d.workspaces ?? 0;
  if (timer === null && hasPending()) {
    timer = setTimeout(flush, FLUSH_DELAY_MS);
  }
}

// Cumulative Claude Code token/USD totals are absolute snapshots, not per-event
// deltas — computed locally from the transcripts and pushed via set_usage_totals
// (which keeps the max). Sync on launch and on a slow timer; the totals barely
// move minute-to-minute and the transcript scan is I/O-heavy, so there's no
// point going faster.
const USAGE_SYNC_INTERVAL_MS = 10 * 60_000;
let usageSyncTimer: ReturnType<typeof setInterval> | null = null;

async function syncOnce(): Promise<void> {
  if (!reportingEnabled()) return;
  const generation = consentGeneration;
  try {
    const u = await claudeCodeUsage();
    if (!u.available || generation !== consentGeneration || !reportingEnabled()) return;
    // Push the absolute total (kept as max) and stamp today's point in the
    // daily history that the usage chart reads back. Both monotonic snapshots.
    await Promise.all([
      setUsageTotals(u.tokens_total, u.cost_usd),
      recordUsageDaily(u.tokens_total, u.cost_usd),
    ]);
  } catch {
    // Best-effort, same as the counters: never surface or retry a failed sync.
  }
}

/** Start periodic sync of cumulative Claude Code token/USD totals to flock
 * ID. Idempotent — calling twice won't stack timers. Runs once immediately. */
export function startUsageSync(): void {
  if (!reportingEnabled()) return;
  if (usageSyncTimer !== null) return;
  void syncOnce();
  usageSyncTimer = setInterval(() => void syncOnce(), USAGE_SYNC_INTERVAL_MS);
}

/** Stop the periodic sync and drop any buffered counter deltas. Called on
 * sign-out — the transcript scan is I/O-heavy and everything here writes to
 * the signed-in profile, so with no session there is nothing to sync. */
export function stopUsageSync(): void {
  if (usageSyncTimer !== null) {
    clearInterval(usageSyncTimer);
    usageSyncTimer = null;
  }
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  pending.prompts = 0;
  pending.agents = 0;
  pending.workspaces = 0;
}
