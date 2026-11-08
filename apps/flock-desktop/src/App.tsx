import { useEffect, useCallback, useMemo, useRef, useState } from "react";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import CommandBar, { type Command } from "./components/CommandBar";
import GitPanel from "./components/GitPanel";
import ErrorBoundary from "./components/ErrorBoundary";
import { OPEN_GRAPH_SETUP_EVENT, OPEN_GRAPH_EXPLORER_EVENT, getGraphEnabled, getGraphUrl, onGraphEnabledChange, type GraphExplorerOpenDetail, type GraphExplorerView } from "./lib/graphSettings";
import { usePtyFileDrop } from "./lib/usePtyFileDrop";
import { onPaletteSummon } from "./lib/paletteBridge";
import { emptyPopoutBook, markPoppedOut as markPoppedOutBook, releasePoppedOut, releasePoppedOutMany, type PopoutOrigin } from "./lib/poppedOut";
import type { NotificationInput } from "./lib/useNotifications";
import { useBudgetAlerts } from "./lib/useBudgetAlerts";
import type { Budget } from "./lib/budgets";
import { isWindowActive, onWindowActiveChange } from "./lib/windowActive";
import { useFlockIdentity } from "./lib/useFlockId";
import { useGithubPrs } from "./lib/useGithubPrs";
import { overallCheckStatus } from "./lib/checks";
import ContextMenu, { MenuItem } from "./components/ContextMenu";
import SignInGate from "./components/SignInGate";
import UpdateBanner from "./components/UpdateBanner";
import { getEffectiveTheme, THEMES, applyTheme, onThemeChange } from "./lib/theme";
import {
  createWorkspace,
  currentBranch,
  summarizeIntent,
  graphBrief,
  graphGroundHook,
  graphMcpConfig,
  getCwd,
  listWorkspaces,
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
  onAnyAgentStatus,
  onAnyAgentStarted,
  hasAgentStarted,
  latestAgentStatus,
  queueAdd,
  queueList,
  queueLaunch,
  containerStatus,
  type QueueItem,
} from "./lib/tauri";
import { copyText } from "./lib/clipboard";
import { openExternalTerminal } from "./lib/externalTerminal";
import { detachStagedImages } from "./lib/imageAttach";
import { flashPanePill } from "./lib/panePill";
import { useVoicePushToTalk } from "./lib/useVoicePushToTalk";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { signOut, supabase } from "./lib/flockId";
import { recordUsage } from "./lib/usageStats";
import { acceptCopilot, acceptObserve, acceptTask, declineObserve, declineTask, endCopilot, endObserve, initSessions, inviteCopilot, requestObserve, sendTask, shareCopilotPane, syncCopilotLayout, type CopilotPane, type SessionMsg } from "./lib/session";
import { stopStream } from "./lib/streamPublisher";
import { isToastSuppressed } from "./lib/toastSuppression";
import SessionToasts, { type ToastItem } from "./components/SessionToast";
import TaskDialog from "./components/TaskDialog";
import { connectPresence, disconnectPresence, resyncFriendPresence, updateAgentCount, updateFriends, type PresenceStatus } from "./lib/presence";
import { onActiveTeamChange, syncActiveTeamMirror } from "./lib/teamSettings";
import { workspaceColor } from "./lib/palette";
import { getCarryPatterns, getDeleteBranchWithWorktree, getComposerBranchMode, getFetchBaseDefault, getWorktreesBaseDir, setLastBaseRef } from "./lib/worktreeSettings";
import { getSecureByDefault } from "./lib/secureSettings";
import { branchForAgent, normalizePlan, previewBranches, slugify } from "./lib/branchPlan";
import { cleanupPlan, raceStem, raceTabName } from "./lib/race";
import { fetchBase } from "./lib/baseFetch";
import { randomAgentName } from "./lib/agentNames";
import { split, remove, firstPaneId, buildGridLayout, remapLayoutTree, pruneLayoutTree, allPaneIds, setRatioAtPath, balanceLayoutTree, swapPanes, type SplitPath } from "./lib/layout";
import { setRestoreHistory } from "./lib/restoreHistory";
import { stepPaneFontSize, stepUiScale } from "./lib/uiScale";
import { getTerminalSelection, getSelectionUrl, getInputLine, clearInputLineBytes, noteInjectedInput, getTerminalBuffer } from "./lib/terminalRegistry";
import { makeTab, getFocusedTab, findTabForPane } from "./lib/tabs";
import { AGENT_KINDS, agentLabel } from "./lib/agents";
import { graphSpawnArgs as graphSpawnArgsFor } from "./lib/graphSpawn";
import { deliverPromptWhenReady as deliverPrompt } from "./lib/promptDelivery";
import { broadcastKey, isBroadcasting, toggleBroadcast, useBroadcast, clearBroadcast } from "./lib/broadcastInput";
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
import type { AgentKind, AgentStatusStr, BranchPlan, Friend, LayoutNode, Pane, PanePhase, PullRequest, RaceContender, RaceState, SplitDir, WindowLayout, Workspace, WorkspaceLaunch, WorkspaceTab } from "./types";
import { lazyModal, preloadWhenIdle } from "./lib/lazyModal";
import { useEventCallback } from "./lib/useEventCallback";
import Sidebar from "./v2/Sidebar";
import ThreadView from "./v2/ThreadView";
import ThreadHeader from "./v2/ThreadHeader";
import Composer, { type StartRequest } from "./v2/Composer";
import { Toasts, useToasts } from "./v2/Toasts";
import { PanelLeftIcon, XIcon } from "./v2/icons";
import type { MenuEntry } from "./v2/Menu";
import { buildProjects, parseDormant, waitingThreads, type Dormant, type Thread } from "./v2/threads";
import { getAiTitles, looksLikeTask, titleFromPrompt } from "./v2/titles";
import { launchArgs, promptArgs, type LaunchOptions } from "./v2/launch";

// Dialogs are code-split: see lib/lazyModal.tsx for why each one carries its
// own Suspense boundary rather than sharing one near the root.
const BranchFateDialog = lazyModal(() => import("./components/BranchFateDialog"));
const ConfirmDialog = lazyModal(() => import("./components/ConfirmDialog"));
const GraphExplorer = lazyModal(() => import("./components/GraphExplorer"));
const GraphOnboardingDialog = lazyModal(() => import("./components/GraphOnboardingDialog"));
const NewWorkspaceDialog = lazyModal(() => import("./components/NewWorkspaceDialog"));
const PrManagerModal = lazyModal(() => import("./components/PrManagerModal"));
const QueueCaptureOverlay = lazyModal(() => import("./components/QueueCaptureOverlay"));
const RaceCompareModal = lazyModal(() => import("./components/RaceCompareModal"));
const RaceDialog = lazyModal(() => import("./components/RaceDialog"));
const RenameDialog = lazyModal(() => import("./components/RenameDialog"));
const SettingsDialog = lazyModal(() => import("./components/SettingsDialog"));
const MyInfoModal = lazyModal(() => import("./components/MyInfoModal"));
const FriendStatsModal = lazyModal(() => import("./components/FriendStatsModal"));
const SpawnLayoutDialog = lazyModal(() => import("./components/SpawnLayoutDialog"));
const VoiceOverlay = lazyModal(() => import("./components/VoiceOverlay"));

/** Dialogs that are pages of the main panel: the shell around them stays live
 *  (shortcuts, the sidebar), and opening one closes whichever page was up. */
function isPageDialog(kind: string): boolean {
  return kind === "settings" || kind === "pr-hub" || kind === "my-info" || kind === "friend-stats";
}

type DialogState =
  | { kind: "none" }
  | { kind: "new-workspace" }
  | { kind: "settings"; tab?: string }
  | { kind: "rename-workspace"; workspaceId: string; current: string }
  | { kind: "confirm-close"; workspaceId: string; name: string; mode?: "close" | "copilot" | "observe" }
  | { kind: "confirm-signout" }
  // Pages of the main panel: your stats and achievements, a friend's.
  | { kind: "my-info" }
  | { kind: "friend-stats"; friendId: string }
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
  // ⌘K. Not a member of DialogState: the palette may open over anything.
  const [cmdBarOpen, setCmdBarOpen] = useState(false);
  // A race merge is in flight (outlives the compare modal's own state).
  const [mergingRace, setMergingRace] = useState(false);
  const [contextMenu, setContextMenu] = useState<CtxMenuState | null>(null);
  // Personal prompt queue (⌘⇧P), sent from ⌘K. Persisted in SQLite.
  const [queueItems, setQueueItems] = useState<QueueItem[]>([]);
  const queueItemsRef = useRef<QueueItem[]>([]);
  queueItemsRef.current = queueItems;
  // Live git snapshot for the project on screen (worktrees + branches).
  const [repoMaps, setRepoMaps] = useState<Record<string, RepoMap>>({});
  const [cwd, setCwd] = useState<string>("");

  // ─── v2 shell state ────────────────────────────────────────────────
  // The main panel shows one thing: the thread on screen, the new-agent
  // composer, or (dialog.kind === "settings") Settings.
  const [composing, setComposing] = useState<{ projectId: string | null } | null>(null);
  // Threads of projects not restored yet this launch, read from their saved
  // state so the sidebar can list them before their agents are started.
  const [dormant, setDormant] = useState<Record<string, Dormant>>({});
  // A dormant thread that was clicked: restore lands on this tab.
  const pendingTabRef = useRef(new Map<string, string>());
  // The changes panel beside the thread (git status, worktrees, commits).
  const [changesOpen, setChangesOpen] = useState<boolean>(() => localStorage.getItem("flock:v2-changes") === "1");
  const toggleChanges = () =>
    setChangesOpen((prev) => {
      try { localStorage.setItem("flock:v2-changes", prev ? "0" : "1"); } catch { /* a preference */ }
      return !prev;
    });

  // Whether the sidebar is hidden, so agents can take the whole window.
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(
    () => localStorage.getItem("flock:sidebar-collapsed") === "1",
  );
  const toggleSidebarCollapsed = () => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem("flock:sidebar-collapsed", next ? "1" : "0");
      return next;
    });
  };
  // With nothing open there is nothing to make room for.
  const effectiveSidebarCollapsed = sidebarCollapsed && workspaces.length > 0;

  // Reflex dialogs are warmed in the first idle window rather than fetched in
  // the keystroke that opens them.
  useEffect(() => {
    preloadWhenIdle([RenameDialog, ConfirmDialog, VoiceOverlay]);
  }, []);

  // Events worth interrupting for become toasts; everything else (an agent
  // started, finished, was prompted) is already on screen as its row's dot.
  const { toasts, push: pushToast, dismiss: dismissToast } = useToasts();
  const focusPaneRefForToasts = useRef<(wsId: string, paneId: string) => void>(() => {});
  const pushNotification = useCallback((n: NotificationInput) => {
    if (!n.priority && n.status !== "failure" && n.status !== "success") return;
    if (n.status === "success" && !n.priority && n.category === "agent") return;
    const action = n.workspaceId && n.paneId
      ? { label: "Open", run: () => focusPaneRefForToasts.current(n.workspaceId!, n.paneId!) }
      : n.url
        ? { label: "Open", run: () => { openUrl(n.url!).catch(console.error); } }
        : undefined;
    pushToast({
      kind: n.status === "failure" ? "failure" : n.status === "success" ? "success" : "info",
      text: n.text,
      detail: n.detail,
      action,
      key: n.paneId ? `pane:${n.paneId}` : undefined,
    });
  }, [pushToast]);
  /** One-liner for "this user action failed". */
  const notifyFailure = useCallback((text: string) => {
    pushNotification({ status: "failure", category: "agent", priority: true, text });
  }, [pushNotification]);

  /** Open a directory in the user's terminal emulator. */
  const openTerminalHere = useCallback(async (dir: string) => {
    try {
      const app = await openExternalTerminal(dir);
      if (!app) notifyFailure("No terminal app found on this Mac.");
    } catch (e) {
      notifyFailure(`Couldn't open a terminal: ${e instanceof Error ? e.message : e}`);
    }
  }, [notifyFailure]);

  // flock ID: the signed-in profile (the app gates on it).
  const { idProfile, idChecked, refreshIdentity, friends, setFriends, addFriend, acceptFriend, removeFriend } = useFlockIdentity(pushNotification);

  // Number of the PR being checked out + reviewed, if any.
  const [reviewingPr, setReviewingPr] = useState<number | null>(null);
  const reviewingPrRef = useRef<number | null>(null);
  reviewingPrRef.current = reviewingPr;
  // ─── PR watch / auto-review / merge queue ──────────────────────────
  const [watchedPrs, setWatchedPrs] = useState<PullRequest[]>([]);
  const [prSummaries, setPrSummaries] = useState<Record<string, PrReviewSummary>>({});
  const [mergeQueue, setMergeQueue] = useState<MergeQueueItem[]>([]);
  const mergeQueueRef = useRef<MergeQueueItem[]>([]);
  const prWatchConfigRef = useRef<PrWatchConfig | null>(null);
  const autoReviewQueueRef = useRef<PullRequest[]>([]);
  const autoReviewDrainingRef = useRef(false);
  const reviewPanesRef = useRef<Map<string, { repo: string; number: number }>>(new Map());
  const reviewPaneStatusRef = useRef<Map<string, AgentStatusStr>>(new Map());
  const summarizedPanesRef = useRef<Set<string>>(new Set());
  const repoSlugCacheRef = useRef<Map<string, string | null>>(new Map());

  const [showGraphSetup, setShowGraphSetup] = useState(false);
  // Whether the shared graph is set up, for the sidebar's Graph row.
  const [graphOn, setGraphOn] = useState(getGraphEnabled);
  useEffect(() => onGraphEnabledChange(setGraphOn), []);
  // The graph page (sidebar, ⌘K, Settings), on the view it was asked for.
  const [showGraphExplorer, setShowGraphExplorer] = useState(false);
  const [graphExplorerWorkspaceId, setGraphExplorerWorkspaceId] = useState<string | null>(null);
  const [graphExplorerView, setGraphExplorerView] = useState<GraphExplorerView | undefined>(undefined);
  // Pages replace each other: Settings, Pull requests, Graph and its setup
  // share the main panel, so opening one closes whichever was up.
  const closePages = useCallback(() => {
    setDialog((d) => (isPageDialog(d.kind) ? { kind: "none" } : d));
    setShowGraphExplorer(false);
    setShowGraphSetup(false);
  }, []);
  useEffect(() => {
    const openSetup = () => {
      closePages();
      setShowGraphSetup(true);
    };
    const openExplorer = (event: Event) => {
      const detail = (event as CustomEvent<GraphExplorerOpenDetail | null>).detail;
      closePages();
      setGraphExplorerWorkspaceId(detail && typeof detail === "object" && "workspaceId" in detail ? detail.workspaceId ?? null : focusedWsIdRef.current);
      setGraphExplorerView(detail && typeof detail === "object" ? detail.view : undefined);
      setShowGraphExplorer(true);
    };
    window.addEventListener(OPEN_GRAPH_SETUP_EVENT, openSetup);
    window.addEventListener(OPEN_GRAPH_EXPLORER_EVENT, openExplorer);
    return () => {
      window.removeEventListener(OPEN_GRAPH_SETUP_EVENT, openSetup);
      window.removeEventListener(OPEN_GRAPH_EXPLORER_EVENT, openExplorer);
    };
  }, [closePages]);
  // Which workspace IDs have had their panes restored this launch.
  const restoredWsIds = useRef(new Set<string>());
  // Hydrated once restore has written its live panes, or created this session.
  // saveWorkspace no-ops on anything else: an unrestored shell is empty, and
  // writing it would wipe the saved state.
  const hydratedWsIds = useRef(new Set<string>());
  // Restore finished with zero live panes; the blob stays the truth until a
  // later spawn succeeds.
  const emptyRestoreIds = useRef(new Set<string>());
  // Budget set this session, possibly before restore finished.
  const budgetTouchedIds = useRef(new Set<string>());
  const workspacesRef = useRef<Workspace[]>([]);
  // Cached graph MCP sidecar path, so spawns can register it without a round trip.
  const mcpConfigRef = useRef<{ mcp_path: string | null; kg_url: string } | null>(null);
  const focusedWsIdRef = useRef<string | null>(null);
  focusedWsIdRef.current = focusedWsId;

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
        setDormant((prev) => {
          if (!(workspaceId in prev)) return prev;
          const next = { ...prev };
          delete next[workspaceId];
          return next;
        });
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
    type SavedTab = { id: string; name: string; renamed?: boolean; layoutTree: LayoutNode | null; focusedPaneId: string | null; zoomedPaneId: string | null; race?: RaceState };
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
      setDormant((prev) => {
        if (!(workspaceId in prev)) return prev;
        const next = { ...prev };
        delete next[workspaceId];
        return next;
      });
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
        if (sp.cmd === "claude") args = [...args, ...launchArgs("claude", sp.launch), ...(await graphArgs)];

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
            launch: sp.launch,
            // A restored pane boots exactly like a fresh one, so it gets the
            // same card — unless the backend already saw its agent paint (the
            // event can beat the whole batch into state).
            booting: !hasAgentStarted(pane.id),
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
          const remapped = st.layoutTree && idMap.size > 0 ? remapLayoutTree(st.layoutTree, idMap) : null;
          // Prune ghost leaves — saved layouts written while a stale-tree
          // race was live can reference panes with no record behind them, and
          // a layout that borrowed another workspace's pane (v1) names a pane
          // this workspace never had. remapLayoutTree keeps unknown ids
          // verbatim, so without this they would render as blank tiles.
          const layoutTree = remapped ? pruneLayoutTree(remapped, liveIds) : null;
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

    // A thread clicked in the sidebar before its project woke up wins over the
    // tab that was in front when the state was saved.
    const wanted = pendingTabRef.current.get(workspaceId);
    pendingTabRef.current.delete(workspaceId);
    const focusedTabId: string = wanted && tabs.some((t) => t.id === wanted)
      ? wanted
      : parsed.focusedTabId && tabs.some((t) => t.id === parsed.focusedTabId)
        ? parsed.focusedTabId
        : tabs[0].id;

    setWorkspaces((prev) => prev.map((ws) => {
      if (ws.id !== workspaceId) return ws;
      const nextBudget = budgetTouchedIds.current.has(workspaceId) ? ws.budget : budget;
      // Booting and status are settled here, as the panes enter state, not when
      // each was spawned: the backend's events for the first panes routinely
      // arrive while the rest of the batch is still spawning, before any of
      // them is in state to receive it.
      const panes = livePanes.map((p) => ({
        ...p,
        booting: p.booting && !hasAgentStarted(p.id),
        status: latestAgentStatus(p.id) ?? p.status,
      }));
      return { ...ws, agentKind, useWorktrees, branchPlan, secure, budget: nextBudget, ...flags, panes, tabs, focusedTabId };
    }));
    // Awake now: the sidebar lists its live threads instead of the saved ones.
    setDormant((prev) => {
      if (!(workspaceId in prev)) return prev;
      const next = { ...prev };
      delete next[workspaceId];
      return next;
    });
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
  const focusedRepoPath = focusedWs ? focusedWs.repo_path : null;

  // The sidebar's order: PR-review workspaces pinned on top, everything else
  // in stored order. The state array itself is never re-sorted, so
  // persistence order stays stable.
  const displayWorkspaces = useMemo(() => orderForDisplay(workspaces), [workspaces]);

  // GitHub connection + open PRs + CI checks for the focused repo (all
  // polling and the integration toggle live in the hook).
  const { ghStatus, pullRequests, prError, wsChecks, refreshGh } = useGithubPrs(focusedRepoPath);

  // ─── Notification watchers ───────────────────────────────────────────
  // These decide when a domain event (PR checks, new PRs, an agent asking for
  // you) is worth a toast.

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
    for (const pr of newPrs.slice(0, 3)) {
      pushToast({
        kind: "info",
        text: `PR #${pr.number} opened`,
        detail: pr.title,
        action: { label: "Review with an agent", run: () => void reviewPrRef.current(pr) },
        key: `pr:${pr.repo}#${pr.number}`,
      });
    }
  }, [pullRequests, focusedRepoPath, pushToast]);

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
      // An agent in the thread on screen is already in front of you.
      const onScreen = ws.id === focusedWsIdRef.current && !!findTabForPane(ws, pane.id)
        && findTabForPane(ws, pane.id)?.id === ws.focusedTabId && document.hasFocus();
      if (onScreen) return;
      switch (e.event) {
        case "Notification":
          // Two very different events share this hook. "Claude is waiting for
          // your input" is a nudge fired a minute after an agent goes quiet —
          // not news, and the Stop above already logged that it finished, so
          // it gets no row and no dot. Anything else is a real ask.
          if (e.message?.includes("waiting for your input")) break;
          pushNotification({ status: "info", category: "agent", priority: true, text: `${name} needs you`, detail: intentDetail ?? place, ...paneRef });
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
      // Read every saved state once (a cheap read — restoring stays lazy) so
      // the sidebar can list each project's threads before its agents run,
      // and PR-review workspaces are pinned from launch.
      const peeks = await Promise.all(list.map(async (w) => {
        const raw = await restoreWorkspace(w.id).catch(() => null);
        let prReview = false;
        try { prReview = raw ? !!JSON.parse(raw).prReview : false; } catch { /* restore reports it */ }
        return { id: w.id, prReview, dormant: parseDormant(raw) };
      }));
      const asleep: Record<string, Dormant> = {};
      for (const p of peeks) {
        // The project restore has already started on (the one focused at
        // launch) lists its live threads, not its saved ones.
        if (p.dormant && !restoredWsIds.current.has(p.id)) asleep[p.id] = p.dormant;
      }
      setDormant(asleep);
      const flagged = new Set(peeks.filter((f) => f.prReview).map((f) => f.id));
      if (flagged.size > 0) {
        setWorkspaces((prev) => prev.map((w) =>
          flagged.has(w.id) ? { ...w, prReview: true, accentColor: "var(--violet)" } : w,
        ));
      }
      // Open where you left off: the first project, on its saved front tab.
      if (list.length > 0) setFocusedWsId(list[0].id);
      else setComposing({ projectId: null });
      queueList().then(setQueueItems).catch(console.error);
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
      pushNotification({ status: "success", category: "agent", priority: true, text: `Sent to ${row.target_label ?? "the agent"}` });
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
      pushNotification({ status: "success", category: "agent", priority: true, text: "Saved for later (⌘K to send it)", detail });
    } catch (e) {
      pushNotification({ status: "failure", category: "agent", priority: true, text: `Couldn't queue prompt: ${e instanceof Error ? e.message : e}` });
    }
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
    // 30s: only panes whose ring moved are written, but with twenty busy agents
    // that is still a few megabytes a tick, and this is a restore cache.
    const id = setInterval(() => { persistPaneBuffers().catch(() => {}); }, 30000);
    return () => clearInterval(id);
  }, []);

  // Keep the git UI in sync with what's actually checked out. One repo-map
  // call per workspace fetches every worktree's live branch (plus dirty and
  // ahead/behind) and every local branch — from that we refresh the
  // workspace's displayed branch AND each pane's worktree branch, so an
  // agent running `git checkout` inside its own worktree self-heals here
  // instead of leaving a stale label. Polled; also called directly after
  // checkouts from the branch picker.
  // Only the project on screen is polled: each map is several git processes
  // (status per worktree included), and v1 ran them for every open project
  // every ten seconds. Others refresh the moment they are opened.
  const refreshBranches = useCallback(async () => {
    const reals = workspacesRef.current.filter((w) => w.id === focusedWsIdRef.current && w.repo_path);
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
    // Paused while the app is hidden; refreshed the moment it is visible again.
    const id = setInterval(() => { if (isWindowActive()) refreshBranches(); }, 15000);
    const unsub = onWindowActiveChange((active) => { if (active) refreshBranches(); });
    return () => { clearInterval(id); unsub(); };
  }, [refreshBranches, focusedWsId]);

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
    // At launch, only ever install. The hooks live in the user's global agent
    // config (~/.claude/settings.json and friends), shared by every flock on
    // the machine, and a fresh instance — a dev build, a second copy — has the
    // graph off simply because it has never been switched on; syncing "off"
    // from there stripped the grounding hooks the installed app's agents were
    // using. Removal happens when someone turns the graph off (the listener).
    refreshMcp();
    if (getGraphEnabled()) graphGroundHook(true, getGraphUrl() || undefined).catch(() => {});
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
    /** Mixed workspace lineups override the batch's default agent per pane. */
    agentKind?: AgentKind;
    /** Repo whose setup command should run in this pane, set only when its
     * worktree was created just now (see resolveNewPaneCwd's `fresh`). */
    setupRepo?: string;
    /** First task, on the command line where the agent takes one. */
    prompt?: string;
    /** Model and effort to start with. */
    launch?: LaunchOptions };

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
    // Share graph preparation per agent kind: each CLI needs its own flags,
    // but several sessions of the same kind should not repeat the request.
    const extraArgs = new Map([...new Set(descriptors.map((d) => d.agentKind ?? kind))]
      .map((agent) => [agent, graphSpawnArgs(agent, workspaceId, secure)]));
    const spawnOne = async (d: PaneDescriptor): Promise<boolean> => {
      const agent = d.agentKind ?? kind;
      const command = d.agentKind ? agentCommand(agent) : { cmd, args: baseArgs };
      try {
        if (prepare) await prepare(d);
        await spawnPane({
          paneId: d.paneId,
          workspaceId,
          cmd: command.cmd,
          args: [
            ...withClaudeSession(command.args, d.sessionId, "new"),
            ...launchArgs(agent, d.launch),
            ...(await extraArgs.get(agent)!),
            // Last: `--` ends the options.
            ...(promptArgs(agent, d.prompt) ?? []),
          ],
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
              : { ...w, panes: w.panes.map((p) => (p.id === d.paneId ? { ...p, spawning: false, booting: !hasAgentStarted(d.paneId) } : p)) }),
        );
        recordUsage({ agents: 1, prompts: d.prompt?.trim() ? 1 : 0 });
        return true;
      } catch (e) {
        pushNotification({ status: "failure", category: "agent", priority: true, text: `Couldn't spawn ${command.cmd}: ${e instanceof Error ? e.message : e}` });
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

  const onNewWorkspaceConfirmed = async ({ name, agents, dir, plan: rawPlan, secure }: WorkspaceLaunch, prompt?: string, launch?: LaunchOptions) => {
    if (agents.length === 0) return;
    setDialog({ kind: "none" });
    const finalName = name.trim() || dir.split("/").pop() || "workspace";
    // Store the repo's actual current branch, not a hardcoded "main".
    const liveBranch = await currentBranch(dir).catch(() => "");

    let ws: Awaited<ReturnType<typeof createWorkspace>>;
    try {
      ws = await createWorkspace(finalName, dir, liveBranch || undefined);
      recordUsage({ workspaces: 1 });
    } catch (e) {
      pushNotification({ status: "failure", category: "agent", priority: true, text: `Couldn't create workspace "${finalName}": ${e instanceof Error ? e.message : e}` });
      return;
    }

    const accent = workspaceColor(workspaces.length);
    const kind = agents[0];
    const { cmd, args } = agentCommand(kind);
    const count = agents.length;
    const { rows, cols } = gridDimsFor(count);
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
        agentKind: agents[i],
        sessionId: newClaudeSessionId(agents[i]),
        ...(i === 0 ? { prompt, launch } : {}),
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
        kind: agentCommand(d.agentKind ?? kind).cmd,
        status: "idle" as AgentStatusStr,
        statusChangedAt: Date.now(),
        attention: false,
        displayName: d.agentName,
        cwd: d.cwd,
        worktree: d.worktree,
        sessionId: d.sessionId,
        spawning: true,
        launch: d.launch,
        ...(prompt && d === descriptors[0]
          ? { intent: titleFromPrompt(prompt), intentRaw: prompt, promptHistory: [prompt] }
          : {}),
        phase: willFetch
          ? ({ kind: "fetching", ref: plan.baseRef } as PanePhase)
          : useWorktrees
            ? ({ kind: "branching", branch: branchForAgent(plan, d.agentName, solo) || undefined } as PanePhase)
            : ({ kind: "starting" } as PanePhase),
      })),
      tabs: [{ ...tab, layoutTree, focusedPaneId: paneIds[0] }],
      focusedTabId: tab.id,
    };
    // This workspace already owns its freshly prepared panes. Focusing it
    // must not restore a saved blob over the lineup we are launching.
    restoredWsIds.current.add(ws.id);
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
    if (prompt) {
      const first = descriptors[0];
      nameThreadWithAi(first.paneId, prompt);
      // Typed in only for an agent that cannot take it on the command line.
      if (promptArgs(first.agentKind ?? kind, prompt) === null) void deliverPromptWhenReady(first.paneId, prompt);
    }
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
    /** The thread's title, known before the agent is (a composer prompt), and
     * the model and effort to start with. */
    seed?: { intent?: string; intentRaw?: string; launch?: LaunchOptions },
  ) => {
    const ws = wsHint ?? workspacesRef.current.find((w) => w.id === workspaceId);
    if (!ws) {
      console.error("spawnAgentInWorkspace: workspace not found:", workspaceId);
      return;
    }
    const kind = kindOverride ?? ws.agentKind;
    const { cmd, args } = agentCommand(kind);
    const newCount = ws.panes.length + 1;
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
    // makes ThreadView show a placeholder until the process is live (mounting the
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
              intent: seed?.intent,
              intentRaw: seed?.intentRaw,
              promptHistory: seed?.intentRaw ? [seed.intentRaw] : undefined,
              launch: seed?.launch,
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
        args: [
          ...withClaudeSession(args, sessionId, "new"),
          ...launchArgs(kind, seed?.launch),
          ...(await graphSpawnArgs(kind, workspaceId, ws.secure)),
          // Last: `--` ends the options.
          ...(promptArgs(kind, initialPrompt) ?? []),
        ],
        cwd: spawnCwd,
        rows: ptyRows,
        cols: ptyCols,
        agentName,
        secure: ws.secure,
        graphEnabled: getGraphEnabled(),
        setupRepo,
      });
      recordUsage({ agents: 1, prompts: initialPrompt?.trim() ? 1 : 0 });
      // In a co-pilot session the partner sees this agent and may type into it.
      if (ws.copilot) {
        shareCopilotPane(ws.copilot.partnerLogin, ws.copilot.sessionId, paneId).catch((error) =>
          pushNotification({ status: "failure", category: "agent", priority: true, text: `Agent started, but sharing it failed: ${error instanceof Error ? error.message : error}` }),
        );
      }
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

    // Process is live — drop the placeholder so the terminal mounts, and
    // persist the now-settled workspace.
    let updated: Workspace | undefined;
    setWorkspaces((prev) =>
      prev.map((w) => {
        if (w.id !== workspaceId) return w;
        return updated = { ...w, panes: w.panes.map((p) => p.id === paneId ? { ...p, spawning: false, booting: !hasAgentStarted(paneId) } : p) };
      }),
    );
    if (updated) saveWorkspace(updated);

    if (initialPrompt && promptArgs(kind, initialPrompt) === null) {
      // An agent without a prompt argument has it typed in: wait for booting
      // to clear, then bracketed paste and Enter. Awaited so reviewPr's
      // loading state covers delivery, not just spawn.
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
        prompt,
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

    // Fanned out per pane rather than through broadcastInput: broadcast
    // replicates what is *typed into the focused pane* to the visible panes of
    // its tab, so it depends on focus, visibility, and the user not having
    // switched away — none of which hold while N agents are still booting at
    // their own pace. Broadcast stays off, and stays available in the header
    // for the follow-up nudges where it is the right tool.
    // On the command line where the agent takes it (see v2/launch.ts); typed
    // in, per pane, where it does not.
    if (promptArgs(kind, prompt) === null) {
      for (const d of descriptors) {
        deliverPromptWhenReady(d.paneId, prompt).catch(console.error);
      }
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
          if (!w.repo_path || w.prReview) continue;
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

  /** "owner/repo" → repo_path for every open workspace, feeding the merge-queue modal's
   * local conflict analysis. First workspace per slug wins. */
  const repoPathsForQueue = useCallback(async (): Promise<Record<string, string>> => {
    const paths: Record<string, string> = {};
    for (const w of workspacesRef.current) {
      if (!w.repo_path) continue;
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
      recordUsage({ agents: 1 });
      if (ws.copilot) {
        shareCopilotPane(ws.copilot.partnerLogin, ws.copilot.sessionId, pane.id).catch((error) =>
          pushNotification({ status: "failure", category: "agent", priority: true, text: `Agent started, but sharing it failed: ${error instanceof Error ? error.message : error}` }),
        );
      }
    } catch (e) {
      pushNotification({ status: "failure", category: "agent", priority: true, text: `Couldn't spawn ${cmd}: ${e instanceof Error ? e.message : e}` });
      throw e;
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
              attention: false,
              displayName: agentName,
              cwd: spawnCwd,
              worktree,
              sessionId,
              // Same reason as the restore path: covered until its agent paints.
              booting: !hasAgentStarted(pane.id),
              status: latestAgentStatus(pane.id) ?? (pane.status as AgentStatusStr),
            },
          ],
        };
      }),
    );
    if (updated) saveWorkspace(updated);
    if (updated?.copilot) {
      const mine = updated.panes.filter((p) => !p.streamId).map((p) => ({ id: p.id, label: p.displayName ?? p.kind }));
      syncCopilotLayout(updated.copilot.partnerLogin, updated.copilot.partnerWid, updated.copilot.sessionId, mine);
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

  /** The workspace that owns a pane. */
  const ownerOfPane = (paneId: string) =>
    workspacesRef.current.find((w) => w.panes.some((p) => p.id === paneId));

  /** Close a pane, but if its worktree branch has commits that exist nowhere
   * else, stop and ask what to do with them first (Keep / Delete / Cancel).
   * All interactive close paths (topbar ✕, header ✕, ⌘⇧K, context menu) go
   * through here; closePaneInWorkspace below is the actual teardown. */
  const requestClosePane = async (paneId: string) => {
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
    // A friend watching this agent, or a co-pilot partner, stops receiving it.
    stopStream(paneId);
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
        if (!w.panes.some((p) => p.id === paneId)) return w;
        const remainingPanes = w.panes.filter((p) => p.id !== paneId);
        let emptiedTabId: string | null = null;
        let tabs = w.tabs.map((t) => {
          if (!t.layoutTree || !allPaneIds(t.layoutTree).includes(paneId)) return t;
          const newTree = remove(t.layoutTree, paneId);
          if (!newTree) emptiedTabId = t.id;
          const focusedPaneId = t.focusedPaneId === paneId ? (newTree ? firstPaneId(newTree) : null) : t.focusedPaneId;
          const zoomedPaneId = t.zoomedPaneId === paneId ? null : t.zoomedPaneId;
          return { ...t, layoutTree: newTree, focusedPaneId, zoomedPaneId };
        });
        // A thread whose last agent closed is over: drop it, and land on its
        // neighbour. A project keeps one (empty) tab, which shows the composer.
        let focusedTabId = w.focusedTabId;
        if (emptiedTabId && tabs.length > 1) {
          const at = tabs.findIndex((t) => t.id === emptiedTabId);
          tabs = tabs.filter((t) => t.id !== emptiedTabId);
          clearBroadcast(broadcastKey(w.id, emptiedTabId));
          if (focusedTabId === emptiedTabId) focusedTabId = tabs[Math.max(0, at - 1)].id;
        }
        const result = { ...w, tabs, focusedTabId, panes: remainingPanes };
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

    // v2 keeps the pane's place in its thread: the tile says it is open in
    // its own window (with a way back), and the thread stays in the sidebar.
    markPoppedOut(paneId, { workspaceId, tabId: tab.id });

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
        light: "#ffffff",
        dark: "#16181d",
        graphite: "#16181d",
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
    const targetWsId = origin?.workspaceId ?? workspaceId;
    let updated: Workspace | undefined;
    setWorkspaces((prev) =>
      prev.map((w) => {
        if (w.id !== targetWsId) return w;
        const pane = ownerOfPane(paneId)?.panes.find((p) => p.id === paneId);
        if (!pane) return w; // already closed/removed elsewhere
        // Still laid out where it was popped from (v2 keeps its place): just
        // bring that thread to the front.
        const home = findTabForPane(w, paneId);
        if (home) {
          return updated = {
            ...w,
            focusedTabId: home.id,
            tabs: w.tabs.map((t) => (t.id === home.id ? { ...t, focusedPaneId: paneId } : t)),
          };
        }
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
    // Open in its own window: raise that window as well as its thread.
    if (popoutRef.current.ids.has(paneId)) {
      WebviewWindow.getByLabel(`pane-${paneId}`)
        .then((win) => win?.setFocus())
        .catch(() => {});
    }
    if (ws && !findTabForPane(ws, paneId)) return;
    let updated: Workspace | undefined;
    setWorkspaces((prev) =>
      prev.map((w) => {
        if (w.id !== workspaceId) return w;
        const tab = findTabForPane(w, paneId) ?? getFocusedTab(w);
        return updated = {
          ...w,
          focusedTabId: tab.id,
          // A focused pane must also be visible. Retarget an existing zoom so
          // attention navigation cannot acknowledge an agent behind another
          // pane while leaving its terminal hidden.
          tabs: w.tabs.map((t) => t.id === tab.id ? { ...t, focusedPaneId: paneId, zoomedPaneId: t.zoomedPaneId ? paneId : null } : t),
        };
      }),
    );
    if (updated) saveWorkspace(updated);
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
        // Land on the thread above the one that closed, as a list does.
        const at = w.tabs.findIndex((t) => t.id === tabId);
        const focusedTabId = w.focusedTabId === tabId ? remainingTabs[Math.max(0, at - 1)].id : w.focusedTabId;
        return updated = { ...w, tabs: remainingTabs, focusedTabId, panes: remainingPanes };
      }),
    );
    if (updated) saveWorkspace(updated);
    clearBroadcast(broadcastKey(workspaceId, tabId));

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
  //
  // Read through one ref, refreshed every render (see `keysRef.current =`
  // below the handlers), so the listener is registered once and never acts on
  // a stale snapshot.
  const keysRef = useRef<{
    dialogOpen: boolean;
    menuOpen: boolean;
    paletteOpen: boolean;
    run: (action: string, arg?: number) => void;
  }>({ dialogOpen: false, menuOpen: false, paletteOpen: false, run: () => {} });

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const k = keysRef.current;
      if (!e.metaKey) return;
      const stop = () => { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); };
      const key = e.key.toLowerCase();

      // ⌘K before the dialog guard: no modal may switch the palette off.
      if (key === "k" && !e.shiftKey && !e.altKey) {
        stop();
        k.run("palette");
        return;
      }
      if (k.dialogOpen || k.menuOpen || k.paletteOpen) return;

      const textSizeDelta =
        e.key === "=" || e.key === "+" || e.code === "Equal" || e.code === "NumpadAdd" ? 1
        : e.key === "-" || e.key === "_" || e.code === "Minus" || e.code === "NumpadSubtract" ? -1
        : 0;

      if (e.key === "," && !e.shiftKey && !e.altKey) { stop(); k.run("settings"); }
      else if (key === "n" && !e.shiftKey) { stop(); k.run("new-agent"); }
      else if (key === "n" && e.shiftKey) { stop(); k.run("new-project"); }
      else if (key === "t" && !e.shiftKey) { stop(); k.run("new-agent"); }
      else if (key === "p" && e.shiftKey) { stop(); k.run("capture"); }
      else if (key === "d") { stop(); k.run(e.shiftKey ? "split-down" : "split-right"); }
      else if (key === "z" && !e.shiftKey) { stop(); k.run("zoom"); }
      else if (key === "k" && e.shiftKey) { stop(); k.run("close-agent"); }
      else if (key === "w" && e.shiftKey) { stop(); k.run("close-thread"); }
      else if (e.code === "BracketRight" || e.code === "BracketLeft") {
        // ⌘] / ⌘[ move between the agents of this thread; with ⇧, between threads.
        stop();
        const dir = e.code === "BracketRight" ? 1 : -1;
        k.run(e.shiftKey ? "thread-step" : "pane-step", dir);
      }
      else if (key === "j" && !e.shiftKey) { stop(); k.run("next-waiting"); }
      else if (e.key === "\\") { stop(); k.run("sidebar"); }
      else if (textSizeDelta !== 0) {
        // ⌘+ / ⌘- size the agents' text; with ⌥, the app's own.
        stop();
        if (e.altKey) stepUiScale(textSizeDelta);
        else stepPaneFontSize(textSizeDelta);
      }
      else if (/^[1-9]$/.test(e.key) && !e.shiftKey) { stop(); k.run("thread-index", Number(e.key) - 1); }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);

  // ⌘K pressed in a popped-out agent window: the palette opens here.
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
  const { voiceHud, voiceLevel, preview: previewVoiceHud, refresh: refreshVoice, dismissError: dismissVoiceError } = useVoicePushToTalk({
    getTargetPaneId: () => {
      const ws = workspaces.find((w) => w.id === focusedWsId);
      return ws ? getFocusedTab(ws).focusedPaneId : null;
    },
    // Dictation goes to the focused agent of the thread on screen, so it has
    // to be on screen: not while the composer or Settings covers it.
    guard: () => dialog.kind === "none" && !contextMenu && !composing,
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
    setWorkspaces((prev) => prev.filter((w) => w.id !== workspaceId));
    setDormant((prev) => {
      if (!(workspaceId in prev)) return prev;
      const next = { ...prev };
      delete next[workspaceId];
      return next;
    });
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
      const mine = ws.panes.filter((p) => !p.streamId).map((p) => p.id);
      await endCopilot(ws.copilot.partnerLogin, ws.copilot.partnerWid, ws.copilot.sessionId, mine).catch(() =>
        pushNotification({ status: "info", category: "agent", priority: true, text: "Sharing stopped here, but your partner couldn't be told. Check your connection." }),
      );
    } else if (ws?.observe) {
      endObserve(ws.observe.ownerLogin, ws.observe.ownerWid, ws.observe.sessionId);
    } else {
      await deleteWorkspaceCmd(workspaceId).catch(console.error);
    }
    if (focusedWsId === workspaceId) {
      const rest = workspaces.filter((w) => w.id !== workspaceId);
      setFocusedWsId(rest[0]?.id ?? null);
      if (rest.length === 0) setComposing({ projectId: null });
    }

    if (ws?.repo_path) {
      for (const wt of worktrees) {
        safeRemoveWorktree(ws.repo_path, wt)
          .catch((e) => console.error("failed to remove worktree for deleted workspace", e));
      }
    }
  };

  // ─── Context menus ─────────────────────────────────────────────────

  /** Right-click on an agent: what you would do to the text and to that one
   *  agent. Thread and project actions live in their "…" menus instead. */
  const openPaneMenu = (workspaceId: string, paneId: string | null, e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    const ws = workspacesRef.current.find((w) => w.id === workspaceId);
    if (!ws || !paneId) return;
    const pane = ws.panes.find((p) => p.id === paneId);
    const items: MenuItem[] = [];
    const selection = getTerminalSelection(paneId);
    const selectionUrl = getSelectionUrl(paneId);
    items.push({
      label: "Copy",
      disabled: !selection,
      onClick: () => copyText(selection).catch(() => flashPanePill(paneId, "copy failed", true)),
    });
    if (selectionUrl) {
      items.push({ label: "Copy Link", onClick: () => copyText(selectionUrl).catch(() => flashPanePill(paneId, "copy failed", true)) });
    }
    // What's typed but not sent can be kept for later (⌘K sends it back).
    if (getInputLine(paneId).trim()) {
      items.push({ label: "Save Prompt for Later", onClick: () => void sendInputLineToQueue(paneId) });
    }
    items.push({ label: "", divider: true });
    items.push({ label: "Add Agent Right", shortcut: "⌘D", onClick: () => void splitPane(workspaceId, "horizontal") });
    items.push({ label: "Add Agent Below", shortcut: "⌘⇧D", onClick: () => void splitPane(workspaceId, "vertical") });
    if (getFocusedTab(ws).layoutTree && allPaneIds(getFocusedTab(ws).layoutTree!).length > 1) {
      items.push({ label: getFocusedTab(ws).zoomedPaneId === paneId ? "Show All Agents" : "Zoom", shortcut: "⌘Z", onClick: () => zoomPane(workspaceId, paneId) });
    }
    items.push({ label: "Open in Its Own Window", onClick: () => void popOutPane(workspaceId, paneId) });
    items.push({ label: "", divider: true });
    items.push({ label: "Clear Terminal", onClick: () => sendInput(paneId, new TextEncoder().encode("\f")).catch(console.error) });
    if (ws.repo_path) {
      const paneCwd = pane?.cwd || ws.repo_path;
      items.push({ label: "Open in Terminal", onClick: () => void openTerminalHere(paneCwd) });
      items.push({ label: "Open in Finder", onClick: () => openPath(paneCwd).catch(console.error) });
      items.push({ label: "Open in VS Code", onClick: () => openPath(paneCwd, "Visual Studio Code").catch(console.error) });
      items.push({ label: "Copy Path", onClick: () => copyText(paneCwd).catch(() => flashPanePill(paneId, "copy failed", true)) });
    }
    items.push({ label: "", divider: true });
    items.push({ label: "Close Agent", shortcut: "⌘⇧K", danger: true, onClick: () => void requestClosePane(paneId) });
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
      // Touch only the workspace that owns the pane: unchanged workspaces keep
      // their identity, and an unchanged status bails before allocating
      // anything — no state change, no re-render.
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
      if (!prev.some((w) => w.panes.some((p) => p.id === paneId && (p.booting || p.phase)))) return prev;
      return prev.map((w) =>
        w.panes.some((p) => p.id === paneId)
          ? { ...w, panes: w.panes.map((p) => (p.id === paneId ? { ...p, booting: false, phase: undefined } : p)) }
          : w,
      );
    });
  }, []);

  // One listener each for every pane's status and start, for the life of the
  // window. v1 registered a status listener per pane inside every mounted
  // workspace; v2 mounts only the thread on screen, and the sidebar still has
  // to hear about all of them.
  const updatePaneStatusRef = useRef(updatePaneStatus);
  updatePaneStatusRef.current = updatePaneStatus;
  useEffect(() => {
    let cancelled = false;
    const unlisten: Array<() => void> = [];
    const keep = (p: Promise<() => void>) =>
      p.then((fn) => { if (cancelled) fn(); else unlisten.push(fn); }).catch(() => {});
    keep(onAnyAgentStatus((paneId, status) => updatePaneStatusRef.current(paneId, status)));
    keep(onAnyAgentStarted((paneId) => onAgentStart(paneId)));
    return () => {
      cancelled = true;
      for (const fn of unlisten) fn();
    };
  }, [onAgentStart]);

  // A submitted `/model <name>` switches the pane's model. Returns the model
  // token, or null if this isn't a model command or carries no argument.
  const parseModelCommand = (raw: string): string | null => {
    const m = raw.trim().match(/^\/models?\b\s*(\S+)?/i);
    if (!m) return null;
    const arg = m[1]?.trim();
    if (!arg) return null;
    return arg.length > 24 ? arg.slice(0, 24) : arg;
  };

  // The per-pane prompt log (for re-sending a past prompt), seeded from the
  // pane's saved history so it survives restarts.
  const promptHistoryRef = useRef<Map<string, string[]>>(new Map());
  const PROMPT_HISTORY_SIZE = 25;
  // Panes already given their one AI title this session (see below).
  const aiTitledRef = useRef<Set<string>>(new Set());

  /** One short AI title for a new thread, once, when Settings allows: a single
   *  `claude -p` per thread, never per prompt. It replaces the local title only
   *  if nothing has renamed the thread in the meantime. */
  const nameThreadWithAi = (paneId: string, prompt: string) => {
    if (!getAiTitles() || aiTitledRef.current.has(paneId)) return;
    const local = titleFromPrompt(prompt);
    if (!local) return;
    aiTitledRef.current.add(paneId);
    summarizeIntent(prompt)
      .then((summary) => {
        const label = summary?.trim();
        if (!label || label.length > 80) return;
        const now = workspacesRef.current.flatMap((w) => w.panes).find((p) => p.id === paneId);
        if (now && (now.intent === local || !now.intent)) {
          patchPaneIntent(paneId, { intent: label, intentRaw: now.intentRaw ?? prompt, promptHistory: now.promptHistory });
        }
      })
      .catch(() => { /* the local title stands */ });
  };

  /** Every prompt submitted into a pane. A thread is named after its first
   *  real task, locally and at once (see v2/titles.ts) — v1 ran `claude -p`
   *  on every prompt of every agent to relabel it. When Settings allows, the
   *  thread then gets one short AI title, once, and never again. Stable
   *  identity: it goes straight to the memoized Terminal. */
  const updatePaneIntent = useCallback((paneId: string, raw: string) => {
    const model = parseModelCommand(raw);
    if (model) { patchPaneModel(paneId, model); return; }
    // One prompt to an agent: the headline social stat (counted only for an
    // account that shares its usage; see usageStats).
    recordUsage({ prompts: 1 });

    const existingPane = workspacesRef.current.flatMap((w) => w.panes).find((p) => p.id === paneId);
    let log = promptHistoryRef.current.get(paneId);
    if (!log) { log = [...(existingPane?.promptHistory ?? [])]; promptHistoryRef.current.set(paneId, log); }
    if (log[log.length - 1] !== raw) log.push(raw);
    while (log.length > PROMPT_HISTORY_SIZE) log.shift();

    const firstTask = !existingPane?.intent && looksLikeTask(raw);
    const title = firstTask ? titleFromPrompt(raw) : undefined;
    patchPaneIntent(paneId, {
      intent: existingPane?.intent ?? title,
      intentRaw: existingPane?.intentRaw ?? (title ? raw : undefined),
      promptHistory: [...log],
    });

    if (title) nameThreadWithAi(paneId, raw);
    // Deps intentionally empty: every binding it touches is a ref or a
    // functional-update helper.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // ─── Settings ──────────────────────────────────────────────────────

  // Settings is a page of the main panel (lucy's Settings), not a dialog over
  // it. `tab` deep-links a page.
  const openSettings = (tab?: string) => {
    closePages();
    setDialog({ kind: "settings", tab: typeof tab === "string" ? tab : undefined });
  };

  // Opened via the native "flock → Settings…" menu item.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    onOpenSettings(() => setDialog({ kind: "settings" })).then((fn) => (unlisten = fn));
    return () => unlisten?.();
  }, []);

  // Light or dark, for the sidebar's toggle; kept in step with Settings.
  const [theme, setThemeState] = useState(getEffectiveTheme());
  useEffect(() => onThemeChange(setThemeState), []);
  const dark = theme !== "light";

  // ─── Where you are ─────────────────────────────────────────────────

  const dormantRef = useRef(dormant);
  dormantRef.current = dormant;
  const projects = useMemo(() => buildProjects(displayWorkspaces, dormant), [displayWorkspaces, dormant]);
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const composerProjects = useMemo(
    () => workspaces.map((w) => ({ id: w.id, name: w.name, repoPath: w.repo_path })),
    // Names and paths only: a status tick must not hand the composer a new list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workspaces.map((w) => `${w.id}\u0000${w.name}\u0000${w.repo_path}`).join("\u0001")],
  );
  const waiting = useMemo(() => waitingThreads(projects), [projects]);

  const focusedTab = focusedWs ? getFocusedTab(focusedWs) : undefined;
  const waking = !!(focusedWs && dormant[focusedWs.id]);
  const threadOnScreen = !!(focusedWs && focusedTab?.layoutTree && !waking);
  // What the main panel shows. Settings sits over all of it.
  const mainView: "thread" | "new" | "waking" = composing ? "new" : threadOnScreen ? "thread" : waking ? "waking" : "new";
  const currentThread: Thread | undefined = threadOnScreen
    ? projects.find((p) => p.id === focusedWs!.id)?.threads.find((t) => t.tabId === focusedTab!.id)
    : undefined;
  const focusedPane = threadOnScreen ? focusedWs!.panes.find((p) => p.id === focusedTab!.focusedPaneId) : undefined;

  /** Open a thread: its project comes to the front (waking it if it has not
   *  been restored yet), the thread is selected, and an agent in it that is
   *  waiting on you gets the focus — which is also what acknowledges it. */
  const openThread = (workspaceId: string, tabId: string) => {
    setComposing(null);
    closePages();
    setFocusedWsId(workspaceId);
    if (dormantRef.current[workspaceId]) {
      pendingTabRef.current.set(workspaceId, tabId);
      return;
    }
    const ws = workspacesRef.current.find((w) => w.id === workspaceId);
    const tab = ws?.tabs.find((t) => t.id === tabId);
    if (!ws || !tab) return;
    const ids = tab.layoutTree ? allPaneIds(tab.layoutTree) : [];
    const waitingPane = ids
      .map((id) => ws.panes.find((p) => p.id === id))
      .find((p) => p && (p.status === "awaiting_input" || p.status === "blocked"));
    const target = waitingPane?.id ?? tab.focusedPaneId ?? ids[0];
    if (target) focusPane(workspaceId, target);
    else switchTab(workspaceId, tabId);
  };
  focusPaneRefForToasts.current = (wsId: string, paneId: string) => {
    const ws = workspacesRef.current.find((w) => w.id === wsId);
    const tab = ws ? findTabForPane(ws, paneId) : undefined;
    if (tab) openThread(wsId, tab.id);
  };

  /** The composer, for a project (or the one on screen). */
  const beginNewAgent = (projectId?: string | null) => {
    setDialog((d) => (d.kind === "settings" ? { kind: "none" } : d));
    setComposing({ projectId: projectId ?? focusedWsIdRef.current });
  };

  /** A new thread in an existing project: a tab of its own (an empty one is
   *  reused), one agent, and the composer's prompt as its first task. */
  const startThread = async (workspaceId: string, kind: AgentKind, prompt: string, launch?: LaunchOptions) => {
    setFocusedWsId(workspaceId);
    // Waking a project replaces its tabs with the saved ones; the new thread
    // has to be added after that, not raced against it.
    if (!restoredWsIds.current.has(workspaceId)) await restoreWorkspaceById(workspaceId);
    let fresh: WorkspaceTab | undefined;
    setWorkspaces((prev) => prev.map((w) => {
      if (w.id !== workspaceId) return w;
      const empty = w.tabs.find((t) => !t.layoutTree);
      fresh = empty ?? makeTab(String(w.tabs.length + 1));
      return { ...w, tabs: empty ? w.tabs : [...w.tabs, fresh], focusedTabId: fresh.id };
    }));
    const title = prompt ? titleFromPrompt(prompt) : undefined;
    const paneId = await spawnAgentInWorkspace(
      workspaceId,
      prompt || undefined,
      undefined,
      kind,
      undefined,
      { intent: title, intentRaw: prompt || undefined, launch },
    ).catch(() => undefined);
    if (paneId && prompt) nameThreadWithAi(paneId, prompt);
  };

  /** A new project from a folder, then its first thread. Uses your defaults
   *  for branches and secure mode; "More options" has the rest. */
  const startProject = async (dir: string, kind: AgentKind, prompt: string, launch?: LaunchOptions) => {
    const name = dir.replace(/\/+$/, "").split("/").pop() || "project";
    // Your checkout, unless you chose per-agent worktrees in Settings: a
    // worktree is a new folder, and a new folder is one more "do you trust
    // it?" from the agent before it starts.
    const mode = getComposerBranchMode();
    const plan: BranchPlan = mode === "new"
      ? { mode: "new", stem: slugify(name), baseRef: "", fetch: getFetchBaseDefault() }
      : { mode: "current", stem: slugify(name), baseRef: "", fetch: false };
    let secure = false;
    if (getSecureByDefault()) secure = await containerStatus().then((c) => c.daemon_running).catch(() => false);
    await onNewWorkspaceConfirmed({ name, agents: [kind], dir, plan, secure }, prompt || undefined, launch);
  };

  const startFromComposer = (req: StartRequest) => {
    setComposing(null);
    if (req.projectId) void startThread(req.projectId, req.kind, req.prompt, req.launch);
    else if (req.dir) void startProject(req.dir, req.kind, req.prompt, req.launch);
  };

  const pickFolder = async (): Promise<string | null> => {
    const picked = await openDialog({ directory: true, multiple: false, title: "Choose a project folder" }).catch(() => null);
    return typeof picked === "string" ? picked : null;
  };

  /** The next thread, in sidebar order (⌘⇧] / ⌘⇧[). */
  const stepThread = (dir: number) => {
    const list = projectsRef.current.flatMap((p) => p.threads);
    if (list.length === 0) return;
    const at = list.findIndex((t) => t.workspaceId === focusedWsIdRef.current && t.tabId === focusedTab?.id);
    const next = list[(at + dir + list.length) % list.length];
    openThread(next.workspaceId, next.tabId);
  };

  /** The next thread waiting on you, across every project (⌘J). */
  const nextWaiting = () => {
    const list = waitingThreads(projectsRef.current);
    if (list.length === 0) return;
    const at = list.findIndex((t) => t.workspaceId === focusedWsIdRef.current && t.tabId === focusedTab?.id);
    const next = list[(at + 1) % list.length];
    openThread(next.workspaceId, next.tabId);
  };

  const closeThread = (workspaceId: string, tabId: string) => void requestCloseTab(workspaceId, tabId);

  const renameThread = (workspaceId: string, tabId: string, name: string) => renameTabInWorkspace(workspaceId, tabId, name);

  // ─── Menus ─────────────────────────────────────────────────────────

  const openInMenu = (dir: string): MenuEntry[] => [
    { label: "Open in Terminal", onSelect: () => void openTerminalHere(dir) },
    { label: "Open in Finder", onSelect: () => { openPath(dir).catch(console.error); } },
    { label: "Open in VS Code", onSelect: () => { openPath(dir, "Visual Studio Code").catch(console.error); } },
    { label: "Copy path", onSelect: () => { copyText(dir).catch(() => notifyFailure("Couldn't copy the path.")); } },
  ];

  const projectMenu = (workspaceId: string): MenuEntry[] => {
    const ws = workspacesRef.current.find((w) => w.id === workspaceId);
    if (!ws) return [];
    return [
      { label: "New agent", hint: "⌘N", onSelect: () => beginNewAgent(workspaceId) },
      ...(ws.repo_path ? [{ label: "Race agents on one prompt…", onSelect: () => setDialog({ kind: "race", workspaceId }) } as MenuEntry] : []),
      { separator: true },
      ...(ws.repo_path ? openInMenu(ws.repo_path) : []),
      { separator: true },
      { label: "Rename project…", onSelect: () => setDialog({ kind: "rename-workspace", workspaceId, current: ws.name }) },
      { label: "Remove project", danger: true, onSelect: () => requestCloseWorkspace(workspaceId) },
    ];
  };

  const threadMenu = (t: Thread): MenuEntry[] => [
    ...(t.paneId ? [{ label: "Open in its own window", onSelect: () => void popOutPane(t.workspaceId, t.paneId!) } as MenuEntry] : []),
    { separator: true },
    { label: t.agents > 1 ? `Close thread and its ${t.agents} agents` : "Close thread", danger: true, onSelect: () => closeThread(t.workspaceId, t.tabId) },
  ];

  useBroadcast();
  const headerMenu = (): MenuEntry[] => {
    if (!focusedWs || !focusedTab) return [];
    const ws = focusedWs;
    const tab = focusedTab;
    const ids = tab.layoutTree ? allPaneIds(tab.layoutTree) : [];
    const key = broadcastKey(ws.id, tab.id);
    const target = tab.focusedPaneId;
    const dir = (target && ws.panes.find((p) => p.id === target)?.cwd) || ws.repo_path;
    return [
      { label: "Add agent right", hint: "⌘D", onSelect: () => void splitPane(ws.id, "horizontal") },
      { label: "Add agent below", hint: "⌘⇧D", onSelect: () => void splitPane(ws.id, "vertical") },
      ...AGENT_KINDS.filter((k) => k !== ws.agentKind).map<MenuEntry>((k) => ({
        label: `Add ${agentLabel(k)}`,
        onSelect: () => void spawnAgentInWorkspace(ws.id, undefined, undefined, k),
      })),
      ...(ids.length > 1
        ? [
            { separator: true } as MenuEntry,
            { label: "Type into every agent", checked: isBroadcasting(key), onSelect: () => toggleBroadcast(key) } as MenuEntry,
            ...(target ? [{ label: tab.zoomedPaneId ? "Show all agents" : "Zoom this agent", hint: "⌘Z", onSelect: () => zoomPane(ws.id, target) } as MenuEntry] : []),
          ]
        : []),
      ...(target ? [{ label: "Open in its own window", onSelect: () => void popOutPane(ws.id, target) } as MenuEntry] : []),
      { separator: true },
      ...(ws.repo_path ? [{ label: "Race this task across agents…", onSelect: () => setDialog({ kind: "race", workspaceId: ws.id }) } as MenuEntry] : []),
      ...(dir ? openInMenu(dir) : []),
      { separator: true },
      ...(target && ids.length > 1 ? [{ label: "Close this agent", hint: "⌘⇧K", danger: true, onSelect: () => void requestClosePane(target) } as MenuEntry] : []),
      { label: "Close thread", hint: "⌘⇧W", danger: true, onSelect: () => closeThread(ws.id, tab.id) },
    ];
  };

  // The branches this thread's agents are on: the focused one's first.
  const threadBranches = useMemo(() => {
    if (!threadOnScreen || !focusedWs || !focusedTab?.layoutTree) return { branch: undefined as string | undefined, others: [] as string[] };
    const map = repoMaps[focusedWs.id];
    const live = (cwd: string, fallback?: string) => {
      const wt = map?.worktrees.find((t) => t.path === cwd);
      return wt ? wt.branch || (wt.head ? `detached@${wt.head.slice(0, 7)}` : "") : fallback ?? "";
    };
    const ids = allPaneIds(focusedTab.layoutTree);
    const branchOf = (id: string) => {
      const p = focusedWs.panes.find((x) => x.id === id);
      return p ? live(p.cwd, p.worktree?.branch || focusedWs.branch) : "";
    };
    const first = branchOf(focusedTab.focusedPaneId ?? ids[0]) || focusedWs.branch;
    const others = [...new Set(ids.map(branchOf).filter((b) => b && b !== first))];
    return { branch: first || undefined, others };
  }, [threadOnScreen, focusedWs, focusedTab, repoMaps]);

  // ─── Command bar contents ──────────────────────────────────────────
  //
  // Everything in the app is reachable here by name. Built from live state on
  // every render: most of it is not a static verb but the threads and projects
  // that exist right now. Threads waiting on you come first.
  const commands: Command[] = useMemo(() => {
    const out: Command[] = [];
    for (const p of projects) {
      for (const t of p.threads) {
        const waitingHere = t.state === "needs-you";
        out.push({
          id: `thread:${t.key}`,
          group: waitingHere ? "Needs you" : "Agents",
          label: waitingHere ? `${t.title} is waiting on you` : t.title,
          hint: p.name,
          attention: waitingHere,
          detail: t.agents > 1 ? `${t.agents} agents` : undefined,
          keywords: `${t.kinds.join(" ")} ${p.name} agent thread`,
          run: () => openThread(t.workspaceId, t.tabId),
        });
      }
    }
    for (const ws of workspaces) {
      out.push({
        id: `ws:${ws.id}`,
        group: "Projects",
        label: `New agent in ${ws.name}`,
        hint: ws.branch || undefined,
        keywords: "project workspace new start spawn",
        context: ws.repo_path ?? "",
        run: () => beginNewAgent(ws.id),
      });
    }
    out.push({ id: "act:new", group: "Start", label: "New agent", hint: "⌘N", keywords: "spawn launch new claude codex opencode grok start", run: () => beginNewAgent() });
    out.push({ id: "act:new-project", group: "Start", label: "New project with options…", hint: "⌘⇧N", keywords: "workspace worktree branch secure lineup grid create", run: () => beginNewWorkspace() });
    if (focusedWs) {
      const here = focusedWs.name;
      out.push({ id: "act:grid", group: "Start", label: "Start a grid of agents", hint: here, keywords: "layout split quad six eight twelve many", run: () => {
        const id = focusedWs.id;
        setComposing(null);
        newTabInWorkspace(id);
        setDialog({ kind: "spawn-layout", workspaceId: id });
      } });
      if (focusedWs.repo_path) {
        out.push({ id: "act:race", group: "Start", label: "Race agents on one prompt", hint: here, keywords: "fan out parallel worktree compare contenders", run: () => setDialog({ kind: "race", workspaceId: focusedWs.id }) });
      }
      if (focusedTab?.race) {
        out.push({ id: "act:race-compare", group: "Review", label: `Compare the ${focusedTab.race.contenders.length} race contenders`, hint: here, keywords: "race diff judge merge winner", run: () => setDialog({ kind: "race-compare", workspaceId: focusedWs.id, tabId: focusedTab.id }) });
      }
      out.push({ id: "act:changes", group: "Review", label: changesOpen ? "Hide changes" : "Show changes", hint: here, keywords: "diff git status uncommitted review changes branches worktrees", run: () => toggleChanges() });
      if (threadOnScreen) {
        out.push({ id: "act:split-right", group: "Agents", label: "Add an agent right", hint: "⌘D", keywords: "pane split new beside", run: () => void splitPane(focusedWs.id, "horizontal") });
        out.push({ id: "act:split-down", group: "Agents", label: "Add an agent below", hint: "⌘⇧D", keywords: "pane split new vertical", run: () => void splitPane(focusedWs.id, "vertical") });
        if (focusedTab?.focusedPaneId) {
          const target = focusedTab.focusedPaneId;
          out.push({ id: "act:zoom", group: "Agents", label: focusedTab.zoomedPaneId === target ? "Show all agents" : "Zoom this agent", hint: "⌘Z", keywords: "full screen maximize expand", run: () => zoomPane(focusedWs.id, target) });
          out.push({ id: "act:popout", group: "Agents", label: "Open this agent in its own window", keywords: "pop out detach window monitor", run: () => void popOutPane(focusedWs.id, target) });
          out.push({ id: "act:close-pane", group: "Agents", label: "Close this agent", hint: "⌘⇧K", keywords: "kill stop quit end pane", run: () => void requestClosePane(target) });
        }
        if (focusedTab) out.push({ id: "act:close-thread", group: "Agents", label: "Close this thread", hint: "⌘⇧W", keywords: "close tab end", run: () => closeThread(focusedWs.id, focusedTab.id) });
      }
      out.push({ id: "act:rename-ws", group: "Projects", label: `Rename "${here}"`, keywords: "project workspace title name", run: () => setDialog({ kind: "rename-workspace", workspaceId: focusedWs.id, current: focusedWs.name }) });
      out.push({ id: "act:delete-ws", group: "Projects", label: `Remove "${here}"`, keywords: "project workspace remove close delete", run: () => requestCloseWorkspace(focusedWs.id) });
    }
    // Saved prompts (⌘⇧P, or "Save prompt for later" on an agent), sent back
    // into the agent on screen.
    const target = focusedTab?.focusedPaneId;
    for (const q of queueItems.filter((i) => i.status === "queued").slice().reverse()) {
      out.push({
        id: `queue:${q.id}`,
        group: "Saved prompts",
        label: queuePreview(q.text),
        hint: target ? "send to this agent" : undefined,
        keywords: "queue saved prompt later send",
        run: () => { if (target) void launchQueueItem(q.id, target); else notifyFailure("Open an agent first, then send the prompt to it."); },
      });
    }
    out.push({ id: "act:queue", group: "Start", label: "Save a prompt for later", hint: "⌘⇧P", keywords: "queue idea note screenshot capture", run: () => setDialog({ kind: "queue-capture" }) });
    out.push({ id: "act:prs", group: "Review", label: "Pull requests", keywords: "github pr checks review", run: () => setDialog({ kind: "pr-hub", view: "prs" }) });
    out.push({ id: "act:queue-view", group: "Review", label: "Merge queue", keywords: "github merge", run: () => setDialog({ kind: "pr-hub", view: "queue" }) });
    if (getGraphEnabled()) {
      out.push({ id: "act:graph", group: "App", label: "Graph Explorer", keywords: "knowledge memory decisions recall nodes", run: () => window.dispatchEvent(new Event(OPEN_GRAPH_EXPLORER_EVENT)) });
      out.push({ id: "act:insights", group: "App", label: "Graph insights", keywords: "knowledge memory coverage recall metrics", run: () => window.dispatchEvent(new CustomEvent<GraphExplorerOpenDetail>(OPEN_GRAPH_EXPLORER_EVENT, { detail: { view: "insights" } })) });
    }
    out.push({ id: "act:graph-setup", group: "App", label: getGraphEnabled() ? "Graph settings" : "Set up the knowledge graph", keywords: "kg memory postgres docker engine mcp", run: () => window.dispatchEvent(new Event(OPEN_GRAPH_SETUP_EVENT)) });
    for (const t of THEMES) {
      out.push({ id: `theme:${t.id}`, group: "App", label: `Theme: ${t.label}`, keywords: "appearance dark light colour color contrast", run: () => applyTheme(t.id) });
    }
    out.push({ id: "act:settings", group: "App", label: "Settings", hint: "⌘,", keywords: "preferences theme appearance security graph shortcuts", run: () => openSettings() });
    if (idProfile?.id) out.push({ id: "act:me", group: "App", label: "Your stats and achievements", keywords: "usage tokens spend profile trophies me", run: () => { closePages(); setDialog({ kind: "my-info" }); } });
    out.push({ id: "act:sidebar", group: "App", label: sidebarCollapsed ? "Show sidebar" : "Hide sidebar", hint: "⌘\\", keywords: "rail panel collapse", run: () => toggleSidebarCollapsed() });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, workspaces, focusedWsId, focusedTab, threadOnScreen, sidebarCollapsed, changesOpen, queueItems]);

  /** The palette's answer to text that is not a command: the agents you can
   *  hand it to (pasted into their input line, not submitted), or a new one. */
  const promptActions = useCallback((text: string): Command[] => {
    const out: Command[] = [];
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
    for (const p of projectsRef.current) {
      for (const t of p.threads) {
        if (!t.paneId) continue;
        out.push({
          id: `send:${t.key}`,
          group: "Send to",
          label: t.title,
          hint: p.name,
          attention: t.state === "needs-you",
          keywords: `${t.kinds.join(" ")} ${p.name} send prompt tell ask`,
          run: () => {
            openThread(t.workspaceId, t.tabId);
            void inject(t.paneId!);
          },
        });
      }
    }
    const here = focusedWsIdRef.current;
    if (here) {
      out.push({
        id: "send:new",
        group: "Send to",
        label: "A new agent",
        hint: workspacesRef.current.find((w) => w.id === here)?.name,
        keywords: "spawn start fresh new",
        run: () => void startThread(here, workspacesRef.current.find((w) => w.id === here)?.agentKind ?? "claude", text),
      });
      if (workspacesRef.current.find((w) => w.id === here)?.repo_path) {
        out.push({ id: "send:race", group: "Send to", label: "Several agents, racing", keywords: "race fan out parallel compare", run: () => setDialog({ kind: "race", workspaceId: here, prompt: text }) });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Stable handler identities for the memoized children ───────────────
  // useEventCallback: one identity for the life of the component, always
  // calling the current render's function (see lib/useEventCallback.ts).
  const sNewAgent = useEventCallback(beginNewAgent);
  const sOpenThread = useEventCallback(openThread);
  const sNextWaiting = useEventCallback(nextWaiting);
  const sOpenPrs = useEventCallback(() => {
    closePages();
    setDialog({ kind: "pr-hub", view: "prs" });
  });
  const sOpenGraph = useEventCallback(() =>
    window.dispatchEvent(new Event(getGraphEnabled() ? OPEN_GRAPH_EXPLORER_EVENT : OPEN_GRAPH_SETUP_EVENT)),
  );
  const sOpenSettings = useEventCallback(openSettings);
  const sToggleSidebar = useEventCallback(toggleSidebarCollapsed);
  const sRenameThread = useEventCallback(renameThread);
  const sThreadMenu = useEventCallback(threadMenu);
  const sProjectMenu = useEventCallback(projectMenu);
  const sToggleTheme = useEventCallback(() => applyTheme(dark ? "light" : "dark"));
  const sHeaderMenu = useEventCallback(headerMenu);
  const sToggleChanges = useEventCallback(toggleChanges);
  const sSplitRight = useEventCallback(() => { if (focusedWsIdRef.current) void splitPane(focusedWsIdRef.current, "horizontal"); });
  const sShowSidebar = useEventCallback(() => { if (sidebarCollapsed) toggleSidebarCollapsed(); });
  const sRenameCurrent = useEventCallback((name: string) => {
    if (focusedWs && focusedTab) renameTabInWorkspace(focusedWs.id, focusedTab.id, name);
  });
  const sCompareRace = useEventCallback(() => {
    if (focusedWs && focusedTab?.race) setDialog({ kind: "race-compare", workspaceId: focusedWs.id, tabId: focusedTab.id });
  });
  const sFocusPane = useEventCallback(focusPane);
  const sResizeSplit = useEventCallback(resizeSplit);
  const sEvenSplits = useEventCallback(evenSplits);
  const sSwapPanes = useEventCallback(swapPanesInTab);
  const sZoomPane = useEventCallback(zoomPane);
  const sClosePane = useEventCallback(requestClosePane);
  const sPaneContextMenu = useEventCallback(openPaneMenu);
  const sBringBack = useEventCallback(bringBackPane);
  const sStart = useEventCallback(startFromComposer);
  const sPickFolder = useEventCallback(pickFolder);
  const sMoreOptions = useEventCallback(() => { setComposing(null); beginNewWorkspace(); });
  const sCancelComposer = useEventCallback(() => setComposing(null));

  // Stable for the memoized sidebar: rebuilt only when the profile changes.
  // ─── Sessions with friends: co-pilot, watching, tasks ────────────────────
  // All three ride the presence connection (lib/session.ts, over Ably). A
  // friend asking to watch, inviting you to co-pilot or sending a task is a
  // note in the corner with an answer on it. Co-pilot is a temporary project,
  // "co-pilot · @friend", holding your agents and theirs; watching is a
  // temporary project with their one agent, read-only; a task is a prompt
  // handed to the agent in focus (or to a new one).
  const [sessionToasts, setSessionToasts] = useState<ToastItem[]>([]);
  const [taskDialog, setTaskDialog] = useState<{ login: string; windowId: string; avatar?: string } | null>(null);
  /** Session id → the local pane a friend is watching. */
  const observeSharesRef = useRef(new Map<string, string>());
  const handleSessionMsgRef = useRef<(msg: SessionMsg) => void>(() => {});

  /** The agent to share, or to hand a task to: the one in focus on screen,
   *  else the first of yours anywhere. Never a friend's. */
  const resolveShareTarget = (): { ws: Workspace; pane: Pane } | null => {
    const local = (w: Workspace) => !w.observe && !w.copilot;
    const ws =
      workspacesRef.current.find((w) => w.id === focusedWsIdRef.current && local(w) && w.panes.some((p) => !p.streamId)) ??
      workspacesRef.current.find((w) => local(w) && w.panes.some((p) => !p.streamId && !p.spawning));
    if (!ws) return null;
    const focusedId = getFocusedTab(ws)?.focusedPaneId;
    const pane = ws.panes.find((p) => p.id === focusedId && !p.streamId) ?? ws.panes.find((p) => !p.streamId);
    return pane ? { ws, pane } : null;
  };

  const newObserveWorkspace = (sessionId: string, ownerLogin: string, ownerWid: string, ownerAvatar: string | undefined, paneLabel: string): Workspace => {
    const wsId = `observe:${sessionId}`;
    const remotePane: Pane = {
      id: `${wsId}:pane`,
      workspaceId: wsId,
      kind: paneLabel,
      displayName: paneLabel,
      status: "idle",
      attention: false,
      streamId: sessionId, // observe streams use the session id as the channel
      cwd: "",
    };
    const tab = makeTab(paneLabel);
    return {
      id: wsId,
      name: `watching @${ownerLogin}`,
      repo_path: "",
      branch: "live",
      created_at: Date.now(),
      accentColor: "var(--ws-accent-5)",
      panes: [remotePane],
      tabs: [{ ...tab, layoutTree: { type: "leaf", paneId: remotePane.id }, focusedPaneId: remotePane.id }],
      focusedTabId: tab.id,
      agentKind: "claude",
      observe: { sessionId, ownerLogin, ownerWid, ownerAvatar },
    };
  };

  const newCopilotWorkspace = (
    sessionId: string,
    partnerLogin: string,
    partnerWid: string,
    partnerAvatar: string | undefined,
    // The inviter starts "pending" and flips to "connected" on copilot_accept;
    // the guest is connected from the start: they build this by accepting.
    status: "pending" | "connected" = "pending",
  ): Workspace => {
    const tab = makeTab("Together");
    return {
      id: `copilot:${sessionId}`,
      name: `co-pilot · @${partnerLogin}`,
      repo_path: "",
      branch: "shared",
      created_at: Date.now(),
      accentColor: "var(--ws-accent-6)",
      panes: [],
      tabs: [tab],
      focusedTabId: tab.id,
      agentKind: "claude",
      copilot: { sessionId, partnerLogin, partnerWid, partnerAvatar, status },
    };
  };

  /** Lay the partner's panes beside yours in a co-pilot workspace. */
  const mergePartnerPanes = (ws: Workspace, partnerPanes: CopilotPane[]): Workspace => {
    const wsId = ws.id;
    const localPanes = ws.panes.filter((p) => !p.streamId);
    const remotePanes: Pane[] = partnerPanes.map((p) => ({
      id: `${wsId}:${p.id}`,
      workspaceId: wsId,
      kind: p.label,
      displayName: p.label,
      status: "idle",
      attention: false,
      streamId: p.id,
      cwd: "",
    }));
    const allPanes = [...localPanes, ...remotePanes];
    const n = allPanes.length;
    const cols = n <= 1 ? 1 : n <= 4 ? 2 : 3;
    const rows = Math.ceil(n / cols);
    const layoutTree = n > 0 ? buildGridLayout(allPanes.map((p) => p.id), rows, cols) : null;
    const tab = getFocusedTab(ws);
    const focusedPaneId = allPanes.find((p) => p.id === tab.focusedPaneId)?.id ?? allPanes[0]?.id ?? null;
    return { ...ws, panes: allPanes, tabs: ws.tabs.map((t) => (t.id === tab.id ? { ...t, layoutTree, focusedPaneId } : t)) };
  };

  const markCopilotConnected = (ws: Workspace): Workspace =>
    ws.copilot && ws.copilot.status !== "connected" ? { ...ws, copilot: { ...ws.copilot, status: "connected" } } : ws;

  /** Show a session workspace: it takes the main panel from any page. */
  const showSessionWorkspace = (wsId: string) => {
    closePages();
    setComposing(null);
    setFocusedWsId(wsId);
  };

  handleSessionMsgRef.current = (msg: SessionMsg) => {
    // Authorization gate. `msg.from` is proven authentic in session.ts (it must
    // equal Ably's verified clientId), so it is safe to allowlist on: only
    // accepted friends, or your own other windows, may ask to watch, invite or
    // hand over a task. A stranger's request would otherwise be a one-click
    // task injection into an agent running with bypassed permissions.
    const isSelf = msg.from === idProfile?.handle;
    const friend = friends.find((f) => f.handle === msg.from && f.friendStatus === "accepted");
    if (!friend && !isSelf) return;

    // ── Watching ─────────────────────────────────────────────────────────
    if (msg.type === "observe_request") {
      pushNotification({ status: "info", category: "agent", priority: false, text: `@${msg.from} asked to watch your agent` });
      // The note above is unconditional; only the pop-up can be turned off.
      if (isToastSuppressed("observe_request")) return;
      setSessionToasts((prev) => [...prev, {
        id: msg.session_id,
        kind: "observe_request",
        fromLogin: msg.from,
        fromAvatar: friend?.avatarUrl,
        sessionId: msg.session_id,
        onAccept: async () => {
          // Resolved now: focus may have moved since the request arrived.
          const target = resolveShareTarget();
          if (!target) {
            declineObserve(msg.from, msg.from_wid, msg.session_id);
            pushNotification({ status: "info", category: "agent", priority: true, text: `No agent running to share, so @${msg.from}'s request was declined. Start one and ask them to try again.` });
            return;
          }
          try {
            await acceptObserve(msg.from, msg.from_wid, msg.session_id, target.pane.id, target.pane.displayName ?? target.pane.kind);
            if (!workspacesRef.current.some((w) => w.panes.some((p) => p.id === target.pane.id))) {
              endObserve(msg.from, msg.from_wid, msg.session_id, target.pane.id);
              return;
            }
            observeSharesRef.current.set(msg.session_id, target.pane.id);
            pushNotification({ status: "success", category: "agent", priority: false, text: `@${msg.from} is watching ${target.pane.displayName ?? target.pane.kind}` });
          } catch (error) {
            pushNotification({ status: "failure", category: "agent", priority: true, text: `Couldn't share the agent: ${error instanceof Error ? error.message : error}` });
          }
        },
        onDecline: () => declineObserve(msg.from, msg.from_wid, msg.session_id),
      }]);
    }
    if (msg.type === "observe_accept") {
      const ws = newObserveWorkspace(msg.session_id, msg.from, msg.from_wid, friend?.avatarUrl, msg.pane_label);
      setWorkspaces((prev) => [...prev, ws]);
      showSessionWorkspace(ws.id);
      pushNotification({ status: "success", category: "agent", priority: false, text: `Watching @${msg.from}'s ${msg.pane_label}` });
    }
    if (msg.type === "observe_decline" || msg.type === "observe_end") {
      const wsId = `observe:${msg.session_id}`;
      const wasWatching = workspacesRef.current.some((w) => w.id === wsId);
      setWorkspaces((prev) => prev.filter((w) => w.id !== wsId));
      setFocusedWsId((prev) => (prev === wsId ? null : prev));
      if (msg.type === "observe_decline") {
        pushNotification({ status: "info", category: "agent", priority: true, text: `@${msg.from} declined to share their agent` });
      }
      // Your side: the watcher left, so stop publishing that pane.
      const sharedPaneId = observeSharesRef.current.get(msg.session_id);
      if (msg.type === "observe_end" && sharedPaneId) {
        observeSharesRef.current.delete(msg.session_id);
        stopStream(sharedPaneId);
        pushNotification({ status: "info", category: "agent", priority: false, text: `@${msg.from} stopped watching` });
      } else if (msg.type === "observe_end" && wasWatching) {
        pushNotification({ status: "info", category: "agent", priority: false, text: `@${msg.from} stopped sharing their agent` });
      }
    }

    // ── Tasks ────────────────────────────────────────────────────────────
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
          // With an agent in focus the prompt is typed into it (\r submits);
          // with none, a new agent starts with the task as its first prompt.
          const target = resolveShareTarget();
          if (target) {
            await sendInput(target.pane.id, new TextEncoder().encode(msg.prompt + "\r"));
          } else {
            const ws = workspacesRef.current.find((w) => w.id === focusedWsIdRef.current && !w.observe && !w.copilot)
              ?? workspacesRef.current.find((w) => !w.observe && !w.copilot);
            if (!ws) {
              declineTask(msg.from, msg.from_wid, msg.task_id);
              pushNotification({ status: "info", category: "agent", priority: true, text: `No project open for @${msg.from}'s task, so it was declined.` });
              return;
            }
            await spawnAgentInWorkspace(ws.id, msg.prompt).catch(console.error);
          }
          acceptTask(msg.from, msg.from_wid, msg.task_id);
          pushNotification({ status: "success", category: "agent", priority: false, text: `@${msg.from}'s task went to an agent` });
        },
        onDecline: () => declineTask(msg.from, msg.from_wid, msg.task_id),
      }]);
    }
    if (msg.type === "task_accept") {
      pushNotification({ status: "success", category: "agent", priority: true, text: `@${msg.from} took your task` });
    }
    if (msg.type === "task_decline") {
      pushNotification({ status: "info", category: "agent", priority: true, text: `@${msg.from} declined your task` });
    }

    // ── Co-pilot ─────────────────────────────────────────────────────────
    if (msg.type === "copilot_invite") {
      pushNotification({ status: "info", category: "agent", priority: false, text: `@${msg.from} invited you to co-pilot` });
      if (isToastSuppressed("copilot_invite")) return;
      setSessionToasts((prev) => [...prev, {
        id: msg.session_id,
        kind: "copilot_invite",
        fromLogin: msg.from,
        fromAvatar: friend?.avatarUrl,
        sessionId: msg.session_id,
        onAccept: async () => {
          try {
            await acceptCopilot(msg.from, msg.from_wid, msg.session_id, []);
          } catch (error) {
            pushNotification({ status: "failure", category: "agent", priority: true, text: `Couldn't join the co-pilot session: ${error instanceof Error ? error.message : error}` });
            return;
          }
          const ws = mergePartnerPanes(newCopilotWorkspace(msg.session_id, msg.from, msg.from_wid, friend?.avatarUrl, "connected"), msg.panes);
          setWorkspaces((prev) => [...prev, ws]);
          showSessionWorkspace(ws.id);
          // Your own agent beside theirs; the workspace is passed in directly,
          // since state has not caught up with it yet.
          await spawnAgentInWorkspace(ws.id, undefined, ws).catch(console.error);
        },
        onDecline: () => {
          void endCopilot(msg.from, msg.from_wid, msg.session_id, []).catch(() =>
            pushNotification({ status: "info", category: "agent", priority: true, text: "Invitation dismissed here, but the sender couldn't be told." }),
          );
        },
      }]);
    }
    if (msg.type === "copilot_accept") {
      setWorkspaces((prev) => prev.map((w) => (w.copilot?.sessionId === msg.session_id ? markCopilotConnected(mergePartnerPanes(w, msg.panes)) : w)));
      pushNotification({ status: "success", category: "agent", priority: false, text: `@${msg.from} joined your co-pilot session` });
      // Send your current agents in case they started before the partner joined.
      setTimeout(() => {
        const ws = workspacesRef.current.find((w) => w.copilot?.sessionId === msg.session_id);
        if (!ws?.copilot) return;
        const mine = ws.panes.filter((p) => !p.streamId).map((p) => ({ id: p.id, label: p.displayName ?? p.kind }));
        syncCopilotLayout(ws.copilot.partnerLogin, ws.copilot.partnerWid, msg.session_id, mine);
      }, 100);
    }
    if (msg.type === "copilot_layout") {
      // A layout also proves the partner is live, so settle any lingering pending.
      setWorkspaces((prev) => prev.map((w) => (w.copilot?.sessionId === msg.session_id ? markCopilotConnected(mergePartnerPanes(w, msg.panes)) : w)));
    }
    if (msg.type === "copilot_end") {
      const wasInSession = workspacesRef.current.some((w) => w.copilot?.sessionId === msg.session_id);
      const ending = workspacesRef.current.find((w) => w.copilot?.sessionId === msg.session_id);
      setWorkspaces((prev) => prev.filter((w) => w.copilot?.sessionId !== msg.session_id));
      if (ending) setFocusedWsId((prev) => (prev === ending.id ? null : prev));
      if (wasInSession) {
        pushNotification({ status: "info", category: "agent", priority: false, text: `@${msg.from} left the co-pilot session` });
      }
    }
  };

  // Dev builds only: the UI harness has no Ably, so it hands session messages
  // in here to show what a friend's request looks like.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as { __flockSessionMsg?: (msg: SessionMsg) => void };
    w.__flockSessionMsg = (msg) => handleSessionMsgRef.current(msg);
    return () => {
      delete w.__flockSessionMsg;
    };
  }, []);

  /** Invite a friend to co-pilot: a shared project with an agent of yours in it. */
  const startCopilot = async (login: string, windowId: string, avatar?: string) => {
    let sessionId: string;
    try {
      sessionId = await inviteCopilot(login, windowId, []);
    } catch (error) {
      pushNotification({ status: "failure", category: "agent", priority: true, text: `Couldn't invite @${login} to co-pilot: ${error instanceof Error ? error.message : error}` });
      return;
    }
    const cws = newCopilotWorkspace(sessionId, login, windowId, avatar);
    setWorkspaces((prev) => [...prev, cws]);
    showSessionWorkspace(cws.id);
    await spawnAgentInWorkspace(cws.id, undefined, cws).catch(console.error);
  };

  /** What you can do with an online friend, from their row's "…". */
  const friendActions = useEventCallback((f: Friend): MenuEntry[] => {
    const wid = f.windowId;
    if (!wid) return [];
    return [
      ...(f.agentCount > 0
        ? [{
            label: "Watch their agent",
            onSelect: () => {
              requestObserve(f.handle, wid);
              pushNotification({ status: "info", category: "agent", priority: true, text: `Asked @${f.handle} to share an agent` });
            },
          } as MenuEntry]
        : []),
      { label: "Co-pilot together", onSelect: () => void startCopilot(f.handle, wid, f.avatarUrl) },
      { label: "Send a task…", onSelect: () => setTaskDialog({ login: f.handle, windowId: wid, avatar: f.avatarUrl }) },
    ];
  });

  // ─── Presence (Ably) ───────────────────────────────────────────────────
  // Which friends are online and how many agents they run, and the same about
  // you to them, once you are signed in with a handle. Ably retries a failed
  // connection on its own every 15–30 s, and while the presence service could
  // not authorise (two months of it; see services/flock-id/PRIVACY.md) that
  // was an endless stream of requests. So a failure gives up, and the next try
  // waits 2, 4, 8, 16, then 30 minutes.
  const [presenceStatus, setPresenceStatus] = useState<PresenceStatus>("connecting");
  const [presenceEpoch, setPresenceEpoch] = useState(0);
  const presenceRetryRef = useRef(0);
  const friendsRef = useRef(friends);
  friendsRef.current = friends;
  const totalAgents = workspaces.reduce((n, w) => n + w.panes.length, 0);
  const totalAgentsRef = useRef(totalAgents);
  totalAgentsRef.current = totalAgents;
  useEffect(() => {
    const myHandle = idProfile?.handle;
    if (!myHandle) {
      disconnectPresence();
      setPresenceStatus("connecting");
      return;
    }
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let stopSessions: (() => void) | undefined;
    const giveUp = () => {
      if (cancelled || retry) return;
      disconnectPresence();
      setPresenceStatus("failed");
      const attempt = ++presenceRetryRef.current;
      retry = setTimeout(() => setPresenceEpoch((e) => e + 1), Math.min(30, 2 ** Math.min(attempt, 5)) * 60_000);
    };
    const handles = [...new Set([myHandle, ...friendsRef.current.map((f) => f.handle)])].filter(Boolean);
    const getToken = async () => {
      const { data } = await supabase().auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("flock ID session expired");
      return token;
    };
    connectPresence(
      getToken,
      handles,
      totalAgentsRef.current,
      (event) => {
        setFriends((prev) =>
          prev.map((f): Friend => {
            if (f.handle !== event.login) return f;
            if (event.kind === "offline") return { ...f, presence: "offline", agentCount: 0, windowId: undefined, lastSeen: Math.floor(Date.now() / 1000) };
            return { ...f, presence: "online", agentCount: event.agentCount, windowId: event.windowId };
          }),
        );
      },
      (status) => {
        if (cancelled) return;
        setPresenceStatus(status);
        if (status === "failed") giveUp();
      },
    )
      .then(() => {
        if (cancelled) return;
        presenceRetryRef.current = 0;
        // Session signalling rides the same connection; routed through the
        // ref so the current handler, with current state, always runs.
        stopSessions = initSessions(myHandle, (msg) => handleSessionMsgRef.current(msg));
      })
      .catch(giveUp);
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
      stopSessions?.();
      disconnectPresence();
    };
  }, [idProfile?.handle, presenceEpoch, setFriends]);

  // Your agent count, to friends, without reconnecting.
  useEffect(() => {
    updateAgentCount(totalAgents).catch(() => {});
  }, [totalAgents]);

  // Who to listen for follows the friend list.
  const friendKey = friends.map((f) => f.handle).sort().join(",");
  useEffect(() => {
    updateFriends(friends.map((f) => f.handle));
    resyncFriendPresence().catch(() => {});
  }, [friendKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const openFriend = useCallback(
    (f: Friend) => {
      closePages();
      setDialog({ kind: "friend-stats", friendId: f.id });
    },
    [closePages],
  );
  const people = useMemo(
    () =>
      idProfile?.id
        ? { friends, myHandle: idProfile.handle ?? null, onAdd: addFriend, onAccept: acceptFriend, onRemove: removeFriend, onOpen: openFriend, actions: friendActions }
        : undefined,
    [idProfile?.id, idProfile?.handle, friends, addFriend, acceptFriend, removeFriend, openFriend, friendActions],
  );
  const sOpenMe = useEventCallback(() => {
    closePages();
    setDialog({ kind: "my-info" });
  });

  const me = useMemo(() => ({
    name: idProfile?.display_name || idProfile?.handle || "You",
    handle: idProfile?.handle ?? null,
    avatarUrl: idProfile?.avatar_url ?? null,
  }), [idProfile]);

  // What the global shortcuts act on, refreshed every render.
  keysRef.current = {
    dialogOpen: dialog.kind !== "none" && !isPageDialog(dialog.kind),
    menuOpen: !!contextMenu,
    paletteOpen: cmdBarOpen,
    run: (action, arg) => {
      const ws = workspacesRef.current.find((w) => w.id === focusedWsIdRef.current);
      const tab = ws ? getFocusedTab(ws) : undefined;
      switch (action) {
        case "palette":
          if (dialog.kind !== "none" && !isPageDialog(dialog.kind)) setDialog({ kind: "none" });
          setCmdBarOpen((v) => !v);
          break;
        case "settings": openSettings(); break;
        case "new-agent": beginNewAgent(); break;
        case "new-project": beginNewWorkspace(); break;
        case "capture": setDialog({ kind: "queue-capture" }); break;
        case "split-right": if (ws && threadOnScreen) void splitPane(ws.id, "horizontal"); break;
        case "split-down": if (ws && threadOnScreen) void splitPane(ws.id, "vertical"); break;
        case "zoom": {
          const target = tab?.zoomedPaneId ?? tab?.focusedPaneId;
          if (ws && target && threadOnScreen) zoomPane(ws.id, target);
          break;
        }
        case "close-agent": if (tab?.focusedPaneId && threadOnScreen) void requestClosePane(tab.focusedPaneId); break;
        case "close-thread": if (ws && tab && threadOnScreen) closeThread(ws.id, tab.id); break;
        case "pane-step": {
          const ids = tab?.layoutTree ? allPaneIds(tab.layoutTree) : [];
          if (ws && ids.length > 1) {
            const cur = tab?.focusedPaneId ? ids.indexOf(tab.focusedPaneId) : -1;
            focusPane(ws.id, ids[(cur + (arg ?? 1) + ids.length) % ids.length]);
          }
          break;
        }
        case "thread-step": stepThread(arg ?? 1); break;
        case "next-waiting": nextWaiting(); break;
        case "sidebar": toggleSidebarCollapsed(); break;
        case "thread-index": {
          const p = projectsRef.current.find((x) => x.id === ws?.id);
          const t = p?.threads[arg ?? 0];
          if (t) openThread(t.workspaceId, t.tabId);
          break;
        }
      }
    },
  };

  // No cockpit without a signed-in flock ID and a claimed handle. Below every
  // hook: nothing may be added between here and the return but JSX.
  if (!idChecked || !idProfile?.handle) {
    return (
      <SignInGate
        checking={!idChecked}
        needsHandle={!!idProfile && !idProfile.handle}
        onReady={() => refreshIdentity({ requireProfile: true })}
      />
    );
  }

  return (
    <div className="v2-app" data-sidebar={effectiveSidebarCollapsed ? "closed" : "open"} onContextMenu={(e) => e.preventDefault()}>
      <Sidebar
        projects={projects}
        currentWorkspaceId={focusedWsId}
        currentTabId={focusedTab?.id ?? null}
        view={
          dialog.kind === "settings" ? "settings"
            : dialog.kind === "pr-hub" ? "prs"
              : showGraphExplorer || showGraphSetup ? "graph"
                : mainView === "new" ? "new" : "thread"
        }
        waiting={waiting.length}
        prCount={ghStatus?.connected ? pullRequests.length : undefined}
        graphEnabled={graphOn}
        me={me}
        meOnline={presenceStatus === "connected" && idProfile?.presence_sharing === true}
        people={people}
        onOpenMe={sOpenMe}
        dark={dark}
        onToggleTheme={sToggleTheme}
        onNewAgent={sNewAgent}
        onOpenThread={sOpenThread}
        onNextWaiting={sNextWaiting}
        onOpenPrs={sOpenPrs}
        onOpenGraph={sOpenGraph}
        onSettings={sOpenSettings}
        onCollapse={sToggleSidebar}
        onRenameThread={sRenameThread}
        threadMenu={sThreadMenu}
        projectMenu={sProjectMenu}
      />

      <main className="v2-main" aria-label="Agent">
        {mainView === "thread" && focusedWs && focusedTab ? (
          <>
            <ThreadHeader
              title={currentThread?.title ?? focusedTab.name}
              project={focusedWs.name}
              branch={threadBranches.branch}
              otherBranches={threadBranches.others}
              kind={focusedPane?.kind}
              sessionId={focusedPane?.sessionId}
              secure={focusedWs.secure}
              race={!!focusedTab.race}
              sidebarHidden={effectiveSidebarCollapsed}
              changesOpen={changesOpen}
              canRename
              onShowSidebar={sShowSidebar}
              onRename={sRenameCurrent}
              onToggleChanges={sToggleChanges}
              onSplit={sSplitRight}
              onCompareRace={sCompareRace}
              menu={sHeaderMenu}
            />
            {focusedTab.layoutTree && isBroadcasting(broadcastKey(focusedWs.id, focusedTab.id)) && allPaneIds(focusedTab.layoutTree).length > 1 && (
              <div className="v2-sync-strip" role="status">
                Typing goes to every agent in this thread.
                <button type="button" className="v2-btn" onClick={() => toggleBroadcast(broadcastKey(focusedWs.id, focusedTab.id))}>
                  Stop
                </button>
              </div>
            )}
            <div className="v2-body">
              <div className="v2-stage">
                <ThreadView
                  key={`${focusedWs.id}:${focusedTab.id}`}
                  workspace={focusedWs}
                  tab={focusedTab}
                  title={currentThread?.title ?? focusedTab.name}
                  poppedOutIds={poppedOutIds}
                  onFocusPane={sFocusPane}
                  onResizeSplit={sResizeSplit}
                  onEvenSplits={sEvenSplits}
                  onSwapPanes={sSwapPanes}
                  onZoomPane={sZoomPane}
                  onClosePane={sClosePane}
                  onPaneContextMenu={sPaneContextMenu}
                  onIntentCaptured={updatePaneIntent}
                  onReveal={onAgentStart}
                  onBringBack={sBringBack}
                />
              </div>
              {changesOpen && focusedWs.repo_path && (
                <aside className="v2-side-panel" aria-label="Changes">
                  <div className="v2-side-panel-head">
                    Changes
                    <button type="button" className="v2-icon-btn" aria-label="Hide changes" onClick={toggleChanges}><XIcon size={14} /></button>
                  </div>
                  <div className="v2-side-panel-body">
                    <ErrorBoundary label="Changes">
                    <GitPanel
                      repoPath={focusedWs.repo_path}
                      workspace={focusedWs}
                      repoMap={repoMaps[focusedWs.id]}
                      overviewPath={focusedPane?.cwd || focusedWs.repo_path}
                      onSelectPane={(paneId) => focusPane(focusedWs.id, paneId)}
                      onAdoptWorktree={(wt) => void adoptWorktree(focusedWs.id, wt)}
                      onPruneWorktree={(wt) => void pruneWorktree(focusedWs.id, wt)}
                      onSendPrompt={sendPromptToPane}
                    />
                    </ErrorBoundary>
                  </div>
                </aside>
              )}
            </div>
          </>
        ) : mainView === "waking" && focusedWs ? (
          <>
            <header className="v2-head" data-tauri-drag-region>
              <h1 className="v2-head-title">{focusedWs.name}</h1>
            </header>
            <div className="v2-body">
              <div className="v2-stage">
                <div className="v2-boot" role="status" style={{ cursor: "default" }}>
                  <span className="v2-boot-line">Starting the agents in {focusedWs.name}…</span>
                  <span className="v2-boot-bar" />
                </div>
              </div>
            </div>
          </>
        ) : (
          <>
            <header className="v2-head" data-tauri-drag-region>
              {effectiveSidebarCollapsed && (
                <button type="button" className="v2-icon-btn" aria-label="Show sidebar" onClick={sShowSidebar}>
                  <PanelLeftIcon size={16} />
                </button>
              )}
              <h1 className="v2-head-title" data-tauri-drag-region>New agent</h1>
              {composing && threadOnScreen && (
                <div className="v2-head-tools">
                  <button type="button" className="v2-btn" onClick={() => setComposing(null)}>Cancel</button>
                </div>
              )}
            </header>
            <div className="v2-body">
              <div className="v2-stage">
                <Composer
                  projects={composerProjects}
                  projectId={composing?.projectId ?? focusedWsId}
                  defaultKind={focusedWs?.agentKind ?? "claude"}
                  onStart={sStart}
                  onPickFolder={sPickFolder}
                  onMoreOptions={sMoreOptions}
                  onCancel={composing && threadOnScreen ? sCancelComposer : undefined}
                />
              </div>
            </div>
          </>
        )}
        {dialog.kind === "settings" && (
          <SettingsDialog
            onClose={() => { setDialog({ kind: "none" }); refreshGh(); refreshVoice(); }}
            onShowSidebar={effectiveSidebarCollapsed ? sShowSidebar : undefined}
            onTestVoiceHud={previewVoiceHud}
            initialTab={dialog.tab as never}
            workspaces={workspaces}
            onSetWorkspaceBudget={setWorkspaceBudget}
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
            onShowSidebar={effectiveSidebarCollapsed ? sShowSidebar : undefined}
          />
        )}
        {dialog.kind === "my-info" && idProfile?.id && (
          <MyInfoModal
            profileId={idProfile.id}
            handle={idProfile.handle ?? ""}
            avatarUrl={idProfile.avatar_url ?? null}
            onSignOut={() => setDialog({ kind: "confirm-signout" })}
            onAccount={() => openSettings("account")}
            onClose={() => setDialog({ kind: "none" })}
            onShowSidebar={effectiveSidebarCollapsed ? sShowSidebar : undefined}
          />
        )}
        {dialog.kind === "friend-stats" &&
          (() => {
            const friend = friends.find((f) => f.id === dialog.friendId);
            return friend ? (
              <FriendStatsModal
                friend={friend}
                onClose={() => setDialog({ kind: "none" })}
                onShowSidebar={effectiveSidebarCollapsed ? sShowSidebar : undefined}
              />
            ) : null;
          })()}
        {showGraphExplorer && (
          <GraphExplorer
            workspaceId={graphExplorerWorkspaceId}
            workspaceName={workspaces.find((workspace) => workspace.id === graphExplorerWorkspaceId)?.name ?? null}
            initialView={graphExplorerView}
            onClose={() => setShowGraphExplorer(false)}
            onShowSidebar={effectiveSidebarCollapsed ? sShowSidebar : undefined}
          />
        )}
        {showGraphSetup && (
          <GraphOnboardingDialog
            onClose={() => setShowGraphSetup(false)}
            onShowSidebar={effectiveSidebarCollapsed ? sShowSidebar : undefined}
          />
        )}
      </main>

      <CommandBar
        open={cmdBarOpen}
        onClose={() => setCmdBarOpen(false)}
        commands={commands}
        promptActions={promptActions}
      />

      {voiceHud && <VoiceOverlay {...voiceHud} level={voiceLevel} onDismiss={dismissVoiceError} />}

      <Toasts toasts={toasts} onDismiss={dismissToast} />
      {/* A friend asking to watch, a co-pilot invite, a task: these wait for an
          answer (45 s), so they stand apart from the passing notes. */}
      {sessionToasts.length > 0 && (
        <SessionToasts toasts={sessionToasts} onDismiss={(id) => setSessionToasts((prev) => prev.filter((t) => t.id !== id))} />
      )}
      {taskDialog && (
        <TaskDialog
          toLogin={taskDialog.login}
          toAvatar={taskDialog.avatar}
          onSend={(prompt) => {
            sendTask(taskDialog.login, taskDialog.windowId, prompt);
            pushNotification({ status: "info", category: "agent", priority: true, text: `Task sent to @${taskDialog.login}` });
            setTaskDialog(null);
          }}
          onClose={() => setTaskDialog(null)}
        />
      )}

      <UpdateBanner />

      {dialog.kind === "new-workspace" && (
        <NewWorkspaceDialog
          cwd={cwd}
          onConfirm={(launch) => void onNewWorkspaceConfirmed(launch)}
          onCancel={() => setDialog({ kind: "none" })}
        />
      )}
      {dialog.kind === "spawn-layout" && (() => {
        const ws = workspaces.find((w) => w.id === dialog.workspaceId);
        return (
          <SpawnLayoutDialog
            defaultKind={ws?.agentKind ?? "claude"}
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
      {dialog.kind === "rename-workspace" && (
        <RenameDialog
          title="Rename project"
          initial={dialog.current}
          onConfirm={(name) => onRenameConfirmed(dialog.workspaceId, name)}
          onCancel={() => setDialog({ kind: "none" })}
        />
      )}
      {dialog.kind === "confirm-close" && (
        <ConfirmDialog
          title={dialog.mode === "copilot" ? "End the co-pilot session?" : dialog.mode === "observe" ? "Stop watching?" : "Remove project?"}
          message={
            dialog.mode === "copilot" ? (
              <>Your agents in <strong>{dialog.name}</strong> stop, and your partner stops seeing them.</>
            ) : dialog.mode === "observe" ? (
              <>You stop seeing <strong>{dialog.name.replace(/^watching /, "")}</strong>'s agent. Nothing changes on their side.</>
            ) : (
              <>This removes <strong>{dialog.name}</strong> from flock and stops its running agents. Your files stay where they are.</>
            )
          }
          confirmLabel={dialog.mode === "copilot" ? "End session" : dialog.mode === "observe" ? "Stop watching" : "Remove project"}
          danger
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
          title="Close this thread?"
          message={
            <>
              Closing <strong>{dialog.tabName}</strong> stops{" "}
              {dialog.agentCount === 1 ? "its agent" : `its ${dialog.agentCount} agents`}. This can't be undone.
            </>
          }
          confirmLabel="Close thread"
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
          message={<>This signs you out of your flock ID{idProfile?.handle ? <> (<strong>@{idProfile.handle}</strong>)</> : null}. Agents keep running.</>}
          confirmLabel="Sign out"
          danger
          onConfirm={() => {
            setDialog({ kind: "none" });
            signOut().catch(console.error);
          }}
          onCancel={() => setDialog({ kind: "none" })}
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

// Estimate PTY dimensions so the agent starts rendering at approximately the
// right size: the window minus v2's chrome (the frame, the sidebar, the
// thread's header, a tiled agent's own bar) at SF Mono 13px cell metrics
// (7.8×15.6 px). The first fit corrects whatever this gets wrong.
function estimatePtyDims(gridRows: number, gridCols: number): { ptyCols: number; ptyRows: number } {
  const frame = 10;          // gap around and between the panels
  const sidebarW = 264;
  const headH = 46;          // the thread's header
  const tiledBarH = gridRows * gridCols > 1 ? 30 : 0;
  const padW = 16;           // pane body padding, left + right
  const padH = 10;           // and top + bottom
  const cellW = 7.8;
  const cellH = 15.6;
  const paneW = (window.innerWidth - sidebarW - frame * 3) / gridCols - padW;
  const paneH = (window.innerHeight - frame * 2 - headH) / gridRows - tiledBarH - padH;
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
