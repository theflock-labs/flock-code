// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen, act, fireEvent } from "@testing-library/react";
import type { GraphStatus } from "../lib/tauri";

// This wizard is the only thing standing between a new user and a graph that
// silently does nothing, and it has failed at that twice. These pin the two
// failures, both reported as "I pressed the button and nothing happened":
//
//  1. Docker installed-but-stopped and Docker not-installed were one boolean,
//     so a machine with no Docker at all was told to start Docker.
//  2. A retry that failed again rendered byte-identical text, which is
//     indistinguishable from a dead button.
//
// Plus the thing the old guide never said at all: secure mode strips the graph
// tools from every pane, and secure mode is the default wherever Docker runs —
// i.e. on every machine that reaches this screen successfully.

const status = vi.fn<(...a: unknown[]) => Promise<GraphStatus>>();
const up = vi.fn<() => Promise<void>>();

vi.mock("../lib/tauri", () => ({
  graphStatus: (...a: unknown[]) => status(...a),
  graphUp: () => up(),
}));
vi.mock("../lib/graphSettings", () => ({
  getGraphUrl: () => "postgresql://flock:flock@127.0.0.1:15432/flock_kg",
  getGraphEnabled: () => true,
  setGraphEnabled: () => {},
  isTeamGraph: () => false,
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));
vi.mock("../lib/clipboard", () => ({ copyText: vi.fn(async () => {}) }));

import GraphOnboardingDialog from "./GraphOnboardingDialog";

const st = (over: Partial<GraphStatus> = {}): GraphStatus => ({
  docker_cli: "/usr/local/bin/docker",
  docker_ready: false,
  container_running: false,
  db_reachable: false,
  mcp_binary: "/Applications/flock.app/Contents/MacOS/flock-mcp",
  kg_url: "postgresql://flock:flock@127.0.0.1:15432/flock_kg",
  ...over,
});

/** Render and advance to the engine step, letting the initial status poll land. */
async function atEngineStep() {
  render(<GraphOnboardingDialog onClose={() => {}} />);
  await act(async () => { await Promise.resolve(); });
  fireEvent.click(screen.getByText("Continue"));
  await act(async () => { await Promise.resolve(); });
}

describe("GraphOnboardingDialog", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    status.mockReset();
    up.mockReset();
  });
  afterEach(() => { vi.useRealTimers(); cleanup(); });

  it("tells a machine with no Docker to install it, not to start it", async () => {
    status.mockResolvedValue(st({ docker_cli: null }));
    await atEngineStep();

    expect(screen.getByText("not installed")).toBeTruthy();
    expect(screen.getByText(/isn't installed on this machine/)).toBeTruthy();
    // The hint that used to be shown here and is useless without Docker.
    expect(screen.queryByText(/Launch Docker Desktop and wait/)).toBeNull();
  });

  it("tells a machine with Docker stopped to start it, not to install it", async () => {
    status.mockResolvedValue(st({ docker_cli: "/usr/local/bin/docker" }));
    await atEngineStep();

    expect(screen.getByText("installed, not running")).toBeTruthy();
    expect(screen.getByText(/Launch Docker Desktop and wait/)).toBeTruthy();
    expect(screen.queryByText(/isn't installed on this machine/)).toBeNull();
  });

  it("makes a second failing attempt distinguishable from a dead button", async () => {
    status.mockResolvedValue(st({ docker_ready: true }));
    up.mockRejectedValue("Docker is installed but its daemon isn't answering.");
    await atEngineStep();

    fireEvent.click(screen.getByRole("button", { name: "Start the engine" }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByText("attempt 1 failed")).toBeTruthy();
    // The label itself changes too, so the control reads as retryable.
    const retry = screen.getByRole("button", { name: "Try again" });

    fireEvent.click(retry);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByText("attempt 2 failed")).toBeTruthy();
    expect(up).toHaveBeenCalledTimes(2);
  });

  it("re-reads status the moment a start attempt finishes", async () => {
    status.mockResolvedValue(st({ docker_ready: true }));
    up.mockResolvedValue(undefined);
    await atEngineStep();
    const before = status.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "Start the engine" }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    // Not left to the 2s poll: the pills must reflect the click immediately.
    expect(status.mock.calls.length).toBeGreaterThan(before);
  });

  it("warns that secure mode strips the graph tools", async () => {
    status.mockResolvedValue(st({ docker_ready: true, container_running: true, db_reachable: true }));
    await atEngineStep();
    fireEvent.click(screen.getByText("Next"));
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByText(/Secure mode turns the graph tools off/)).toBeTruthy();
    // And that flock's own panes need no manual MCP registration — the old
    // guide presented that step as required for everyone.
    expect(screen.getByText(/wired up automatically/)).toBeTruthy();
  });
});
