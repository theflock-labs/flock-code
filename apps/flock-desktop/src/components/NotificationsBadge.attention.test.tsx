// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import NotificationsBadge, { AttentionPanel } from "./NotificationsBadge";
import { attentionDuration, collectAttentionAgents, type AttentionAgent } from "../lib/agentMonitoring";
import type { Workspace } from "../types";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

// Node's global storage shadows jsdom on some versions; use the same browser
// storage double as App.smoke.test rather than relying on the host runtime.
const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, String(value)),
  clear: () => store.clear(),
});

const agents: AttentionAgent[] = [{
  workspaceId: "repo-a", workspaceName: "Project A", paneId: "pane-a", name: "Pluto",
  task: "Review checkout edge cases", status: "blocked", statusChangedAt: 1_800_000_000_000,
}, {
  workspaceId: "repo-b", workspaceName: "Project B", paneId: "pane-b", name: "Hazel",
  status: "awaiting_input",
}];

afterEach(() => { cleanup(); localStorage.clear(); vi.useRealTimers(); });

describe("live task context and pinned attention list", () => {
  it("shows known task, honest status and duration, and navigates to the owning pane", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_120_000);
    const onOpenPane = vi.fn();
    const onUnpin = vi.fn();
    const view = render(<AttentionPanel agents={agents} onOpenPane={onOpenPane} onUnpin={onUnpin} />);
    expect(screen.getByText("Review checkout edge cases")).toBeTruthy();
    expect(screen.getByText("Pluto · Project A")).toBeTruthy();
    expect(screen.getByText("Blocked")).toBeTruthy();
    expect(screen.getByText("· 2m")).toBeTruthy();
    expect(screen.getByText("Open terminal to inspect the blocker")).toBeTruthy();
    const missingTimestamp = screen.getByRole("button", { name: /Hazel needs your attention/ });
    expect(missingTimestamp.querySelector(".attention-row-duration")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Review checkout edge cases/ }));
    expect(onOpenPane).toHaveBeenCalledWith("repo-a", "pane-a");
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText("· 3m")).toBeTruthy();
    view.rerender(<AttentionPanel agents={[]} onOpenPane={onOpenPane} onUnpin={onUnpin} />);
    expect(screen.getByText("No agents waiting on you.")).toBeTruthy();
    expect(screen.queryByText("Review checkout edge cases")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Unpin list" }));
    expect(onUnpin).toHaveBeenCalledOnce();
  });

  it("lets the existing notification popover pin its live attention list", () => {
    const onPin = vi.fn();
    render(<NotificationsBadge checks={null} notifications={[]} attentionAgents={agents}
      agents={{ total: 2, working: 0 }} onOpenPr={() => {}} onOpenPane={() => {}}
      attentionPinned={false} onToggleAttentionPin={onPin} />);
    fireEvent.click(screen.getByRole("button", { name: /2 agents need attention/ }));
    expect(screen.getByText("Review checkout edge cases")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pin list" }));
    expect(onPin).toHaveBeenCalledOnce();
    expect(screen.queryByText("Review checkout edge cases")).toBeNull();
  });

  it("derives attention from live status and never invents a timestamp", () => {
    const workspace = { id: "ws", name: "Work", panes: [
      { id: "waiting", kind: "claude", status: "awaiting_input", intent: "  Repair checkout  " },
      { id: "working", kind: "codex", status: "working", attention: true },
      { id: "blocked", kind: "codex", status: "blocked", statusChangedAt: 1234 },
    ] } as Workspace;
    expect(collectAttentionAgents([workspace])).toEqual([
      { workspaceId: "ws", workspaceName: "Work", paneId: "waiting", name: "claude", task: "Repair checkout", status: "awaiting_input", statusChangedAt: undefined },
      { workspaceId: "ws", workspaceName: "Work", paneId: "blocked", name: "codex", task: undefined, status: "blocked", statusChangedAt: 1234 },
    ]);
    for (const since of [undefined, NaN, Infinity, 0, -1, 300_000]) {
      expect(attentionDuration(since, 200_000)).toBeNull();
    }
  });
});
