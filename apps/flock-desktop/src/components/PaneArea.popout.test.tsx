// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import PaneArea, { type BorrowedPane } from "./PaneArea";
import PoppedPaneWindow from "./PoppedPaneWindow";
import type { Pane, Workspace } from "../types";
import { broadcastKey, clearBroadcast, isBroadcasting } from "../lib/broadcastInput";

// popOutPane removes the leaf only from the tab you clicked. The other
// workspace that still lays that id out keeps a Terminal, and the pop-out
// is a second webview with visible={true}. Only `visible` gates resizePty,
// so a focused owner (or borrower) tile would fight the pop-out — the
// dims-drift Terminal's comments warn about. These fixtures are that
// layout after each direction of the pop.

vi.mock("./Terminal", () => ({
  default: ({ paneId, visible, broadcastGroup }: { paneId: string; visible: boolean; broadcastGroup?: string[] | null }) => (
    <div data-testid={`term-${paneId}`} data-visible={visible ? "1" : "0"} data-broadcast={broadcastGroup?.join(",") ?? ""} />
  ),
}));
vi.mock("./ExternalTerminalButton", () => ({ default: () => null }));
vi.mock("./RemoteTerminal", () => ({ default: () => null }));
vi.mock("../lib/tauri", () => ({
  onAgentStatus: vi.fn(async () => () => {}),
  checkoutInWorktree: vi.fn(),
  claudeContextUsage: vi.fn(async () => []),
  listTerminalApps: vi.fn(async () => []),
  openTerminalAt: vi.fn(),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ close: vi.fn() }),
}));
vi.mock("../lib/useVoicePushToTalk", () => ({
  useVoicePushToTalk: () => ({ voiceHud: null, voiceLevel: 0 }),
}));
vi.mock("../lib/usePtyFileDrop", () => ({ usePtyFileDrop: () => {} }));

const noop = () => {};

function pane(over: Partial<Pane> = {}): Pane {
  return {
    id: "p1",
    workspaceId: "owner",
    kind: "claude",
    status: "idle",
    attention: false,
    cwd: "/repo",
    displayName: "Pluto",
    ...over,
  };
}

function workspace(id: string, over: Partial<Workspace> = {}): Workspace {
  return {
    id,
    name: id,
    repo_path: "/repo",
    branch: "main",
    created_at: 0,
    accentColor: "#7fb4f0",
    panes: [],
    tabs: [{
      id: `${id}-tab`,
      name: "1",
      layoutTree: { type: "leaf", paneId: "p1" },
      focusedPaneId: "p1",
      zoomedPaneId: null,
    }],
    focusedTabId: `${id}-tab`,
    agentKind: "claude",
    ...over,
  };
}

function handlers() {
  return {
    onGitChanged: noop,
    onStatusChange: noop,
    onIntentCaptured: noop,
    onAgentStart: noop,
    onPaneContextMenu: noop,
    onSpawnAgent: noop,
    onRace: noop,
    onCompareRace: noop,
    onSplitPane: noop,
    onResizeSplit: noop,
    onEvenSplits: noop,
    onSwapPanes: noop,
    onZoomPane: noop,
    onClosePane: noop,
    onPopOutPane: noop,
    onFocusPane: noop,
    onSubmitPrompt: noop,
    onSwitchTab: noop,
    onNewTab: noop,
    onCloseTab: noop,
    onRenameTab: noop,
    sidebarCollapsed: false,
    onToggleSidebar: noop,
    rightRailCollapsed: true,
    onToggleRightRail: noop,
    rightRailHasContent: false,
    onError: noop,
  };
}

function loan(p: Pane, owner: Workspace): Map<string, BorrowedPane> {
  return new Map([[p.id, {
    pane: p,
    workspaceId: owner.id,
    workspaceName: owner.name,
    accentColor: owner.accentColor,
    secure: !!owner.secure,
  }]]);
}

/** Both workspaces, as the main window keeps them: every PaneArea stays
 *  mounted, and `isVisible` is which tab the user is looking at. */
function renderPair(opts: {
  ownerLayout: Workspace["tabs"][0]["layoutTree"];
  borrowerLayout: Workspace["tabs"][0]["layoutTree"];
  poppedOutIds?: ReadonlySet<string>;
  ownerVisible?: boolean;
  borrowerVisible?: boolean;
  ownerSecure?: boolean;
  borrowerSecure?: boolean;
  withPopout?: boolean;
}) {
  const p = pane();
  const owner = workspace("owner", {
    secure: opts.ownerSecure,
    panes: [p],
    tabs: [{
      id: "owner-tab",
      name: "1",
      layoutTree: opts.ownerLayout,
      focusedPaneId: "p1",
      zoomedPaneId: null,
    }],
    focusedTabId: "owner-tab",
  });
  const borrower = workspace("borrower", {
    secure: opts.borrowerSecure,
    panes: [],
    tabs: [{
      id: "borrower-tab",
      name: "1",
      layoutTree: opts.borrowerLayout,
      focusedPaneId: "p1",
      zoomedPaneId: null,
      borrowed: [{ paneId: "p1", workspaceId: "owner" }],
    }],
    focusedTabId: "borrower-tab",
  });
  const props = handlers();
  return render(
    <>
      <div data-testid="owner">
        <PaneArea
          workspace={owner}
          isVisible={opts.ownerVisible ?? false}
          poppedOutIds={opts.poppedOutIds}
          {...props}
        />
      </div>
      <div data-testid="borrower">
        <PaneArea
          workspace={borrower}
          borrowed={loan(p, owner)}
          isVisible={opts.borrowerVisible ?? false}
          poppedOutIds={opts.poppedOutIds}
          {...props}
        />
      </div>
      {opts.withPopout && (
        <div data-testid="popout">
          <PoppedPaneWindow paneId="p1" workspaceId="borrower" name="Pluto" kind="claude" accent="#7fb4f0" />
        </div>
      )}
    </>,
  );
}

function driverIn(testId: string): HTMLElement | null {
  const root = document.querySelector(`[data-testid="${testId}"]`);
  if (!root) return null;
  return within(root as HTMLElement).queryByTestId("term-p1");
}

function isVisibleDriver(el: HTMLElement | null): boolean {
  return el?.getAttribute("data-visible") === "1";
}

function jailChips(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".pane-chip")]
    .map((el) => (el.textContent ?? "").trim())
    .filter((t) => t === "jailed" || t === "host");
}

beforeEach(() => {
  // jsdom reports 0×0; the grid only lays tiles out once it has a size.
  Element.prototype.getBoundingClientRect = () => ({
    x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600,
    width: 800, height: 600, toJSON() { return {}; },
  });
  window.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => { cleanup(); clearBroadcast(broadcastKey("owner", "owner-tab")); clearBroadcast(broadcastKey("owner", "other-tab")); });

describe("visible keyboard input sync disclosure and recipients", () => {
  function pairWorkspace(): Workspace {
    return workspace("owner", {
      panes: [pane(), pane({ id: "p2", displayName: "Hazel", intent: "Fix the login redirect", status: "awaiting_input" })],
      tabs: [{ id: "owner-tab", name: "1", layoutTree: {
        type: "split", dir: "horizontal", ratio: 0.5,
        first: { type: "leaf", paneId: "p1" }, second: { type: "leaf", paneId: "p2" },
      }, focusedPaneId: "p1", zoomedPaneId: null }],
    });
  }

  it("discloses names and exact delivery count, and stops without closing the tab", () => {
    render(<PaneArea workspace={pairWorkspace()} isVisible {...handlers()} />);
    fireEvent.click(screen.getByRole("button", { name: "Sync keyboard input to visible local panes" }));
    expect(screen.getByRole("status").textContent).toBe("Input is synced to 2 panes");
    expect(screen.getByText("Recipients: Pluto, Hazel")).toBeTruthy();
    expect(screen.getByTestId("term-p1").dataset.broadcast).toBe("p1,p2");
    expect(screen.getByTestId("term-p2").dataset.broadcast).toBe("p1,p2");
    expect(screen.getByRole("button", { name: "Agent intent: Fix the login redirect" })).toBeTruthy();
    expect(screen.getByText("Needs input")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop syncing" }));
    expect(isBroadcasting(broadcastKey("owner", "owner-tab"))).toBe(false);
    expect(screen.queryByRole("region", { name: "Keyboard input sync" })).toBeNull();
    expect(screen.getByTestId("term-p1").dataset.broadcast).toBe("");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Sync keyboard input to visible local panes" }));
  });

  it("pauses delivery under zoom and resumes only when both panes are visible", () => {
    const ws = pairWorkspace();
    const view = render(<PaneArea workspace={ws} isVisible {...handlers()} />);
    fireEvent.click(screen.getByRole("button", { name: "Sync keyboard input to visible local panes" }));
    const zoomed = { ...ws, tabs: [{ ...ws.tabs[0], zoomedPaneId: "p1" }] };
    view.rerender(<PaneArea workspace={zoomed} isVisible {...handlers()} />);
    expect(screen.getByRole("status").textContent).toBe("Input sync is paused");
    expect(screen.getByText("Unzoom to sync with other visible panes.")).toBeTruthy();
    expect(screen.getByTestId("term-p1").dataset.broadcast).toBe("");
    view.rerender(<PaneArea workspace={ws} isVisible {...handlers()} />);
    expect(screen.getByRole("status").textContent).toBe("Input is synced to 2 panes");
  });

  it("excludes popped and booting panes while retaining borrowed local recipients", () => {
    const ws = pairWorkspace();
    const borrowed = loan(ws.panes[1], workspace("home", { name: "Other repo" }));
    const borrower = { ...ws, panes: [ws.panes[0]] };
    const view = render(<PaneArea workspace={borrower} borrowed={borrowed} isVisible {...handlers()} />);
    fireEvent.click(screen.getByRole("button", { name: "Sync keyboard input to visible local panes" }));
    expect(screen.getByText("Recipients: Pluto, Hazel (Other repo)")).toBeTruthy();
    expect(screen.getByTestId("term-p1").dataset.broadcast).toBe("p1,p2");
    view.rerender(<PaneArea workspace={borrower} borrowed={borrowed} poppedOutIds={new Set(["p2"])} isVisible {...handlers()} />);
    expect(screen.getByRole("status").textContent).toBe("Input sync is paused");
    expect(screen.getByTestId("term-p1").dataset.broadcast).toBe("");
    view.rerender(<PaneArea workspace={{ ...ws, panes: [ws.panes[0], { ...ws.panes[1], booting: true }] }} isVisible {...handlers()} />);
    expect(within(screen.getByRole("region", { name: "Keyboard input sync" })).getByRole("status").textContent).toBe("Input sync is paused");
    expect(screen.getByTestId("term-p2").dataset.broadcast).toBe("");
  });

  it("clears hidden tabs' delivery groups and excludes remote streams", () => {
    const ws = pairWorkspace();
    const other = { id: "other-tab", name: "2", layoutTree: { type: "leaf" as const, paneId: "remote" }, focusedPaneId: "remote", zoomedPaneId: null };
    const withOther = { ...ws, panes: [...ws.panes, pane({ id: "remote", streamId: "stream", displayName: "Remote agent" })], tabs: [...ws.tabs, other] };
    const view = render(<PaneArea workspace={withOther} isVisible {...handlers()} />);
    fireEvent.click(screen.getByRole("button", { name: "Sync keyboard input to visible local panes" }));
    view.rerender(<PaneArea workspace={{ ...withOther, focusedTabId: "other-tab" }} isVisible {...handlers()} />);
    expect(screen.queryByRole("region", { name: "Keyboard input sync" })).toBeNull();
    expect(screen.getByTestId("term-p1").dataset.broadcast).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Sync keyboard input to visible local panes" }));
    expect(screen.getByText("No ready local panes are visible.")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Input sync is paused");
    // Stopping one tab does not silently change another tab's explicit mode.
    fireEvent.click(screen.getByRole("button", { name: "Stop syncing" }));
    expect(isBroadcasting(broadcastKey("owner", "owner-tab"))).toBe(true);
    act(() => clearBroadcast(broadcastKey("owner", "owner-tab")));
  });

  it("isolates identical legacy tab IDs across workspaces and clears modes on removal", () => {
    const ws = pairWorkspace();
    const other = { ...ws, id: "other", name: "Other" };
    const view = render(<>
      <div data-testid="sync-owner"><PaneArea workspace={ws} isVisible {...handlers()} /></div>
      <div data-testid="sync-other"><PaneArea workspace={other} isVisible={false} {...handlers()} /></div>
    </>);
    const ownerView = within(screen.getByTestId("sync-owner"));
    fireEvent.click(ownerView.getByRole("button", { name: "Sync keyboard input to visible local panes" }));
    expect(isBroadcasting(broadcastKey("owner", "owner-tab"))).toBe(true);
    expect(isBroadcasting(broadcastKey("other", "owner-tab"))).toBe(false);
    expect(within(screen.getByTestId("sync-other")).queryByRole("region", { name: "Keyboard input sync" })).toBeNull();
    view.unmount();
    expect(isBroadcasting(broadcastKey("owner", "owner-tab"))).toBe(false);
  });
});

describe("one PTY driver after popping out a borrowed pane", () => {
  it("popping from the borrower does not leave a visible driver in the owner", () => {
    // Borrower lost the leaf; owner still lays p1 out and is focused.
    const { container } = renderPair({
      ownerLayout: { type: "leaf", paneId: "p1" },
      borrowerLayout: null,
      poppedOutIds: new Set(["p1"]),
      ownerVisible: true,
      withPopout: true,
    });
    expect(isVisibleDriver(driverIn("owner"))).toBe(false);
    expect(driverIn("borrower")).toBeNull();
    expect(isVisibleDriver(driverIn("popout"))).toBe(true);
    // One visible Terminal in the whole tree — the pop-out.
    const visible = [...container.querySelectorAll("[data-testid='term-p1'][data-visible='1']")];
    expect(visible).toHaveLength(1);
  });

  it("popping from the owner does not leave a visible driver in the borrower", () => {
    // Owner lost the leaf; borrower still lays p1 out and is focused.
    const { container } = renderPair({
      ownerLayout: null,
      borrowerLayout: { type: "leaf", paneId: "p1" },
      poppedOutIds: new Set(["p1"]),
      borrowerVisible: true,
      withPopout: true,
    });
    expect(driverIn("owner")).toBeNull();
    expect(isVisibleDriver(driverIn("borrower"))).toBe(false);
    expect(isVisibleDriver(driverIn("popout"))).toBe(true);
    const visible = [...container.querySelectorAll("[data-testid='term-p1'][data-visible='1']")];
    expect(visible).toHaveLength(1);
  });

  it("a focused tile still drives the PTY when nothing is popped out", () => {
    renderPair({
      ownerLayout: { type: "leaf", paneId: "p1" },
      borrowerLayout: { type: "leaf", paneId: "p1" },
      ownerVisible: true,
    });
    expect(isVisibleDriver(driverIn("owner"))).toBe(true);
    expect(isVisibleDriver(driverIn("borrower"))).toBe(false);
  });

  it("stray existing + return unhides the remaining tile so it drives again", () => {
    // Leaf still in the owner tab (existing-window path never removes it).
    // After the window is gone, releasePoppedOut clears the id even though
    // insert is a no-op — the focused owner tile must become a driver again.
    const poppedOutIds = new Set(["p1"]);
    const view = renderPair({
      ownerLayout: { type: "leaf", paneId: "p1" },
      borrowerLayout: { type: "leaf", paneId: "p1" },
      poppedOutIds,
      ownerVisible: true,
    });
    expect(isVisibleDriver(driverIn("owner"))).toBe(false);

    view.rerender(
      <>
        <div data-testid="owner">
          <PaneArea
            workspace={workspace("owner", {
              panes: [pane()],
              tabs: [{
                id: "owner-tab",
                name: "1",
                layoutTree: { type: "leaf", paneId: "p1" },
                focusedPaneId: "p1",
                zoomedPaneId: null,
              }],
              focusedTabId: "owner-tab",
            })}
            isVisible
            poppedOutIds={new Set()}
            {...handlers()}
          />
        </div>
      </>,
    );
    expect(isVisibleDriver(driverIn("owner"))).toBe(true);
  });
});

describe("host/jailed chips follow the pane's jail, not the tab", () => {
  it("jailed-into-host shows only jailed", () => {
    const { container } = renderPair({
      ownerLayout: { type: "leaf", paneId: "p1" },
      borrowerLayout: { type: "leaf", paneId: "p1" },
      ownerSecure: true,
      borrowerSecure: false,
      borrowerVisible: true,
    });
    expect(jailChips(within(container).getByTestId("borrower"))).toEqual(["jailed"]);
  });

  it("host-into-jailed shows only host", () => {
    const { container } = renderPair({
      ownerLayout: { type: "leaf", paneId: "p1" },
      borrowerLayout: { type: "leaf", paneId: "p1" },
      ownerSecure: false,
      borrowerSecure: true,
      borrowerVisible: true,
    });
    expect(jailChips(within(container).getByTestId("borrower"))).toEqual(["host"]);
  });
});
