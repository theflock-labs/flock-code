import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { shouldReport } from "./usageStats";

// Everything usageStats reports is machine-wide, so a `tauri dev` build running
// beside the installed app would credit its own (usually test) flock ID with the
// whole machine's work — every prompt typed in the installed app included. These
// cover the gate that stops it, in both directions: a silent regression here
// either leaks a dev instance's writes into the real backend or quietly stops
// the installed app reporting at all, and neither shows up on screen.

vi.mock("./flockId", () => ({
  bumpStats: vi.fn(async () => {}),
  setUsageTotals: vi.fn(async () => {}),
  recordUsageDaily: vi.fn(async () => {}),
}));

vi.mock("./tauri", () => ({
  claudeCodeUsage: vi.fn(async () => ({ available: true, tokens_total: 42, cost_usd: 1 })),
}));

// Tests run in node, where there is no real localStorage — only enough of one
// to read the override key back.
const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  clear: () => store.clear(),
});

/** Fresh module state per test: the buffer and its timer are module-level. */
async function load() {
  vi.resetModules();
  const flockId = await import("./flockId");
  const usageStats = await import("./usageStats");
  return { ...usageStats, ...flockId };
}

beforeEach(() => {
  vi.useFakeTimers();
  store.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

// `import.meta.env.DEV` is fixed to true under vitest and cannot be stubbed, so
// the release-build branch is covered here and the dev-build branches are
// covered end-to-end below.
describe("shouldReport", () => {
  it("reports from a release build regardless of the override", () => {
    expect(shouldReport(false, null)).toBe(true);
    expect(shouldReport(false, "1")).toBe(true);
    expect(shouldReport(false, "0")).toBe(true);
  });

  it("stays silent from a dev build unless explicitly opted in", () => {
    expect(shouldReport(true, null)).toBe(false);
    expect(shouldReport(true, "")).toBe(false);
    expect(shouldReport(true, "0")).toBe(false);
    expect(shouldReport(true, "yes")).toBe(false);
    expect(shouldReport(true, "1")).toBe(true);
  });
});

/** Push the 15s debounce past its deadline and let the flush's promise settle. */
async function flushBuffer() {
  await vi.advanceTimersByTimeAsync(20_000);
}

describe("counters, from a dev build", () => {
  it("buffers nothing and calls nothing", async () => {
    const { recordUsage, bumpStats } = await load();
    recordUsage({ prompts: 1, agents: 2, workspaces: 3 });
    await flushBuffer();
    expect(bumpStats).not.toHaveBeenCalled();
  });

  it("reports when opted in", async () => {
    localStorage.setItem("flock:sync-stats", "1");
    const { recordUsage, bumpStats } = await load();
    recordUsage({ prompts: 1 });
    await flushBuffer();
    expect(bumpStats).toHaveBeenCalledWith({ prompts: 1, agents: 0, workspaces: 0 });
  });
});

describe("token/cost sync, from a dev build", () => {
  it("does not sync, now or on the interval", async () => {
    const { startUsageSync, setUsageTotals, recordUsageDaily } = await load();
    startUsageSync();
    // Past the first tick of the 10-minute timer, so a gate that only skipped
    // the immediate sync would still be caught.
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(setUsageTotals).not.toHaveBeenCalled();
    expect(recordUsageDaily).not.toHaveBeenCalled();
  });

  it("syncs when opted in", async () => {
    localStorage.setItem("flock:sync-stats", "1");
    const { startUsageSync, stopUsageSync, setUsageTotals, recordUsageDaily } = await load();
    startUsageSync();
    await vi.advanceTimersByTimeAsync(0);
    expect(setUsageTotals).toHaveBeenCalledWith(42, 1);
    expect(recordUsageDaily).toHaveBeenCalledWith(42, 1);
    stopUsageSync();
  });
});
