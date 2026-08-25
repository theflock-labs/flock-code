// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

// The panel is the confirmation that the export is worth taking — so the two
// things it must never do are report activity it was not asked about, and let
// a click on Export write a file for a window nobody chose.

const report = vi.fn();
const doExport = vi.fn();
const savePath = vi.fn();

vi.mock("../lib/tauri", () => ({
  provenanceReport: (...a: unknown[]) => report(...a),
  provenanceExport: (...a: unknown[]) => doExport(...a),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: (...a: unknown[]) => savePath(...a) }));

import ProvenanceSection from "./ProvenanceSection";
import type { ProvenanceSession } from "../lib/tauri";

const session = (over: Partial<ProvenanceSession> = {}): ProvenanceSession => ({
  id: "s1", pane_id: "p1", workspace_id: "w1", workspace_name: "flock",
  agent_name: "Fern", agent_kind: "claude", person_id: "person-1", person_name: "remi",
  repo_id: "git@github.com:acme/flock", repo_name: "flock",
  cwd: "/wt/a", branch: "feature/x", worktree: true, secure: false,
  transcript_ref: "", started_at: 1_700_000_000, ended_at: 1_700_003_723,
  updated_at: 1_700_003_723, outcome: "closed", prompts: 3, last_status: "done",
  tokens_input: 1_000, tokens_output: 2_000, tokens_cache_read: 0, tokens_cache_write: 0,
  cost_usd_micros: 1_234_567, status_history: [],
  ...over,
});

function reportOf(sessions: ProvenanceSession[], truncated = false) {
  return {
    sessions,
    totals: {
      sessions: sessions.length,
      prompts: sessions.reduce((n, s) => n + s.prompts, 0),
      tokens: sessions.reduce(
        (n, s) => n + s.tokens_input + s.tokens_output + s.tokens_cache_read + s.tokens_cache_write, 0),
      cost_usd_micros: sessions.reduce((n, s) => n + s.cost_usd_micros, 0),
    },
    truncated,
  };
}

async function show() {
  const view = render(<ProvenanceSection />);
  await act(async () => { await Promise.resolve(); });
  return view;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 7, 9, 12, 0, 0));
  report.mockReset().mockResolvedValue(reportOf([session()]));
  doExport.mockReset().mockResolvedValue({ path: "/tmp/out.csv", sessions: 1, bytes: 42 });
  savePath.mockReset().mockResolvedValue("/tmp/out.csv");
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("ProvenanceSection", () => {
  it("opens on the last thirty days and asks for exactly that window", async () => {
    await show();
    const [from, to, limit] = report.mock.calls[0];
    // Local midnight to local midnight *after* the end day, so today counts.
    expect(to - from).toBe(30 * 86_400);
    expect(new Date((from as number) * 1000).getDate()).toBe(11);
    expect(limit).toBe(200);
  });

  it("shows the session, its isolation and its cost", async () => {
    await show();
    expect(screen.getByText("Fern")).toBeTruthy();
    expect(screen.getByText("feature/x")).toBeTruthy();
    expect(screen.getByText("worktree")).toBeTruthy();
    expect(screen.getByText("1h 02m")).toBeTruthy();
    // Twice: the window's total tile and the row itself, which for a
    // single-session window must agree.
    expect(screen.getAllByText("$1.23")).toHaveLength(2);
  });

  /// An opencode pane has no transcript flock can read. A zero there would read
  /// as "this agent was free", which is a different claim from "not measured".
  it("leaves tokens blank rather than zero when there is no transcript", async () => {
    report.mockResolvedValue(reportOf([session({
      agent_kind: "opencode", tokens_input: 0, tokens_output: 0, cost_usd_micros: 0,
    })]));
    await show();
    const cells = document.querySelectorAll(".prov-table tbody td.num");
    expect(cells[cells.length - 1].textContent).toBe("—");
    expect(cells[cells.length - 2].textContent).toBe("—");
  });

  it("marks a still-running session instead of inventing a duration", async () => {
    report.mockResolvedValue(reportOf([session({ ended_at: null, outcome: "running" })]));
    await show();
    expect(screen.getByText("running")).toBeTruthy();
  });

  it("says the list is cut when the export would carry more", async () => {
    report.mockResolvedValue(reportOf([session()], true));
    await show();
    expect(screen.getByText(/the list below is cut, the export is not/)).toBeTruthy();
  });

  it("refuses a backwards range and does not query for it", async () => {
    await show();
    report.mockClear();
    const from = document.querySelectorAll<HTMLInputElement>(".prov-field input")[0];
    await act(async () => {
      fireEvent.change(from, { target: { value: "2026-12-31" } });
      await Promise.resolve();
    });
    expect(screen.getByText(/Pick an end date on or after the start date/)).toBeTruthy();
    expect(report).not.toHaveBeenCalled();
  });

  it("exports the window on screen, to the path the dialog returned", async () => {
    await show();
    await act(async () => {
      fireEvent.click(screen.getByText("Export CSV"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(savePath.mock.calls[0][0]).toMatchObject({
      defaultPath: "flock-provenance-2026-07-11_2026-08-09.csv",
    });
    const [from, to, format, dest] = doExport.mock.calls[0];
    const asked = report.mock.calls[0];
    expect([from, to]).toEqual([asked[0], asked[1]]);
    expect(format).toBe("csv");
    expect(dest).toBe("/tmp/out.csv");
    expect(screen.getByText(/Wrote 1 session to \/tmp\/out.csv/)).toBeTruthy();
  });

  /// Cancelling the save dialog is the most common outcome of pressing Export.
  it("writes nothing and reports nothing when the save dialog is dismissed", async () => {
    savePath.mockResolvedValue(null);
    await show();
    await act(async () => {
      fireEvent.click(screen.getByText("Export JSON"));
      await Promise.resolve();
    });
    expect(doExport).not.toHaveBeenCalled();
    expect(document.querySelector(".settings-error")).toBeNull();
  });

  it("states on screen that prompt text is never stored", async () => {
    await show();
    expect(screen.getByText(/prompt text, agent output, file contents and diffs are/i)).toBeTruthy();
  });
});
