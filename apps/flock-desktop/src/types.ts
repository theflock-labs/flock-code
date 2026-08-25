import type { BorrowedRef } from "./lib/borrowedPanes";

// Types shared with the Rust backend. Must stay in sync with
// src-tauri/src/events.rs.

import type { Budget } from "./lib/budgets";

export interface WorkspaceInfo {
  id: string;
  name: string;
  repo_path: string;
  branch: string;
  created_at: number;
}

export interface PaneInfo {
  id: string;
  workspace_id: string;
  kind: string;
  status: AgentStatusStr;
  rows: number;
  cols: number;
}

export type AgentStatusStr =
  | "idle"
  | "working"
  | "awaiting_input"
  | "blocked"
  | "done"
  | "failed";

export interface PtyExitPayload {
  pane_id: string;
  exit_code: number;
}

export interface AgentStatusPayload {
  pane_id: string;
  status: AgentStatusStr;
}

export type AgentKind = "opencode" | "codex" | "claude" | "pi" | "grok";

export type FriendPresence = "online" | "offline";
export type FriendStatus = "pending_out" | "pending_in" | "accepted";

export interface Friend {
  id: string;
  handle: string;
  avatarUrl: string;
  friendStatus: FriendStatus;
  presence: FriendPresence;
  agentCount: number;
  lastSeen: number | null;
  windowId?: string; // Ably window_id — unique per running app instance
}

export type WindowLayout = "single" | "split" | "quad" | "six" | "eight" | "twelve";

// GitHub
export interface GitHubStatus {
  connected: boolean;
  user: string | null;
  avatar_url: string | null;
}

export interface PullRequest {
  number: number;
  title: string;
  author: string;
  repo: string;
  state: string;
  body: string | null;
  updated_at: string;
  /** PR's head branch name. Empty for PRs from `githubListPrs` (search-based,
   * doesn't include it) — only populated by `githubWorkspacePrs`. */
  head_ref: string;
}

/** One independent split-pane layout within a workspace — like a terminal
 * app's tab. Panes themselves (the live agents) belong to the *workspace*
 * (see Workspace.panes below); a tab is just a layoutTree that references
 * some subset of them, plus which one is focused/zoomed within this tab. */
/** One agent in a race: the branch and worktree it was given, and the name it
 * is wearing in its pane.
 *
 * Deliberately keyed by `worktreePath` rather than by pane id. A restored
 * workspace respawns every pane with a *fresh* id (see `remapLayoutTree`), so a
 * race that remembered pane ids would lose every contender across a relaunch —
 * and a race is exactly the kind of thing left running overnight. The checkout
 * on disk outlives the pane, so the comparison survives with it. */
export interface RaceContender {
  /** The pane's display name at spawn time ("Pluto"), for labelling. */
  agentName: string;
  branch: string;
  worktreePath: string;
}

/** A fan-out: one prompt, N agents, each in its own worktree off one commit.
 * Lives on the tab holding those agents, and is persisted with it. */
export interface RaceState {
  /** The prompt every contender was given. */
  prompt: string;
  /** Full sha every contender branched from, and what their diffs are taken
   * against. A sha, not a branch name — see `git::head_sha`. */
  baseSha: string;
  /** The branch that sha was on when the race started, purely for display. */
  baseLabel: string;
  contenders: RaceContender[];
  startedAt: number;
  /** Set once a contender has been merged, so the tab stops offering to run
   * the merge again and the compare view can say which one won. */
  winnerBranch?: string;
}

export interface WorkspaceTab {
  id: string;
  name: string;
  /** True once the user has given this tab a custom name (double-click the tab
   * to rename, e.g. "Fable" / "Sonnet" / "Opus"). Auto-created tabs are named
   * by position ("1", "2", …) and get renumbered as tabs open/close; a renamed
   * tab keeps its name and is skipped by that renumbering. */
  renamed?: boolean;
  layoutTree: LayoutNode | null;
  focusedPaneId: string | null;
  zoomedPaneId: string | null;
  /** Set when this tab was opened by "Race agents" — the fan-out's prompt,
   * base commit, and contenders. Its presence is what turns the header's Race
   * button into Compare. */
  race?: RaceState;
  /** Panes laid out in this tab that belong to ANOTHER workspace. The tab
   * displays them; it never owns them. Recorded separately from `layoutTree`
   * because the tree holds bare pane ids and so cannot say who owns one, and
   * because on restore this list is what tells us which other workspace has to
   * come up before these leaves can resolve. See lib/borrowedPanes.ts. */
  borrowed?: BorrowedRef[];
}

// Front-end-only workspace state with extra display data.
export interface Workspace extends WorkspaceInfo {
  accentColor: string;
  panes: Pane[];
  tabs: WorkspaceTab[];
  focusedTabId: string;
  agentKind: AgentKind;
  /** When true, every new agent spawned into this workspace gets its own
   * git worktree + branch instead of sharing repo_path. Set at creation
   * time in NewWorkspaceDialog; applies to later "+ Spawn Agent"/split too.
   *
   * Derived from `branchPlan` for workspaces created since the branch picker
   * landed; kept as the stored flag so workspaces persisted before it still
   * restore with their isolation intact. */
  useWorktrees?: boolean;
  /** How this workspace's agents get a branch. Persisted so later spawns and
   * splits inherit the same stem and base ref instead of falling back to
   * "branch off whatever HEAD is". Absent on pre-branch-picker workspaces. */
  branchPlan?: BranchPlan;
  /** Secure mode: every agent in this workspace runs inside a Docker
   * container that sees only the workspace directory — no host files, keys,
   * or credentials — making the full-permission launch flags safe. Set at
   * creation time in NewWorkspaceDialog; applies to later spawns/splits. */
  secure?: boolean;
  copilot?: CopilotInfo; // when set, this is a co-pilot workspace
  observe?: ObserveInfo; // when set, this is an observe workspace (single read-only pane)
  /** When true, this workspace was created by the PR-review flow (reviewPr /
   * the auto-review watcher): a dedicated worktree with a PR branch checked
   * out and a review agent inside. PR-review workspaces get the violet
   * treatment and are pinned to the top of every workspace list. Persisted
   * with the workspace state so the pin survives restarts. */
  prReview?: boolean;
  /** The PR a prReview workspace is reviewing. Persisted so review-summary
   * tracking re-arms on the restored pane after a restart, and so re-review
   * dedupe doesn't depend on the workspace's display name. */
  prReviewTarget?: { repo: string; number: number };
  /** Spend ceiling for this workspace's agents, per day or per month. Stored
   * in the workspace_state blob so it travels with the workspace rather than
   * living in a machine preference that a restore would not bring back.
   * Absent = no ceiling. Priced from a local table — see `lib/budgets.ts`. */
  budget?: Budget;
}

/** Where a workspace's agents do their work.
 *
 * - `new`      cut a fresh branch per agent from `baseRef`, each in its own worktree
 * - `existing` check out `branch` in a worktree (single agent; with more, it
 *              becomes the base every agent branches from)
 * - `current`  no isolation, every agent shares the repo's own working copy
 */
export type BranchMode = "new" | "existing" | "current";

export interface BranchPlan {
  mode: BranchMode;
  /** `new` mode: the branch name for a solo agent, and the prefix each
   * additional agent's branch is derived from (`{stem}-{agent}`). */
  stem: string;
  /** Ref new branches are cut from, e.g. "origin/main". Empty = current HEAD. */
  baseRef: string;
  /** `existing` mode: the branch to check out. */
  branch?: string;
  /** Update `baseRef` from its remote before branching. */
  fetch: boolean;
}

export interface CopilotInfo {
  sessionId: string;
  partnerLogin: string;
  partnerWid: string;
  partnerAvatar?: string;
  /** "pending" from the moment you invite until the partner joins; "connected"
   *  once they've accepted. The guest side is "connected" from the start — they
   *  create the workspace by accepting the invite. */
  status: "pending" | "connected";
}

export interface ObserveInfo {
  sessionId: string;
  ownerLogin: string;
  ownerWid: string;
  ownerAvatar?: string;
}

export interface Pane {
  id: string;
  workspaceId: string;
  kind: string;
  status: AgentStatusStr;
  /** Unix ms when `status` last transitioned to its current value — drives the
   * sidebar's "idle 3m" / "working 45s" last-activity readout. Optional: panes
   * restored from disk get stamped on their first live status event instead. */
  statusChangedAt?: number;
  attention: boolean;
  /** Random whimsical name (e.g. "Pluto") shown at the top of the pane. */
  displayName?: string;
  /** Working directory the agent was actually spawned in — the workspace's
   * repo_path by default, or a dedicated git worktree path when the
   * workspace has "separate worktrees per agent" enabled. */
  cwd: string;
  /** Set when this pane runs in its own git worktree (vs. sharing the
   * workspace's repo_path). Both are needed to clean the worktree up via
   * `git worktree remove` when the pane closes. */
  worktree?: { path: string; branch: string };
  /** Claude only: the per-pane session id passed via `--session-id`, so the
   * exact conversation can be resumed (`--resume`) after an app restart. */
  sessionId?: string;
  /** When set, render via RemoteTerminal subscribing to flock:stream:{streamId}. */
  streamId?: string;
  /** What this agent is currently working on, sniffed from keystrokes on
   * every Enter — a plain-language reminder shown in the pane topbar and the
   * sidebar Agents list. Starts as the raw prompt, then upgrades to a short
   * LLM-summarized task label derived from the pane's recent prompt history
   * once `claude -p` returns, so it tracks where the task has moved on to
   * rather than freezing on the first thing typed. Persisted with the
   * workspace so it survives restarts. */
  intent?: string;
  /** The recent raw prompts this pane's `intent` was derived from (joined
   * for display), kept alongside the (possibly summarized) `intent` so the
   * full text is still available as a hover tooltip. */
  intentRaw?: string;
  /** Rolling list of the raw prompts submitted into this pane (oldest first),
   * persisted so clicking the topbar intent opens a per-agent prompt history
   * you can re-send. Distinct from `intentRaw`, which is a joined display
   * string of just the last few. */
  promptHistory?: string[];
  /** The model this pane is running, as last selected via a `/model <name>`
   * command sniffed from the user's keystrokes (e.g. "opus", "sonnet"). Shown
   * as a chip next to the sidebar intent so you can tell at a glance which
   * model each agent is on. Undefined until a `/model` is seen — the agent's
   * own default isn't observable from keystrokes. Persisted with the pane. */
  model?: string;
  /** True between the moment the pane is rendered optimistically and the
   * backend PTY spawn resolving. While set, PaneArea shows a lightweight
   * placeholder instead of mounting the terminal (which would try to bind to
   * a pane that doesn't exist backend-side yet). Never persisted as true. */
  spawning?: boolean;
  /** True from the PTY going live until the agent takes the terminal over
   * (lib/agentBoot). The terminal is mounted underneath — it has to be, so it
   * sizes the PTY and answers the cursor-position queries some agents make on
   * startup — with the boot card over it, so the shell prompt, a worktree's
   * `npm ci` and a secure pane's image build don't scroll past on the way in.
   * Never persisted as true. */
  booting?: boolean;
  /** What flock is doing for this pane while it is spawning or booting, shown
   * on the card. Absent means "starting the agent". Never persisted. */
  phase?: PanePhase;
}

/** A step of getting a pane ready, in the order they happen. Each one is work
 *  that used to happen with nothing on screen at all. */
export type PanePhase =
  | { kind: "fetching"; ref: string }
  | { kind: "branching"; branch?: string }
  | { kind: "installing"; command: string }
  | { kind: "starting" };

// BSP layout tree — ported from crates/flock-tui/src/layout.rs
export type SplitDir = "horizontal" | "vertical";

export type LayoutNode =
  | { type: "leaf"; paneId: string }
  | {
      type: "split";
      dir: SplitDir;
      ratio: number;
      first: LayoutNode;
      second: LayoutNode;
    };
