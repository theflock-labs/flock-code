// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, fireEvent, waitFor } from "@testing-library/react";

// Everything below the mocks is the real App, mounted the way the app mounts
// it. It is a smoke test in the literal sense — it does not assert
// on behaviour so much as prove the thing comes up, restores a workspace,
// paints its shell, and survives a pane arriving. That is the class of break
// that otherwise only shows up after a release.
//
// Mocked at the boundary and no deeper: the Tauri IPC layer, the auth session,
// and the two components that need a real terminal. Everything else runs.

const WORKSPACE = {
  id: "ws-1",
  name: "test-workspace",
  repo_path: "/tmp/repo",
  branch: "main",
  created_at: 1_700_000_000,
};

/** The one saved pane the restore path will re-spawn. */
const SAVED_STATE = JSON.stringify({
  layoutTree: { type: "leaf", paneId: "pane-1" },
  panes: [{ id: "pane-1", cmd: "claude", args: [], cwd: "/tmp/repo", displayName: "agent one" }],
  agentKind: "claude",
  focusedPaneId: "pane-1",
});

// Named results for the handful of calls whose shape App actually depends on.
// Everything else falls through to the convention below, which is what keeps
// this from being a 185-line mock that rots on the next command added.
const RESULTS: Record<string, unknown> = {
  listWorkspaces: [WORKSPACE],
  getCwd: "/tmp/repo",
  restoreWorkspace: SAVED_STATE,
  spawnPane: { id: "pane-1", workspace_id: WORKSPACE.id, kind: "claude", status: "idle", rows: 24, cols: 80 },
  getPersistedPaneBuffer: [],
  containerStatus: { available: false, daemon_running: false, image_ready: false },
  hasGithubToken: false,
  getAgentPref: "claude",
  claudeCodeUsage: { available: false },
  agentHookStatus: { claude: false, codex: false },
  // Resolves, so the caller's .catch fallback never runs and it reads .downloaded
  // off whatever comes back.
  voiceModelStatus: { downloaded: false },
  voiceGetEnabled: false,
  graphStatus: { running: false },
  prWatchGetConfig: { repos: [] },
  mergeQueueList: [],
  queueList: [],
};

/**
 * One stub for all 185 IPC wrappers, keyed off the real module's export list so
 * a command added to tauri.ts is stubbed here automatically instead of failing
 * this file. Return values follow the convention the callers assume:
 *  - `on*` are event subscriptions, so they resolve to an unlisten function
 *  - `list*` resolve to arrays, because callers .map over them unguarded
 *  - the rest resolve undefined unless RESULTS names them
 */
vi.mock("./lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mock: Record<string, unknown> = {};
  // Synchronous lookups of what the backend's events said: every agent has
  // started, and none has reported a status since its spawn.
  const sync: Record<string, (...a: unknown[]) => unknown> = {
    hasAgentStarted: () => true,
    latestAgentStatus: () => undefined,
  };
  for (const name of Object.keys(actual)) {
    if (name in sync) { mock[name] = vi.fn(sync[name]); continue; }
    mock[name] = vi.fn(async () => {
      if (name in RESULTS) return RESULTS[name];
      if (name.startsWith("on")) return () => {};
      if (name.startsWith("list")) return [];
      return undefined;
    });
  }
  return mock;
});
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined), Channel: class {} }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ WebviewWindow: class { static getCurrent() { return { label: "main" }; } } }));
// Both read window.__TAURI_INTERNALS__ at call time, which only the real
// runtime provides — file drop and window metadata are not what this covers.
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: vi.fn(async () => () => {}) }),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: "main",
    listen: vi.fn(async () => () => {}),
    onFocusChanged: vi.fn(async () => () => {}),
    isFocused: vi.fn(async () => true),
    setTitle: vi.fn(async () => {}),
  }),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}), openPath: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => null), message: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn(async () => null) }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn(async () => {}) }));
// SettingsDialog reads the bundle version on mount, and ⌘, opens it for real.
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "0.0.0-test") }));

// Signed in with a claimed handle, which is the hard gate in front of the
// cockpit — without this the app legitimately renders SignInGate instead.
// Mutable so one test can drive the signed-out → signed-in transition, which
// is the only render pair that can catch a hook declared below the gate.
const ID = {
  idProfile: { id: "p1", handle: "tester", display_name: "Tester", avatar_url: null } as
    | { id: string; handle: string | null; display_name: string; avatar_url: string | null }
    | null,
  idChecked: true,
};
const NO_FRIENDS: never[] = [];
vi.mock("./lib/useFlockId", () => ({
  useFlockIdentity: () => ({
    get idProfile() { return ID.idProfile; },
    get idChecked() { return ID.idChecked; },
    refreshIdentity: vi.fn(),
    friends: NO_FRIENDS,
    setFriends: vi.fn(),
    addFriend: vi.fn(),
    acceptFriend: vi.fn(),
    removeFriend: vi.fn(),
  }),
}));

// Presence would open an Ably socket; here it is a connection that never comes.
vi.mock("./lib/presence", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  connectPresence: () => new Promise(() => {}),
  disconnectPresence: () => {},
  updateAgentCount: async () => {},
  updateFriends: () => {},
  resyncFriendPresence: async () => {},
}));

// Signed out at the Supabase layer and never configured, so nothing here opens
// a socket. Spread the real module first: it exports the subscribe* helpers
// several components call on mount, and listing them by hand only holds until
// the next one is added.
vi.mock("./lib/flockId", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isIdConfigured: () => false,
  getSession: vi.fn(async () => null),
  supabase: () => { throw new Error("flock ID is not configured"); },
  onAuthChange: () => () => {},
  subscribeFriendships: () => () => {},
  subscribeFriendEvents: () => () => {},
  subscribeReleaseAnnouncements: () => () => {},
  getMyProfile: vi.fn(async () => null),
  listIdFriends: vi.fn(async () => []),
  signOut: vi.fn(async () => {}),
}));


// xterm needs a real canvas and a measured DOM; neither exists in jsdom, and
// the terminal is not what this test is about.
vi.mock("./components/Terminal", () => ({
  default: ({ paneId }: { paneId: string }) => <div data-testid={`term-${paneId}`} />,
}));

import App from "./App";
import { OPEN_GRAPH_EXPLORER_EVENT } from "./lib/graphSettings";
import { agentCliStatus, createWorkspace, gitBranchOptions, restoreWorkspace, spawnPane, worktreeSetupGet } from "./lib/tauri";

// Node exposes its own half-implemented localStorage global that shadows
// jsdom's, so supply a real one rather than depending on which wins.
const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
});

beforeEach(() => {
  localStorage.clear();
  // One AI title per thread runs `claude -p`; not what these tests are about.
  localStorage.setItem("flock:ai-titles", "0");
  // jsdom has neither, and both are called during layout.
  window.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  window.matchMedia ??= ((q: string) => ({
    matches: false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  RESULTS.listWorkspaces = [WORKSPACE];
  RESULTS.restoreWorkspace = SAVED_STATE;
  delete RESULTS.graphListNodes;
});

/** Mount and let every on-mount effect and its promises settle. */
async function mount() {
  const utils = render(<App />);
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return utils;
}

const cmd = (key: string, over: KeyboardEventInit = {}) =>
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, metaKey: true, bubbles: true, ...over }));
  });

describe("App smoke", () => {
  it("mounts the shell: a sidebar and a main panel, each a window handle", async () => {
    const { container } = await mount();
    expect(container.querySelector(".v2-app")).toBeTruthy();
    // On macOS this attribute is the only thing that moves the window; the
    // overlay title bar draws the window buttons over the sidebar's head.
    expect(container.querySelector(".v2-side-head")?.hasAttribute("data-tauri-drag-region")).toBe(true);
    expect(container.querySelector(".v2-main .v2-head")?.hasAttribute("data-tauri-drag-region")).toBe(true);
  });

  it("restores the saved project and lists it with its thread", async () => {
    await mount();
    expect(screen.getByRole("region", { name: WORKSPACE.name })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^agent one/ })).toBeTruthy();
  });

  it("re-spawns the saved pane rather than dropping it", async () => {
    await mount();
    expect(spawnPane).toHaveBeenCalled();
  });

  it("does not trip the error boundary", async () => {
    const { container } = await mount();
    expect(container.querySelector(".crash")).toBeNull();
  });

  it("survives a project with no saved state at all", async () => {
    RESULTS.restoreWorkspace = null;
    const { container } = await mount();
    expect(container.querySelector(".v2-app")).toBeTruthy();
    expect(container.querySelector(".crash")).toBeNull();
    // Nothing to show yet, so the main panel offers a new agent.
    expect(screen.getByRole("heading", { name: "What should we work on?" })).toBeTruthy();
  });

  it("launches the exact mixed lineup from New project with options", async () => {
    vi.mocked(agentCliStatus).mockResolvedValueOnce({ claude: true, codex: true, pi: true, grok: true, opencode: true });
    vi.mocked(gitBranchOptions).mockResolvedValueOnce({ is_repo: true, current: "main", default_ref: "main", local: [{ name: "main", worktree_path: null }], remote: [] });
    vi.mocked(worktreeSetupGet).mockResolvedValue({ unset: false, command: "", suggestion: "" });
    vi.mocked(createWorkspace).mockResolvedValueOnce({ ...WORKSPACE, id: "ws-mixed", name: "repo" });
    await mount();
    await cmd("n", { shiftKey: true });
    await screen.findByRole("dialog", { name: "New project" });
    fireEvent.click(screen.getByRole("radio", { name: "3 agents" }));
    fireEvent.change(screen.getByLabelText("Session 2 agent"), { target: { value: "codex" } });
    fireEvent.change(screen.getByLabelText("Session 3 agent"), { target: { value: "pi" } });
    fireEvent.click(screen.getByRole("radio", { name: "Shared checkout" }));
    await waitFor(() => expect((screen.getByRole("button", { name: /^Launch 3 agents/ }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: /^Launch 3 agents/ }));
    await waitFor(() => expect(vi.mocked(spawnPane).mock.calls.filter(([input]) => input.workspaceId === "ws-mixed")).toHaveLength(3));
    const launches = vi.mocked(spawnPane).mock.calls.map(([input]) => input).filter((input) => input.workspaceId === "ws-mixed");
    expect(launches.map((input) => input.cmd)).toEqual(["claude", "codex", "pi"]);
    expect(launches[0].args).toContain("--session-id");
    expect(launches[1].args).not.toContain("--session-id");
    expect(launches[2].args).not.toContain("--session-id");
    expect(launches.every((input) => input.cwd === "/tmp/repo" && !input.secure)).toBe(true);
  });
});

describe("v2 threads", () => {
  it("lists a sleeping project's threads before waking it, and wakes it on click", async () => {
    const other = { ...WORKSPACE, id: "ws-2", name: "wink", repo_path: "/tmp/wink" };
    RESULTS.listWorkspaces = [WORKSPACE, other];
    vi.mocked(restoreWorkspace).mockImplementation(async (id: string) =>
      id === "ws-2"
        ? JSON.stringify({
            agentKind: "claude",
            tabs: [{ id: "t-docs", name: "Docs", renamed: true, layoutTree: { type: "leaf", paneId: "old-1" }, focusedPaneId: "old-1", zoomedPaneId: null }],
            focusedTabId: "t-docs",
            panes: [{ id: "old-1", cmd: "claude", args: [], cwd: "/tmp/wink", displayName: "Hazel" }],
          })
        : SAVED_STATE,
    );
    await mount();
    // Listed from the saved state, and not started.
    expect(vi.mocked(spawnPane).mock.calls.some(([i]) => i.workspaceId === "ws-2")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /^Docs/ }));
    await waitFor(() => expect(vi.mocked(spawnPane).mock.calls.some(([i]) => i.workspaceId === "ws-2")).toBe(true));
    vi.mocked(restoreWorkspace).mockReset();
  });

  it("starts a thread from the composer, named after its task at once", async () => {
    await mount();
    await cmd("n");
    const box = await screen.findByRole("textbox", { name: "Task for the new agent" });
    fireEvent.change(box, { target: { value: "fix the login redirect on safari" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(vi.mocked(spawnPane).mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(await screen.findByRole("button", { name: /^Fix the login redirect on safari/ })).toBeTruthy();
    const last = vi.mocked(spawnPane).mock.calls.at(-1)![0];
    expect(last.workspaceId).toBe(WORKSPACE.id);
    expect(last.cmd).toBe("claude");
  });

  // Settings is a page of the main panel: with the sidebar hidden it sits under
  // the window's buttons, and once had no way back to the sidebar at all.
  it("keeps a way back to the sidebar on the settings page", async () => {
    await mount();
    await cmd("\\");
    await cmd(",");
    fireEvent.click(await screen.findByRole("button", { name: "Show sidebar" }));
    expect(await screen.findByRole("button", { name: "Hide sidebar" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show sidebar" })).toBeNull();
  });

  // The composer shows two chips, where and who. Model and effort are one
  // step into the agent's menu (the menus used to throw on click), the chip
  // names them once chosen, the choices reach the agent as its own flags, and
  // the task rides on the command line after `--` instead of being typed into
  // whatever the agent shows first — a typed Enter once answered Claude Code's
  // "trust this folder?" with "No".
  it("starts an agent with the chosen model and effort, and its task on the command line", async () => {
    await mount();
    await cmd("n");
    const box = await screen.findByRole("textbox", { name: "Task for the new agent" });
    const agent = () => screen.getByRole("button", { name: /^Agent:/ });
    expect(agent().getAttribute("aria-label")).toBe("Agent: Claude Code");
    expect(screen.queryByRole("button", { name: /^Model/ })).toBeNull();
    fireEvent.click(agent());
    expect(await screen.findByRole("menu", { name: "Agent" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: /^Model/ }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /^Opus/ }));
    fireEvent.click(agent());
    fireEvent.click(await screen.findByRole("menuitem", { name: /^Effort/ }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /^High/ }));
    expect(agent().getAttribute("aria-label")).toBe("Agent: Claude Code · Opus · High");
    fireEvent.change(box, { target: { value: "make the docs page searchable" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(vi.mocked(spawnPane).mock.calls.length).toBeGreaterThanOrEqual(2));
    const args = vi.mocked(spawnPane).mock.calls.at(-1)![0].args;
    expect(args).toEqual(expect.arrayContaining(["--model", "opus", "--effort", "high"]));
    expect(args.slice(-2)).toEqual(["--", "make the docs page searchable"]);
    expect(args.indexOf("--model")).toBeLessThan(args.indexOf("--"));
  });

  it("opens a waiting agent hidden behind a zoomed one, and acknowledges it", async () => {
    RESULTS.restoreWorkspace = JSON.stringify({
      agentKind: "claude", focusedPaneId: "pane-a", zoomedPaneId: "pane-a",
      layoutTree: { type: "split", dir: "horizontal", ratio: 0.5,
        first: { type: "leaf", paneId: "pane-a" }, second: { type: "leaf", paneId: "pane-b" } },
      panes: [
        { id: "pane-a", cmd: "claude", args: [], cwd: "/tmp/repo", displayName: "Pluto" },
        { id: "pane-b", cmd: "claude", args: [], cwd: "/tmp/repo", displayName: "Hazel", intent: "Fix checkout validation" },
      ],
    });
    vi.mocked(spawnPane)
      .mockResolvedValueOnce({ id: "live-a", workspace_id: WORKSPACE.id, kind: "claude", status: "working", rows: 24, cols: 80 })
      .mockResolvedValueOnce({ id: "live-b", workspace_id: WORKSPACE.id, kind: "claude", status: "awaiting_input", rows: 24, cols: 80 });
    const geometry = vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, right: 900, bottom: 700, width: 900, height: 700, toJSON: () => ({}),
    });
    const tauri = await import("./lib/tauri");
    try {
      await mount();
      await waitFor(() => expect(screen.getByTestId("term-live-a")).toBeTruthy());
      expect(screen.queryByTestId("term-live-b")).toBeNull();
      // The sidebar says someone is waiting; following it lands on them.
      fireEvent.click(screen.getByRole("button", { name: /Waiting on you/ }));
      await waitFor(() => expect(screen.getByTestId("term-live-b")).toBeTruthy());
      expect(screen.queryByTestId("term-live-a")).toBeNull();
      expect(tauri.ackPaneAttention).toHaveBeenCalledWith("live-b");
      expect(screen.getByRole("button", { name: "Show all agents" })).toBeTruthy();
    } finally {
      geometry.mockRestore();
    }
  });

  // The performance property v2 is built on: a thread you are not looking at
  // has no terminal in the webview — no xterm, no output stream, nothing to
  // repaint — however many agents it runs. Switching mounts the new thread's
  // terminals and lets the old ones go.
  it("mounts terminals only for the thread on screen", async () => {
    RESULTS.restoreWorkspace = JSON.stringify({
      agentKind: "claude",
      focusedTabId: "t-a",
      tabs: [
        { id: "t-a", name: "Alpha", renamed: true, layoutTree: { type: "leaf", paneId: "pane-a" }, focusedPaneId: "pane-a", zoomedPaneId: null },
        { id: "t-b", name: "Beta", renamed: true, layoutTree: { type: "leaf", paneId: "pane-b" }, focusedPaneId: "pane-b", zoomedPaneId: null },
      ],
      panes: [
        { id: "pane-a", cmd: "claude", args: [], cwd: "/tmp/repo", displayName: "Pluto" },
        { id: "pane-b", cmd: "claude", args: [], cwd: "/tmp/repo", displayName: "Hazel" },
      ],
    });
    vi.mocked(spawnPane)
      .mockResolvedValueOnce({ id: "live-a", workspace_id: WORKSPACE.id, kind: "claude", status: "idle", rows: 24, cols: 80 })
      .mockResolvedValueOnce({ id: "live-b", workspace_id: WORKSPACE.id, kind: "claude", status: "idle", rows: 24, cols: 80 });
    const geometry = vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, right: 900, bottom: 700, width: 900, height: 700, toJSON: () => ({}),
    });
    try {
      await mount();
      await waitFor(() => expect(screen.getByTestId("term-live-a")).toBeTruthy());
      expect(screen.queryByTestId("term-live-b")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: /^Beta/ }));
      await waitFor(() => expect(screen.getByTestId("term-live-b")).toBeTruthy());
      expect(screen.queryByTestId("term-live-a")).toBeNull();
      expect(document.querySelectorAll("[data-testid^='term-']")).toHaveLength(1);
    } finally {
      geometry.mockRestore();
    }
  });

  it("opens knowledge in the originating workspace, including explicit all-workspace scope", async () => {
    RESULTS.graphListNodes = [];
    await mount();
    const tauri = await import("./lib/tauri");
    act(() => window.dispatchEvent(new CustomEvent(OPEN_GRAPH_EXPLORER_EVENT, { detail: { workspaceId: "origin-workspace" } })));
    await waitFor(() => expect(tauri.graphListNodes).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "origin-workspace" }), expect.any(String)));
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    act(() => window.dispatchEvent(new CustomEvent(OPEN_GRAPH_EXPLORER_EVENT, { detail: { workspaceId: null } })));
    await waitFor(() => expect(tauri.graphListNodes).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceId: null }), expect.any(String)));
  });
});

// ─── The command bar's reach ─────────────────────────────────────────────────

const palette = () => document.querySelector(".cmdk-panel");

/** ⌘⇧P opens the cheapest dialog for the harness; which one does not matter. */
const openADialog = async () => {
  await cmd("p", { shiftKey: true });
  await waitFor(() => expect(document.querySelector(".modal-overlay")).toBeTruthy());
};

describe("App ⌘K", () => {
  it("opens the command bar, and closes it on a second press", async () => {
    await mount();
    await cmd("k");
    expect(palette()).toBeTruthy();
    await cmd("k");
    expect(palette()).toBeNull();
  });

  it("opens over an already-open dialog, replacing it", async () => {
    await mount();
    await openADialog();
    await cmd("k");
    expect(palette()).toBeTruthy();
    expect(document.querySelector(".modal-overlay")).toBeNull();
  });

  it("binds ⌘, to Settings, as a page of the main panel", async () => {
    await mount();
    await cmd(",");
    await waitFor(() => expect(document.querySelector(".v2-main > .modal-overlay .settings-modal")).toBeTruthy());
  });
});

describe("App hook order", () => {
  afterEach(() => { ID.idChecked = true; ID.idProfile = { id: "p1", handle: "tester", display_name: "Tester", avatar_url: null }; });

  /* The sign-in gate is an early return in a component with a great many
   * hooks; the signed-out → signed-in transition is the only render pair that
   * catches a hook declared below it. */
  it("survives the signed-out to signed-in transition", async () => {
    ID.idChecked = false;
    ID.idProfile = null;
    const { container, rerender } = render(<App />);
    await act(async () => { await Promise.resolve(); });
    expect(container.querySelector(".v2-app")).toBeNull();

    ID.idChecked = true;
    ID.idProfile = { id: "p1", handle: "tester", display_name: "Tester", avatar_url: null };
    await act(async () => { rerender(<App />); await Promise.resolve(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    expect(container.querySelector(".v2-app")).toBeTruthy();
    expect(container.querySelector(".crash")).toBeNull();
  });
});
