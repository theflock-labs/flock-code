// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen, act } from "@testing-library/react";
import type { InsightsSummary } from "../lib/tauri";

// The two surfaces that used to print `sum(grounding_hits)` — the sidebar strip
// as "rediscoveries avoided", the panel as "facts reused instead of
// re-derived". Both were a lifetime count of bullet lines the grounding hook
// printed, so neither could fall, and neither did while the write half of the
// graph was dead across every relaunch.
//
// These tests pin the properties that failure would have needed: the headline
// must move with the *ratio* of knowledge read back rather than with cumulative
// activity, a graph with nothing to measure must say so instead of printing a
// confident figure, and the empty-pass denominator must be on screen.

const insights = vi.fn<(...a: unknown[]) => Promise<InsightsSummary>>();
vi.mock("../lib/tauri", () => ({ graphInsights: (...a: unknown[]) => insights(...a) }));
vi.mock("../lib/graphSettings", () => ({
  getGraphUrl: () => "postgresql://local",
  getGraphEnabled: () => true,
}));
import MoatReadout from "./MoatReadout";
import InsightsPanel from "./InsightsPanel";

const summary = (recall: Partial<InsightsSummary["recall"]> = {}): InsightsSummary => ({
  since: new Date().toISOString(),
  recall: {
    ground_passes: 0,
    passes_with_facts: 0,
    silent_passes: 0,
    facts_injected: 0,
    facts_recalled: 0,
    knowledge_total: 0,
    passes_unrecorded: 0,
    ...recall,
  },
  reads: 0,
  writes: 0,
  outcomes: 0,
  cost_minor: 0,
  currency: "USD",
  exponent: 2,
});

async function show(node: React.ReactElement, data: InsightsSummary) {
  insights.mockResolvedValue(data);
  await act(async () => {
    render(node);
  });
}

beforeEach(() => insights.mockReset());
afterEach(cleanup);

describe("MoatReadout", () => {
  it("reports coverage, not a cumulative count of injected lines", async () => {
    // The shape of the stress run that scored 300: one fact, fed over and over.
    // Coverage says 1 of 20, which is the truth about this graph.
    await show(<MoatReadout />, summary({
      ground_passes: 300,
      passes_with_facts: 300,
      facts_injected: 300,
      facts_recalled: 1,
      knowledge_total: 20,
    }));

    expect(screen.getByText("5%")).toBeTruthy();
    expect(screen.queryByText(/rediscover/i)).toBeNull();
    expect(screen.queryByText("300")).toBeNull();
  });

  it("shows the share of passes that surfaced nothing", async () => {
    await show(<MoatReadout />, summary({
      ground_passes: 10,
      passes_with_facts: 3,
      silent_passes: 7,
      facts_injected: 3,
      facts_recalled: 3,
      knowledge_total: 6,
    }));

    expect(screen.getByText("70% passes empty")).toBeTruthy();
  });

  it("says nothing rather than 0% when there is nothing to measure", async () => {
    // A graph with no recorded knowledge has no coverage. Printing 0% would
    // read as "recall is failing" when the truth is that nobody has written
    // anything down.
    await show(<MoatReadout />, summary({ ground_passes: 4 }));

    expect(screen.getByText("not enough data yet")).toBeTruthy();
    expect(screen.queryByText("0%")).toBeNull();
  });
});

describe("InsightsPanel", () => {
  it("leads with coverage and keeps the empty passes visible", async () => {
    await show(<InsightsPanel onClose={() => {}} />, summary({
      ground_passes: 40,
      passes_with_facts: 10,
      silent_passes: 30,
      facts_injected: 55,
      facts_recalled: 8,
      knowledge_total: 32,
    }));

    expect(screen.getByText("25%")).toBeTruthy();
    expect(screen.getByText(/of recorded knowledge was read back/)).toBeTruthy();
    expect(screen.getByText("75%")).toBeTruthy();
    expect(screen.getByText(/surfaced nothing \(30 of 40\)/)).toBeTruthy();
    expect(screen.queryByText(/re-derived/)).toBeNull();
  });

  it("prints no coverage at all when every pass in the window predates the record", async () => {
    // The numerator would be 0 and the panel would read "0% of your knowledge
    // is being used" — while what actually happened is 40 passes nobody can
    // account for. Being unable to tell those apart is what let the graph sit
    // dead for a release.
    await show(<InsightsPanel onClose={() => {}} />, summary({
      passes_unrecorded: 40,
      knowledge_total: 12,
    }));

    expect(screen.getByText("Not enough data yet")).toBeTruthy();
    expect(screen.getByText(/40 older passes/)).toBeTruthy();
    expect(screen.queryByText("0%")).toBeNull();
  });

  it("states on screen that none of it proves an effect on the agent's output", async () => {
    await show(<InsightsPanel onClose={() => {}} />, summary({
      ground_passes: 5,
      passes_with_facts: 5,
      facts_injected: 9,
      facts_recalled: 2,
      knowledge_total: 4,
    }));

    expect(screen.getByText(/A\/B against the same prompts with grounding off/)).toBeTruthy();
  });

  it("shows no money: no graph telemetry figure is attributable spend", async () => {
    await show(<InsightsPanel onClose={() => {}} />, summary({
      ground_passes: 5,
      passes_with_facts: 5,
      facts_injected: 9,
      facts_recalled: 2,
      knowledge_total: 4,
    }));

    expect(screen.queryByText(/\$/)).toBeNull();
    expect(screen.queryByText(/per shipped PR/)).toBeNull();
  });
});
