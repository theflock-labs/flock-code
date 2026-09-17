// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import NewWorkspaceDialog from "./NewWorkspaceDialog";
import { agentCliStatus, containerStatus, gitBranchOptions, worktreeSetupGet, worktreeSetupSet } from "../lib/tauri";
import { setDefaultBranchMode, setFetchBaseDefault } from "../lib/worktreeSettings";
import { getSecureByDefault } from "../lib/secureSettings";
import { readWorkspacePresets } from "../lib/workspacePresets";

vi.mock("../lib/tauri", () => ({
  agentCliStatus: vi.fn(), containerStatus: vi.fn(), egressPolicy: vi.fn(async () => ({ restrict: false })),
  gitBranchOptions: vi.fn(), worktreeSetupGet: vi.fn(), worktreeSetupSet: vi.fn(),
}));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn(async () => "/Users/test") }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));
vi.mock("../lib/baseFetch", () => ({ primeBaseFetch: vi.fn() }));

const readyAgents = { claude: true, codex: true, grok: true, opencode: true, pi: true };
const readyDocker = { available: true, daemon_running: true, image_ready: true };
const repo = { is_repo: true, current: "main", default_ref: "origin/main", local: [{ name: "main", worktree_path: null }], remote: ["origin/main"] };
const launchButton = () => screen.getByRole("button", { name: /^Launch/ }) as HTMLButtonElement;
async function settle() { await act(async () => { await vi.advanceTimersByTimeAsync(300); }); }
async function setup() {
  const confirm = vi.fn();
  render(<NewWorkspaceDialog cwd="/Users/test/repo" onConfirm={confirm} onCancel={vi.fn()} />);
  await settle();
  return confirm;
}

beforeEach(() => {
  vi.useFakeTimers();
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  vi.clearAllMocks();
  vi.mocked(agentCliStatus).mockResolvedValue(readyAgents);
  vi.mocked(containerStatus).mockResolvedValue(readyDocker);
  vi.mocked(gitBranchOptions).mockResolvedValue(repo);
  vi.mocked(worktreeSetupGet).mockResolvedValue({ unset: false, command: "npm ci", suggestion: "" });
  vi.mocked(worktreeSetupSet).mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("first-agent setup", () => {
  it("previews and launches an ordered mixed lineup without adding empty sessions", async () => {
    const confirm = await setup();
    fireEvent.click(screen.getByRole("radio", { name: "3 agents" }));
    fireEvent.change(screen.getByLabelText("Session 2 agent"), { target: { value: "codex" } });
    fireEvent.change(screen.getByLabelText("Session 3 agent"), { target: { value: "pi" } });
    expect(within(screen.getByRole("region", { name: "Launch summary" })).getAllByRole("combobox")).toHaveLength(3);
    fireEvent.click(screen.getByRole("radio", { name: "Shared checkout" }));
    fireEvent.click(launchButton());
    await settle();
    expect(confirm.mock.calls[0][0]).toMatchObject({ agents: ["claude", "codex", "pi"], plan: { mode: "current" } });
  });

  it("keeps existing seats when resizing and replaces the whole lineup from the agent picker", async () => {
    await setup();
    fireEvent.click(screen.getByRole("button", { name: /Mixed team/ }));
    expect(screen.getAllByRole("combobox", { name: /^Session/ })).toHaveLength(6);
    fireEvent.click(screen.getByRole("radio", { name: "5 agents" }));
    expect((screen.getByLabelText("Session 5 agent") as HTMLSelectElement).value).toBe("codex");
    fireEvent.click(screen.getByRole("radio", { name: "Codex, Ready" }));
    expect(screen.getAllByRole("combobox", { name: /^Session/ }).every((element) => (element as HTMLSelectElement).value === "codex")).toBe(true);
  });

  it("validates every agent in a preset and clears overrides when the lineup changes", async () => {
    vi.mocked(agentCliStatus).mockResolvedValue({ ...readyAgents, codex: false });
    await setup();
    fireEvent.click(screen.getByRole("button", { name: /Mixed team/ }));
    expect(launchButton().disabled).toBe(true);
    expect(screen.getByText(/Codex is missing/)).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: /custom wrapper/ }));
    expect(launchButton().disabled).toBe(false);
    fireEvent.change(screen.getByLabelText("Session 1 agent"), { target: { value: "pi" } });
    expect(launchButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "Claude Code, Ready" }));
    expect(launchButton().disabled).toBe(false);
  });

  it("saves and restores a mixed preset without launching from its name input", async () => {
    const confirm = await setup();
    fireEvent.click(screen.getByRole("radio", { name: "3 agents" }));
    fireEvent.change(screen.getByLabelText("Session 2 agent"), { target: { value: "codex" } });
    fireEvent.click(screen.getByRole("button", { name: /New preset/ }));
    fireEvent.change(screen.getByLabelText("Preset name"), { target: { value: "My team" } });
    fireEvent.keyDown(screen.getByLabelText("Preset name"), { key: "Enter" });
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save preset" }));
    expect(readWorkspacePresets()).toEqual([expect.objectContaining({ name: "My team", agents: ["claude", "codex", "claude"] })]);
    cleanup();
    await setup();
    fireEvent.click(screen.getByRole("button", { name: /^My team/ }));
    expect((screen.getByLabelText("Session 2 agent") as HTMLSelectElement).value).toBe("codex");
    fireEvent.click(screen.getByRole("button", { name: "Delete preset My team" }));
    expect(readWorkspacePresets()).toEqual([]);
    expect(screen.getAllByRole("combobox", { name: /^Session/ })).toHaveLength(3);
  });

  it("reports preset persistence failures without losing the current lineup", async () => {
    await setup();
    fireEvent.click(screen.getByRole("button", { name: /New preset/ }));
    fireEvent.change(screen.getByLabelText("Preset name"), { target: { value: "My team" } });
    vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("quota"); });
    fireEvent.click(screen.getByRole("button", { name: "Save preset" }));
    expect(screen.getByRole("alert").textContent).toContain("Couldn’t save this preset");
    expect(screen.queryByRole("button", { name: /^My team/ })).toBeNull();
    expect(launchButton().disabled).toBe(false);
  });

  it("keeps non-repositories on shared checkout and disables worktree isolation", async () => {
    vi.mocked(gitBranchOptions).mockResolvedValue({ ...repo, is_repo: false, local: [], remote: [], current: "", default_ref: "" });
    const confirm = await setup();
    expect((screen.getByRole("radio", { name: "New worktree per agent" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("radio", { name: "Shared checkout" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /Mixed team/ }));
    fireEvent.click(launchButton());
    await settle();
    expect(confirm.mock.calls[0][0].plan.mode).toBe("current");
  });

  it("launches one installed agent with visible effective defaults and hidden customization", async () => {
    vi.mocked(agentCliStatus).mockResolvedValue({ ...readyAgents, claude: false, grok: false, opencode: false });
    const confirm = await setup();
    expect(screen.queryByLabelText(/^Name/)).toBeNull();
    expect(screen.getByRole("radiogroup", { name: "How many" })).toBeTruthy();
    expect(screen.getByRole("radiogroup", { name: "Isolation" })).toBeTruthy();
    expect(screen.getByLabelText("Repository folder")).toBeTruthy();
    const summary = within(screen.getByRole("region", { name: "Launch summary" }));
    expect(summary.getByText(/1 Codex agent/)).toBeTruthy();
    expect(summary.getByText(/separate worktree on repo from origin\/main/)).toBeTruthy();
    expect(summary.getByText("npm ci")).toBeTruthy();
    expect(summary.getByText(/Fetches the base ref first/)).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /Secure mode/ })).toBeTruthy();
    fireEvent.click(launchButton());
    await settle();
    expect(confirm).toHaveBeenCalledWith({ name: "repo", agents: ["codex"], dir: "/Users/test/repo", plan: expect.objectContaining({ mode: "new", stem: "repo", baseRef: "origin/main", fetch: true }), secure: true });
  });

  it("preserves saved current-checkout and fetch defaults", async () => {
    setDefaultBranchMode("current");
    setFetchBaseDefault(false);
    const confirm = await setup();
    expect(screen.getByText(/Works in your current checkout on main/)).toBeTruthy();
    fireEvent.click(launchButton());
    await settle();
    expect(confirm.mock.calls[0][0].plan).toMatchObject({ mode: "current", fetch: false });
  });

  it("keeps custom names and larger layouts in the summary after Customize closes", async () => {
    const confirm = await setup();
    fireEvent.click(screen.getByRole("button", { name: /^Customize/ }));
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Fix authentication" } });
    fireEvent.click(screen.getByRole("radio", { name: "4 agents" }));
    fireEvent.click(screen.getByRole("button", { name: /^Hide customization/ }));
    expect(screen.getByText(/4 Claude Code agents in “Fix authentication”/)).toBeTruthy();
    fireEvent.click(launchButton());
    await settle();
    expect(confirm.mock.calls[0][0]).toMatchObject({ name: "Fix authentication", agents: ["claude", "claude", "claude", "claude"], dir: "/Users/test/repo" });
  });

  it("requires an explicit override for a missing CLI and clears it on selection changes", async () => {
    vi.mocked(agentCliStatus).mockResolvedValue({ ...readyAgents, claude: false });
    const confirm = await setup();
    fireEvent.click(screen.getByRole("radio", { name: "Claude Code, Missing" }));
    expect(launchButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /custom wrapper/ }));
    expect(launchButton().disabled).toBe(false);
    fireEvent.click(screen.getByRole("radio", { name: "Codex, Ready" }));
    fireEvent.click(screen.getByRole("radio", { name: "Claude Code, Missing" }));
    expect(launchButton().disabled).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("shows a failed CLI check as unknown and recovers in place", async () => {
    vi.mocked(agentCliStatus).mockRejectedValueOnce("shell unavailable");
    await setup();
    expect(screen.getByRole("radio", { name: "Claude Code, Couldn’t check" })).toBeTruthy();
    expect(launchButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Check agents again" }));
    await settle();
    expect(screen.getByRole("radio", { name: "Claude Code, Ready" })).toBeTruthy();
    expect(launchButton().disabled).toBe(false);
  });

  it("does not label an omitted CLI result as installed", async () => {
    vi.mocked(agentCliStatus).mockResolvedValue({ claude: true });
    await setup();
    fireEvent.click(screen.getByRole("radio", { name: "Grok, Couldn’t check" }));
    expect(launchButton().disabled).toBe(true);
  });

  it("rechecks Docker without reopening and preserves the secure preference", async () => {
    vi.mocked(containerStatus).mockResolvedValueOnce({ ...readyDocker, daemon_running: false });
    const confirm = await setup();
    expect(screen.getByText("Agents will run directly on your Mac")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Check Docker again" }));
    await settle();
    expect(screen.queryByText("Agents will run directly on your Mac")).toBeNull();
    fireEvent.click(launchButton());
    await settle();
    expect(confirm.mock.calls[0][0].secure).toBe(true);
    expect(getSecureByDefault()).toBe(true);
  });

  it("blocks a failed folder check rather than silently launching in a shared directory", async () => {
    vi.mocked(gitBranchOptions).mockRejectedValueOnce("folder unavailable");
    await setup();
    expect(launchButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Check folder again" }));
    await settle();
    expect(launchButton().disabled).toBe(false);
  });

  it("does not launch before setup saves, and offers recovery if saving fails", async () => {
    vi.mocked(worktreeSetupSet).mockRejectedValueOnce("read-only settings");
    const confirm = await setup();
    fireEvent.click(launchButton());
    await settle();
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("Couldn’t save the setup command");
    fireEvent.click(launchButton());
    await settle();
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("does not launch when Enter activates a recovery or Customize control", async () => {
    const confirm = await setup();
    fireEvent.keyDown(screen.getByRole("button", { name: /^Customize/ }), { key: "Enter" });
    fireEvent.keyDown(screen.getByRole("button", { name: "Check Docker again" }), { key: "Enter" });
    await settle();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("does not launch after Cancel while setup is still saving", async () => {
    let finishSave!: () => void;
    vi.mocked(worktreeSetupSet).mockReturnValue(new Promise<void>((resolve) => { finishSave = resolve; }));
    const confirm = await setup();
    fireEvent.click(launchButton());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await act(async () => { finishSave(); });
    expect(confirm).not.toHaveBeenCalled();
  });

  it("freezes the visible launch configuration during asynchronous setup saving", async () => {
    let finishSave!: () => void;
    vi.mocked(worktreeSetupSet).mockReturnValue(new Promise<void>((resolve) => { finishSave = resolve; }));
    const confirm = await setup();
    fireEvent.click(screen.getByRole("button", { name: /^Customize/ }));
    const summary = screen.getByRole("region", { name: "Launch summary" }).textContent;
    fireEvent.click(launchButton());
    expect((screen.getByRole("group", { name: "Workspace configuration" }) as HTMLFieldSetElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Repository folder"), { target: { value: "/different/repo" } });
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Changed name" } });
    fireEvent.click(screen.getByRole("radio", { name: "Codex, Ready" }));
    fireEvent.keyDown(screen.getByRole("radio", { name: "4 agents" }), { key: "ArrowRight" });
    fireEvent.click(screen.getByRole("checkbox", { name: /Secure mode/ }));
    expect(screen.getByRole("region", { name: "Launch summary" }).textContent).toBe(summary);
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(false);
    await act(async () => { finishSave(); });
    expect(confirm).toHaveBeenCalledWith({ name: "repo", agents: ["claude"], dir: "/Users/test/repo", plan: expect.objectContaining({ mode: "new" }), secure: true });
  });

  it("reopens required branch customization when the saved mode is existing", async () => {
    setDefaultBranchMode("existing");
    await setup();
    expect(screen.getByRole("button", { name: /^Hide customization/ })).toBeTruthy();
    expect(screen.getByText("Choose an existing branch in Customize.")).toBeTruthy();
    expect(launchButton().disabled).toBe(true);
  });

  it("does not claim Docker is missing when its status check fails", async () => {
    vi.mocked(containerStatus).mockRejectedValueOnce("daemon probe failed");
    await setup();
    expect(screen.getByText("Couldn’t check")).toBeTruthy();
    expect(screen.queryByText(/Install Docker Desktop to jail/)).toBeNull();
    expect(screen.getByText("Agents will run directly on your Mac")).toBeTruthy();
  });
});
