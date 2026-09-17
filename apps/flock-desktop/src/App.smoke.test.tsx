// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, fireEvent, waitFor } from "@testing-library/react";

// The cockpit had no test that ever rendered it. Everything below the mocks is
// the real App: 4,000 lines of hooks, effects and layout, mounted the way the
// app mounts it. It is a smoke test in the literal sense — it does not assert
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
  for (const name of Object.keys(actual)) {
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
vi.mock("./lib/useFlockId", () => ({
  useFlockId: () => ({
    get idProfile() { return ID.idProfile; },
    get idChecked() { return ID.idChecked; },
    friends: [],
    setFriends: vi.fn(),
    refreshIdFriends: vi.fn(),
    addIdFriend: vi.fn(),
    acceptIdFriend: vi.fn(),
    removeIdFriend: vi.fn(),
  }),
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

vi.mock("./lib/presence", () => ({
  getAblyClient: () => null,
  connectPresence: vi.fn(async () => {}),
  disconnectPresence: vi.fn(),
  updateAgentCount: vi.fn(async () => {}),
  updateFriends: vi.fn(),
  resyncFriendPresence: vi.fn(async () => {}),
  MY_WINDOW_ID: "test-window",
}));

// xterm needs a real canvas and a measured DOM; neither exists in jsdom, and
// the terminal is not what this test is about.
vi.mock("./components/Terminal", () => ({
  default: ({ paneId }: { paneId: string }) => <div data-testid={`term-${paneId}`} />,
}));
vi.mock("./components/RemoteTerminal", () => ({ default: () => <div data-testid="remote-term" /> }));

import App from "./App";
import { OPEN_FEATURE_TOUR_EVENT } from "./lib/onboarding";
import { OPEN_GRAPH_EXPLORER_EVENT } from "./lib/graphSettings";
import { agentCliStatus, createWorkspace, gitBranchOptions, spawnPane, worktreeSetupGet } from "./lib/tauri";

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
  // Skip the first-run dialog; it covers the shell and is its own surface.
  localStorage.setItem("flock:onboarding-seen", "1");
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
});

/** Mount and let every on-mount effect and its promises settle. */
async function mount() {
  const utils = render(<App />);
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return utils;
}

describe("App smoke", () => {
  it("launches the exact mixed lineup with each CLI's own command and session flags", async () => {
    vi.mocked(agentCliStatus).mockResolvedValueOnce({ claude: true, codex: true, pi: true, grok: true, opencode: true });
    vi.mocked(gitBranchOptions).mockResolvedValueOnce({ is_repo: true, current: "main", default_ref: "main", local: [{ name: "main", worktree_path: null }], remote: [] });
    vi.mocked(worktreeSetupGet).mockResolvedValue({ unset: false, command: "", suggestion: "" });
    vi.mocked(createWorkspace).mockResolvedValueOnce({ ...WORKSPACE, id: "ws-mixed", name: "repo" });
    await mount();
    fireEvent.keyDown(window, { key: "n", metaKey: true });
    await screen.findByRole("dialog", { name: "New workspace" });
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

  it("mounts and paints the cockpit shell", async () => {
    const { container } = await mount();
    expect(container.querySelector(".app-shell")).toBeTruthy();
    expect(container.querySelector(".titlebar")).toBeTruthy();
    // The attribute IS the macOS move handle, and this assertion used to say
    // the opposite — that CSS -webkit-app-region was the handle and the
    // attribute a redundant second drag session. It is not: `app-region` is a
    // Windows path (WebView2 123+; wry's own custom_titlebar example says so in
    // a comment) and is inert under WKWebView, which is what Tauri runs on
    // macOS. Tauri's injected drag.js keys on this attribute and nothing else.
    // With it removed the window could not be dragged by its titlebar at all,
    // and this test held that state in place — so it is written as the
    // behaviour ("you can drag the window") rather than as the mechanism.
    expect(container.querySelector(".titlebar")?.hasAttribute("data-tauri-drag-region")).toBe(true);
    expect(container.querySelector(".app-main")).toBeTruthy();
  });

  it("restores the saved workspace and shows it in the sidebar", async () => {
    await mount();
    expect(screen.getByText(WORKSPACE.name)).toBeTruthy();
  });

  it("re-spawns the saved pane rather than dropping it", async () => {
    await mount();
    const tauri = await import("./lib/tauri");
    expect(tauri.spawnPane).toHaveBeenCalled();
  });

  it("does not trip the error boundary", async () => {
    const { container } = await mount();
    // The boundary renders .crash in place of everything else, so its absence
    // is the assertion that nothing in the tree threw during render.
    expect(container.querySelector(".crash")).toBeNull();
  });

  it("survives a workspace with no saved state at all", async () => {
    // The path a freshly created workspace takes before anything is persisted.
    RESULTS.restoreWorkspace = null;
    const { container } = await mount();
    expect(container.querySelector(".app-shell")).toBeTruthy();
    expect(container.querySelector(".crash")).toBeNull();
    RESULTS.restoreWorkspace = SAVED_STATE;
  });
});

describe("App UX entry points", () => {
  afterEach(() => {
    RESULTS.listWorkspaces = [WORKSPACE];
    RESULTS.restoreWorkspace = SAVED_STATE;
    delete RESULTS.graphListNodes;
  });

  it("takes first-run users directly from the short intro to agent setup", async () => {
    localStorage.removeItem("flock:onboarding-seen");
    RESULTS.listWorkspaces = [];
    await mount();
    fireEvent.click(await screen.findByRole("button", { name: "Set up my first agent" }));
    expect(await screen.findByRole("dialog", { name: "New workspace" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Welcome to flock" })).toBeNull();
    expect(localStorage.getItem("flock:onboarding-seen")).toBe("1");
    expect(localStorage.getItem("flock:first-agent-launched")).toBeNull();
  });

  it("opens the optional feature tour without replaying the first-run intro", async () => {
    await mount();
    act(() => window.dispatchEvent(new Event(OPEN_FEATURE_TOUR_EVENT)));
    expect(await screen.findByRole("dialog", { name: "Feature tour" })).toBeTruthy();
    expect(screen.queryByText("Set up my first agent")).toBeNull();
    expect(localStorage.getItem("flock:first-agent-launched")).toBe("1");
  });

  it("opens knowledge in the originating workspace, including explicit all-workspace scope", async () => {
    RESULTS.graphListNodes = [];
    await mount();
    const tauri = await import("./lib/tauri");
    act(() => window.dispatchEvent(new CustomEvent(OPEN_GRAPH_EXPLORER_EVENT, { detail: { workspaceId: "origin-workspace" } })));
    await waitFor(() => expect(tauri.graphListNodes).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "origin-workspace" }), expect.any(String)));
    // Escape closes the explorer; its next opening must use that event's
    // explicit null rather than silently falling back to the focused repo.
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    act(() => window.dispatchEvent(new CustomEvent(OPEN_GRAPH_EXPLORER_EVENT, { detail: { workspaceId: null } })));
    await waitFor(() => expect(tauri.graphListNodes).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceId: null }), expect.any(String)));
  });

  it("restores the user's pinned attention preference and lets them unpin it", async () => {
    localStorage.setItem("flock:attention-pinned", "1");
    await mount();
    expect(screen.getByRole("region", { name: "Pinned attention list" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Unpin list" }));
    expect(screen.queryByRole("region", { name: "Pinned attention list" })).toBeNull();
    expect(localStorage.getItem("flock:attention-pinned")).toBe("0");
  });

  it("reveals a waiting agent when another pane is zoomed before acknowledging it", async () => {
    localStorage.setItem("flock:attention-pinned", "1");
    RESULTS.restoreWorkspace = JSON.stringify({
      agentKind: "claude", focusedPaneId: "pane-a", zoomedPaneId: "pane-a",
      layoutTree: { type: "split", dir: "horizontal", ratio: 0.5,
        first: { type: "leaf", paneId: "pane-a" }, second: { type: "leaf", paneId: "pane-b" } },
      panes: [
        { id: "pane-a", cmd: "claude", args: [], cwd: "/tmp/repo", displayName: "Pluto" },
        { id: "pane-b", cmd: "claude", args: [], cwd: "/tmp/repo", displayName: "Hazel", intent: "Fix checkout validation" },
      ],
    });
    const tauri = await import("./lib/tauri");
    vi.mocked(tauri.spawnPane)
      .mockResolvedValueOnce({ id: "live-a", workspace_id: WORKSPACE.id, kind: "claude", status: "working", rows: 24, cols: 80 })
      .mockResolvedValueOnce({ id: "live-b", workspace_id: WORKSPACE.id, kind: "claude", status: "awaiting_input", rows: 24, cols: 80 });
    const geometry = vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, right: 900, bottom: 700, width: 900, height: 700, toJSON: () => ({}),
    });
    try {
      await mount();
      expect(screen.getByTestId("term-live-a")).toBeTruthy();
      expect(screen.queryByTestId("term-live-b")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: /Fix checkout validation.*Hazel/ }));
      await waitFor(() => expect(screen.getByTestId("term-live-b")).toBeTruthy());
      expect(screen.queryByTestId("term-live-a")).toBeNull();
      expect(tauri.ackPaneAttention).toHaveBeenCalledWith("live-b");
      expect(screen.getByRole("button", { name: "Unzoom Pane" })).toBeTruthy();
    } finally {
      geometry.mockRestore();
    }
  });
});

// ─── The command bar's reach ─────────────────────────────────────────────────
//
// These drive the real capture-phase handler in App, because every one of them
// is a claim about *when* ⌘K works rather than about what the palette renders,
// and CommandBar's own tests cannot see the guard that used to switch it off.

const cmd = (key: string, over: KeyboardEventInit = {}) =>
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, metaKey: true, bubbles: true, ...over }));
  });

const palette = () => document.querySelector(".cmdk-panel");

/** Dialogs are lazy chunks (`lazyModal`) behind `Suspense fallback={null}`, so
 *  a keypress that opens one paints nothing until its dynamic import resolves.
 *  ⌘⇧P because the queue-capture overlay is the cheapest dialog for the
 *  harness to open — which dialog it is does not matter to these tests. */
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

  /* The regression this replaces: the handler returned early whenever any of
   * the nineteen DialogState kinds was open, so the app's command surface
   * could be switched off by any modal — including ones it opened itself. */
  it("opens over an already-open dialog, replacing it", async () => {
    await mount();
    await openADialog();
    await cmd("k");
    expect(palette()).toBeTruthy();
    // The dialog goes rather than stacking behind it, so Escape is unambiguous.
    expect(document.querySelector(".modal-overlay")).toBeNull();
  });

  /* Nothing bound ⌘, — the palette printed it as the Settings row's shortcut
   * and pressing it did nothing, which is worse than printing none. */
  it("binds ⌘, to Settings", async () => {
    await mount();
    await cmd(",");
    await waitFor(() => expect(document.querySelector(".modal-overlay")).toBeTruthy());
  });

  /* The empty-workspace screen names ⌘K once and then disappears forever on
   * the first workspace, and there is no menu bar. This cue is what is left. */
  it("keeps a permanent ⌘K cue in the status bar", async () => {
    const { container } = await mount();
    expect(container.querySelector(".cmdk-cue")?.textContent).toBe("⌘K");
  });
});

describe("App hook order", () => {
  afterEach(() => { ID.idChecked = true; ID.idProfile = { id: "p1", handle: "tester", display_name: "Tester", avatar_url: null }; });

  /* The sign-in gate is an early `return` in the middle of a component with
   * ~200 hooks, and anything declared below it runs on the signed-in pass and
   * not on the signed-out one. A block of ~30 useEventCallback calls landed
   * there, and React threw "Rendered more hooks than during the previous
   * render" on the transition — on every cold launch that has to check the
   * session, which is all of them. The signed-out → signed-in transition is
   * the only render pair that can catch it, so it is worth a test of its own. */
  it("survives the signed-out to signed-in transition", async () => {
    ID.idChecked = false;
    ID.idProfile = null;
    const { container, rerender } = render(<App />);
    await act(async () => { await Promise.resolve(); });
    expect(container.querySelector(".app-shell")).toBeNull();

    ID.idChecked = true;
    ID.idProfile = { id: "p1", handle: "tester", display_name: "Tester", avatar_url: null };
    await act(async () => { rerender(<App />); await Promise.resolve(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    expect(container.querySelector(".app-shell")).toBeTruthy();
    // The boundary renders .crash in place of everything else, so its absence
    // is the assertion that the render did not throw.
    expect(container.querySelector(".crash")).toBeNull();
  });
});
