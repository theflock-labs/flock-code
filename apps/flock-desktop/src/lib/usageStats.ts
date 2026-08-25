import { bumpStats, recordUsageDaily, setUsageTotals } from "./flockId";
import { claudeCodeUsage } from "./tauri";

// Local buffer of usage deltas, flushed to the flock ID backend on a short
// timer so a burst of prompts/spawns collapses into one network call instead of
// one per event. Best-effort throughout: these are social vanity counters, so a
// failed flush is dropped silently and never blocks the action that produced it.

// Everything here reports machine-wide facts: the hook log the prompt counter
// is driven from and the ~/.claude transcripts the token totals are summed from
// belong to the OS user, not to whichever flock ID an instance happens to be
// signed into. A `tauri dev` build is a second flock on that same machine, so
// left enabled it credits its (usually test) account with the whole machine's
// work — every prompt typed in the installed app included. Same reasoning that
// sends debug builds to ~/.flock-dev in data_dir(): a dev instance has no
// business writing to the real backend.
//
// Set `flock:sync-stats` to "1" in localStorage to report from a dev build
// anyway. That is the only way to exercise this path while working on it, and
// it matches how flockId.ts lets a dev point at their own Supabase project.
const DEV_OVERRIDE_KEY = "flock:sync-stats";

/** The whole decision, as a pure function of the two things the runtime
 *  supplies. Split out from the reads below because `import.meta.env.DEV` is
 *  fixed by the run mode and cannot be stubbed, so this is the only way to
 *  exercise the release-build branch under test. */
export function shouldReport(isDevBuild: boolean, override: string | null): boolean {
  return !isDevBuild || override === "1";
}

function reportingEnabled(): boolean {
  const env = (import.meta as { env?: Record<string, unknown> }).env ?? {};
  let override: string | null = null;
  try {
    override = localStorage.getItem(DEV_OVERRIDE_KEY);
  } catch {
    // No localStorage (a non-browser context): treat as no override.
  }
  return shouldReport(env.DEV === true, override);
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
  if (!hasPending()) return;
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
  try {
    const u = await claudeCodeUsage();
    if (!u.available) return;
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
