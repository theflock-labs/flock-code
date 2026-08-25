// One poller for every pane's context meter.
//
// A store rather than props threaded down from App.tsx: every workspace's
// PaneArea stays mounted (see the visibility note in PaneArea), so a hook that
// polled per component would run one timer per workspace and re-fetch the same
// sessions N times over. Here the meters *register* their session ids, one
// interval batches the whole live set into a single invoke, and each meter
// subscribes to its own id.
//
// Registration is ref-counted, so a pane closing (or a workspace being
// unmounted) takes its session out of the batch; the Rust side drops its memo
// for any id that stops being asked about, so a long-running app doesn't
// accumulate transcript handles for dead panes.

import { useEffect, useSyncExternalStore } from "react";
import { claudeContextUsage, type ContextUsage } from "./tauri";
import { isWindowActive, onWindowActiveChange } from "./windowActive";

/** Slow on purpose. The number only moves when an agent finishes a turn, and
 * each tick re-stats one file per pane; a snappier meter would buy nothing but
 * disk churn across a twelve-pane grid. */
const POLL_MS = 5000;

const refs = new Map<string, number>();
const readings = new Map<string, ContextUsage>();
const subs = new Set<() => void>();

let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

function emit() {
  for (const cb of subs) cb();
}

async function pull() {
  if (inFlight) return;
  const ids = [...refs.keys()];
  if (ids.length === 0) return;
  inFlight = true;
  try {
    const rows = await claudeContextUsage(ids);
    let changed = false;
    const seen = new Set<string>();
    for (const row of rows) {
      seen.add(row.session_id);
      const prev = readings.get(row.session_id);
      if (
        !prev ||
        prev.used_tokens !== row.used_tokens ||
        prev.window_tokens !== row.window_tokens
      ) {
        readings.set(row.session_id, row);
        changed = true;
      }
    }
    // A session whose transcript went away (worktree removed, history cleared)
    // should lose its meter rather than freeze on its last reading.
    for (const id of [...readings.keys()]) {
      if (refs.has(id) && !seen.has(id)) {
        readings.delete(id);
        changed = true;
      }
    }
    if (changed) emit();
  } catch {
    // Transcript reading is ambient telemetry; a failed tick keeps the last
    // reading and tries again rather than blanking every meter in the grid.
  } finally {
    inFlight = false;
  }
}

function ensureTimer() {
  if (timer !== null || refs.size === 0) return;
  timer = setInterval(() => {
    if (isWindowActive()) void pull();
  }, POLL_MS);
  void pull();
}

function stopTimer() {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}

// Coming back from hidden, refresh immediately instead of waiting out a tick
// the app spent minimized — the meters are the first thing you look at.
onWindowActiveChange((active) => {
  if (active) void pull();
});

function register(sessionId: string): () => void {
  refs.set(sessionId, (refs.get(sessionId) ?? 0) + 1);
  ensureTimer();
  return () => {
    const n = (refs.get(sessionId) ?? 1) - 1;
    if (n > 0) {
      refs.set(sessionId, n);
      return;
    }
    refs.delete(sessionId);
    readings.delete(sessionId);
    if (refs.size === 0) stopTimer();
  };
}

function subscribe(cb: () => void): () => void {
  subs.add(cb);
  return () => { subs.delete(cb); };
}

/** This session's context occupancy, or null while unknown (not a claude pane,
 * no transcript yet, or a jailed pane whose transcript lives in the container).
 * Pass undefined to opt out entirely — the hook then registers nothing. */
export function useContextUsage(sessionId?: string): ContextUsage | null {
  useEffect(() => {
    if (!sessionId) return;
    return register(sessionId);
  }, [sessionId]);

  return useSyncExternalStore(
    subscribe,
    () => (sessionId ? readings.get(sessionId) ?? null : null),
  );
}
