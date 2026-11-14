// The real App, in a browser, with Tauri's IPC mocked — for looking at the UI
// (and screenshotting it) without the desktop shell, a sign-in, or agents.
//
//   npm run ui:harness        → http://localhost:1430/harness.html
//   ?theme=light|dark  ?view=new|settings  ?empty=1  ?live=1 (agents' hook activity)
//
// Seeded with a realistic room: four projects, threads in every state, a grid
// thread with two agents, and terminals that paint a Claude Code-like screen.
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";

type Args = Record<string, unknown>;
const params = new URLSearchParams(location.search);
const HOME = "/Users/remi/git";

localStorage.setItem("flock:ai-titles", "0");
if (params.get("changes")) localStorage.setItem("flock:v2-changes", "1");
localStorage.setItem("flock:sidebar-collapsed", params.get("sidebar") === "closed" ? "1" : "0");
if (params.get("graph")) localStorage.setItem("flock:graph-enabled", "1");
if (params.get("theme")) {
  localStorage.setItem("flock:theme-follow-system", "0");
  localStorage.setItem("flock:theme", params.get("theme")!);
}

const workspaces = params.get("empty")
  ? []
  : [
      { id: "ws-lucy", name: "lucy-ui", repo_path: `${HOME}/lucy-ui`, branch: "main", created_at: 1 },
      { id: "ws-git", name: "git", repo_path: `${HOME}`, branch: "", created_at: 2 },
      { id: "ws-wink", name: "wink", repo_path: `${HOME}/wink`, branch: "feat/onboarding", created_at: 3 },
      { id: "ws-flock", name: "flock-code", repo_path: `${HOME}/flock-code`, branch: "v2", created_at: 4 },
    ];

const leaf = (paneId: string) => ({ type: "leaf", paneId });
const tab = (id: string, name: string, panes: string[], renamed = true) => ({
  id,
  name,
  renamed,
  layoutTree:
    panes.length === 1
      ? leaf(panes[0])
      : { type: "split", dir: "horizontal", ratio: 0.5, first: leaf(panes[0]), second: leaf(panes[1]) },
  focusedPaneId: panes[0],
  zoomedPaneId: null,
});
const pane = (id: string, displayName: string, cwd: string, intent?: string, cmd = "claude") => ({
  id, cmd, args: [], cwd, displayName, intent, sessionId: cmd === "claude" ? `0000000${id.length}-aaaa-bbbb-cccc-${id.padEnd(12, "0").slice(0, 12)}` : undefined,
});

const saved: Record<string, unknown> = {
  "ws-lucy": {
    agentKind: "claude",
    focusedTabId: "t-ui",
    tabs: [
      tab("t-ui", "UI", ["p-ui-1", "p-ui-2"]),
      tab("t-notif", "notification", ["p-notif"]),
      tab("t-search", "search", ["p-search"]),
      tab("t-video", "video", ["p-video"]),
      tab("t-docs", "1", ["p-docs"], false),
    ],
    panes: [
      pane("p-ui-1", "Pluto", `${HOME}/lucy-ui`, "Make the settings page one list of pages"),
      pane("p-ui-2", "Hazel", `${HOME}/lucy-ui`, "Fix the composer send inset"),
      pane("p-notif", "Orion", `${HOME}/lucy-ui`, "Email switches in Settings"),
      pane("p-search", "Juno", `${HOME}/lucy-ui`, "Search chats while you type"),
      pane("p-video", "Vega", `${HOME}/lucy-ui`, "Video player keyboard shortcuts", "codex"),
      pane("p-docs", "Lyra", `${HOME}/lucy-ui`, "Automate docs updates with a CI hook"),
    ],
  },
  "ws-git": {
    agentKind: "claude",
    focusedTabId: "t-g1",
    tabs: [tab("t-g1", "1", ["p-g1"], false)],
    panes: [pane("p-g1", "Atlas", HOME, "Clean up old worktrees across repos")],
  },
  "ws-wink": {
    agentKind: "claude",
    focusedTabId: "t-w1",
    tabs: [tab("t-w1", "1", ["p-w1"], false), tab("t-w2", "1", ["p-w2"], false)],
    panes: [
      pane("p-w1", "Nova", `${HOME}/wink`, "Onboarding flow for new teams"),
      pane("p-w2", "Rhea", `${HOME}/wink`, undefined, "grok"),
    ],
  },
  "ws-flock": {
    agentKind: "claude",
    focusedTabId: "t-f1",
    tabs: [tab("t-f1", "1", ["p-f1"], false)],
    panes: [pane("p-f1", "Echo", `${HOME}/flock-code`, "Flock v2: simpler shell, live-only terminals")],
  },
};

// ?live=1: what each agent's hooks report once it is up (see v2/live.ts) — a
// tool on a file, a page in Wink, a to-do list, a finished turn, a failed one.
const LIVE: Record<string, Array<Record<string, unknown>>> = {
  Pluto: [
    { event: "PreToolUse", tool: "TodoWrite", todos_done: 2, todos_total: 5 },
    { event: "PreToolUse", tool: "mcp__wink__navigate", url: "http://localhost:5173/settings", detail: "http://localhost:5173/settings" },
    { event: "PreToolUse", tool: "Edit", detail: "src/settings/Settings.tsx" },
  ],
  Juno: [{ event: "PreToolUse", tool: "Bash", detail: "Run the search tests" }],
  Lyra: [{ event: "UserPromptSubmit" }, { event: "StopFailure", error: "rate_limit", error_details: "429 Too Many Requests" }],
};
// ?live=1: agents whose turn finishes a moment after they start.
const FINISH = new Set(["Hazel", "Atlas"]);

let staged = 0;

// What each agent is doing once it is up, by its name.
const STATUS: Record<string, string> = {
  Pluto: "working",
  Hazel: "idle",
  Orion: "awaiting_input",
  Juno: "working",
  Vega: "idle",
  Lyra: "idle",
  Atlas: "idle",
  Nova: "working",
  Rhea: "idle",
  Echo: "working",
};
const paneNames = new Map<string, string>();

const enc = new TextEncoder();
const fg = (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`;
const R = "\x1b[0m";
const DIM = "\x1b[2m";
const ACCENT = fg(215, 119, 87);
function screen(name: string, task: string, cwd: string): string {
  const w = 56;
  const line = (s: string) => `${DIM}│${R} ${s}${" ".repeat(Math.max(0, w - 3 - [...s.replace(/\x1b\[[0-9;]*m/g, "")].length))}${DIM}│${R}\r\n`;
  return [
    "\x1b[?1049h\x1b[2J\x1b[H",
    `${DIM}╭${"─".repeat(w - 2)}╮${R}\r\n`,
    line(`${ACCENT}✻${R} Welcome to ${ACCENT}Claude Code${R}!`),
    line(""),
    line(`${DIM}/help for help, /status for your current setup${R}`),
    line(""),
    line(`${DIM}cwd: ${cwd}${R}`),
    `${DIM}╰${"─".repeat(w - 2)}╯${R}\r\n\r\n`,
    `${DIM}>${R} ${task.toLowerCase()}\r\n\r\n`,
    `${fg(120, 200, 140)}⏺${R} I'll start by reading how this is wired today.\r\n\r\n`,
    `${fg(120, 200, 140)}⏺${R} ${"Read"}(src/components/${name}.tsx)\r\n`,
    `  ${DIM}⎿  Read 214 lines${R}\r\n\r\n`,
    `${fg(120, 200, 140)}⏺${R} ${"Search"}(pattern: "useSettings", path: "src")\r\n`,
    `  ${DIM}⎿  Found 7 files${R}\r\n\r\n`,
    `${fg(120, 200, 140)}⏺${R} The page list lives in ${ACCENT}sections.ts${R}; I'll move the two\r\n`,
    `  stray toggles into it and drop the duplicate header.\r\n\r\n`,
    `${ACCENT}✻ Simmering…${R} ${DIM}(12s · ↑ 1.4k tokens · esc to interrupt)${R}\r\n\r\n`,
    `${DIM}╭${"─".repeat(w - 2)}╮${R}\r\n`,
    line(`> `),
    `${DIM}╰${"─".repeat(w - 2)}╯${R}\r\n`,
    `  ${fg(200, 120, 200)}⏵⏵ bypass permissions on${R} ${DIM}(shift+tab to cycle)${R}\r\n`,
  ].join("");
}

mockWindows("main");
const node = (id: string, kind: string, label: string, body: string | null, agent: string, at: string, extra: Record<string, unknown> = {}) => ({
  id, kind, label, body, workspace_id: "ws-1", created_by_agent: agent, created_at: at, updated_at: at, archived_at: null, outcome: null, shipped_in: null, ...extra,
});
const GRAPH_NODES = [
  node("n1", "Decision", "Composer sends on Enter, Shift+Enter adds a line", "Matches every chat app the team uses; the old Cmd+Enter confused new users. Rejected: a send-mode toggle.", "Pluto", "2026-11-08T16:40:00Z", { shipped_in: "Composer: Send and Stop inset · #145" }),
  node("n2", "Attempt", "Virtualised message list with react-window", "Scroll jumped on streaming answers; measured heights fought the stream. Reverted.", "Hazel", "2026-11-07T11:20:00Z", { outcome: "failure" }),
  node("n3", "Decision", "Settings is a page, not a modal", "A page keeps its place in history and can be linked; modals stacked on top of each other.", "Rhea", "2026-11-06T09:12:00Z"),
  node("n4", "Note", "Email switches live under Settings, Notifications", "Product asked for one place for every notification preference.", "Pluto", "2026-11-07T15:02:00Z"),
  node("n5", "Attempt", "Search chats with Postgres full-text", "Works for English; stemming broke for French titles. Partial: kept for English.", "Kiwi", "2026-11-05T18:44:00Z", { outcome: "partial" }),
  node("n6", "Decision", "One sidebar list for chats and agents", "Two lists split attention. Rejected: tabs above the list.", "Rhea", "2026-11-04T10:30:00Z"),
  node("n7", "File", "src/components/Composer.tsx", null, "Pluto", "2026-11-08T16:41:00Z"),
  node("n8", "File", "src/settings/pages.tsx", null, "Rhea", "2026-11-06T09:13:00Z"),
  node("n9", "Note", "Staging deploys need the VPN", "The preview URLs resolve only inside the office network.", "Ozzy", "2026-11-03T08:10:00Z"),
  node("n10", "Attempt", "Stream answers over SSE behind nginx", "Buffering held chunks until the end; proxy_buffering off fixed it.", "Hazel", "2026-11-02T13:00:00Z", { outcome: "success" }),
  node("n11", "Decision", "Dark theme follows macOS until picked", "People expect the system setting; a stored choice wins after.", "Kiwi", "2026-11-01T12:00:00Z"),
  node("n12", "Note", "Release notes are written from merged PR titles", null, "Ozzy", "2026-10-30T17:30:00Z"),
];
const QUEUE = [
  {
    item: { repo: "Just-getting-SARL/lucy-chat", number: 145, title: "Composer: Send and Stop inset", position: 0, status: "checks_pending", note: null },
    mergeable: true, mergeable_state: "unstable",
    checks: [{ name: "build", status: "completed", conclusion: "success" }, { name: "e2e", status: "in_progress", conclusion: null }],
    approvals: [{ author: "hazel", state: "APPROVED", submitted_at: "" }],
    conflict_files: [], base_ref: "main", head_ref: "composer-send-inset",
  },
  {
    item: { repo: "Just-getting-SARL/lucy-chat", number: 144, title: "Emails: switches in Settings", position: 1, status: "blocked", note: "Needs an approval" },
    mergeable: false, mergeable_state: "dirty",
    checks: [{ name: "build", status: "completed", conclusion: "failure" }],
    approvals: [],
    conflict_files: ["src/settings/pages.tsx"], base_ref: "main", head_ref: "email-settings",
  },
];
const GRAPH_EDGES = [
  { from: "n1", to: "n7", edge_type: "ABOUT" },
  { from: "n3", to: "n8", edge_type: "ABOUT" },
  { from: "n2", to: "n6", edge_type: "RELATES_TO" },
  { from: "n4", to: "n3", edge_type: "RELATES_TO" },
  { from: "n5", to: "n6", edge_type: "RELATES_TO" },
  { from: "n10", to: "n2", edge_type: "RELATES_TO" },
  { from: "n11", to: "n3", edge_type: "RELATES_TO" },
];

mockIPC(
  async (cmd: string, raw?: unknown) => {
    const args = (raw ?? {}) as Args;
    switch (cmd) {
      case "list_workspaces":
        return workspaces;
      case "cwd":
        return HOME;
      case "restore_workspace":
        return saved[String(args.workspaceId)] ? JSON.stringify(saved[String(args.workspaceId)]) : null;
      case "stage_composer_image":
        return `.flock/images/img-${++staged}.png`;
      case "spawn_pane": {
        const a = args;
        (window as unknown as { __lastSpawn?: Args }).__lastSpawn = a;
        const id = String(a.paneId ?? crypto.randomUUID());
        const name = String(a.agentName ?? "Agent");
        paneNames.set(id, name);
        setTimeout(() => {
          void emit("agent://started", { pane_id: id });
          const s = STATUS[name];
          if (s && s !== "idle") void emit("agent://status", { pane_id: id, status: s });
          if (params.get("live")) {
            (LIVE[name] ?? []).forEach((e, i) =>
              setTimeout(() => void emit("hook://event", { time: 1, agent: "claude", pane_id: id, ...e }), 300 + i * 250),
            );
            if (FINISH.has(name)) {
              void emit("agent://status", { pane_id: id, status: "working" });
              setTimeout(() => void emit("agent://status", { pane_id: id, status: "idle" }), 900);
            }
          }
        }, 400);
        return { id, workspace_id: a.workspaceId, kind: a.cmd, status: "idle", rows: 24, cols: 80, started: false };
      }
      case "subscribe_pane_output": {
        const ch = args.channel as { onmessage: (b: ArrayBuffer) => void };
        const id = String(args.paneId);
        const name = paneNames.get(id) ?? "Agent";
        const p = Object.values(saved).flatMap((s) => (s as { panes: Array<{ displayName: string; intent?: string; cwd: string }> }).panes).find((x) => x.displayName === name);
        setTimeout(() => ch.onmessage(enc.encode(screen(name, p?.intent ?? "say hello", p?.cwd ?? HOME)).buffer as ArrayBuffer), 50);
        return 1;
      }
      case "git_overview":
        return {
          is_repo: true,
          branch: "main",
          upstream: "origin/main",
          ahead: 1,
          behind: 0,
          changes: [
            { path: "src/settings/sections.ts", status: "M", staged: false },
            { path: "src/settings/Settings.tsx", status: "M", staged: false },
            { path: "src/settings/pages.tsx", status: "A", staged: true },
            { path: "notes.md", status: "?", staged: false },
          ],
          commits: [
            { hash: "8b6667e1", short: "8b6667e", parents: ["cc3bba31"], refs: ["HEAD -> main"], is_head: true, subject: "Composer: Send and Stop inset", author: "Remi", date: "2026-11-08" },
            { hash: "cc3bba31", short: "cc3bba3", parents: ["b9e3eaa1"], refs: [], is_head: false, subject: "Emails: switches in Settings", author: "Remi", date: "2026-11-07" },
            { hash: "b9e3eaa1", short: "b9e3eaa", parents: [], refs: ["origin/main"], is_head: false, subject: "Search chats while you type", author: "Remi", date: "2026-11-06" },
          ],
        };
      case "git_repo_map": {
        const ws = workspaces.find((w) => w.repo_path === args.repoPath);
        return {
          is_repo: !!ws?.branch,
          worktrees: ws?.branch ? [{ path: ws.repo_path, branch: ws.branch, head: "a1b2c3d", is_main: true, detached: false, locked: false, prunable: false, dirty: 3, ahead: 1, behind: 0 }] : [],
          branches: ws?.branch ? [{ name: ws.branch, worktree_path: ws.repo_path }] : [],
        };
      }
      case "claude_context_usage":
        return ((args.sessionIds as string[]) ?? []).map((id, i) => ({ session_id: id, used_tokens: [62_000, 141_000, 174_000][i % 3], window_tokens: 200_000, model: "claude-opus-5-5" }));
      case "github_check":
        return { connected: true, user: "remiminnebo", avatar_url: null };
      case "github_workspace_prs":
        return [
          { number: 145, title: "Composer: Send and Stop inset", author: "remiminnebo", repo: "Just-getting-SARL/lucy-chat", state: "open", body: null, updated_at: "", head_ref: "composer-send-inset" },
          { number: 144, title: "Emails: switches in Settings", author: "remiminnebo", repo: "Just-getting-SARL/lucy-chat", state: "open", body: null, updated_at: "", head_ref: "email-settings" },
        ];
      case "pr_watch_get_config":
        return { repos: [], auto_review: false, merge_method: "squash", auto_update_branch: false };
      case "pr_watch_poll":
        return { prs: [], fresh: [] };
      case "pr_review_get_summaries":
        return { "Just-getting-SARL/lucy-chat#145": { summary: "Small, focused change. The inset now matches the composer spec on both themes; Stop keeps its hit area. One nit: the 2px offset is duplicated in two places.", updated_at: new Date(Date.now() - 50 * 60000).toISOString() } };
      case "merge_queue_list":
        return params.get("queue") ? QUEUE.map((d) => d.item) : [];
      case "merge_queue_inspect":
        return params.get("queue") ? QUEUE : [];
      case "github_pr_details":
        return {
          head_ref: args.number === 145 ? "composer-send-inset" : "email-settings",
          base_ref: "main",
          state: "open",
          merged: false,
          approved: args.number === 145,
          checks: [
            { name: "build", status: "completed", conclusion: "success" },
            { name: "lint", status: "completed", conclusion: "success" },
            { name: "e2e", status: "in_progress", conclusion: null },
          ],
          reviews: args.number === 145 ? [{ author: "hazel", state: "APPROVED", body: "Looks right on both themes. Ship it.", submitted_at: "" }] : [],
        };
      case "github_pr_diff":
        return [
          "diff --git a/src/components/Composer.css b/src/components/Composer.css",
          "--- a/src/components/Composer.css",
          "+++ b/src/components/Composer.css",
          "@@ -41,9 +41,9 @@ .composer-row {",
          " .composer-send {",
          "-  right: 10px;",
          "-  bottom: 10px;",
          "+  right: 8px;",
          "+  bottom: 8px;",
          "   width: 32px;",
          "   height: 32px;",
          "   border-radius: 50%;",
          "",
        ].join("\n");
      case "claude_usage":
        return {
          plan: "max",
          bars: [
            { kind: "session", group: "session", label: "Current session", percent: 42, severity: "normal", resets_at: new Date(Date.now() + 190 * 60000).toISOString(), is_active: true },
            { kind: "weekly_all", group: "weekly", label: "All models", percent: 18, severity: "normal", resets_at: new Date(Date.now() + 4 * 86400000).toISOString(), is_active: false },
            { kind: "weekly_scoped", group: "weekly", label: "Opus", percent: 31, severity: "normal", resets_at: new Date(Date.now() + 4 * 86400000).toISOString(), is_active: false },
          ],
          spend: null,
          fetched_at_ms: Date.now(),
        };
      case "codex_usage":
        return {
          plan: "pro",
          bars: [{ kind: "session", group: "session", label: "Current session", percent: 81, severity: "warning", resets_at: new Date(Date.now() + 47 * 60000).toISOString(), is_active: true }],
          spend: null,
          fetched_at_ms: Date.now(),
        };
      case "graph_mcp_config":
        return { mcp_path: null, kg_url: "" };
      case "graph_status":
        return { docker_cli: "/usr/local/bin/docker", docker_ready: true, container_running: true, db_reachable: true, mcp_binary: "/Applications/flock.app/Contents/MacOS/flock-mcp", kg_url: "postgres://localhost:54329/flock" };
      case "graph_overview":
        return { stats: { total: GRAPH_NODES.length, decisions: 4, attempts: 3, files: 2, notes: 3, contributors: 5, latest: GRAPH_NODES[0] } };
      case "graph_list_nodes": {
        const kind = args.kind as string | null;
        const q = String(args.query ?? "").toLowerCase();
        return GRAPH_NODES.filter((n) => (!kind || n.kind === kind) && (!q || `${n.label} ${n.body ?? ""}`.toLowerCase().includes(q)));
      }
      case "graph_node_neighbors":
        return GRAPH_EDGES.filter((e) => e.from === args.nodeId || e.to === args.nodeId).map((e) => ({
          node: GRAPH_NODES.find((n) => n.id === (e.from === args.nodeId ? e.to : e.from))!,
          edge_type: e.edge_type,
          direction: e.from === args.nodeId ? "out" : "in",
        }));
      case "graph_subgraph":
        return { nodes: GRAPH_NODES, edges: GRAPH_EDGES };
      case "graph_recall":
        return {
          passes: [
            { ts: "2026-11-08T17:40:00Z", workspace_id: "ws-1", agent_id: "Pluto", facts: GRAPH_NODES.slice(0, 3).map((n) => ({ id: n.id, kind: n.kind, label: n.label, body: n.body, archived: false, superseded: false })) },
            { ts: "2026-11-08T16:05:00Z", workspace_id: "ws-1", agent_id: "Hazel", facts: [] },
          ],
          top: GRAPH_NODES.slice(0, 4).map((n, i) => ({ id: n.id, kind: n.kind, label: n.label, recalls: 14 - i * 3 })),
          stats: { ground_passes: 42, passes_with_facts: 31, silent_passes: 11, facts_injected: 97, facts_recalled: 9, knowledge_total: GRAPH_NODES.length, passes_unrecorded: 0 },
        };
      case "graph_insights":
        return { since: "2026-10-09T00:00:00Z", recall: { ground_passes: 42, passes_with_facts: 31, silent_passes: 11, facts_injected: 97, facts_recalled: 9, knowledge_total: GRAPH_NODES.length, passes_unrecorded: 0 }, reads: 214, writes: 38, outcomes: 6, cost_minor: 18450, currency: "USD", exponent: 2 };
      case "graph_brief":
        return "";
      case "container_status":
        return { available: false, daemon_running: false, image_ready: false };
      case "claude_session_exists":
        return false;
      case "git_branch_options":
        return { is_repo: true, current: "main", default_ref: "origin/main", local: [{ name: "main", worktree_path: String(args.repoPath ?? HOME) }], remote: [{ name: "origin/main" }] };
      case "agent_cli_status":
        return { claude: true, codex: true, grok: true, opencode: false, pi: false };
      case "worktree_setup_get":
        return { unset: false, command: "", suggestion: "" };
      case "get_persisted_pane_buffer":
        return [];
      case "plugin:app|version":
        return "0.8.0-harness";
      case "plugin:window|is_focused":
        return true;
      case "plugin:dialog|open":
        return `${HOME}/new-project`;
      default:
        if (cmd.startsWith("list") || cmd.endsWith("_list") || cmd.startsWith("queue_list") || cmd.includes("merge_queue")) return [];
        return null;
    }
  },
  { shouldMockEvents: true },
);

await import("../main");

// Deep links for screenshots.
const view = params.get("view");
setTimeout(() => {
  const key = (k: string, extra: KeyboardEventInit = {}) =>
    window.dispatchEvent(new KeyboardEvent("keydown", { key: k, metaKey: true, bubbles: true, ...extra }));
  if (view === "new") key("n");
  if (view === "settings") key(",");
  if (view === "palette") key("k");
  if (view === "project") key("n", { shiftKey: true });
  // ?click=<css selector>: press something, for a screenshot of what it opens.
  const click = params.get("click");
  if (click) (document.querySelector(click) as HTMLElement | null)?.click();
  // ?open=prs|queue|graph|graph-setup|insights: one of the panels, for its screenshot.
  const open = params.get("open");
  const row = (text: string) =>
    [...document.querySelectorAll<HTMLElement>("button")].find((b) => b.textContent?.trim().startsWith(text))?.click();
  if (open === "prs") row("Pull requests");
  if (open === "graph") window.dispatchEvent(new Event("flock:open-graph-explorer"));
  if (open === "graph-setup") window.dispatchEvent(new Event("flock:open-graph-setup"));
  if (open === "me") document.querySelector<HTMLElement>(".v2-me")?.click();
  // ?session=observe|task|copilot: a request from @hazel, as presence would deliver it.
  const session = params.get("session");
  const deliver = (window as unknown as { __flockSessionMsg?: (m: unknown) => void }).__flockSessionMsg;
  const base = { from: "hazel", to: "remi", from_wid: "w-hazel", to_wid: "w-remi" };
  if (session === "observe") deliver?.({ ...base, type: "observe_request", session_id: "s-1" });
  if (session === "task") deliver?.({ ...base, type: "task_send", task_id: "t-1", prompt: "Can you make the composer's Stop button match Send? Same inset, same hit area." });
  if (session === "copilot") deliver?.({ ...base, type: "copilot_invite", session_id: "s-2", panes: [] });
  if (open === "friend") document.querySelector<HTMLElement>(".v2-person-main")?.click();
  const graphView = ({ map: "graph", recall: "recall", insights: "insights", knowledge: "list" } as Record<string, string>)[open ?? ""];
  if (graphView) window.dispatchEvent(new CustomEvent("flock:open-graph-explorer", { detail: { view: graphView } }));
  if (open === "queue" || open === "repos") {
    row("Pull requests");
    setTimeout(() => [...document.querySelectorAll<HTMLElement>("[role=tab]")].find((t) => t.textContent?.startsWith(open === "queue" ? "Merge queue" : "Watched"))?.click(), 1500);
  }
  // ?select=<n>: pick the nth row of the page's list, for its detail.
  const select = Number(params.get("select") ?? 0);
  if (select) setTimeout(() => document.querySelectorAll<HTMLElement>(".v2-page .v2-list-row")[select - 1]?.click(), 700);
}, 1200);

// ?debug=1: the shell's measured boxes, written onto <body> for a DOM dump.
if (params.get("debug")) {
  setTimeout(() => {
    const box = (sel: string) => {
      const r = document.querySelector(sel)?.getBoundingClientRect();
      return r ? `${sel}=${Math.round(r.top)},${Math.round(r.height)}` : `${sel}=none`;
    };
    document.body.dataset.debug = [".v2-app", ".v2-main", ".v2-head", ".v2-body", ".v2-stage", ".v2-grid"].map(box).join(" ");
  }, 4000);
}
