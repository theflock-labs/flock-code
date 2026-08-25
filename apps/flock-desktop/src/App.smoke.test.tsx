// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, waitFor } from "@testing-library/react";

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
  spawnPane: "pane-1",
  getPersistedPaneBuffer: null,
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
