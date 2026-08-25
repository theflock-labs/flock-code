// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen, act } from "@testing-library/react";
import type { RecallReport } from "../lib/tauri";

// Recall is the only place in the app that reports whether the graph is being
// *read*, and the whole point of building it was that every other readout
// flatters. These tests pin the three claims it would be easiest to quietly
// get wrong in the flattering direction: an empty pass must still look empty,
// a fact the team has since retracted must say so, and coverage must be
// measured against everything recorded rather than against what happened to be
// recalled.

const recall = vi.fn<(...a: unknown[]) => Promise<RecallReport>>();
vi.mock("../lib/tauri", () => ({ graphRecall: (...a: unknown[]) => recall(...a) }));
vi.mock("../lib/graphSettings", () => ({ getGraphUrl: () => "postgresql://local" }));

import GraphRecallView from "./GraphRecallView";

const fact = (over: Partial<RecallReport["passes"][0]["facts"][0]> = {}) => ({
  id: crypto.randomUUID(),
  kind: "Decision",
  label: "panes stay mounted",
  body: "because xterm dies otherwise",
  archived: false,
  superseded: false,
  ...over,
});

const stats = (over: Partial<RecallReport["stats"]> = {}): RecallReport["stats"] => ({
  ground_passes: 0,
  passes_with_facts: 0,
  silent_passes: 0,
  facts_injected: 0,
  facts_recalled: 0,
  knowledge_total: 0,
  passes_unrecorded: 0,
  ...over,
});

const report = (over: Partial<RecallReport> = {}): RecallReport => ({
  passes: [],
  top: [],
  ...over,
  stats: stats(over.stats),
});

/** Render and flush the one effect that fetches. */
async function show(r: RecallReport) {
  recall.mockResolvedValue(r);
  await act(async () => {
    render(<GraphRecallView workspaceId="ws-1" />);
  });
}

beforeEach(() => recall.mockReset());
afterEach(cleanup);

describe("GraphRecallView", () => {
  it("says nothing surfaced rather than hiding an empty pass", async () => {
    await show(report({
      passes: [
        { ts: new Date().toISOString(), workspace_id: "ws-1", agent_id: "swift-heron", facts: [] },
        { ts: new Date().toISOString(), workspace_id: "ws-1", agent_id: "swift-heron", facts: [fact()] },
      ],
      stats: stats({ ground_passes: 2, passes_with_facts: 1, silent_passes: 1, knowledge_total: 4, facts_recalled: 1 }),
    }));

    expect(screen.getByText("nothing surfaced")).toBeTruthy();
    // The pass counter is the honest headline: one of two found anything.
    expect(screen.getByText("1/2")).toBeTruthy();
  });

  it("counts passes over the selected window, not over the rows it rendered", async () => {
    // The list is capped at 40 passes. Deriving the counter from it answered
    // for the last 40 prompts while the button said 90 days — and always in
    // the flattering direction, since a recent burst of hits is what fills the
    // cap in the first place.
    await show(report({
      passes: [{ ts: new Date().toISOString(), workspace_id: "ws-1", agent_id: "a", facts: [fact()] }],
      stats: stats({ ground_passes: 210, passes_with_facts: 12, silent_passes: 198, knowledge_total: 9, facts_recalled: 4 }),
    }));

    expect(screen.getByText("12/210")).toBeTruthy();
  });

  it("excludes passes that cannot say what they surfaced, and says so", async () => {
    await show(report({
      passes: [{ ts: new Date().toISOString(), workspace_id: "ws-1", agent_id: "a", facts: [fact()] }],
      stats: stats({ ground_passes: 3, passes_with_facts: 3, silent_passes: 0, knowledge_total: 5, facts_recalled: 2, passes_unrecorded: 17 }),
    }));

    expect(screen.getByText("3/3")).toBeTruthy();
    expect(screen.getByText(/17 older/)).toBeTruthy();
  });

  it("flags a fact the team retracted after it was injected", async () => {
    await show(report({
      passes: [{
        ts: new Date().toISOString(),
        workspace_id: "ws-1",
        agent_id: "a",
        facts: [fact({ archived: true }), fact({ label: "old api shape", superseded: true })],
      }],
      stats: stats({ ground_passes: 1, passes_with_facts: 1, knowledge_total: 2, facts_recalled: 2 }),
    }));

    expect(screen.getByText("retracted since")).toBeTruthy();
    expect(screen.getByText("superseded since")).toBeTruthy();
  });

  it("measures coverage against everything recorded, not against what was recalled", async () => {
    // Three of forty pieces of knowledge came back in the window. A readout
    // that divided recalled by recalled would print 100% and mean nothing.
    await show(report({
      passes: [{ ts: new Date().toISOString(), workspace_id: "ws-1", agent_id: "a", facts: [fact()] }],
      top: [{ id: "1", kind: "Note", label: "n", recalls: 9 }],
      stats: stats({ ground_passes: 1, passes_with_facts: 1, knowledge_total: 40, facts_recalled: 3 }),
    }));

    expect(screen.getByText("8%")).toBeTruthy();
    expect(screen.getByText(/3 of 40/)).toBeTruthy();
  });

  it("reads the configured graph, not the default local one", async () => {
    await show(report());
    expect(recall).toHaveBeenCalledWith("ws-1", 30, "postgresql://local");
  });
});
