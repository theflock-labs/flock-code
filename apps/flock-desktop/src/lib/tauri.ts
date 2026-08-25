// Typed wrapper around Tauri's invoke + event APIs.
//
// Every backend command lives in src-tauri/src/commands.rs. Keep names + signatures
// in sync — the command set is small enough that this stays manageable.

import { invoke, Channel } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import type {
  AgentStatusPayload,
  GitHubStatus,
  PaneInfo,
  PullRequest,
  PtyExitPayload,
  WorkspaceInfo,
} from "../types";
import { getEffectiveTheme } from "./theme";

// ─── Workspaces ──────────────────────────────────────────────────────────────

export const listWorkspaces = (): Promise<WorkspaceInfo[]> =>
  invoke<WorkspaceInfo[]>("list_workspaces");

export const createWorkspace = (
  name: string,
  repoPath: string,
  branch?: string,
): Promise<WorkspaceInfo> =>
  invoke<WorkspaceInfo>("create_workspace", { name, repoPath, branch });

export const reorderWorkspaces = (ids: string[]): Promise<void> =>
  invoke<void>("reorder_workspaces", { ids });

export const listPanes = (): Promise<PaneInfo[]> => invoke<PaneInfo[]>("list_panes");

// ─── Panes / PTY ─────────────────────────────────────────────────────────────

export interface SpawnPaneArgs {
  workspaceId: string;
  cmd: string;
  args: string[];
  cwd?: string;
  rows: number;
  cols: number;
  /** Display name (e.g. "Vesper") — exported as FLOCK_AGENT_NAME into the
   * pane so downstream tools (flock-graph MCP) attribute work to it. */
  agentName?: string;
  /** Extra env vars exported into the pane's shell before the agent launches. */
  env?: Record<string, string>;
  /** Run the agent jailed in a Docker container (secure mode). Fails the
   * spawn (rather than silently unjailing) when Docker is unavailable. */
  secure?: boolean;
  /** Client-generated pane id, so the frontend can render the pane
   * optimistically and have the spawned PTY bind to it. Omit to let the
   * backend generate one. */
  paneId?: string;
  /** Whether the knowledge graph is on — gates a per-spawn org/team lookup
   * that otherwise costs up to 400ms even when the graph is disabled. */
  graphEnabled?: boolean;
  /** Set only when `cwd` is a git worktree created moments ago: the repo whose
   * stored setup command should run in the pane before the agent starts. The
   * command itself is never sent from here — the backend looks it up (see the
   * `worktree_setup` module). Leave unset on restore and on adopting an
   * existing worktree; both are already installed. */
  setupRepo?: string;
}

export const spawnPane = (args: SpawnPaneArgs): Promise<PaneInfo> =>
  invoke<PaneInfo>("spawn_pane", {
    ...args,
    // Theme id, not FLOCK_CLAUDE_THEME: identity and launch env are
    // backend-chosen, and a webview FLOCK_* is refused.
    theme: getEffectiveTheme(),
    env: { ...agentThemeEnv(args.cmd), ...args.env },
  });

/** Docker readiness for secure (container) mode. */
export interface ContainerStatus {
  available: boolean;
  daemon_running: boolean;
  image_ready: boolean;
}

export const containerStatus = (): Promise<ContainerStatus> =>
  invoke<ContainerStatus>("container_status");

/** The jail's network posture. Machine-wide, not per workspace: the policy
 *  lives in a host file the spawn path reads for itself, so this is a view of
 *  it rather than a value the webview gets to pass at spawn time. */
export interface EgressPolicy {
  /** Restrict secure panes to the allowlist. Applies at the next spawn — a
   *  running container's network cannot be tightened underneath it. */
  restrict: boolean;
  /** The operator's own list, verbatim from ~/.flock/egress-allow.txt. */
  allow_file: string;
  /** The built-in agent endpoints, always allowed when restrict is on. */
  defaults: string[];
}

export const egressPolicy = (): Promise<EgressPolicy> => invoke<EgressPolicy>("egress_policy");

export const setEgressPolicy = (restrict: boolean, allowFile?: string): Promise<void> =>
  invoke<void>("set_egress_policy", { restrict, allowFile });

/** Whether each agent CLI is on the PATH of the user's login shell — which is
 *  the shell panes are spawned in, and not this process's PATH. Keys are agent
 *  kinds. Fails open: an unrunnable shell reports everything as present. */
export const agentCliStatus = (): Promise<Record<string, boolean>> =>
  invoke<Record<string, boolean>>("agent_cli_status");

// ─── Claude usage limits ─────────────────────────────────────────────────────

/** One limit meter (session / weekly-all / per-model weekly). Fields are
 * snake_case to match serde's default serialization, as elsewhere in this app. */
export interface UsageBar {
  kind: string;
  group: string;
  label: string;
  percent: number;
  severity: string;
  resets_at: string | null;
  is_active: boolean;
}

export interface UsageSpend {
  enabled: boolean;
  percent: number;
  used_minor: number;
  limit_minor: number;
  currency: string;
  exponent: number;
  disclaimer: string | null;
}

export interface ClaudeUsage {
  plan: string | null;
  bars: UsageBar[];
  spend: UsageSpend | null;
  fetched_at_ms: number;
}

/** Fetch Claude subscription usage limits (mirrors Claude Code's `/usage`).
 * Backend caches for 180s; pass `force` to skip the local cache on an explicit
 * refresh. Rejects with a friendly message when not signed in / rate-limited. */
export const claudeUsage = (force = false): Promise<ClaudeUsage> =>
  invoke<ClaudeUsage>("claude_usage", { force });

/** Fetch Codex (ChatGPT) usage limits — same shape as Claude's, from the Codex
 * CLI's own `wham/usage` endpoint using its stored login. Same caching/errors. */
export const codexUsage = (force = false): Promise<ClaudeUsage> =>
  invoke<ClaudeUsage>("codex_usage", { force });

/** Grok tokens today + optional sane conversation context, from
 * `~/.grok/sessions`. There is no remaining-quota endpoint. */
export interface GrokUsage {
  available: boolean;
  today_tokens: number;
  context_percent: number | null;
  context_used: number | null;
  context_window: number | null;
  model: string | null;
  fetched_at_ms: number;
}

export const grokUsage = (force = false): Promise<GrokUsage> =>
  invoke<GrokUsage>("grok_usage", { force });

/** Cumulative opencode spend/tokens read from its local SQLite DB. opencode has
 * no remaining-limit endpoint (it's a provider pass-through), so this is
 * spend-to-date, not a limit. `available` is false when opencode isn't set up. */
export interface OpencodeStats {
  available: boolean;
  sessions: number;
  cost: number;
  tokens_input: number;
  tokens_output: number;
  tokens_reasoning: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  fetched_at_ms: number;
}

export const opencodeStats = (): Promise<OpencodeStats> =>
  invoke<OpencodeStats>("opencode_stats");

/** Cumulative Claude Code token spend + a computed USD equivalent, summed from
 * the local session transcripts (`~/.claude/projects/**`) — the same source as
 * Claude Code's own "Usage" view. Local-machine only; `cost_usd` is priced from
 * token counts, so it's an estimate. `available` is false when there are no
 * transcripts. */
export interface ClaudeCodeUsage {
  available: boolean;
  tokens_input: number;
  tokens_output: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  tokens_total: number;
  cost_usd: number;
  fetched_at_ms: number;
}

export const claudeCodeUsage = (force = false): Promise<ClaudeCodeUsage> =>
  invoke<ClaudeCodeUsage>("claude_code_usage", { force });

/** One session's spend inside a window. `session_id` is the attribution key —
 * flock imposes it with `--session-id`, so it maps back to exactly one pane.
 * `cost_usd` is priced from a local table and is an estimate, not an invoice. */
export interface SessionSpend {
  session_id: string;
  /** Directory of the newest turn — the fallback for a session whose pane is
   * gone (closed, or spawned before this app instance started). */
  cwd: string;
  tokens: number;
  cost_usd: number;
  last_ms: number;
}

export interface SpendWindow {
  since_ms: number;
  tokens: number;
  cost_usd: number;
  /** Costliest first. Sums to at most the window totals; the rest is
   * `unattributed_*`. Never add these to a directory grouping of the same
   * window — the backend returns one breakdown precisely so nothing can. */
  sessions: SessionSpend[];
  unattributed_tokens: number;
  unattributed_cost_usd: number;
  /** Spend from turns with no parseable timestamp, so in no window at all.
   * Distinguishes a quiet day from unreadable transcripts. */
  undated_cost_usd: number;
}

export interface SpendWindows {
  /** False when `~/.claude/projects` is missing. Budgets must read this as
   * "unknown", never as "nothing spent". */
  available: boolean;
  /** One per requested cutoff, in the order requested. */
  windows: SpendWindow[];
  fetched_at_ms: number;
}

/** Claude Code spend since each of `sinceMs`, attributed per session, from one
 * pass over the transcripts. Several cutoffs in one call on purpose: computing
 * a day and a month separately lets the two disagree about the same entries. */
export const claudeSpendWindows = (sinceMs: number[]): Promise<SpendWindows> =>
  invoke<SpendWindows>("claude_spend_windows", { sinceMs });

/** How full one claude pane's context window is, read from that session's
 * transcript. `used_tokens` is the last main-thread turn's prompt + completion,
 * i.e. what the next request carries; `window_tokens` is inferred (200k, or 1M
 * once the session proves it can't be on the standard window) because
 * transcripts record neither the window nor the `[1m]` suffix. */
export interface ContextUsage {
  session_id: string;
  used_tokens: number;
  window_tokens: number;
  model: string;
  updated_at_ms: number;
}

/** Batched on purpose — a grid of eight panes costs one round trip per poll.
 * Sessions with no transcript yet are absent from the result, not zeroed. */
export const claudeContextUsage = (sessionIds: string[]): Promise<ContextUsage[]> =>
  invoke<ContextUsage[]>("claude_context_usage", { sessionIds });

/** Temporary diagnostic: write a line into ~/.flock/desktop.log from the
 * frontend so a repro can be traced end-to-end. Remove once the spawn bug is
 * pinned down. */
export const debugLog = (msg: string): void => {
  invoke<void>("debug_log", { msg }).catch(() => {});
};

// ─── Enterprise: graph insights (phase 3) ────────────────────────────────────

/** Headline graph metrics over a trailing window, computed from the telemetry
 * tables (kg_event / kg_usage_snapshot / kg_outcome).
 *
 * `grounding_hits` used to be the headline here and is deliberately gone: it
 * was a lifetime count of bullet lines the grounding hook printed, so it could
 * not fall, and it did not — it climbed through the whole period in which the
 * write half of the graph was dead on every relaunch. See `RecallStats`, which
 * replaces it with windowed figures that can. */
export interface InsightsSummary {
  since: string;
  recall: RecallStats;
  reads: number;
  writes: number;
  outcomes: number;
  /** Whole-account model spend over the window, in minor units. Deliberately
   * not divided by `outcomes` on any graph surface: that ratio moves when you
   * use Claude outside flock and when you merge a typo fix, so it says nothing
   * about the graph. Attributed spend lives in Settings → Usage. */
  cost_minor: number;
  currency: string;
  exponent: number;
}

export const graphInsights = (days: number, kgUrl?: string): Promise<InsightsSummary> =>
  invoke<InsightsSummary>("graph_insights", { days, kgUrl });

// Match each agent CLI's own theme to flock's active theme at spawn time.
//
// opencode's TUI decides light vs. dark by querying the terminal's background
// color (OSC 11); xterm.js never answers that query, so it always falls back to
// a light theme regardless of flock's own dark chrome. OPENCODE_CONFIG_CONTENT
// merges into opencode's config at the highest precedence, so this forces the
// right theme without touching the user's own opencode.jsonc.
//
// Claude Code has no theme env var — it reads ~/.claude/settings.json — so the
// backend maps the app theme id (`theme` on spawn_pane) through theme_pref_for
// and sets FLOCK_CLAUDE_THEME itself. A jailed pane's init.bash applies it to
// a fresh settings.json; on the host it's an inert var (we never rewrite the
// user's global settings.json) and the bundled themes are available via /theme.
function agentThemeEnv(cmd: string): Record<string, string> {
  const app = getEffectiveTheme();
  if (cmd === "opencode") {
    const theme = app === "light" ? "light" : "dark";
    return { OPENCODE_CONFIG_CONTENT: JSON.stringify({ theme }) };
  }
  if (cmd === "grok") {
    // grok ships its own themes and takes one by env, so there is nothing to
    // install and nothing of the user's to rewrite. Two of its five built-ins
    // are near enough to flock's grounds to match; the rest of the app's
    // themes fall to GrokNight, which is the neutral dark it was designed on.
    return { GROK_THEME: app === "light" ? "grokday" : "groknight" };
  }
  return {};
}

export const sendInput = (paneId: string, data: Uint8Array): Promise<void> =>
  invoke<void>("send_input", { paneId, data: Array.from(data) });

/** Write pasted clipboard image bytes into the pane's workspace
 * (`.flock/images/`); returns the workspace-relative path to type. The
 * backend resolves the pane's cwd itself, so the caller only needs the pane id. */
export const stageImageBytes = (paneId: string, data: Uint8Array, ext: string): Promise<string> =>
  invoke<string>("stage_image_bytes", { paneId, data: Array.from(data), ext });

/** Copy a dropped image file into the pane's workspace (`.flock/images/`);
 * returns the workspace-relative path to type. */
export const stageImageFile = (paneId: string, src: string): Promise<string> =>
  invoke<string>("stage_image_file", { paneId, src });

export const resizePty = (paneId: string, rows: number, cols: number): Promise<void> =>
  invoke<void>("resize_pty", { paneId, rows, cols });

/** Clear a pane's "needs input" back to idle after the user focuses it. Resets
 *  the status the backend caches (both status sources dedupe against it), so the
 *  agent's next prompt still raises attention. No-op unless it was awaiting. */
export const ackPaneAttention = (paneId: string): Promise<void> =>
  invoke<void>("ack_pane_attention", { paneId });

export const closePane = (paneId: string): Promise<void> =>
  invoke<void>("close_pane", { paneId });

// ─── External terminal ────────────────────────────────────────────────────────

/** A terminal emulator installed on this machine (see src-tauri/terminals.rs).
 * Returned in picker order — purpose-built terminals first, Terminal.app last. */
export interface TerminalApp {
  id: string;
  name: string;
  path: string;
  /** The app's real icon as a PNG data URI, read out of its bundle. Null when
   * the bundle hides its icon in an asset catalog — callers fall back to the
   * generic terminal glyph. */
  icon: string | null;
}

export const listTerminalApps = (): Promise<TerminalApp[]> =>
  invoke<TerminalApp[]>("list_terminal_apps");

/** Open `dir` in the given installed terminal app — a normal host shell, not a
 * flock pane and never the secure-mode container. */
export const openTerminalAt = (appId: string, dir: string): Promise<void> =>
  invoke<void>("open_terminal_at", { appId, dir });

// ─── Prompt queue ─────────────────────────────────────────────────────────────

// Field names are snake_case to match the Rust `QueueItemRow` response shape
// (this codebase never camelCases response structs — only invoke() params).
export interface QueueItem {
  id: string;
  text: string;
  image_paths: string; // JSON array of staged filenames
  status: "queued" | "launched";
  workspace_id: string | null;
  agent_id: string | null;
  target_label: string | null;
  created_at: number;
  launched_at: number | null;
}

/** Capture a prompt (+ optional pasted screenshots as `[bytes, ext]`) into the
 * queue. Returns the freshly-inserted row. */
export const queueAdd = (
  text: string,
  images: { data: Uint8Array; ext: string }[],
): Promise<QueueItem> =>
  invoke<QueueItem>("queue_add", {
    text,
    imageData: images.map((i) => [Array.from(i.data), i.ext]),
  });

export const queueList = (): Promise<QueueItem[]> => invoke<QueueItem[]>("queue_list");

/** Read an image off the native clipboard (NSPasteboard), PNG-encoded. Returns
 * null when the clipboard holds no image. This is how images copied from Apple
 * Notes get in — they never reach the WebView paste event. */
export const readClipboardImage = async (): Promise<{ data: Uint8Array; ext: string } | null> => {
  const r = await invoke<[number[], string] | null>("read_clipboard_image");
  return r ? { data: new Uint8Array(r[0]), ext: r[1] } : null;
};

/** Read dropped image files (absolute paths) into bytes + ext, skipping
 * non-images. Tauri file drops carry real paths, not DOM Files. */
export const readImageFilesFromPaths = async (
  paths: string[],
): Promise<{ data: Uint8Array; ext: string }[]> => {
  const r = await invoke<[number[], string][]>("read_image_files", { paths });
  return r.map(([d, ext]) => ({ data: new Uint8Array(d), ext }));
};

export const queueUpdateText = (id: string, text: string): Promise<void> =>
  invoke<void>("queue_update_text", { id, text });

export const queueDelete = (id: string): Promise<void> =>
  invoke<void>("queue_delete", { id });

/** Fire a queued prompt into a live pane. Returns the updated (launched) row
 * plus `typed`, the exact text written into that pane's input line — the
 * caller feeds it to the pane's input-line sniffer, since this write never
 * passes through xterm. */
export const queueLaunch = (
  id: string,
  paneId: string,
): Promise<{ row: QueueItem; typed: string }> =>
  invoke<{ row: QueueItem; typed: string }>("queue_launch", { id, paneId });

// ─── Workspace state persistence ────────────────────────────────────────────

export const saveWorkspaceState = (
  workspaceId: string,
  stateJson: string,
): Promise<void> =>
  invoke<void>("save_workspace_state", { workspaceId, stateJson });

/** Returns the saved state JSON string (or empty if none). */
export const restoreWorkspace = (
  workspaceId: string,
): Promise<string> =>
  invoke<string>("restore_workspace", { workspaceId });

export const renameWorkspace = (
  workspaceId: string,
  name: string,
): Promise<void> =>
  invoke<void>("rename_workspace", { workspaceId, name });

export const deleteWorkspaceCmd = (
  workspaceId: string,
): Promise<void> =>
  invoke<void>("delete_workspace", { workspaceId });

// ─── Identity & Friends ───────────────────────────────────────────────────────

export interface IdentityInfo {
  id: string;
  handle: string;
}

export interface FriendRecord {
  id: string;
  handle: string;
  friend_status: string;
  presence: string;
  agent_count: number;
  last_seen: number | null;
  added_at: number;
}

export const getIdentity = (): Promise<IdentityInfo> =>
  invoke<IdentityInfo>("get_identity");

export const setHandle = (handle: string): Promise<void> =>
  invoke<void>("set_handle", { handle });

export const listFriends = (): Promise<FriendRecord[]> =>
  invoke<FriendRecord[]>("list_friends");

export const addFriendCmd = (handle: string): Promise<FriendRecord> =>
  invoke<FriendRecord>("add_friend", { handle });

export const removeFriendCmd = (id: string): Promise<void> =>
  invoke<void>("remove_friend", { id });

// ─── Agent preference / environment ──────────────────────────────────────────

export const getAgentPref = (): Promise<string | null> => invoke<string | null>("get_agent_pref");

export const setAgentPref = (value: string): Promise<void> =>
  invoke<void>("set_agent_pref", { value });

export const hasClaudeSession = (cwd: string): Promise<boolean> =>
  invoke<boolean>("has_claude_session", { cwd });

/** True when `sessionId` has a saved conversation in `cwd` — gate for
 * `claude --resume`, which errors if the session was never actually used. */
export const claudeSessionExists = (cwd: string, sessionId: string): Promise<boolean> =>
  invoke<boolean>("claude_session_exists", { cwd, sessionId });

/** Look up the session id an agent (opencode/codex) generated for a pane in
 * `cwd`, so it can be resumed by id after a restart. Null until it exists. */
export const captureAgentSession = (cmd: string, cwd: string, afterMs: number, exclude: string[]): Promise<string | null> =>
  invoke<string | null>("capture_agent_session", { cmd, cwd, afterMs, exclude });

export const getCwd = (): Promise<string> => invoke<string>("cwd");

// ─── Events ──────────────────────────────────────────────────────────────────

/** Subscribe to a pane's live PTY output over a binary IPC channel: each frame
 * arrives as a raw ArrayBuffer (no JSON number-array encoding, no per-byte
 * parse). When `replay` is true the backend sends the pane's current
 * output-ring snapshot as the first frame — atomically with joining the live
 * set — so a freshly mounted terminal paints the current screen with no
 * snapshot/live race to reconcile. ACP panes pass `replay: false` (they parse
 * the stream as JSON-RPC and must not re-ingest history). Resolves to an
 * unsubscribe function. */
export const subscribePaneOutput = (
  paneId: string,
  onData: (data: Uint8Array) => void,
  replay: boolean,
): Promise<() => void> => {
  const channel = new Channel<ArrayBuffer>();
  channel.onmessage = (buf) => onData(new Uint8Array(buf));
  return invoke<number>("subscribe_pane_output", { paneId, channel, replay }).then(
    (channelId) => () => {
      invoke("unsubscribe_pane_output", { paneId, channelId }).catch(() => {});
    },
  );
};

/** Snapshot every live pane's scrollback to SQLite so it survives a restart. */
export const persistPaneBuffers = (): Promise<void> =>
  invoke<void>("persist_pane_buffers");

/** Read a pane's persisted scrollback by its pre-restart id (empty if none). */
export const getPersistedPaneBuffer = (paneId: string): Promise<number[]> =>
  invoke<number[]>("get_persisted_pane_buffer", { paneId });

export const onPtyExit = (
  paneId: string,
  handler: (exitCode: number) => void,
): Promise<UnlistenFn> =>
  listen<PtyExitPayload>(`pty://exit/${paneId}`, (e) => {
    handler(e.payload.exit_code);
  });

export const onAgentStatus = (
  paneId: string,
  handler: (status: AgentStatusPayload["status"]) => void,
): Promise<UnlistenFn> =>
  listen<AgentStatusPayload>(`agent://status/${paneId}`, (e) => {
    handler(e.payload.status);
  });

// ─── Menu ──────────────────────────────────────────────────────────────────

export const onOpenSettings = (handler: () => void): Promise<UnlistenFn> =>
  listen("menu://settings", () => handler());

// ─── Popped-out pane windows ────────────────────────────────────────────────

export interface PanePopoutClosedEvent {
  workspaceId: string;
  paneId: string;
  /** "return" — window was just dismissed, bring the (still-alive) pane back
   *  into the grid. "closed" — the agent was explicitly closed from the
   *  popout window; remove it entirely, same as the main grid's close button. */
  action: "return" | "closed";
}

export const onPanePopoutClosed = (handler: (e: PanePopoutClosedEvent) => void): Promise<UnlistenFn> =>
  listen<PanePopoutClosedEvent>("pane-popout-closed", (e) => handler(e.payload));

// ─── GitHub ──────────────────────────────────────────────────────────────────

/** Returns `true` if a GitHub PAT is available, without exposing the token
 *  itself to the frontend. The raw token must never cross the IPC boundary. */
export const hasGithubToken = (): Promise<boolean> =>
  invoke<boolean>("has_github_token");

export const githubCheck = (): Promise<GitHubStatus> =>
  invoke<GitHubStatus>("github_check");

export const githubStorePat = (token: string): Promise<void> =>
  invoke<void>("github_store_pat", { token });

export interface DeviceFlowStart {
  user_code: string;
  verification_uri: string;
  device_code: string;
  interval: number;
  expires_in: number;
}

export const githubOauthStart = (clientId: string): Promise<DeviceFlowStart> =>
  invoke<DeviceFlowStart>("github_oauth_start", { clientId });

export const githubOauthPoll = (clientId: string, deviceCode: string, interval: number): Promise<string> =>
  invoke<string>("github_oauth_poll", { clientId, deviceCode, interval });

export const githubDisconnect = (): Promise<void> =>
  invoke<void>("github_disconnect");

export const githubListPrs = (): Promise<PullRequest[]> =>
  invoke<PullRequest[]>("github_list_prs");

// ─── Presence ─────────────────────────────────────────────────────────────────

export interface FriendPresenceEvent { login: string; agent_count: number; }

export const updatePresence = (
  token: string | null,
  friends: string[],
  agentCount: number,
): Promise<void> =>
  invoke<void>("update_presence", { token: token ?? null, friends, agentCount });

export const onFriendOnline = (handler: (e: FriendPresenceEvent) => void) =>
  listen<FriendPresenceEvent>("friends://online", (e) => handler(e.payload));

export const onFriendOffline = (handler: (e: FriendPresenceEvent) => void) =>
  listen<FriendPresenceEvent>("friends://offline", (e) => handler(e.payload));

export const onFriendUpdate = (handler: (e: FriendPresenceEvent) => void) =>
  listen<FriendPresenceEvent>("friends://update", (e) => handler(e.payload));

export const onPresenceDisconnected = (handler: () => void) =>
  listen("friends://disconnected", () => handler());

export interface GhFriend { login: string; avatar_url: string; }
export const githubListFriends = (): Promise<GhFriend[]> =>
  invoke<GhFriend[]>("github_list_friends");

/** One row in the watched-repo picker. */
export interface GithubRepo {
  full_name: string;
  private: boolean;
  fork: boolean;
  description: string | null;
  /** Last push, ISO8601 — the list arrives sorted by it, newest first. */
  pushed_at: string;
}

/** Repos the connected account can see (owner, collaborator, org member),
 *  archived ones dropped. Capped at 500; see `github::list_repos`. */
export const githubListRepos = (): Promise<GithubRepo[]> =>
  invoke<GithubRepo[]>("github_list_repos");

export interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string | null;
}

export interface PrDetails {
  checks: CheckRun[];
  reviews: { author: string; state: string; body: string; submitted_at: string }[];
  /** PR source branch. */
  head_ref: string;
  /** Branch the PR merges into. */
  base_ref: string;
  /** "open" | "closed" as reported by GitHub. */
  state: string;
  merged: boolean;
  /** Whether any review is APPROVED — computed backend-side over the
   * unfiltered review list (`reviews` above drops body-less entries, and
   * plain approvals usually have no body). */
  approved: boolean;
}

export const githubPrDetails = (ownerRepo: string, number: number): Promise<PrDetails> =>
  invoke<PrDetails>("github_pr_details", { ownerRepo, number });

/** The full unified diff for a pull request (raw `git`-format text). */
export const githubPrDiff = (ownerRepo: string, number: number): Promise<string> =>
  invoke<string>("github_pr_diff", { ownerRepo, number });

export interface WorkspaceChecks {
  pr_number: number;
  pr_title: string;
  pr_url: string;
  pr_state: string;
  pr_author: string;
  base_ref: string;
  head_ref: string;
  commits: number;
  additions: number;
  deletions: number;
  checks: CheckRun[];
}

export const githubWorkspaceChecks = (repoPath: string): Promise<WorkspaceChecks | null> =>
  invoke<WorkspaceChecks | null>("github_workspace_checks", { repoPath });

/** All open PRs (any author) for the repo at `repoPath`, resolved via its git remote. */
export const githubWorkspacePrs = (repoPath: string): Promise<PullRequest[]> =>
  invoke<PullRequest[]>("github_workspace_prs", { repoPath });

/** `https://github.com/owner/repo` for `repoPath`, or null if it has no GitHub origin. */
export const githubRepoWebUrl = (repoPath: string): Promise<string | null> =>
  invoke<string | null>("github_repo_web_url", { repoPath });

/** Fetch + checkout a PR's exact head commit into a local branch. */
export const githubCheckoutPr = (repoPath: string, number: number, headRef: string): Promise<void> =>
  invoke<void>("github_checkout_pr", { repoPath, number, headRef });

export interface PrWorktree {
  path: string;
  branch: string;
}

/** Fetch a PR's head into a dedicated git worktree (leaving the repo's own
 * checkout untouched) and return the worktree path + branch. */
export const githubCheckoutPrWorktree = (repoPath: string, number: number, headRef: string): Promise<PrWorktree> =>
  invoke<PrWorktree>("github_checkout_pr_worktree", { repoPath, number, headRef });

// ─── Voice-to-text ──────────────────────────────────────────────────────────

export const voiceGetEnabled = (): Promise<boolean> => invoke<boolean>("voice_get_enabled");

export const voiceSetEnabled = (enabled: boolean): Promise<void> =>
  invoke<void>("voice_set_enabled", { enabled });

export interface VoiceModelStatus {
  downloaded: boolean;
}

export const voiceModelStatus = (): Promise<VoiceModelStatus> =>
  invoke<VoiceModelStatus>("voice_model_status");

export const voiceDownloadModel = (): Promise<void> => invoke<void>("voice_download_model");

export interface VoiceModelOption {
  id: string;
  label: string;
  size_mb: number;
}

export const voiceAvailableModels = (): Promise<VoiceModelOption[]> =>
  invoke<VoiceModelOption[]>("voice_available_models");

export const voiceGetModel = (): Promise<string> => invoke<string>("voice_get_model");

export const voiceSetModel = (id: string): Promise<void> => invoke<void>("voice_set_model", { id });

export const voiceListInputDevices = (): Promise<string[]> => invoke<string[]>("voice_list_input_devices");

/** `null` means "use the system default input device". */
export const voiceGetInputDevice = (): Promise<string | null> => invoke<string | null>("voice_get_input_device");

export const voiceSetInputDevice = (name: string | null): Promise<void> =>
  invoke<void>("voice_set_input_device", { name });

export interface VoiceDownloadProgress {
  downloaded: number;
  total: number;
}

export const onVoiceDownloadProgress = (handler: (p: VoiceDownloadProgress) => void): Promise<UnlistenFn> =>
  listen<VoiceDownloadProgress>("voice://download-progress", (e) => handler(e.payload));

export const voiceStartRecording = (): Promise<void> => invoke<void>("voice_start_recording");

/** Stops recording, runs local transcription, and returns the resulting text (empty if too short/silent). */
export const voiceStopRecording = (): Promise<string> => invoke<string>("voice_stop_recording");

/** Loads the Whisper model into memory ahead of first use so the first dictation transcribes instantly. */
export const voicePrewarm = (): Promise<void> => invoke<void>("voice_prewarm");

export interface VoiceStats {
  total_words: number;
  total_dictations: number;
  total_duration_secs: number;
}

export const voiceGetStats = (): Promise<VoiceStats> => invoke<VoiceStats>("voice_get_stats");

/** 0–1 mic input level, emitted ~30x/sec while recording — drives the HUD's soundwave. */
export const onVoiceLevel = (handler: (level: number) => void): Promise<UnlistenFn> =>
  listen<number>("voice://level", (e) => handler(e.payload));

/** Fired when a dictation captured only silence — macOS denied the mic
 *  (missing permission/entitlement) without raising any error. */
export const onVoiceNoAudio = (handler: () => void): Promise<UnlistenFn> =>
  listen<void>("voice://no-audio", () => handler());

/** Live draft transcript while recording — re-transcribed as audio grows,
 *  superseded by the final pass on release. Display-only. */
export const onVoicePartial = (handler: (text: string) => void): Promise<UnlistenFn> =>
  listen<string>("voice://partial", (e) => handler(e.payload));

/** "auto" or an ISO 639-1 code; English-only models ignore it. */
export const voiceGetLanguage = (): Promise<string> => invoke<string>("voice_get_language");
export const voiceSetLanguage = (lang: string): Promise<void> =>
  invoke<void>("voice_set_language", { lang });

/** User vocabulary (newline/comma separated) merged into Whisper's prompt. */
export const voiceGetVocab = (): Promise<string> => invoke<string>("voice_get_vocab");
export const voiceSetVocab = (text: string): Promise<void> =>
  invoke<void>("voice_set_vocab", { text });

/** Filler-word removal ("um", "uh") on transcripts. Defaults on. */
export const voiceGetCleanup = (): Promise<boolean> => invoke<boolean>("voice_get_cleanup");
export const voiceSetCleanup = (enabled: boolean): Promise<void> =>
  invoke<void>("voice_set_cleanup", { enabled });

// ─── Git ───────────────────────────────────────────────────────────────────

export interface GitFileChange {
  path: string;
  /** Friendly one-letter status: M, A, D, R, C, U (conflict), ? (untracked). */
  status: string;
  staged: boolean;
}

export interface GitCommit {
  hash: string;
  short: string;
  parents: string[];
  refs: string[];
  is_head: boolean;
  subject: string;
  author: string;
  date: string;
}

export interface GitOverview {
  is_repo: boolean;
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  changes: GitFileChange[];
  commits: GitCommit[];
}

/** Read-only snapshot of a repo's branch, working-tree status, and recent commits. */
export const gitOverview = (repoPath: string): Promise<GitOverview> =>
  invoke<GitOverview>("git_overview", { repoPath });

/** The repo's live current branch (empty string if it can't be resolved). */
export const currentBranch = (repoPath: string): Promise<string> =>
  invoke<string>("current_branch", { repoPath });

/** One checkout of the repo — the main working copy or a linked worktree. */
export interface WorktreeStatus {
  /** Absolute path; matches a pane's cwd when an agent owns this checkout. */
  path: string;
  /** Branch checked out here; empty when HEAD is detached. */
  branch: string;
  /** Short HEAD sha — display fallback for detached checkouts. */
  head: string;
  is_main: boolean;
  detached: boolean;
  locked: boolean;
  /** Directory is gone/stale — `git worktree prune` would drop it. */
  prunable: boolean;
  /** Count of changed files (staged + unstaged + untracked). */
  dirty: number;
  ahead: number;
  behind: number;
}

export interface BranchInfo {
  name: string;
  /** Worktree where this branch is checked out, if anywhere. */
  worktree_path: string | null;
}

/** Every checkout of the repo plus every local branch and who holds it. */
export interface RepoMap {
  is_repo: boolean;
  worktrees: WorktreeStatus[];
  branches: BranchInfo[];
}

/** One-call snapshot of all worktrees (with live branch + status) and local
 * branches — the data behind the per-agent branch UI. */
export const gitRepoMap = (repoPath: string): Promise<RepoMap> =>
  invoke<RepoMap>("git_repo_map", { repoPath });

/** The refs a new workspace can branch from or check out. */
export interface BranchOptions {
  is_repo: boolean;
  /** Branch checked out in the main working copy; empty when detached. */
  current: string;
  /** The repo's default branch as a base ref ("origin/main"). */
  default_ref: string;
  local: BranchInfo[];
  /** Remote-tracking branches ("origin/main"), minus each remote's symbolic HEAD. */
  remote: string[];
}

/** Local + remote refs plus the repo's default branch. Lighter than
 * `gitRepoMap` (no per-worktree status probes) — meant for dialogs. */
export const gitBranchOptions = (repoPath: string): Promise<BranchOptions> =>
  invoke<BranchOptions>("git_branch_options", { repoPath });

/** Update a remote-tracking base ref before branching from it. Non-interactive
 * and time-capped in the backend; a local ref is a no-op. */
export const gitFetchBase = (repoPath: string, baseRef: string): Promise<void> =>
  invoke<void>("git_fetch_base", { repoPath, baseRef });

/** A repo's stored worktree setup command, plus a lockfile-derived suggestion. */
export interface SetupInfo {
  command: string;
  /** No answer stored for this repo yet — the dialog prefills `suggestion`. */
  unset: boolean;
  suggestion: string;
}

export const worktreeSetupGet = (repoPath: string): Promise<SetupInfo> =>
  invoke<SetupInfo>("worktree_setup_get", { repoPath });

/** Record a repo's setup command. "" is a real answer ("nothing to run here")
 * and stops the suggestion being offered again. */
export const worktreeSetupSet = (repoPath: string, command: string): Promise<void> =>
  invoke<void>("worktree_setup_set", { repoPath, command });

/** Commits on `branch` unreachable from any other ref — what would be lost if
 * the branch were deleted. */
export const branchUnmergedCount = (repoPath: string, branch: string): Promise<number> =>
  invoke<number>("branch_unmerged_count", { repoPath, branch });

/** Full working-tree diff (staged + unstaged + untracked) as raw unified-diff text. */
export const gitWorkingDiff = (repoPath: string): Promise<string> =>
  invoke<string>("git_working_diff", { repoPath });

/** The commit HEAD is on, full sha ("" when it can't be resolved). A race pins
 * its comparison base to this so later commits on the main checkout can't move
 * it out from under the contenders' diffs. */
export const gitHeadSha = (repoPath: string): Promise<string> =>
  invoke<string>("git_head_sha", { repoPath });

/** Everything the checkout at `workPath` has done since `base` — committed,
 * staged, unstaged and untracked — as raw unified-diff text. Rejects (rather
 * than answering "no changes") when `base` doesn't resolve there. */
export const gitDiffAgainst = (workPath: string, base: string): Promise<string> =>
  invoke<string>("git_diff_against", { workPath, base });

/** Commit everything in a checkout onto whatever branch it has out; resolves to
 * whether there was anything to commit. Run before tearing a losing
 * contender's worktree down — `git worktree remove` refuses to discard
 * uncommitted work, and this keeps that work on the branch for anyone who
 * chose to keep the branches. */
export const gitCommitAll = (workPath: string, message: string): Promise<boolean> =>
  invoke<boolean>("git_commit_all", { workPath, message });

export interface MergeReport {
  /** `worktreePath` had uncommitted work, committed onto its branch first. */
  committed: boolean;
  merged: boolean;
  /** Conflicted paths. Non-empty only when `merged` is false, by which point
   * the merge has been aborted — the checkout is back where it started. */
  conflicts: string[];
  /** git's own one-line reason when `merged` is false. */
  message: string;
}

/** Merge `branch` into the repo's current checkout, committing whatever the
 * agent left uncommitted in `worktreePath` onto that branch first. */
export const gitMergeBranch = (
  repoPath: string,
  worktreePath: string | null,
  branch: string,
  message: string,
): Promise<MergeReport> =>
  invoke<MergeReport>("git_merge_branch", { repoPath, worktreePath, branch, message });

/** Summarize a captured first-prompt into a short task label via the `claude`
 * CLI in headless mode. Best-effort: resolves to null (keep the raw prompt) if
 * claude isn't installed, times out, or replies empty. */
export const summarizeIntent = (text: string): Promise<string | null> =>
  invoke<string | null>("summarize_intent", { text });

// ─── Git worktrees ─────────────────────────────────────────────────────────

export interface CreateWorktreeOpts {
  /** Overrides the default `~/.flock/worktrees/` parent. */
  baseDir?: string | null;
  /** Ref the new branch is cut from ("origin/main"). Omit for current HEAD. */
  baseRef?: string | null;
  /** Check `branch` out as-is instead of creating it. */
  existing?: boolean;
  /** Repo-relative patterns of gitignored files to copy in from the main
   * checkout (`.env*`), so the agent isn't missing local config. */
  carry?: string[];
}

/** Creates a git worktree for `repoPath` on `branch`. Returns its absolute path.
 * Rejects with git's own reason (branch already exists, unknown base ref, …). */
export const createWorktree = (repoPath: string, branch: string, opts: CreateWorktreeOpts = {}): Promise<string> =>
  invoke<string>("create_worktree", {
    repoPath,
    branch,
    baseDir: opts.baseDir ?? null,
    baseRef: opts.baseRef ?? null,
    existing: opts.existing ?? false,
    carry: opts.carry ?? null,
  });

/** Best-effort cleanup — removes the worktree (and its branch, if `deleteBranch`). Safe to fire-and-forget. */
export const removeWorktree = (repoPath: string, worktreePath: string, branch: string, deleteBranch: boolean): Promise<void> =>
  invoke<void>("remove_worktree", { repoPath, worktreePath, branch, deleteBranch });

/** Switch the checkout at `worktreePath` to `branch` (creating it from HEAD
 * when `create`). Rejects with git's own one-line reason — e.g. the branch is
 * already used by another worktree, or local changes would be clobbered. */
export const checkoutInWorktree = (worktreePath: string, branch: string, create: boolean): Promise<void> =>
  invoke<void>("checkout_in_worktree", { worktreePath, branch, create });

// ─── Agent hooks (Claude Code / Codex) ─────────────────────────────────────

export type HookAgent = "claude" | "codex" | "grok";

/** Writes hook entries into the agent's own settings file (`~/.claude/settings.json` or `~/.codex/hooks.json`). Idempotent — safe to call again to refresh. */
export const installAgentHook = (agent: HookAgent): Promise<void> =>
  invoke<void>("install_agent_hook", { agent });

/** Removes exactly the hook entries we installed, leaving any hooks the user configured themselves untouched. */
export const uninstallAgentHook = (agent: HookAgent): Promise<void> =>
  invoke<void>("uninstall_agent_hook", { agent });

export const agentHookStatus = (agent: HookAgent): Promise<boolean> =>
  invoke<boolean>("agent_hook_status", { agent });

export interface HookEvent {
  time: number;
  agent: HookAgent;
  event: "SessionStart" | "UserPromptSubmit" | "Stop" | "Notification";
  pane_id: string;
  /** Notification only: the agent's own wording for why it spoke up. Claude
   * Code fires this event both for a real ask ("Claude needs your permission
   * to use Bash") and for a nudge a minute after any agent goes quiet
   * ("Claude is waiting for your input") — only the message separates them.
   * Absent on events logged by a hook installed before flock forwarded it. */
  message?: string;
}

/** Fires whenever an installed hook reports agent activity (session start, prompt submitted, turn finished, etc). */
export const onHookEvent = (handler: (e: HookEvent) => void): Promise<UnlistenFn> =>
  listen<HookEvent>("hook://event", (e) => handler(e.payload));

// ─── flock Graph ─────────────────────────────────────────────────────────────

export interface GraphStatus {
  /** Path to the docker CLI, or null when it isn't installed. Distinct from
   *  `docker_ready` on purpose: "not installed" and "installed but stopped"
   *  need different things from the user. */
  docker_cli: string | null;
  /** The daemon answers `docker info`. */
  docker_ready: boolean;
  container_running: boolean;
  db_reachable: boolean;
  mcp_binary: string | null;
  kg_url: string;
}

export const graphStatus = (kgUrl?: string): Promise<GraphStatus> =>
  invoke<GraphStatus>("graph_status", { kgUrl: kgUrl ?? null });
export const graphUp = (): Promise<void> => invoke<void>("graph_up");
export const graphDown = (): Promise<void> => invoke<void>("graph_down");

export interface GraphKgNode {
  id: string;
  kind: string;
  label: string;
  body: string | null;
  workspace_id: string | null;
  created_by_agent: string | null;
  created_at: string;
  /** Last content edit (title-upserts bump this). */
  updated_at: string;
  /** Set by kg.forget; archived knowledge is hidden from reads. */
  archived_at: string | null;
  /** Attempt outcome ("success" | "failure" | "partial"); null otherwise. */
  outcome: string | null;
  /** Decision only: the merged-PR stamp (title · url) that realized it. */
  shipped_in: string | null;
}

export interface GraphOverview {
  stats: {
    total: number;
    decisions: number;
    attempts: number;
    files: number;
    /** Free-form remembered knowledge (Note + Interface nodes). */
    notes: number;
    /** Distinct authors (agents) of knowledge in this scope. */
    contributors: number;
    latest: GraphKgNode | null;
  };
}

export const graphOverview = (workspaceId?: string, kgUrl?: string): Promise<GraphOverview> =>
  invoke<GraphOverview>("graph_overview", { workspaceId: workspaceId ?? null, kgUrl: kgUrl ?? null });

export interface GraphNeighbor {
  node: GraphKgNode;
  edge_type: string;
  /** "out" when the anchor node is the edge's source, "in" when the target. */
  direction: "out" | "in";
}

/** Graph Explorer: browse/search nodes. Empty `query` → most recent. */
export const graphListNodes = (args: {
  workspaceId?: string | null;
  kind?: string | null;
  query?: string | null;
  limit?: number;
}, kgUrl?: string): Promise<GraphKgNode[]> =>
  invoke<GraphKgNode[]>("graph_list_nodes", {
    workspaceId: args.workspaceId ?? null,
    kind: args.kind ?? null,
    query: args.query ?? null,
    limit: args.limit ?? null,
    kgUrl: kgUrl ?? null,
  });

/** Graph Explorer: a node's immediate neighbors (both directions). */
export const graphNodeNeighbors = (nodeId: string, kgUrl?: string): Promise<GraphNeighbor[]> =>
  invoke<GraphNeighbor[]>("graph_node_neighbors", { nodeId, kgUrl: kgUrl ?? null });

export interface GraphEdge {
  from: string;
  to: string;
  edge_type: string;
}

export interface GraphSubgraph {
  nodes: GraphKgNode[];
  edges: GraphEdge[];
}

/** Graph Explorer: nodes + edges for the force-directed map. */
export const graphSubgraph = (workspaceId?: string | null, limit?: number, kgUrl?: string): Promise<GraphSubgraph> =>
  invoke<GraphSubgraph>("graph_subgraph", { workspaceId: workspaceId ?? null, limit: limit ?? null, kgUrl: kgUrl ?? null });

/** One fact a grounding pass injected, resolved to the node's current state —
 * so a fact that has since been retracted or replaced reads as such. */
export interface GroundedFact {
  id: string;
  kind: string;
  label: string;
  body: string | null;
  archived: boolean;
  superseded: boolean;
}

export interface GroundingPass {
  ts: string;
  workspace_id: string | null;
  agent_id: string | null;
  facts: GroundedFact[];
}

export interface RecallCount {
  id: string;
  kind: string;
  label: string;
  recalls: number;
}

/** The windowed recall figures, shared by the Recall view and the Insights
 * panel so one graph cannot be described two ways.
 *
 * What they count, exactly:
 *  - `ground_passes` — grounding passes in the window that recorded which
 *    facts they surfaced; `passes_unrecorded` are older passes that cannot say
 *    and are excluded from every other figure here rather than guessed at.
 *  - `silent_passes` — of those, the ones that surfaced nothing. The
 *    denominator every previous version of this readout dropped.
 *  - `facts_injected` — total facts put into prompts. Volume, not value: the
 *    same three facts across a hundred prompts is 300.
 *  - `facts_recalled` / `knowledge_total` — coverage: the share of recorded
 *    knowledge that anything read back in the window. The only figure here
 *    that falls when the graph stops working.
 *
 * What none of them proves: that grounding changed an agent's output. They
 * measure retrieval and injection. Establishing an effect on the answer needs
 * an A/B against the same prompts with grounding off, and we have not run one. */
export interface RecallStats {
  ground_passes: number;
  passes_with_facts: number;
  silent_passes: number;
  facts_injected: number;
  facts_recalled: number;
  knowledge_total: number;
  passes_unrecorded: number;
}

export interface RecallReport {
  passes: GroundingPass[];
  top: RecallCount[];
  stats: RecallStats;
}

/** What grounding actually surfaced: recent passes with their facts, the
 * recall leaderboard, and how much recorded knowledge is ever read back. */
export const graphRecall = (workspaceId?: string | null, days?: number, kgUrl?: string): Promise<RecallReport> =>
  invoke<RecallReport>("graph_recall", {
    workspaceId: workspaceId ?? null,
    days: days ?? null,
    kgUrl: kgUrl ?? null,
  });

/** Grounding brief for a workspace (empty string when nothing recorded yet). */
export const graphBrief = (workspaceId: string, kgUrl?: string): Promise<string> =>
  invoke<string>("graph_brief", { workspaceId, kgUrl: kgUrl ?? null });

/** Mirror the active flock ID org/team into the local graph (same UUIDs as
 * the server) so spawns carry FLOCK_ORG_ID/TEAM_ID. Resolves false when the
 * engine is down — retry on the next sync, never an error. */
export const graphMirrorMembership = (args: {
  orgId: string;
  orgName: string;
  teamId?: string | null;
  teamName?: string | null;
  role: string;
}): Promise<boolean> =>
  invoke<boolean>("graph_mirror_membership", {
    orgId: args.orgId,
    orgName: args.orgName,
    teamId: args.teamId ?? null,
    teamName: args.teamName ?? null,
    role: args.role,
  });

export interface McpConfig { mcp_path: string | null; kg_url: string; }

/** Sidecar path + KG url, for auto-registering the graph MCP server at spawn. */
export const graphMcpConfig = (kgUrl?: string): Promise<McpConfig> =>
  invoke<McpConfig>("graph_mcp_config", { kgUrl: kgUrl ?? null });

/** Install/remove the per-prompt grounding hook (UserPromptSubmit →
 * `flock-mcp ground`) to match the graph toggle. Idempotent. */
export const graphGroundHook = (enable: boolean, kgUrl?: string): Promise<boolean> =>
  invoke<boolean>("graph_ground_hook", { enable, kgUrl: kgUrl ?? null });

// ─── PR watch / auto-review / merge queue ────────────────────────────────────
// State lives backend-side in ~/.flock/pr_watch.json (see pr_watch.rs) so
// watched repos, the seen-PR set, review summaries, and the merge queue all
// survive restarts and are shared by every window.

export interface PrWatchConfig {
  /** "owner/repo" slugs polled for new PRs (beyond open workspaces' repos). */
  repos: string[];
  /** Spawn a review agent automatically when a new PR appears. */
  auto_review: boolean;
  merge_method: "squash" | "merge" | "rebase";
  /** Queue tick: when the head PR is merely behind its base, request a
   * branch update instead of blocking. Defaults false (explicit opt-in —
   * it pushes commits to the PR branch). */
  auto_update_branch?: boolean;
}

export const prWatchGetConfig = (): Promise<PrWatchConfig> =>
  invoke<PrWatchConfig>("pr_watch_get_config");

export const prWatchSetConfig = (config: PrWatchConfig): Promise<void> =>
  invoke<void>("pr_watch_set_config", { config });

export interface PrWatchPoll {
  prs: PullRequest[];
  /** "repo#number" keys never seen before this poll (empty on a repo's first
   * poll — pre-existing PRs are seeded as seen so adding a repo can't storm). */
  fresh: string[];
}

/** Open PRs across all watched repos, plus which ones are new since last poll. */
export const prWatchPoll = (): Promise<PrWatchPoll> =>
  invoke<PrWatchPoll>("pr_watch_poll");

export interface PrReviewSummary {
  summary: string;
  updated_at: string;
  pane_id: string | null;
}

/** Persist an agent-review summary for "repo#number". */
export const prReviewSetSummary = (repo: string, number: number, summary: string, paneId: string | null): Promise<void> =>
  invoke<void>("pr_review_set_summary", { repo, number, summary, paneId });

/** All stored review summaries, keyed "repo#number". */
export const prReviewGetSummaries = (): Promise<Record<string, PrReviewSummary>> =>
  invoke<Record<string, PrReviewSummary>>("pr_review_get_summaries");

/** One-shot LLM summary of a review agent's terminal output (verdict + key
 * findings). Same claude-CLI mechanism as summarizeIntent; null on failure. */
export const summarizeReview = (text: string): Promise<string | null> =>
  invoke<string | null>("summarize_review", { text });

/** Submit an APPROVE review on the PR as the connected GitHub user. */
export const githubApprovePr = (repo: string, number: number, body?: string): Promise<void> =>
  invoke<void>("github_approve_pr", { repo, number, body: body ?? null });

/** Merge the PR now with the given method ("squash" | "merge" | "rebase"). */
export const githubMergePr = (repo: string, number: number, method: string): Promise<void> =>
  invoke<void>("github_merge_pr", { repo, number, method });

export type MergeQueueStatus =
  | "waiting"          // not at the head yet
  | "checks_pending"   // head of queue, waiting on CI
  | "rebasing"         // head of queue, branch update requested, waiting for it to land
  | "blocked"          // head of queue but unapproved / failing / conflicted
  | "merging"          // merge request in flight
  | "merged"
  | "failed";

export interface MergeQueueItem {
  repo: string;
  number: number;
  title: string;
  position: number;
  status: MergeQueueStatus;
  /** Human-readable reason for blocked/failed. */
  note: string | null;
}

export const mergeQueueList = (): Promise<MergeQueueItem[]> =>
  invoke<MergeQueueItem[]>("merge_queue_list");

export const mergeQueueAdd = (repo: string, number: number, title: string): Promise<MergeQueueItem[]> =>
  invoke<MergeQueueItem[]>("merge_queue_add", { repo, number, title });

export const mergeQueueRemove = (repo: string, number: number): Promise<MergeQueueItem[]> =>
  invoke<MergeQueueItem[]>("merge_queue_remove", { repo, number });

/** Move an item to a new 0-based position; others shift. */
export const mergeQueueReorder = (repo: string, number: number, position: number): Promise<MergeQueueItem[]> =>
  invoke<MergeQueueItem[]>("merge_queue_reorder", { repo, number, position });

/** Evaluate the queue head: approved + checks green → merge (using the
 * configured merge method) and advance; otherwise update its status/note.
 * With auto_update_branch on, a head that's merely behind its base gets a
 * branch update ("rebasing") instead of blocking. Called on the frontend PR
 * poll cadence — no backend daemon. */
export const mergeQueueTick = (): Promise<MergeQueueItem[]> =>
  invoke<MergeQueueItem[]>("merge_queue_tick");

/** Latest review per reviewer (APPROVED / CHANGES_REQUESTED / COMMENTED). */
export interface PrApproval { author: string; state: string; submitted_at: string }

/** Everything the merge-queue manager shows for one queued PR. */
export interface MergeQueueItemDetail {
  item: MergeQueueItem;
  /** GitHub's computed merge flag; null while GitHub is still computing it. */
  mergeable: boolean | null;
  /** clean | dirty (conflicts) | behind | blocked | unstable | draft | unknown. */
  mergeable_state: string;
  checks: CheckRun[];
  approvals: PrApproval[];
  /** Conflicting paths from a local `git merge-tree` dry run against the base
   * branch — only populated when the PR is dirty AND a local checkout of the
   * repo was supplied via repoPaths; empty otherwise. */
  conflict_files: string[];
  base_ref: string;
  head_ref: string;
}

/** Rich state for every queued item, for the merge-queue modal. `repoPaths`
 * maps "owner/repo" → a local checkout path, enabling conflict analysis for
 * repos that have an open workspace; pass {} to skip it. */
export const mergeQueueInspect = (repoPaths: Record<string, string>): Promise<MergeQueueItemDetail[]> =>
  invoke<MergeQueueItemDetail[]>("merge_queue_inspect", { repoPaths });

/** Ask GitHub to update the PR's head branch from base (the "Update branch"
 * button — merge or rebase per repo settings). 422 with a readable message
 * when conflicts make it impossible. */
export const githubUpdatePrBranch = (repo: string, number: number): Promise<void> =>
  invoke<void>("github_update_pr_branch", { repo, number });

// ─── Provenance ─────────────────────────────────────────────────────────────
//
// The durable record of what the fleet did: one row per agent session, written
// by the backend from its own live pane map (see src-tauri/src/provenance.rs
// for why that, and not the machine-wide hooks log, is what decides ownership).
//
// Nothing here carries prompt text, agent output or file contents — `prompts`
// is a count. That is a property of the table, not of this projection.

/** One status transition, as recorded. Only present on the JSON export. */
export interface ProvenanceStatusChange { at: number; status: string }

/** One agent session, start to finish. Timestamps are epoch seconds. */
export interface ProvenanceSession {
  id: string;
  pane_id: string;
  workspace_id: string;
  /** Snapshotted at spawn — the row outlives the workspace it names. */
  workspace_name: string;
  agent_name: string;
  /** claude | opencode | codex | pi */
  agent_kind: string;
  person_id: string;
  person_name: string;
  repo_id: string;
  repo_name: string;
  cwd: string;
  branch: string;
  /** The agent worked in a git worktree of its own, not the shared checkout. */
  worktree: boolean;
  /** The agent ran inside the Docker jail (Secure mode). */
  secure: boolean;
  transcript_ref: string;
  started_at: number;
  ended_at: number | null;
  updated_at: number;
  /** running | closed | exited | interrupted */
  outcome: string;
  prompts: number;
  last_status: string;
  tokens_input: number;
  tokens_output: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  /** Micros, so a total can be summed without float drift. An estimate. */
  cost_usd_micros: number;
  status_history: ProvenanceStatusChange[];
}

export interface ProvenanceTotals {
  sessions: number;
  prompts: number;
  tokens: number;
  cost_usd_micros: number;
}

export interface ProvenanceReport {
  sessions: ProvenanceSession[];
  totals: ProvenanceTotals;
  /** The window held more sessions than the backend will return in one go. */
  truncated: boolean;
}

/** Sessions overlapping [from, to) in epoch seconds, newest first, with the
 * window's totals. Overlap rather than "started in the window": an agent left
 * running overnight belongs in both days' reports. Refreshes the token counts
 * of still-live panes before it answers. */
export const provenanceReport = (from: number, to: number, limit?: number): Promise<ProvenanceReport> =>
  invoke<ProvenanceReport>("provenance_report", { from, to, limit });

export interface ProvenanceExportResult { path: string; sessions: number; bytes: number }

/** Write the export for [from, to) to `dest`, which must be an absolute path
 * whose extension matches `format` and whose folder already exists — the
 * backend refuses anything else rather than acting as a write-anywhere
 * primitive. Pick `dest` with the native save dialog. */
export const provenanceExport = (
  from: number,
  to: number,
  format: "csv" | "json",
  dest: string,
): Promise<ProvenanceExportResult> =>
  invoke<ProvenanceExportResult>("provenance_export", { from, to, format, dest });
