import { useEffect, useCallback, useMemo, useRef, useState } from "react";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import Sidebar from "./components/Sidebar";
import PaneArea from "./components/PaneArea";
import { RailResizer, loadRailWidth, saveRailWidth, SIDEBAR_W, RIGHT_RAIL_W } from "./components/RailResizer";
import Splash from "./components/Splash";
import CommandBar, { type Command } from "./components/CommandBar";
import { OPEN_GRAPH_SETUP_EVENT, OPEN_GRAPH_EXPLORER_EVENT, getGraphEnabled, getGraphUrl, onGraphEnabledChange } from "./lib/graphSettings";
import { usePtyFileDrop } from "./lib/usePtyFileDrop";
import { recordUsage } from "./lib/usageStats";
import { isToastSuppressed } from "./lib/toastSuppression";
import { onPaletteSummon } from "./lib/paletteBridge";
import { addBorrowed, appendLeaf, borrowedOwner, remapBorrowed, removeBorrowed, type BorrowedRef } from "./lib/borrowedPanes";
import { emptyPopoutBook, markPoppedOut as markPoppedOutBook, releasePoppedOut, releasePoppedOutMany, type PopoutOrigin } from "./lib/poppedOut";
import type { BorrowedPane } from "./components/PaneArea";
import { useNotifications } from "./lib/useNotifications";
import { useBudgetAlerts } from "./lib/useBudgetAlerts";
import type { Budget } from "./lib/budgets";
import { isWindowActive, onWindowActiveChange } from "./lib/windowActive";
import { useFlockId } from "./lib/useFlockId";
import { useGithubPrs } from "./lib/useGithubPrs";
import NotificationsBadge, { overallCheckStatus } from "./components/NotificationsBadge";
import StatusBar from "./components/StatusBar";
import ContextMenu, { MenuItem } from "./components/ContextMenu";
import SessionToasts, { type ToastItem } from "./components/SessionToast";
import SignInGate from "./components/SignInGate";
import UpdateBanner from "./components/UpdateBanner";
import { getEffectiveTheme, THEMES, applyTheme } from "./lib/theme";
import {
  createWorkspace,
  currentBranch,
  summarizeIntent,
  graphBrief,
  graphGroundHook,
  graphMcpConfig,
  getCwd,
  listWorkspaces,
  reorderWorkspaces as reorderWorkspacesCmd,
  spawnPane,
  debugLog,
  closePane as closePaneCmd,
  sendInput,
  ackPaneAttention,
  saveWorkspaceState as saveWorkspaceStateCmd,
  restoreWorkspace,
  persistPaneBuffers,
  getPersistedPaneBuffer,
  claudeSessionExists,
  captureAgentSession,
  renameWorkspace,
  deleteWorkspaceCmd,
  githubCheckoutPrWorktree,
  githubRepoWebUrl,
  githubApprovePr,
  githubMergePr,
  prWatchGetConfig,
  prWatchPoll,
  prReviewGetSummaries,
  prReviewSetSummary,
  summarizeReview,
  mergeQueueList,
  mergeQueueAdd,
  mergeQueueRemove,
  mergeQueueReorder,
  mergeQueueTick,
  type PrWatchConfig,
  type PrReviewSummary,
  type MergeQueueItem,
  onOpenSettings,
  onPanePopoutClosed,
  onVoiceNoAudio,
  createWorktree,
  removeWorktree,
  gitHeadSha,
  gitCommitAll,
  gitMergeBranch,
  gitRepoMap,
  worktreeSetupGet,
  branchUnmergedCount,
  type RepoMap,
  type WorktreeStatus,
  onHookEvent,
  queueAdd,
  queueList,
  queueLaunch,
  queueUpdateText,
  queueDelete,
  type QueueItem,
} from "./lib/tauri";
import { copyText } from "./lib/clipboard";
import { openExternalTerminal } from "./lib/externalTerminal";
import { detachStagedImages } from "./lib/imageAttach";
import { flashPanePill } from "./lib/panePill";
import { useVoicePushToTalk } from "./lib/useVoicePushToTalk";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import {
  connectPresence,
  disconnectPresence,
  updateAgentCount,
  updateFriends,
  resyncFriendPresence,
  type PresenceStatus,
} from "./lib/presence";
import { signOut, supabase } from "./lib/flockId";
import { onActiveTeamChange, syncActiveTeamMirror } from "./lib/teamSettings";
import {
  initSessions,
  requestObserve,
  acceptObserve,
  declineObserve,
  endObserve,
  sendTask,
  acceptTask,
  declineTask,
  inviteCopilot,
  acceptCopilot,
  endCopilot,
  type SessionMsg,
  type CopilotPane,
} from "./lib/session";
import { workspaceColor } from "./lib/palette";
import { getCarryPatterns, getDeleteBranchWithWorktree, getWorktreesBaseDir, setLastBaseRef } from "./lib/worktreeSettings";
import { branchForAgent, normalizePlan, previewBranches, slugify } from "./lib/branchPlan";
import { cleanupPlan, raceStem, raceTabName } from "./lib/race";
import { fetchBase } from "./lib/baseFetch";
import { randomAgentName } from "./lib/agentNames";
import { hasSeenOnboarding, markOnboardingSeen } from "./lib/onboarding";
import { split, remove, firstPaneId, buildGridLayout, remapLayoutTree, pruneLayoutTree, allPaneIds, setRatioAtPath, balanceLayoutTree, swapPanes, type SplitPath } from "./lib/layout";
import { setRestoreHistory } from "./lib/restoreHistory";
import { stepPaneFontSize, stepUiScale } from "./lib/uiScale";
import { getTerminalSelection, getSelectionUrl, getInputLine, clearInputLineBytes, noteInjectedInput, getTerminalBuffer } from "./lib/terminalRegistry";
import { makeTab, getFocusedTab, findTabForPane } from "./lib/tabs";
import { AGENT_KINDS, agentLabel } from "./lib/agents";
import { graphSpawnArgs as graphSpawnArgsFor } from "./lib/graphSpawn";
import { deliverPromptWhenReady as deliverPrompt } from "./lib/promptDelivery";
import {
  agentCommand,
  buildWorkspaceStateBlob,
  patchSavedBudget,
  restoreDisplayNames,
  shouldHydrateAfterEmptyRestore,
  shouldPersistWorkspace,
  worktreesFromSavedState,
  type SavedPane,
} from "./lib/workspaceState";
import type { AgentKind, AgentStatusStr, BranchPlan, Friend, LayoutNode, Pane, PanePhase, PullRequest, RaceContender, RaceState, SplitDir, WindowLayout, Workspace, WorkspaceTab } from "./types";
import { lazyModal, preloadWhenIdle } from "./lib/lazyModal";
import { useEventCallback } from "./lib/useEventCallback";

// Dialogs are code-split: see lib/lazyModal.tsx for why each one carries its
// own Suspense boundary rather than sharing one near the root. Call sites are
// unchanged — these are still ordinary components.
const BranchFateDialog = lazyModal(() => import("./components/BranchFateDialog"));
const ConfirmDialog = lazyModal(() => import("./components/ConfirmDialog"));
const FriendStatsModal = lazyModal(() => import("./components/FriendStatsModal"));
const GraphExplorer = lazyModal(() => import("./components/GraphExplorer"));
const GraphOnboardingDialog = lazyModal(() => import("./components/GraphOnboardingDialog"));
const MyInfoModal = lazyModal(() => import("./components/MyInfoModal"));
const NewWorkspaceDialog = lazyModal(() => import("./components/NewWorkspaceDialog"));
const OnboardingDialog = lazyModal(() => import("./components/OnboardingDialog"));
const PrManagerModal = lazyModal(() => import("./components/PrManagerModal"));
const QueueCaptureOverlay = lazyModal(() => import("./components/QueueCaptureOverlay"));
const RaceCompareModal = lazyModal(() => import("./components/RaceCompareModal"));
const RaceDialog = lazyModal(() => import("./components/RaceDialog"));
const RenameDialog = lazyModal(() => import("./components/RenameDialog"));
const SettingsDialog = lazyModal(() => import("./components/SettingsDialog"));
const SpawnLayoutDialog = lazyModal(() => import("./components/SpawnLayoutDialog"));
const TaskDialog = lazyModal(() => import("./components/TaskDialog"));
const VoiceOverlay = lazyModal(() => import("./components/VoiceOverlay"));

type DialogState =
  | { kind: "none" }
  | { kind: "new-workspace" }
  | { kind: "settings"; tab?: string }
  | { kind: "rename-workspace"; workspaceId: string; current: string }
  | { kind: "confirm-close"; workspaceId: string; name: string; mode: "close" | "copilot" | "observe" }
  | { kind: "confirm-signout" }
  // The shared GitHub cockpit — PULL REQUESTS and MERGE QUEUE are tabs of one
  // modal; `view` picks which tab opens first.
  | { kind: "pr-hub"; view: "prs" | "queue"; initialPr?: number }
  | { kind: "spawn-layout"; workspaceId: string }
  // Fan-out: pick a prompt, an agent, and how many contenders.
  // `prompt` pre-fills the composer when the race was started from the
  // command bar, where the user has already typed what they want run.
  | { kind: "race"; workspaceId: string; prompt?: string }
  // Judge a fan-out: every contender's diff against the commit they share.
  | { kind: "race-compare"; workspaceId: string; tabId: string }
  // Pane close paused on a branch with unmerged commits — Keep / Delete / Cancel.
  | { kind: "close-pane-branch"; paneId: string; agentName?: string; branch: string; unmerged: number }
  // Prune of an orphaned worktree paused the same way.
  | { kind: "prune-worktree"; workspaceId: string; wt: WorktreeStatus; unmerged: number }
  // Friend's usage stats, opened from the friends pane.
  | { kind: "friend-stats"; friend: Friend }
  // Your own stats + graph metrics, opened from the profile footer.
  | { kind: "my-info" }
  // Personal prompt-queue capture overlay (⌘⇧P).
  | { kind: "queue-capture" }
  // Closing a tab that still has agents laid out in it — confirm first.
  | { kind: "confirm-close-tab"; workspaceId: string; tabId: string; tabName: string; agentCount: number };

interface CtxMenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

export default function App() {
  // Drop a file (e.g. a screenshot) on any agent pane → its quoted path is
  // typed into that pane's PTY, Terminal.app-style.
  usePtyFileDrop();

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [focusedWsId, setFocusedWsId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>({ kind: "none" });
  // ⌘K. Deliberately not a member of DialogState: the palette is allowed to be
  // open over an idle workspace and every other dialog is exclusive, so folding
  // it into that union would make "no dialog" the wrong precondition for half
  // the shortcut handler.
  const [cmdBarOpen, setCmdBarOpen] = useState(false);
  // A race merge is in flight. Lives here rather than in the compare modal
  // because the merge outlives the modal's own state on a re-render, and a
  // second click while `git merge` is running would try to merge a branch that
  // is halfway into the checkout.
  const [mergingRace, setMergingRace] = useState(false);
  const [contextMenu, setContextMenu] = useState<CtxMenuState | null>(null);
  // Personal prompt queue (queued captures + launched history), loaded once and
  // spliced in place on each mutation. Persisted server-side in SQLite.
  const [queueItems, setQueueItems] = useState<QueueItem[]>([]);
  // Live mirror so ref-based handlers (openPaneMenu) can read the current queue
  // without closing over render-scope state — see the memo(PaneArea) invariant.
  const queueItemsRef = useRef<QueueItem[]>([]);
  queueItemsRef.current = queueItems;
  // Live git snapshot per workspace id (worktrees + branches + who holds
  // what), refreshed on the same poll as workspace branches. UI-only.
  const [repoMaps, setRepoMaps] = useState<Record<string, RepoMap>>({});
  const [cwd, setCwd] = useState<string>("");
  // Whether the left sidebar is collapsed, so agents can take the full
  // window width. Persisted across launches like other layout prefs.
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(
    () => localStorage.getItem("flock:sidebar-collapsed") === "1",
  );
  // Which sidebar tab is showing. Lifted out of Sidebar so starting a co-pilot
  // session can snap back to Home and surface the new shared workspace instead
  // of stranding the user on Friends.
  const [sidebarTab, setSidebarTab] = useState<"workspaces" | "friends">("workspaces");
  const toggleSidebarCollapsed = () => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem("flock:sidebar-collapsed", next ? "1" : "0");
      return next;
    });
  };
  // Right-rail collapse — mirror of the sidebar, lifted here (rather than owned
  // inside Sidebar) so the pane-header can render the toggle and this component
  // can flag the <aside> below. `rightRailHasContent` is reported up by Sidebar
  // when sections are docked right; the toggle only shows when there's content.
  const [rightRailCollapsed, setRightRailCollapsed] = useState<boolean>(
    () => localStorage.getItem("flock:right-rail-collapsed") === "1",
  );
  const toggleRightRailCollapsed = () => {
    setRightRailCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem("flock:right-rail-collapsed", next ? "1" : "0");
      return next;
    });
  };
  const [rightRailHasContent, setRightRailHasContent] = useState(false);
  // Rail widths, dragged at the seams (RailResizer) and persisted per rail.
  // Only the committed value lives here — a drag in progress writes the CSS
  // variable directly, so moving one edge doesn't re-render the whole app.
  const [sidebarWidth, setSidebarWidth] = useState(() => loadRailWidth(SIDEBAR_W));
  const [rightRailWidth, setRightRailWidth] = useState(() => loadRailWidth(RIGHT_RAIL_W));
  const commitSidebarWidth = useCallback((w: number) => {
    setSidebarWidth(w);
    saveRailWidth(SIDEBAR_W, w);
  }, []);
  const commitRightRailWidth = useCallback((w: number) => {
    setRightRailWidth(w);
    saveRailWidth(RIGHT_RAIL_W, w);
  }, []);
  // The sidebar's toggle lives in the pane-header, which only exists once a
  // workspace does — so a collapsed sidebar plus an empty Splash would have no
  // way back. Treat the sidebar as expanded whenever there's nothing to reclaim
  // space for; the stored preference still applies once work is open.
  const effectiveSidebarCollapsed = sidebarCollapsed && workspaces.length > 0;
  // The four dialogs that answer a reflex rather than a decision: ⌘K, a rename,
  // a confirm, and push-to-talk. Code-splitting them is still right — they are
  // dead weight at launch — but a chunk fetch inside the keystroke that opens
  // them is the exact stutter this split exists to remove, so they are warmed
  // in the first idle window instead. Everything else loads on open, where a
  // few milliseconds behind a deliberate click is invisible.
  useEffect(() => {
    preloadWhenIdle([RenameDialog, ConfirmDialog, VoiceOverlay, TaskDialog]);
  }, []);

  // Drive --sidebar-w directly (rather than a fixed width on .collapsed)
  // so every other element positioned off it — the voice bar, popout
  // offsets — stays aligned without each needing its own collapsed variant.
  useEffect(() => {
    document.documentElement.style.setProperty(
      "--sidebar-w",
      effectiveSidebarCollapsed ? "0px" : `${Math.round(sidebarWidth)}px`,
    );
  }, [effectiveSidebarCollapsed, sidebarWidth]);
  useEffect(() => {
    document.documentElement.style.setProperty("--right-rail-w", `${Math.round(rightRailWidth)}px`);
  }, [rightRailWidth]);
  // Notification log + the pusher every domain watcher below feeds into.
  const { notifications, pushNotification } = useNotifications();
  /** One-liner for "this user action failed" — handed to child components that
   * have no business knowing the notification shape. */
  const notifyFailure = useCallback((text: string) => {
    pushNotification({ status: "failure", category: "agent", priority: true, text });
  }, [pushNotification]);

  /** Open a directory in the user's terminal emulator (the same preference the
   * header button uses). Failures are loud — nothing visible happens on
   * success except a window appearing somewhere else. */
  const openTerminalHere = useCallback(async (dir: string) => {
    try {
      const app = await openExternalTerminal(dir);
      if (!app) notifyFailure("No terminal app found on this Mac.");
    } catch (e) {
      notifyFailure(`Couldn't open a terminal: ${e instanceof Error ? e.message : e}`);
    }
  }, [notifyFailure]);
  // flock ID session: profile, friend graph, and the social-stats sync.
  const {
    idProfile, idChecked, friends, setFriends,
    refreshIdFriends, addIdFriend, acceptIdFriend, removeIdFriend,
  } = useFlockId(pushNotification);
  // Number of the PR currently being checked out + reviewed, if any — drives
  // the loading spinner on its "review" button while checkout/spawn/prompt
  // are in flight.
  const [reviewingPr, setReviewingPr] = useState<number | null>(null);
  // Live mirror of reviewingPr so the auto-review FIFO drain (async, spans
  // renders) can wait for the in-flight review to settle without closing over
  // a stale render's state.
  const reviewingPrRef = useRef<number | null>(null);
  reviewingPrRef.current = reviewingPr;
  // ─── PR watch / auto-review / merge queue ──────────────────────────
  // Open PRs across the *watched* repos (Settings → GitHub → Pull Requests),
  // merged into the modal's list alongside the focused workspace's PRs.
  const [watchedPrs, setWatchedPrs] = useState<PullRequest[]>([]);
  // Stored agent-review summaries, keyed "repo#number" — loaded once at
  // startup and refreshed each time a review pane finishes summarizing.
  const [prSummaries, setPrSummaries] = useState<Record<string, PrReviewSummary>>({});
  // The merge queue, refreshed when the PR modal opens and re-evaluated
  // (mergeQueueTick) on the watch-poll cadence while non-empty.
  const [mergeQueue, setMergeQueue] = useState<MergeQueueItem[]>([]);
  const mergeQueueRef = useRef<MergeQueueItem[]>([]);
  // Last-loaded watch config; re-read on every poll so a settings change
  // applies without any wiring between the dialog and this component.
  const prWatchConfigRef = useRef<PrWatchConfig | null>(null);
  // FIFO of freshly-detected PRs awaiting an auto-review, drained one at a
  // time through reviewPr (which only ever runs one review at once).
  const autoReviewQueueRef = useRef<PullRequest[]>([]);
  const autoReviewDrainingRef = useRef(false);
  // Panes spawned by reviewPr → the PR they're reviewing, so a finished
  // review agent's terminal output can be summarized against the right PR.
  const reviewPanesRef = useRef<Map<string, { repo: string; number: number }>>(new Map());
  // Per-review-pane status tracking for the summarize trigger: last seen
  // status (to detect the working → idle/awaiting_input edge) and which panes
  // have already summarized this working-streak (re-armed on "working").
  const reviewPaneStatusRef = useRef<Map<string, AgentStatusStr>>(new Map());
  const summarizedPanesRef = useRef<Set<string>>(new Set());
  // repo_path → "owner/repo" slug (null = no GitHub origin), so the
  // auto-review drain can match open workspaces to a watched PR's repo
  // without re-running `git remote` on every poll.
  const repoSlugCacheRef = useRef<Map<string, string | null>>(new Map());
  // Health of our own Ably presence connection, shown as a light on the profile.
  const [presenceStatus, setPresenceStatus] = useState<PresenceStatus>("connecting");
  // Last-seen presence per friend handle + a "primed" flag, so we can toast
  // real online/offline *transitions* without spamming: presence backfill and
  // the 20s friend-list resync both re-emit "online" for already-online
  // friends, and the initial connect emits a burst for everyone already on.
  const presencePrevRef = useRef<Map<string, "online" | "offline">>(new Map());
  const presencePrimedRef = useRef(false);
  const [sessionToasts, setSessionToasts] = useState<ToastItem[]>([]);
  // Always points at the latest handleSessionMsg. initSessions subscribes to
  // Ably once (at presence connect), so without this the handler would keep a
  // stale closure over the first render's empty friends/workspaces — making
  // an incoming observe/task/copilot "Accept" a silent no-op.
  const handleSessionMsgRef = useRef<(m: SessionMsg) => void>(() => {});
  const [showOnboarding, setShowOnboarding] = useState(() => !hasSeenOnboarding());
  const [showGraphSetup, setShowGraphSetup] = useState(false);
  const [taskDialog, setTaskDialog] = useState<{ login: string; windowId: string; avatar?: string } | null>(null);

  // The flock Graph wizard opens from Settings and from the onboarding
  // tutorial — both dispatch this event rather than prop-drilling a setter
  // through the (busy) SettingsDialog surface.
  useEffect(() => {
    const open = () => setShowGraphSetup(true);
    window.addEventListener(OPEN_GRAPH_SETUP_EVENT, open);
    return () => window.removeEventListener(OPEN_GRAPH_SETUP_EVENT, open);
  }, []);

  // Full-area Graph Explorer, opened from the sidebar Graph card.
  const [showGraphExplorer, setShowGraphExplorer] = useState(false);
  useEffect(() => {
    const open = () => setShowGraphExplorer(true);
    window.addEventListener(OPEN_GRAPH_EXPLORER_EVENT, open);
    return () => window.removeEventListener(OPEN_GRAPH_EXPLORER_EVENT, open);
  }, []);
  // Tracks which workspace IDs have already had their panes restored so we
  // don't re-spawn on every focus change.
  const restoredWsIds = useRef(new Set<string>());
  // A workspace is hydrated once restore has written its live panes, or as
  // soon as it is created this session. saveWorkspace no-ops on anything
  // else: unrestored shells are empty, and writing one would wipe the blob.
  const hydratedWsIds = useRef(new Set<string>());
  // Restore finished with zero live panes. The blob stays the source of
  // truth until a later spawn succeeds; saveWorkspace then hydrates.
  const emptyRestoreIds = useRef(new Set<string>());
  // Budget set this session, including on a workspace restore has not finished.
  // Restore must not write parsed.budget over it.
  const budgetTouchedIds = useRef(new Set<string>());
  /** Every saved pane id seen this launch, mapped to the id it was respawned
   * with, across ALL workspaces. The per-workspace map inside a restore can
   * only resolve that workspace's own panes, and a borrowed leaf's id belongs
   * to a different one whose restore is lazy and may not have run. */
  const restoredIdsRef = useRef(new Map<string, string>());
  /** saveWorkspace is declared below restoreWorkspaceById, and the loan
   * re-attach sweep at the end of a restore has to persist what it resolved.
   * Same deferred-ref shape as reviewPrRef. */
  const saveWorkspaceRef = useRef<(ws: Workspace) => void>(() => {});
  // Ref mirroring workspaces — used by callbacks that need the latest array
  // without re-binding on every workspace change.
  const workspacesRef = useRef<Workspace[]>([]);

  /** For each workspace, the panes its tabs display but do not own, resolved
   *  against their real owners.
   *
   *  Derived from the `borrowed` ref lists rather than by scanning every tab's
   *  leaves for unknown ids: an id with no pane behind it is a ghost leaf that
   *  restore has not healed yet, and treating one as a loan would give it a
   *  tile that never resolves. A ref whose owner or pane is gone simply drops
   *  out here, which is what makes deleting the lending workspace leave the
   *  borrowing tab intact instead of taking it down.
   *
   *  Memoised on `workspaces` alone, so a status change in the LENDING
   *  workspace produces a new map and reaches the borrowing tile through
   *  PaneArea's comparator. Almost always empty. */
  const borrowedByWorkspace = useMemo(() => {
    const byId = new Map(workspaces.map((w) => [w.id, w]));
    const out = new Map<string, Map<string, BorrowedPane>>();
    for (const ws of workspaces) {
      let mine: Map<string, BorrowedPane> | undefined;
      for (const tab of ws.tabs) {
        for (const ref of tab.borrowed ?? []) {
          const owner = byId.get(ref.workspaceId);
          const pane = owner?.panes.find((p) => p.id === ref.paneId);
          if (!owner || !pane) continue;
          (mine ??= new Map()).set(ref.paneId, {
            pane,
            workspaceId: owner.id,
            workspaceName: owner.name,
            accentColor: owner.accentColor,
            secure: !!owner.secure,
          });
        }
      }
      if (mine) out.set(ws.id, mine);
    }
    return out;
  }, [workspaces]);
  // Cached graph MCP sidecar path, so spawns can auto-register it without a
  // per-spawn round trip. Refreshed on mount and whenever the graph toggle or
  // URL changes. The URL itself is read live via getGraphUrl() at spawn — a
  // cache filled once on mount left new agents writing to the previous
  // database after Settings pointed at the team graph.
  const mcpConfigRef = useRef<{ mcp_path: string | null; kg_url: string } | null>(null);
  // Same for the focused workspace: session-toast accept handlers must
  // resolve their target when the user clicks, not when the toast arrived.
  const focusedWsIdRef = useRef<string | null>(null);
  focusedWsIdRef.current = focusedWsId;

  // Owner-side ledger of live observe shares: session_id → the pane being
  // streamed. Without it, an observer closing their side would leave this
  // side publishing PTY bytes to Ably forever.
  const observeSharesRef = useRef(new Map<string, string>());

  /** The pane a friend's observe/task should land on, resolved at
   * accept time: the focused local (non-remote) pane of the focused
   * workspace, else its first local pane, else the first local pane
   * anywhere. Null means no agent is running at all. */
  const resolveShareTarget = useCallback((): { ws: Workspace; pane: Workspace["panes"][number] } | null => {
    const all = workspacesRef.current;
    const ordered = [
      ...all.filter((w) => w.id === focusedWsIdRef.current),
      ...all.filter((w) => w.id !== focusedWsIdRef.current),
    ];
    for (const ws of ordered) {
      const local = ws.panes.filter((p) => !p.streamId);
      if (local.length === 0) continue;
      const focused = local.find((p) => p.id === getFocusedTab(ws).focusedPaneId);
      return { ws, pane: focused ?? local[0] };
    }
    return null;
  }, []);

  // ─── Restore a single workspace's panes on demand ──────────────────

  const restoreWorkspaceById = useCallback(async (workspaceId: string) => {
    if (workspaceId.startsWith("copilot:") || workspaceId.startsWith("observe:")) return;
    if (restoredWsIds.current.has(workspaceId)) return;
    restoredWsIds.current.add(workspaceId);

    let parsed: any = {};
    try {
      const raw = await restoreWorkspace(workspaceId);
      if (!raw) {
        // No blob: nothing to clobber. Mark hydrated so later activity can persist.
        hydratedWsIds.current.add(workspaceId);
        return;
      }
      parsed = JSON.parse(raw);
    } catch (e) {
      // The blob exists but could not be read or parsed. Staying unhydrated is
      // the right half: writing the empty React shell over it would destroy the
      // only record of this workspace's panes and worktrees. Silence is the
      // wrong half — every later change to this workspace (a new pane, a
      // renamed tab, a budget) is dropped for the life of the install with
      // nothing on screen. So it is unhydrated *and* said out loud, once.
      console.error("could not read saved state for workspace", workspaceId, e);
      pushNotification({
        status: "failure",
        category: "agent",
        priority: true,
        text: `Couldn't read the saved state for ${workspacesRef.current.find((w) => w.id === workspaceId)?.name ?? "a workspace"} — it won't restore, and changes to it won't be saved. The saved copy is left untouched.`,
      });
      return;
    }

    const agentKind: AgentKind = parsed.agentKind ?? "claude";
    const useWorktrees: boolean = parsed.useWorktrees ?? false;
    // Absent on workspaces saved before the branch picker: those keep working
    // off `useWorktrees` alone and fall back to the legacy branch naming.
    const branchPlan: BranchPlan | undefined = parsed.branchPlan;
    const secure: boolean = parsed.secure ?? false;
    const prReview: boolean = parsed.prReview ?? false;
    const prReviewTarget: { repo: string; number: number } | undefined = parsed.prReviewTarget;
    // Absent on every workspace saved before budgets shipped, which reads
    // correctly as "no ceiling".
    const budget: Budget | undefined = parsed.budget;
    // PR-review workspaces keep their violet accent (and top-pinned position)
    // across restarts — the launch-time list assigns palette colors by index.
    const flags = prReview ? { prReview: true as const, accentColor: "var(--violet)", prReviewTarget } : {};
    const savedPanes: SavedPane[] = parsed.panes ?? [];

    // Saved state predating tabs has a single top-level layoutTree instead
    // of parsed.tabs — wrap it into one tab so old saves still restore.
    type SavedTab = { id: string; name: string; renamed?: boolean; layoutTree: LayoutNode | null; focusedPaneId: string | null; zoomedPaneId: string | null; race?: RaceState; borrowed?: BorrowedRef[] };
    const savedTabs: SavedTab[] = parsed.tabs ?? (
      parsed.layoutTree !== undefined
        ? [{ id: "tab-legacy", name: "1", layoutTree: parsed.layoutTree ?? null, focusedPaneId: parsed.focusedPaneId ?? null, zoomedPaneId: parsed.zoomedPaneId ?? null }]
        : []
    );

    if (savedPanes.length === 0) {
      setWorkspaces((prev) => prev.map((ws) => {
        if (ws.id !== workspaceId) return ws;
        const nextBudget = budgetTouchedIds.current.has(workspaceId) ? ws.budget : budget;
        return { ...ws, agentKind, useWorktrees, branchPlan, secure, budget: nextBudget, ...flags };
      }));
      hydratedWsIds.current.add(workspaceId);
      return;
    }

    const idMap = new Map<string, string>();

    // Reuse a saved displayName so a restart doesn't remint "Pluto" into
    // "Harry". Gaps still mint, and have to see the names already taken.
    // Chosen before spawn so the name rides into the pane's environment
    // (FLOCK_AGENT_NAME) for graph attribution.
    const agentNames = restoreDisplayNames(savedPanes, randomAgentName);

    // Restore panes in overlapping batches rather than one after another. This
    // used to await a session lookup, a spawn and a scrollback read per pane, so
    // a twelve-agent workspace paid twelve round trips before a single terminal
    // could mount — dead time on every launch, and dead time during which the
    // panes spawned first are already running. That second part is not just
    // slow, it loses things: a pane's replay ring holds a bounded tail, so an
    // agent that paints its startup while eleven more spawns go by can push the
    // boot marker out of its own ring before anything is watching for it.
    //
    // Through the same pool as a fresh grid, for the same two reasons: an
    // unbounded fan-out saturates the webview, and secure mode needs its first
    // container up before the rest race for the image. Nothing here depends on
    // another pane's result — names are settled above, and the ordered pass
    // below rebuilds the original order.
    // The graph args are NOT part of what a workspace saves. `saveWorkspace`
    // persists `agentCommand(p.kind).args` — the base launch flags — so a
    // restored pane came back with no `--mcp-config` and no
    // `--append-system-prompt`: no kg.* tools, no protocol, no workspace brief.
    // The UserPromptSubmit hook kept firing (it lives in settings.json, not in
    // the argv), so a restored agent was still handed a "flock Graph — prior
    // team knowledge" block ending in "kg.query for the rest" — pointing at
    // tools it no longer had. The write half of the graph died on the first
    // relaunch and nothing said so; only the read half kept up appearances.
    // Rebuilt here rather than saved because it embeds a live binary path and
    // the current brief, both of which go stale in a saved blob.
    //
    // One promise for the whole workspace, awaited per pane, exactly as the
    // grid path does it: the brief is keyed by workspace and costs up to 1.2s,
    // which twelve panes should pay once between them, not twelve times.
    const graphArgs = graphSpawnArgs(agentKind, workspaceId, secure);
    const restored = await spawnBatch(savedPanes, secure, async (sp, i) => {
      try {
        // Resume (feature C): claude reopens its exact conversation via
        // `--resume <sessionId>`, but ONLY when that session actually recorded
        // a conversation — resuming an id that was assigned to an idle,
        // never-chatted pane errors ("No conversation found with session ID").
        // When there's nothing to resume we spawn a *fresh* session id (so the
        // pane can be resumed after the next restart) and fall back to the
        // scrollback replay (A) for the visible history. `--continue` covers
        // legacy saves that predate per-pane ids.
        let args = sp.args;
        let selfResumes = false;
        let sessionId = sp.sessionId;
        // Per-agent resume: each claude pane carries its own --session-id, so a
        // workspace of 12 agents each resumes its OWN conversation (not the
        // "most recent" that -c/--continue would collide on). claudeSessionExists
        // finds the session by id no matter how claude encodes the cwd into its
        // project dir; when found we --resume it (claude repaints, so no
        // scrollback). Otherwise we (re)assign an id so it's resumable next time.
        //
        // grok takes the same two flags with the same meanings, and refuses a
        // `--resume` of a session that recorded nothing for the same reason,
        // so it takes the same branch rather than a copy of it.
        if (sp.cmd === "claude" || sp.cmd === "grok") {
          if (sp.sessionId && await claudeSessionExists(sp.cwd, sp.sessionId).catch(() => false)) {
            args = withClaudeSession(sp.args, sp.sessionId, "resume");
            selfResumes = true;
          } else {
            sessionId = sp.sessionId ?? crypto.randomUUID();
            args = withClaudeSession(sp.args, sessionId, "new");
          }
        } else if (sp.sessionId && sp.cmd === "opencode") {
          // Resume this pane's captured session (opencode replays its history).
          args = ["-s", sp.sessionId];
          selfResumes = true;
        } else if (sp.sessionId && sp.cmd === "codex") {
          // codex resumes via a subcommand (not a flag); use the bypass flag
          // that `codex resume` accepts rather than the top-level --yolo.
          args = ["resume", sp.sessionId, "--dangerously-bypass-approvals-and-sandbox"];
          selfResumes = true;
        }

        // claude only. opencode needs nothing per-spawn (its server and plugin
        // are installed globally), and codex's graph args are top-level `-c`
        // overrides whose behaviour behind the `resume` subcommand this restore
        // path uses is unverified — a restored codex pane keeps the argv that
        // is known to resume correctly rather than gaining tools it might not
        // start with.
        if (sp.cmd === "claude") args = [...args, ...(await graphArgs)];

        const agentName = agentNames[i];
        const pane = await spawnPane({ workspaceId, cmd: sp.cmd, args, cwd: sp.cwd, rows: 24, cols: 80, agentName, secure, graphEnabled: getGraphEnabled() });

        // Scrollback (feature A): hand the freshly spawned terminal its
        // pre-restart history to paint before going live, keyed by the new
        // pane id. Awaited (before the pane enters React state) so the value
        // is in place by the time Terminal mounts and reads it. Skipped for
        // agents that repaint themselves on resume.
        if (!selfResumes) {
          const bytes = await getPersistedPaneBuffer(sp.id).catch(() => [] as number[]);
          if (bytes.length > 0) setRestoreHistory(pane.id, new Uint8Array(bytes));
        }

        return {
          savedId: sp.id,
          pane: {
            id: pane.id,
            workspaceId,
            kind: pane.kind,
            status: pane.status as AgentStatusStr,
            attention: false,
            displayName: agentName,
            cwd: sp.cwd,
            worktree: sp.worktree,
            sessionId,
            intent: sp.intent,
            intentRaw: sp.intentRaw,
            promptHistory: sp.promptHistory,
            model: sp.model,
            // A restored pane boots exactly like a fresh one — same login
            // shell, same echoed `eval "$FLOCK_LAUNCH"`, same wait for the
            // agent to paint — so it needs the same card over it. Without this
            // the one path every user hits on every launch was the one path
            // that showed the plumbing, on top of the restored scrollback
            // painted beneath it.
            booting: true,
          },
        };
      } catch (e) { console.error("restore pane failed", e); return null; }
    });

    // Back into saved order: the layout tree is remapped from these ids, and
    // livePanes[0] is the PR-review pane below. A pane that failed to spawn is
    // dropped here exactly as the sequential loop dropped it — absent from
    // idMap, so remapLayoutTree prunes its leaf.
    const livePanes: Workspace["panes"] = [];
    for (const r of restored) {
      if (!r) continue;
      idMap.set(r.savedId, r.pane.id);
      // The same mapping, accumulated across every workspace's restore. A
      // borrowed leaf's old id was minted by ANOTHER workspace, so the local
      // map can never resolve it; restore is lazy, so that workspace may not
      // even have woken up yet. This is what lets a loan be resolved later
      // instead of being pruned as a ghost and lost for good.
      restoredIdsRef.current.set(r.savedId, r.pane.id);
      livePanes.push(r.pane);
    }

    // Re-arm review-summary tracking on the restored review pane — the
    // in-memory map died with the previous app instance, and without this a
    // review that finishes after a restart never reaches the PR modal.
    if (prReview && prReviewTarget && livePanes[0]) {
      reviewPanesRef.current.set(livePanes[0].id, prReviewTarget);
    }

    const liveIds = new Set(livePanes.map((p) => p.id));
    const tabs: WorkspaceTab[] = savedTabs.length > 0
      ? savedTabs.map((st) => {
          // Remapped through the union of every restore so far, not just this
          // workspace's own idMap: a borrowed leaf's saved id was minted by
          // its LENDER, so when the lender restored first, only the global map
          // can rename that leaf to the pane's new id. Remapping with the
          // local map alone left the leaf on its old id while the prune's
          // `visible` set held the new one — the resolved loan was pruned as a
          // ghost, and the borrowed tile silently vanished on every launch
          // where the lender came up before the borrower. Local entries are in
          // both maps, so the union changes nothing for the tab's own panes.
          const ids = new Map([...restoredIdsRef.current, ...idMap]);
          const remapped = st.layoutTree && ids.size > 0 ? remapLayoutTree(st.layoutTree, ids) : null;
          // Prune ghost leaves — saved layouts written while a stale-tree
          // race was live can reference panes with no record behind them.
          // remapLayoutTree keeps unknown IDs verbatim, so without this the
          // ghosts render as blank uncloseable panes forever.
          // Loans, resolved against every workspace restored so far. What
          // resolves is spared from the prune below; what does not is carried
          // forward untouched and re-attached by the sweep after its lender
          // comes up. Neither half may be dropped here.
          const { resolved, pending } = remapBorrowed(st.borrowed, restoredIdsRef.current);
          const visible = new Set(liveIds);
          for (const r of resolved) visible.add(r.paneId);
          const layoutTree = remapped ? pruneLayoutTree(remapped, visible) : null;
          // Fall back to the tab's own first pane whenever the saved focus
          // is missing or its pane failed to restore — leaving focusedPaneId
          // null here (even though the tab has a live pane) is what makes
          // split() and the header split buttons silently no-op after a
          // restart, looking like "can't add agents" on a 1-agent workspace.
          const mappedFocus = st.focusedPaneId ? idMap.get(st.focusedPaneId) : undefined;
          return {
            id: st.id,
            name: st.name,
            renamed: st.renamed,
            // Carried verbatim, no id remapping: a race identifies its
            // contenders by worktree path precisely so it can survive this
            // (see RaceContender). The panes below are respawned into those
            // same cwds, so contenderState finds them again.
            race: st.race,
            layoutTree,
            focusedPaneId: layoutTree ? (mappedFocus ?? firstPaneId(layoutTree)) : null,
            zoomedPaneId: st.zoomedPaneId ? (idMap.get(st.zoomedPaneId) ?? null) : null,
            borrowed: [...resolved, ...pending],
          };
        })
      : [makeTab("1")];

    // Panes that were popped out into their own window when the state was
    // saved exist in the pane list but in no tab's layout. Popout windows
    // don't survive a restart, so left alone these respawn as phantom
    // "popped out" agents with no window behind them — fold them into the
    // first tab instead.
    const inSomeTab = new Set(tabs.flatMap((t) => t.layoutTree ? allPaneIds(t.layoutTree) : []));
    for (const pane of livePanes) {
      if (inSomeTab.has(pane.id)) continue;
      const t = tabs[0];
      const target = t.focusedPaneId ?? (t.layoutTree ? firstPaneId(t.layoutTree) : null);
      t.layoutTree = t.layoutTree && target
        ? split(t.layoutTree, target, "horizontal", pane.id)
        : { type: "leaf", paneId: pane.id };
      t.focusedPaneId = t.focusedPaneId ?? pane.id;
    }

    const focusedTabId: string = parsed.focusedTabId && tabs.some((t) => t.id === parsed.focusedTabId)
      ? parsed.focusedTabId
      : tabs[0].id;

    setWorkspaces((prev) => prev.map((ws) => {
      if (ws.id !== workspaceId) return ws;
      const nextBudget = budgetTouchedIds.current.has(workspaceId) ? ws.budget : budget;
      return { ...ws, agentKind, useWorktrees, branchPlan, secure, budget: nextBudget, ...flags, panes: livePanes, tabs, focusedTabId };
    }));
    // Only after live panes are in state. A failed spawnBatch leaves the
    // blob alone so a later save cannot write the empty shell over it — and,
    // like an unreadable blob above, says so rather than going quiet: a
    // workspace that saved twelve panes and restored none is a Docker daemon
    // that is not running, not a workspace that is now empty.
    if (livePanes.length > 0) {
      hydratedWsIds.current.add(workspaceId);
    } else {
      emptyRestoreIds.current.add(workspaceId);
      pushNotification({
        status: "failure",
        category: "agent",
        priority: true,
        text: `None of the ${savedPanes.length} saved agents in ${workspacesRef.current.find((w) => w.id === workspaceId)?.name ?? "a workspace"} could be started. Its saved layout is left untouched — changes won't be saved until one starts.`,
      });
    }

    // This workspace's panes now have ids, so a loan some OTHER workspace was
    // still waiting on can finally be resolved. Restore is lazy and ordered by
    // whatever the user focuses, so the lender routinely comes up after the
    // borrower and this is the only pass that can close that gap.
    //
    // The leaf is appended rather than restored to its saved position: its
    // place in the tree was pruned when the loan could not be resolved, and
    // reserving a hole for a pane that might never arrive would leave a dead
    // rectangle in the grid on every launch where the lender was deleted.
    setWorkspaces((prev) => {
      let touched = false;
      const next = prev.map((ws) => {
        if (ws.id === workspaceId) return ws;
        if (!ws.tabs.some((t) => (t.borrowed ?? []).length > 0)) return ws;
        let wsTouched = false;
        const tabs = ws.tabs.map((t) => {
          const { resolved, pending } = remapBorrowed(t.borrowed, restoredIdsRef.current);
          if (resolved.length === 0) return t;
          let tree = t.layoutTree;
          for (const r of resolved) tree = appendLeaf(tree, r.paneId);
          wsTouched = true;
          return { ...t, layoutTree: tree, borrowed: [...resolved, ...pending] };
        });
        if (!wsTouched) return ws;
        touched = true;
        return { ...ws, tabs };
      });
      if (touched) for (const ws of next) if (ws.tabs.some((t) => (t.borrowed ?? []).length > 0)) saveWorkspaceRef.current(ws);
      return touched ? next : prev;
    });
  }, []);

  // Restore when the focused workspace changes (lazy, on-demand).
  useEffect(() => {
    if (focusedWsId) restoreWorkspaceById(focusedWsId);
  }, [focusedWsId, restoreWorkspaceById]);

  // Keep the imperative mirror current during render, rather than in an
  // effect. A pane can be closed and the empty-workspace Spawn button clicked
  // before effects flush; using the effect left that click resolving an old
  // workspace snapshot (with already-closed panes/layout) and made the spawn
  // path appear to do nothing.
  workspacesRef.current = workspaces;

  const focusedWs = workspaces.find((w) => w.id === focusedWsId);
  const focusedRepoPath = focusedWs && !focusedWs.copilot && !focusedWs.observe ? focusedWs.repo_path : null;

  // Every ordered rendering of the workspace list (the sidebar switcher is
  // the only one — the PaneArea stack and status bar are order-independent)
  // goes through this derived view: PR-review workspaces pinned on top,
  // everything else in stored order. The state array itself is never
  // re-sorted, so persistence order stays stable.
  const displayWorkspaces = useMemo(() => orderForDisplay(workspaces), [workspaces]);

  // GitHub connection + open PRs + CI checks for the focused repo (all
  // polling and the integration toggle live in the hook).
  const { ghStatus, pullRequests, prError, wsChecks, refreshGh } = useGithubPrs(focusedRepoPath);

  // Agents currently blocked on the user (live status, not logged events) —
  // the notification pill reflects this over a stale "is working" event, since
  // "needs input" is what the user actually has to act on right now.
  const attentionAgents = workspaces.flatMap((w) =>
    w.panes
      .filter((p) => p.status === "awaiting_input" || p.status === "blocked")
      .map((p) => ({ workspaceId: w.id, paneId: p.id, name: p.displayName ?? "Agent", workspaceName: w.name })),
  );

  // Live tally behind the notification pill's fallback headline, so it states
  // what is true now rather than replaying the last thing that happened.
  const agentTally = workspaces.reduce(
    (acc, w) => {
      for (const p of w.panes) {
        acc.total += 1;
        if (p.status === "working") acc.working += 1;
      }
      return acc;
    },
    { working: 0, total: 0 },
  );

  // ─── Notification watchers ───────────────────────────────────────────
  // The log itself lives in useNotifications; these effects decide when a
  // domain event (PR checks, new PRs, agent hooks) becomes a notification.

  // Log a notification whenever the focused PR's overall check status
  // actually changes (not on every poll — only on transitions).
  const prevChecksOverall = useRef<string | null>(null);
  useEffect(() => {
    if (!wsChecks || wsChecks.checks.length === 0) {
      prevChecksOverall.current = null;
      return;
    }
    const overall = overallCheckStatus(wsChecks.checks);
    if (prevChecksOverall.current !== null && prevChecksOverall.current !== overall && overall !== "running") {
      pushNotification({
        status: overall,
        category: "pr",
        priority: true,
        text: `#${wsChecks.pr_number} checks ${overall === "success" ? "passed" : "failed"} — ${wsChecks.pr_title}`,
        url: wsChecks.pr_url,
      });
    }
    prevChecksOverall.current = overall;
  }, [wsChecks, pushNotification]);

  // Log a notification and raise a toast for newly-opened PRs. All new PRs
  // share a single toast with one tab per PR (a burst of agent-created PRs
  // must not stack up a wall of toasts); accepting reviews the active tab's
  // PR. The seen-set is keyed to the repo so switching workspaces — which
  // empties and refills the PR list — re-seeds silently instead of
  // re-announcing every open PR. The ref indirection exists because
  // reviewPr is defined further down and recreated each render — a toast
  // stored in state must not close over a stale copy.
  const seenPrs = useRef<{ repoPath: string | null; nums: Set<number> | null }>({ repoPath: null, nums: null });
  const reviewPrRef = useRef<(pr: PullRequest, sourceOverride?: Workspace) => Promise<void> | void>(() => {});
  // Guards "Review all PRs" against a double-click stampede — it fans out one
  // agent per PR, so a second click before the first finishes would spawn a
  // duplicate set.
  const reviewAllInFlightRef = useRef(false);
  useEffect(() => {
    const current = new Set(pullRequests.map((p) => p.number));
    if (seenPrs.current.repoPath !== focusedRepoPath) {
      seenPrs.current = { repoPath: focusedRepoPath, nums: pullRequests.length > 0 ? current : null };
      return;
    }
    if (seenPrs.current.nums === null) {
      if (pullRequests.length > 0) seenPrs.current.nums = current;
      return;
    }
    const newPrs = pullRequests.filter((p) => !seenPrs.current.nums!.has(p.number));
    seenPrs.current.nums = current;
    if (newPrs.length === 0) return;
    for (const pr of newPrs) {
      pushNotification({
        status: "info",
        category: "pr",
        priority: true,
        text: `PR #${pr.number} opened — ${pr.title}`,
        url: `https://github.com/${pr.repo}/pull/${pr.number}`,
      });
    }
    const tabs = newPrs.map((pr) => ({
      label: `#${pr.number}`,
      title: pr.title,
      author: pr.author,
      onAccept: () => reviewPrRef.current(pr),
    }));
    // Notifications for each new PR were pushed above and are unaffected; this
    // only decides whether one also interrupts.
    if (isToastSuppressed("pr_opened")) return;
    setSessionToasts((prev) => {
      const existing = prev.find((t) => t.kind === "pr_opened");
      if (existing) {
        const have = new Set((existing.tabs ?? []).map((t) => t.label));
        const merged = [...(existing.tabs ?? []), ...tabs.filter((t) => !have.has(t.label))];
        return prev.map((t) => (t === existing ? { ...t, tabs: merged } : t));
      }
      return [...prev, {
        id: `pr-opened-${Date.now()}`,
        kind: "pr_opened" as const,
        fromLogin: newPrs[0].author,
        sessionId: "",
        tabs,
        onAccept: () => {},
        onDecline: () => {},
      }];
    });
  }, [pullRequests, focusedRepoPath, pushNotification]);

  // Log a notification for each agent-hook event (Claude Code / Codex —
  // see Settings → Integrations). No URL since these aren't web resources —
  // instead they carry workspaceId/paneId so clicking one jumps to the pane.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    onHookEvent((e) => {
      const ws = workspacesRef.current.find((w) => w.panes.some((p) => p.id === e.pane_id));
      const pane = ws?.panes.find((p) => p.id === e.pane_id);
      // Ours or nobody's. The hook writes to one machine-wide
      // ~/.flock/hooks.jsonl and every running instance tails all of it, so a
      // second flock (a `tauri dev` build beside the installed app) sees every
      // event for panes it never spawned. Notifying about a stranger's agent is
      // noise; counting its prompt is worse, because that instance may be
      // signed into a different flock ID and the prompt lands on both accounts.
      if (!ws || !pane) return;
      const name = pane.displayName ?? "Agent";
      const hookAgentLabel = e.agent === "claude" ? "Claude Code" : "Codex";
      const paneRef = { workspaceId: ws.id, paneId: pane.id };
      // The context subline: what the pane is working on (its sniffed/
      // summarized intent) if we have it, otherwise where it lives (workspace ·
      // agent kind). Truncated so a long prompt can't blow out the row.
      const on = pane.intent?.trim();
      const intentDetail = on ? (on.length > 80 ? `${on.slice(0, 79)}…` : on) : undefined;
      const place = [ws.name, hookAgentLabel].filter(Boolean).join(" · ");
      switch (e.event) {
        case "SessionStart":
          pushNotification({ status: "info", category: "agent", priority: false, text: `${name} started`, detail: place, ...paneRef });
          break;
        case "UserPromptSubmit":
          pushNotification({ status: "running", category: "agent", priority: false, text: `${name} is working`, detail: intentDetail ?? place, ...paneRef });
          // One prompt submitted to an agent — the headline social stat.
          recordUsage({ prompts: 1 });
          break;
        case "Stop":
          pushNotification({ status: "success", category: "agent", priority: false, text: intentDetail ? `${name} finished` : `${name} finished responding`, detail: intentDetail ?? place, ...paneRef });
          break;
        case "Notification":
          // Two very different events share this hook. "Claude is waiting for
          // your input" is a nudge fired a minute after an agent goes quiet —
          // not news, and the Stop above already logged that it finished, so
          // it gets no row and no dot. Anything else is a real ask.
          if (e.message?.includes("waiting for your input")) break;
          pushNotification({ status: "info", category: "agent", priority: true, text: `${name} needs your attention`, detail: place || undefined, ...paneRef });
          break;
      }
    }).then((fn) => (unlisten = fn));
    return () => unlisten?.();
  }, [pushNotification]);

  // ─── Init ──────────────────────────────────────────────────────────

  useEffect(() => {
    (async () => {
      const [list, dir] = await Promise.all([listWorkspaces(), getCwd()]);
      setCwd(dir);
      // Show all workspaces in the sidebar immediately — panes restore lazily
      // when each workspace is focused for the first time.
      setWorkspaces(list.map((w, i) => {
        const tab = makeTab("1");
        return {
          ...w,
          accentColor: workspaceColor(i),
          panes: [],
          tabs: [tab],
          focusedTabId: tab.id,
          agentKind: "claude" as AgentKind,
        };
      }));
      if (list.length > 0) setFocusedWsId(list[0].id);
      // GitHub status, open PRs and friends are owned by useGithubPrs /
      // useFlockId — nothing else to bootstrap here.
      queueList().then(setQueueItems).catch(console.error);
      // Peek each saved blob for the prReview flag (a cheap read — the real
      // pane restore stays lazy) so PR-review workspaces are pinned on top
      // and violet from launch, not only once they're first focused.
      Promise.all(list.map(async (w) => {
        const prReview = await restoreWorkspace(w.id)
          .then((raw) => (raw ? !!JSON.parse(raw).prReview : false))
          .catch(() => false);
        return { id: w.id, prReview };
      })).then((flags) => {
        const flagged = new Set(flags.filter((f) => f.prReview).map((f) => f.id));
        if (flagged.size === 0) return;
        setWorkspaces((prev) => prev.map((w) =>
          flagged.has(w.id) ? { ...w, prReview: true, accentColor: "var(--violet)" } : w,
        ));
      }).catch(() => {});
    })();
  }, []);

  // Stored review summaries survive restarts backend-side; hydrate once so
  // the PR modal can show "AGENT REVIEW" cards immediately.
  useEffect(() => {
    prReviewGetSummaries().then(setPrSummaries).catch(() => {});
    // Same for the merge queue — the poll below only ticks a *known*
    // non-empty queue, so it has to be primed after a restart.
    mergeQueueList().then((q) => { mergeQueueRef.current = q; setMergeQueue(q); }).catch(() => {});
  }, []);

  // Mirror the active flock ID org/team into the local graph on sign-in
  // and whenever the selection changes (Settings → Teams), so spawned agents
  // carry FLOCK_ORG_ID/TEAM_ID. Best-effort; a down engine retries on the
  // next change or launch.
  useEffect(() => {
    if (!idProfile?.id) return;
    void syncActiveTeamMirror();
    return onActiveTeamChange(() => void syncActiveTeamMirror());
  }, [idProfile?.id]);

  // ─── Prompt queue ──────────────────────────────────────────────────

  // Fire a queued prompt into a chosen pane. The returned row is authoritative
  // ("launched" + snapshotted target); the notification is the reliable "did it
  // land" signal (a background/popped-out pane can't show the DOM image pill).
  const launchQueueItem = async (id: string, paneId: string) => {
    try {
      const { row, typed } = await queueLaunch(id, paneId);
      // The backend wrote straight to the PTY, so mirror it into the pane's
      // input-line sniffer — otherwise a follow-up "Send to Prompt Queue"
      // would ignore the prompt that's sitting there.
      noteInjectedInput(paneId, typed);
      setQueueItems((prev) => prev.map((i) => (i.id === row.id ? row : i)));
      pushNotification({ status: "info", category: "agent", priority: false, text: `Launched into ${row.target_label ?? "pane"}` });
    } catch (e) {
      pushNotification({ status: "failure", category: "agent", priority: true, text: `Couldn't launch prompt: ${e instanceof Error ? e.message : e}` });
    }
  };

  // Right-click → "Send to Prompt Queue": lift whatever's typed into the pane's
  // input box (but not yet submitted) into the personal queue, then clear the
  // line. Persist first — only wipe the input once the row is safely saved so a
  // backend hiccup can't eat the user's draft.
  const sendInputLineToQueue = async (paneId: string) => {
    const line = getInputLine(paneId).trim();
    if (!line) return;
    try {
      // An attached screenshot is a `.flock/images/…` path in the line;
      // carry the bytes into the queue item so relaunching it anywhere re-stages
      // the real image instead of typing a path from another workspace.
      const cwd = workspacesRef.current.flatMap((w) => w.panes).find((p) => p.id === paneId)?.cwd ?? "";
      const { text, images } = await detachStagedImages(line, cwd);
      const item = await queueAdd(text, images);
      setQueueItems((prev) => [...prev, item]);
      const clear = clearInputLineBytes(paneId);
      if (clear) sendInput(paneId, clear).catch(console.error);
      const shot = images.length > 1 ? `${images.length} images` : "1 image";
      const detail = images.length === 0 ? queuePreview(text)
        : text ? `${queuePreview(text)} · ${shot}` : shot;
      pushNotification({ status: "info", category: "agent", priority: false, text: "Saved to prompt queue", detail });
    } catch (e) {
      pushNotification({ status: "failure", category: "agent", priority: true, text: `Couldn't queue prompt: ${e instanceof Error ? e.message : e}` });
    }
  };

  // Reuse the generic context-menu popover as the launch-target picker — a flat
  // cross-workspace list of live panes, computed at open time.
  const openQueueLaunchPicker = (item: QueueItem, e: React.MouseEvent) => {
    const targets = workspaces.flatMap((w) =>
      w.panes.map((p) => ({ paneId: p.id, label: `${w.name} · ${p.displayName ?? p.kind}` })),
    );
    if (targets.length === 0) {
      pushNotification({ status: "failure", category: "agent", priority: true, text: "No running panes to launch into — open a workspace first." });
      return;
    }
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      items: targets.map((t) => ({ label: t.label, onClick: () => void launchQueueItem(item.id, t.paneId) })),
    });
  };

  // Optimistic edit/delete: apply locally, then persist. The backend rejects
  // edits to already-launched rows on its own; on any failure we re-read to
  // reconcile rather than leaving the UI out of sync.
  const editQueueItem = (id: string, text: string) => {
    setQueueItems((prev) => prev.map((i) => (i.id === id ? { ...i, text } : i)));
    queueUpdateText(id, text).catch((err) => {
      console.error(err);
      queueList().then(setQueueItems).catch(console.error);
    });
  };

  const deleteQueueItem = (id: string) => {
    setQueueItems((prev) => prev.filter((i) => i.id !== id));
    queueDelete(id).catch((err) => {
      console.error(err);
      queueList().then(setQueueItems).catch(console.error);
    });
  };

  // Claude and grok each get a stable per-pane session id (via `--session-id`)
  // at spawn, so an exact conversation can be resumed with `--resume` after a
  // restart. Both take a UUID they did not choose, which is what makes a pane's
  // transcript findable later — the meter, the spend attribution and the resume
  // all hang off it. opencode continues via its own `-c`, and codex relies on
  // the replayed scrollback (feature A).
  const IMPOSED_SESSION_KINDS: AgentKind[] = ["claude", "grok"];

  const newClaudeSessionId = (kind: AgentKind): string | undefined =>
    IMPOSED_SESSION_KINDS.includes(kind) ? crypto.randomUUID() : undefined;

  const withClaudeSession = (
    args: string[],
    sessionId: string | undefined,
    mode: "new" | "resume",
  ): string[] =>
    sessionId ? [...args, mode === "resume" ? "--resume" : "--session-id", sessionId] : args;

  // ─── Persistence ───────────────────────────────────────────────────

  const saveWorkspace = useCallback((ws: Workspace) => {
    if (!shouldPersistWorkspace(ws, hydratedWsIds.current)) {
      if (!shouldHydrateAfterEmptyRestore(ws, hydratedWsIds.current, emptyRestoreIds.current)) return;
      // Restore spawned nothing; this save is the first live pane. Persist
      // now so later work is not dropped on quit.
      hydratedWsIds.current.add(ws.id);
      emptyRestoreIds.current.delete(ws.id);
    }
    saveWorkspaceStateCmd(ws.id, JSON.stringify(buildWorkspaceStateBlob(ws))).catch(console.error);
  }, []);
  saveWorkspaceRef.current = saveWorkspace;

  const saveAllWorkspaces = useCallback(() => {
    for (const ws of workspaces) {
      saveWorkspace(ws);
    }
  }, [workspaces, saveWorkspace]);

  /** Set (or clear, with undefined) a workspace's spend ceiling. An unrestored
   * shell must not be written: patch the existing blob instead, and only after
   * a successful read — a failed restoreWorkspace is not "no blob". Once
   * hydrated, React is the source of truth and saveWorkspace has the live panes. */
  const setWorkspaceBudget = useCallback((workspaceId: string, budget: Budget | undefined) => {
    budgetTouchedIds.current.add(workspaceId);
    let updated: Workspace | undefined;
    setWorkspaces((prev) => prev.map((w) => {
      if (w.id !== workspaceId) return w;
      return updated = { ...w, budget };
    }));
    if (!updated) return;
    if (hydratedWsIds.current.has(workspaceId)) {
      saveWorkspace(updated);
      return;
    }
    restoreWorkspace(workspaceId)
      .then((raw) => saveWorkspaceStateCmd(workspaceId, patchSavedBudget(raw, budget)))
      .catch(console.error);
  }, [saveWorkspace]);

  // Budget approach/breach notifications. Reads the same polled spend the
  // status-bar chip does, so watching costs one transcript scan a minute for
  // the whole app rather than one per surface.
  useBudgetAlerts(workspaces, pushNotification);

  // Save on close
  useEffect(() => {
    const handler = () => { saveAllWorkspaces(); persistPaneBuffers().catch(() => {}); };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [saveAllWorkspaces]);

  // Periodically snapshot each pane's scrollback to SQLite so an agent's
  // on-screen history survives even a hard quit (beforeunload isn't
  // guaranteed to fire on a Tauri window close). Buffers change constantly,
  // so this runs on its own cadence rather than only on layout mutations.
  //
  // Deliberately NOT gated on isWindowActive, unlike the polls that only feed
  // the UI. This is the durability path, and a hidden window is exactly when
  // it earns its keep: agents keep writing while the user is elsewhere, and
  // that is also when a crash or a forced quit costs the most. The Rust side
  // already skips any pane whose ring hasn't advanced (PaneOutput's
  // persisted_pushed), so an idle background app writes nothing anyway.
  useEffect(() => {
    const id = setInterval(() => { persistPaneBuffers().catch(() => {}); }, 15000);
    return () => clearInterval(id);
  }, []);

  // Keep the git UI in sync with what's actually checked out. One repo-map
  // call per workspace fetches every worktree's live branch (plus dirty and
  // ahead/behind) and every local branch — from that we refresh the
  // workspace's displayed branch AND each pane's worktree branch, so an
  // agent running `git checkout` inside its own worktree self-heals here
  // instead of leaving a stale label. Polled; also called directly after
  // checkouts from the branch picker.
  const refreshBranches = useCallback(async () => {
    const reals = workspacesRef.current.filter((w) => !w.copilot && !w.observe && w.repo_path);
    const resolved = await Promise.all(
      reals.map(async (w) => ({ id: w.id, map: await gitRepoMap(w.repo_path).catch(() => null) })),
    );
    const maps = new Map(resolved.filter((r) => r.map?.is_repo).map((r) => [r.id, r.map as RepoMap]));
    if (maps.size === 0) return;

    setRepoMaps((prev) => {
      const next = { ...prev };
      for (const [id, map] of maps) next[id] = map;
      return next;
    });

    setWorkspaces((prev) => {
      let anyChanged = false;
      const next = prev.map((w) => {
        const map = maps.get(w.id);
        if (!map) return w;
        const main = map.worktrees.find((t) => t.is_main);
        const liveBranch = main ? main.branch || (main.head ? `detached@${main.head}` : "") : "";
        const byPath = new Map(map.worktrees.map((t) => [t.path, t]));
        let changed = false;
        const panes = w.panes.map((p) => {
          const wt = p.worktree ? byPath.get(p.worktree.path) : undefined;
          if (wt && wt.branch && wt.branch !== p.worktree?.branch) {
            changed = true;
            return { ...p, worktree: { path: p.worktree!.path, branch: wt.branch } };
          }
          return p;
        });
        if (liveBranch && liveBranch !== w.branch) changed = true;
        if (!changed) return w;
        anyChanged = true;
        return { ...w, branch: liveBranch || w.branch, panes };
      });
      // Nothing actually moved this pass → keep the same array so the poll
      // doesn't re-render the whole app every 10s when branches are stable.
      return anyChanged ? next : prev;
    });
  }, []);

  useEffect(() => {
    refreshBranches();
    // Pause the git subprocess scans while the app is hidden; refresh once the
    // moment it's visible again so branch labels are never stale on return.
    const id = setInterval(() => { if (isWindowActive()) refreshBranches(); }, 10000);
    const unsub = onWindowActiveChange((active) => { if (active) refreshBranches(); });
    return () => { clearInterval(id); unsub(); };
  }, [refreshBranches, workspaces.length]);

  // Locate the graph MCP sidecar so spawns can auto-register it without a
  // per-spawn round trip. Cheap (no docker probe); usage stays gated on the
  // graph being enabled.
  // The URL matters as much as the path. Called bare, `graph_mcp_config`
  // returns the *local* engine's connection string, so a team pointed at a
  // hosted graph (Settings → Graph → Team graph) had its agents registered
  // against 127.0.0.1:15432 while the app itself read the shared database —
  // the app saw a team's memory and every agent wrote into an empty local one.
  // Refresh on every graph toggle/URL change (`setGraphUrl` re-fires this
  // event): a cache filled only at mount kept writing to the previous
  // database after Settings pointed at the team graph.
  useEffect(() => {
    const refreshMcp = () =>
      graphMcpConfig(getGraphUrl()).then((cfg) => { mcpConfigRef.current = cfg; }).catch(() => {});
    const sync = (enabled: boolean) => {
      refreshMcp();
      graphGroundHook(enabled, getGraphUrl() || undefined).catch(() => {});
    };
    sync(getGraphEnabled());
    return onGraphEnabledChange(sync);
  }, []);

  // opencode/codex mint their own session ids (unlike claude, which takes an
  // imposed --session-id), so we can't know a pane's session up front. Once
  // the agent has recorded a session, look it up by cwd and latch it onto the
  // pane, so a restart resumes THIS agent's conversation — even with several
  // agents sharing one directory. `paneSeenRef` remembers roughly when we
  // first saw each pane, so we never claim a stale pre-existing session.
  const paneSeenRef = useRef<Map<string, number>>(new Map());
  const captureSessions = useCallback(async () => {
    const live = workspacesRef.current
      .filter((w) => !w.copilot && !w.observe)
      .flatMap((w) => w.panes.map((p) => ({ p, wsId: w.id })));
    const claimed = new Set(live.map((x) => x.p.sessionId).filter(Boolean) as string[]);
    for (const { p, wsId } of live) {
      if (p.sessionId || !p.cwd) continue;
      if (p.kind !== "opencode" && p.kind !== "codex") continue;
      let after = paneSeenRef.current.get(p.id);
      if (after === undefined) { after = Date.now(); paneSeenRef.current.set(p.id, after); }
      const id = await captureAgentSession(p.kind, p.cwd, after, [...claimed]).catch(() => null);
      if (!id) continue;
      claimed.add(id);
      paneSeenRef.current.delete(p.id);
      let updated: Workspace | undefined;
      setWorkspaces((prev) => prev.map((w) => {
        if (w.id !== wsId) return w;
        return (updated = { ...w, panes: w.panes.map((x) => x.id === p.id ? { ...x, sessionId: id } : x) });
      }));
      if (updated) saveWorkspace(updated); // persist the id so restart can resume
    }
  }, [saveWorkspace]);
  // Also deliberately ungated: an opencode or codex pane mints its session id
  // whenever the agent gets round to it, including while the window is hidden,
  // and a missed latch means that agent's conversation is not resumed on the
  // next launch. The tick is near-free when there is nothing to claim — it
  // walks the pane list and returns without an IPC call for every pane that
  // already has a session id, which after the first minute is all of them.
  useEffect(() => {
    const t = setInterval(() => { captureSessions().catch(() => {}); }, 8000);
    return () => clearInterval(t);
  }, [captureSessions]);

  // ─── Workspace ops ─────────────────────────────────────────────────

  const beginNewWorkspace = () => {
    setDialog({ kind: "new-workspace" });
  };

  // One planned pane: everything needed to spawn a PTY, with a client-generated
  // id so the box can be rendered (as a `spawning:true` placeholder) before the
  // backend pane exists.
  type PaneDescriptor = { paneId: string; cwd: string; worktree?: { path: string; branch: string }; agentName: string; sessionId?: string;
    /** Repo whose setup command should run in this pane, set only when its
     * worktree was created just now (see resolveNewPaneCwd's `fresh`). */
    setupRepo?: string };

  // Spawn a batch of already-rendered placeholder panes IN PARALLEL, flipping
  // each `spawning:false` (so its terminal mounts) the moment its PTY is live,
  // and removing any pane whose spawn fails. Returns how many succeeded.
  //
  // This is the fix for the "12 agents takes ~5s and freezes" problem: the old
  // grid paths awaited each spawn in a sequential loop and rendered nothing
  // until all had booted, then mounted every xterm at once. Here the grid is
  // already on screen (placeholders) and the spawns overlap, so total time is
  // roughly one spawn rather than N, and terminals mount staggered as each
  // process comes up instead of all in one main-thread-blocking burst.
  const spawnGridPanes = async (
    workspaceId: string,
    cmd: string,
    baseArgs: string[],
    kind: AgentKind,
    secure: boolean | undefined,
    ptyRows: number,
    ptyCols: number,
    descriptors: PaneDescriptor[],
    /** Per-pane work that has to happen before its PTY can start (cutting its
     * worktree, waiting on the shared fetch). Runs inside the pool, so a pane
     * whose turn came up spawns while the next one is still being prepared —
     * rather than every pane waiting on the slowest one. Never throws: a pane
     * that can't be prepared falls back to the shared checkout.
     *
     * This used to be a sequential loop on the belief that `git worktree add`
     * serializes on the repo's index lock. It doesn't — each worktree gets its
     * own index, and six concurrent adds on this repo measured 0.37s against
     * 1.1s one after another. */
    prepare?: (d: PaneDescriptor) => Promise<void>,
  ): Promise<number> => {
    // One graph brief per workspace, not per pane: it's keyed by workspace id,
    // so N panes were paying the same (up to 1.2s) wait N times over. Started
    // here so it overlaps with everything `prepare` does.
    const extraArgs = graphSpawnArgs(kind, workspaceId, secure);
    const spawnOne = async (d: PaneDescriptor): Promise<boolean> => {
      try {
        if (prepare) await prepare(d);
        await spawnPane({
          paneId: d.paneId,
          workspaceId,
          cmd,
          args: [...withClaudeSession(baseArgs, d.sessionId, "new"), ...(await extraArgs)],
          cwd: d.cwd,
          rows: ptyRows,
          cols: ptyCols,
          agentName: d.agentName,
          secure,
          graphEnabled: getGraphEnabled(),
          setupRepo: d.setupRepo,
        });
        // The PTY is live, so the terminal can mount and take over sizing it.
        // Still `booting` though: what it shows until the agent announces
        // itself is flock's own plumbing, and the card stays over it.
        setWorkspaces((prev) =>
          prev.map((w) =>
            w.id !== workspaceId
              ? w
              : { ...w, panes: w.panes.map((p) => (p.id === d.paneId ? { ...p, spawning: false, booting: true } : p)) }),
        );
        return true;
      } catch (e) {
        pushNotification({ status: "failure", category: "agent", priority: true, text: `Couldn't spawn ${cmd}: ${e instanceof Error ? e.message : e}` });
        // Remove the failed placeholder from both the pane list and the layout
        // so no dead box is left behind.
        setWorkspaces((prev) =>
          prev.map((w) => {
            if (w.id !== workspaceId) return w;
            return {
              ...w,
              tabs: w.tabs.map((t) => {
                if (!t.layoutTree || !allPaneIds(t.layoutTree).includes(d.paneId)) return t;
                const newTree = remove(t.layoutTree, d.paneId);
                return {
                  ...t,
                  layoutTree: newTree,
                  focusedPaneId: t.focusedPaneId === d.paneId ? (newTree ? firstPaneId(newTree) : null) : t.focusedPaneId,
                  zoomedPaneId: t.zoomedPaneId === d.paneId ? null : t.zoomedPaneId,
                };
              }),
              panes: w.panes.filter((p) => p.id !== d.paneId),
            };
          }),
        );
        return false;
      }
    };

    // Pooled, with secure mode's first-pane-alone rule — see spawnBatch.
    return (await spawnBatch(descriptors, secure, spawnOne)).filter(Boolean).length;
  };

  const onNewWorkspaceConfirmed = async (name: string, kind: AgentKind, dir: string, layout: WindowLayout, rawPlan: BranchPlan, secure: boolean) => {
    setDialog({ kind: "none" });
    const finalName = name.trim() || dir.split("/").pop() || "workspace";
    // Store the repo's actual current branch, not a hardcoded "main".
    const liveBranch = await currentBranch(dir).catch(() => "");

    let ws: Awaited<ReturnType<typeof createWorkspace>>;
    try {
      ws = await createWorkspace(finalName, dir, liveBranch || undefined);
    } catch (e) {
      pushNotification({ status: "failure", category: "agent", priority: true, text: `Couldn't create workspace "${finalName}": ${e instanceof Error ? e.message : e}` });
      return;
    }

    const accent = workspaceColor(workspaces.length);
    const { cmd, args } = agentCommand(kind);
    const { rows, cols } = layoutGrid(layout);
    const count = rows * cols;
    const { ptyCols, ptyRows } = estimatePtyDims(rows, cols);

    // Resolve the plan against the agent count: a pick of "check out branch X"
    // only survives as a checkout for a solo agent, otherwise X becomes the
    // base everyone branches from.
    const plan = normalizePlan(rawPlan, count);
    const useWorktrees = plan.mode !== "current";
    if (plan.mode === "new" && plan.baseRef) setLastBaseRef(dir, plan.baseRef);

    // Nothing below this line blocks the workspace appearing. Fetching the base
    // ref and cutting each agent's worktree used to run here, between the
    // dialog closing and the first pixel — seconds of an empty screen, on the
    // one action where the user is definitely watching. Both are now per-pane
    // work that happens with the grid already up (see `prepare`), and each pane
    // says which of them it is waiting on.
    const solo = count === 1;
    // One fetch for the whole workspace, not one per agent, and usually already
    // done: the dialog primed it when the base ref settled. Best-effort — an
    // unreachable remote shouldn't block the spawn, it just means branching
    // from what's already on disk.
    const willFetch = useWorktrees && plan.fetch && !!plan.baseRef;
    const fetching = willFetch
      ? fetchBase(dir, plan.baseRef).catch((e) => {
          pushNotification({ status: "failure", category: "agent", priority: false, text: `Couldn't fetch ${plan.baseRef}: ${e instanceof Error ? e.message : e}. Branching from the local copy.` });
        })
      : null;
    // Whether a fresh worktree will run an install, so the card can say so
    // rather than sitting on "starting" through a two-minute `npm ci`.
    const setupCmd = useWorktrees
      ? worktreeSetupGet(dir).then((i) => i.command.trim()).catch(() => "")
      : Promise.resolve("");

    // Agent names are generated up front so they stay unique (the parallel
    // prepare can't dedupe) and because the agent's name is what its branch is
    // named after. Every pane starts in the shared checkout and is moved to its
    // own worktree by `prepare`, if it gets one.
    const descriptors: PaneDescriptor[] = [];
    for (let i = 0; i < count; i++) {
      descriptors.push({
        paneId: crypto.randomUUID(),
        cwd: dir,
        agentName: randomAgentName(descriptors.map((d) => d.agentName)),
        sessionId: newClaudeSessionId(kind),
      });
    }

    const setPhase = (paneId: string, phase: PanePhase) =>
      setWorkspaces((prev) =>
        prev.map((w) =>
          w.id !== ws.id ? w : { ...w, panes: w.panes.map((p) => (p.id === paneId ? { ...p, phase } : p)) }),
      );

    const prepare = async (d: PaneDescriptor) => {
      if (fetching) await fetching;
      if (useWorktrees) {
        setPhase(d.paneId, { kind: "branching", branch: branchForAgent(plan, d.agentName, solo) || undefined });
        const { cwd: paneCwd, worktree, fresh } = await resolveNewPaneCwd(dir, plan, d.agentName, solo);
        d.cwd = paneCwd;
        d.worktree = worktree;
        d.setupRepo = fresh ? dir : undefined;
        setWorkspaces((prev) =>
          prev.map((w) =>
            w.id !== ws.id ? w : { ...w, panes: w.panes.map((p) => (p.id === d.paneId ? { ...p, cwd: paneCwd, worktree } : p)) }),
        );
      }
      const setup = d.setupRepo ? await setupCmd : "";
      setPhase(d.paneId, setup ? { kind: "installing", command: setup } : { kind: "starting" });
    };

    const paneIds = descriptors.map((d) => d.paneId);
    const layoutTree = buildGridLayout(paneIds, rows, cols);
    const tab = makeTab("1");

    // Render the whole grid immediately as placeholder panes (spawning:true), so
    // the workspace appears at once — before the fetch, before a single worktree
    // exists. Preparing and spawning then run per pane below, and each terminal
    // mounts as its own process comes live: no blank wait, no
    // 12-terminals-at-once main-thread freeze.
    const wsState: Workspace = {
      ...ws,
      accentColor: accent,
      agentKind: kind,
      useWorktrees,
      branchPlan: plan,
      secure,
      panes: descriptors.map((d) => ({
        id: d.paneId,
        workspaceId: ws.id,
        kind: cmd,
        status: "idle" as AgentStatusStr,
        statusChangedAt: Date.now(),
        attention: false,
        displayName: d.agentName,
        cwd: d.cwd,
        worktree: d.worktree,
        sessionId: d.sessionId,
        spawning: true,
        phase: willFetch
          ? ({ kind: "fetching", ref: plan.baseRef } as PanePhase)
          : useWorktrees
            ? ({ kind: "branching", branch: branchForAgent(plan, d.agentName, solo) || undefined } as PanePhase)
            : ({ kind: "starting" } as PanePhase),
      })),
      tabs: [{ ...tab, layoutTree, focusedPaneId: paneIds[0] }],
      focusedTabId: tab.id,
    };
    hydratedWsIds.current.add(ws.id);
    setWorkspaces((prev) => [...prev, wsState]);
    setFocusedWsId(ws.id);

    const okCount = await spawnGridPanes(ws.id, cmd, args, kind, secure, ptyRows, ptyCols, descriptors, prepare);
    if (okCount === 0) {
      // Every pane failed (e.g. secure mode with Docker down). Roll the whole
      // thing back so no empty workspace row or dead grid is left behind.
      setWorkspaces((prev) => prev.filter((w) => w.id !== ws.id));
      await deleteWorkspaceCmd(ws.id).catch(() => {});
      const hint = secure ? " Secure mode needs Docker running." : "";
      pushNotification({ status: "failure", category: "agent", priority: true, text: `Couldn't start "${finalName}".${hint}` });
      return;
    }
    // Persist the settled workspace. Capture it from committed state inside the
    // updater — workspacesRef lags an await, and the parallel spawns have since
    // flipped spawning flags / dropped any failures.
    setWorkspaces((prev) => {
      const settled = prev.find((w) => w.id === ws.id);
      if (settled) { const s = settled; queueMicrotask(() => saveWorkspace(s)); }
      return prev;
    });
    recordUsage({ workspaces: 1, agents: okCount });
  };

  /** The branch plan `additional` more agents in this workspace should follow.
   *
   * Workspaces created before the branch picker have no stored plan — those
   * keep their old behavior, derived from the `useWorktrees` flag. Normalizing
   * against the resulting agent count is what stops a second agent under an
   * "existing branch" plan from trying to check out a branch the first one
   * already holds: past one agent, that branch becomes the base instead. */
  const planFor = (ws: Workspace, additional = 1): BranchPlan =>
    normalizePlan(
      ws.branchPlan ?? legacyPlan(ws.useWorktrees ?? false, slugify(ws.name)),
      ws.panes.length + additional,
    );

  const spawnAgentInWorkspace = async (
    workspaceId: string,
    initialPrompt?: string,
    wsHint?: Workspace,
    kindOverride?: AgentKind,
    /** Spawn into this exact directory (e.g. adopting an existing orphaned
     * worktree from the Git panel) instead of resolving a fresh one. */
    cwdOverride?: { cwd: string; worktree?: { path: string; branch: string } },
  ) => {
    const ws = wsHint ?? workspacesRef.current.find((w) => w.id === workspaceId);
    if (!ws) {
      console.error("spawnAgentInWorkspace: workspace not found:", workspaceId);
      return;
    }
    const kind = kindOverride ?? ws.agentKind;
    const { cmd, args } = agentCommand(kind);
    const newCount = ws.panes.filter((p) => !p.streamId).length + 1;
    const { ptyCols, ptyRows } = estimatePtyDims(1, newCount);
    // The agent's name comes first: under a branch plan it's what the branch
    // is named after.
    const agentName = randomAgentName(ws.panes.map((p) => p.displayName));
    // Co-pilot workspaces have no repo_path — fall back to the app cwd
    const resolved: { cwd: string; worktree?: { path: string; branch: string }; fresh?: boolean } = cwdOverride
      ? cwdOverride
      : ws.repo_path
      ? await resolveNewPaneCwd(ws.repo_path, planFor(ws), agentName, ws.panes.length === 0)
      : { cwd, worktree: undefined };
    const spawnCwd = resolved.cwd;
    const worktree = resolved.worktree;
    // Never on a cwdOverride: that path adopts a worktree that already exists
    // on disk (Git panel orphan adoption), which is already installed.
    const setupRepo = resolved.fresh ? ws.repo_path : undefined;
    const sessionId = newClaudeSessionId(kind);
    const paneId = crypto.randomUUID();

    // Optimistic render: insert the pane into the layout *now* so the box
    // appears instantly, then spawn the PTY in the background. `spawning: true`
    // makes PaneArea show a placeholder until the process is live (mounting the
    // terminal before its backend pane exists would fail the output subscribe).
    // This is what turns the old ~1-2s "nothing happens" wait into an immediate
    // response — the terminal fills in a beat later as the agent boots.
    setWorkspaces((prev) =>
      prev.map((w) => {
        if (w.id !== workspaceId) return w;
        const tab = getFocusedTab(w);
        const targetId = tab.focusedPaneId ?? (tab.layoutTree ? firstPaneId(tab.layoutTree) : null);
        let layoutTree: LayoutNode | null = tab.layoutTree
          ? targetId
            ? split(tab.layoutTree, targetId, "horizontal", paneId)
            : { type: "leaf", paneId }
          : { type: "leaf", paneId };
        // Safety net: split() no-ops if `targetId` isn't in the tree (a stale
        // focusedPaneId pointing at a popped-out or just-closed pane). Without
        // this the new pane lands in `panes` but not the layout, so the agent
        // spawns invisibly — the "Spawn sometimes does nothing" bug. Force it
        // in against a real leaf.
        if (layoutTree && !allPaneIds(layoutTree).includes(paneId)) {
          layoutTree = split(layoutTree, firstPaneId(layoutTree), "horizontal", paneId);
        }
        // zoomedPaneId cleared: with a pane zoomed the tab renders only the
        // zoom leaf, so the freshly spawned agent would join the tree without
        // ever appearing on screen — spawn looked like it did nothing.
        return {
          ...w,
          tabs: w.tabs.map((t) => t.id === tab.id ? { ...t, layoutTree, focusedPaneId: paneId, zoomedPaneId: null } : t),
          panes: [
            ...w.panes,
            {
              id: paneId,
              workspaceId,
              kind: cmd,
              status: "idle" as AgentStatusStr,
              attention: false,
              displayName: agentName,
              cwd: spawnCwd,
              worktree,
              sessionId,
              spawning: true,
            },
          ],
        };
      }),
    );
    setFocusedWsId(workspaceId);

    // Spawn the actual process. The box is already on screen; this fills it in.
    try {
      await spawnPane({
        paneId,
        workspaceId,
        cmd,
        args: [...withClaudeSession(args, sessionId, "new"), ...(await graphSpawnArgs(kind, workspaceId, ws.secure))],
        cwd: spawnCwd,
        rows: ptyRows,
        cols: ptyCols,
        agentName,
        secure: ws.secure,
        graphEnabled: getGraphEnabled(),
        setupRepo,
      });
    } catch (e) {
      // Spawn failed (e.g. secure mode with Docker down). Roll back the
      // optimistic pane so a dead placeholder isn't left behind, surface the
      // error, and rethrow for callers that await this.
      pushNotification({ status: "failure", category: "agent", priority: true, text: `Couldn't spawn ${cmd}: ${e instanceof Error ? e.message : e}` });
      setWorkspaces((prev) =>
        prev.map((w) => {
          if (w.id !== workspaceId || !w.panes.some((p) => p.id === paneId)) return w;
          return {
            ...w,
            tabs: w.tabs.map((t) => {
              if (!t.layoutTree || !allPaneIds(t.layoutTree).includes(paneId)) return t;
              const newTree = remove(t.layoutTree, paneId);
              return {
                ...t,
                layoutTree: newTree,
                focusedPaneId: t.focusedPaneId === paneId ? (newTree ? firstPaneId(newTree) : null) : t.focusedPaneId,
                zoomedPaneId: t.zoomedPaneId === paneId ? null : t.zoomedPaneId,
              };
            }),
            panes: w.panes.filter((p) => p.id !== paneId),
          };
        }),
      );
      throw e;
    }

    // Closed mid-spawn: if the user dismissed the pane during the spawn window
    // its frontend state is already gone, so kill the just-spawned PTY rather
    // than leak an orphaned backend pane.
    if (!workspacesRef.current.some((w) => w.panes.some((p) => p.id === paneId))) {
      await closePaneCmd(paneId).catch(() => {});
      return;
    }

    recordUsage({ agents: 1 });

    // If this is a co-pilot workspace, set up streaming so the partner sees
    // this new local pane as a remote pane on their side.
    if (ws.copilot) {
      const client = (await import("./lib/presence")).getAblyClient();
      if (client) {
        const ch = client.channels.get(`flock:stream:${paneId}`);
        await ch.attach();
        const { startStream } = await import("./lib/streamPublisher");
        // Only the co-pilot partner may type into this newly shared pane.
        startStream(paneId, ch, { allowInput: true, allowedInputFrom: ws.copilot.partnerLogin });
      }
    }

    // Process is live — drop the placeholder so the terminal mounts, and
    // persist the now-settled workspace.
    let updated: Workspace | undefined;
    setWorkspaces((prev) =>
      prev.map((w) => {
        if (w.id !== workspaceId) return w;
        return updated = { ...w, panes: w.panes.map((p) => p.id === paneId ? { ...p, spawning: false, booting: true } : p) };
      }),
    );
    if (updated) saveWorkspace(updated);

    // Tell co-pilot partner about the new pane so they re-render their view
    if (updated?.copilot) {
      const localPaneIds = updated.panes.filter((p) => !p.streamId).map((p) => ({ id: p.id, label: p.displayName ?? p.kind }));
      const { syncCopilotLayout } = await import("./lib/session");
      syncCopilotLayout(
        updated.copilot.partnerLogin,
        updated.copilot.partnerWid,
        updated.copilot.sessionId,
        localPaneIds,
      );
    }

    if (initialPrompt) {
      // Same path as a race: wait for booting to clear, then bracketed paste
      // and enter. A flat sleep + raw sendInput lands a multi-line PR-review
      // prompt in the login shell as separate bash commands. Awaited so
      // reviewPr's loading state covers delivery, not just spawn.
      await deliverPromptWhenReady(paneId, initialPrompt);
    }
    return paneId;
  };

  /** Fill an empty *tab* with N agents of a chosen kind, arranged in a
   * grid — the same agent + layout pickers used by New Workspace, but for
   * a workspace that already has a repo, so it skips straight to "which
   * agent, how many". Only meant for an empty tab: unlike
   * spawnAgentInWorkspace (which splits one new pane into whatever layout
   * already exists in the focused tab), this builds a fresh grid tree for
   * that tab — panes are appended to the workspace's pane list (not
   * replaced), so other tabs' panes are untouched. */
  const spawnAgentsInWorkspace = async (workspaceId: string, kind: AgentKind, layout: WindowLayout) => {
    debugLog(`spawnAgentsInWorkspace ENTER ws=${workspaceId} kind=${kind} layout=${layout} known=[${workspacesRef.current.map((w) => w.id).join(",")}]`);
    const ws = workspacesRef.current.find((w) => w.id === workspaceId);
    if (!ws) {
      debugLog(`spawnAgentsInWorkspace ABORT ws not found: ${workspaceId}`);
      pushNotification({ status: "failure", category: "agent", priority: true, text: "Couldn't spawn agents: workspace is no longer open." });
      return;
    }
    const { cmd, args } = agentCommand(kind);
    const { rows, cols } = layoutGrid(layout);
    const count = rows * cols;
    debugLog(`spawnAgentsInWorkspace ws found, spawning count=${count} cmd=${cmd} repo=${ws.repo_path ?? "<none>"} existingPanes=${ws.panes.length}`);
    const { ptyCols, ptyRows } = estimatePtyDims(rows, cols);
    const existingNames = ws.panes.map((p) => p.displayName);
    // A grid dropped into an existing workspace follows that workspace's plan,
    // but "check out branch X" can't apply to several agents at once, so it
    // degrades to "branch off X" exactly as it would at creation time.
    const plan = planFor(ws, count);
    const solo = count === 1 && ws.panes.length === 0;

    // Names dedupe against the workspace's existing panes plus the ones being
    // planned now. Worktrees are cut per pane once the grid is on screen (see
    // `prepare`), not in a loop before it — same as at creation.
    const repoPath = ws.repo_path;
    const descriptors: PaneDescriptor[] = [];
    for (let i = 0; i < count; i++) {
      descriptors.push({
        paneId: crypto.randomUUID(),
        cwd: repoPath || cwd,
        agentName: randomAgentName([...existingNames, ...descriptors.map((d) => d.agentName)]),
        sessionId: newClaudeSessionId(kind),
      });
    }
    const prepare = async (d: PaneDescriptor) => {
      if (!repoPath) return;
      setWorkspaces((prev) =>
        prev.map((w) =>
          w.id !== workspaceId ? w : { ...w, panes: w.panes.map((p) => (p.id === d.paneId ? { ...p, phase: { kind: "branching", branch: branchForAgent(plan, d.agentName, solo) || undefined } as PanePhase } : p)) }),
      );
      const { cwd: paneCwd, worktree, fresh } = await resolveNewPaneCwd(repoPath, plan, d.agentName, solo);
      d.cwd = paneCwd;
      d.worktree = worktree;
      d.setupRepo = fresh ? repoPath : undefined;
      setWorkspaces((prev) =>
        prev.map((w) =>
          w.id !== workspaceId ? w : { ...w, panes: w.panes.map((p) => (p.id === d.paneId ? { ...p, cwd: paneCwd, worktree, phase: { kind: "starting" } as PanePhase } : p)) }),
      );
    };

    const paneIds = descriptors.map((d) => d.paneId);
    const layoutTree = buildGridLayout(paneIds, rows, cols);
    debugLog(`spawnAgentsInWorkspace planned=${paneIds.length} rendering placeholders`);

    // Render the grid immediately as placeholder panes, then spawn in parallel.
    // Don't gate the spawn on a flag set inside the updater: React runs updaters
    // from async code on a later tick, so reading it synchronously here is racy
    // (that race skipped every spawn and stranded the placeholders). The ENTER
    // check above already confirmed the workspace exists.
    setWorkspaces((prev) => {
      const next = prev.map((w) => {
        if (w.id !== workspaceId) return w;
        const tab = getFocusedTab(w);
        return {
          ...w,
          agentKind: kind,
          panes: [
            ...w.panes,
            ...descriptors.map((d) => ({
              id: d.paneId,
              workspaceId,
              kind: cmd,
              status: "idle" as AgentStatusStr,
              attention: false,
              displayName: d.agentName,
              cwd: d.cwd,
              worktree: d.worktree,
              sessionId: d.sessionId,
              spawning: true,
            })),
          ],
          // zoomedPaneId cleared for the same reason as spawnAgentInWorkspace:
          // a lingering zoom would hide the entire fresh grid.
          tabs: w.tabs.map((t) => t.id === tab.id ? { ...t, layoutTree, focusedPaneId: paneIds[0], zoomedPaneId: null } : t),
        };
      });
      workspacesRef.current = next;
      return next;
    });
    setFocusedWsId(workspaceId);

    const okCount = await spawnGridPanes(workspaceId, cmd, args, kind, ws.secure, ptyRows, ptyCols, descriptors, prepare);
    if (okCount === 0) {
      debugLog(`spawnAgentsInWorkspace ABORT: 0 panes spawned for ws=${workspaceId}`);
      pushNotification({ status: "failure", category: "agent", priority: true, text: `Couldn't spawn any ${cmd} agents.` });
      return;
    }
    // Persist the settled workspace from committed state.
    setWorkspaces((prev) => {
      const settled = prev.find((w) => w.id === workspaceId);
      if (settled) { const s = settled; queueMicrotask(() => saveWorkspace(s)); }
      return prev;
    });
    debugLog(`spawnAgentsInWorkspace settled ok=${okCount}`);
  };

  // ─── Race: fan one prompt out, compare, merge one ──────────────────

  /** Type a prompt into a pane once the agent is actually listening.
   *
   * The wait is the whole function. A fresh pane is a login shell for the
   * first second or two (see lib/agentBoot) and bytes sent into it during
   * that window are read by *bash*, not the agent — a race's prompt would be
   * run as a shell command in every contender at once. `booting` comes down
   * on the agent's own first paint, which is the earliest honest signal that
   * an input line exists.
   *
   * Bounded, because an agent that never paints (a missing CLI, a jail whose
   * image is still building) must not leave a promise pending forever; on
   * timeout the prompt is sent anyway. */
  const deliverPromptWhenReady = (paneId: string, text: string) =>
    deliverPrompt(paneId, text, {
      readiness: (id) => {
        const pane = workspacesRef.current.flatMap((w) => w.panes).find((p) => p.id === id);
        if (!pane) return "gone";
        return pane.spawning || pane.booting ? "booting" : "ready";
      },
      paste: sendPromptToPane,
      submit: (id) =>
        sendInput(id, new TextEncoder().encode("\r")).catch(console.error) as Promise<void>,
    });

  /** Fan one prompt across `count` agents, each in its own fresh worktree cut
   * from the repo's current HEAD, in a tab of their own.
   *
   * Built out of the paths that already exist — `resolveNewPaneCwd` for the
   * worktree, `spawnGridPanes` for the parallel spawn, `buildGridLayout` for
   * the tiling — with three things that are specific to a race:
   *
   * 1. The base is pinned to a **sha**, not a branch. Every contender's diff
   *    is taken against it, and a branch would move the moment anything lands
   *    on the main checkout mid-race.
   * 2. Every agent is suffixed (`solo: false` unconditionally), even at two
   *    contenders. The bare stem going to whoever spawned first would make
   *    one branch in the race look like the "real" one.
   * 3. The race is recorded on the tab, keyed by worktree path rather than
   *    pane id, so it survives a relaunch (see RaceContender in types.ts).
   */
  const startRace = async (workspaceId: string, kind: AgentKind, count: number, prompt: string) => {
    const ws = workspacesRef.current.find((w) => w.id === workspaceId);
    if (!ws?.repo_path) {
      pushNotification({ status: "failure", category: "agent", priority: true, text: "A race needs a workspace with a git repo." });
      return;
    }
    const repoPath = ws.repo_path;

    // Pinned before anything is spawned, so a contender that takes a minute to
    // start still branches from the same commit as the first one.
    const baseSha = await gitHeadSha(repoPath).catch(() => "");
    if (!baseSha) {
      pushNotification({ status: "failure", category: "agent", priority: true, text: `Couldn't read HEAD in ${repoPath} — is it a git repo?` });
      return;
    }
    const baseLabel = (await currentBranch(repoPath).catch(() => "")) || baseSha.slice(0, 8);

    const { cmd, args } = agentCommand(kind);
    const { rows, cols } = gridDimsFor(count);
    const { ptyCols, ptyRows } = estimatePtyDims(rows, cols);
    // A plain `new` plan against the pinned sha. `fetch` is off on purpose:
    // the base is a commit that is already in the repo by definition, so there
    // is nothing to fetch and nothing to wait on.
    const plan: BranchPlan = { mode: "new", stem: raceStem(prompt), baseRef: baseSha, fetch: false };
    const setupCmd = worktreeSetupGet(repoPath).then((i) => i.command.trim()).catch(() => "");

    const existingNames = ws.panes.map((p) => p.displayName);
    const descriptors: PaneDescriptor[] = [];
    for (let i = 0; i < count; i++) {
      descriptors.push({
        paneId: crypto.randomUUID(),
        cwd: repoPath,
        agentName: randomAgentName([...existingNames, ...descriptors.map((d) => d.agentName)]),
        sessionId: newClaudeSessionId(kind),
      });
    }

    const setPhase = (paneId: string, phase: PanePhase) =>
      setWorkspaces((prev) =>
        prev.map((w) =>
          w.id !== workspaceId ? w : { ...w, panes: w.panes.map((p) => (p.id === paneId ? { ...p, phase } : p)) }),
      );

    const prepare = async (d: PaneDescriptor) => {
      setPhase(d.paneId, { kind: "branching", branch: branchForAgent(plan, d.agentName, false) });
      const { cwd: paneCwd, worktree, fresh } = await resolveNewPaneCwd(repoPath, plan, d.agentName, false);
      d.cwd = paneCwd;
      d.worktree = worktree;
      d.setupRepo = fresh ? repoPath : undefined;
      setWorkspaces((prev) =>
        prev.map((w) =>
          w.id !== workspaceId ? w : { ...w, panes: w.panes.map((p) => (p.id === d.paneId ? { ...p, cwd: paneCwd, worktree } : p)) }),
      );
      const setup = d.setupRepo ? await setupCmd : "";
      setPhase(d.paneId, setup ? { kind: "installing", command: setup } : { kind: "starting" });
    };

    const paneIds = descriptors.map((d) => d.paneId);
    const layoutTree = buildGridLayout(paneIds, rows, cols);
    // `renamed` so the tab keeps its race name: closing a sibling tab
    // renumbers every tab that hasn't been named, and "×4 fix-login" becoming
    // "3" would erase the only label saying this tab is a race.
    const tab: WorkspaceTab = { ...makeTab(raceTabName(prompt, count)), renamed: true, layoutTree, focusedPaneId: paneIds[0] };

    setWorkspaces((prev) => {
      const next = prev.map((w) =>
        w.id !== workspaceId
          ? w
          : {
              ...w,
              agentKind: kind,
              panes: [
                ...w.panes,
                ...descriptors.map((d) => ({
                  id: d.paneId,
                  workspaceId,
                  kind: cmd,
                  status: "idle" as AgentStatusStr,
                  attention: false,
                  displayName: d.agentName,
                  cwd: d.cwd,
                  sessionId: d.sessionId,
                  spawning: true,
                  phase: { kind: "branching", branch: branchForAgent(plan, d.agentName, false) } as PanePhase,
                })),
              ],
              tabs: [...w.tabs, tab],
              focusedTabId: tab.id,
            });
      workspacesRef.current = next;
      return next;
    });
    setFocusedWsId(workspaceId);

    const okCount = await spawnGridPanes(workspaceId, cmd, args, kind, ws.secure, ptyRows, ptyCols, descriptors, prepare);
    if (okCount === 0) {
      pushNotification({ status: "failure", category: "agent", priority: true, text: `Couldn't start the race — no ${cmd} agents spawned.` });
      return;
    }

    // Only panes that got their own worktree are contenders. One that fell
    // back to the shared checkout (resolveNewPaneCwd logs and degrades rather
    // than failing the spawn) has no branch to diff or merge, and listing it
    // would put a row in the compare view that can never do anything.
    const contenders: RaceContender[] = descriptors
      .filter((d) => d.worktree)
      .map((d) => ({ agentName: d.agentName, branch: d.worktree!.branch, worktreePath: d.worktree!.path }));
    if (contenders.length < descriptors.length) {
      pushNotification({
        status: "info",
        category: "agent",
        priority: false,
        text: `${descriptors.length - contenders.length} agent(s) couldn't get their own worktree and won't be in the comparison.`,
      });
    }

    const race: RaceState = { prompt, baseSha, baseLabel, contenders, startedAt: Date.now() };
    setWorkspaces((prev) => {
      const next = prev.map((w) =>
        w.id !== workspaceId ? w : { ...w, tabs: w.tabs.map((t) => (t.id === tab.id ? { ...t, race } : t)) });
      const settled = next.find((w) => w.id === workspaceId);
      if (settled) { const s = settled; queueMicrotask(() => saveWorkspace(s)); }
      return next;
    });
    recordUsage({ agents: okCount });

    // Fanned out per pane rather than through broadcastInput: broadcast
    // replicates what is *typed into the focused pane* to the visible panes of
    // its tab, so it depends on focus, visibility, and the user not having
    // switched away — none of which hold while N agents are still booting at
    // their own pace. Broadcast stays off, and stays available in the header
    // for the follow-up nudges where it is the right tool.
    for (const d of descriptors) {
      deliverPromptWhenReady(d.paneId, prompt).catch(console.error);
    }
    refreshBranches().catch(() => {});
  };

  /** Merge a race contender into the workspace's main checkout, and optionally
   * tear the others down.
   *
   * The teardown deliberately goes through the same two paths every other
   * worktree removal uses — `closePaneInWorkspace` for a loser whose agent is
   * still alive (it kills the PTY, then removes the worktree), `removeWorktree`
   * for one whose pane is already gone — rather than a race-specific bulk
   * delete. Every loser is committed first: `git worktree remove` refuses to
   * discard uncommitted changes, so without that step "discard the others"
   * would fail on exactly the contenders that had done the most work. */
  const mergeRaceWinner = async (workspaceId: string, tabId: string, branch: string, discardOthers: boolean) => {
    const ws = workspacesRef.current.find((w) => w.id === workspaceId);
    const tab = ws?.tabs.find((t) => t.id === tabId);
    const race = tab?.race;
    const winner = race?.contenders.find((c) => c.branch === branch);
    if (!ws?.repo_path || !race || !winner) return;

    setMergingRace(true);
    try {
      // One message for both the winner's catch-up commit and the merge
      // commit, so it has to read as either (see git::merge_branch).
      const subject = race.prompt.split("\n")[0].trim().slice(0, 60);
      const report = await gitMergeBranch(ws.repo_path, winner.worktreePath, branch, `Race winner (${winner.agentName}): ${subject}`);
      if (!report.merged) {
        const detail = report.conflicts.length
          ? `conflicts in ${report.conflicts.slice(0, 3).join(", ")}${report.conflicts.length > 3 ? ` +${report.conflicts.length - 3} more` : ""}`
          : report.message;
        pushNotification({ status: "failure", category: "agent", priority: true, text: `Couldn't merge ${winner.agentName}: ${detail}. Your checkout is unchanged.` });
        return;
      }

      let updated: Workspace | undefined;
      setWorkspaces((prev) =>
        prev.map((w) =>
          w.id !== workspaceId
            ? w
            : (updated = { ...w, tabs: w.tabs.map((t) => (t.id === tabId && t.race ? { ...t, race: { ...t.race, winnerBranch: branch } } : t)) })),
      );
      if (updated) saveWorkspace(updated);
      // "your checkout", not `race.baseLabel`: the merge lands wherever the
      // main working copy is *now*, and the user can have switched branches
      // since the race started. Naming the wrong branch in a success message
      // about a merge is worse than naming none.
      pushNotification({ status: "success", category: "agent", priority: false, text: `Merged ${winner.agentName} (${branch}) into your checkout.` });

      if (discardOthers) {
        // Panes read fresh, not from the snapshot taken before the merge: a
        // contender can be closed while `git merge` runs, and a stale pane id
        // here would send closePaneInWorkspace after a pane that is already
        // gone instead of removing the worktree directly.
        const livePanes = workspacesRef.current.find((w) => w.id === workspaceId)?.panes ?? [];
        const targets = cleanupPlan(race, branch, livePanes, true);
        for (const t of targets) {
          // Committed even though the branch is about to be deleted: `git
          // worktree remove` refuses to discard uncommitted changes, so
          // without this the teardown fails on exactly the contenders that did
          // the most work. It also means that if the branch delete then fails
          // (git won't drop a branch a worktree still holds), the work is on a
          // ref rather than in a directory nothing points at.
          await gitCommitAll(t.worktreePath, `Race: ${subject}`).catch((e) =>
            console.error("couldn't commit losing worktree", t.branch, e),
          );
          if (t.paneId) {
            // Closes the pane, kills the PTY, and removes the worktree +
            // branch on the way out — the same path every other pane close
            // uses. Its worktree removal is fire-and-forget by design, which
            // is why nothing below claims a count.
            await closePaneInWorkspace(t.paneId, t.deleteBranch);
          } else {
            await removeWorktree(ws.repo_path, t.worktreePath, t.branch, t.deleteBranch).catch((e) => {
              pushNotification({
                status: "failure",
                category: "agent",
                priority: false,
                text: `Couldn't remove ${t.branch}: ${e instanceof Error ? e.message : e}`,
              });
            });
          }
        }
        if (targets.length > 0) {
          pushNotification({ status: "info", category: "agent", priority: false, text: `Tearing down the other ${targets.length} worktree${targets.length === 1 ? "" : "s"}.` });
        }
      }
      refreshBranches().catch(() => {});
    } catch (e) {
      pushNotification({ status: "failure", category: "agent", priority: true, text: `Couldn't merge ${winner.agentName}: ${e instanceof Error ? e.message : e}` });
    } finally {
      setMergingRace(false);
    }
  };

  /** Appended to orchestrated handoff prompts when the flock Graph is
   * enabled — the harness's nudge to consult and extend shared memory at
   * exactly the moments context changes hands between agents. */
  const graphHandoffClause = () =>
    getGraphEnabled()
      ? `\n\nThe flock-graph MCP server is available: before starting, run kg.query for prior decisions and attempts relevant to this work, and record significant decisions (kg.write_decision) and failed approaches (kg.record_attempt) as you go so other agents inherit them.`
      : "";

  // Full graph protocol, injected into every claude agent's system prompt (not
  // just PR reviews) so recording is the default, not an afterthought. This is
  // the fix for "the graph almost never records": agents were never told to.
  // Codex/opencode receive an equivalent via `flock-mcp brief` — keep this
  // in sync with GRAPH_PROTOCOL in crates/flock-mcp/src/main.rs.
  const GRAPH_PROTOCOL =
    "The flock-graph MCP tools are your shared, persistent memory for this project and the people on it. It is the source of truth for prior decisions, context, and preferences — shared live with every other agent and teammate on this project.\n" +
    "This is NOT your built-in/session memory. When you are asked to recall anything (a past decision, someone's preference, earlier work, why something was done), query the graph with kg.query. Do not answer 'nothing is recorded' from any other memory feature without checking kg.query first. Relevant graph knowledge is also injected automatically with each of your prompts — treat an injected 'flock Graph' block as recall you should honor.\n" +
    "Before significant changes to a file, run kg.about_file on it — it returns every decision, failed attempt, and note recorded about that file.\n" +
    "Record continuously as you work, not just at the end:\n" +
    "- kg.write_decision when you settle a non-trivial choice (library, pattern, API shape, trade-off), with your reasoning and what you rejected. ALWAYS pass `files` (paths it governs); pass `supersedes` (a label fragment is fine) when it replaces a differently-titled decision.\n" +
    "- kg.record_attempt when something fails or only partly works, so nobody repeats it. Pass `files` and, when it was in service of a decision, `relates_to` with that decision's label.\n" +
    "- kg.remember for reusable facts, conventions, invariants, and a person's stated preferences — with `files` when it concerns specific code.\n" +
    "- kg.forget when recorded knowledge turns out to be wrong or obsolete and there is no replacement — it stops surfacing, with your reason kept.\n" +
    "Titles are identity: writing a label that already exists UPDATES that note in place — re-use titles to keep knowledge current instead of piling up near-duplicates. Inside any body you can write [[another note's title]] to link it; `files` and `relates_to` draw ABOUT/RELATES_TO edges automatically, so you never look up node IDs. kg.link (labels work) is only for connections you notice after the fact.\n" +
    "When you finish, make sure the decisions and dead ends from this session are in the graph so the next agent can pick up exactly where you left off.";

  /** Extra spawn args to give an agent graph access when the graph is enabled.
   * Each agent CLI has a different injection surface:
   *  - claude: `--append-system-prompt` (protocol + workspace brief) + inline
   *    `--mcp-config` to register the flock-graph server.
   *  - codex: inline `-c mcp_servers.*` overrides register the server (no
   *    config.toml mutation); the protocol + brief and per-prompt recall ride
   *    in via the codex hooks.json brief/ground hooks (installed by
   *    graph_ground_hook). `--dangerously-bypass-hook-trust` runs those
   *    flock-authored hooks without a per-change re-trust prompt.
   *  - opencode: nothing per-spawn — its MCP server and grounding plugin are
   *    installed globally (config + plugin file) by graph_ground_hook.
   * Everything is gated on getGraphEnabled(). Skipped for secure (container)
   * panes: the MCP config points at a host macOS binary that neither exists
   * nor could run inside the Linux jail, and shipping the protocol prompt
   * without its tools just makes the agent apologize about missing them. */
  const graphSpawnArgs = (kind: AgentKind, workspaceId: string, secure?: boolean): Promise<string[]> => {
    // Read here, at spawn — the URL is the one input that goes stale, so it is
    // deliberately not part of anything cached (see lib/graphSpawn.ts).
    const url = getGraphUrl();
    return graphSpawnArgsFor(kind, {
      enabled: getGraphEnabled(),
      secure,
      mcpPath: mcpConfigRef.current?.mcp_path ?? null,
      url,
      // Capped at ~1.2s so a slow or down engine can't stall a spawn.
      brief: () =>
        Promise.race<string>([
          graphBrief(workspaceId, url),
          new Promise((resolve) => setTimeout(() => resolve(""), 1200)),
        ]),
      protocol: GRAPH_PROTOCOL,
    });
  };

  /** Review a PR in its own workspace: the PR's head is fetched into a
   * dedicated git worktree — never the repo's own checkout, so a dirty tree
   * or in-flight work in the source workspace can neither fail the checkout
   * nor be clobbered by it — then a workspace is created on that worktree
   * and the review agent spawns there. Reviewing the same PR again just
   * refocuses its existing workspace. */
  const reviewPr = async (pr: PullRequest, sourceOverride?: Workspace) => {
    if (reviewingPr !== null) return;
    const source =
      sourceOverride ??
      workspaces.find((w) => w.id === focusedWsId && !!w.repo_path) ??
      workspaces.find((w) => !!w.repo_path);
    if (!source?.repo_path) return;
    // Repo short name in the workspace name: with watched repos, two repos
    // can both have a PR #12 — a bare "PR #12" would dedupe them into one
    // workspace. Dedupe primarily on the recorded target; the name fallbacks
    // cover review workspaces saved before prReviewTarget existed.
    const wsName = `PR #${pr.number} · ${pr.repo.split("/")[1] ?? pr.repo}`;
    const existing = workspaces.find((w) => w.prReviewTarget?.repo === pr.repo && w.prReviewTarget?.number === pr.number)
      ?? workspaces.find((w) => w.name === wsName)
      ?? workspaces.find((w) => w.prReview && w.name === `PR #${pr.number}`);
    if (existing) {
      setFocusedWsId(existing.id);
      return;
    }
    setReviewingPr(pr.number);
    try {
      const wt = await githubCheckoutPrWorktree(source.repo_path, pr.number, pr.head_ref);
      const ws = await createWorkspace(wsName, wt.path, wt.branch);
      const tab = makeTab("1");
      const wsState: Workspace = {
        ...ws,
        // PR-review workspaces get the violet treatment and pin to the top of
        // every workspace list (see orderForDisplay) — a review is a transient
        // errand, not another peer workspace to hunt for in the stack.
        accentColor: "var(--violet)",
        prReview: true,
        prReviewTarget: { repo: pr.repo, number: pr.number },
        agentKind: source.agentKind,
        panes: [],
        tabs: [tab],
        focusedTabId: tab.id,
      };
      hydratedWsIds.current.add(ws.id);
      setWorkspaces((prev) => [...prev, wsState]);
      setFocusedWsId(ws.id);
      const reviewPaneId = await spawnAgentInWorkspace(ws.id, `Review this pull request and provide feedback:\nhttps://github.com/${pr.repo}/pull/${pr.number}\n\nTitle: ${pr.title}\n\nThis workspace is a dedicated worktree with the PR branch (${wt.branch}) checked out — look at the actual changes in this working directory.${graphHandoffClause()}`, wsState);
      // Track the spawned pane against its PR so the moment the agent settles
      // (working → idle) its terminal output can be summarized into the modal.
      // The returned id (not a workspacesRef lookup) — the ref only syncs on
      // re-render, which isn't guaranteed to have happened yet.
      if (reviewPaneId) reviewPanesRef.current.set(reviewPaneId, { repo: pr.repo, number: pr.number });
    } catch (e) {
      pushNotification({ status: "failure", category: "pr", priority: true, text: `Couldn't check out PR #${pr.number} for review: ${e instanceof Error ? e.message : e}` });
    } finally {
      setReviewingPr(null);
    }
  };
  reviewPrRef.current = reviewPr;

  /** Spawn one review agent per open PR (no branch checkout — a single
   * workspace can only have one branch checked out at a time). Guarded and
   * sequential so a double-click can't fan out a duplicate set, with a toast
   * confirming how many were started. */
  const reviewAllPrs = async () => {
    if (!focusedWsId || reviewAllInFlightRef.current) return;
    const prs = pullRequests;
    if (prs.length === 0) return;
    reviewAllInFlightRef.current = true;
    try {
      for (const pr of prs) {
        await spawnAgentInWorkspace(focusedWsId, `Review this pull request and provide feedback:\nhttps://github.com/${pr.repo}/pull/${pr.number}\n\nTitle: ${pr.title}${graphHandoffClause()}`).catch(() => {});
      }
      pushNotification({ status: "info", category: "pr", priority: false, text: `Started review agents for ${prs.length} open PR${prs.length === 1 ? "" : "s"}` });
    } finally {
      reviewAllInFlightRef.current = false;
    }
  };

  // ─── PR watch / auto-review / merge queue ──────────────────────────

  /** "owner/repo" slug for a local checkout (cached per repo_path), so open
   * workspaces can be matched against a watched PR's repo. */
  const repoSlugFor = useCallback(async (repoPath: string): Promise<string | null> => {
    const cached = repoSlugCacheRef.current.get(repoPath);
    if (cached !== undefined) return cached;
    const url = await githubRepoWebUrl(repoPath).catch(() => null);
    const slug = url ? url.replace(/^https?:\/\/github\.com\//i, "").replace(/\/$/, "") : null;
    repoSlugCacheRef.current.set(repoPath, slug);
    return slug;
  }, []);

  /** Drain the auto-review FIFO one PR at a time through reviewPr. reviewPr
   * only ever runs one review (it guards on reviewingPr), so the wait loop +
   * sequential awaits are what "review is queued" means in practice. */
  const drainAutoReviewQueue = useCallback(async () => {
    if (autoReviewDrainingRef.current) return;
    autoReviewDrainingRef.current = true;
    try {
      while (autoReviewQueueRef.current.length > 0) {
        // Wait for any in-flight review (manual or a previous queue entry) to
        // settle — reviewPr would silently no-op while one is running.
        while (reviewingPrRef.current !== null) {
          await new Promise((r) => setTimeout(r, 750));
        }
        const pr = autoReviewQueueRef.current.shift();
        if (!pr) break;
        // reviewPr checks the PR head out of a source workspace's repo — find
        // an open workspace on the same GitHub repo as this PR.
        let source: Workspace | undefined;
        for (const w of workspacesRef.current) {
          if (!w.repo_path || w.copilot || w.observe || w.prReview) continue;
          if ((await repoSlugFor(w.repo_path)) === pr.repo) { source = w; break; }
        }
        if (!source) {
          // Dropped from the auto queue (it still shows in the PR modal for a
          // manual review once a matching workspace exists).
          pushNotification({
            status: "info",
            category: "pr",
            priority: true,
            text: `PR #${pr.number} queued for review — open a workspace on ${pr.repo} to auto-review`,
          });
          continue;
        }
        await reviewPrRef.current(pr, source);
      }
    } finally {
      autoReviewDrainingRef.current = false;
    }
  }, [repoSlugFor, pushNotification]);

  /** Fresh PRs from a watch poll: always notify; auto-review when enabled. */
  const handleFreshWatchedPrs = useCallback((fresh: string[], prs: PullRequest[], config: PrWatchConfig) => {
    const byKey = new Map(prs.map((p) => [`${p.repo}#${p.number}`, p]));
    const freshPrs = fresh.map((k) => byKey.get(k)).filter((p): p is PullRequest => !!p);
    for (const pr of freshPrs) {
      pushNotification({
        status: "info",
        category: "pr",
        priority: true,
        text: `New PR ${pr.repo}#${pr.number} — ${pr.title}`,
        url: `https://github.com/${pr.repo}/pull/${pr.number}`,
      });
    }
    if (config.auto_review && freshPrs.length > 0) {
      autoReviewQueueRef.current.push(...freshPrs);
      void drainAutoReviewQueue();
    }
  }, [pushNotification, drainAutoReviewQueue]);

  /** Store a ticked queue and notify on the transitions that matter: an item
   * that reached "merged" (or vanished mid-merge — the backend drops merged
   * items), and anything newly failed/blocked, with the backend's note. */
  const applyMergeQueueResult = useCallback((after: MergeQueueItem[], before: MergeQueueItem[]) => {
    const key = (i: MergeQueueItem) => `${i.repo}#${i.number}`;
    const afterByKey = new Map(after.map((i) => [key(i), i]));
    for (const prev of before) {
      const cur = afterByKey.get(key(prev));
      if (!cur) {
        if (prev.status === "merging" || prev.status === "checks_pending") {
          pushNotification({ status: "success", category: "pr", priority: true, text: `Merged ${prev.repo}#${prev.number} — ${prev.title}` });
        }
        continue;
      }
      if (cur.status === prev.status) continue;
      if (cur.status === "merged") {
        pushNotification({ status: "success", category: "pr", priority: true, text: `Merged ${cur.repo}#${cur.number} — ${cur.title}` });
      } else if (cur.status === "failed" || cur.status === "blocked") {
        pushNotification({
          status: "failure",
          category: "pr",
          priority: true,
          text: `Merge ${cur.status} for ${cur.repo}#${cur.number}${cur.note ? ` — ${cur.note}` : ""}`,
        });
      }
    }
    mergeQueueRef.current = after;
    setMergeQueue(after);
  }, [pushNotification]);

  // The watch poll proper: config re-read each tick (so a settings save
  // applies without wiring), then the watched-repo PR sweep, then — while the
  // merge queue is non-empty — a queue tick. Same active-window gating and
  // cadence as the workspace PR poll.
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const config = await prWatchGetConfig();
        if (cancelled) return;
        prWatchConfigRef.current = config;
        const res = await prWatchPoll();
        if (cancelled) return;
        setWatchedPrs(res.prs);
        if (res.fresh.length > 0) handleFreshWatchedPrs(res.fresh, res.prs, config);
      } catch { /* gh disconnected or backend unavailable — retry next tick */ }
      try {
        if (mergeQueueRef.current.length > 0) {
          const before = mergeQueueRef.current;
          const after = await mergeQueueTick();
          if (!cancelled) applyMergeQueueResult(after, before);
        }
      } catch { /* tick is best-effort; state stands until the next one */ }
    };
    poll();
    const id = setInterval(() => { if (isWindowActive()) poll(); }, 30000);
    return () => { cancelled = true; clearInterval(id); };
  }, [handleFreshWatchedPrs, applyMergeQueueResult]);

  // Re-list the merge queue whenever the PR hub opens, so it reflects
  // changes made from another window since the last tick.
  useEffect(() => {
    if (dialog.kind !== "pr-hub") return;
    mergeQueueList().then((q) => { mergeQueueRef.current = q; setMergeQueue(q); }).catch(() => {});
  }, [dialog.kind]);

  /** "owner/repo" → repo_path for every open real workspace (co-pilot/observe
   * mirrors excluded — no usable checkout), feeding the merge-queue modal's
   * local conflict analysis. First workspace per slug wins. */
  const repoPathsForQueue = useCallback(async (): Promise<Record<string, string>> => {
    const paths: Record<string, string> = {};
    for (const w of workspacesRef.current) {
      if (!w.repo_path || w.copilot || w.observe) continue;
      const slug = await repoSlugFor(w.repo_path);
      if (slug && paths[slug] === undefined) paths[slug] = w.repo_path;
    }
    return paths;
  }, [repoSlugFor]);

  // The modal's PR list: workspace-sourced entries first (they win the dedupe
  // — they carry head_ref), then watched-repo PRs not already present.
  const modalPrs = useMemo(() => {
    const seen = new Set(pullRequests.map((p) => `${p.repo}#${p.number}`));
    const extra = watchedPrs.filter((p) => !seen.has(`${p.repo}#${p.number}`));
    return extra.length === 0 ? pullRequests : [...pullRequests, ...extra];
  }, [pullRequests, watchedPrs]);

  const addPrToMergeQueue = useCallback(async (pr: PullRequest) => {
    const q = await mergeQueueAdd(pr.repo, pr.number, pr.title);
    mergeQueueRef.current = q;
    setMergeQueue(q);
  }, []);

  const removePrFromMergeQueue = useCallback(async (repo: string, number: number) => {
    const q = await mergeQueueRemove(repo, number);
    mergeQueueRef.current = q;
    setMergeQueue(q);
  }, []);

  const reorderPrInMergeQueue = useCallback(async (repo: string, number: number, position: number) => {
    const q = await mergeQueueReorder(repo, number, position);
    mergeQueueRef.current = q;
    setMergeQueue(q);
  }, []);

  const approvePr = useCallback(async (repo: string, number: number) => {
    await githubApprovePr(repo, number);
    pushNotification({ status: "success", category: "pr", priority: false, text: `Approved ${repo}#${number}` });
  }, [pushNotification]);

  /** Merge immediately with the configured method, bypassing the queue's
   * head-of-line gating; a queued entry for the PR is dropped afterwards. */
  const mergePrNow = useCallback(async (repo: string, number: number) => {
    const method = prWatchConfigRef.current?.merge_method
      ?? (await prWatchGetConfig().then((c) => { prWatchConfigRef.current = c; return c; })).merge_method;
    await githubMergePr(repo, number, method);
    pushNotification({ status: "success", category: "pr", priority: true, text: `Merged ${repo}#${number} (${method})` });
    const q = await mergeQueueRemove(repo, number).catch(() => null);
    if (q) { mergeQueueRef.current = q; setMergeQueue(q); }
  }, [pushNotification]);

  const splitPane = async (workspaceId: string, dir: SplitDir) => {
    const ws = workspacesRef.current.find((w) => w.id === workspaceId);
    if (!ws) return;
    const { cmd, args } = agentCommand(ws.agentKind);
    const newCount = ws.panes.length + 1;
    const { ptyCols, ptyRows } = estimatePtyDims(
      dir === "vertical" ? newCount : 1,
      dir === "horizontal" ? newCount : 1,
    );
    const agentName = randomAgentName(ws.panes.map((p) => p.displayName));
    // Co-pilot workspaces have no repo_path — fall back to the app cwd, same as
    // spawnAgentInWorkspace. Without this, split spawned into cwd "" and failed.
    const { cwd: spawnCwd, worktree, fresh } = ws.repo_path
      ? await resolveNewPaneCwd(ws.repo_path, planFor(ws), agentName, ws.panes.length === 0)
      : { cwd, worktree: undefined as { path: string; branch: string } | undefined, fresh: false };
    const sessionId = newClaudeSessionId(ws.agentKind);
    let pane;
    try {
      pane = await spawnPane({
        workspaceId,
        cmd,
        args: [...withClaudeSession(args, sessionId, "new"), ...(await graphSpawnArgs(ws.agentKind, workspaceId, ws.secure))],
        cwd: spawnCwd,
        rows: ptyRows,
        cols: ptyCols,
        agentName,
        secure: ws.secure,
        graphEnabled: getGraphEnabled(),
        setupRepo: fresh ? ws.repo_path : undefined,
      });
    } catch (e) {
      pushNotification({ status: "failure", category: "agent", priority: true, text: `Couldn't spawn ${cmd}: ${e instanceof Error ? e.message : e}` });
      throw e;
    }

    // Co-pilot: share this new pane so the partner sees it as a remote pane and
    // may type into it (mirrors spawnAgentInWorkspace).
    if (ws.copilot) {
      const client = (await import("./lib/presence")).getAblyClient();
      if (client) {
        const ch = client.channels.get(`flock:stream:${pane.id}`);
        await ch.attach();
        const { startStream } = await import("./lib/streamPublisher");
        startStream(pane.id, ch, { allowInput: true, allowedInputFrom: ws.copilot.partnerLogin });
      }
    }
    // Everything layout-related is derived inside the updater, from the tree
    // as it is NOW — not from a snapshot taken before the awaits above (which
    // can take seconds when worktrees are on). Writing back a pre-await tree
    // clobbered any concurrent change: panes closed in the meantime came back
    // as ghost leaves, and a second quick ⌘D dropped the first spawn from the
    // layout entirely, leaving its agent running invisibly.
    let updated: Workspace | undefined;
    setWorkspaces((prev) =>
      prev.map((w) => {
        if (w.id !== workspaceId) return w;
        const tab = getFocusedTab(w);
        // Fall back to the tree's first pane when nothing is focused (e.g. a
        // restored workspace whose saved focusedPaneId came back null); on an
        // empty tab the new pane becomes the tree, so ⌘D and the header split
        // buttons still work after every agent in a tab has been closed.
        const splitTarget = tab.focusedPaneId ?? (tab.layoutTree ? firstPaneId(tab.layoutTree) : null);
        let layoutTree: LayoutNode = tab.layoutTree && splitTarget
          ? split(tab.layoutTree, splitTarget, dir, pane.id)
          : { type: "leaf", paneId: pane.id };
        // Same safety net as spawnAgentInWorkspace: never orphan the new pane
        // if the split target was stale.
        if (!allPaneIds(layoutTree).includes(pane.id)) {
          layoutTree = split(layoutTree, firstPaneId(layoutTree), dir, pane.id);
        }
        return updated = {
          ...w,
          tabs: w.tabs.map((t) => t.id === tab.id ? { ...t, layoutTree, focusedPaneId: pane.id, zoomedPaneId: null } : t),
          panes: [
            ...w.panes,
            {
              id: pane.id,
              workspaceId,
              kind: pane.kind,
              status: pane.status as AgentStatusStr,
              attention: false,
              displayName: agentName,
              cwd: spawnCwd,
              worktree,
              sessionId,
              // Same reason as the restore path: a split's pane boots through
              // the same shell plumbing as one spawned into a fresh grid, and
              // has the same claim on being covered until its agent paints.
              booting: true,
            },
          ],
        };
      }),
    );
    if (updated) saveWorkspace(updated);

    // Tell the co-pilot partner about the new pane so it appears on their side.
    if (updated?.copilot) {
      const localPaneIds = updated.panes.filter((p) => !p.streamId).map((p) => ({ id: p.id, label: p.displayName ?? p.kind }));
      const { syncCopilotLayout } = await import("./lib/session");
      syncCopilotLayout(updated.copilot.partnerLogin, updated.copilot.partnerWid, updated.copilot.sessionId, localPaneIds);
    }
  };

  const resizeSplit = (workspaceId: string, tabId: string, path: SplitPath, ratio: number) => {
    let updated: Workspace | undefined;
    setWorkspaces((prev) =>
      prev.map((w) =>
        w.id === workspaceId
          ? updated = {
              ...w,
              tabs: w.tabs.map((t) =>
                t.id === tabId && t.layoutTree
                  ? { ...t, layoutTree: setRatioAtPath(t.layoutTree, path, ratio) }
                  : t,
              ),
            }
          : w,
      ),
    );
    if (updated) saveWorkspace(updated);
  };

  /** Trade two panes' positions in a tab's split tree — fired by dragging a
   * pane's topbar onto another pane. The tree shape (directions, ratios) is
   * kept, so a 12-agent grid stays a 12-agent grid; only the two agents move. */
  const swapPanesInTab = (workspaceId: string, tabId: string, a: string, b: string) => {
    if (a === b) return;
    let updated: Workspace | undefined;
    setWorkspaces((prev) =>
      prev.map((w) =>
        w.id === workspaceId
          ? updated = {
              ...w,
              tabs: w.tabs.map((t) =>
                t.id === tabId && t.layoutTree
                  ? { ...t, layoutTree: swapPanes(t.layoutTree, a, b) }
                  : t,
              ),
            }
          : w,
      ),
    );
    if (updated) saveWorkspace(updated);
  };

  /** Even out every split in a tab so all panes share the screen equally —
   * fired by double-clicking any resize gutter. */
  const evenSplits = (workspaceId: string, tabId: string) => {
    let updated: Workspace | undefined;
    setWorkspaces((prev) =>
      prev.map((w) =>
        w.id === workspaceId
          ? updated = {
              ...w,
              tabs: w.tabs.map((t) =>
                t.id === tabId && t.layoutTree
                  ? { ...t, layoutTree: balanceLayoutTree(t.layoutTree) }
                  : t,
              ),
            }
          : w,
      ),
    );
    if (updated) saveWorkspace(updated);
  };

  /** Remove a pane's worktree without ever silently deleting unmerged work:
   * the branch is only deleted when the user's setting says so AND nothing
   * on it would be lost. Used by every bulk teardown path (tab close,
   * workspace delete, popout close) where prompting per-pane would be
   * obnoxious; the interactive single-pane path prompts instead. */
  const safeRemoveWorktree = async (repoPath: string, wt: { path: string; branch: string }) => {
    let deleteBranch = getDeleteBranchWithWorktree() && !!wt.branch;
    if (deleteBranch) {
      const unmerged = await branchUnmergedCount(repoPath, wt.branch).catch(() => 0);
      if (unmerged > 0) deleteBranch = false;
    }
    await removeWorktree(repoPath, wt.path, wt.branch, deleteBranch);
  };

  /** The workspace that OWNS a pane, which since borrowed panes is not always
   * the workspace whose tab is displaying it. Every lifecycle decision that
   * touches the filesystem or the agent itself - the repo a path resolves
   * against, whether a worktree gets removed, whether the PTY is killed, what
   * the jail chip claims - has to key off THIS and never off the tab's owner.
   * The tab's owner is only ever the answer to "which tab do I show". */
  const ownerOfPane = (paneId: string) =>
    workspacesRef.current.find((w) => w.panes.some((p) => p.id === paneId));

  /** Close a pane, but if its worktree branch has commits that exist nowhere
   * else, stop and ask what to do with them first (Keep / Delete / Cancel).
   * All interactive close paths (topbar ✕, header ✕, ⌘⇧K, context menu) go
   * through here; closePaneInWorkspace below is the actual teardown. */
  const requestClosePane = async (paneId: string) => {
    // Same rule the context menu applies: a borrowed pane is not this tab's
    // to close. When the close gesture (topbar ✕, header ✕, ⌘⇧K) fires while
    // the FOCUSED workspace only borrows the pane, the user is dismissing it
    // from the tab they are looking at — killing the owning workspace's agent
    // and tearing down its worktree from here would be the one destructive
    // path the menu deliberately refuses to offer.
    const focused = workspacesRef.current.find((w) => w.id === focusedWsIdRef.current);
    if (
      focused &&
      !focused.panes.some((p) => p.id === paneId) &&
      focused.tabs.some((t) => borrowedOwner(t.borrowed, paneId))
    ) {
      returnBorrowedPane(focused.id, paneId);
      return;
    }
    const ws = workspacesRef.current.find((w) => w.panes.some((p) => p.id === paneId));
    const pane = ws?.panes.find((p) => p.id === paneId);
    if (ws?.repo_path && pane?.worktree?.branch) {
      const unmerged = await branchUnmergedCount(ws.repo_path, pane.worktree.branch).catch(() => 0);
      if (unmerged > 0) {
        setDialog({
          kind: "close-pane-branch",
          paneId,
          agentName: pane.displayName,
          branch: pane.worktree.branch,
          unmerged,
        });
        return;
      }
    }
    await closePaneInWorkspace(paneId);
  };

  const closePaneInWorkspace = async (paneId: string, deleteBranchOverride?: boolean) => {
    await closePaneCmd(paneId).catch(console.error);

    // If a friend was watching this pane (observe) or it streamed into a
    // co-pilot session, stop publishing — stopStream is a no-op otherwise.
    import("./lib/streamPublisher").then(({ stopStream }) => stopStream(paneId));
    for (const [sid, pid] of observeSharesRef.current) {
      if (pid === paneId) observeSharesRef.current.delete(sid);
    }

    // Capture worktree info before it's dropped from state, so the checkout
    // on disk gets cleaned up once the pane itself is gone.
    const owningWs = workspacesRef.current.find((w) => w.panes.some((p) => p.id === paneId));
    const closedPane = owningWs?.panes.find((p) => p.id === paneId);

    setWorkspaces((prev) => {
      let saved: Workspace | undefined;
      const next = prev.map((w) => {
        // A workspace that merely BORROWED this pane has no pane record to
        // drop, but it does have a leaf and a ref pointing at an agent that no
        // longer exists. Left alone that leaf is a blank, uncloseable tile,
        // which is the exact failure pruneLayoutTree was written for.
        if (!w.panes.some((p) => p.id === paneId)) {
          if (!w.tabs.some((t) => borrowedOwner(t.borrowed, paneId))) return w;
          const released = { ...w, tabs: w.tabs.map((t) => {
            if (!borrowedOwner(t.borrowed, paneId)) return t;
            const tree = t.layoutTree ? remove(t.layoutTree, paneId) : null;
            return {
              ...t,
              layoutTree: tree,
              focusedPaneId: t.focusedPaneId === paneId ? (tree ? firstPaneId(tree) : null) : t.focusedPaneId,
              zoomedPaneId: t.zoomedPaneId === paneId ? null : t.zoomedPaneId,
              borrowed: removeBorrowed(t.borrowed, paneId),
            };
          }) };
          saveWorkspaceRef.current(released);
          return released;
        }
        const remainingPanes = w.panes.filter((p) => p.id !== paneId);
        const tabs = w.tabs.map((t) => {
          if (!t.layoutTree || !allPaneIds(t.layoutTree).includes(paneId)) return t;
          const newTree = remove(t.layoutTree, paneId);
          const focusedPaneId = t.focusedPaneId === paneId ? (newTree ? firstPaneId(newTree) : null) : t.focusedPaneId;
          const zoomedPaneId = t.zoomedPaneId === paneId ? null : t.zoomedPaneId;
          return { ...t, layoutTree: newTree, focusedPaneId, zoomedPaneId };
        });
        const result = { ...w, tabs, panes: remainingPanes };
        saved = result;
        return result;
      });
      workspacesRef.current = next;
      if (saved) {
        const stateToSave = saved;
        queueMicrotask(() => saveWorkspace(stateToSave));
      }
      return next;
    });

    if (owningWs?.repo_path && closedPane?.worktree) {
      const wt = closedPane.worktree;
      const cleanup = deleteBranchOverride === undefined
        ? safeRemoveWorktree(owningWs.repo_path, wt)
        : removeWorktree(owningWs.repo_path, wt.path, wt.branch, deleteBranchOverride && !!wt.branch);
      cleanup.catch((e) => console.error("failed to remove worktree for closed pane", e));
    }
  };

  /** Spawn a new agent pane directly into an orphaned worktree (one on disk
   * with no live pane behind it — a crashed pane, an old session, or a
   * worktree made outside the app), from the Git panel's worktree list. */
  const adoptWorktree = async (workspaceId: string, wt: WorktreeStatus) => {
    await spawnAgentInWorkspace(workspaceId, undefined, undefined, undefined, {
      cwd: wt.path,
      worktree: { path: wt.path, branch: wt.branch },
    });
    refreshBranches().catch(() => {});
  };

  /** Remove an orphaned worktree from the Git panel. Pauses on the same
   * keep/delete-branch prompt as pane close when the branch has unmerged
   * commits; otherwise removes it directly (honoring the delete-branch
   * setting). `git worktree remove` itself refuses on uncommitted changes,
   * and that error is surfaced instead of forced through. */
  const pruneWorktree = async (workspaceId: string, wt: WorktreeStatus) => {
    const ws = workspacesRef.current.find((w) => w.id === workspaceId);
    if (!ws?.repo_path) return;
    const unmerged = wt.branch
      ? await branchUnmergedCount(ws.repo_path, wt.branch).catch(() => 0)
      : 0;
    if (unmerged > 0) {
      setDialog({ kind: "prune-worktree", workspaceId, wt, unmerged });
      return;
    }
    await removeOrphanWorktree(workspaceId, wt, getDeleteBranchWithWorktree() && !!wt.branch);
  };

  const removeOrphanWorktree = async (workspaceId: string, wt: WorktreeStatus, deleteBranch: boolean) => {
    const ws = workspacesRef.current.find((w) => w.id === workspaceId);
    if (!ws?.repo_path) return;
    try {
      await removeWorktree(ws.repo_path, wt.path, wt.branch, deleteBranch);
      pushNotification({ status: "success", category: "agent", priority: false, text: `Removed worktree ${wt.branch || wt.path}` });
    } catch (e) {
      pushNotification({
        status: "failure",
        category: "agent",
        priority: true,
        text: `Couldn't remove worktree ${wt.branch || wt.path}: ${e instanceof Error ? e.message : e} (it may have uncommitted changes)`,
      });
    }
    refreshBranches().catch(() => {});
  };

  /** Live `pane-${id}` windows + where each should fold back. The id set is
   * "is the window live?", not "did we pull a leaf out of a tab" — a stray
   * existing window, or a pop from the borrower, leaves the other workspace
   * still laying that id out. Grid Terminals treat these ids like hidden.
   * Origin is only *where* to re-insert; releasing the id must not wait on
   * a successful insert. In-memory only: popout windows don't survive an
   * app restart (the restore path folds orphans into the first tab). */
  const popoutRef = useRef(emptyPopoutBook());
  const [poppedOutIds, setPoppedOutIds] = useState<ReadonlySet<string>>(() => new Set());
  const markPoppedOut = (paneId: string, origin?: PopoutOrigin, onlyIfMissing = false) => {
    popoutRef.current = markPoppedOutBook(popoutRef.current, paneId, origin, onlyIfMissing);
    setPoppedOutIds(popoutRef.current.ids);
  };
  /** Window is gone. Always unhide. Returns the origin so a caller can try
   * to re-insert without gating the clear on that insert. */
  const clearPoppedOut = (paneId: string): PopoutOrigin | undefined => {
    const { book, origin } = releasePoppedOut(popoutRef.current, paneId);
    popoutRef.current = book;
    setPoppedOutIds(book.ids);
    return origin;
  };

  /** Detach a pane into its own OS window, loosely coupled from the main
   * app window (Teams-style pop-out chat). The agent keeps running — it's
   * just removed from this workspace's grid until the popout window closes,
   * at which point it either returns (window dismissed) or is fully closed
   * (explicit "close agent" from the popout), handled by the
   * pane-popout-closed listener below. */
  const popOutPane = async (workspaceId: string, paneId: string) => {
    // Two different workspaces, and the distinction is the whole of borrowed
    // panes: `ws` is the one whose TAB the pane is being pulled out of, and
    // `owner` is the one that has the pane record and the accent. Reading the
    // record off `ws` made popping out a borrowed pane a silent no-op.
    const ws = workspacesRef.current.find((w) => w.id === workspaceId);
    const owner = ownerOfPane(paneId);
    const pane = owner?.panes.find((p) => p.id === paneId);
    const tab = ws ? findTabForPane(ws, paneId) : undefined;
    if (!ws || !owner || !pane || !tab) return;

    // Already has a live popout window (e.g. a stray one that didn't get
    // cleaned up) — bring it forward instead of spawning a second window
    // for the same pane.
    const existing = await WebviewWindow.getByLabel(`pane-${paneId}`).catch(() => null);
    if (existing) {
      // A stray window we didn't book-keep still owns the PTY; hide every
      // grid Terminal for this id or the focused workspace's tile will
      // fight it the moment it becomes visible. Record origin only when
      // missing — this click is just a focus, not a new pop — so a later
      // return still has a destination if a leaf *was* removed earlier.
      markPoppedOut(paneId, { workspaceId, tabId: tab.id }, true);
      existing.setFocus().catch(console.error);
      return;
    }

    markPoppedOut(paneId, { workspaceId, tabId: tab.id });

    const newLayoutTree = tab.layoutTree ? remove(tab.layoutTree, paneId) : null;
    const focusedPaneId =
      tab.focusedPaneId === paneId
        ? newLayoutTree ? firstPaneId(newLayoutTree) : null
        : tab.focusedPaneId;
    const zoomedPaneId = tab.zoomedPaneId === paneId ? null : tab.zoomedPaneId;

    let updated: Workspace | undefined;
    setWorkspaces((prev) =>
      prev.map((w) =>
        w.id === workspaceId
          ? (updated = { ...w, tabs: w.tabs.map((t) => t.id === tab.id ? { ...t, layoutTree: newLayoutTree, focusedPaneId, zoomedPaneId } : t) })
          : w,
      ),
    );
    if (updated) saveWorkspace(updated);

    const params = new URLSearchParams({
      pane: paneId,
      workspaceId,
      name: pane.displayName ?? "",
      kind: pane.kind,
      accent: owner.accentColor,
      // Carried so the popout can draw the same context meter the grid does —
      // it's the pane's conversation that has the reading, not its tile.
      session: pane.sessionId ?? "",
    });
    const win = new WebviewWindow(`pane-${paneId}`, {
      url: `index.html?${params.toString()}`,
      title: pane.displayName ? `${pane.displayName} — ${pane.kind}` : pane.kind,
      width: 560,
      height: 720,
      minWidth: 360,
      minHeight: 240,
      // Match the main window's dark overlay title bar (see tauri.conf.json)
      // instead of Tauri's plain default grey chrome.
      decorations: true,
      transparent: false,
      // The popout's native chrome before any of our CSS paints, so it has to
      // be the literal window ground of each theme. Typed against ThemeId, so
      // adding a theme fails the build here rather than flashing the wrong
      // colour on every popout.
      backgroundColor: {
        light: "#FCFBF8",
        dark: "#071122",
        graphite: "#121212",
        "high-contrast": "#000000",
      }[getEffectiveTheme()],
      titleBarStyle: "overlay",
      hiddenTitle: true,
      trafficLightPosition: new LogicalPosition(14, 18),
    });
    // Window creation happens async on the Rust side, after the pane was
    // already pulled out of the grid above — if it fails (label collision
    // with a not-yet-torn-down window, OS refusal, etc.) the agent would
    // otherwise vanish entirely: gone from the grid, no window to show it.
    // Put it back and say why instead of leaving it stranded.
    win.once("tauri://error", (e) => {
      console.error("popout window creation failed", e);
      pushNotification({ status: "failure", category: "agent", priority: true, text: `Couldn't pop out ${pane.displayName ?? pane.kind} into its own window` });
      clearPoppedOut(paneId);
      returnPaneToGrid(workspaceId, paneId);
    });
  };

  /** Re-insert a (live but tab-less) pane into its workspace, into the tab
   * it was originally popped out of (falling back to the focused tab if
   * that tab has since been closed). Shared by the popout-close listener
   * and bringBackPane's no-window fallback. Clears the target tab's zoom —
   * otherwise the returning pane lands in the layout but stays invisible
   * behind whichever pane is zoomed — and focuses the target tab +
   * workspace so the pane visibly flows back instead of returning
   * somewhere off-screen. */
  const returnPaneToGrid = useCallback((workspaceId: string, paneId: string) => {
    // Window is gone. Unhide first, including the exits below: a stray
    // existing window never removed a leaf, so findTabForPane succeeds and
    // this used to leave every grid Terminal on visible={false} with nobody
    // calling resizePty. Origin is only where to re-insert.
    const origin = clearPoppedOut(paneId);
    // The origin outranks the caller's workspace id. The popout-closed event
    // carries the pane's OWNER (recorded at spawn on the Rust side), but a
    // borrowed pane was popped out of the BORROWING workspace's tab — and in
    // the owner the pane never left its tab, so the idempotency guard below
    // would see it in place and return the whole event to a no-op: the
    // borrowing tab silently loses the tile and keeps a leaf-less loan.
    const targetWsId = origin?.workspaceId ?? workspaceId;
    let updated: Workspace | undefined;
    setWorkspaces((prev) =>
      prev.map((w) => {
        if (w.id !== targetWsId) return w;
        // The pane may be borrowed, so its record is not necessarily in `w`.
        // What has to be true is only that it still exists somewhere.
        const pane = ownerOfPane(paneId)?.panes.find((p) => p.id === paneId);
        if (!pane) return w; // already closed/removed elsewhere
        // Idempotency guard: if this pane is already in some tab's grid
        // (e.g. a duplicate event slipped through), don't insert it again.
        if (findTabForPane(w, paneId)) return w;
        const tab = w.tabs.find((t) => t.id === origin?.tabId) ?? getFocusedTab(w);
        const target = tab.focusedPaneId ?? (tab.layoutTree ? firstPaneId(tab.layoutTree) : null);
        const layoutTree: LayoutNode = tab.layoutTree
          ? target
            ? split(tab.layoutTree, target, "horizontal", paneId)
            : { type: "leaf", paneId }
          : { type: "leaf", paneId };
        return updated = {
          ...w,
          focusedTabId: tab.id,
          tabs: w.tabs.map((t) =>
            t.id === tab.id ? { ...t, layoutTree, focusedPaneId: paneId, zoomedPaneId: null } : t,
          ),
        };
      }),
    );
    if (updated) {
      saveWorkspace(updated);
      // Land where the user can see it — closing a popout is a deliberate
      // "put it back" action, so follow it to the destination workspace.
      setFocusedWsId(targetWsId);
    }
  }, [saveWorkspace]);

  /** Bring a popped-out pane back into the main grid, from the main window
   * itself. Normally just closes the popout window — the Rust-side Destroyed
   * hook emits pane-popout-closed and the listener below re-inserts the
   * pane. If no window exists (e.g. the pane was popped out when the app
   * last quit, so it restored into no tab), fold it straight back in — the
   * button must never silently do nothing. */
  const bringBackPane = async (paneId: string) => {
    const win = await WebviewWindow.getByLabel(`pane-${paneId}`).catch(() => null);
    if (win) {
      await win.close();
      return;
    }
    const ws = workspacesRef.current.find((w) => w.panes.some((p) => p.id === paneId));
    if (ws) returnPaneToGrid(ws.id, paneId);
  };

  // A popout window either returns its pane to the grid (window dismissed)
  // or reports it fully closed (explicit "close agent" from the popout).
  useEffect(() => {
    // Same StrictMode dev-mode race as PoppedPaneWindow's listener: cleanup
    // can run before the async `listen` registration resolves, leaking the
    // first listener. Left unfixed, every popout-close event then gets
    // processed twice — for the "return" path that means splitting the same
    // paneId into layoutTree twice, i.e. the pane visibly appears twice.
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    onPanePopoutClosed(({ workspaceId, paneId, action }) => {
      // Both actions mean the window is gone. "return" clears inside
      // returnPaneToGrid (after it reads origin). "closed" has no insert,
      // so unhide here — the remaining tile, if any, must drive the PTY.
      if (action === "closed") {
        clearPoppedOut(paneId);
        // Mirror closePaneInWorkspace's teardown: drop the pane record,
        // strip it from any tab layout (belt-and-braces — a popped-out pane
        // shouldn't be in one), and clean up its git worktree. Previously
        // this branch only dropped the record, silently leaking worktrees.
        const owningWs = workspacesRef.current.find((w) => w.id === workspaceId);
        const closedPane = owningWs?.panes.find((p) => p.id === paneId);
        setWorkspaces((prev) => prev.map((w) => {
          if (w.id !== workspaceId) return w;
          const tabs = w.tabs.map((t) => {
            if (!t.layoutTree || !allPaneIds(t.layoutTree).includes(paneId)) return t;
            const newTree = remove(t.layoutTree, paneId);
            return {
              ...t,
              layoutTree: newTree,
              focusedPaneId: t.focusedPaneId === paneId ? (newTree ? firstPaneId(newTree) : null) : t.focusedPaneId,
              zoomedPaneId: t.zoomedPaneId === paneId ? null : t.zoomedPaneId,
            };
          });
          return { ...w, tabs, panes: w.panes.filter((p) => p.id !== paneId) };
        }));
        if (owningWs?.repo_path && closedPane?.worktree) {
          safeRemoveWorktree(owningWs.repo_path, closedPane.worktree)
            .catch((e) => console.error("failed to remove worktree for popout-closed pane", e));
        }
        return;
      }
      returnPaneToGrid(workspaceId, paneId);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [returnPaneToGrid]);

  const zoomPane = (workspaceId: string, paneId: string | null) => {
    if (!paneId) return;
    let updated: Workspace | undefined;
    setWorkspaces((prev) =>
      prev.map((w) => {
        if (w.id !== workspaceId) return w;
        const tab = getFocusedTab(w);
        return updated = { ...w, tabs: w.tabs.map((t) => t.id === tab.id ? { ...t, zoomedPaneId: t.zoomedPaneId === paneId ? null : paneId } : t) };
      }),
    );
    if (updated) saveWorkspace(updated);
  };

  /** Focus a pane, switching to whichever tab actually contains it — the
   * sidebar's "click an agent" can target a pane in a tab other than the
   * one currently showing. A pane in *no* tab is popped out into its own
   * OS window: raise that window instead of writing a dangling
   * focusedPaneId into a tab that can't show it (which also made ⌘⇧K
   * close an off-screen pane). */
  const focusPane = (workspaceId: string, paneId: string) => {
    const ws = workspacesRef.current.find((w) => w.id === workspaceId);
    // Landing on an agent that was waiting on you IS the acknowledgement: clear
    // "needs input" back to idle so the sidebar dot, the tab attention dot, and
    // the ⌘J queue all stop pointing at an agent you're already looking at. The
    // detector re-raises it the moment the agent actually asks again, so this
    // only ever clears a notice you've now seen. Every caller is user-initiated
    // (pane click, sidebar agent, notification click-through, ⌘] / ⌘J), and it
    // runs before the popped-out branch below so that path clears too.
    // ownerOfPane, not `ws`: a borrowed pane's record lives in another
    // workspace, and reading it from the displaying one leaves the attention
    // dot lit on the agent you are currently looking at.
    if (ownerOfPane(paneId)?.panes.find((p) => p.id === paneId)?.status === "awaiting_input") {
      updatePaneStatus(paneId, "idle"); // optimistic, so the dot clears on the click
      // and server-side too, so the value both status sources dedupe against
      // doesn't stay stuck at awaiting (see ack_pane_attention).
      ackPaneAttention(paneId).catch(console.error);
    }
    if (ws && !findTabForPane(ws, paneId)) {
      WebviewWindow.getByLabel(`pane-${paneId}`)
        .then((win) => win?.setFocus())
        .catch(() => {});
      return;
    }
    let updated: Workspace | undefined;
    setWorkspaces((prev) =>
      prev.map((w) => {
        if (w.id !== workspaceId) return w;
        const tab = findTabForPane(w, paneId) ?? getFocusedTab(w);
        return updated = {
          ...w,
          focusedTabId: tab.id,
          tabs: w.tabs.map((t) => t.id === tab.id ? { ...t, focusedPaneId: paneId } : t),
        };
      }),
    );
    if (updated) saveWorkspace(updated);
  };

  /** Notification click-through: switch to the pane's workspace (it may not
   * be the one currently focused, unlike the sidebar's agent list which only
   * ever lists the focused workspace's panes), then focus the pane itself. */
  const openNotificationPane = (workspaceId: string, paneId: string) => {
    setFocusedWsId(workspaceId);
    focusPane(workspaceId, paneId);
  };

  // ─── Tabs (independent split-pane layouts within a workspace) ──────

  const switchTab = (workspaceId: string, tabId: string) => {
    let updated: Workspace | undefined;
    setWorkspaces((prev) =>
      prev.map((w) => w.id === workspaceId ? (updated = { ...w, focusedTabId: tabId }) : w),
    );
    if (updated) saveWorkspace(updated);
  };

  const newTabInWorkspace = (workspaceId: string) => {
    let updated: Workspace | undefined;
    setWorkspaces((prev) =>
      prev.map((w) => {
        if (w.id !== workspaceId) return w;
        const tab = makeTab(String(w.tabs.length + 1));
        return updated = { ...w, tabs: [...w.tabs, tab], focusedTabId: tab.id };
      }),
    );
    if (updated) saveWorkspace(updated);
  };

  /** Rename a tab (double-click the tab name). An empty/blank name reverts the
   * tab to positional auto-numbering; anything else pins the custom name so
   * closing sibling tabs won't renumber it. */
  const renameTabInWorkspace = (workspaceId: string, tabId: string, rawName: string) => {
    const name = rawName.trim().slice(0, 40);
    let updated: Workspace | undefined;
    setWorkspaces((prev) =>
      prev.map((w) => {
        if (w.id !== workspaceId) return w;
        const idx = w.tabs.findIndex((t) => t.id === tabId);
        if (idx === -1) return w;
        const tabs = w.tabs.map((t) =>
          t.id !== tabId
            ? t
            : name
              ? { ...t, name, renamed: true }
              : { ...t, name: String(idx + 1), renamed: false },
        );
        return updated = { ...w, tabs };
      }),
    );
    if (updated) saveWorkspace(updated);
  };

  /** Interactive tab-close entry point (✕ button, middle-click, ⌘⇧W). If the
   * tab still has agents laid out in it, pause and confirm first — otherwise
   * closing it silently kills every agent inside. An empty tab has nothing to
   * lose, so it closes straight through. */
  const requestCloseTab = async (workspaceId: string, tabId: string) => {
    const ws = workspacesRef.current.find((w) => w.id === workspaceId);
    const tab = ws?.tabs.find((t) => t.id === tabId);
    if (!ws || !tab) return;
    // Only the panes this workspace owns are going to be killed, so only those
    // may be counted. Borrowed ones are released, and warning about them would
    // ask the user to approve a loss that is not going to happen.
    const agentCount = tab.layoutTree
      ? allPaneIds(tab.layoutTree).filter((id) => ws.panes.some((p) => p.id === id)).length
      : 0;
    if (agentCount > 0) {
      setDialog({ kind: "confirm-close-tab", workspaceId, tabId, tabName: tab.name, agentCount });
      return;
    }
    await closeTabInWorkspace(workspaceId, tabId);
  };

  /** Close a tab, killing every agent laid out in it. A workspace always
   * keeps at least one tab — closing the last one just clears it instead of
   * removing it. */
  const closeTabInWorkspace = async (workspaceId: string, tabId: string) => {
    const ws = workspacesRef.current.find((w) => w.id === workspaceId);
    const tab = ws?.tabs.find((t) => t.id === tabId);
    if (!ws || !tab) return;
    const paneIdsInTab = tab.layoutTree ? allPaneIds(tab.layoutTree) : [];
    // A borrowed pane is only being DISPLAYED here. Closing this tab lets it
    // go; it must not kill it. The agent belongs to another workspace, is
    // still laid out in that workspace's own tabs, and killing it would take
    // an unrelated workspace's work down with a tab it was merely visiting.
    // The same reasoning governs the worktree cleanup below, which reads
    // `ws.panes` and so was already right by construction.
    const ownIds = paneIdsInTab.filter((id) => ws.panes.some((p) => p.id === id));
    for (const paneId of ownIds) {
      await closePaneCmd(paneId).catch(console.error);
    }
    const removedIds = new Set(ownIds);
    const worktreesToClean = ws.panes.filter((p) => removedIds.has(p.id) && p.worktree);

    let updated: Workspace | undefined;
    setWorkspaces((prev) =>
      prev.map((w) => {
        if (w.id !== workspaceId) return w;
        const remainingPanes = w.panes.filter((p) => !removedIds.has(p.id));
        // Renumber auto-named tabs so their names stay 1..N — otherwise
        // closing tab 1 of 2 leaves a lone tab named "2", and the next new tab
        // duplicates it. Tabs the user has renamed keep their custom name and
        // are skipped; the ⌘1-9 shortcut is positional regardless.
        const remainingTabs = w.tabs
          .filter((t) => t.id !== tabId)
          .map((t, i) => (t.renamed ? t : { ...t, name: String(i + 1) }));
        if (remainingTabs.length === 0) {
          const fresh = makeTab("1");
          return updated = { ...w, tabs: [fresh], focusedTabId: fresh.id, panes: remainingPanes };
        }
        const focusedTabId = w.focusedTabId === tabId ? remainingTabs[0].id : w.focusedTabId;
        return updated = { ...w, tabs: remainingTabs, focusedTabId, panes: remainingPanes };
      }),
    );
    if (updated) saveWorkspace(updated);

    if (ws.repo_path) {
      for (const p of worktreesToClean) {
        if (p.worktree) {
          safeRemoveWorktree(ws.repo_path, p.worktree)
            .catch((e) => console.error("failed to remove worktree for closed tab", e));
        }
      }
    }
  };

  // ─── Global keyboard shortcuts (capture-phase) ─────────────────────

  const shortcutData = useRef({ dialog, contextMenu, focusedWsId, workspaces, cmdBarOpen });
  shortcutData.current = { dialog, contextMenu, focusedWsId, workspaces, cmdBarOpen };
  const beginNewWorkspaceRef = useRef<() => void>(() => {});
  beginNewWorkspaceRef.current = beginNewWorkspace;
  const splitPaneRef = useRef<(wsId: string, dir: SplitDir) => void>(async () => {});
  splitPaneRef.current = splitPane;
  const closePaneRef = useRef<(paneId: string) => Promise<void>>(async () => {});
  closePaneRef.current = requestClosePane;
  const zoomPaneRef = useRef<(wsId: string, paneId: string | null) => void>(() => {});
  zoomPaneRef.current = zoomPane;
  const switchTabRef = useRef<(wsId: string, tabId: string) => void>(() => {});
  switchTabRef.current = switchTab;
  const newTabRef = useRef<(wsId: string) => void>(() => {});
  newTabRef.current = newTabInWorkspace;
  const closeTabRef = useRef<(wsId: string, tabId: string) => Promise<void>>(async () => {});
  closeTabRef.current = requestCloseTab;
  const focusPaneRef = useRef<(wsId: string, paneId: string) => void>(() => {});
  focusPaneRef.current = focusPane;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const { dialog, contextMenu, focusedWsId, workspaces, cmdBarOpen } = shortcutData.current;
      if (!e.metaKey) return;
      const stop = () => { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); };

      // ⌘K is checked BEFORE the dialog guard, not after it. Nineteen dialog
      // kinds are declared below `DialogState`, and while any of them was open
      // this handler returned early — so the app's command surface could be
      // switched off by any modal, including the ones it opens itself. A
      // command surface a dialog can disable is a menu with extra steps.
      // Opening the palette closes whatever dialog was up: it is a jump to
      // somewhere else, and leaving a modal stacked behind it would make
      // Escape ambiguous.
      if (e.key.toLowerCase() === "k" && !e.shiftKey && !e.altKey) {
        stop();
        if (dialog.kind !== "none") setDialog({ kind: "none" });
        setCmdBarOpen((v) => !v);
        return;
      }

      if (dialog.kind !== "none" || contextMenu) return;
      // While the palette is up it owns the keyboard. ⌘K itself is handled
      // above, so nothing here can fire behind an open palette — without this
      // guard ⌘D would split a pane the user cannot see.
      if (cmdBarOpen) return;

      // +1 grow / -1 shrink / 0 not a text-size key. ⌘⇧= arrives as "+" and
      // ⌘⇧- as "_", so both shifted forms count; the e.code arms carry the
      // ⌥-modified variants, whose e.key is a different character entirely.
      const textSizeDelta =
        e.key === "=" || e.key === "+" || e.code === "Equal" || e.code === "NumpadAdd" ? 1
        : e.key === "-" || e.key === "_" || e.code === "Minus" || e.code === "NumpadSubtract" ? -1
        : 0;
      const ws = workspaces.find((w: Workspace) => w.id === focusedWsId);
      const tab = ws ? getFocusedTab(ws) : undefined;

      if (e.key === "," && !e.shiftKey && !e.altKey) {
        // ⌘, — the macOS convention for Preferences, and printed by the command
        // bar's Settings row since that row existed. Nothing bound it, so the
        // palette was teaching a shortcut that did nothing, which is worse than
        // teaching none.
        stop();
        openSettings();
      } else if (e.key.toLowerCase() === "n" && !e.shiftKey) {
        // ⌘N is the platform's "new document" and this app's document is a
        // workspace. It was previously reachable only by clicking.
        stop();
        beginNewWorkspaceRef.current();
      } else if (e.key.toLowerCase() === "p" && e.shiftKey) {
        // ⌘⇧P captures a prompt into the personal queue. Only fires while
        // flock is focused — there's no OS-global hotkey in v1.
        stop();
        setDialog({ kind: "queue-capture" });
      } else if (e.key === "d" && !e.shiftKey) {
        stop();
        if (focusedWsId) splitPaneRef.current(focusedWsId, "horizontal");
      } else if (e.key === "d" && e.shiftKey) {
        stop();
        if (focusedWsId) splitPaneRef.current(focusedWsId, "vertical");
      } else if (e.key === "z" && !e.shiftKey) {
        stop();
        // Toggle whatever's currently zoomed (if anything) rather than always
        // targeting the focused pane — those can diverge (e.g. zooming a pane
        // via its own topbar button doesn't refocus it), and zoomPane's
        // internal toggle only flips zoomedPaneId -> null when the id passed
        // in matches what's actually zoomed.
        const zoomTarget = tab?.zoomedPaneId ?? tab?.focusedPaneId;
        if (zoomTarget && focusedWsId) zoomPaneRef.current(focusedWsId, zoomTarget);
      } else if (e.key === "k" && e.shiftKey) {
        // ⌘⇧K closes the focused pane. ⌘W is avoided (macOS native Close Window)
        // and ⌘⌫ is avoided (macOS/terminal shortcut for delete-to-line-start).
        stop();
        if (tab?.focusedPaneId) closePaneRef.current(tab.focusedPaneId);
      } else if (e.key === "t" && !e.shiftKey) {
        stop();
        if (focusedWsId) newTabRef.current(focusedWsId);
      } else if (e.key === "w" && e.shiftKey) {
        // ⌘⇧W closes the focused tab (⌘W alone is macOS's native Close Window).
        stop();
        if (ws) closeTabRef.current(ws.id, ws.focusedTabId);
      } else if ((e.key === "]" || e.key === "[") && !e.shiftKey) {
        // ⌘] / ⌘[ move focus to the next/previous pane in the current tab, so
        // the room is drivable without the mouse — the flight-deck keyboard loop.
        stop();
        const ids = tab?.layoutTree ? allPaneIds(tab.layoutTree) : [];
        if (ws && ids.length > 1) {
          const cur = tab?.focusedPaneId ? ids.indexOf(tab.focusedPaneId) : -1;
          const delta = e.key === "]" ? 1 : -1;
          focusPaneRef.current(ws.id, ids[(cur + delta + ids.length) % ids.length]);
        }
      } else if (e.key.toLowerCase() === "j" && !e.shiftKey) {
        // ⌘J jumps to the next agent waiting on you — across tabs, in tab-then-
        // tree order — so answering a blocked agent never means hunting the grid.
        stop();
        if (ws) {
          const waiting: string[] = [];
          for (const t of ws.tabs) {
            for (const id of (t.layoutTree ? allPaneIds(t.layoutTree) : [])) {
              const p = ws.panes.find((pp) => pp.id === id);
              if (p && (p.status === "awaiting_input" || p.status === "blocked")) waiting.push(id);
            }
          }
          if (waiting.length > 0) {
            const at = tab?.focusedPaneId ? waiting.indexOf(tab.focusedPaneId) : -1;
            focusPaneRef.current(ws.id, waiting[(at + 1) % waiting.length]);
          }
        }
      } else if (textSizeDelta !== 0) {
        // ⌘+ / ⌘- resize the *agent panes* one point — the text the app exists
        // to show. Hold ⌥ to move the app chrome's scale a notch instead; the
        // two are independent settings (see lib/uiScale.ts).
        //
        // Matched on e.code as well as e.key because ⌥ rewrites the character:
        // macOS reports ⌥- as "–" and ⌥= as "≠", so the alt half of this
        // binding is unreachable through e.key alone.
        stop();
        if (e.altKey) stepUiScale(textSizeDelta);
        else stepPaneFontSize(textSizeDelta);
      } else if (/^[1-9]$/.test(e.key) && !e.shiftKey) {
        stop();
        const targetTab = ws?.tabs[Number(e.key) - 1];
        if (ws && targetTab) switchTabRef.current(ws.id, targetTab.id);
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);

  // ⌘K pressed in a popped-out agent window. That webview cannot host the
  // palette (every command acts on state that lives here), so it asks us to
  // open ours; it has already called setFocus on this window.
  useEffect(() => onPaletteSummon(() => {
    setDialog({ kind: "none" });
    setCmdBarOpen(true);
  }), []);

  // ─── Voice-to-text push-to-talk (configurable hotkey) ───────────────
  // Shared with popped-out agent windows via useVoicePushToTalk. The HUD is
  // an in-window overlay (see VoiceOverlay), NOT a separate OS window — a
  // separate window steals macOS keyboard focus every time it appears, which
  // is what repeatedly broke release detection (the keyup fired in the wrong
  // window). In-window, keyboard focus never leaves, so keyup is always seen.
  const { voiceHud, voiceLevel, preview: previewVoiceHud, refresh: refreshVoice } = useVoicePushToTalk({
    getTargetPaneId: () => {
      const ws = workspaces.find((w) => w.id === focusedWsId);
      return ws ? getFocusedTab(ws).focusedPaneId : null;
    },
    guard: () => dialog.kind === "none" && !contextMenu,
  });

  // A dictation that captured pure silence means macOS blocked the mic
  // without raising any error — surface it, otherwise push-to-talk just
  // "does nothing" with no explanation.
  useEffect(() => {
    let un: (() => void) | undefined;
    onVoiceNoAudio(() => {
      pushNotification({
        status: "failure",
        category: "agent",
        priority: true,
        text: "Voice captured no audio — allow microphone access for flock in System Settings → Privacy & Security → Microphone.",
      });
    }).then((fn) => (un = fn));
    return () => un?.();
  }, [pushNotification]);

  const onRenameConfirmed = async (workspaceId: string, newName: string) => {
    setDialog({ kind: "none" });
    await renameWorkspace(workspaceId, newName).catch(console.error);
    let updated: Workspace | undefined;
    setWorkspaces((prev) =>
      prev.map((w) => {
        if (w.id !== workspaceId) return w;
        return updated = { ...w, name: newName };
      }),
    );
    if (updated) saveWorkspace(updated);
  };

  // Closing a workspace tears down its agents (and any worktrees), so gate it
  // behind an "Are you sure?" confirmation rather than deleting on one click.
  const requestCloseWorkspace = (workspaceId: string) => {
    const ws = workspaces.find((w) => w.id === workspaceId);
    if (!ws) return;
    const mode = ws.copilot ? "copilot" : ws.observe ? "observe" : "close";
    setDialog({ kind: "confirm-close", workspaceId, name: ws.name, mode });
  };

  const deleteWorkspace = async (workspaceId: string) => {
    const ws = workspaces.find((w) => w.id === workspaceId);
    // Remove the workspace from state *before* destroying popout windows:
    // the Rust Destroyed hook emits a "return this pane" event, and with
    // the workspace already gone that event no-ops instead of racing to
    // re-insert a pane into a workspace mid-deletion.
    setWorkspaces((prev) => prev.filter((w) => w.id !== workspaceId).map((w) => {
      // Every other workspace that was borrowing one of this one's agents now
      // holds a leaf pointing at a pane that is about to be killed. Release
      // those loans in the same update that removes the workspace, so no tab
      // ever renders a tile for an agent that no longer exists.
      const lost = w.tabs.flatMap((t) => (t.borrowed ?? []).filter((r) => r.workspaceId === workspaceId).map((r) => r.paneId));
      if (lost.length === 0) return w;
      const released = { ...w, tabs: w.tabs.map((t) => {
        let tree = t.layoutTree;
        let refs = t.borrowed;
        for (const id of lost) {
          if (!borrowedOwner(refs, id)) continue;
          tree = tree ? remove(tree, id) : null;
          refs = removeBorrowed(refs, id);
        }
        if (refs === t.borrowed) return t;
        return {
          ...t,
          layoutTree: tree,
          focusedPaneId: tree && t.focusedPaneId && lost.includes(t.focusedPaneId) ? firstPaneId(tree) : (tree ? t.focusedPaneId : null),
          zoomedPaneId: t.zoomedPaneId && lost.includes(t.zoomedPaneId) ? null : t.zoomedPaneId,
          borrowed: refs,
        };
      }) };
      saveWorkspaceRef.current(released);
      return released;
    }));
    // Popped-out panes have their own OS windows — without this they'd
    // outlive the workspace, left showing dead terminals. Unhide now:
    // the Destroyed hook emits "return", but this workspace is already
    // gone so returnPaneToGrid's insert no-ops — the id must not wait.
    if (ws) {
      popoutRef.current = releasePoppedOutMany(popoutRef.current, ws.panes.map((p) => p.id));
      setPoppedOutIds(popoutRef.current.ids);
    }
    for (const p of ws?.panes ?? []) {
      WebviewWindow.getByLabel(`pane-${p.id}`)
        .then((win) => win?.destroy())
        .catch(() => {});
    }

    // An unrestored workspace has no panes in memory; the blob is the only
    // record of its worktrees. Read it before deleteWorkspaceCmd drops the row.
    let worktrees: { path: string; branch: string }[] = [];
    if (ws?.repo_path) {
      if (hydratedWsIds.current.has(workspaceId)) {
        worktrees = ws.panes.flatMap((p) => (p.worktree ? [p.worktree] : []));
      } else {
        const raw = await restoreWorkspace(workspaceId).catch(() => "");
        worktrees = worktreesFromSavedState(raw);
      }
    }

    if (ws?.copilot) {
      const myPaneIds = ws.panes.filter((p) => !p.streamId).map((p) => p.id);
      await endCopilot(ws.copilot.partnerLogin, ws.copilot.partnerWid, ws.copilot.sessionId, myPaneIds);
    } else if (ws?.observe) {
      endObserve(ws.observe.ownerLogin, ws.observe.ownerWid, ws.observe.sessionId);
    } else {
      await deleteWorkspaceCmd(workspaceId).catch(console.error);
    }
    if (focusedWsId === workspaceId) {
      const rest = workspaces.filter((w) => w.id !== workspaceId);
      setFocusedWsId(rest[0]?.id ?? null);
    }

    if (ws?.repo_path) {
      for (const wt of worktrees) {
        safeRemoveWorktree(ws.repo_path, wt)
          .catch((e) => console.error("failed to remove worktree for deleted workspace", e));
      }
    }
  };

  // Drag-and-drop reorder in the sidebar. `fromIndex`/`toIndex` are indices
  // into the *displayed* list — which pins PR-review workspaces first (see
  // orderForDisplay) — so they're translated back to state-array positions by
  // workspace id before splicing. The underlying state order (what persists)
  // is only ever changed relative to the card actually dropped on.
  const reorderWorkspacesLocal = (fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return;
    setWorkspaces((prev) => {
      const display = orderForDisplay(prev);
      const fromId = display[fromIndex]?.id;
      const toId = display[toIndex]?.id;
      if (!fromId || !toId || fromId === toId) return prev;
      const next = [...prev];
      const fi = next.findIndex((w) => w.id === fromId);
      const [moved] = next.splice(fi, 1);
      const ti = next.findIndex((w) => w.id === toId);
      // Dragging downwards lands *after* the card under the cursor, upwards
      // lands before it — same feel as the old index-splice behavior.
      next.splice(toIndex > fromIndex ? ti + 1 : ti, 0, moved);
      reorderWorkspacesCmd(next.map((w) => w.id)).catch(console.error);
      return next;
    });
  };

  // ─── Context menus ─────────────────────────────────────────────────

  const openWorkspaceMenu = (workspaceId: string, e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    const ws = workspaces.find((w) => w.id === workspaceId);
    if (!ws) return;
    setContextMenu({
      x: e.clientX, y: e.clientY,
      items: [
        { label: "New Agent Here", onClick: () => spawnAgentInWorkspace(workspaceId) },
        // Only where there's a repo to branch: a co-pilot or observe workspace
        // has no repo_path, and a race is nothing but branches.
        ...(ws.repo_path ? [{ label: "Race Agents…", onClick: () => setDialog({ kind: "race", workspaceId }) }] : []),
        { label: "", divider: true },
        { label: "Rename Workspace…", onClick: () => setDialog({ kind: "rename-workspace", workspaceId, current: ws.name }) },
        { label: "Delete Workspace", danger: true, onClick: () => requestCloseWorkspace(workspaceId) },
      ],
    });
  };

  /** Lay another workspace's agent out in this tab. The loan is recorded on
   * the tab, the pane record is not moved: the lending workspace keeps the
   * agent in its own tabs, keeps its worktree, keeps its jail, and keeps the
   * right to close it. Nothing here spawns, and nothing here can outlive the
   * lender - if that workspace is deleted, `borrowedByWorkspace` stops
   * resolving the ref and the leaf becomes a ghost the next reconcile drops. */
  const borrowPanesIntoTab = (workspaceId: string, paneIds: string[]) => {
    const loans = paneIds
      .map((paneId) => ({ paneId, owner: ownerOfPane(paneId) }))
      .filter((l): l is { paneId: string; owner: Workspace } => !!l.owner && l.owner.id !== workspaceId);
    if (loans.length === 0) return;
    let updated: Workspace | undefined;
    setWorkspaces((prev) =>
      prev.map((w) => {
        if (w.id !== workspaceId) return w;
        const tab = getFocusedTab(w);
        return updated = {
          ...w,
          tabs: w.tabs.map((t) => {
            if (t.id !== tab.id) return t;
            let layoutTree = t.layoutTree;
            let borrowed = t.borrowed;
            for (const l of loans) {
              layoutTree = appendLeaf(layoutTree, l.paneId);
              borrowed = addBorrowed(borrowed, { paneId: l.paneId, workspaceId: l.owner.id });
            }
            return {
              ...t,
              layoutTree,
              focusedPaneId: loans[0].paneId,
              // A zoomed tab would hide the panes the user just asked to see.
              zoomedPaneId: null,
              borrowed,
            };
          }),
        };
      }),
    );
    if (updated) saveWorkspace(updated);
  };

  /** End a loan. Removes the leaf and the ref; never touches the agent, which
   * is still laid out in its own workspace exactly as it was. */
  const returnBorrowedPane = (workspaceId: string, paneId: string) => {
    let updated: Workspace | undefined;
    setWorkspaces((prev) =>
      prev.map((w) => {
        if (w.id !== workspaceId) return w;
        return updated = {
          ...w,
          tabs: w.tabs.map((t) => {
            if (!borrowedOwner(t.borrowed, paneId)) return t;
            const layoutTree = t.layoutTree ? remove(t.layoutTree, paneId) : null;
            return {
              ...t,
              layoutTree,
              focusedPaneId: t.focusedPaneId === paneId ? (layoutTree ? firstPaneId(layoutTree) : null) : t.focusedPaneId,
              zoomedPaneId: t.zoomedPaneId === paneId ? null : t.zoomedPaneId,
              borrowed: removeBorrowed(t.borrowed, paneId),
            };
          }),
        };
      }),
    );
    if (updated) saveWorkspace(updated);
  };

  const openPaneMenu = (workspaceId: string, paneId: string | null, e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    // Refs, not render-scope state — so a stale instance kept by memo(PaneArea)
    // still reads the current workspaces/queue at call (right-click) time.
    const wsList = workspacesRef.current;
    const ws = wsList.find((w) => w.id === workspaceId);
    const items: MenuItem[] = [];

    /* Agents from other workspaces, offered as a loan rather than a move: the
     * pane keeps running where it lives and this tab merely lays it out. Only
     * ones not already somewhere in this workspace, and only real agents - a
     * co-pilot or observe pane is already a mirror of someone else's terminal,
     * and a mirror of a mirror answers no question. */
    const pushBringIn = () => {
      const here = new Set(ws?.tabs.flatMap((t) => t.layoutTree ? allPaneIds(t.layoutTree) : []) ?? []);
      const lenders = wsList
        .filter((w) => w.id !== workspaceId && !w.copilot && !w.observe)
        .map((w) => ({ w, panes: w.panes.filter((p) => !p.streamId && !here.has(p.id)) }))
        .filter((l) => l.panes.length > 0);
      if (lenders.length === 0) return;
      items.push({ label: "", divider: true });
      items.push({
        label: "Bring In Agent",
        submenu: lenders.flatMap(({ w, panes }) =>
          panes.map((p) => ({
            label: `${w.name} · ${p.displayName ?? agentLabel(p.kind)}`,
            onClick: () => borrowPanesIntoTab(workspaceId, [p.id]),
          })),
        ),
      });
      // The whole workspace in one gesture, which is the shape of the actual
      // intent behind this feature: watch what another project's agents are
      // doing, not assemble a grid one pane at a time. Offered only where it
      // differs from the item above, since a workspace with one agent would
      // otherwise appear twice saying the same thing.
      const wholesale = lenders.filter((l) => l.panes.length > 1);
      if (wholesale.length > 0) {
        items.push({
          label: "Bring In Workspace",
          submenu: wholesale.map(({ w, panes }) => ({
            label: `${w.name} · ${panes.length} agents`,
            onClick: () => borrowPanesIntoTab(workspaceId, panes.map((p) => p.id)),
          })),
        });
      }
    };

    if (paneId === null) {
      AGENT_KINDS.forEach((kind) => {
        items.push({
          label: `Spawn ${agentLabel(kind)}`,
          onClick: () => spawnAgentInWorkspace(workspaceId, undefined, undefined, kind),
        });
      });
      pushBringIn();
    } else {
      const selection = getTerminalSelection(paneId);
      const selectionUrl = getSelectionUrl(paneId);
      items.push({
        label: "Copy",
        disabled: !selection,
        onClick: () => copyText(selection).catch(() => flashPanePill(paneId, "copy failed", true)),
      });
      items.push({
        label: "Copy URL",
        disabled: !selectionUrl,
        onClick: () => copyText(selectionUrl ?? "").catch(() => flashPanePill(paneId, "copy failed", true)),
      });
      // Prompt-queue bridge: with text typed into the input line, lift it into
      // the queue; with an empty line, drop a queued prompt back in for review.
      const inputLine = getInputLine(paneId).trim();
      const queued = queueItemsRef.current.filter((i) => i.status === "queued");
      if (inputLine) {
        items.push({ label: "", divider: true });
        items.push({ label: "Send to Prompt Queue", onClick: () => void sendInputLineToQueue(paneId) });
      } else if (queued.length > 0) {
        items.push({ label: "", divider: true });
        items.push({
          label: `Insert from Prompt Queue (${queued.length})`,
          submenu: queued
            .slice()
            .reverse()
            .map((q) => ({
              label: queuePreview(q.text),
              onClick: () => sendPromptToPane(paneId, q.text),
            })),
        });
      }
      items.push({ label: "", divider: true });
      AGENT_KINDS.forEach((kind) => {
        items.push({
          label: `Spawn ${agentLabel(kind)}`,
          onClick: () => spawnAgentInWorkspace(workspaceId, undefined, undefined, kind),
        });
      });
      pushBringIn();
      items.push({ label: "", divider: true });
      items.push({ label: "Split Right", shortcut: "⌘D", onClick: () => splitPane(workspaceId, "horizontal") });
      items.push({ label: "Split Down", shortcut: "⌘⇧D", onClick: () => splitPane(workspaceId, "vertical") });
      // Menu twin of dragging a pane's topbar onto another pane — the same
      // swap, reachable without a mouse drag (and without hunting for the
      // drop target in a 12-pane grid).
      const paneTab = ws?.tabs.find((t) => t.layoutTree && allPaneIds(t.layoutTree).includes(paneId));
      const swappable = paneTab?.layoutTree
        ? allPaneIds(paneTab.layoutTree).filter((id) => id !== paneId)
        : [];
      if (paneTab && swappable.length > 0) {
        items.push({
          label: "Swap Position With",
          submenu: swappable.map((id) => {
            const other = ws?.panes.find((p) => p.id === id);
            return {
              label: other?.displayName ?? other?.kind ?? id,
              onClick: () => swapPanesInTab(workspaceId, paneTab.id, paneId, id),
            };
          }),
        });
      }
      items.push({ label: "", divider: true });
      items.push({ label: (ws && getFocusedTab(ws).zoomedPaneId === paneId) ? "Unzoom Pane" : "Zoom Pane", shortcut: "⌘Z", onClick: () => zoomPane(workspaceId, paneId) });
      // A borrowed pane is not this tab's to close. Offer the loan back
      // instead, and say whose agent it is so the two are never confused.
      const lentFrom = ws?.tabs.map((t) => borrowedOwner(t.borrowed, paneId)).find(Boolean);
      if (lentFrom) {
        const home = wsList.find((w) => w.id === lentFrom);
        items.push({ label: `Return to ${home?.name ?? "its workspace"}`, onClick: () => returnBorrowedPane(workspaceId, paneId) });
      } else {
        items.push({ label: "Close Pane", shortcut: "⌘⇧K", danger: true, onClick: () => requestClosePane(paneId) });
      }
      items.push({ label: "", divider: true });
      items.push({ label: "Clear Terminal", onClick: () => sendInput(paneId, new TextEncoder().encode("\f")).catch(console.error) });
      if (ownerOfPane(paneId)?.panes.find((p) => p.id === paneId)?.intent) {
        items.push({ label: "Reset Intent", onClick: () => resetPaneIntent(paneId) });
      }
      // The OWNING workspace's repo, not the displaying tab's. A borrowed pane
      // sitting in another workspace's tab would otherwise open a checkout it
      // has never touched, under a label saying "here".
      const paneOwner = ownerOfPane(paneId) ?? ws;
      if (paneOwner?.repo_path) {
        // Menu twin of the header's terminal button, but scoped to THIS pane —
        // an agent on its own worktree opens that checkout, not the shared one.
        // All four use paneCwd: this is a *pane's* menu, so "here" has to mean
        // the same directory in every one of them. Three of them used to read
        // ws.repo_path while their sibling read the pane's cwd, so with
        // per-agent worktrees on, "Open in Terminal" landed in the agent's
        // branch and "Open in Finder" one directory away in the shared repo —
        // silently the wrong tree to go poking around in.
        const paneCwd = paneOwner.panes.find((p) => p.id === paneId && !p.streamId)?.cwd || paneOwner.repo_path;
        items.push({ label: "Open in Terminal", onClick: () => void openTerminalHere(paneCwd) });
        items.push({ label: "Open in Finder", onClick: () => openPath(paneCwd).catch(console.error) });
        items.push({ label: "Open in VS Code", onClick: () => openPath(paneCwd, "Visual Studio Code").catch(console.error) });
        items.push({ label: "Copy Path", onClick: () => copyText(paneCwd).catch(() => flashPanePill(paneId, "copy failed", true)) });
      }
    }
    setContextMenu({ x: e.clientX, y: e.clientY, items });
  };

  // ─── Pane status updates ───────────────────────────────────────────

  /** Summarize a finished review agent's terminal into a stored PR summary.
   * Fired from updatePaneStatus for panes tracked in reviewPanesRef, on the
   * working → idle/awaiting_input edge only, at most once per working-streak
   * (the guard set re-arms when the pane goes working again). */
  const maybeSummarizeReviewPane = (paneId: string, status: AgentStatusStr) => {
    const pr = reviewPanesRef.current.get(paneId);
    if (!pr) return;
    const prevStatus = reviewPaneStatusRef.current.get(paneId);
    reviewPaneStatusRef.current.set(paneId, status);
    if (status === "working") { summarizedPanesRef.current.delete(paneId); return; }
    if (prevStatus !== "working") return;
    if (status !== "idle" && status !== "awaiting_input") return;
    if (summarizedPanesRef.current.has(paneId)) return;
    summarizedPanesRef.current.add(paneId);
    void summarizeReviewPane(paneId, pr);
  };

  const summarizeReviewPane = async (paneId: string, pr: { repo: string; number: number }) => {
    const text = getTerminalBuffer(paneId);
    if (!text) return;
    try {
      const summary = await summarizeReview(text);
      if (!summary) return;
      await prReviewSetSummary(pr.repo, pr.number, summary, paneId);
      setPrSummaries(await prReviewGetSummaries());
      pushNotification({
        status: "success",
        category: "pr",
        priority: true,
        text: `Review of ${pr.repo}#${pr.number} ready — open the PR modal`,
      });
    } catch (e) {
      console.error("review summary failed", e);
    }
  };

  const updatePaneStatus = (paneId: string, status: AgentStatusStr) => {
    maybeSummarizeReviewPane(paneId, status);
    setWorkspaces((prev) => {
      // Touch ONLY the workspace that owns the pane. The old version spread
      // every workspace and rebuilt every panes array on each status tick (which
      // fire several times a second across live agents), giving every workspace
      // a fresh identity and forcing a full re-render of all mounted PaneAreas.
      // Now unchanged workspaces keep their identity, and an unchanged status
      // bails before allocating anything at all — no state change, no re-render.
      const wi = prev.findIndex((w) => w.panes.some((p) => p.id === paneId));
      if (wi < 0) return prev;
      const w = prev[wi];
      const pi = w.panes.findIndex((p) => p.id === paneId);
      // Only restamp statusChangedAt on a real transition, so "idle 3m" measures
      // time in the *current* state, not since the last identical emission.
      if (w.panes[pi].status === status) return prev;
      const panes = w.panes.slice();
      panes[pi] = { ...panes[pi], status, statusChangedAt: Date.now() };
      const next = prev.slice();
      next[wi] = { ...w, panes };
      return next;
    });
  };

  // Merge an intent patch onto a pane and persist. Stored on the pane and
  // persisted (unlike status) so the "what was this agent doing?" reminder
  // survives an app restart.
  const patchPaneIntent = (paneId: string, patch: Pick<Pane, "intent" | "intentRaw" | "promptHistory">) => {
    setWorkspaces((prev) => {
      const next = prev.map((w) =>
        w.panes.some((p) => p.id === paneId)
          ? { ...w, panes: w.panes.map((p) => (p.id === paneId ? { ...p, ...patch } : p)) }
          : w,
      );
      const changed = next.find((w) => w.panes.some((p) => p.id === paneId));
      if (changed) queueMicrotask(() => saveWorkspace(changed));
      return next;
    });
  };

  // Patch the pane's `model` (set from a sniffed `/model` command) and persist,
  // mirroring patchPaneIntent so it survives restarts.
  const patchPaneModel = (paneId: string, model: string | undefined) => {
    setWorkspaces((prev) => {
      const next = prev.map((w) =>
        w.panes.some((p) => p.id === paneId)
          ? { ...w, panes: w.panes.map((p) => (p.id === paneId ? { ...p, model } : p)) }
          : w,
      );
      const changed = next.find((w) => w.panes.some((p) => p.id === paneId));
      if (changed) queueMicrotask(() => saveWorkspace(changed));
      return next;
    });
  };

  /** The agent has the terminal: lift the boot card. Fired by Terminal on the
   *  marker the launch line writes just before the agent runs — or on the
   *  process exiting, so a pane that died on the way up shows why instead of
   *  claiming to still be starting.
   *
   *  Stable identity (useCallback []) for the same reason updatePaneIntent is:
   *  it goes straight to the memo'd Terminal, and re-creating it every render
   *  would re-render every pane's terminal. Nothing here closes over state. */
  const onAgentStart = useCallback((paneId: string) => {
    setWorkspaces((prev) => {
      if (!prev.some((w) => w.panes.some((p) => p.id === paneId && p.booting))) return prev;
      return prev.map((w) =>
        w.panes.some((p) => p.id === paneId)
          ? { ...w, panes: w.panes.map((p) => (p.id === paneId ? { ...p, booting: false, phase: undefined } : p)) }
          : w,
      );
    });
  }, []);

  // A submitted `/model <name>` (or `/models <name>`) switches the pane's model.
  // Returns the chosen model token, or null if this isn't a model command or
  // carries no argument (a bare `/model` opens the agent's interactive picker,
  // whose outcome we can't observe from keystrokes). Kept short: we display the
  // token verbatim, so `opus` / `sonnet[1m]` / `claude-opus-4-8` all pass through.
  const parseModelCommand = (raw: string): string | null => {
    const m = raw.trim().match(/^\/models?\b\s*(\S+)?/i);
    if (!m) return null;
    const arg = m[1]?.trim();
    if (!arg) return null;
    return arg.length > 24 ? arg.slice(0, 24) : arg;
  };

  // Intent history, sniffed by Terminal on every prompt the user submits into
  // a pane (not just the first) — a rolling window of the last few raw
  // prompts per pane, so the label can track where the task has moved on to
  // instead of freezing on an early one-off like "checkout master".
  const intentHistoryRef = useRef<Map<string, string[]>>(new Map());
  const intentDebounceRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const INTENT_HISTORY_SIZE = 5;
  const INTENT_DEBOUNCE_MS = 1200;
  // Longer, persisted per-pane prompt log powering the topbar intent dropdown
  // (re-send a past prompt). Seeded lazily from the pane's saved promptHistory
  // so it survives restarts; the ref is the always-current source of truth
  // within a burst of submissions (the `workspaces` closure can lag).
  const promptHistoryRef = useRef<Map<string, string[]>>(new Map());
  const PROMPT_HISTORY_SIZE = 25;

  // Quick client-side check gating only the *instant* raw label: does this
  // prompt look like a real task, or a one-off nav/admin command we'd rather
  // not flash into the UI before the summarizer decides how to fold it in?
  // Everything is still sent to the summarizer regardless — this only avoids a
  // bare "/model" or "git status" briefly becoming the label.
  const looksLikeTask = (raw: string): boolean => {
    const s = raw.trim();
    if (s.length < 3) return false;
    if (s.startsWith("/")) return false; // slash-commands (/model, /status, …)
    return !/^(ls|cd|pwd|clear|exit|q|quit|status|help|which|echo|cat|git (status|checkout|switch|log|diff|pull|push|stash|branch|fetch))\b/i.test(s);
  };

  // Fold a newly submitted prompt into the pane's rolling history. If the
  // pane has no label yet, show the raw prompt immediately for instant
  // feedback; otherwise leave the visible label alone until the debounced
  // summarizer (below) confirms a new one — so a mid-task navigational
  // command can't flash into the label before its context catches up. The
  // full recent history is kept as `intentRaw` for the tooltip.
  // Stable identity (useCallback []) so it can be passed straight to the
  // React.memo'd Terminal without re-rendering every terminal on each App
  // render. Safe because every value it touches is a ref (intentHistoryRef,
  // promptHistoryRef, intentDebounceRef, workspacesRef) or a functional-update /
  // arg-based helper (patchPaneModel, patchPaneIntent, saveWorkspace) whose
  // behavior is identical across renders — nothing closes over render-scope
  // state. In particular it reads workspacesRef.current, NOT the render-scope
  // `workspaces` (which would go stale the instant this is memoized).
  const updatePaneIntent = useCallback((paneId: string, raw: string) => {
    // A `/model` command isn't a task — capture the model for the sidebar chip
    // and don't fold it into the intent label/history.
    const model = parseModelCommand(raw);
    if (model) { patchPaneModel(paneId, model); return; }

    const history = intentHistoryRef.current.get(paneId) ?? [];
    history.push(raw);
    if (history.length > INTENT_HISTORY_SIZE) history.shift();
    intentHistoryRef.current.set(paneId, history);
    const joinedRaw = history.join(" → ");

    const existingPane = workspacesRef.current.flatMap((w) => w.panes).find((p) => p.id === paneId);
    const instant = existingPane?.intent ?? (looksLikeTask(raw) ? raw : undefined);

    // Persisted prompt log for the intent dropdown: append (skipping an exact
    // consecutive repeat), cap the length. Seed from the pane's saved history
    // the first time we touch it this session.
    let log = promptHistoryRef.current.get(paneId);
    if (!log) { log = [...(existingPane?.promptHistory ?? [])]; promptHistoryRef.current.set(paneId, log); }
    if (log[log.length - 1] !== raw) log.push(raw);
    while (log.length > PROMPT_HISTORY_SIZE) log.shift();

    patchPaneIntent(paneId, { intent: instant, intentRaw: joinedRaw, promptHistory: [...log] });

    // Debounce so a burst of quick submissions (corrections, retries)
    // coalesces into one summarizer call instead of one per prompt.
    const existingTimer = intentDebounceRef.current.get(paneId);
    if (existingTimer) clearTimeout(existingTimer);
    intentDebounceRef.current.set(
      paneId,
      setTimeout(() => {
        intentDebounceRef.current.delete(paneId);
        const prompts = intentHistoryRef.current.get(paneId) ?? [];
        if (prompts.length === 0) return;
        summarizeIntent(prompts.join("\n"))
          .then((summary) => {
            if (summary) patchPaneIntent(paneId, { intent: summary, intentRaw: joinedRaw });
          })
          .catch(() => { /* keep the current label */ });
      }, INTENT_DEBOUNCE_MS),
    );
    // Deps intentionally empty: see the comment on the declaration — every
    // referenced binding is a ref or a behaviorally-stable helper.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Clear a pane's captured intent and history — for when the captured
  // prompts were a stray "ls" or the task has moved on and the label should
  // start fresh from the next submitted prompt.
  const resetPaneIntent = (paneId: string) => {
    intentHistoryRef.current.delete(paneId);
    promptHistoryRef.current.delete(paneId);
    const timer = intentDebounceRef.current.get(paneId);
    if (timer) { clearTimeout(timer); intentDebounceRef.current.delete(paneId); }
    patchPaneIntent(paneId, { intent: undefined, intentRaw: undefined, promptHistory: [] });
  };

  // Drop a past prompt back into the agent's input line — no trailing Enter,
  // so the user reviews/edits before submitting. Powers the topbar intent
  // history dropdown.
  const sendPromptToPane = (paneId: string, text: string) => {
    // Bracketed, like a real paste: a multi-line prompt then lands in the input
    // box as newlines instead of the agent (or a shell) submitting at the first
    // one and swallowing the rest.
    const paste = `\x1b[200~${text}\x1b[201~`;
    sendInput(paneId, new TextEncoder().encode(paste)).catch(console.error);
    // The bytes bypass xterm's onData, so tell the sniffer about them or a later
    // "Send to Prompt Queue" would miss this text and mis-clear the input line.
    noteInjectedInput(paneId, paste);
  };

  // ─── Presence (Ably) ───────────────────────────────────────────────

  // Connect to Ably once signed in to flock ID with a claimed handle —
  // the handle is the wire identity (Ably clientId) for presence and
  // session signaling. Reconnects when the handle changes.
  useEffect(() => {
    const myHandle = idProfile?.handle;
    if (!myHandle) {
      disconnectPresence();
      setPresenceStatus("connecting");
      return;
    }

    // Include our own handle so a second window shows up in the friends list
    const friendHandles = [...new Set([
      myHandle,
      ...friends.map((f) => f.handle),
    ])].filter(Boolean);
    const agentCount = workspaces.reduce((n, w) => n + w.panes.length, 0);

    // Fresh access token per Ably (re)auth — flock ID tokens expire hourly.
    const getToken = async () => {
      const { data } = await supabase().auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("flock ID session expired");
      return token;
    };

    // Reset the transition tracker for this connection: the initial backfill
    // burst below establishes the baseline silently (primed stays false until
    // connect resolves), so we only toast changes after that.
    presencePrevRef.current.clear();
    presencePrimedRef.current = false;

    connectPresence(getToken, friendHandles, agentCount, (event) => {
      const next: "online" | "offline" = event.kind === "offline" ? "offline" : "online";
      const prevPresence = presencePrevRef.current.get(event.login);
      presencePrevRef.current.set(event.login, next);
      // Toast only a genuine change, and only once the baseline is primed.
      // "update" events (agent-count changes) keep next==="online", so a friend
      // already online doesn't re-toast.
      if (presencePrimedRef.current && prevPresence !== next) {
        if (next === "online") {
          const n = "agentCount" in event ? event.agentCount : 0;
          pushNotification({ status: "info", category: "agent", priority: false,
            text: `@${event.login} connected${n ? ` — ${n} agent${n === 1 ? "" : "s"} running` : ""}` });
        } else {
          pushNotification({ status: "info", category: "agent", priority: false,
            text: `@${event.login} disconnected` });
        }
      }
      setFriends((prev) => prev.map((f) => {
        if (f.handle !== event.login) return f;
        if (event.kind === "online")  return { ...f, presence: "online",  agentCount: event.agentCount, windowId: event.windowId };
        if (event.kind === "offline") return { ...f, presence: "offline", agentCount: 0, windowId: undefined, lastSeen: Math.floor(Date.now() / 1000) };
        if (event.kind === "update")  return { ...f, presence: "online",  agentCount: event.agentCount, windowId: event.windowId };
        return f;
      }));
    }, setPresenceStatus).then(() => {
      // Baseline is now established (initial members synced) — start toasting
      // real transitions from here on.
      presencePrimedRef.current = true;
      // Init session signaling once presence is established. Route through the
      // ref so the *current* handler (with live state) always runs, not the
      // stale one captured when presence first connected.
      initSessions(myHandle, (msg) => handleSessionMsgRef.current(msg));
    }).catch(console.error);

    return () => disconnectPresence();
  }, [idProfile?.handle]);

  // Broadcast agent count changes without reconnecting
  useEffect(() => {
    const agentCount = workspaces.reduce((n, w) => n + w.panes.length, 0);
    updateAgentCount(agentCount).catch(console.error);
  }, [workspaces]);

  // Update the presence filter whenever the set of friends changes, and
  // backfill presence for any of them already online (e.g. a friend you just
  // added who was online before you started tracking them).
  const friendKey = friends.map((f) => f.handle).sort().join(",");
  useEffect(() => {
    updateFriends(friends.map((f) => f.handle));
    resyncFriendPresence();
  }, [friendKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Friends ───────────────────────────────────────────────────────


  // ─── Sessions ──────────────────────────────────────────────────────

  /** Build a fresh co-pilot workspace shell with no panes yet. */
  /** Build a single-pane observe workspace (read-only). */
  const newObserveWorkspace = useCallback((
    sessionId: string,
    ownerLogin: string,
    ownerWid: string,
    ownerAvatar: string | undefined,
    paneLabel: string,
  ): Workspace => {
    const wsId = `observe:${sessionId}`;
    const remotePane = {
      id: `${wsId}:pane`,
      workspaceId: wsId,
      kind: paneLabel,
      status: "idle" as AgentStatusStr,
      statusChangedAt: Date.now(),
      attention: false,
      streamId: sessionId, // observe streams use session_id as the channel
      cwd: "", // remote pane — no local working directory
    };
    const tab = makeTab("1");
    return {
      id: wsId,
      name: `observing · ${ownerLogin}`,
      repo_path: "",
      branch: "live",
      created_at: Date.now(),
      // The palette's gold slot, by token: the literal #f4d49b this used to
      // carry is a Nightfall pastel and reads at 1.27:1 on Daybreak's paper.
      accentColor: "var(--ws-accent-5)",
      panes: [remotePane],
      tabs: [{ ...tab, layoutTree: { type: "leaf", paneId: remotePane.id }, focusedPaneId: remotePane.id }],
      focusedTabId: tab.id,
      agentKind: "claude" as AgentKind,
      observe: { sessionId, ownerLogin, ownerWid, ownerAvatar },
    };
  }, []);

  const newCopilotWorkspace = useCallback((
    sessionId: string,
    partnerLogin: string,
    partnerWid: string,
    partnerAvatar: string | undefined,
    // The inviter starts "pending" and flips to "connected" on copilot_accept;
    // the guest passes "connected" since they build this by accepting.
    status: "pending" | "connected" = "pending",
  ): Workspace => {
    const tab = makeTab("1");
    return {
      id: `copilot:${sessionId}`,
      name: `co-pilot · ${partnerLogin}`,
      repo_path: "",
      branch: "shared",
      created_at: Date.now(),
      // The palette's slot 6, by token, for the same reason as observe above.
      accentColor: "var(--ws-accent-6)",
      panes: [],
      tabs: [tab],
      focusedTabId: tab.id,
      agentKind: "claude" as AgentKind,
      copilot: { sessionId, partnerLogin, partnerWid, partnerAvatar, status },
    };
  }, []);

  /** Merge partner's panes into an existing co-pilot workspace, preserving local panes. */
  const mergePartnerPanes = useCallback((ws: Workspace, partnerPanes: CopilotPane[]): Workspace => {
    const wsId = ws.id;
    const localPanes = ws.panes.filter((p) => !p.streamId);
    const remotePanes = partnerPanes.map((p) => ({
      id: `${wsId}:${p.id}`,
      workspaceId: wsId,
      kind: p.label,
      status: "idle" as AgentStatusStr,
      statusChangedAt: Date.now(),
      attention: false,
      streamId: p.id,
      cwd: "", // remote pane — no local working directory
    }));
    const allPanes = [...localPanes, ...remotePanes];
    const n = allPanes.length;
    const cols = n <= 1 ? 1 : n <= 4 ? 2 : 3;
    const rows = Math.ceil(n / cols);
    const layoutTree = n > 0 ? buildGridLayout(allPanes.map((p) => p.id), rows, cols) : null;
    const tab = getFocusedTab(ws);
    const focusedPaneId = allPanes.find((p) => p.id === tab.focusedPaneId)?.id ?? allPanes[0]?.id ?? null;
    return { ...ws, panes: allPanes, tabs: ws.tabs.map((t) => t.id === tab.id ? { ...t, layoutTree, focusedPaneId } : t) };
  }, []);

  /** Settle a co-pilot workspace's status to "connected" (idempotent). */
  const markCopilotConnected = useCallback((ws: Workspace): Workspace =>
    ws.copilot && ws.copilot.status !== "connected"
      ? { ...ws, copilot: { ...ws.copilot, status: "connected" } }
      : ws,
  []);

  const handleSessionMsg = useCallback((msg: SessionMsg) => {
    // Authorization gate. `msg.from` is already proven authentic in session.ts
    // (it must equal Ably's verified clientId), so it's safe to allowlist on:
    // only accepted friends — or our own other windows in the self-test — may
    // drive observe/co-pilot/task control. This stops a stranger from sending
    // spoofed requests or a one-click task-injection that runs in our agent.
    const isSelf = msg.from === idProfile?.handle;
    const friend = friends.find((f) => f.handle === msg.from);
    if (!friend && !isSelf) return;
    const focusedWs = workspaces.find((w) => w.id === focusedWsId);

    // ── Observe ──────────────────────────────────────────────────────────────
    if (msg.type === "observe_request") {
      pushNotification({ status: "info", category: "agent", priority: false, text: `@${msg.from} asked to watch your terminal` });
      // The notification above is unconditional. Only the pop-up is suppressible.
      if (isToastSuppressed("observe_request")) return;
      setSessionToasts((prev) => [...prev, {
        id: msg.session_id,
        kind: "observe_request",
        fromLogin: msg.from,
        fromAvatar: friend?.avatarUrl,
        sessionId: msg.session_id,
        onAccept: () => {
          // Resolve the shared pane NOW — the toast may have arrived while
          // no pane was focused (the old silent no-op), or focus moved.
          const target = resolveShareTarget();
          if (!target) {
            declineObserve(msg.from, msg.from_wid, msg.session_id);
            pushNotification({ status: "info", category: "agent", priority: true, text: `No agent running to share — @${msg.from}'s request was declined. Spawn an agent and have them retry.` });
            return;
          }
          observeSharesRef.current.set(msg.session_id, target.pane.id);
          acceptObserve(msg.from, msg.from_wid, msg.session_id, target.pane.id, target.pane.displayName ?? target.pane.kind);
          pushNotification({ status: "success", category: "agent", priority: false, text: `@${msg.from} is watching ${target.pane.displayName ?? target.pane.kind} live` });
        },
        onDecline: () => declineObserve(msg.from, msg.from_wid, msg.session_id),
      }]);
    }
    if (msg.type === "observe_accept") {
      const ws = newObserveWorkspace(
        msg.session_id, msg.from, msg.from_wid, friend?.avatarUrl, msg.pane_label,
      );
      setWorkspaces((prev) => [...prev, ws]);
      setFocusedWsId(ws.id);
      pushNotification({ status: "success", category: "agent", priority: false, text: `Connected to @${msg.from}'s ${msg.pane_label}` });
    }
    if (msg.type === "observe_decline" || msg.type === "observe_end") {
      // Observer side: drop the observe workspace.
      const wsId = `observe:${msg.session_id}`;
      const wasObserving = workspaces.some((w) => w.id === wsId);
      setWorkspaces((prev) => prev.filter((w) => w.id !== wsId));
      setFocusedWsId((prev) => prev === wsId ? null : prev);
      if (msg.type === "observe_decline") {
        pushNotification({ status: "info", category: "agent", priority: true, text: `@${msg.from} declined to share their terminal` });
      }
      // Owner side: the observer left — stop publishing that pane's bytes.
      const sharedPaneId = observeSharesRef.current.get(msg.session_id);
      if (msg.type === "observe_end" && sharedPaneId) {
        observeSharesRef.current.delete(msg.session_id);
        import("./lib/streamPublisher").then(({ stopStream }) => stopStream(sharedPaneId));
        pushNotification({ status: "info", category: "agent", priority: false, text: `@${msg.from} disconnected from your terminal` });
      } else if (msg.type === "observe_end" && wasObserving) {
        // Observer side: the owner stopped sharing their terminal.
        pushNotification({ status: "info", category: "agent", priority: false, text: `@${msg.from} disconnected — stopped sharing their terminal` });
      }
    }

    // ── Task handoff ─────────────────────────────────────────────────────────
    if (msg.type === "task_send") {
      pushNotification({ status: "info", category: "agent", priority: false, text: `@${msg.from} sent you a task` });
      if (isToastSuppressed("task_send")) return;
      setSessionToasts((prev) => [...prev, {
        id: msg.task_id,
        kind: "task_send",
        fromLogin: msg.from,
        fromAvatar: friend?.avatarUrl,
        sessionId: msg.task_id,
        prompt: msg.prompt,
        onAccept: async () => {
          // Resolve at accept time. With an agent running, the prompt is
          // typed into it (\r submits — \n never did); with none, a fresh
          // agent is spawned carrying the task as its opening prompt.
          const target = resolveShareTarget();
          if (target) {
            const { sendInput: sendInputCmd } = await import("./lib/tauri");
            await sendInputCmd(target.pane.id, new TextEncoder().encode(msg.prompt + "\r"));
          } else {
            const ws = workspacesRef.current.find((w) => w.id === focusedWsIdRef.current && !w.observe && !w.copilot)
              ?? workspacesRef.current.find((w) => !w.observe && !w.copilot);
            if (!ws) {
              declineTask(msg.from, msg.from_wid, msg.task_id);
              pushNotification({ status: "info", category: "agent", priority: true, text: `No workspace open for @${msg.from}'s task — it was declined.` });
              return;
            }
            await spawnAgentInWorkspace(ws.id, msg.prompt).catch(console.error);
          }
          acceptTask(msg.from, msg.from_wid, msg.task_id);
          pushNotification({ status: "success", category: "agent", priority: false, text: `Task from @${msg.from} handed to an agent` });
        },
        onDecline: () => declineTask(msg.from, msg.from_wid, msg.task_id),
      }]);
    }
    if (msg.type === "task_accept") {
      pushNotification({ status: "success", category: "agent", priority: true, text: `@${msg.from} accepted your task` });
    }
    if (msg.type === "task_decline") {
      pushNotification({ status: "info", category: "agent", priority: true, text: `@${msg.from} declined your task` });
    }

    // ── Co-pilot ─────────────────────────────────────────────────────────────
    if (msg.type === "copilot_invite") {
      const myPanes: CopilotPane[] = (focusedWs?.panes ?? []).map((p) => ({
        id: p.id, label: p.kind,
      }));
      pushNotification({ status: "info", category: "agent", priority: false, text: `@${msg.from} invited you to co-pilot` });
      if (isToastSuppressed("copilot_invite")) return;
      setSessionToasts((prev) => [...prev, {
        id: msg.session_id,
        kind: "copilot_invite",
        fromLogin: msg.from,
        fromAvatar: friend?.avatarUrl,
        sessionId: msg.session_id,
        onAccept: async () => {
          const shell = newCopilotWorkspace(msg.session_id, msg.from, msg.from_wid, friend?.avatarUrl, "connected");
          const ws = mergePartnerPanes(shell, msg.panes);
          setWorkspaces((prev) => [...prev, ws]);
          setFocusedWsId(ws.id);
          setSidebarTab("workspaces"); // surface the shared workspace immediately
          await acceptCopilot(msg.from, msg.from_wid, msg.session_id, []);
          // Auto-spawn a local agent — pass ws directly to avoid closure race
          await spawnAgentInWorkspace(ws.id, undefined, ws).catch(console.error);
        },
        onDecline: () => endCopilot(msg.from, msg.from_wid, msg.session_id, myPanes.map((p) => p.id)),
      }]);
    }
    if (msg.type === "copilot_accept") {
      // Inviter receives accept — merge partner's panes and flip pending→connected.
      setWorkspaces((prev) => prev.map((w) =>
        w.copilot?.sessionId === msg.session_id ? markCopilotConnected(mergePartnerPanes(w, msg.panes)) : w
      ));
      pushNotification({ status: "success", category: "agent", priority: false, text: `@${msg.from} connected to your co-pilot session` });
      // Push our current local panes to the partner in case they spawned before we accepted
      setTimeout(() => {
        const ws = workspacesRef.current.find((w) => w.copilot?.sessionId === msg.session_id);
        if (!ws?.copilot) return;
        const localPanes = ws.panes.filter((p) => !p.streamId).map((p) => ({ id: p.id, label: p.displayName ?? p.kind }));
        import("./lib/session").then(({ syncCopilotLayout }) =>
          syncCopilotLayout(ws.copilot!.partnerLogin, ws.copilot!.partnerWid, msg.session_id, localPanes)
        );
      }, 100);
    }
    if (msg.type === "copilot_layout") {
      // Partner updated their pane list — merge while preserving our local panes.
      // A layout also proves the partner is live, so settle any lingering pending.
      setWorkspaces((prev) => prev.map((w) =>
        w.copilot?.sessionId === msg.session_id ? markCopilotConnected(mergePartnerPanes(w, msg.panes)) : w
      ));
    }
    if (msg.type === "copilot_end") {
      const wasInSession = workspaces.some((w) => w.copilot?.sessionId === msg.session_id);
      setWorkspaces((prev) => prev.filter((w) => w.copilot?.sessionId !== msg.session_id));
      setFocusedWsId((prev) => {
        const remaining = workspaces.filter((w) => w.copilot?.sessionId !== msg.session_id);
        return remaining.find((w) => w.id === prev)?.id ?? remaining[0]?.id ?? null;
      });
      if (wasInSession) {
        pushNotification({ status: "info", category: "agent", priority: false, text: `@${msg.from} disconnected from the co-pilot session` });
      }
    }
  }, [friends, workspaces, focusedWsId, newCopilotWorkspace, mergePartnerPanes, newObserveWorkspace, pushNotification]);
  handleSessionMsgRef.current = handleSessionMsg;

  const handleRequestObserve = (login: string, windowId: string) => { requestObserve(login, windowId); };

  const handleSendTask = (login: string, windowId: string, avatar?: string) => {
    setTaskDialog({ login, windowId, avatar });
  };

  const handleCopilot = async (login: string, windowId: string, avatar?: string) => {
    const sessionId = await inviteCopilot(login, windowId, []);
    const cws = newCopilotWorkspace(sessionId, login, windowId, avatar);
    setWorkspaces((prev) => [...prev, cws]);
    setFocusedWsId(cws.id);
    setSidebarTab("workspaces"); // jump off Friends to the new shared workspace
    // Auto-spawn a local agent — pass cws directly to avoid closure race
    await spawnAgentInWorkspace(cws.id, undefined, cws).catch(console.error);
  };

  // ─── Settings ──────────────────────────────────────────────────────

  // Optional `tab` deep-links a quick action to the right Settings pane. Guard
  // against event objects from `onClick={openSettings}` call sites.
  const openSettings = (tab?: string) =>
    setDialog({ kind: "settings", tab: typeof tab === "string" ? tab : undefined });

  // Focus a workspace and pop its sidebar Git section open — the click target
  // for the titlebar's uncommitted-changes bar.
  const openGit = useCallback((wsId: string) => {
    setFocusedWsId(wsId);
    setSidebarCollapsed(false);
    window.dispatchEvent(new CustomEvent("flock:open-section", { detail: "git" }));
  }, []);

  // Opened via the native "flock → Settings…" menu item (⌘,).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    onOpenSettings(() => setDialog({ kind: "settings" })).then((fn) => (unlisten = fn));
    return () => unlisten?.();
  }, []);

  // ─── Command bar contents ──────────────────────────────────────────
  //
  // The palette's founding claim (890e476) was that everything the removed
  // chrome offered is reachable here by name. It was not: tabs, splits, zoom,
  // pop-out, close, rename/delete workspace, theme and Graph Explorer were all
  // button- or shortcut-only, and Graph Explorer's single entry point was a
  // sidebar card the palette itself could hide. This list is the answer to
  // that inventory.
  //
  // Built from live state on every render rather than registered once, because
  // most of what belongs in a palette here is not a static verb: it is a list
  // of the agents and workspaces that exist right now. A registry would have to
  // be invalidated on every spawn, every status change and every close, which
  // is three subscriptions to avoid one array rebuild of a few dozen entries.
  //
  // Order matters and is the design: agents that need input, then the rest of
  // the live agents, then workspaces, then verbs. CommandBar sorts `attention`
  // above everything regardless of match score, so the first thing the palette
  // shows on ⌘K with an empty query is always whoever is waiting on you.
  const commands: Command[] = useMemo(() => {
    const out: Command[] = [];
    const focused = workspaces.find((w) => w.id === focusedWsId);
    const focusedTab = focused ? getFocusedTab(focused) : undefined;

    for (const ws of workspaces) {
      for (const pane of ws.panes) {
        const waiting = pane.status === "awaiting_input" || pane.status === "blocked";
        const name = pane.displayName ?? "Agent";
        out.push({
          id: `pane:${pane.id}`,
          group: waiting ? "Needs you" : "Agents",
          label: waiting ? `${name} is waiting on you` : name,
          hint: ws.name,
          attention: waiting,
          // `detail` rather than a keyword: the sidebar row for this same agent
          // shows its status and task, and the palette opens *over* the
          // sidebar. A row that carries less than the thing it covers is a
          // downgrade the user paid a keystroke for.
          detail: paneDetail(pane),
          keywords: `${pane.kind} ${ws.name} ${pane.intent ?? ""} agent`,
          context: `${pane.cwd} ${pane.worktree?.branch ?? ""} ${pane.model ?? ""}`,
          run: () => focusPane(ws.id, pane.id),
        });
      }
    }

    for (const ws of workspaces) {
      out.push({
        id: `ws:${ws.id}`,
        group: "Workspaces",
        label: ws.name,
        hint: ws.branch || undefined,
        detail: ws.panes.length ? `${ws.panes.length} agent${ws.panes.length === 1 ? "" : "s"}` : undefined,
        keywords: "workspace",
        // The repo path is `context`, not a keyword. As a keyword it made every
        // workspace under ~/git outrank "Show uncommitted changes" for the
        // query "git".
        context: ws.repo_path ?? "",
        run: () => setFocusedWsId(ws.id),
      });
    }

    if (focused) {
      const here = focused.name;
      out.push({
        id: "act:spawn",
        group: "Start",
        label: "New agent here",
        hint: here,
        keywords: "spawn launch new claude codex opencode grok",
        run: () => void spawnAgentInWorkspace(focused.id),
      });
      out.push({
        id: "act:race",
        group: "Start",
        label: "Race agents on one prompt",
        hint: here,
        keywords: "fan out parallel worktree compare contenders",
        run: () => setDialog({ kind: "race", workspaceId: focused.id }),
      });
      if (focusedTab?.race) {
        out.push({
          id: "act:race-compare",
          group: "Review",
          label: `Compare the ${focusedTab.race.contenders.length} race contenders`,
          hint: here,
          keywords: "race diff judge merge winner",
          run: () => setDialog({ kind: "race-compare", workspaceId: focused.id, tabId: focusedTab.id }),
        });
      }
      out.push({
        id: "act:git",
        group: "Review",
        label: "Show uncommitted changes",
        hint: here,
        keywords: "diff git status uncommitted review changes",
        run: () => openGit(focused.id),
      });

      // ── Panes. Every one of these was keyboard-only or button-only before,
      // which is the gap that made the palette's founding claim untrue.
      out.push({
        id: "act:split-right",
        group: "Panes",
        label: "Split right",
        hint: "⌘D",
        keywords: "pane divide horizontal new",
        run: () => void splitPane(focused.id, "horizontal"),
      });
      out.push({
        id: "act:split-down",
        group: "Panes",
        label: "Split down",
        hint: "⌘⇧D",
        keywords: "pane divide vertical new",
        run: () => void splitPane(focused.id, "vertical"),
      });
      if (focusedTab?.focusedPaneId) {
        const target = focusedTab.focusedPaneId;
        const zoomed = focusedTab.zoomedPaneId === target;
        out.push({
          id: "act:zoom",
          group: "Panes",
          label: zoomed ? "Unzoom this pane" : "Zoom this pane",
          hint: "⌘Z",
          keywords: "full screen maximise maximize expand",
          run: () => zoomPane(focused.id, target),
        });
        out.push({
          id: "act:popout",
          group: "Panes",
          label: "Open this agent in its own window",
          keywords: "pop out detach window monitor",
          run: () => void popOutPane(focused.id, target),
        });
        out.push({
          id: "act:close-pane",
          group: "Panes",
          label: "Close this agent",
          hint: "⌘⇧K",
          keywords: "kill stop quit end pane",
          run: () => void requestClosePane(target),
        });
      }

      // ── Tabs. Entirely absent before; ⌘T and ⌘1–9 were the only paths.
      out.push({
        id: "act:new-tab",
        group: "Tabs",
        label: "New tab",
        hint: "⌘T",
        keywords: "room grid layout",
        run: () => newTabInWorkspace(focused.id),
      });
      for (const t of focused.tabs) {
        if (t.id === focused.focusedTabId) continue;
        out.push({
          id: `tab:${t.id}`,
          group: "Tabs",
          label: t.name,
          hint: here,
          keywords: "tab room switch",
          run: () => switchTab(focused.id, t.id),
        });
      }
      if (focused.tabs.length > 1) {
        out.push({
          id: "act:close-tab",
          group: "Tabs",
          label: "Close this tab",
          hint: "⌘⇧W",
          keywords: "remove room",
          run: () => void requestCloseTab(focused.id, focused.focusedTabId),
        });
      }

      // ── Workspace management, previously right-click only — the exact class
      // of hidden affordance a palette exists to abolish.
      out.push({
        id: "act:rename-ws",
        group: "Workspaces",
        label: `Rename "${here}"`,
        keywords: "workspace title name",
        run: () => setDialog({ kind: "rename-workspace", workspaceId: focused.id, current: focused.name }),
      });
      out.push({
        id: "act:delete-ws",
        group: "Workspaces",
        label: `Delete "${here}"`,
        keywords: "workspace remove close destroy",
        run: () => requestCloseWorkspace(focused.id),
      });
    }

    out.push({
      id: "act:new-ws",
      group: "Start",
      label: "New workspace",
      hint: "⌘N",
      keywords: "create repo clone worktree open",
      run: () => beginNewWorkspace(),
    });
    out.push({
      id: "act:queue",
      group: "Start",
      label: "Capture a prompt for later",
      hint: "⌘⇧P",
      keywords: "queue idea note screenshot",
      run: () => setDialog({ kind: "queue-capture" }),
    });
    out.push({
      id: "act:prs",
      group: "Review",
      label: "Pull requests",
      keywords: "github pr checks review",
      run: () => setDialog({ kind: "pr-hub", view: "prs" }),
    });
    out.push({
      id: "act:queue-view",
      group: "Review",
      label: "Merge queue",
      keywords: "github merge",
      run: () => setDialog({ kind: "pr-hub", view: "queue" }),
    });
    out.push({
      id: "act:stats",
      group: "App",
      // Reachable only by clicking a 16px chart icon in the sidebar footer
      // before this. Every other surface in the app has a keyboard path.
      label: "Your usage and stats",
      keywords: "metrics tokens spend chart achievements profile account cost",
      run: () => setDialog({ kind: "my-info" }),
    });
    // The Graph Explorer's only other entry point is one card in the sidebar —
    // and the palette itself offers "Hide sidebar", so it could remove the last
    // path to a feature it did not expose.
    if (getGraphEnabled()) {
      out.push({
        id: "act:graph",
        group: "App",
        label: "Graph Explorer",
        keywords: "knowledge memory decisions recall nodes",
        run: () => window.dispatchEvent(new Event(OPEN_GRAPH_EXPLORER_EVENT)),
      });
    }
    out.push({
      id: "act:graph-setup",
      group: "App",
      label: getGraphEnabled() ? "Graph settings" : "Set up the knowledge graph",
      keywords: "kg memory postgres docker engine mcp",
      run: () => window.dispatchEvent(new Event(OPEN_GRAPH_SETUP_EVENT)),
    });
    for (const t of THEMES) {
      out.push({
        id: `theme:${t.id}`,
        group: "App",
        label: `Theme: ${t.label}`,
        keywords: "appearance dark light colour color contrast",
        run: () => applyTheme(t.id),
      });
    }
    out.push({
      id: "act:settings",
      group: "App",
      label: "Settings",
      hint: "⌘,",
      keywords: "preferences theme appearance security graph shortcuts",
      run: () => openSettings(),
    });
    out.push({
      id: "act:sidebar",
      group: "App",
      label: sidebarCollapsed ? "Show sidebar" : "Hide sidebar",
      keywords: "rail panel collapse",
      run: () => toggleSidebarCollapsed(),
    });

    return out;
    // `workspaces` covers panes, statuses and names; the rest are the handles
    // this list closes over. Deliberately not exhaustive on the setters, which
    // are stable for the lifetime of the component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaces, focusedWsId, sidebarCollapsed]);

  /**
   * The palette's answer to text that is not a command: the agents you can
   * hand it to, plus the two ways to create one that starts with it.
   *
   * This is the only thing in the palette that is not also a button somewhere,
   * and it is therefore the only reason to prefer ⌘K over the mouse. Delivery
   * is `sendPromptToPane` — bracketed paste into the input line, **not
   * submitted** — which is the same contract the diff-review composer ships
   * under, for the same reason: the user reads it before it costs tokens.
   *
   * A pane that is still booting is a login shell for a second or two, and
   * bytes sent into that window are run by bash. `deliverPromptWhenReady` is
   * reused with a no-op `submit` so the wait is shared with the race path and
   * only the Enter key is dropped.
   */
  const promptActions = useCallback((text: string): Command[] => {
    const out: Command[] = [];
    const focused = workspacesRef.current.find((w) => w.id === focusedWsId);
    const inject = (paneId: string) =>
      deliverPrompt(paneId, text, {
        readiness: (id) => {
          const pane = workspacesRef.current.flatMap((w) => w.panes).find((p) => p.id === id);
          if (!pane) return "gone";
          return pane.spawning || pane.booting ? "booting" : "ready";
        },
        paste: sendPromptToPane,
        submit: async () => {},
      });

    // Focused workspace first — the agents you can see. A prompt aimed at an
    // agent in another workspace is aimed at a different checkout of the tree.
    const ordered = [
      ...(focused ? [focused] : []),
      ...workspacesRef.current.filter((w) => w.id !== focusedWsId),
    ];
    for (const ws of ordered) {
      for (const pane of ws.panes) {
        const waiting = pane.status === "awaiting_input" || pane.status === "blocked";
        out.push({
          id: `send:${pane.id}`,
          group: "Send to",
          label: pane.displayName ?? "Agent",
          hint: ws.name,
          attention: waiting,
          detail: paneDetail(pane),
          keywords: `${pane.kind} ${ws.name} send prompt tell ask`,
          // Switch workspace as well as pane, the same pair `openNotificationPane`
          // uses: `focusPane` alone leaves a cross-workspace target selected in a
          // layer that is still `visibility: hidden`, so the prompt lands
          // somewhere the user cannot see it and has to press Enter blind.
          run: () => {
            setFocusedWsId(ws.id);
            focusPane(ws.id, pane.id);
            void inject(pane.id);
          },
        });
      }
    }

    if (focused) {
      out.push({
        id: "send:new",
        group: "Send to",
        label: "A new agent here",
        hint: focused.name,
        keywords: "spawn start fresh new",
        run: () => void spawnAgentInWorkspace(focused.id).then((id) => { if (id) void inject(id); }),
      });
      if (focused.repo_path) {
        out.push({
          id: "send:race",
          group: "Send to",
          label: "Several agents, racing",
          hint: focused.name,
          keywords: "race fan out parallel compare",
          run: () => setDialog({ kind: "race", workspaceId: focused.id, prompt: text }),
        });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedWsId]);

  // ─── Render ────────────────────────────────────────────────────────

  // ─── Stable handler identities for the memoized children ───────────────
  // Sidebar and PaneArea are both wrapped in React.memo, and until this block
  // existed that memo had never once prevented a re-render: all 54 handler
  // props between them were freshly-created functions on every render, so the
  // props comparison failed every time. PaneArea is rendered once per
  // workspace and every workspace stays mounted, so one setState anywhere in
  // this component re-rendered every pane header, branch chip and context
  // meter in every open workspace.
  //
  // useEventCallback rather than useCallback: see lib/useEventCallback.ts. The
  // short version is that 45 hand-written dependency arrays over a component
  // with this much state is a stale-closure bug waiting to happen, and a
  // handler acting on a workspace list from three renders ago corrupts data
  // rather than merely painting slowly.
  const sToggleSidebar = useEventCallback(toggleSidebarCollapsed);
  const sNewWorkspace = useEventCallback(beginNewWorkspace);
  const sCloseWorkspace = useEventCallback(requestCloseWorkspace);
  const sWorkspaceMenu = useEventCallback(openWorkspaceMenu);
  const sReorderWorkspaces = useEventCallback(reorderWorkspacesLocal);
  const sSelectPane = useEventCallback(focusPane);
  const sBringBackPane = useEventCallback(bringBackPane);
  const sResetIntent = useEventCallback(resetPaneIntent);
  const sOpenSettings = useEventCallback(openSettings);
  const sAdoptWorktree = useEventCallback(adoptWorktree);
  const sPruneWorktree = useEventCallback(pruneWorktree);
  const sSendPrompt = useEventCallback(sendPromptToPane);
  const sReviewAll = useEventCallback(reviewAllPrs);
  const sRequestObserve = useEventCallback(handleRequestObserve);
  const sSendTask = useEventCallback(handleSendTask);
  const sCopilot = useEventCallback(handleCopilot);
  const sQueueLaunch = useEventCallback(openQueueLaunchPicker);
  const sQueueEdit = useEventCallback(editQueueItem);
  const sQueueDelete = useEventCallback(deleteQueueItem);
  const sPaneContextMenu = useEventCallback(openPaneMenu);
  const sSpawnInWorkspace = useEventCallback(spawnAgentInWorkspace);
  // The nine handlers that were written inline at the call site, hoisted so
  // they get an identity at all. Each only closes over setDialog (a stable
  // setState) or reads the live workspace list through workspacesRef.
  const sOpenPrManager = useEventCallback((pr?: { number: number }) =>
    setDialog({ kind: "pr-hub", view: "prs", initialPr: pr?.number }));
  const sOpenMergeQueue = useEventCallback(() => setDialog({ kind: "pr-hub", view: "queue" }));
  const sOpenFriend = useEventCallback((friend: Friend) => setDialog({ kind: "friend-stats", friend }));
  const sOpenMyInfo = useEventCallback(() => setDialog({ kind: "my-info" }));
  const sOpenQueueCapture = useEventCallback(() => setDialog({ kind: "queue-capture" }));
  const sGitChanged = useEventCallback(() => { refreshBranches().catch(() => {}); });
  const sRace = useEventCallback((workspaceId: string) => setDialog({ kind: "race", workspaceId }));
  const sCompareRace = useEventCallback((workspaceId: string, tabId: string) =>
    setDialog({ kind: "race-compare", workspaceId, tabId }));
  // Takes the workspace id and re-reads the workspace from the ref, so this
  // is one identity shared by every PaneArea instead of a closure per card.
  const sSpawnAgent = useEventCallback((workspaceId: string) => {
    const ws = workspacesRef.current.find((w) => w.id === workspaceId);
    if (!ws) return;
    const emptyTab = getFocusedTab(ws).layoutTree === null;
    debugLog(`EmptyPane spawn clicked ws=${ws.id} focusedTab=${ws.focusedTabId} layoutTreeNull=${emptyTab} panes=${ws.panes.length}`);
    if (emptyTab) setDialog({ kind: "spawn-layout", workspaceId: ws.id });
    else void sSpawnInWorkspace(ws.id);
  });

  // Hard gate: no cockpit without a signed-in flock ID and a claimed handle.
  //
  // It has to sit below EVERY hook, including the useEventCallback block above,
  // and its own comment has said so since it was written. When the block was
  // added between the gate and the render, the signed-out pass ran ~30 fewer
  // hooks than the signed-in one and React threw "Rendered more hooks than
  // during the previous render" on the transition — i.e. on every cold launch
  // that has to check the session. Nothing may be added between here and the
  // return but JSX.
  if (!idChecked || !idProfile?.handle) {
    return (
      <SignInGate
        checking={!idChecked}
        needsHandle={!!idProfile && !idProfile.handle}
        onReady={refreshIdFriends}
      />
    );
  }

  return (
    <div className="app-shell" onContextMenu={(e) => e.preventDefault()}>
      {/* data-tauri-drag-region is what moves the window, and on macOS it is
          the ONLY thing that does. `-webkit-app-region: drag` in the CSS is a
          Windows path (WebView2 123+, see wry's custom_titlebar example) and is
          inert under WKWebView, so a titlebar carrying only the CSS is a
          titlebar you cannot drag the window by. It was removed here on the
          theory that the CSS was the macOS handle and the attribute merely
          duplicated it; the two do not overlap on this platform.

          Bare, not "deep": Tauri's drag.js treats a bare attribute as "only
          direct clicks on this exact element", and separately refuses to drag
          from any clickable descendant. So the strip drags and the
          notifications pill inside it still takes its own clicks — which is
          the same intent `.titlebar * { -webkit-app-region: no-drag }`
          expresses for Windows.

          Titlebar stays sparse — just the notifications pill centered — so
          most of it is bare, draggable window chrome. Ambient telemetry
          (usage bars, uncommitted changes) lives in the bottom StatusBar. */}
      <div className="titlebar" data-tauri-drag-region>
        <NotificationsBadge
          checks={wsChecks}
          notifications={notifications}
          attentionAgents={attentionAgents}
          agents={agentTally}
          onOpenPr={() => { if (wsChecks) openUrl(wsChecks.pr_url).catch(console.error); }}
          onOpenPane={openNotificationPane}
        />
      </div>
      <div className="app-main">
        <Sidebar
          collapsed={effectiveSidebarCollapsed}
          onToggleSidebar={sToggleSidebar}
          activeTab={sidebarTab}
          onTabChange={setSidebarTab}
          onRightRailPopulated={setRightRailHasContent}
          workspaces={displayWorkspaces}
          focusedWsId={focusedWsId}
          onSelectWs={setFocusedWsId}
          onNewWorkspace={sNewWorkspace}
          onCloseWorkspace={sCloseWorkspace}
          onWorkspaceContextMenu={sWorkspaceMenu}
          onReorderWorkspaces={sReorderWorkspaces}
          onSelectPane={sSelectPane}
          onBringBackPane={sBringBackPane}
          onResetIntent={sResetIntent}
          onSettings={sOpenSettings}
          repoMaps={repoMaps}
          onAdoptWorktree={sAdoptWorktree}
          onPruneWorktree={sPruneWorktree}
          onSendPrompt={sSendPrompt}
          githubConnected={ghStatus?.connected ?? false}
          ghUser={ghStatus?.user ?? null}
          pullRequests={pullRequests}
          prError={prError}
          reviewingPr={reviewingPr}
          onOpenPrManager={sOpenPrManager}
          mergeQueue={mergeQueue}
          onOpenMergeQueue={sOpenMergeQueue}
          onReviewAll={sReviewAll}
          friends={friends}
          idSignedIn={!!idProfile}
          idHandle={idProfile?.handle ?? null}
          idDisplayName={idProfile?.display_name ?? null}
          idAvatarUrl={idProfile?.avatar_url ?? null}
          presenceStatus={presenceStatus}
          onAddFriend={addIdFriend}
          onAcceptFriend={acceptIdFriend}
          onRemoveFriend={removeIdFriend}
          onRequestObserve={sRequestObserve}
          onSendTask={sSendTask}
          onCopilot={sCopilot}
          onOpenFriend={sOpenFriend}
          onOpenMyInfo={sOpenMyInfo}
          queueItems={queueItems}
          onOpenQueueCapture={sOpenQueueCapture}
          onQueueLaunch={sQueueLaunch}
          onQueueEdit={sQueueEdit}
          onQueueDelete={sQueueDelete}
        />
        {/* Seam between the sidebar and the panes. Gone while the sidebar is
            collapsed — there is no edge to drag, and a seam pinned at x=0
            would sit on top of the pane header's expand button. */}
        {!effectiveSidebarCollapsed && (
          <RailResizer
            side="left"
            cssVar="--sidebar-w"
            spec={SIDEBAR_W}
            width={sidebarWidth}
            onCommit={commitSidebarWidth}
            label="Resize sidebar"
          />
        )}
        <div className="workspace-stack">
          {workspaces.length === 0 ? (
            <Splash onNewWorkspace={sNewWorkspace} onOpenCommandBar={() => setCmdBarOpen(true)} />
          ) : (
            workspaces.map((ws) => (
              <div
                key={ws.id}
                className="workspace-layer"
                data-workspace-id={ws.id}
                style={{
                  visibility: ws.id === focusedWsId ? "visible" : "hidden",
                  pointerEvents: ws.id === focusedWsId ? "auto" : "none",
                }}
              >
                <PaneArea
                  borrowed={borrowedByWorkspace.get(ws.id)}
                  workspace={ws}
                  repoMap={repoMaps[ws.id]}
                  onGitChanged={sGitChanged}
                  isVisible={ws.id === focusedWsId}
                  poppedOutIds={poppedOutIds}
                  onStatusChange={updatePaneStatus}
                  onIntentCaptured={updatePaneIntent}
                  onAgentStart={onAgentStart}
                  onPaneContextMenu={sPaneContextMenu}
                  onSpawnAgent={sSpawnAgent}
                  onRace={sRace}
                  onCompareRace={sCompareRace}
                  onSplitPane={splitPane}
                  onResizeSplit={resizeSplit}
                  onEvenSplits={evenSplits}
                  onSwapPanes={swapPanesInTab}
                  onZoomPane={zoomPane}
                  onClosePane={requestClosePane}
                  onPopOutPane={popOutPane}
                  onFocusPane={focusPane}
                  onSubmitPrompt={sendPromptToPane}
                  onSwitchTab={switchTab}
                  onNewTab={newTabInWorkspace}
                  onCloseTab={requestCloseTab}
                  onRenameTab={renameTabInWorkspace}
                  // Effective, not raw: this now decides whether the expand
                  // button exists at all, so it has to agree with what the
                  // rail is actually doing.
                  sidebarCollapsed={effectiveSidebarCollapsed}
                  onToggleSidebar={sToggleSidebar}
                  rightRailCollapsed={rightRailCollapsed}
                  onToggleRightRail={toggleRightRailCollapsed}
                  rightRailHasContent={rightRailHasContent}
                  onError={notifyFailure}
                />
              </div>
            ))
          )}
        </div>

        {/* Right rail — Sidebar portals any right-docked sections in here.
            Stays 0-width (see .right-rail:empty) until empty; the manual
            collapse (pane-header toggle) zeroes it too, keeping content mounted. */}
        <aside
          className={`right-rail${rightRailCollapsed && rightRailHasContent ? " right-rail-collapsed" : ""}`}
          id="flock-right-rail"
        />
        {/* Only when the rail is actually on screen: with nothing docked it's
            zero-width by CSS (.right-rail:empty), and the width variable the
            seam positions off would strand it out over the panes. */}
        {rightRailHasContent && !rightRailCollapsed && (
          <RailResizer
            side="right"
            cssVar="--right-rail-w"
            spec={RIGHT_RAIL_W}
            width={rightRailWidth}
            onCommit={commitRightRailWidth}
            label="Resize right rail"
          />
        )}
      </div>

      <StatusBar workspaces={workspaces} repoMaps={repoMaps} mergeQueue={mergeQueue} onOpenGit={openGit} onOpenMergeQueue={() => setDialog({ kind: "pr-hub", view: "queue" })} onOpenCommandBar={() => setCmdBarOpen(true)} />

      {/* Above the status bar in source order so it stacks over everything in
          the shell, and outside .app-main so the scrim covers the rails too —
          a palette that dims only the work area reads as belonging to the work
          area rather than to the app. */}
      <CommandBar
        open={cmdBarOpen}
        onClose={() => setCmdBarOpen(false)}
        commands={commands}
        promptActions={promptActions}
      />

      {voiceHud && <VoiceOverlay status={voiceHud.status} level={voiceLevel} locked={voiceHud.locked} />}

      <SessionToasts
        toasts={sessionToasts}
        onDismiss={(id) => setSessionToasts((prev) => prev.filter((t) => t.id !== id))}
      />

      <UpdateBanner />

      {taskDialog && (
        <TaskDialog
          toLogin={taskDialog.login}
          toAvatar={taskDialog.avatar}
          onSend={(prompt) => sendTask(taskDialog.login, taskDialog.windowId, prompt)}
          onClose={() => setTaskDialog(null)}
        />
      )}

      {dialog.kind === "new-workspace" && (
        <NewWorkspaceDialog
          cwd={cwd}
          onConfirm={onNewWorkspaceConfirmed}
          onCancel={() => setDialog({ kind: "none" })}
        />
      )}
      {dialog.kind === "spawn-layout" && (() => {
        const ws = workspaces.find((w) => w.id === dialog.workspaceId);
        return (
          <SpawnLayoutDialog
            defaultKind={ws?.agentKind ?? "claude"}
            // The same plan spawnAgentInWorkspace will actually use, read
            // through the same planFor() — including its normalization, which
            // is why an "existing branch" workspace correctly reports that
            // agents past the first get their own branches cut off it.
            branchNote={(count) => {
              if (!ws?.repo_path) return "";
              const plan = planFor(ws, count);
              const preview = previewBranches(plan, count);
              if (plan.mode === "current") return "Runs in your checkout. No branch isolation.";
              if (plan.mode === "existing") return `Checks out ${preview}.`;
              return count <= 1
                ? `Creates ${preview}${plan.baseRef ? ` off ${plan.baseRef}` : ""}.`
                : `Creates ${count} branches (${preview})${plan.baseRef ? ` off ${plan.baseRef}` : ""}.`;
            }}
            onConfirm={(kind, layout) => {
              debugLog(`SpawnLayoutDialog confirm ws=${dialog.workspaceId} kind=${kind} layout=${layout}`);
              setDialog({ kind: "none" });
              spawnAgentsInWorkspace(dialog.workspaceId, kind, layout);
            }}
            onCancel={() => setDialog({ kind: "none" })}
          />
        );
      })()}
      {dialog.kind === "race" && (() => {
        const ws = workspaces.find((w) => w.id === dialog.workspaceId);
        if (!ws) return null;
        return (
          <RaceDialog
            defaultKind={ws.agentKind}
            // The main checkout's branch as the poll last saw it, not
            // `ws.branch` — that one is frozen at workspace-creation time, and
            // a race promising to branch off a branch the user left days ago
            // is the kind of wrong that only shows up after the fact.
            baseLabel={repoMaps[ws.id]?.worktrees.find((w) => w.is_main)?.branch || ws.branch || "HEAD"}
            initialPrompt={dialog.prompt}
            onConfirm={(kind, count, prompt) => {
              setDialog({ kind: "none" });
              startRace(dialog.workspaceId, kind, count, prompt);
            }}
            onCancel={() => setDialog({ kind: "none" })}
          />
        );
      })()}
      {dialog.kind === "race-compare" && (() => {
        const ws = workspaces.find((w) => w.id === dialog.workspaceId);
        const race = ws?.tabs.find((t) => t.id === dialog.tabId)?.race;
        if (!ws || !race) return null;
        return (
          <RaceCompareModal
            race={race}
            panes={ws.panes}
            merging={mergingRace}
            onMerge={(branch, discardOthers) => mergeRaceWinner(ws.id, dialog.tabId, branch, discardOthers)}
            onClose={() => setDialog({ kind: "none" })}
          />
        );
      })()}
      {dialog.kind === "settings" && (
        <SettingsDialog
          onClose={() => { setDialog({ kind: "none" }); refreshGh(); refreshVoice(); }}
          onTestVoiceHud={previewVoiceHud}
          initialTab={dialog.tab as never}
          workspaces={workspaces}
          onSetWorkspaceBudget={setWorkspaceBudget}
        />
      )}
      {dialog.kind === "rename-workspace" && (
        <RenameDialog
          title="Rename Workspace"
          initial={dialog.current}
          onConfirm={(name) => onRenameConfirmed(dialog.workspaceId, name)}
          onCancel={() => setDialog({ kind: "none" })}
        />
      )}
      {dialog.kind === "pr-hub" && (
        <PrManagerModal
          prs={modalPrs}
          prError={prError}
          initialPr={dialog.initialPr}
          initialView={dialog.view}
          onClose={() => setDialog({ kind: "none" })}
          onReview={(pr) => {
            setDialog({ kind: "none" });
            reviewPr(pr);
          }}
          reviewingPr={reviewingPr}
          onReviewAll={() => {
            setDialog({ kind: "none" });
            reviewAllPrs();
          }}
          summaries={prSummaries}
          ghUser={ghStatus?.user ?? null}
          mergeQueue={mergeQueue}
          onQueueAdd={addPrToMergeQueue}
          onQueueRemove={removePrFromMergeQueue}
          onQueueReorder={reorderPrInMergeQueue}
          onApprove={approvePr}
          onMergeNow={mergePrNow}
          resolveRepoPaths={repoPathsForQueue}
        />
      )}
      {dialog.kind === "confirm-close" && (
        <ConfirmDialog
          title={
            dialog.mode === "copilot"
              ? "End co-pilot session?"
              : dialog.mode === "observe"
              ? "Stop observing?"
              : "Close workspace?"
          }
          message={
            dialog.mode === "copilot"
              ? <>This ends the shared session <strong>{dialog.name}</strong> for both of you.</>
              : dialog.mode === "observe"
              ? <>This stops observing <strong>{dialog.name}</strong>.</>
              : <>This closes <strong>{dialog.name}</strong> and shuts down its running agents. This can't be undone.</>
          }
          confirmLabel={
            dialog.mode === "copilot" ? "End session" : dialog.mode === "observe" ? "Stop" : "Close workspace"
          }
          danger={dialog.mode === "close"}
          onConfirm={() => {
            const id = dialog.workspaceId;
            setDialog({ kind: "none" });
            deleteWorkspace(id);
          }}
          onCancel={() => setDialog({ kind: "none" })}
        />
      )}
      {dialog.kind === "close-pane-branch" && (
        <BranchFateDialog
          title={`Close ${dialog.agentName ?? "agent"}?`}
          branch={dialog.branch}
          unmerged={dialog.unmerged}
          subject="Its worktree will be removed."
          onKeep={() => {
            const id = dialog.paneId;
            setDialog({ kind: "none" });
            closePaneInWorkspace(id, false).catch(console.error);
          }}
          onDelete={() => {
            const id = dialog.paneId;
            setDialog({ kind: "none" });
            closePaneInWorkspace(id, true).catch(console.error);
          }}
          onCancel={() => setDialog({ kind: "none" })}
        />
      )}
      {dialog.kind === "prune-worktree" && (
        <BranchFateDialog
          title="Remove worktree?"
          branch={dialog.wt.branch}
          unmerged={dialog.unmerged}
          subject="No agent is using this worktree."
          onKeep={() => {
            const { workspaceId, wt } = dialog;
            setDialog({ kind: "none" });
            removeOrphanWorktree(workspaceId, wt, false).catch(console.error);
          }}
          onDelete={() => {
            const { workspaceId, wt } = dialog;
            setDialog({ kind: "none" });
            removeOrphanWorktree(workspaceId, wt, true).catch(console.error);
          }}
          onCancel={() => setDialog({ kind: "none" })}
        />
      )}
      {dialog.kind === "confirm-close-tab" && (
        <ConfirmDialog
          title="Close this tab?"
          message={
            <>
              Closing <strong>{dialog.tabName}</strong> shuts down{" "}
              {dialog.agentCount === 1 ? "the agent" : `all ${dialog.agentCount} agents`} laid out in it. This can't be undone.
            </>
          }
          confirmLabel="Close tab"
          danger
          onConfirm={() => {
            const { workspaceId, tabId } = dialog;
            setDialog({ kind: "none" });
            closeTabInWorkspace(workspaceId, tabId).catch(console.error);
          }}
          onCancel={() => setDialog({ kind: "none" })}
        />
      )}
      {dialog.kind === "confirm-signout" && (
        <ConfirmDialog
          title="Sign out of flock?"
          message={<>This signs you out of your flock ID{idProfile?.handle ? <> (<strong>@{idProfile.handle}</strong>)</> : null} and locks the cockpit until you sign back in. Agents keep running locally.</>}
          confirmLabel="Sign out"
          danger
          onConfirm={() => {
            setDialog({ kind: "none" });
            signOut().catch(console.error);
          }}
          onCancel={() => setDialog({ kind: "none" })}
        />
      )}
      {dialog.kind === "friend-stats" && (
        <FriendStatsModal friend={dialog.friend} onClose={() => setDialog({ kind: "none" })} />
      )}
      {dialog.kind === "my-info" && idProfile?.handle && (
        <MyInfoModal
          profileId={idProfile.id}
          handle={idProfile.handle}
          avatarUrl={idProfile.avatar_url}
          onSignOut={() => setDialog({ kind: "confirm-signout" })}
          onClose={() => setDialog({ kind: "none" })}
        />
      )}
      {dialog.kind === "queue-capture" && (
        <QueueCaptureOverlay
          onSave={(item) => setQueueItems((prev) => [...prev, item])}
          onClose={() => setDialog({ kind: "none" })}
        />
      )}
      {contextMenu && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} items={contextMenu.items} onClose={() => setContextMenu(null)} />
      )}
      {showOnboarding && (
        <OnboardingDialog onDone={() => { markOnboardingSeen(); setShowOnboarding(false); }} />
      )}
      {/* Rendered after OnboardingDialog so "Set up now" from the tutorial's
          graph step opens the wizard on top of it. */}
      {showGraphSetup && (
        <GraphOnboardingDialog onClose={() => setShowGraphSetup(false)} />
      )}
      {showGraphExplorer && (
        <GraphExplorer
          workspaceId={focusedWsId}
          workspaceName={focusedWs?.name ?? null}
          onClose={() => setShowGraphExplorer(false)}
        />
      )}
    </div>
  );
}

/** How many panes may be brought up at once, on any path that spawns a batch
 * of them (a fresh grid, a restored workspace).
 *
 * Deliberately not an unbounded Promise.all: firing every spawn at once (24
 * agents → 24 simultaneous PTY + agent-process spawns and 24 xterm mounts)
 * saturates the webview main thread and froze the app. A small pool keeps most
 * of the parallel speedup while capping the resource spike; terminals then
 * mount in waves as each batch comes live. */
const SPAWN_CONCURRENCY = 4;

/** Run `items` through `worker` at most `limit` at a time, resolving to the
 * results in input order. Workers pull from a shared cursor rather than being
 * handed fixed slices, so one slow item doesn't idle the rest of its batch. */
async function runPooled<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await worker(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

/** Bring up a batch of panes through the pool, with the one ordering constraint
 * secure mode imposes: the first pane goes alone, because a cold machine builds
 * the sandbox image on its first container and concurrent `docker build` of the
 * same tag would stampede. Once it returns, the image exists and the rest can
 * overlap freely. */
async function spawnBatch<T, R>(
  items: T[],
  secure: boolean | undefined,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (secure && items.length > 1) {
    const first = await worker(items[0], 0);
    const rest = await runPooled(items.slice(1), SPAWN_CONCURRENCY, (item, i) => worker(item, i + 1));
    return [first, ...rest];
  }
  return runPooled(items, SPAWN_CONCURRENCY, worker);
}

/** Shared display order for workspace lists: PR-review workspaces always
 * first (in their stored relative order), everything else untouched. Returns
 * the input array untouched when nothing is pinned, so stable-order renders
 * don't churn. Never mutates — persistence order lives in the state array. */
function orderForDisplay(list: Workspace[]): Workspace[] {
  const pinned = list.filter((w) => w.prReview);
  if (pinned.length === 0) return list;
  return [...pinned, ...list.filter((w) => !w.prReview)];
}

/** What a command-bar row says an agent is doing right now: its state, then
 * the task it sniffed from your keystrokes. The palette opens *over* the
 * sidebar, whose row for the same agent carries exactly this, so a palette row
 * without it is strictly less than the thing it covers. Capped short — the
 * label and the workspace still own the row. */
function paneDetail(pane: Pane): string | undefined {
  const state =
    pane.status === "awaiting_input" || pane.status === "blocked" ? "waiting"
    : pane.status === "working" ? "working"
    : pane.spawning || pane.booting ? "starting"
    : pane.status === "failed" ? "failed"
    : pane.status === "done" ? "done"
    : "idle";
  const task = pane.intent?.replace(/\s+/g, " ").trim();
  if (!task) return state;
  return `${state} · ${task.length > 48 ? `${task.slice(0, 48)}…` : task}`;
}

/** One-line, length-capped preview of a queued prompt for menus and toasts. */
function queuePreview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat || "(empty)";
}

/** Short, effectively-unique suffix so parallel worktree branches never collide. */
function shortId(): string {
  return Math.random().toString(36).slice(2, 8);
}

/** The branch plan for a workspace that predates the branch picker: isolate
 * per agent (if that was on) with the old generated names, off current HEAD.
 * The `clarence/` stem stays spelled the old way on purpose — these branches
 * already exist in users' repos under that name, and renaming the prefix here
 * would fork a second branch beside the work they're already on. */
function legacyPlan(useWorktrees: boolean, wsSlug: string): BranchPlan {
  return useWorktrees
    ? { mode: "new", stem: `clarence/${wsSlug}`, baseRef: "", fetch: false }
    : { mode: "current", stem: "", baseRef: "", fetch: false };
}

/**
 * Resolve the cwd a new pane should spawn in. Under a `new`/`existing` plan
 * this creates the agent's git worktree and returns that path; under `current`
 * (or on failure — logged, not fatal) it falls back to sharing `repoPath`, so
 * one bad worktree creation can't break the whole spawn.
 *
 * `solo` marks the only agent a plan is being applied to, which is what earns
 * the bare stem as its branch name (see lib/branchPlan).
 */
async function resolveNewPaneCwd(
  repoPath: string,
  plan: BranchPlan,
  agentName: string,
  solo: boolean,
): Promise<{ cwd: string; worktree?: { path: string; branch: string }; fresh?: boolean }> {
  if (plan.mode === "current" || !repoPath) return { cwd: repoPath };
  const existing = plan.mode === "existing";
  const wanted = branchForAgent(plan, agentName, solo);
  if (!wanted) return { cwd: repoPath };
  const carry = getCarryPatterns();

  // Retry once with a unique suffix: the stem is user-chosen now, so "branch
  // already exists" is an ordinary outcome (same name as a past workspace, or
  // two agents whose random names slugged to the same thing). Only a new
  // branch can be retried — an existing one is the whole point of that mode.
  const candidates = existing ? [wanted] : [wanted, `${wanted}-${shortId()}`];
  for (const branch of candidates) {
    try {
      const path = await createWorktree(repoPath, branch, {
        baseDir: getWorktreesBaseDir() || null,
        baseRef: existing ? null : plan.baseRef || null,
        existing,
        carry,
      });
      // `fresh` is what earns this pane a setup run: the worktree has only
      // tracked files in it and nothing installed.
      return { cwd: path, worktree: { path, branch }, fresh: true };
    } catch (e) {
      console.error(`createWorktree failed for branch ${branch}`, e);
    }
  }
  console.error(`falling back to the shared directory for agent ${agentName}`);
  return { cwd: repoPath };
}

// Estimate PTY dimensions so the agent starts rendering at approximately
// the right size. Uses window dimensions minus known chrome offsets and
// SF Mono 13px approximate cell metrics (7.8×15.6 px per character).
function estimatePtyDims(gridRows: number, gridCols: number): { ptyCols: number; ptyRows: number } {
  const sidebarW = 240;
  const titlebarH = 32;
  const statusBarH = 26;       // bottom status bar (usage + changes)
  const paneHeaderH = 40 + 30; // workspace header + tab bar
  const paneTopbarH = 22;      // per-pane name/controls strip (inside each pane)
  const cellW = 7.8;
  const cellH = 15.6;
  const paneW = (window.innerWidth - sidebarW) / gridCols;
  const paneH = (window.innerHeight - titlebarH - statusBarH - paneHeaderH) / gridRows - paneTopbarH;
  return {
    ptyCols: Math.max(20, Math.floor(paneW / cellW)),
    ptyRows: Math.max(5, Math.floor(paneH / cellH)),
  };
}

function layoutGrid(layout: WindowLayout): { rows: number; cols: number } {
  switch (layout) {
    case "single": return { rows: 1, cols: 1 };
    case "split":  return { rows: 1, cols: 2 };
    case "quad":   return { rows: 2, cols: 2 };
    case "six":    return { rows: 2, cols: 3 };
    case "eight":  return { rows: 2, cols: 4 };
    case "twelve": return { rows: 3, cols: 4 };
  }
}

// Smallest preset grid shape that holds `n` panes — used for counts that don't
// come from a layout preset (a race's contender count). Mirrors the layoutGrid
// presets.
function gridDimsFor(n: number): { rows: number; cols: number } {
  if (n <= 1) return { rows: 1, cols: 1 };
  if (n <= 2) return { rows: 1, cols: 2 };
  if (n <= 4) return { rows: 2, cols: 2 };
  if (n <= 6) return { rows: 2, cols: 3 };
  if (n <= 8) return { rows: 2, cols: 4 };
  return { rows: 3, cols: 4 };
}
