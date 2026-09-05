// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import QuickActions from "./QuickActions";
import { agentHookStatus, installAgentHook, voiceGetEnabled } from "../lib/tauri";
import { markFirstAgentLaunched, OPEN_FEATURE_TOUR_EVENT } from "../lib/onboarding";

vi.mock("../lib/tauri", () => ({ agentHookStatus: vi.fn(), installAgentHook: vi.fn(), voiceGetEnabled: vi.fn() }));
const flush = async () => { await act(async () => { await Promise.resolve(); }); };
function panel() { return render(<QuickActions onSettings={vi.fn()} onNewWorkspace={vi.fn()} onOpenPrManager={vi.fn()} githubConnected={false} prCount={0} />); }
beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  vi.clearAllMocks();
  vi.mocked(agentHookStatus).mockResolvedValue(false);
  vi.mocked(voiceGetEnabled).mockResolvedValue(false);
  vi.mocked(installAgentHook).mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("setup readiness", () => {
  it("never marks failed hook or voice probes as ready and allows a recheck", async () => {
    vi.mocked(agentHookStatus).mockRejectedValueOnce("hook read failed");
    vi.mocked(voiceGetEnabled).mockRejectedValueOnce("voice read failed");
    panel();
    await flush();
    expect(screen.queryByText("Live agent status on")).toBeNull();
    expect(screen.queryByText("Voice dictation on")).toBeNull();
    expect(screen.getAllByText("Couldn’t check")).toHaveLength(2);
    vi.mocked(agentHookStatus).mockResolvedValue(true);
    fireEvent.click(screen.getAllByRole("button", { name: "Check again" })[0]);
    await flush();
    expect(screen.getByText("Live agent status on")).toBeTruthy();
  });

  it("shows pending checks without a completed checkmark", () => {
    vi.mocked(agentHookStatus).mockReturnValue(new Promise(() => {}));
    vi.mocked(voiceGetEnabled).mockReturnValue(new Promise(() => {}));
    panel();
    expect(screen.getByRole("button", { name: /Checking live agent status/ }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByText("Ready")).toBeNull();
  });

  it("reports installation failures inline and verifies readiness after retry", async () => {
    vi.mocked(installAgentHook).mockRejectedValueOnce("permission denied");
    panel();
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Turn on live agent status/ }));
    await flush();
    expect(screen.getByRole("alert").textContent).toContain("permission denied");
    vi.mocked(agentHookStatus).mockResolvedValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Retry installation" }));
    await flush();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Live agent status on")).toBeTruthy();
    expect(installAgentHook).toHaveBeenCalledTimes(2);
  });

  it("offers the feature tour after successful first launch without interrupting work", async () => {
    const openTour = vi.fn();
    window.addEventListener(OPEN_FEATURE_TOUR_EVENT, openTour);
    panel();
    await flush();
    expect(screen.queryByText("Explore the feature tour")).toBeNull();
    act(() => markFirstAgentLaunched());
    expect(openTour).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Explore the feature tour/ }));
    expect(openTour).toHaveBeenCalledTimes(1);
    window.removeEventListener(OPEN_FEATURE_TOUR_EVENT, openTour);
  });

  it("does not fail a successful agent launch when browser storage is unavailable", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("storage blocked"); },
      setItem: () => { throw new Error("storage blocked"); },
    });
    expect(() => markFirstAgentLaunched()).not.toThrow();
  });
});
