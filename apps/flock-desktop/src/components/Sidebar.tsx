import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Friend, PullRequest, Workspace } from "../types";
import type { MergeQueueItem, QueueItem, RepoMap, WorktreeStatus } from "../lib/tauri";
import GitPanel from "./GitPanel";
import GooseMark from "./GooseMark";
import Wordmark from "./Wordmark";
import WorkingBlocks from "./WorkingBlocks";
// `import type`, not `import { type ... }` — the first form is erased outright,
// the second still emits a module reference under some emit settings, and this
// import existing at runtime is exactly what kept presence in the startup chunk.
import type { PresenceStatus } from "../lib/presence";
import { MY_WINDOW_ID } from "../lib/windowId";
import { groupByProject } from "../lib/projectGrouping";
import { FriendsIcon, HomeIcon } from "./railIcons";
import { inviteMailto, sendInviteEmail, type AddFriendResult } from "../lib/flockId";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CheckIcon, ChevronDownIcon, CopilotIcon, EyeIcon, SearchIcon, SendIcon, UserMinusIcon, XIcon } from "./friendIcons";
import AgentKindBadge from "./AgentKindBadge";
import { Avatar } from "./Avatar";
import IconButton from "./IconButton";
import { PanelLeftIcon, PopOutIcon } from "./paneIcons";
import {
  BlockedIcon, BringBackIcon, RefreshIcon, ReviewIcon, WarningIcon,
} from "./statusIcons";
import { BranchIcon } from "./settingsIcons";
import { allPaneIds } from "../lib/layout";
import { onActivateKey } from "../lib/a11y";
import { useFloatingTip } from "../lib/floatingTip";
import { getFocusedTab } from "../lib/tabs";
import QuickActions from "./QuickActions";
import GraphSidebarCard from "./GraphSidebarCard";
import MoatReadout from "./MoatReadout";
import CollapsibleSection from "./CollapsibleSection";
import { loadDocks, saveDocks, moveSection, reorderSide, type Docks, type DockSide } from "../lib/dockStore";

type SidebarTab = "workspaces" | "friends";

/** Which sections can be sent to the right rail. The graph card isn't a
 *  foldable section (and renders nothing when the graph isn't opted in), so it
 *  stays pinned to the left rather than offering a move it can't honour. */
const MOVABLE = new Set(["agents", "git", "prs", "merge-queue", "queue"]);

interface Props {
  collapsed: boolean;
  /** Collapse the rail. The expand half of the pair stays in the pane header,
   *  because this one goes with the rail when it closes. */
  onToggleSidebar: () => void;
  /** Which tab is showing. Lifted to App so co-pilot invites can switch back to
   * Home and reveal the new shared workspace. */
  activeTab: SidebarTab;
  onTabChange: (tab: SidebarTab) => void;
  /** Reports whether any section is docked on the right rail, so App can show
   * the pane-header's right-panel toggle only when there's something to hide. */
  onRightRailPopulated: (has: boolean) => void;
  workspaces: Workspace[];
  focusedWsId: string | null;
  onSelectWs: (id: string) => void;
  onNewWorkspace: () => void;
  onCloseWorkspace: (id: string) => void;
  onWorkspaceContextMenu: (workspaceId: string, e: React.MouseEvent) => void;
  onReorderWorkspaces: (fromIndex: number, toIndex: number) => void;
  onSelectPane: (workspaceId: string, paneId: string) => void;
  onBringBackPane: (paneId: string) => void;
  onResetIntent: (paneId: string) => void;
  onSettings: (tab?: string) => void;
  /** Live git snapshot per workspace id — drives the Git panel's agent table
   * and orphaned-worktree list. */
  repoMaps: Record<string, RepoMap>;
  onAdoptWorktree: (workspaceId: string, wt: WorktreeStatus) => void;
  onPruneWorktree: (workspaceId: string, wt: WorktreeStatus) => void;
  /** Paste text into a pane's input line without submitting — the git panel's
   * diff viewer uses it to hand a review's inline notes to the agent. */
  onSendPrompt: (paneId: string, text: string) => void;
  githubConnected: boolean;
  ghUser: string | null;
  pullRequests: PullRequest[];
  /** Why the PR list couldn't be fetched, if the last poll failed. */
  prError: string | null;
  /** Number of the PR currently being checked out + reviewed, if any. */
  reviewingPr: number | null;
  onReviewAll: () => void;
  /** Open the Pull Requests manager modal, optionally focused on one PR. */
  onOpenPrManager: (pr?: PullRequest) => void;
  /** The merge queue, in order — glance rows only; management lives in the
   * Merge Queue modal. */
  mergeQueue: MergeQueueItem[];
  onOpenMergeQueue: () => void;
  friends: Friend[];
  idSignedIn: boolean;
  idHandle: string | null;
  idDisplayName: string | null;
  idAvatarUrl: string | null;
  /** Health of our own Ably presence connection, shown as a light on the avatar. */
  presenceStatus: PresenceStatus;
  onAddFriend: (input: string) => Promise<AddFriendResult>;
  onAcceptFriend: (profileId: string) => Promise<void>;
  onRemoveFriend: (profileId: string) => Promise<void>;
  onRequestObserve: (login: string, windowId: string) => void;
  onSendTask: (login: string, windowId: string, avatar?: string) => void;
  onCopilot: (login: string, windowId: string, avatar?: string) => void;
  onOpenFriend: (friend: Friend) => void;
  onOpenMyInfo: () => void;
  /** Personal prompt queue (queued + launched history), newest handled first. */
  queueItems: QueueItem[];
  onOpenQueueCapture: () => void;
  onQueueLaunch: (item: QueueItem, e: React.MouseEvent) => void;
  onQueueEdit: (id: string, text: string) => void;
  onQueueDelete: (id: string) => void;
}

/** Hover text for the presence light on the profile avatar. */
const PRESENCE_TITLE: Record<PresenceStatus, string> = {
  connected: "Presence connected — friends can see you online",
  connecting: "Connecting to presence…",
  failed: "Presence offline — couldn't reach the presence service (check sign-in / connection)",
};

/** A persisted set of folded group names. Two group kinds in this rail fold
 *  the same way, so they share the mechanism rather than each growing their
 *  own copy of it. */
function useCollapsedSet(storageKey: string): [Set<string>, (name: string) => void] {
  const [set, setSet] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      return new Set<string>(raw ? JSON.parse(raw) : []);
    } catch {
      return new Set<string>();
    }
  });
  const toggle = useCallback(
    (name: string) => {
      setSet((prev) => {
        const next = new Set(prev);
        if (next.has(name)) next.delete(name);
        else next.add(name);
        try {
          localStorage.setItem(storageKey, JSON.stringify([...next]));
        } catch {
          /* a full or disabled store must not take the rail down with it */
        }
        return next;
      });
    },
    [storageKey],
  );
  return [set, toggle];
}

export default function Sidebar({
  collapsed,
  onToggleSidebar,
  activeTab: tab,
  onTabChange: setTab,
  onRightRailPopulated,
  workspaces,
  focusedWsId,
  onSelectWs,
  onNewWorkspace,
  onCloseWorkspace,
  onWorkspaceContextMenu,
  onReorderWorkspaces,
  onSelectPane,
  onBringBackPane,
  onResetIntent,
  onSettings,
  repoMaps,
  onAdoptWorktree,
  onPruneWorktree,
  onSendPrompt,
  githubConnected,
  ghUser,
  pullRequests,
  prError,
  reviewingPr,
  onReviewAll,
  onOpenPrManager,
  mergeQueue,
  onOpenMergeQueue,
  friends,
  idSignedIn,
  idHandle,
  idDisplayName,
  idAvatarUrl,
  presenceStatus,
  onAddFriend,
  onAcceptFriend,
  onRemoveFriend,
  onRequestObserve,
  onSendTask,
  onCopilot,
  onOpenFriend,
  onOpenMyInfo,
  queueItems,
  onOpenQueueCapture,
  onQueueLaunch,
  onQueueEdit,
  onQueueDelete,
}: Props) {
  // Drag-and-drop reorder — both indices are into the visible slice, which
  // starts at array index 0, so they double as indices into `workspaces`.
  //
  // This is pointer-capture based, not the native HTML5 drag-and-drop API:
  // that API needs `dataTransfer` populated on dragstart to be treated as a
  // "real" drag inside Tauri's WKWebView, and even with that it never
  // reliably fired dragenter/drop on sibling cards here. Pointer events are
  // the same technique already proven for the pane-split gutters in
  // PaneArea.tsx — a card starts "dragging" once the pointer moves past a
  // small threshold (so a plain click still selects the workspace), and
  // while captured, `document.elementFromPoint` finds whichever card is
  // currently under the cursor (captured pointers don't fire hover/enter
  // events on other elements, so this is the only reliable way to know).
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  // Mirrors of the two above. The state drives what the cards look like; these
  // are what the drag callbacks read, so those callbacks can hold an empty
  // dependency list and keep one identity for the life of the rail (see the
  // handler note below). Written together with the state, never separately.
  const dragIndexRef = useRef<number | null>(null);
  const dragOverIndexRef = useRef<number | null>(null);
  const setDrag = useCallback((i: number | null) => { dragIndexRef.current = i; setDragIndex(i); }, []);
  const setDragOver = useCallback((i: number | null) => { dragOverIndexRef.current = i; setDragOverIndex(i); }, []);

  // Which groups are folded, for the two kinds of group in this rail.
  // localStorage rather than the workspace blob: a fold is a property of this
  // window's rail, not of any workspace, and it has to survive a relaunch that
  // respawns every pane with a fresh id.
  const [collapsedProjects, toggleProject] = useCollapsedSet("flock:collapsed-projects");
  const [collapsedAgentGroups, toggleAgentGroup] = useCollapsedSet("flock:collapsed-agent-groups");
  const projectGroups = groupByProject(workspaces);

  // Stable identities for everything <WorkspaceCard> is handed, so memoizing it
  // (below) actually skips anything. App rebuilds these handlers every render —
  // they close over its render-scope state deliberately — so they can't be
  // passed straight through, and freezing a copy would be the stale-closure bug
  // that memo(PaneArea) hit with openPaneMenu. Bouncing through a ref gives the
  // card a callback that never changes identity but always calls App's current
  // instance, which is both halves of what's needed.
  const handlersRef = useRef({ onSelectWs, onWorkspaceContextMenu, onCloseWorkspace, onReorderWorkspaces });
  handlersRef.current = { onSelectWs, onWorkspaceContextMenu, onCloseWorkspace, onReorderWorkspaces };
  const selectWs = useCallback((id: string) => handlersRef.current.onSelectWs(id), []);
  const contextMenuWs = useCallback(
    (id: string, e: React.MouseEvent) => handlersRef.current.onWorkspaceContextMenu(id, e),
    [],
  );
  const closeWs = useCallback((id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    handlersRef.current.onCloseWorkspace(id);
  }, []);
  const startWsDrag = useCallback((index: number) => {
    setDrag(index);
    setDragOver(index);
  }, [setDrag, setDragOver]);

  const handleDragMove = useCallback((clientX: number, clientY: number) => {
    const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    const card = el?.closest<HTMLElement>("[data-ws-card-index]");
    if (!card) return;
    const idx = Number(card.dataset.wsCardIndex);
    if (!Number.isNaN(idx)) setDragOver(idx);
  }, [setDragOver]);
  const handleDragFinish = useCallback(() => {
    const from = dragIndexRef.current;
    const to = dragOverIndexRef.current;
    if (from !== null && to !== null && from !== to) {
      handlersRef.current.onReorderWorkspaces(from, to);
    }
    setDrag(null);
    setDragOver(null);
  }, [setDrag, setDragOver]);

  // Where each section is docked (left rail / right rail) and its order within
  // that rail. Reorder-by-drag lives in <SectionRail>; this owns placement so
  // both rails render from one source of truth.
  const [docks, setDocks] = useState<Docks>(loadDocks);
  const persistDocks = (next: Docks) => { setDocks(next); saveDocks(next); };
  const toggleDock = (id: string) => {
    const to: DockSide = docks.right.includes(id) ? "left" : "right";
    persistDocks(moveSection(docks, id, to));
  };
  const reorder = (side: DockSide, from: number, to: number) => {
    persistDocks(reorderSide(docks, side, from, to));
  };
  // Header move-button props for a movable section; nothing for pinned ones.
  const dockProps = (id: string) =>
    MOVABLE.has(id)
      ? { dockSide: (docks.right.includes(id) ? "right" : "left") as DockSide, onToggleDock: () => toggleDock(id) }
      : {};
  // Portal target for the right rail — an <aside> App renders as the last
  // child of .app-main. Resolved after mount so the node exists.
  const [rightRoot, setRightRoot] = useState<HTMLElement | null>(null);
  useEffect(() => { setRightRoot(document.getElementById("flock-right-rail")); }, []);

  // The right rail's manual collapse is owned by App now (it renders the
  // <aside> and the pane-header toggle); here we just report whether anything
  // is docked over there so App knows whether to offer the toggle at all.
  useEffect(() => {
    onRightRailPopulated(docks.right.length > 0);
  }, [docks.right.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const focusedWs = workspaces.find((w) => w.id === focusedWsId);
  const wsWithAgents = focusedWs && focusedWs.panes.length > 0 ? [focusedWs] : [];
  // Never count yourself — App seeds a self entry (so a second window of your
  // own is visible), but the tab badge is about *other people* being online.
  const realFriends = friends.filter((f) => f.handle !== idHandle && f.windowId !== MY_WINDOW_ID);
  const onlineFriends = realFriends.filter((f) => f.friendStatus === "accepted" && f.presence === "online");
  const onlineCount = onlineFriends.length;
  const pendingInCount = realFriends.filter((f) => f.friendStatus === "pending_in").length;
  const queuedCount = queueItems.filter((i) => i.status === "queued").length;

  // The focused-workspace sections, keyed by id and rendered in the user's
  // stored order. Default order is glance frequency: agents (live, watched
  // constantly), git and PRs (the two repo surfaces, adjacent), then the
  // graph (ambient memory) — but the user drags them into whatever reads
  // best for them.
  const sections: Record<string, ReactNode> = {
    agents: (
      <CollapsibleSection
        id="agents"
        title={<>Agents{focusedWs && focusedWs.panes.length > 0 && <span className="count"> {focusedWs.panes.length}</span>}</>}
        {...dockProps("agents")}
      >
        {wsWithAgents.length === 0 ? (
          <div className="empty-state">{focusedWs ? "no agents running" : "select a workspace"}</div>
        ) : (
          wsWithAgents.map((ws) => {
            const inGrid = new Set(ws.tabs.flatMap((t) => t.layoutTree ? allPaneIds(t.layoutTree) : []));
            const focusedPaneId = getFocusedTab(ws).focusedPaneId;
            // A group header separates this workspace's agents from another
            // workspace's. With one workspace there is nothing to separate: the
            // header repeats the name on the card directly above it, costs a
            // row and an indent level, and adds a third disclosure triangle to
            // a rail that already has two. So it appears only once it has a job.
            const grouped = wsWithAgents.length > 1;
            const shut = grouped && collapsedAgentGroups.has(ws.id);
            return (
            <div className="agent-group" key={ws.id} style={{ ["--accent" as never]: ws.accentColor }}>
              {grouped && (
              <button
                type="button"
                className={`rail-group-head${shut ? " collapsed" : ""}`}
                onClick={() => toggleAgentGroup(ws.id)}
                aria-expanded={!shut}
              >
                {/* The class goes on a span, never the svg itself: the svg is a
                    replaced element, so `top: 0; bottom: 0` cannot stretch it and
                    the browser drops `bottom` — pinning the glyph to the top of
                    the header instead of centring it. The span stretches, and the
                    flex centring in .rail-group-chevron does the rest. */}
                <span className="rail-group-chevron">
                  <svg width="10" height="10" viewBox="0 0 24 24"
                    fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"
                    strokeLinejoin="round" aria-hidden="true">
                    <path d="M8 5l8 7-8 7" />
                  </svg>
                </span>
                <span className="rail-group-name">{ws.name}</span>
                <span className="rail-group-count">{ws.panes.length}</span>
              </button>
              )}
              {/* `shut` is false whenever the header is gone, so closing every
                  other workspace can never leave these rows hidden behind a
                  control that no longer exists. */}
              {!shut && ws.panes.map((p) => {
                const poppedOut = !inGrid.has(p.id);
                const sc = statusClass(p.status);
                return (
                <div
                  className={`agent-row${p.id === focusedPaneId ? " active" : ""}${poppedOut ? "" : ` s-${sc}`}`}
                  key={p.id}
                  onClick={() => onSelectPane(ws.id, p.id)}
                  onKeyDown={onActivateKey(() => onSelectPane(ws.id, p.id))}
                  role="button"
                  tabIndex={0}
                  aria-current={p.id === focusedPaneId || undefined}
                >
                  {/* The logo is the row's gutter, not an item on its first line:
                      it sits in its own column and centres against BOTH lines,
                      the way an avatar does in Mail or Messages. Everything that
                      is text lives in .agent-row-main beside it, which is what
                      lets the two lines share a left edge without either of them
                      having to compensate for the logo's width. */}
                  <AgentKindBadge kind={p.kind} className="kind" iconOnly size={18} />
                  <div className="agent-row-main">
                  <div className="agent-row-line">
                  {p.displayName && (
                    <span className="agent-name">{p.displayName}</span>
                  )}
                  {poppedOut ? (
                    <>
                      <span className="agent-popped-badge" title="Popped out into its own window"><PopOutIcon size={10} /> popped out</span>
                      <span
                        className="agent-bring-back-btn"
                        title="Bring back into this workspace"
                        role="button"
                        tabIndex={0}
                        onClick={(e) => { e.stopPropagation(); onBringBackPane(p.id); }}
                        onKeyDown={(e) => { e.stopPropagation(); onActivateKey(() => onBringBackPane(p.id))(e); }}
                      >
                        <BringBackIcon size={11} /> bring back
                      </span>
                    </>
                  ) : (
                    <AgentStatusChip status={p.status} />
                  )}
                  </div>
                  {/* The intent line is always rendered, even with nothing to
                      say yet: dropping it for agents whose prompt hasn't been
                      sniffed made those rows half the height of their siblings
                      and broke the list's rhythm. The placeholder keeps every
                      agent one two-line block and is honest about the gap. */}
                  <span className="agent-intent">
                    {p.intent ? (
                      <AgentIntentText intent={p.intent} full={p.intentRaw ?? p.intent} />
                    ) : (
                      <span className="agent-intent-text agent-intent-empty">no task yet</span>
                    )}
                    {p.model && (
                      <span className="agent-model-chip" title={`Model: ${p.model} (set via /model)`}>{p.model}</span>
                    )}
                    {p.intent && (
                      <span
                        className="agent-intent-reset"
                        title="Reset — re-capture from the next prompt"
                        role="button"
                        tabIndex={0}
                        onClick={(e) => { e.stopPropagation(); onResetIntent(p.id); }}
                        onKeyDown={(e) => { e.stopPropagation(); onActivateKey(() => onResetIntent(p.id))(e); }}
                      >
                        <RefreshIcon size={10} />
                      </span>
                    )}
                    {/* Last, so it lands on the row's right edge directly under
                        the status mark. Suppressed for a popped-out pane, which
                        shows its own badges instead of a status. */}
                    {!poppedOut && <AgentStatusTime since={p.statusChangedAt} />}
                  </span>
                  </div>
                </div>
                );
              })}
            </div>
            );
          })
        )}
      </CollapsibleSection>
    ),
    git: (
      <CollapsibleSection id="git" title="Git" defaultOpen={false} {...dockProps("git")}>
        {focusedWs && !focusedWs.copilot && !focusedWs.observe ? (
          <GitPanel
            repoPath={focusedWs.repo_path}
            workspace={focusedWs}
            repoMap={repoMaps[focusedWs.id]}
            // Status + commits follow the focused agent's checkout, so
            // clicking an agent shows that agent's branch history —
            // falling back to the main checkout with no pane focused.
            overviewPath={
              focusedWs.panes.find((p) => p.id === getFocusedTab(focusedWs).focusedPaneId)?.cwd ||
              focusedWs.repo_path
            }
            onSelectPane={(paneId) => onSelectPane(focusedWs.id, paneId)}
            onAdoptWorktree={(wt) => onAdoptWorktree(focusedWs.id, wt)}
            onPruneWorktree={(wt) => onPruneWorktree(focusedWs.id, wt)}
            onSendPrompt={onSendPrompt}
          />
        ) : (
          <div className="empty-state">{focusedWs ? "no repo for this session" : "select a workspace"}</div>
        )}
      </CollapsibleSection>
    ),
    prs: (
      <CollapsibleSection
        id="prs"
        title={<>Pull Requests{pullRequests.length > 0 && <span className="count"> {pullRequests.length}</span>}</>}
        {...dockProps("prs")}
        actions={
          // Icon-only buttons with tooltips. The manager is a review /
          // management surface for existing PRs (there's no create-PR
          // flow), so it always uses the "open external" glyph — never a
          // "+", which reads as *create*. The review-all control only
          // appears once there's something to review.
          githubConnected && (
            <>
              {pullRequests.length > 0 && (
                <IconButton className="add-btn ghost" icon={<ReviewIcon size={13} />} label="Review all pull requests" onClick={onReviewAll} />
              )}
              <IconButton className="add-btn ghost" icon={<PopOutIcon size={13} />} label="Manage PRs" onClick={() => onOpenPrManager()} />
            </>
          )
        }
      >
        {!githubConnected ? (
          <div className="empty-state">
            <BlockedIcon size={12} /> GitHub not connected
            <br />
            <span
              style={{ color: "var(--text-ghost)", cursor: "pointer" }}
              onClick={() => onSettings("github")}
              onKeyDown={onActivateKey(() => onSettings("github"))}
              role="button"
              tabIndex={0}
            >
              connect in settings →
            </span>
          </div>
        ) : prError && pullRequests.length === 0 ? (
          <div className="empty-state pr-error-state" title={prError}>
            <WarningIcon size={12} /> couldn't load PRs
            <br />
            <span className="pr-error-detail">{shortPrError(prError)}</span>
          </div>
        ) : pullRequests.length === 0 ? (
          <div className="empty-state">
            No open PRs{focusedWs ? "" : " — select a workspace"}
          </div>
        ) : (
          <div className="pr-list">
            {pullRequests.map((pr) => (
              <div
                className="pr-row"
                key={`${pr.repo}#${pr.number}`}
                onClick={() => onOpenPrManager(pr)}
                onKeyDown={onActivateKey(() => onOpenPrManager(pr))}
                role="button"
                tabIndex={0}
                style={{ cursor: "pointer" }}
              >
                <span className="pr-number">#{pr.number}</span>
                <div className="pr-row-content">
                  <span className="pr-title">{pr.title}</span>
                  <span className="pr-repo">@{pr.author}</span>
                </div>
                <button
                  type="button"
                  className={`pr-review-btn${reviewingPr === pr.number ? " loading" : ""}`}
                  title={
                    reviewingPr === pr.number
                      ? "Checking out branch and starting agent…"
                      : `Open PR #${pr.number} in the pull-request manager`
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenPrManager(pr);
                  }}
                >
                  {reviewingPr === pr.number
                    ? <span className="pr-review-spinner" />
                    : <><ReviewIcon size={11} /> review</>}
                </button>
              </div>
            ))}
          </div>
        )}
      </CollapsibleSection>
    ),
    "merge-queue": (
      <CollapsibleSection
        id="merge-queue"
        title={<>Merge Queue{mergeQueue.length > 0 && <span className="count"> {mergeQueue.length}</span>}</>}
        defaultOpen={false}
        {...dockProps("merge-queue")}
        actions={
          <IconButton className="add-btn ghost" icon={<PopOutIcon size={13} />} label="Manage merge queue" onClick={onOpenMergeQueue} />
        }
      >
        {mergeQueue.length === 0 ? (
          <div className="empty-state">no queued merges — queue one from the PR manager</div>
        ) : (
          <div className="merge-queue-list merge-queue-glance mq-sidebar-list">
            {mergeQueue.map((item) => (
              <div
                className="merge-queue-item"
                key={`${item.repo}#${item.number}`}
                role="button"
                tabIndex={0}
                title={item.note ?? `${item.repo}#${item.number} — ${item.title}`}
                onClick={onOpenMergeQueue}
                onKeyDown={onActivateKey(onOpenMergeQueue)}
              >
                <span className="mq-pos">{item.position + 1}</span>
                <span className="mq-ref">{item.repo}#{item.number}</span>
                <span className={`mq-chip mq-${item.status}`}>
                  {item.status.replace("_", " ")}
                </span>
              </div>
            ))}
          </div>
        )}
      </CollapsibleSection>
    ),
    // Renders nothing unless the flock Graph is opted in.
    graph: <GraphSidebarCard workspaceId={focusedWsId} />,
    queue: (
      <CollapsibleSection
        id="queue"
        title={<>Prompt Queue{queuedCount > 0 && <span className="count"> {queuedCount}</span>}</>}
        {...dockProps("queue")}
        actions={
          <IconButton className="add-btn ghost" icon="+" label="Capture a prompt" onClick={onOpenQueueCapture} />
        }
      >
        <QueueList
          queueItems={queueItems}
          onLaunch={onQueueLaunch}
          onEdit={onQueueEdit}
          onDelete={onQueueDelete}
        />
      </CollapsibleSection>
    ),
  };

  return (
    <>
    <aside
      className={`sidebar${collapsed ? " sidebar-collapsed" : ""}`}
      style={{ ["--accent" as never]: focusedWs?.accentColor ?? "var(--mint)" }}
    >
      {!collapsed && (
        <>
      <div className="brand">
        <div className="brand-lockup">
          {/* The bird, back in the lockup. It stood here until 2026-07-29 and
              was taken out on the argument that two symbols sharing no visual
              language — pixel art on a ten-unit grid beside a geometric sans —
              read as two companies co-branding, and that the persistent
              lockup is where that shows most.

              LEADING, not trailing. Trailing was tried on 2026-08-16 and put
              back the same day: the bird is the first thing in the rail and
              the word reads off it, which is not what a swap preserves.

              36 IS NOT A TASTE. The sprite is 36 cells wide, so that width is
              the one that puts exactly one device pixel per cell; 44 and 30
              were both tried in the running app and both resample, which
              stair-steps the wing and mushes the eye. The next clean size up
              is 72, which is a third of the rail. So this number is arithmetic
              and the only thing to argue about is whether the bird is here. */}
          <span className="brand-goose"><GooseMark width={36} /></span>
          {/* On the rail's own surface, carrying its own crest in the l. The
              row's colour is three pixels of it under the active tab instead,
              which is the only way the mark and the wave can both be here. */}
          <Wordmark size={26} />
          {/* The rail's own collapse control, held against the far edge so the
              logotype keeps the near one. Its expand twin stays in the pane
              header: this one is inside the thing it hides, so it cannot be
              what brings it back. */}
          <IconButton
            className="brand-collapse"
            icon={<PanelLeftIcon filled />}
            label="Hide sidebar"
            onClick={onToggleSidebar}
          />
        </div>
      </div>

      {/* ─── Tab bar ─────────────────────────────────────────────────── */}
      <div className="sidebar-tabs">
        {/* "Home", not "Workspaces": this tab holds the whole work surface
            (switcher + git + agents + PRs + graph), and naming it after just
            one of those made the tab and the first section header read as
            the same thing twice. */}
        <button
          className={`sidebar-tab${tab === "workspaces" ? " active" : ""}`}
          onClick={() => setTab("workspaces")}
        >
          <HomeIcon />
          Home
        </button>
        <button
          className={`sidebar-tab${tab === "friends" ? " active" : ""}`}
          onClick={() => setTab("friends")}
        >
          <FriendsIcon />
          Friends
          {pendingInCount > 0 ? (
            <span className="tab-request-badge" title={`${pendingInCount} friend request${pendingInCount === 1 ? "" : "s"}`}>{pendingInCount}</span>
          ) : onlineCount > 0 ? (
            <span className="tab-online-badge">{onlineCount}</span>
          ) : null}
        </button>
      </div>

      {/* ─── Tab content ─────────────────────────────────────────────── */}
      <div className="sidebar-list">
        {tab === "workspaces" ? (
          <>
            {/* The switcher stays pinned on top — it decides what every
                section below shows — but folds like any other section. */}
            <CollapsibleSection
              id="workspaces"
              title={<>Workspaces{workspaces.length > 0 && <span className="count"> {workspaces.length}</span>}</>}
            >
              <div className="ws-card-list">
                {/* Grouped by project — see lib/projectGrouping.ts for what a
                    project is and why it is derived rather than configured.
                    With nothing to group this returns one unnamed bucket, so
                    the list renders exactly as it did before grouping existed.
                    `index` stays the position in the ORIGINAL array, because
                    that is what the drag handlers reorder by. */}
                {projectGroups.map((group) => (
                  <div className="ws-group" key={group.project ?? "\u0000ungrouped"}>
                    {group.project && projectGroups.length > 1 && (
                      <button
                        type="button"
                        className={`rail-group-head${collapsedProjects.has(group.project) ? " collapsed" : ""}`}
                        onClick={() => toggleProject(group.project!)}
                        aria-expanded={!collapsedProjects.has(group.project)}
                      >
                        {/* Span wrapper for the same reason as the agent-group
                            chevron above: a bare svg cannot stretch to the header
                            and lands at its top. */}
                        <span className="rail-group-chevron">
                          <svg width="10" height="10" viewBox="0 0 24 24"
                            fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"
                            strokeLinejoin="round" aria-hidden="true">
                            <path d="M8 5l8 7-8 7" />
                          </svg>
                        </span>
                        <span className="rail-group-name">{group.project}</span>
                        <span className="rail-group-count">{group.items.length}</span>
                      </button>
                    )}
                    {/* Same rule as the agent groups: one project is not a
                        grouping, so it draws no header, and with no header the
                        collapsed flag must not apply. */}
                    {!(group.project && projectGroups.length > 1 && collapsedProjects.has(group.project)) &&
                      group.items.map(({ ws, index: i }) => (
                        <WorkspaceCard
                          key={ws.id}
                          ws={ws}
                          repoMap={repoMaps[ws.id]}
                          index={i}
                          focused={ws.id === focusedWsId}
                          onSelect={selectWs}
                          onContextMenu={contextMenuWs}
                          onClose={closeWs}
                          dragging={dragIndex === i}
                          draggedOver={dragOverIndex === i && dragIndex !== i}
                          onDragStart={startWsDrag}
                          onDragMove={handleDragMove}
                          onDragEnd={handleDragFinish}
                        />
                      ))}
                  </div>
                ))}
                {/* Always-visible, labeled create affordance at the end of
                    the list — doubles as the empty state's call to action. */}
                <button className="ws-new-row" onClick={onNewWorkspace}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                  New workspace
                </button>
              </div>
            </CollapsibleSection>

            <SectionRail
              side="left"
              ids={docks.left}
              sections={sections}
              onReorder={(from, to) => reorder("left", from, to)}
            />
          </>
        ) : (
          <FriendsPanel friends={friends} idSignedIn={idSignedIn} idHandle={idHandle} onAddFriend={onAddFriend} onAcceptFriend={onAcceptFriend} onRemoveFriend={onRemoveFriend} onSettings={onSettings} onRequestObserve={onRequestObserve} onSendTask={onSendTask} onCopilot={onCopilot} onOpenFriend={onOpenFriend} />
        )}
      </div>

      <QuickActions
        onSettings={onSettings}
        onNewWorkspace={onNewWorkspace}
        onOpenPrManager={() => onOpenPrManager()}
        githubConnected={githubConnected}
        prCount={pullRequests.length}
      />

      <MoatReadout />

      {/* ─── Profile footer — the flock ID identity (the gate guarantees
           one exists), with GitHub shown as a connection status. The row itself
           opens your usage stats (the natural "tap my profile" expectation);
           the gear is the only thing that opens Settings. ────────────────── */}
      <div
        className="profile-footer"
        onClick={() => onOpenMyInfo()}
        onKeyDown={onActivateKey(() => onOpenMyInfo())}
        role="button"
        tabIndex={0}
        style={{ cursor: "pointer" }}
        title="Your usage stats"
      >
        <div className="avatar-wrap">
          <button
            type="button"
            className="avatar-button"
            title="Your usage stats"
            onClick={(e) => { e.stopPropagation(); onOpenMyInfo(); }}
          >
            <Avatar
              url={idAvatarUrl}
              seed={idDisplayName ?? idHandle}
              imgClassName="avatar-img"
              fallbackClassName="avatar"
            />
            <span className={`presence-light ${presenceStatus}`} title={PRESENCE_TITLE[presenceStatus]} />
          </button>
        </div>
        <div className="info info-clickable">
          <div className="display-name footer-handle">
            {idHandle ? <><span className="footer-at">@</span>{idHandle}</> : idDisplayName ?? "…"}
          </div>
          <div className="tier">
            <span className={`gh-status${githubConnected ? " connected" : ""}`} title={githubConnected ? `GitHub connected${ghUser ? ` as ${ghUser}` : ""}` : "GitHub not connected"}>
              <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>
              {githubConnected ? "connected" : "off"}
            </span>
          </div>
        </div>
        {/* Explicit affordances so the footer's two actions are legible at a
            glance: a chart icon for stats (matches the row click), a gear for
            Settings. */}
        <div className="profile-footer-actions">
          <button
            type="button"
            className="footer-action"
            title="Your usage stats"
            aria-label="Your usage stats"
            onClick={(e) => { e.stopPropagation(); onOpenMyInfo(); }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 3v18h18"/>
              <rect x="7" y="12" width="3" height="5" rx="0.5"/>
              <rect x="12.5" y="8" width="3" height="9" rx="0.5"/>
              <rect x="18" y="5" width="3" height="12" rx="0.5"/>
            </svg>
          </button>
          <button
            type="button"
            className="footer-action gear"
            title="Settings"
            aria-label="Settings"
            onClick={(e) => { e.stopPropagation(); onSettings(); }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
          </button>
        </div>
      </div>
        </>
      )}
    </aside>
    {/* ─── Right rail — the sections the user sent rightward, portaled into the
         <aside> App renders on the far edge of the work surface. Nothing here
         means the rail stays collapsed (see .right-rail:empty in global.css),
         so it costs no space until used. */}
    {rightRoot && docks.right.length > 0 && createPortal(
      <SectionRail
        side="right"
        ids={docks.right}
        sections={sections}
        onReorder={(from, to) => reorder("right", from, to)}
      />,
      rightRoot,
    )}
    {/* Both rail collapse/expand controls now live in the pane-header as flat
       panel-glyph buttons (see PaneArea) rather than floating seam pucks. */}
    </>
  );
}

// ─── Section rail ─────────────────────────────────────────────────────────────

/** An ordered column of sections. Dragging a section's header row reorders it
 *  within the rail (the same pointer-capture technique as the workspace cards);
 *  `data-rail` scopes the drop target so a drag in one rail never lands in the
 *  other. Placement between rails is the parent's job — this only reorders. */
function SectionRail({ side, ids, sections, onReorder }: {
  side: "left" | "right";
  ids: string[];
  sections: Record<string, ReactNode>;
  onReorder: (from: number, to: number) => void;
}) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const pressRef = useRef<{ index: number; x: number; y: number; pointerId: number; dragging: boolean } | null>(null);
  const suppressClickRef = useRef(false);
  return (
    <>
      {ids.map((secId, i) => (
        <div
          key={secId}
          className={`sb-sec-drag${dragIndex === i ? " dragging" : ""}${dragOverIndex === i && dragIndex !== i ? " drag-over" : ""}`}
          data-sec-index={i}
          data-rail={side}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            const t = e.target as HTMLElement;
            // Drag by the header row only, never from its action buttons (the
            // fold handle, the move button, per-section controls).
            if (!t.closest(".sb-sec-header") || t.closest(".sb-sec-actions")) return;
            e.preventDefault();
            pressRef.current = { index: i, x: e.clientX, y: e.clientY, pointerId: e.pointerId, dragging: false };
          }}
          onPointerMove={(e) => {
            const press = pressRef.current;
            if (!press) return;
            if (!press.dragging) {
              if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < DRAG_THRESHOLD_PX) return;
              press.dragging = true;
              (e.currentTarget as HTMLElement).setPointerCapture(press.pointerId);
              setDragIndex(press.index);
              setDragOverIndex(press.index);
            }
            const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
            const wrap = el?.closest<HTMLElement>(`[data-sec-index][data-rail="${side}"]`);
            if (wrap) {
              const idx = Number(wrap.dataset.secIndex);
              if (!Number.isNaN(idx)) setDragOverIndex(idx);
            }
          }}
          onPointerUp={(e) => {
            const press = pressRef.current;
            if (press?.dragging) {
              (e.currentTarget as HTMLElement).releasePointerCapture(press.pointerId);
              suppressClickRef.current = true;
              if (dragIndex !== null && dragOverIndex !== null && dragIndex !== dragOverIndex) {
                onReorder(dragIndex, dragOverIndex);
              }
            }
            pressRef.current = null;
            setDragIndex(null);
            setDragOverIndex(null);
          }}
          onPointerCancel={() => {
            pressRef.current = null;
            setDragIndex(null);
            setDragOverIndex(null);
          }}
          onClickCapture={(e) => {
            // The click that follows a completed drag would fold the section it
            // was dropped on — swallow exactly that one.
            if (suppressClickRef.current) {
              suppressClickRef.current = false;
              e.preventDefault();
              e.stopPropagation();
            }
          }}
        >
          {sections[secId]}
        </div>
      ))}
    </>
  );
}

// ─── Friends panel ────────────────────────────────────────────────────────────

function FriendsPanel({ friends, idSignedIn, idHandle, onAddFriend, onAcceptFriend, onRemoveFriend, onSettings, onRequestObserve, onSendTask, onCopilot, onOpenFriend }: {
  friends: Friend[];
  idSignedIn: boolean;
  idHandle: string | null;
  onAddFriend: (input: string) => Promise<AddFriendResult>;
  onAcceptFriend: (profileId: string) => Promise<void>;
  onRemoveFriend: (profileId: string) => Promise<void>;
  onSettings: () => void;
  onRequestObserve: (login: string, windowId: string) => void;
  onSendTask: (login: string, windowId: string, avatar?: string) => void;
  onCopilot: (login: string, windowId: string, avatar?: string) => void;
  onOpenFriend: (friend: Friend) => void;
}) {
  const [addInput, setAddInput] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState("");
  const [addNote, setAddNote] = useState("");
  // The add/invite input is revealed by the header "+", not always present —
  // a permanent empty field reads as a search box, which this isn't.
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const [offlineOpen, setOfflineOpen] = useState(true);

  // Never list yourself. App seeds a self entry (so presence from a second
  // window of your own account is trackable), and that window shares your
  // handle — filtering on handle + window id keeps both out.
  const realFriends = friends.filter(
    (f) => f.windowId !== MY_WINDOW_ID && !!f.handle && f.handle !== idHandle,
  );
  const accepted = realFriends.filter((f) => f.friendStatus === "accepted");
  const pendingIn = realFriends.filter((f) => f.friendStatus === "pending_in");
  const pendingOut = realFriends.filter((f) => f.friendStatus === "pending_out");

  const onlineCount = accepted.filter((f) => f.presence === "online").length;
  const totalFriends = accepted.length;
  const nothingYet = accepted.length === 0 && pendingIn.length === 0 && pendingOut.length === 0;

  // Search only earns its place once the list is long enough to scroll — below
  // that it's noise. A magnifier (vs the header "+") keeps the two unambiguous.
  const showSearch = accepted.length > 10;
  const q = query.trim().toLowerCase();
  const matches = (f: Friend) => !q || f.handle.toLowerCase().includes(q);
  const online = accepted.filter((f) => f.presence === "online").filter(matches)
    .sort((a, b) => b.agentCount - a.agentCount);
  const offline = accepted.filter((f) => f.presence === "offline").filter(matches)
    .sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0));

  const revealAdd = () => { setAdding(true); setAddError(""); setAddNote(""); };
  const dismissAdd = () => { setAdding(false); setAddInput(""); setAddError(""); };

  const submitAdd = async () => {
    const input = addInput.trim();
    if (!input || addBusy) return;
    setAddBusy(true);
    setAddError("");
    setAddNote("");
    try {
      const result = await onAddFriend(input);
      if (result === "invited") {
        // No account for that email yet: flock emails the invite. When
        // the friend signs up with that address, the two are auto-connected
        // and the referral counts. If the mail service can't send (domain
        // not verified yet, outage), fall back to a prefilled draft in the
        // inviter's own mail app so the invite still goes out.
        try {
          await sendInviteEmail(input);
          setAddNote(`Invite sent to ${input}. When they join, you're connected automatically.`);
        } catch {
          setAddNote("Couldn't send from flock — drafted the invite in your mail app instead.");
          openUrl(inviteMailto(input, idHandle)).catch(console.error);
        }
      } else if (result === "already") {
        setAddNote("Already friends, or a request is pending.");
      } else if (result === "self") {
        setAddNote("That's you.");
      }
      setAddInput("");
    } catch (e) {
      setAddError(e instanceof Error ? e.message : String(e));
    } finally {
      setAddBusy(false);
    }
  };

  const removeFriend = (id: string) => onRemoveFriend(id).catch(console.error);

  return (
    <section className="sidebar-section friends-panel">
      <div className="sidebar-section-header">
        <span>
          Friends
          {totalFriends > 0 && <span className="count"> {onlineCount} of {totalFriends} online</span>}
        </span>
        {idSignedIn && (
          <IconButton
            className="add-btn"
            icon="+"
            label="Add friend"
            onClick={() => (adding ? dismissAdd() : revealAdd())}
          />
        )}
      </div>

      {!idSignedIn ? (
        <div className="empty-state">
          <BlockedIcon size={12} /> not signed in
          <br />
          <span style={{ color: "var(--text-ghost)", cursor: "pointer" }} onClick={onSettings}>
            sign in with Google →
          </span>
        </div>
      ) : (
        <>
          {adding && (
            <div className="friend-add-row">
              <input
                className="friend-add-input"
                autoFocus
                value={addInput}
                onChange={(e) => { setAddInput(e.target.value); setAddError(""); setAddNote(""); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitAdd();
                  else if (e.key === "Escape") dismissAdd();
                }}
                placeholder="Handle, or email to invite"
                autoComplete="off"
                spellCheck={false}
              />
              <IconButton
                className="friend-add-btn"
                icon={addBusy ? "…" : "+"}
                label="Send request or invite"
                onClick={submitAdd}
                disabled={addBusy || !addInput.trim()}
              />
            </div>
          )}
          {addError && <div className="friend-add-error">{addError}</div>}
          {addNote && <div className="friend-add-note">{addNote}</div>}

          {pendingIn.length > 0 && (
            <>
              <div className="friend-subhead">Requests<span className="count"> {pendingIn.length}</span></div>
              {pendingIn.map((f) => (
                <FriendRow key={f.id} friend={f} subtitle="wants to connect" onOpen={() => onOpenFriend(f)}
                  trailing={
                    <span className="friend-action-btns friend-action-btns-static">
                      <IconButton className="friend-action-btn" icon={<CheckIcon />} label="Accept request" onClick={(e) => { e.stopPropagation(); onAcceptFriend(f.id).catch(console.error); }} />
                      <IconButton className="friend-action-btn friend-action-btn-danger" icon={<XIcon />} label="Decline request" onClick={(e) => { e.stopPropagation(); removeFriend(f.id); }} />
                    </span>
                  }
                />
              ))}
            </>
          )}

          {nothingYet ? (
            !adding && (
              <div className="friend-empty">
                <div className="friend-empty-text">Invite people to share agents and workspaces.</div>
                <button className="friend-empty-btn" onClick={revealAdd}>Add friend</button>
              </div>
            )
          ) : (
            <>
              {showSearch && (
                <div className="friend-search-row">
                  <SearchIcon />
                  <input
                    className="friend-search-input"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search friends"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
              )}

              {online.map((f) => {
                const wid = f.windowId ?? "";
                return (
                  <FriendRow key={f.id} friend={f} onOpen={() => onOpenFriend(f)}
                    onObserve={f.agentCount > 0 && wid ? () => onRequestObserve(f.handle, wid) : undefined}
                    onSendTask={wid ? () => onSendTask(f.handle, wid, f.avatarUrl) : undefined}
                    onCopilot={wid ? () => onCopilot(f.handle, wid, f.avatarUrl) : undefined}
                    onRemove={() => removeFriend(f.id)}
                  />
                );
              })}

              {offline.length > 0 && (
                <div className="friend-offline-group">
                  <button className="friend-offline-head" onClick={() => setOfflineOpen((o) => !o)} aria-expanded={offlineOpen}>
                    <span className={`friend-offline-chevron${offlineOpen ? " open" : ""}`}><ChevronDownIcon /></span>
                    Offline
                    <span className="friend-offline-count">{offline.length}</span>
                  </button>
                  {offlineOpen && offline.map((f) => (
                    <FriendRow key={f.id} friend={f} onOpen={() => onOpenFriend(f)} onRemove={() => removeFriend(f.id)} />
                  ))}
                </div>
              )}

              {pendingOut.map((f) => (
                <FriendRow key={f.id} friend={f} subtitle="request sent" onOpen={() => onOpenFriend(f)}
                  trailing={
                    <span className="friend-action-btns friend-action-btns-static">
                      <IconButton className="friend-action-btn friend-action-btn-danger" icon={<XIcon />} label="Cancel request" onClick={(e) => { e.stopPropagation(); removeFriend(f.id); }} />
                    </span>
                  }
                />
              ))}
            </>
          )}
        </>
      )}
    </section>
  );
}

/** One friend. Two lines — handle + a shared-context subtitle answering "what
 *  can I do with this person" — plus hover actions. Presence is carried by the
 *  avatar dot (online) or the "last seen …" subtitle (offline). */
function FriendRow({ friend: f, subtitle, trailing, onOpen, onObserve, onSendTask, onCopilot, onRemove }: {
  friend: Friend;
  /** Override the presence-derived subtitle (e.g. "request sent"). */
  subtitle?: string;
  /** Custom trailing controls (accept/decline for requests). */
  trailing?: React.ReactNode;
  /** Click the row body (not the action buttons) to open their stats. */
  onOpen?: () => void;
  onObserve?: () => void;
  onSendTask?: () => void;
  onCopilot?: () => void;
  onRemove?: () => void;
}) {
  const isOnline = f.presence === "online";
  const sub = subtitle ?? friendSubtitle(f);
  const hasActions = !!(onObserve || onSendTask || onCopilot || onRemove);
  return (
    <div
      className={`friend-row${isOnline ? " online" : " offline"}${onOpen ? " openable" : ""}`}
      {...(onOpen ? { role: "button", tabIndex: 0, onClick: onOpen, onKeyDown: onActivateKey(onOpen) } : {})}
    >
      <div className="friend-avatar-wrap">
        <Avatar
          url={f.avatarUrl}
          imgClassName="friend-avatar"
          fallbackClassName="friend-avatar-placeholder"
          fallbackContent={null}
        />
        {/* Online only — offline rows read from the "last seen" subtitle. */}
        {isOnline && <span className="friend-presence-dot online" />}
      </div>
      <div className="friend-row-text">
        <span className={`friend-handle${isOnline ? " online" : ""}`}>{f.handle}</span>
        <span className="friend-subtitle">{sub}</span>
      </div>
      {trailing}
      {hasActions && (
        <div className="friend-action-btns">
          {onObserve && <IconButton className="friend-action-btn" icon={<EyeIcon />} label="View their agents" onClick={(e) => { e.stopPropagation(); onObserve(); }} />}
          {onSendTask && <IconButton className="friend-action-btn" icon={<SendIcon />} label="Send a task" onClick={(e) => { e.stopPropagation(); onSendTask(); }} />}
          {onCopilot && <IconButton className="friend-action-btn" icon={<CopilotIcon />} label="Invite to co-pilot" onClick={(e) => { e.stopPropagation(); onCopilot(); }} />}
          {onRemove && <IconButton className="friend-action-btn friend-action-btn-danger" icon={<UserMinusIcon />} label="Remove friend" onClick={(e) => { e.stopPropagation(); onRemove(); }} />}
        </div>
      )}
    </div>
  );
}

/** Shared-context line for a friend row: agents they're exposing when online,
 *  a relative "last seen" when offline. */
function friendSubtitle(f: Friend): string {
  if (f.presence === "online") {
    return f.agentCount > 0
      ? `${f.agentCount} ${f.agentCount === 1 ? "agent" : "agents"} shared`
      : "online";
  }
  return f.lastSeen ? `last seen ${relativeTime(f.lastSeen)}` : "offline";
}

// Shield, mint: this workspace's agents run inside the secure-mode container
// jail. Same stroke language as the rest of the inline icons.
function JailShieldIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
    </svg>
  );
}

// ─── Workspace card ───────────────────────────────────────────────────────────

/** Pointer must move this far before a press-and-hold turns into a drag —
 *  below this it's treated as a plain click (selects the workspace). */
const DRAG_THRESHOLD_PX = 4;

/** How many distinct branches this workspace's agents are actually on —
 * live from the repo map when available, else the persisted snapshots.
 * Above 1, "@main" alone would lie, so cards show "⑂ N branches" instead. */
function distinctBranchCount(ws: Workspace, map?: RepoMap): number {
  const byPath = new Map((map?.worktrees ?? []).map((t) => [t.path, t]));
  const branches = new Set(
    ws.panes
      .filter((p) => !p.streamId)
      .map((p) => {
        const wt = byPath.get(p.cwd);
        return wt ? wt.branch || wt.head : p.worktree?.branch || ws.branch;
      })
      .filter(Boolean),
  );
  return branches.size;
}

/** One row in the workspace list.
 *
 *  Every callback takes the workspace id (or index) rather than closing over
 *  it, so the parent can hand every card the same function instances and the
 *  memo below has something to skip on. Without that this re-rendered the whole
 *  list on every agent status event anywhere in the app. */
function WorkspaceCardImpl({
  ws, repoMap, index, focused, onSelect, onContextMenu, onClose,
  dragging, draggedOver, onDragStart, onDragMove, onDragEnd,
}: {
  ws: Workspace;
  repoMap?: RepoMap;
  index: number;
  focused: boolean;
  onSelect: (workspaceId: string) => void;
  onContextMenu: (workspaceId: string, e: React.MouseEvent) => void;
  onClose: (workspaceId: string, e: React.MouseEvent) => void;
  dragging: boolean;
  draggedOver: boolean;
  onDragStart: (index: number) => void;
  onDragMove: (clientX: number, clientY: number) => void;
  onDragEnd: () => void;
}) {
  const select = () => onSelect(ws.id);
  // Tracks an in-progress press: origin coords (to measure the drag
  // threshold), whether it's actually become a drag yet, and the pointerId
  // (needed to release capture). A ref, not state — every pointermove
  // during a drag would otherwise re-render this component for no reason.
  const pressRef = useRef<{ x: number; y: number; pointerId: number; dragging: boolean } | null>(null);
  // A drag that just ended still fires a native `click` right after
  // pointerup — this suppresses exactly that one click so dropping a card
  // doesn't also "select" whichever workspace it landed on.
  const suppressClickRef = useRef(false);
  // Derived live from pane statuses (not a stored flag, so it can't go
  // stale): an unfocused workspace with an agent waiting on the user gets
  // the yellow attention treatment.
  const needsAttention = !focused && ws.panes.some(
    (p) => p.status === "awaiting_input" || p.status === "blocked",
  );
  const cls = [
    "workspace-card",
    focused && "focused",
    needsAttention && "attention",
    ws.copilot && "copilot",
    ws.observe && "observe",
    ws.prReview && "pr-review",
    dragging && "dragging",
    draggedOver && "drag-over",
  ].filter(Boolean).join(" ");
  const rollup = rollupStatus(ws);
  return (
    <div
      className={cls}
      data-ws-card-index={index}
      role="button"
      tabIndex={0}
      aria-current={focused}
      aria-label={`Workspace ${ws.name}`}
      onClick={() => {
        if (suppressClickRef.current) { suppressClickRef.current = false; return; }
        select();
      }}
      onKeyDown={onActivateKey(select)}
      onContextMenu={(e) => onContextMenu(ws.id, e)}
      style={{ ["--accent" as never]: ws.accentColor }}
      onPointerDown={(e) => {
        if (e.button !== 0) return; // reorder via primary button/touch only
        // Text selection is one of the browser's default actions for a
        // mousedown-then-move gesture, same as the pane-split gutters —
        // without this, dragging a card highlights its name/branch text
        // the whole time (`user-select: none` on the sidebar helps but
        // doesn't fully suppress the native selection *gesture* starting).
        // Does not affect the click that follows a plain press-release, or
        // clicks on nested buttons (git/close) — only text selection.
        e.preventDefault();
        pressRef.current = { x: e.clientX, y: e.clientY, pointerId: e.pointerId, dragging: false };
      }}
      onPointerMove={(e) => {
        const press = pressRef.current;
        if (!press) return;
        if (!press.dragging) {
          const dx = e.clientX - press.x, dy = e.clientY - press.y;
          if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
          press.dragging = true;
          (e.currentTarget as HTMLElement).setPointerCapture(press.pointerId);
          onDragStart(index);
        }
        onDragMove(e.clientX, e.clientY);
      }}
      onPointerUp={(e) => {
        const press = pressRef.current;
        if (press?.dragging) {
          (e.currentTarget as HTMLElement).releasePointerCapture(press.pointerId);
          suppressClickRef.current = true;
          onDragEnd();
        }
        pressRef.current = null;
      }}
      onPointerCancel={() => {
        if (pressRef.current?.dragging) onDragEnd();
        pressRef.current = null;
      }}
    >
      <div className="ws-card-header">
        <div className="card-top">
          <div className="name ws-name">{ws.name}</div>
          {/* PR-review marker: this workspace exists to review one PR (its
              worktree has the PR branch checked out). Pairs with the violet
              accent rail and the top-of-list pinning. */}
          {ws.prReview && (
            <span className="ws-review-badge" title="PR-review workspace — a review agent on this PR's branch">
              REVIEW
            </span>
          )}
          {/* Secure mode marker: quiet at rest, but always visible. Whether a
              workspace's agents are jailed is a security property, not a
              hover detail. Pairs with the "jailed" chip on each pane. */}
          {ws.secure && (
            <span
              className="ws-jail-badge"
              title="Secure mode: agents run jailed in a Docker container"
            >
              <JailShieldIcon />
            </span>
          )}
        </div>
        <div className="meta">
          {ws.copilot
            ? <span className={`copilot-status copilot-status--${ws.copilot.status}`}>
                <span className="copilot-status-dot" aria-hidden="true" />
                {ws.copilot.status === "pending"
                  ? `inviting ${ws.copilot.partnerLogin}…`
                  : `with ${ws.copilot.partnerLogin}`}
              </span>
            : ws.observe
            ? `${ws.observe.ownerLogin} · live`
            : <>
                <span className="meta-branch">
                  {distinctBranchCount(ws, repoMap) > 1
                    ? <><BranchIcon size={10} /> {distinctBranchCount(ws, repoMap)} branches</>
                    : `@${ws.branch}`}
                </span>
                {ws.panes.length > 0 && <>
                  <span className="sep">·</span>
                  <span className="meta-panes">
                    {ws.panes.length}p
                    {ws.panes.filter((p) => p.status === "working").length > 0 &&
                      ` · ${ws.panes.filter((p) => p.status === "working").length} working`}
                  </span>
                </>}
              </>
          }
        </div>
        <div className="ws-card-actions">
          <IconButton
            className="ws-close-btn"
            icon={<XIcon size={11} />}
            label={ws.copilot ? "End Co-pilot Session" : ws.observe ? "Stop Observing" : "Close Workspace"}
            onClick={(e) => onClose(ws.id, e)}
          />
        </div>
      </div>
      {!ws.copilot && !ws.observe && <span className="status-dot"><StatusDot status={rollup} /></span>}
    </div>
  );
}

// Shallow compare is enough now that the callbacks above are stable: `ws` is
// replaced wholesale whenever anything in that workspace changes, and the rest
// are primitives. So a status event in one workspace re-renders one card
// instead of the entire list.
const WorkspaceCard = memo(WorkspaceCardImpl);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Compress a raw GitHub API error ("GitHub API error 403 Forbidden: {json}")
 * into something a 200px-wide sidebar can show. Prefers the API's own
 * `message` field; the full error stays available via the tooltip. */
function shortPrError(err: string): string {
  const jsonStart = err.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const msg = JSON.parse(err.slice(jsonStart)).message;
      if (typeof msg === "string" && msg) {
        return msg.length > 120 ? `${msg.slice(0, 120)}…` : msg;
      }
    } catch { /* fall through to truncation */ }
  }
  return err.length > 120 ? `${err.slice(0, 120)}…` : err;
}

// The sidebar agent row's intent label: single-line + ellipsis-clipped, with
// the full intent revealed in the shared floating tooltip on hover (replaces
// the native `title`). Its own component so the hook isn't called in a loop.
function AgentIntentText({ intent, full }: { intent: string; full: string }) {
  const { ref, anchorProps, tipNode } = useFloatingTip<HTMLSpanElement>(full);
  return (
    <span className="agent-intent-text" ref={ref} aria-label={`Agent intent: ${full}`} {...anchorProps}>
      {intent}
      {tipNode}
    </span>
  );
}

function StatusDot({ status }: { status: string }) {
  // A working rollup gets no mark: the card's own meta line already reads
  // "N working", and the wave belongs to the agent rows that are doing the
  // work. One workspace saying it twice is noise.
  if (status === "working") return null;
  // A mark, not a character. The three states used to be ● ✓ ✗ — one from
  // SF Mono, one from SF Mono, one from nowhere in the app's own type — set
  // at 8px in a row of 11px text, so the "done" tick sat a pixel low against
  // the "needs you" dot beside it. The dot is now drawn by CSS (it is a
  // circle, and a circle does not need a font) and the two outcomes are the
  // same icon pair used everywhere else a check or a cross appears.
  const mark =
    status === "awaiting_input" ? <span className="status-mark filled" />
    : status === "done" ? <CheckIcon size={11} />
    : status === "failed" ? <XIcon size={11} />
    : <span className="status-mark" />;
  return <span className={`status-dot ${statusClass(status)}`}>{mark}</span>;
}

function statusClass(status: string): string {
  return status === "working" ? "working"
    // blocked, like awaiting_input, is on the user — surface it as attention
    // (yellow/pulsing) rather than letting it read as a resting idle state.
    : status === "awaiting_input" || status === "blocked" ? "awaiting"
    : status === "done" ? "done"
    : status === "failed" ? "failed"
    : "idle";
}

function statusLabel(status: string): string {
  switch (status) {
    case "working": return "working";
    case "awaiting_input": return "needs input";
    case "blocked": return "blocked";
    case "done": return "done";
    case "failed": return "failed";
    default: return "idle";
  }
}

/** Compact "how long in this state" for the agent rows: 45s → 3m → 2h → 4d. */
function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** How often the durations on the agent rows are recomputed. They are rendered
 *  at minute granularity past the first minute, so this is already finer than
 *  most of what it drives. */
const CLOCK_INTERVAL_MS = 5_000;

/** The shared clock, as one external store rather than one component's state.
 *
 *  It used to be `useState` in <Sidebar>, which meant every tick re-rendered
 *  the entire rail — every workspace card, every agent row, every panel — to
 *  refresh a handful of "3m" labels. Subscribing where the value is actually
 *  read confines the tick to those labels.
 *
 *  Still one timer for the whole rail, not one per row: it starts on the first
 *  subscriber and stops on the last, so a sidebar showing no durations (the
 *  friends tab, a collapsed rail) costs nothing at all. */
const clockListeners = new Set<() => void>();
let clockTimer: ReturnType<typeof setInterval> | null = null;
let clockNow = Date.now();

function subscribeClock(onChange: () => void): () => void {
  clockListeners.add(onChange);
  if (clockTimer === null) {
    clockTimer = setInterval(() => {
      clockNow = Date.now();
      for (const listener of clockListeners) listener();
    }, CLOCK_INTERVAL_MS);
  }
  return () => {
    clockListeners.delete(onChange);
    if (clockListeners.size === 0 && clockTimer !== null) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  };
}

function useNow(): number {
  return useSyncExternalStore(subscribeClock, () => clockNow);
}

/**
 * The heart of "who's doing what" — a right-aligned chip so every agent's state
 * lines up in one scannable column: a status-colored indicator (pulsing while
 * working or awaiting you), the label, and how long it's held that state. The
 * duration is omitted only when genuinely unknown (a just-restored pane that
 * hasn't emitted a status event yet).
 */
/** The state mark, sized to its content and pinned to the right of the name.
 *
 * It carries no duration: that sits under it on the intent line (see
 * `AgentStatusTime`), so the mark and the elapsed time stack against the same
 * right edge instead of competing for one line. Content-width matters more
 * than it looks — this was a fixed three-column grid whose middle column
 * reserved 70px for a label that is `position: absolute` on working rows, and
 * those dead 70px were enough to wrap the whole chip onto a line of its own. */
function AgentStatusChip({ status }: { status: string }) {
  const sc = statusClass(status);
  const working = sc === "working";
  return (
    <span className={`agent-status s-${sc}`}>
      {working
        ? <WorkingBlocks cells={5} />
        : <span className="agent-ind" aria-hidden="true" />}
      {/* The wave already says "working" — the word alongside it is redundant.
          It stays for screen readers only, since the strip is aria-hidden. */}
      <span className={`agent-status-label${working ? " is-visually-hidden" : ""}`}>
        {statusLabel(status)}
      </span>
    </span>
  );
}

/** How long the agent has held its current state, on the intent line and hard
 *  right, directly below the status mark. Subscribes to the shared clock
 *  itself, so a tick re-renders this span and nothing above it. */
function AgentStatusTime({ since }: { since?: number }) {
  const now = useNow();
  if (since == null) return null;
  return <span className="agent-status-time">{formatDuration(now - since)}</span>;
}

function rollupStatus(ws: Workspace): string {
  const priority = (s: string) =>
    s === "awaiting_input" ? 5
    : s === "blocked" ? 4
    : s === "failed" ? 3
    : s === "working" ? 2
    : s === "done" ? 1
    : 0;
  return ws.panes.reduce(
    (acc, p) => (priority(p.status) > priority(acc) ? p.status : acc),
    "idle",
  );
}

function relativeTime(unixSec: number): string {
  const diff = Math.floor(Date.now() / 1000) - unixSec;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 172800) return "yesterday";
  return `${Math.floor(diff / 86400)}d ago`;
}

// ─── Prompt queue ─────────────────────────────────────────────────────────────

/** Count of staged screenshots on a row (image_paths is a JSON filename array).
 *  The bytes live on disk under the instance data dir; the sidebar shows a
 *  count chip rather than live thumbnails — rendering the files in the webview
 *  would need the Tauri asset protocol, out of scope for v1. The capture overlay
 *  shows real previews because it still holds the bytes in memory. */
function imageCount(raw: string): number {
  try {
    const a = JSON.parse(raw);
    return Array.isArray(a) ? a.length : 0;
  } catch {
    return 0;
  }
}

function QueueList({ queueItems, onLaunch, onEdit, onDelete }: {
  queueItems: QueueItem[];
  onLaunch: (item: QueueItem, e: React.MouseEvent) => void;
  onEdit: (id: string, text: string) => void;
  onDelete: (id: string) => void;
}) {
  // Queued: newest capture first. History: most-recently launched first.
  const queued = queueItems.filter((i) => i.status === "queued").slice().reverse();
  const launched = queueItems
    .filter((i) => i.status === "launched")
    .slice()
    .sort((a, b) => (b.launched_at ?? 0) - (a.launched_at ?? 0));

  if (queued.length === 0 && launched.length === 0) {
    return <div className="empty-state">nothing queued — capture a prompt with +</div>;
  }
  return (
    <div className="queue-list">
      {queued.map((item) => (
        <QueuedRow key={item.id} item={item} onLaunch={onLaunch} onEdit={onEdit} onDelete={onDelete} />
      ))}
      {launched.length > 0 && <div className="queue-divider">History</div>}
      {launched.map((item) => (
        <HistoryRow key={item.id} item={item} />
      ))}
    </div>
  );
}

function QueuedRow({ item, onLaunch, onEdit, onDelete }: {
  item: QueueItem;
  onLaunch: (item: QueueItem, e: React.MouseEvent) => void;
  onEdit: (id: string, text: string) => void;
  onDelete: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.text);
  const imgs = imageCount(item.image_paths);
  const save = () => {
    const t = draft.trim();
    if (t && t !== item.text) onEdit(item.id, t);
    setEditing(false);
  };
  return (
    <div className="queue-row">
      {editing ? (
        <textarea
          className="queue-edit-input"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
            else if (e.key === "Escape") { setDraft(item.text); setEditing(false); }
          }}
          rows={3}
        />
      ) : (
        <div
          className="queue-row-text"
          role="button"
          tabIndex={0}
          title="Click to edit"
          onClick={() => { setDraft(item.text); setEditing(true); }}
          onKeyDown={onActivateKey(() => { setDraft(item.text); setEditing(true); })}
        >
          {item.text}
        </div>
      )}
      <div className="queue-row-footer">
        {imgs > 0 && <span className="queue-img-chip">{imgs} image{imgs === 1 ? "" : "s"}</span>}
        <div className="queue-row-actions">
          <button type="button" className="queue-launch-btn" onClick={(e) => onLaunch(item, e)}>Launch →</button>
          <IconButton className="queue-del-btn ghost" icon={<XIcon />} label="Delete queued prompt" onClick={() => onDelete(item.id)} />
        </div>
      </div>
    </div>
  );
}

function HistoryRow({ item }: { item: QueueItem }) {
  const imgs = imageCount(item.image_paths);
  return (
    <div className="queue-row queue-row-history">
      <div className="queue-row-text queue-row-text-static">{item.text}</div>
      <div className="queue-row-meta">
        {imgs > 0 && <span className="queue-img-chip">{imgs} image{imgs === 1 ? "" : "s"}</span>}
        {item.target_label && <span className="queue-target" title={item.target_label}>{item.target_label}</span>}
        {item.launched_at != null && <span className="queue-time">{relativeTime(item.launched_at)}</span>}
      </div>
    </div>
  );
}
