import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Terminal from "./Terminal";
import ErrorBoundary from "./ErrorBoundary";
import RemoteTerminal from "./RemoteTerminal";
import GooseMark from "./GooseMark";
import WorkingBlocks from "./WorkingBlocks";
import AgentKindBadge from "./AgentKindBadge";
import IconButton from "./IconButton";
import { XIcon } from "./friendIcons";
import { BroadcastIcon, CollapseIcon, ExpandIcon, PanelLeftIcon, PanelRightIcon, PopOutIcon, RaceIcon, SplitDownIcon, SplitRightIcon } from "./paneIcons";
import ExternalTerminalButton from "./ExternalTerminalButton";
import { isBroadcasting, toggleBroadcast, useBroadcast } from "../lib/broadcastInput";
import BranchChip from "./BranchChip";
import ContextMeter from "./ContextMeter";
import { onAgentStatus, type RepoMap } from "../lib/tauri";
import { clearTerminalSelection } from "../lib/terminalRegistry";
import { onActivateKey, onRadioKey } from "../lib/a11y";
import { useFloatingTip } from "../lib/floatingTip";
import { allPaneIds, computeBorders, computeLayout, setRatioAtPath, type BorderRect, type Rect, type SplitPath } from "../lib/layout";
import { getFocusedTab } from "../lib/tabs";
import type { AgentStatusStr, LayoutNode, Pane, SplitDir, Workspace, WorkspaceTab } from "../types";
import { BranchIcon } from "./settingsIcons";

/** A pane laid out in one of this workspace's tabs but owned by another. The
 *  fields are exactly what the tile has to draw truthfully and cannot read off
 *  `workspace`: whose agent this is, whose colour it wears, and above all
 *  whether it is jailed. The jail chip is a safety claim, so inheriting it from
 *  the tab's owner would let an unjailed agent sit under a badge saying it
 *  cannot touch anything outside the workspace. */
export interface BorrowedPane {
  pane: Pane;
  workspaceId: string;
  workspaceName: string;
  accentColor: string;
  secure: boolean;
}

interface Props {
  workspace: Workspace;
  /** Panes from other workspaces that this workspace's tabs display, keyed by
   *  pane id. Empty for the overwhelmingly common case of a tab whose panes
   *  are all its own. */
  borrowed?: Map<string, BorrowedPane>;
  /** Live git snapshot for this workspace's repo (worktrees + branches),
   * polled by App — drives the per-pane branch chips and divergence badge. */
  repoMap?: RepoMap;
  /** Refresh git state now (after a checkout from a branch picker). */
  onGitChanged: () => void;
  /** Whether this workspace's layer is the currently-visible one (vs. kept
   * mounted-but-hidden in the background). */
  isVisible: boolean;
  /** Pane ids that currently have a live `pane-${id}` OS window. Those
   * tiles must not mount a visible Terminal — the pop-out is a second
   * webview, so `isVisible` alone would let this grid fight it on resizePty. */
  poppedOutIds?: ReadonlySet<string>;
  onStatusChange: (paneId: string, status: AgentStatusStr) => void;
  onIntentCaptured: (paneId: string, text: string) => void;
  /** A pane's agent has taken the terminal over from flock's boot plumbing. */
  onAgentStart: (paneId: string) => void;
  onPaneContextMenu: (
    workspaceId: string,
    paneId: string | null,
    e: React.MouseEvent,
  ) => void;
  /** Takes the workspace id rather than closing over it: App passes one
   * stable handler to every PaneArea, which is what lets React.memo here
   * actually skip a re-render. PaneArea binds its own id below. */
  onSpawnAgent: (workspaceId: string) => void;
  /** Start a fan-out, or — when the focused tab already is one — open the
   * comparison. One button with two states rather than two: a race is a mode
   * a tab is in, and a permanently-dead "Compare" beside "Race" would be
   * chrome that does nothing in every tab but one. */
  onRace: (workspaceId: string) => void;
  onCompareRace: (workspaceId: string, tabId: string) => void;
  onSplitPane: (workspaceId: string, dir: SplitDir) => void;
  onResizeSplit: (workspaceId: string, tabId: string, path: SplitPath, ratio: number) => void;
  /** Even out every split in a tab (double-clicking a resize gutter). */
  onEvenSplits: (workspaceId: string, tabId: string) => void;
  /** Trade two panes' places in the layout (dragging one pane onto another,
   * by its topbar or with ⌘ held anywhere in it). */
  onSwapPanes: (workspaceId: string, tabId: string, a: string, b: string) => void;
  onZoomPane: (workspaceId: string, paneId: string | null) => void;
  onClosePane: (paneId: string) => void;
  onPopOutPane: (workspaceId: string, paneId: string) => void;
  onFocusPane: (workspaceId: string, paneId: string) => void;
  /** Drop a past prompt back into a pane's input line (no auto-submit). */
  onSubmitPrompt: (paneId: string, text: string) => void;
  onSwitchTab: (workspaceId: string, tabId: string) => void;
  onNewTab: (workspaceId: string) => void;
  onCloseTab: (workspaceId: string, tabId: string) => void;
  /** Rename a tab (double-click its name). Blank name reverts to auto-number. */
  onRenameTab: (workspaceId: string, tabId: string, name: string) => void;
  /** Left-sidebar collapse state + toggle — the toggle lives here in the
   * pane-header (a flat control among the split/zoom/close buttons) rather than
   * as a floating puck on the sidebar seam. */
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  /** Right-rail collapse state + toggle, and whether the rail has anything
   * docked (the toggle only shows when it does). */
  rightRailCollapsed: boolean;
  onToggleRightRail: () => void;
  rightRailHasContent: boolean;
  /** Report a failure to the user (goes to the notification log) — used by the
   * external-terminal button, which can only fail loudly or not at all. */
  onError: (message: string) => void;
}

function PaneArea({
  workspace,
  borrowed,
  repoMap,
  onGitChanged,
  isVisible,
  poppedOutIds,
  onStatusChange,
  onIntentCaptured,
  onAgentStart,
  onPaneContextMenu,
  onSpawnAgent,
  onRace,
  onCompareRace,
  onSplitPane,
  onResizeSplit,
  onZoomPane,
  onClosePane,
  onPopOutPane,
  onFocusPane,
  onSubmitPrompt,
  onSwitchTab,
  onNewTab,
  onCloseTab,
  onRenameTab,
  onEvenSplits,
  onSwapPanes,
  sidebarCollapsed,
  onToggleSidebar,
  rightRailCollapsed,
  onToggleRightRail,
  rightRailHasContent,
  onError,
}: Props) {
  const gridRef = useRef<HTMLDivElement>(null);
  // The workspace id is bound here rather than in App, so App can hand every
  // PaneArea the same handler identity (see the stable-handler block there).
  const spawnAgentHere = useCallback(() => onSpawnAgent(workspace.id), [onSpawnAgent, workspace.id]);
  const [gridSize, setGridSize] = useState<Rect | null>(null);
  // Tab id currently being renamed inline (double-click a tab name), and the
  // draft text. null = not editing.
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const commitRename = () => {
    if (editingTabId) onRenameTab(workspace.id, editingTabId, editingName);
    setEditingTabId(null);
  };
  const startRename = (t: WorkspaceTab) => {
    setEditingName(t.name);
    setEditingTabId(t.id);
  };

  const paneIds = workspace.panes.map((p) => p.id).join(",");
  useEffect(() => {
    const unsubs: Array<() => void> = [];
    workspace.panes.forEach((p) => {
      onAgentStatus(p.id, (status) => onStatusChange(p.id, status)).then(
        (fn) => unsubs.push(fn),
      );
    });
    return () => {
      unsubs.forEach((u) => u());
    };
  // Track exact pane IDs so listeners are cleaned up when panes are replaced
  // (same count but different IDs would otherwise leak old subscriptions).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id, paneIds]);

  // Track the pane-grid container size — useLayoutEffect so sizes
  // are available before the first paint, preventing an empty flash. Shared
  // across every tab's layer since they all fill the same area.
  useLayoutEffect(() => {
    if (!gridRef.current) return;
    const el = gridRef.current;
    // Measure immediately so terminals render at the right size on frame 1
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      setGridSize({ x: 0, y: 0, width: Math.floor(rect.width), height: Math.floor(rect.height) });
    }
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      setGridSize({ x: 0, y: 0, width: Math.floor(width), height: Math.floor(height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const focusedTab = getFocusedTab(workspace);
  // Subscribe to broadcast toggles so the toolbar switch reflects the current
  // tab's sync state (the flag lives in a module store, not workspace state).
  useBroadcast();
  const focusedBroadcasting = isBroadcasting(focusedTab.id);

  // Where the external-terminal button lands: the focused agent's own cwd, so a
  // per-agent worktree opens as itself rather than as the shared checkout. A
  // remote (co-pilot) pane's cwd is on the other machine, so it doesn't count.
  const focusedPane = workspace.panes.find((p) => p.id === focusedTab.focusedPaneId);
  const externalTerminalCwd =
    (focusedPane && !focusedPane.streamId ? focusedPane.cwd : "") || workspace.repo_path;

  // Panes that exist on the workspace but aren't laid out in *any* tab —
  // i.e. popped out into their own window (not just parked in another tab).
  // These derivations run for EVERY mounted workspace (all stay mounted) on
  // every re-render, so memoize them on their real inputs — they only change
  // when the panes/tabs or the repo's branch map change, not on unrelated App
  // re-renders (notifications, dialogs, other workspaces' status ticks).
  const { poppedOutCount, branchByPane, distinctBranches } = useMemo(() => {
    // Panes that exist on the workspace but aren't laid out in *any* tab —
    // i.e. popped out into their own window (not just parked in another tab).
    const inAnyTab = new Set(workspace.tabs.flatMap((t) => t.layoutTree ? allPaneIds(t.layoutTree) : []));
    const poppedOutCount = workspace.panes.filter((p) => !p.streamId && !inAnyTab.has(p.id)).length;

    // Live branch per checkout path, for the divergence badge — when the
    // workspace's agents sit on more than one branch, "@main" alone lies.
    const liveBranchOf = (cwd: string, fallback?: string) => {
      const wt = repoMap?.worktrees.find((t) => t.path === cwd);
      return wt ? wt.branch || wt.head : fallback ?? "";
    };
    const branchByPane = workspace.panes
      .filter((p) => !p.streamId)
      .map((p) => ({ name: p.displayName ?? p.kind, branch: liveBranchOf(p.cwd, p.worktree?.branch || workspace.branch) }));
    const distinctBranches = new Set(branchByPane.map((b) => b.branch).filter(Boolean));
    return { poppedOutCount, branchByPane, distinctBranches };
  }, [workspace.tabs, workspace.panes, workspace.branch, repoMap]);

  // Last path segment — "flock-code", not "/Users/…/git/flock-code".
  const repoFolder = (workspace.repo_path ?? "").replace(/\/+$/, "").split("/").pop() ?? "";

  return (
    <div className="main-content" style={{ ["--accent" as never]: workspace.accentColor }}>
      {/* ─── Header — one row: sidebar toggle, tab strip, then the workspace's
           identity (branch + repo) sat against the pane-action cluster. The tab
           bar used to be a second 40px row below this one; merging them buys
           back that whole band of chrome for terminal. ─────────────────────── */}
      <div className="pane-header">
        {/* Left-sidebar expand — only while the rail is hidden. Collapsing it
            is the rail's own job now (see .brand-collapse in Sidebar), which
            keeps this row for the workspace's tabs; bringing it back has to
            live out here, since a control inside the rail goes with it. */}
        {sidebarCollapsed && (
          <IconButton
            className="header-btn header-panel-toggle"
            icon={<PanelLeftIcon filled={false} />}
            label="Show sidebar"
            onClick={onToggleSidebar}
          />
        )}

        {/* ─── Tab strip ────────────────────────────────────────────────
             Shrinks and scrolls when tabs overflow; the + button lives
             outside it so it never scrolls out of reach. */}
        <div className="tab-strip" role="tablist" aria-label="Workspace tabs">
          {workspace.tabs.map((t, i) => {
            // Live-derived attention: an agent in a *background* tab is
            // waiting on the user. Without this, hidden tabs are where
            // agents silently stall.
            const paneIdsInTab = t.layoutTree ? new Set(allPaneIds(t.layoutTree)) : new Set<string>();
            const needsAttention =
              t.id !== workspace.focusedTabId &&
              workspace.panes.some((p) => paneIdsInTab.has(p.id) && (p.status === "awaiting_input" || p.status === "blocked"));
            return (
            <div
              key={t.id}
              className={`tab-item${t.id === workspace.focusedTabId ? " active" : ""}${needsAttention ? " attention" : ""}`}
              role="tab"
              /* Roving tabindex: Tab enters the strip on the active tab only,
                 arrows/Home/End move between tabs (onRadioKey moves DOM focus
                 and selection together, per the tablist pattern). Without it,
                 Tab stepped through every tab one by one and arrows did
                 nothing. */
              tabIndex={t.id === workspace.focusedTabId ? 0 : -1}
              aria-selected={t.id === workspace.focusedTabId}
              onClick={() => onSwitchTab(workspace.id, t.id)}
              onKeyDown={(e) => {
                onActivateKey(() => onSwitchTab(workspace.id, t.id))(e);
                onRadioKey(e, i, workspace.tabs.length, (n) => onSwitchTab(workspace.id, workspace.tabs[n].id));
              }}
              onAuxClick={(e) => {
                // Middle-click closes, matching every browser/terminal tab bar.
                if (e.button === 1) { e.preventDefault(); onCloseTab(workspace.id, t.id); }
              }}
            >
              {needsAttention && <span className="tab-attention-dot" role="img" aria-label="An agent in this tab needs input" title="An agent in this tab needs input" />}
              {editingTabId === t.id ? (
                <input
                  className="tab-name-input"
                  value={editingName}
                  autoFocus
                  spellCheck={false}
                  maxLength={40}
                  aria-label="Tab name"
                  onChange={(e) => setEditingName(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") commitRename();
                    else if (e.key === "Escape") setEditingTabId(null);
                  }}
                />
              ) : (
                <span
                  className="tab-name"
                  title="Double-click to rename"
                  onDoubleClick={(e) => { e.stopPropagation(); startRename(t); }}
                >
                  {t.name}
                </span>
              )}
              {/* One trailing slot, two jobs. The shortcut sits here at rest and
                  the close button takes its place on hover, stacked in the same
                  grid cell so the tab never changes width and the strip never
                  reflows under the pointer.
                  The rename pencil that used to live here is gone: it was a
                  third way to do what double-clicking the name already does
                  (and says it does, in its tooltip), and together with the
                  close button it reserved about 46px of invisible chrome in
                  every tab — which is what put a hand's width of empty space
                  between two tabs labelled "1" and "2". */}
              <span className="tab-trail">
                {i < 9 && <span className="tab-shortcut">⌘{i + 1}</span>}
                <IconButton
                  className="tab-close-btn"
                  icon={<XIcon size={11} />}
                  label="Close Tab"
                  onClick={(e) => { e.stopPropagation(); onCloseTab(workspace.id, t.id); }}
                />
              </span>
            </div>
            );
          })}
        </div>
        <IconButton className="tab-add-btn" icon="+" label="New Tab (⌘T)" onClick={() => onNewTab(workspace.id)} />

        <div className="spacer" />

        {workspace.repo_path && !workspace.copilot && !workspace.observe ? (
          <BranchChip
            cwd={workspace.repo_path}
            workspace={workspace}
            repoMap={repoMap}
            fallbackBranch={workspace.branch}
            shared
            className="header-branch-chip"
            onGitChanged={onGitChanged}
          />
        ) : (
          <span className="branch" style={{ color: workspace.accentColor }}>@{workspace.branch}</span>
        )}
        {distinctBranches.size > 1 && (
          <span
            className="branch-divergence"
            title={branchByPane.map((b) => `${b.name}: ${b.branch || "?"}`).join("\n")}
          >
            <BranchIcon size={10} /> {distinctBranches.size} branches
          </span>
        )}
        {/* Folder name only. Every workspace shares the same parent dirs, so the
            full path spent header width saying nothing — it moves to the hover. */}
        {repoFolder && (
          <span className="directory" title={workspace.repo_path}>{repoFolder}</span>
        )}
        {/* Escape hatch to a plain host terminal, opened where the focused
            agent actually runs (its worktree, when there is one). Sits at the
            head of the action row, split off by a hairline: everything to its
            right rearranges panes, this one leaves the app entirely. */}
        <ExternalTerminalButton cwd={externalTerminalCwd} onError={onError} />
        {/* Race / Compare. Only where there is a repo to branch — a co-pilot
            or observe workspace has no repo_path, and a race is nothing but
            branches. */}
        {workspace.repo_path && !workspace.copilot && !workspace.observe && (
          <IconButton
            className={`header-btn${focusedTab.race ? " active" : ""}`}
            icon={<RaceIcon />}
            label={
              focusedTab.race
                ? `Compare the ${focusedTab.race.contenders.length} contenders in this tab`
                : "Race agents — one prompt, several worktrees"
            }
            onClick={() =>
              focusedTab.race ? onCompareRace(workspace.id, focusedTab.id) : onRace(workspace.id)
            }
          />
        )}
        <span className="header-sep" aria-hidden="true" />
        {/* No focused-pane guard: splitPane itself resolves the target (and
            spawns into an empty tab as a fresh leaf), so gating on a target
            here just made these buttons silently dead after closing every
            agent in a tab. */}
        <IconButton
          className="header-btn"
          icon={<SplitRightIcon />}
          label="Split Right"
          onClick={() => onSplitPane(workspace.id, "horizontal")}
        />
        <IconButton
          className="header-btn"
          icon={<SplitDownIcon />}
          label="Split Down"
          onClick={() => onSplitPane(workspace.id, "vertical")}
        />
        {/* No zoom control here. Every pane carries its own in its topbar,
            where it is unambiguous about which pane it zooms; this one had to
            guess between the zoomed pane and the focused one. */}
        <IconButton
          className={`header-btn${focusedBroadcasting ? " active" : ""}`}
          icon={<BroadcastIcon />}
          label={focusedBroadcasting ? "Stop syncing input to all panes" : "Sync input to all panes in this tab"}
          onClick={() => toggleBroadcast(focusedTab.id)}
        />
        <IconButton
          className="header-btn danger"
          icon={<XIcon size={13} />}
          label="Close Pane"
          disabled={!focusedTab.focusedPaneId}
          onClick={() => {
            if (focusedTab.focusedPaneId)
              onClosePane(focusedTab.focusedPaneId);
          }}
        />
        {/* Right-rail toggle — mirrors the left one, at the far right edge of
            the row. Only when something is docked over there to show/hide. */}
        {rightRailHasContent && (
          <IconButton
            className="header-btn header-panel-toggle right"
            icon={<PanelRightIcon filled={!rightRailCollapsed} />}
            label={rightRailCollapsed ? "Show right panel" : "Hide right panel"}
            onClick={onToggleRightRail}
          />
        )}
      </div>

      {/* ─── Pane grid — one absolutely-stacked layer per tab, only the
           focused tab's layer visible, so switching tabs doesn't unmount
           (and lose scrollback for) the others. Mirrors how workspace
           layers themselves stay mounted when switching workspaces. ───── */}
      <div
        ref={gridRef}
        className="pane-grid"
        onContextMenu={(e) =>
          onPaneContextMenu(
            workspace.id,
            focusedTab.focusedPaneId ?? null,
            e,
          )
        }
      >
        {workspace.tabs.map((tab) => (
          <TabLayer
            key={tab.id}
            workspace={workspace}
            borrowed={borrowed}
            repoMap={repoMap}
            onGitChanged={onGitChanged}
            tab={tab}
            tabVisible={tab.id === workspace.focusedTabId}
            paneAreaVisible={isVisible}
            poppedOutIds={poppedOutIds}
            gridSize={gridSize}
            gridRef={gridRef}
            poppedOutCount={poppedOutCount}
            onSpawnAgent={spawnAgentHere}
            onIntentCaptured={onIntentCaptured}
            onAgentStart={onAgentStart}
            onPaneContextMenu={onPaneContextMenu}
            onZoomPane={onZoomPane}
            onClosePane={onClosePane}
            onPopOutPane={onPopOutPane}
            onFocusPane={onFocusPane}
            onSubmitPrompt={onSubmitPrompt}
            onResizeSplit={onResizeSplit}
            onEvenSplits={onEvenSplits}
            onSwapPanes={onSwapPanes}
          />
        ))}
      </div>
    </div>
  );
}

// Every workspace's PaneArea stays mounted (visibility:hidden), so without this
// an unrelated App state change (a notification, a dialog, another workspace's
// status tick) re-runs EVERY PaneArea. Custom comparator: re-render only when
// one of this workspace's DATA inputs changed. The 19 handler props are omitted
// on purpose — App keeps them all stale-proof (ref-based / functional-setState;
// the inline lambdas close over nothing but `workspace`, which IS compared
// here, and the stable `setDialog`), so a skipped render safely keeps the prior
// handler instances.
//
// INVARIANT for maintainers: (1) if you add a non-handler prop to Props, add it
// to this comparator or the pane will render stale; (2) if you add a handler
// that reads render-scope state directly, route it through a ref first (see the
// openPaneMenu/popOutPane/updatePaneIntent fixes) or it will read frozen state.
export default memo(PaneArea, (a, b) =>
  a.workspace === b.workspace &&
  // A borrowed pane's status, name and intent live in ANOTHER workspace's
  // object, so `a.workspace === b.workspace` stays true through every change
  // to it. Without this line a borrowed tile freezes at the state it had when
  // it was borrowed, which looks exactly like an agent that has stopped.
  a.borrowed === b.borrowed &&
  a.repoMap === b.repoMap &&
  a.isVisible === b.isVisible &&
  a.poppedOutIds === b.poppedOutIds &&
  a.sidebarCollapsed === b.sidebarCollapsed &&
  a.rightRailCollapsed === b.rightRailCollapsed &&
  a.rightRailHasContent === b.rightRailHasContent,
);

// ─── One tab's split-pane grid ──────────────────────────────────────────

function TabLayer({
  workspace,
  borrowed,
  repoMap,
  onGitChanged,
  tab,
  tabVisible,
  paneAreaVisible,
  poppedOutIds,
  gridSize,
  gridRef,
  poppedOutCount,
  onSpawnAgent,
  onIntentCaptured,
  onAgentStart,
  onPaneContextMenu,
  onZoomPane,
  onClosePane,
  onPopOutPane,
  onFocusPane,
  onSubmitPrompt,
  onResizeSplit,
  onEvenSplits,
  onSwapPanes,
}: {
  workspace: Workspace;
  borrowed?: Map<string, BorrowedPane>;
  repoMap?: RepoMap;
  onGitChanged: () => void;
  tab: WorkspaceTab;
  tabVisible: boolean;
  paneAreaVisible: boolean;
  poppedOutIds?: ReadonlySet<string>;
  gridSize: Rect | null;
  gridRef: React.RefObject<HTMLDivElement | null>;
  poppedOutCount: number;
  onSpawnAgent: () => void;
  onIntentCaptured: Props["onIntentCaptured"];
  onAgentStart: Props["onAgentStart"];
  onPaneContextMenu: Props["onPaneContextMenu"];
  onZoomPane: Props["onZoomPane"];
  onClosePane: Props["onClosePane"];
  onPopOutPane: Props["onPopOutPane"];
  onFocusPane: Props["onFocusPane"];
  onSubmitPrompt: Props["onSubmitPrompt"];
  onResizeSplit: Props["onResizeSplit"];
  onEvenSplits: Props["onEvenSplits"];
  onSwapPanes: Props["onSwapPanes"];
}) {
  // While a gutter is being dragged, the ratio is previewed locally instead
  // of round-tripping through the top-level workspace state on every pixel
  // of mouse movement — that would re-render (and re-persist) far more than
  // a drag needs. The override is dropped once `tab.layoutTree` itself
  // changes, which happens the moment the drag's final ratio is committed.
  const [liveRatio, setLiveRatio] = useState<{ path: SplitPath; ratio: number } | null>(null);
  useEffect(() => { setLiveRatio(null); }, [tab.layoutTree]);
  // Which pane's topbar intent dropdown is open, and where to anchor it.
  const [intentMenu, setIntentMenu] = useState<{ paneId: string; rect: DOMRect } | null>(null);
  const dragRef = useRef<{ path: SplitPath; dir: SplitDir; area: Rect; ratio: number; originX: number; originY: number } | null>(null);

  // Memoize the tree + geometry so an unrelated re-render doesn't rebuild the
  // tree and re-walk computeLayout/computeBorders for every mounted tab. These
  // recompute only when the layout, the zoom, the live drag ratio, or the grid
  // size actually change (a drag changes liveRatio, which is exactly when the
  // preview must recompute).
  const displayTree = useMemo<LayoutNode | null>(() => {
    const base: LayoutNode | null = tab.zoomedPaneId
      ? { type: "leaf", paneId: tab.zoomedPaneId }
      : tab.layoutTree;
    return base && liveRatio ? setRatioAtPath(base, liveRatio.path, liveRatio.ratio) : base;
  }, [tab.zoomedPaneId, tab.layoutTree, liveRatio]);

  const paneRects = useMemo(
    () => (displayTree && gridSize ? computeLayout(displayTree, gridSize) : []),
    [displayTree, gridSize],
  );
  const borders = useMemo(
    () => (displayTree && gridSize && !tab.zoomedPaneId ? computeBorders(displayTree, gridSize) : []),
    [displayTree, gridSize, tab.zoomedPaneId],
  );

  // Broadcast/"sync input": when on for this tab, the visible panes (what's in
  // paneRects, so zoom is respected) form the group every keystroke fans out to.
  // Memoized so Terminal's shallow memo only re-registers when it truly changes.
  useBroadcast();
  const broadcasting = isBroadcasting(tab.id);
  const broadcastGroup = useMemo<readonly string[] | null>(
    () => (broadcasting ? paneRects.map((r) => r.paneId) : null),
    [broadcasting, paneRects],
  );

  // ─── Drag a pane onto another pane to swap their places ────────────────
  // Two-stage on purpose: `dragPaneId` is armed on pointerdown but nothing is
  // visible until the pointer actually travels (THRESHOLD), so a plain click —
  // focusing the pane, hitting its intent label, ⌘-clicking — never reads as a
  // drag. `swapDrag` is set only once the drag is live, which is also what the
  // ghost + target ring render off.
  const [dragPaneId, setDragPaneId] = useState<string | null>(null);
  const [swapDrag, setSwapDrag] = useState<{ overId: string | null; x: number; y: number } | null>(null);

  // In-flight drag bookkeeping. It lives in a ref, not in the listener
  // closure, because App re-renders constantly (status ticks) and a re-render
  // would otherwise re-run the effect and silently reset the drag halfway.
  const swapRef = useRef<{ start: { x: number; y: number } | null; live: boolean; over: string | null }>(
    { start: null, live: false, over: null },
  );
  // Same reason: the listeners read the current geometry/handler through this
  // rather than closing over them, so the effect can depend on `dragPaneId`
  // alone and stay registered for the whole drag.
  const swapCtx = useRef({ paneRects, onSwapPanes, wsId: workspace.id, tabId: tab.id });
  swapCtx.current = { paneRects, onSwapPanes, wsId: workspace.id, tabId: tab.id };

  // Two ways in: the topbar is a bare grab handle, and ⌘ + drag grabs the pane
  // from anywhere, terminal body included. The modifier is what makes the body
  // safe — a bare drag over the terminal is a text selection, and no heuristic
  // (distance, leaving the pane) separates the two reliably: selections
  // routinely overshoot into a neighbouring pane, which is exactly the motion a
  // swap would be. ⌘ is free: xterm's own force-selection modifier is ⌥ on
  // macOS, ctrl-click is the context menu, and links open on a bare click.
  const beginPaneDrag = (e: React.PointerEvent, paneId: string) => {
    // Left button only, never from a pane control (pop-out, zoom, close,
    // intent), and only when there's somewhere to drop it.
    if (e.button !== 0) return;
    const el = e.target as HTMLElement;
    if (el.closest("button, input, a")) return;
    if (tab.zoomedPaneId || paneRects.length < 2) return;
    if (!e.metaKey && !el.closest(".pane-topbar")) return;
    // This is what keeps the terminal out of it: xterm binds mousedown (not
    // pointerdown), so preventing the default here means it never sees the
    // press — no selection starts, and nothing is reported to a TUI that has
    // mouse tracking on. It's also what stops the native text-selection drag
    // when the gesture starts on the topbar's label.
    e.preventDefault();
    // The wrapper's onMouseDown normally does this, but preventDefault above
    // suppresses the compatibility mouse events, so focus the pane here.
    onFocusPane(workspace.id, paneId);
    swapRef.current = { start: null, live: false, over: null };
    setDragPaneId(paneId);
  };

  // ⌘ held (with a droppable neighbour) turns every pane into a grab handle —
  // the cursor says so before the user commits to a drag. setState with an
  // unchanged value bails out in React, so ordinary typing in a terminal
  // doesn't re-render this on every keystroke.
  const [metaHeld, setMetaHeld] = useState(false);
  useEffect(() => {
    if (!tabVisible || tab.zoomedPaneId || paneRects.length < 2) {
      setMetaHeld(false);
      return;
    }
    const sync = (e: KeyboardEvent) => setMetaHeld(e.metaKey);
    const clear = () => setMetaHeld(false);
    window.addEventListener("keydown", sync);
    window.addEventListener("keyup", sync);
    // ⌘-tabbing away never delivers the keyup, which would otherwise leave
    // every pane stuck showing the grab cursor.
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", sync);
      window.removeEventListener("keyup", sync);
      window.removeEventListener("blur", clear);
    };
  }, [tabVisible, tab.zoomedPaneId, paneRects.length]);

  useEffect(() => {
    if (!dragPaneId) return;
    // Pane rects are grid-local; pointer coords are viewport-relative.
    const gridRect = gridRef.current?.getBoundingClientRect();
    const originX = gridRect?.left ?? 0;
    const originY = gridRect?.top ?? 0;
    // The pointerdown itself lands on .pane-topbar, which is CSS-`zoom`ed —
    // its coordinates aren't comparable with the window's. So the drag origin
    // is taken from the first window-level move instead, and everything after
    // is measured against that.
    const THRESHOLD = 6;

    const paneAt = (x: number, y: number) =>
      swapCtx.current.paneRects.find(
        ({ rect }) =>
          x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height,
      )?.paneId ?? null;

    const onMove = (e: PointerEvent) => {
      const d = swapRef.current;
      if (!d.start) { d.start = { x: e.clientX, y: e.clientY }; return; }
      if (!d.live) {
        if (Math.hypot(e.clientX - d.start.x, e.clientY - d.start.y) < THRESHOLD) return;
        d.live = true;
      }
      const x = e.clientX - originX;
      const y = e.clientY - originY;
      const hit = paneAt(x, y);
      d.over = hit && hit !== dragPaneId ? hit : null;
      setSwapDrag({ overId: d.over, x, y });
    };
    const finish = (commit: boolean) => {
      const d = swapRef.current;
      const { onSwapPanes: swap, wsId, tabId } = swapCtx.current;
      if (commit && d.live && d.over) swap(wsId, tabId, dragPaneId, d.over);
      swapRef.current = { start: null, live: false, over: null };
      // A drag that started on the topbar's text otherwise leaves a highlighted
      // selection behind (xterm's a11y layer opts back into user-select), and
      // clearTerminalSelection covers the terminal's own selection model in
      // case anything slipped past the suppressed mousedown.
      window.getSelection()?.removeAllRanges();
      clearTerminalSelection(dragPaneId);
      setDragPaneId(null);
      setSwapDrag(null);
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") finish(false); };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey);
    };
  }, [dragPaneId, gridRef]);

  const draggedPane = swapDrag ? workspace.panes.find((p) => p.id === dragPaneId) : undefined;

  const onGutterPointerDown = (e: React.PointerEvent, b: BorderRect) => {
    e.stopPropagation();
    // Without this, dragging the gutter over a terminal pane still kicks off
    // the browser's native text-selection drag — xterm's accessibility text
    // layer sets `user-select: text` (needed for copy/paste) so it isn't
    // covered by the app-wide `user-select: none`, and that selection was
    // left highlighted after the drag ended.
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    // Border rects (b.x/b.y/b.area) live in grid-local coordinates — origin
    // at .pane-grid's own top-left, not the viewport's. e.clientX/clientY
    // are viewport-relative, so without this offset every drag was off by
    // however far the grid sits from the window edge (past the sidebar,
    // tab bar, etc.), producing a jump the instant the pointer moved.
    const gridRect = gridRef.current?.getBoundingClientRect();
    dragRef.current = {
      path: b.path, dir: b.dir, area: b.area, ratio: 0.5,
      originX: gridRect?.left ?? 0, originY: gridRect?.top ?? 0,
    };
  };
  const onGutterPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const localX = e.clientX - d.originX;
    const localY = e.clientY - d.originY;
    const raw = d.dir === "horizontal"
      ? (localX - d.area.x) / d.area.width
      : (localY - d.area.y) / d.area.height;
    const ratio = Math.max(0.1, Math.min(0.9, raw));
    d.ratio = ratio;
    setLiveRatio({ path: d.path, ratio });
  };
  const onGutterPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    dragRef.current = null;
    window.getSelection()?.removeAllRanges();
    onResizeSplit(workspace.id, tab.id, d.path, d.ratio);
  };

  return (
    <div
      className={`tab-layer${swapDrag ? " swapping" : ""}${metaHeld ? " meta-grab" : ""}`}
      style={{
        position: "absolute",
        inset: 0,
        // "inherit", never "visible"/"auto": an explicit visible/auto on a
        // child pierces a `visibility: hidden` / `pointer-events: none`
        // ancestor — which made every background workspace's focused tab
        // paint (and receive clicks) on top of the actually-focused
        // workspace whenever it came later in the DOM.
        visibility: tabVisible ? "inherit" : "hidden",
        pointerEvents: tabVisible ? "inherit" : "none",
      }}
    >
      {displayTree && paneRects.length === 0 ? (
        <div style={{ flex: 1 }} />
      ) : paneRects.length > 0 ? (
        <>
          {paneRects.map(({ paneId, rect }) => {
            // Own panes first, then the loans. A leaf that resolves to neither
            // is a ghost the restore pass has not healed yet, and renders as an
            // empty tile exactly as it did before borrowing existed.
            const lent = borrowed?.get(paneId);
            const pane = workspace.panes.find((p) => p.id === paneId) ?? lent?.pane;
            const isFocused = paneId === tab.focusedPaneId;
            // The pane's jail, never the tab's. A jailed agent borrowed into
            // an unjailed tab is still jailed; a host agent borrowed into a
            // secure tab is still on the host.
            const jailed = !!(lent ? lent.secure : workspace.secure);
            // A live pop-out is another webview driving this PTY. Treat it
            // like a hidden workspace so this tile cannot call resizePty.
            const poppedOut = !!poppedOutIds?.has(paneId);
            const isDragSource = !!swapDrag && dragPaneId === paneId;
            const isSwapTarget = swapDrag?.overId === paneId;
            return (
              <div
                key={paneId}
                data-pane-id={paneId}
                className={`terminal-pane${isFocused ? " focused" : ""}${broadcasting ? " broadcasting" : ""}${isDragSource ? " swap-source" : ""}${isSwapTarget ? " swap-target" : ""}`}
                style={{
                  position: "absolute",
                  left: rect.x,
                  top: rect.y,
                  width: rect.width,
                  height: rect.height,
                  // `--accent` is set once for the whole workspace layer on
                  // `.main-content`, so a borrowed tile has to re-declare it
                  // here or it wears the colour of the workspace it is only
                  // visiting, which is the one cue saying whose agent it is.
                  ...(lent ? { ["--accent" as never]: lent.accentColor } : {}),
                }}
                onMouseDown={() => onFocusPane(workspace.id, paneId)}
                onPointerDown={(e) => beginPaneDrag(e, paneId)}
                onContextMenu={(e) => {
                  e.stopPropagation();
                  onPaneContextMenu(workspace.id, paneId, e);
                }}
              >
                {pane && (
                  <div className={`pane-topbar${!tab.zoomedPaneId && paneRects.length > 1 ? " draggable" : ""}`}>
                    <div className="pane-topbar-lead">
                    {/* The agent mark leads the bar: it's the one thing here
                        that's this pane's own identity. The old 3px accent tick
                        sat in this slot, but it repeated the workspace accent
                        that the name's color and the focused pane border
                        already carry — two vertical marks competing for the
                        left edge. Logo only, no "Claude Code" text: the
                        color-coded mark identifies the kind, and the reclaimed
                        width goes to the pane's intent. */}
                    <AgentKindBadge kind={pane.kind} iconOnly size={12} />
                    {pane.displayName && <span className="pane-topbar-name">{pane.displayName}</span>}
                    {/* Secure mode: the agent lives in a Docker jail that sees
                        only the workspace — worth saying on every pane, since
                        it's also the promise that bypass-permissions is safe. */}
                    {/* Borrowed panes name their home, because "which repo is
                        this agent in" stops being answerable from the tab. */}
                    {lent && (
                      <span className="pane-chip pane-chip-lent" title={`Borrowed from ${lent.workspaceName}`}>
                        {lent.workspaceName}
                      </span>
                    )}
                    {jailed && (
                      <span
                        className="pane-chip"
                        title="Secure mode: this agent runs in a Docker container that can only touch this workspace"
                      >
                        jailed
                      </span>
                    )}
                    {/* The inverse mark: a non-secure local agent runs on the
                        host with bypass-permissions, so it can reach real files
                        and keys. The risk carries the visible chip, not the safe
                        (jailed) path. Remote/co-pilot stream panes are excluded.
                        Keys off the pane's jail, not the tab's: a host agent
                        borrowed into a secure tab must still say host. */}
                    {!jailed && !pane.streamId && (
                      <span
                        className="pane-chip pane-chip-warn"
                        title="This agent runs on your machine with bypass-permissions — it can read and write your files and use your credentials. Turn on Secure mode when creating a workspace to jail it to that workspace."
                      >
                        host
                      </span>
                    )}
                    {/* Co-pilot: every pane declares its pilot, color-coded —
                        blue for the partner, mint for you. */}
                    {workspace.copilot && (
                      <span className={`pane-chip ${pane.streamId ? "pane-chip-blue" : "pane-chip-mint"}`}>
                        @{pane.streamId ? workspace.copilot.partnerLogin : "you"}
                      </span>
                    )}
                    {pane.worktree && (
                      <BranchChip
                        cwd={pane.cwd}
                        workspace={workspace}
                        repoMap={repoMap}
                        fallbackBranch={pane.worktree.branch}
                        className="pane-topbar-worktree"
                        onGitChanged={onGitChanged}
                      />
                    )}
                    {/* How full this agent's context is. Sits after the
                        identity chips and before the intent: it's a property of
                        the conversation, not of the pane's setup, and the
                        intent is the one thing here allowed to eat the
                        remaining width. */}
                    <ContextMeter kind={pane.kind} sessionId={pane.sessionId} />
                    {pane.intent && (
                      <IntentLabel
                        intent={pane.intent}
                        intentRaw={pane.intentRaw}
                        open={intentMenu?.paneId === paneId}
                        onOpen={(rect) =>
                          setIntentMenu((m) => (m?.paneId === paneId ? null : { paneId, rect }))
                        }
                      />
                    )}
                    </div>
                    <div className="pane-topbar-actions">
                    {pane.status === "working" && <WorkingBlocks cells={5} className="pane-topbar-wave" />}
                    {!pane.streamId && (
                      <IconButton
                        className="pane-topbar-btn"
                        icon={<PopOutIcon size={13} />}
                        label="Open in New Window"
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={() => onPopOutPane(workspace.id, paneId)}
                      />
                    )}
                    <IconButton
                      className="pane-topbar-btn"
                      icon={tab.zoomedPaneId === paneId ? <CollapseIcon size={13} /> : <ExpandIcon size={13} />}
                      label={tab.zoomedPaneId === paneId ? "Unzoom Pane" : "Zoom Pane"}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={() => {
                        onFocusPane(workspace.id, paneId);
                        // Always pass the pane id — zoomPane toggles off
                        // internally when it matches the current zoom.
                        // (Passing null here hits zoomPane's null guard and
                        // silently no-ops, which broke unzooming.)
                        onZoomPane(workspace.id, paneId);
                      }}
                    />
                    <IconButton
                      className="pane-topbar-btn danger"
                      icon={<XIcon size={13} />}
                      label="Close Pane"
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={() => onClosePane(paneId)}
                    />
                    </div>
                  </div>
                )}
                {/* Per pane, not just at the root: one agent's terminal
                    throwing should cost that one tile, not the whole grid and
                    every other agent's scrollback with it. */}
                <ErrorBoundary label="This agent's terminal">
                  <div className="pane-body">
                    {pane?.streamId
                      ? <RemoteTerminal streamId={pane.streamId} focused={isFocused} interactive={!!workspace.copilot} />
                      : (
                        <>
                          {/* Mounted as soon as there is a PTY, even while the
                              boot card covers it: the terminal is what sizes
                              the PTY and answers the cursor-position query
                              some agents make on startup, so hiding it would
                              be hiding it from the agent too. */}
                          {!pane?.spawning && (
                            <Terminal paneId={paneId} focused={isFocused} visible={paneAreaVisible && tabVisible && !poppedOut} primary={!lent} onIntentCaptured={onIntentCaptured} onAgentStart={onAgentStart} broadcastGroup={broadcastGroup} />
                          )}
                          {(pane?.spawning || pane?.booting) && (
                            <PaneBootCard pane={pane} onReveal={onAgentStart} />
                          )}
                        </>
                      )}
                  </div>
                </ErrorBoundary>
              </div>
            );
          })}
          {/* Gutters — draggable to resize the split. The hit area is padded
              wider than the visual 2px line (see .layout-gutter::after in
              global.css) so it's actually grabbable. */}
          {borders.map((b, i) => {
            const pad = 4;
            const rect = b.dir === "horizontal"
              ? { left: b.x - pad, top: b.y, width: b.width + pad * 2, height: b.height }
              : { left: b.x, top: b.y - pad, width: b.width, height: b.height + pad * 2 };
            const dragging = liveRatio !== null && pathsEqual(liveRatio.path, b.path);
            return (
              <div
                key={`g${i}`}
                className={`layout-gutter layout-gutter-${b.dir === "horizontal" ? "h" : "v"}${dragging ? " dragging" : ""}`}
                style={{ position: "absolute", ...rect }}
                onPointerDown={(e) => onGutterPointerDown(e, b)}
                onPointerMove={onGutterPointerMove}
                onPointerUp={onGutterPointerUp}
                onDoubleClick={(e) => { e.stopPropagation(); onEvenSplits(workspace.id, tab.id); }}
                title="Double-click to even out the panes"
              />
            );
          })}
          {/* Cursor-following label so the agent being moved stays identifiable
              while the pane itself is dimmed in place. Says what will happen the
              moment it's over a droppable pane. */}
          {swapDrag && draggedPane && (
            <div
              className="pane-swap-ghost"
              style={{ left: swapDrag.x + 14, top: swapDrag.y + 14 }}
            >
              <span className="pane-swap-ghost-name">
                {draggedPane.displayName ?? draggedPane.kind}
              </span>
              <span className="pane-swap-ghost-hint">
                {swapDrag.overId
                  ? `swap with ${workspace.panes.find((p) => p.id === swapDrag.overId)?.displayName
                      ?? workspace.panes.find((p) => p.id === swapDrag.overId)?.kind
                      ?? "pane"}`
                  : "drop on a pane to swap"}
              </span>
            </div>
          )}
          {intentMenu && (
            <IntentHistoryMenu
              anchor={intentMenu.rect}
              history={workspace.panes.find((p) => p.id === intentMenu.paneId)?.promptHistory ?? []}
              onPick={(text) => {
                onSubmitPrompt(intentMenu.paneId, text);
                onFocusPane(workspace.id, intentMenu.paneId);
                setIntentMenu(null);
              }}
              onClose={() => setIntentMenu(null)}
            />
          )}
        </>
      ) : (
        <EmptyPane
          onSpawn={onSpawnAgent}
          poppedOutCount={poppedOutCount}
        />
      )}
    </div>
  );
}

// The pane topbar's intent label. Clicking opens the prompt-history dropdown;
// hovering shows the agent's *full* intent in a real floating tooltip (the
// visible label is single-line, ellipsis-clipped). Deliberately not the native
// `title` — that renders small, low-contrast, after an OS delay, and truncates
// long text. This one is a legible card, appears immediately, wraps to multiple
// lines, and (portaled + fixed) escapes the topbar's overflow:hidden + zoom.
function IntentLabel({
  intent,
  intentRaw,
  open,
  onOpen,
}: {
  intent: string;
  intentRaw?: string;
  open: boolean;
  onOpen: (rect: DOMRect) => void;
}) {
  const full = intentRaw ?? intent;
  // Suppress the tooltip while the dropdown owns this element.
  const { ref, anchorProps, tipNode, hide } = useFloatingTip<HTMLButtonElement>(full, { disabled: open });

  return (
    <button
      ref={ref}
      type="button"
      className={`pane-topbar-intent${open ? " open" : ""}`}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-label={`Agent intent: ${full}`}
      {...anchorProps}
      onMouseDown={(e) => { hide(); e.stopPropagation(); }}
      onClick={(e) => onOpen((e.currentTarget as HTMLElement).getBoundingClientRect())}
    >
      {intent}
      {tipNode}
    </button>
  );
}

// Per-agent prompt history, opened by clicking a pane's topbar intent. Picking
// an entry drops it back into that agent's input line. Portaled to <body> and
// fixed-positioned so it escapes the topbar's overflow:hidden + zoom.
function IntentHistoryMenu({
  anchor,
  history,
  onPick,
  onClose,
}: {
  anchor: DOMRect;
  history: string[];
  onPick: (text: string) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".pane-intent-menu, .pane-topbar-intent")) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const WIDTH = 360;
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - WIDTH - 8));
  const recent = [...history].reverse();

  return createPortal(
    <div className="pane-intent-menu" role="listbox" style={{ top: anchor.bottom + 4, left, width: WIDTH }}>
      <div className="pane-intent-menu-head">Prompt history</div>
      {recent.length === 0 ? (
        <div className="pane-intent-menu-empty">No prompts captured yet</div>
      ) : (
        recent.map((p, i) => (
          <button
            key={i}
            type="button"
            className="pane-intent-menu-item"
            role="option"
            title={p}
            onClick={() => onPick(p)}
          >
            {p}
          </button>
        ))
      )}
    </div>,
    document.body,
  );
}

// ─── Helpers ───────────────────────────────────────────────────────────

function pathsEqual(a: SplitPath, b: SplitPath): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// ─── Empty state ───────────────────────────────────────────────────────

function EmptyPane({
  onSpawn,
  poppedOutCount,
}: {
  onSpawn: () => void;
  poppedOutCount: number;
}) {
  return (
    <div className="splash" style={{ background: "transparent" }}>
      <div className="empty-goose"><GooseMark width={84} flap /></div>
      <div className="time">EMPTY WORKSPACE</div>
      <div className="empty-headline">
        {poppedOutCount > 0 ? "grid is empty" : "no agents running"}
      </div>
      <div className="tagline">
        {poppedOutCount > 0
          ? `${poppedOutCount} agent${poppedOutCount === 1 ? "" : "s"} popped out into ${poppedOutCount === 1 ? "its own window" : "their own windows"}`
          : "RIGHT-CLICK FOR OPTIONS"}
      </div>
      <div className="cta">
        <button className="btn-mint-solid" onClick={onSpawn}>
          + Spawn Agent
        </button>
      </div>
    </div>
  );
}

/** What a pane shows between "Create" and the agent's own first frame.
 *
 * There is real work in that gap — a fetch, a worktree, an install, the agent's
 * own startup — and it used to happen either with nothing on screen at all (the
 * grid didn't exist yet) or as a login shell's prompt, an echoed `eval` line
 * and a wall of `npm ci` scrolling past. Neither is what the user asked to see,
 * and both read as flock being slow rather than as flock doing something.
 *
 * So: name the step, and keep the terminal covered until the agent is the one
 * writing to it. Anyone who does want to watch can click through — and after
 * `REVEAL_MS` the card gets out of the way by itself, because a step that slow
 * is one where the output is the only honest progress bar. */
function PaneBootCard({ pane, onReveal }: { pane: Pane; onReveal: (paneId: string) => void }) {
  const REVEAL_MS = 20_000;
  const [elapsed, setElapsed] = useState(0);
  const paneId = pane.id;
  useEffect(() => {
    const started = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    const reveal = setTimeout(() => onReveal(paneId), REVEAL_MS);
    return () => { clearInterval(id); clearTimeout(reveal); };
    // Deps are the pane and App's stable callback, deliberately not the phase:
    // both timers measure how long this pane has been starting, which moving
    // from one step to the next doesn't reset.
  }, [paneId, onReveal]);

  const who = pane.displayName ?? "the agent";
  const [line, detail] = ((): [string, string | undefined] => {
    switch (pane.phase?.kind) {
      case "fetching":   return ["fetching the base", pane.phase.ref];
      case "branching":  return ["cutting its worktree", pane.phase.branch];
      case "installing": return ["installing dependencies", pane.phase.command];
      default:           return [`starting ${who}`, undefined];
    }
  })();

  return (
    <div
      className="pane-spawning pane-boot"
      role="status"
      title="Click to watch"
      onClick={() => onReveal(paneId)}
    >
      <WorkingBlocks cells={7} className="wb-spawning" />
      <div className="pane-boot-lines">
        <span>{line}…</span>
        {detail && <span className="pane-boot-detail">{detail}</span>}
      </div>
      {/* Only once it's slow enough to wonder about. */}
      <span className="pane-boot-elapsed">{elapsed >= 5 ? `${elapsed}s` : " "}</span>
    </div>
  );
}
