// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, act } from "@testing-library/react";

const RESULTS: Record<string, unknown> = {
  githubCheck: { connected: false, user: null, avatar_url: null },
  voiceGetEnabled: false, voiceModelStatus: { downloaded: false },
  voiceAvailableModels: [], voiceListInputDevices: [], voiceGetLanguage: "auto",
  agentHookStatus: false,
  githubOauthStart: { user_code: "UXREVIEW", verification_uri: "https://github.com/login/device", device_code: "test-device", interval: 5 },
  containerStatus: { available: false, daemon_running: false, image_ready: false },
  egressPolicy: { restrict: false, allow_file: "", defaults: [] },
};
vi.mock("../lib/tauri", async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(Object.keys(actual).map(name => [name, vi.fn(async () =>
    name === "githubOauthPoll" ? new Promise(() => {}) : name in RESULTS ? RESULTS[name] : name.startsWith("on") ? () => {} : undefined)]));
});
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "test") }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));
vi.mock("../lib/clipboard", () => ({ copyText: vi.fn(async () => {}) }));
vi.mock("./AccountSection", async () => {
  const { useState } = await import("react");
  return { default: function AccountDraft() {
    const [draft, setDraft] = useState("");
    return <input aria-label="Profile draft" value={draft} onChange={event => setDraft(event.target.value)} />;
  } };
});
vi.mock("./GraphSettingsSection", () => ({ default: () => <div>Test memory settings</div> }));
vi.mock("./TeamsSection", () => ({ default: () => <div>Test team settings</div> }));
vi.mock("./BudgetSection", () => ({ default: () => <div>Test budget settings</div> }));
vi.mock("./AgentUsageSection", () => ({ default: () => <div>Test usage</div> }));
vi.mock("./OpencodeUsageSection", () => ({ default: () => <div>Test usage</div> }));
vi.mock("./GrokUsageChip", () => ({ GrokUsageSection: () => <div>Test usage</div> }));
vi.mock("./ProvenanceSection", () => ({ default: () => <button>Export CSV</button> }));

import SettingsDialog from "./SettingsDialog";
import { installAgentHook } from "../lib/tauri";

const search = (query: string) => {
  const field = screen.getByRole("searchbox", { name: "Find a setting" });
  fireEvent.change(field, { target: { value: query } });
  return field;
};

async function open(onClose = vi.fn()) {
  render(<SettingsDialog onClose={onClose} onTestVoiceHud={vi.fn()} workspaces={[]} onSetWorkspaceBudget={vi.fn()} />);
  await act(async () => { await Promise.resolve(); });
  return onClose;
}

describe("Settings search navigation", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, String(value)),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
    });
    vi.clearAllMocks();
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("takes agent-status searches directly to hook controls without installing anything", async () => {
    await open();
    search("agent status");
    fireEvent.click(screen.getByRole("button", { name: "Live agent status Integrations" }));
    expect(screen.getByRole("tab", { name: "Integrations" }).getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement?.textContent).toBe("Install");
    expect(installAgentHook).not.toHaveBeenCalled();
    expect(document.querySelector(".settings-search-destination")?.getAttribute("data-setting")).toBe("agent-hooks");
  });

  it("Enter reveals app text controls, not the similarly styled voice hotkeys", async () => {
    await open();
    fireEvent.keyDown(search("app text"), { key: "Enter" });
    expect(document.activeElement?.textContent).toBe("Small");
    expect(document.querySelector(".settings-search-destination")?.getAttribute("data-setting")).toBe("app-text");
    expect(screen.getByRole("tab", { name: "Appearance" }).getAttribute("aria-selected")).toBe("true");
  });

  it("finds session export through history vocabulary", async () => {
    await open();
    fireEvent.keyDown(search("history"), { key: "Enter" });
    expect(document.activeElement?.textContent).toBe("Export CSV");
    expect(screen.getByRole("tab", { name: "Provenance" }).getAttribute("aria-selected")).toBe("true");
  });

  it("supports arrow navigation and clears search before Escape closes the dialog", async () => {
    const onClose = await open();
    const field = search("text size");
    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(document.activeElement?.className).toBe("settings-search-result");
    const first = document.activeElement!;
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).not.toBe(first);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect((field as HTMLInputElement).value).toBe("");
    expect(document.activeElement).toBe(field);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("preserves an unfinished child form when a search is cleared", async () => {
    await open();
    fireEvent.change(screen.getByRole("textbox", { name: "Profile draft" }), { target: { value: "Keep this draft" } });
    fireEvent.keyDown(search("theme"), { key: "Escape" });
    expect((screen.getByRole("textbox", { name: "Profile draft" }) as HTMLInputElement).value).toBe("Keep this draft");
  });

  it("focuses the explanation instead of a disabled system-controlled theme", async () => {
    localStorage.setItem("flock:theme-follow-system", "1");
    await open();
    fireEvent.keyDown(search("theme"), { key: "Enter" });
    expect(document.activeElement).toBe(screen.getByRole("group", { name: /Theme follows system/ }));
    expect((screen.getByRole("button", { name: "Nightfall" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps OAuth recovery available through search and prevents the tour from cancelling sign-in", async () => {
    const onClose = await open();
    fireEvent.click(screen.getByRole("tab", { name: "GitHub" }));
    fireEvent.click(screen.getByRole("button", { name: "Connect with GitHub" }));
    await act(async () => { await Promise.resolve(); });
    fireEvent.keyDown(search("feature tour"), { key: "Enter" });
    const tour = screen.getByRole("button", { name: "Open feature tour" });
    expect((tour as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(tour);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Return to GitHub" }));
    expect(screen.getByText("UXREVIEW")).toBeTruthy();
    search("text size");
    fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
    expect(screen.queryByRole("button", { name: "Cancel sign-in" })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });
});
