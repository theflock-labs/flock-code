// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { GraphKgNode, GraphNeighbor, RecallReport } from "../lib/tauri";

const api = vi.hoisted(() => ({ list: vi.fn(), neighbors: vi.fn(), subgraph: vi.fn(), recall: vi.fn(), overview: vi.fn() }));
vi.mock("../lib/tauri", () => ({ graphListNodes: api.list, graphNodeNeighbors: api.neighbors, graphSubgraph: api.subgraph, graphRecall: api.recall, graphOverview: api.overview }));
vi.mock("../lib/useFocusTrap", () => ({ useFocusTrap: () => {} }));
vi.mock("../lib/windowActive", () => ({ isWindowActive: () => true, onWindowActiveChange: () => () => {} }));
vi.mock("./InsightsPanel", () => ({ default: () => null }));
vi.mock("./GraphCanvas", () => ({ default: () => <div>Graph map</div> }));
import GraphExplorer from "./GraphExplorer";

const node = (id: string, kind = "Decision"): GraphKgNode => ({ id, kind, label: `Knowledge ${id}`, body: `Body ${id}`, workspace_id: "ws-1", created_by_agent: "swift-heron", created_at: "2026-09-01T10:00:00Z", updated_at: "2026-09-05T10:00:00Z", archived_at: null, outcome: null, shipped_in: null });
const emptyReport: RecallReport = { passes: [], top: [], stats: { ground_passes: 0, passes_with_facts: 0, silent_passes: 0, facts_injected: 0, facts_recalled: 0, knowledge_total: 0, passes_unrecorded: 0 } };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
async function flush(ms = 0) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
async function show() { render(<GraphExplorer workspaceId="ws-1" workspaceName="Alpha" onClose={vi.fn()} />); await flush(); }
/** Scope the explorer to every project, through its scope chip's menu. */
async function allProjects() {
  fireEvent.click(screen.getByRole("button", { name: /^Scope:/ }));
  fireEvent.click(screen.getByRole("menuitemradio", { name: /All projects/ }));
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  api.list.mockReset().mockResolvedValue([node("new", "Note"), node("old")]);
  api.neighbors.mockReset().mockResolvedValue([]);
  api.subgraph.mockReset().mockResolvedValue({ nodes: [node("new")], edges: [] });
  api.recall.mockReset().mockResolvedValue(emptyReport);
  api.overview.mockReset().mockResolvedValue({ stats: { total: 0, decisions: 0, attempts: 0, notes: 0, files: 0, contributors: 0, latest: null } });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("contextual memory exploration", () => {
  it("defaults to a searchable workspace list and preserves server recency across kinds", async () => {
    await show();
    expect(screen.getByRole("tab", { name: "Knowledge" }).getAttribute("aria-selected")).toBe("true");
    expect(api.list).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1", query: null }), expect.any(String));
    expect(screen.getByRole("button", { name: /^Scope:/ }).textContent).toContain("Alpha");
    const rows = screen.getAllByRole("button", { name: /Knowledge/ });
    expect(rows.map((row) => row.textContent)).toEqual([expect.stringContaining("Knowledge new"), expect.stringContaining("Knowledge old")]);
    expect(screen.getByRole("searchbox", { name: "Search the graph" })).toBeTruthy();
    expect(api.subgraph).not.toHaveBeenCalled();
    await allProjects();
    expect(api.list).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceId: null }), expect.any(String));
  });

  it("remembers the chosen view without persisting another workspace's scope", async () => {
    await show();
    await allProjects();
    fireEvent.click(screen.getByRole("tab", { name: "Recall" })); await flush();
    cleanup(); await show();
    expect(screen.getByRole("tab", { name: "Recall" }).getAttribute("aria-selected")).toBe("true");
    expect(api.recall).toHaveBeenLastCalledWith("ws-1", 30, expect.any(String));
  });

  it("rejects an old query result even when it arrives during the new query's debounce", async () => {
    await show();
    const older = deferred<GraphKgNode[]>();
    api.list.mockImplementation(({ query }: { query: string }) => query === "old" ? older.promise : Promise.resolve([node("fresh")]));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "old" } }); await flush(220);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "fresh" } });
    await act(async () => { older.resolve([node("stale")]); });
    expect(screen.queryByText("Knowledge stale")).toBeNull();
    await flush(220);
    expect(screen.getByText("Knowledge fresh")).toBeTruthy();
    expect(screen.queryByText("Knowledge stale")).toBeNull();
  });

  it("discards stale neighbors and can open a connected record outside the current search", async () => {
    await show();
    const oldNeighbors = deferred<GraphNeighbor[]>();
    api.neighbors.mockImplementation((id: string) => id === "new" ? oldNeighbors.promise : Promise.resolve([{ node: node("connected"), edge_type: "ABOUT", direction: "out" }]));
    fireEvent.click(screen.getByRole("button", { name: /Knowledge new/ }));
    fireEvent.click(screen.getByRole("button", { name: /Knowledge old/ })); await flush();
    await act(async () => { oldNeighbors.resolve([{ node: node("stale"), edge_type: "ABOUT", direction: "out" }]); });
    expect(screen.queryByRole("button", { name: "Knowledge stale" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Knowledge connected" })); await flush();
    expect(screen.getByRole("heading", { name: "Knowledge connected" })).toBeTruthy();
    expect(screen.getByText("Body connected")).toBeTruthy();
  });

  it("links a selected decision to observed recall evidence without claiming lifetime use", async () => {
    api.recall.mockResolvedValue({ ...emptyReport, passes: [{ ts: new Date().toISOString(), workspace_id: "ws-1", agent_id: "swift-heron", facts: [{ id: "old", kind: "Decision", label: "Knowledge old", body: "Body old", archived: false, superseded: false }] }] });
    await show(); fireEvent.click(screen.getByRole("button", { name: /Knowledge old/ })); await flush();
    expect(screen.getByText(/Shown to swift-heron/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /See every time it was recalled/ })); await flush();
    expect(screen.getByText(/Recall evidence for/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show all recalls" })).toBeTruthy();
  });

  it("distinguishes offline from empty results and retries", async () => {
    api.list.mockRejectedValueOnce(new Error("offline")); await show();
    expect(screen.getByText(/graph engine isn't answering/)).toBeTruthy();
    api.list.mockResolvedValue([]);
    fireEvent.click(screen.getByRole("button", { name: "Try again" })); await flush();
    expect(screen.getByText(/Nothing recorded yet/)).toBeTruthy();
    expect(screen.queryByText(/graph engine isn't answering/)).toBeNull();
  });
});
