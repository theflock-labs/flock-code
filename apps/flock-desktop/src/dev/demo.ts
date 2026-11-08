// The website's demo: the real flock App in a page, with Tauri's IPC mocked and
// made-up projects, agents and people, playing a short story by driving the
// app the way a person would (its shortcuts, its composer, its rows). Built
// static by vite.demo.config.ts into the site's /demo/; never part of the app.
//
// The page that embeds it (theflock.sh) talks to it with postMessage:
//   to the page:  {type:"flock-demo", event:"ready"} once loaded,
//                 {type:"flock-demo", event:"scene", index, total, caption} at each step,
//                 {type:"flock-demo", event:"ended"} at the end;
//   to the demo:  {type:"flock-demo-control", action:"play" | "pause" | "restart"}.
// Opened on its own (no parent page), it plays straight away and shows its
// captions itself.

import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";

type Args = Record<string, unknown>;
type Channel = { onmessage: (b: ArrayBuffer) => void };

const HOME = "/Users/sam/code";
const EMBEDDED = window.parent !== window;

// A clean first visit every time: the app's own preferences, not the site's.
for (const k of Object.keys(localStorage)) if (k.startsWith("flock:")) localStorage.removeItem(k);
localStorage.setItem("flock:ai-titles", "0");
localStorage.setItem("flock:graph-enabled", "1");
localStorage.setItem("flock:sidebar-collapsed", "0");

// ─── The made-up world ────────────────────────────────────────────────────

const workspaces = [
  { id: "ws-store", name: "storefront", repo_path: `${HOME}/storefront`, branch: "main", created_at: 1 },
  { id: "ws-api", name: "api", repo_path: `${HOME}/api`, branch: "main", created_at: 2 },
  { id: "ws-docs", name: "docs", repo_path: `${HOME}/docs`, branch: "main", created_at: 3 },
];

const leaf = (paneId: string) => ({ type: "leaf", paneId });
const tab = (id: string, name: string, paneId: string) => ({ id, name, renamed: true, layoutTree: leaf(paneId), focusedPaneId: paneId, zoomedPaneId: null });
const pane = (id: string, displayName: string, cwd: string, intent: string) => ({
  id, cmd: "claude", args: [], cwd, displayName, intent, promptHistory: [intent.toLowerCase()],
  sessionId: `0000000${id.length}-aaaa-bbbb-cccc-${id.padEnd(12, "0").slice(0, 12)}`,
});

const saved: Record<string, unknown> = {
  "ws-store": {
    agentKind: "claude",
    focusedTabId: "t-checkout",
    tabs: [
      tab("t-checkout", "Checkout on one page", "p-pluto"),
      tab("t-email", "Email preferences in Settings", "p-orion"),
      tab("t-search", "Search as you type", "p-juno"),
    ],
    panes: [
      pane("p-pluto", "Pluto", `${HOME}/storefront`, "Checkout on one page"),
      pane("p-orion", "Orion", `${HOME}/storefront`, "Email preferences in Settings"),
      pane("p-juno", "Juno", `${HOME}/storefront`, "Search as you type"),
    ],
  },
  "ws-api": {
    agentKind: "claude",
    focusedTabId: "t-rate",
    tabs: [tab("t-rate", "Rate-limit the export endpoint", "p-atlas")],
    panes: [pane("p-atlas", "Atlas", `${HOME}/api`, "Rate-limit the export endpoint")],
  },
  "ws-docs": {
    agentKind: "claude",
    focusedTabId: "t-quick",
    tabs: [tab("t-quick", "Rewrite the quickstart", "p-lyra")],
    panes: [pane("p-lyra", "Lyra", `${HOME}/docs`, "Rewrite the quickstart")],
  },
};

const PRS = [
  { number: 212, title: "Checkout on one page", author: "sam", repo: "acme/storefront", state: "open", body: null, updated_at: "", head_ref: "checkout-one-page" },
  { number: 209, title: "Search as you type", author: "sam", repo: "acme/storefront", state: "open", body: null, updated_at: "", head_ref: "search-as-you-type" },
];

const node = (id: string, kind: string, label: string, body: string | null, agent: string, hoursAgo: number, extra: Record<string, unknown> = {}) => {
  const at = new Date(Date.now() - hoursAgo * 3600_000).toISOString();
  return { id, kind, label, body, workspace_id: "ws-store", created_by_agent: agent, created_at: at, updated_at: at, archived_at: null, outcome: null, shipped_in: null, ...extra };
};
const GRAPH_NODES = [
  node("n1", "Decision", "Checkout is one page with three sections", "One form state already served all three steps; a single page removes two loads and the back-button bugs. Rejected: a stepper.", "Pluto", 0.2),
  node("n2", "Decision", "The weekly digest is opt-in", "Asked on the thread; off until someone turns it on in Settings, Notifications.", "Orion", 0.1),
  node("n3", "Attempt", "Debounce search at 300 ms", "Felt laggy while typing names; 150 ms keeps it live without flooding the API.", "Juno", 3, { outcome: "partial" }),
  node("n4", "Note", "Payment provider sandbox needs the test card 4242", null, "Pluto", 26),
  node("n5", "Decision", "Prices are stored in minor units", "Floats rounded totals in two currencies. Integers everywhere, formatting at the edge.", "Atlas", 50),
  node("n6", "Attempt", "Stream order exports as CSV", "Timed out on large accounts behind the proxy; paging by 5,000 rows fixed it.", "Atlas", 70, { outcome: "success" }),
  node("n7", "File", "src/checkout/Checkout.tsx", null, "Pluto", 0.3),
];
const GRAPH_EDGES = [
  { from: "n1", to: "n7", edge_type: "ABOUT" },
  { from: "n3", to: "n1", edge_type: "RELATES_TO" },
  { from: "n6", to: "n5", edge_type: "RELATES_TO" },
];

// ─── Terminals that keep running ──────────────────────────────────────────
// Every agent's terminal is a script that plays from the moment the agent
// starts, whether or not its thread is on screen, the way the real backend
// keeps every pane's output; opening a thread replays what it has so far.

const enc = new TextEncoder();
const fg = (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`;
const R = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const ACCENT = fg(215, 119, 87);
const OK = fg(120, 200, 140);
const DOT = `${OK}⏺${R}`;

class Term {
  buf = "";
  subs = new Set<Channel>();
  spin: string | null = null;
  spinFrom = 0;
  ticker: ReturnType<typeof setInterval> | null = null;

  write(s: string) {
    this.buf += s;
    for (const ch of this.subs) ch.onmessage(enc.encode(s).buffer as ArrayBuffer);
  }
  attach(ch: Channel, replay: boolean) {
    this.subs.add(ch);
    if (replay && this.buf) ch.onmessage(enc.encode(this.buf).buffer as ArrayBuffer);
  }
  private spinText() {
    const s = Math.max(1, Math.round((Date.now() - this.spinFrom) / 1000));
    return `\r\x1b[2K${ACCENT}✻ ${this.spin}…${R} ${DIM}(${s}s · esc to interrupt)${R}`;
  }
  /** A line above the spinner. */
  line(s = "") {
    if (this.spin) this.write("\r\x1b[2K");
    this.write(`${s}\r\n`);
    if (this.spin) this.write(this.spinText());
  }
  spinStart(label: string) {
    this.spinStop();
    this.spin = label;
    this.spinFrom = Date.now();
    this.write(this.spinText());
    this.ticker = setInterval(() => this.spin && this.write(this.spinText()), 1000);
  }
  spinStop() {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    if (this.spin) this.write("\r\x1b[2K");
    this.spin = null;
  }
  banner(cwd: string, task: string) {
    const w = 52;
    const row = (s: string) => `${DIM}│${R} ${s}${" ".repeat(Math.max(0, w - 3 - [...s.replace(/\x1b\[[0-9;]*m/g, "")].length))}${DIM}│${R}`;
    this.line(`${DIM}╭${"─".repeat(w - 2)}╮${R}`);
    this.line(row(`${ACCENT}✻${R} Welcome to ${BOLD}Claude Code${R}`));
    this.line(row(""));
    this.line(row(`${DIM}cwd: ${cwd}${R}`));
    this.line(`${DIM}╰${"─".repeat(w - 2)}╯${R}`);
    this.line();
    this.line(`${DIM}>${R} ${task}`);
    this.line();
  }
}

const terms = new Map<string, Term>();
const channels = new Map<number, { paneId: string; ch: Channel }>();
let lastChannel = 0;
const nameOf = new Map<string, string>();
const paneOf = (name: string) => [...nameOf.entries()].find(([, n]) => n === name)?.[0];
const term = (paneId: string) => {
  let t = terms.get(paneId);
  if (!t) terms.set(paneId, (t = new Term()));
  return t;
};
const status = (paneId: string | undefined, s: string) => paneId && void emit("agent://status", { pane_id: paneId, status: s });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Each agent's work, as lines with a pause before each. */
type Beat = [number, string] | [number, { spin: string }] | [number, { done: string }];
const SCRIPTS: Record<string, Beat[]> = {
  checkout: [
    [400, { spin: "Reading" }],
    [900, `${DOT} I'll read how checkout is split today.`],
    [900, `${DOT} Read(src/checkout/Steps.tsx)`],
    [200, `  ${DIM}⎿  Read 188 lines${R}`],
    [900, `${DOT} Search(pattern: "useCheckoutStep", path: "src")`],
    [200, `  ${DIM}⎿  Found 6 files${R}`],
    [1200, `${DOT} All three steps share one form state, so a single page is`],
    [100, `  mostly layout. I'll merge them into ${ACCENT}Checkout.tsx${R} and keep`],
    [100, `  each section collapsible.`],
    [400, { spin: "Composing" }],
    [2600, `${DOT} Update(src/checkout/Checkout.tsx)`],
    [200, `  ${DIM}⎿  Updated with 142 additions and 61 removals${R}`],
    [1400, `${DOT} Bash(npm test -- checkout)`],
    [300, `  ${DIM}⎿  24 passed${R}`],
    [400, { spin: "Opening a pull request" }],
    [2400, `${DOT} Opened ${ACCENT}#212 Checkout on one page${R}.`],
    [300, { done: "" }],
  ],
  email: [
    [600, { spin: "Reading" }],
    [1100, `${DOT} Read(src/settings/Notifications.tsx)`],
    [200, `  ${DIM}⎿  Read 96 lines${R}`],
    [1200, `${DOT} The digest has no switch yet; I'll add one under`],
    [100, `  Settings, Notifications.`],
    [400, { spin: "Thinking" }],
  ],
  search: [
    [300, `${DOT} Update(src/search/useSearch.ts)`],
    [100, `  ${DIM}⎿  Updated with 18 additions and 4 removals${R}`],
    [200, `${DOT} Bash(npm test -- search)`],
    [100, `  ${DIM}⎿  11 passed${R}`],
    [200, `${DOT} Done. Search now updates as you type, debounced at 150 ms.`],
    [100, { done: "" }],
  ],
  darkmode: [
    [500, { spin: "Reading" }],
    [1000, `${DOT} Read(src/settings/Appearance.tsx)`],
    [200, `  ${DIM}⎿  Read 74 lines${R}`],
    [900, `${DOT} Search(pattern: "prefers-color-scheme", path: "src")`],
    [200, `  ${DIM}⎿  Found 3 files${R}`],
    [1100, `${DOT} Colours are already tokens, so the toggle only has to set`],
    [100, `  ${ACCENT}data-theme${R} on the root and remember the choice.`],
    [400, { spin: "Composing" }],
    [2200, `${DOT} Update(src/settings/Appearance.tsx)`],
    [200, `  ${DIM}⎿  Updated with 38 additions and 2 removals${R}`],
    [400, { spin: "Testing" }],
  ],
};

const TASK_SCRIPT: Record<string, string> = {
  Pluto: "checkout",
  Orion: "email",
  Juno: "search",
};

async function play(paneId: string, script: Beat[], task: string, cwd: string) {
  const t = term(paneId);
  t.banner(cwd, task);
  for (const [wait, beat] of script) {
    await sleep(wait);
    if (typeof beat === "string") t.line(beat);
    else if ("spin" in beat) t.spinStart(beat.spin);
    else {
      t.spinStop();
      t.line();
      t.write(`${DIM}>${R} `);
      status(paneId, "idle");
    }
  }
}

// ─── The backend ───────────────────────────────────────────────────────────

mockWindows("main");
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
      case "spawn_pane": {
        // A real spawn takes a moment (a PTY, a login shell); answering in the
        // same tick beats React to its own render of the new pane, and the app
        // then takes the pane for one closed while it was starting.
        await sleep(180);
        const id = String(args.paneId ?? crypto.randomUUID());
        const name = String(args.agentName ?? "Agent");
        nameOf.set(id, name);
        const argv = (args.args as string[] | undefined) ?? [];
        const dash = argv.indexOf("--");
        const prompt = dash >= 0 ? argv[dash + 1] : undefined;
        const cwd = String(args.cwd ?? HOME);
        const savedPane = Object.values(saved)
          .flatMap((s) => (s as { panes: Array<{ displayName: string; intent: string }> }).panes)
          .find((p) => p.displayName === name);
        const key = prompt ? "darkmode" : TASK_SCRIPT[name];
        setTimeout(() => {
          void emit("agent://started", { pane_id: id });
          if (key && key !== "search") status(id, "working");
          if (key) void play(id, SCRIPTS[key], (prompt ?? savedPane?.intent ?? "").toLowerCase(), cwd);
          else term(id).banner(cwd, (savedPane?.intent ?? "").toLowerCase());
        }, 350);
        return { id, workspace_id: args.workspaceId, kind: args.cmd, status: "idle", rows: 24, cols: 80, started: false };
      }
      case "subscribe_pane_output": {
        const ch = args.channel as Channel;
        const channelId = ++lastChannel;
        channels.set(channelId, { paneId: String(args.paneId), ch });
        term(String(args.paneId)).attach(ch, args.replay !== false);
        return channelId;
      }
      case "unsubscribe_pane_output": {
        // The terminal went away (its thread left the screen): stop writing to it.
        const sub = channels.get(Number(args.channelId));
        if (sub) {
          term(sub.paneId).subs.delete(sub.ch);
          channels.delete(Number(args.channelId));
        }
        return null;
      }
      case "voice_model_status":
        return { downloaded: false, size_bytes: 0, path: "" };
      case "git_overview":
        return { is_repo: true, branch: "main", upstream: "origin/main", ahead: 1, behind: 0, changes: [{ path: "src/checkout/Checkout.tsx", status: "M", staged: false }], commits: [] };
      case "git_repo_map": {
        const ws = workspaces.find((w) => w.repo_path === args.repoPath);
        return {
          is_repo: !!ws,
          worktrees: ws ? [{ path: ws.repo_path, branch: ws.branch, head: "a1b2c3d", is_main: true, detached: false, locked: false, prunable: false, dirty: 1, ahead: 1, behind: 0 }] : [],
          branches: ws ? [{ name: ws.branch, worktree_path: ws.repo_path }] : [],
        };
      }
      case "claude_context_usage":
        return ((args.sessionIds as string[]) ?? []).map((id, i) => ({ session_id: id, used_tokens: [52_000, 96_000, 131_000][i % 3], window_tokens: 200_000, model: "claude-opus-5-5" }));
      case "github_check":
        return { connected: true, user: "sam", avatar_url: null };
      case "github_workspace_prs":
        return PRS;
      case "pr_watch_get_config":
        return { repos: [], auto_review: false, merge_method: "squash", auto_update_branch: false };
      case "pr_watch_poll":
        return { prs: [], fresh: [] };
      case "pr_review_get_summaries":
        return { "acme/storefront#212": { summary: "One page, three collapsible sections, same form state. Tests cover the address and payment edge cases. One nit: the coupon field lost its label.", updated_at: new Date(Date.now() - 20 * 60000).toISOString() } };
      case "github_pr_details":
        return {
          head_ref: args.number === 212 ? "checkout-one-page" : "search-as-you-type",
          base_ref: "main",
          state: "open",
          merged: false,
          approved: false,
          checks: [
            { name: "build", status: "completed", conclusion: "success" },
            { name: "unit", status: "completed", conclusion: "success" },
            { name: "e2e", status: "in_progress", conclusion: null },
          ],
          reviews: [],
        };
      case "github_pr_diff":
        return [
          "diff --git a/src/checkout/Checkout.tsx b/src/checkout/Checkout.tsx",
          "--- a/src/checkout/Checkout.tsx",
          "+++ b/src/checkout/Checkout.tsx",
          "@@ -12,7 +12,9 @@ export function Checkout() {",
          "   const form = useCheckoutForm();",
          "-  return <Steps form={form} />;",
          "+  return (",
          "+    <Page>",
          "+      <Cart form={form} />",
          "+      <Address form={form} />",
          "+      <Payment form={form} />",
          "+    </Page>",
          "+  );",
          " }",
          "",
        ].join("\n");
      case "claude_usage":
        return {
          plan: "max",
          bars: [
            { kind: "session", group: "session", label: "Current session", percent: 34, severity: "normal", resets_at: new Date(Date.now() + 160 * 60000).toISOString(), is_active: true },
            { kind: "weekly_all", group: "weekly", label: "All models", percent: 12, severity: "normal", resets_at: new Date(Date.now() + 4 * 86400000).toISOString(), is_active: false },
          ],
          spend: null,
          fetched_at_ms: Date.now(),
        };
      case "codex_usage":
        return { plan: null, bars: [], spend: null, fetched_at_ms: Date.now() };
      case "graph_mcp_config":
        return { mcp_path: null, kg_url: "" };
      case "graph_status":
        return { docker_cli: "/usr/local/bin/docker", docker_ready: true, container_running: true, db_reachable: true, mcp_binary: "flock-mcp", kg_url: "postgres://localhost/flock" };
      case "graph_overview":
        return { stats: { total: GRAPH_NODES.length, decisions: 3, attempts: 2, files: 1, notes: 1, contributors: 4, latest: GRAPH_NODES[0] } };
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
        return { passes: [], top: [], stats: { ground_passes: 18, passes_with_facts: 14, silent_passes: 4, facts_injected: 41, facts_recalled: 5, knowledge_total: GRAPH_NODES.length, passes_unrecorded: 0 } };
      case "graph_insights":
        return { since: new Date(Date.now() - 30 * 86400000).toISOString(), recall: { ground_passes: 18, passes_with_facts: 14, silent_passes: 4, facts_injected: 41, facts_recalled: 5, knowledge_total: GRAPH_NODES.length, passes_unrecorded: 0 }, reads: 96, writes: 19, outcomes: 3, cost_minor: 0, currency: "USD", exponent: 2 };
      case "graph_brief":
        return "";
      case "container_status":
        return { available: false, daemon_running: false, image_ready: false };
      case "claude_session_exists":
        return false;
      case "git_branch_options":
        return { is_repo: true, current: "main", default_ref: "origin/main", local: [{ name: "main", worktree_path: String(args.repoPath ?? HOME) }], remote: [{ name: "origin/main" }] };
      case "agent_cli_status":
        return { claude: true, codex: true, grok: false, opencode: false, pi: false };
      case "worktree_setup_get":
        return { unset: false, command: "", suggestion: "" };
      case "get_persisted_pane_buffer":
        return [];
      case "plugin:app|version":
        return "0.8.0";
      case "plugin:window|is_focused":
        return true;
      case "plugin:dialog|open":
        return null;
      default:
        if (cmd.startsWith("list") || cmd.endsWith("_list") || cmd.includes("merge_queue")) return [];
        return null;
    }
  },
  { shouldMockEvents: true },
);

await import("../main");

// ─── The story ────────────────────────────────────────────────────────────

const SCENES: Array<{ caption: string; run: () => Promise<void> }> = [
  {
    caption: "Every agent you run, in one calm list.",
    run: () => sleep(6000),
  },
  {
    caption: "Start one like you start a chat: say the task, press Enter.",
    run: async () => {
      key("n");
      await sleep(900);
      const box = await waitFor(() => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Task for the new agent"]'));
      if (box) {
        await typeInto(box, "Add a dark mode toggle to Settings");
        await sleep(700);
        box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      }
      await sleep(7000);
    },
  },
  {
    caption: "Agents keep working; one tells you when it needs you.",
    run: async () => {
      const orion = paneOf("Orion");
      if (orion) {
        const t = term(orion);
        t.spinStop();
        t.line(`${DOT} Should the weekly digest be on by default?`);
        t.line();
        t.line(`  ${ACCENT}❯ 1. Opt-in${R}  ${DIM}(off until someone turns it on)${R}`);
        t.line(`    2. Opt-out ${DIM}(on for everyone)${R}`);
        status(orion, "awaiting_input");
      }
      await sleep(4200);
    },
  },
  {
    caption: "⌘J takes you straight to it. Answer, and it carries on.",
    run: async () => {
      key("j");
      await sleep(2600);
      const orion = paneOf("Orion");
      if (orion) {
        const t = term(orion);
        t.line();
        t.line(`${DIM}>${R} 1`);
        t.line();
        status(orion, "working");
        await sleep(700);
        t.line(`${DOT} Opt-in it is. Adding the switch under Settings, Notifications.`);
        t.spinStart("Composing");
      }
      await sleep(4200);
    },
  },
  {
    caption: "Its pull request, with checks and an agent's review, in the same window.",
    run: async () => {
      clickText("Pull requests");
      await sleep(5600);
    },
  },
  {
    caption: "And a memory every agent reads before it works.",
    run: async () => {
      clickText("Graph");
      await sleep(1400);
      document.querySelector<HTMLElement>(".v2-page .v2-list-row")?.click();
      await sleep(4600);
    },
  },
  {
    caption: "Twenty agents, one calm window.",
    run: async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await sleep(3500);
    },
  },
];

function key(k: string, extra: KeyboardEventInit = {}) {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: k, metaKey: true, bubbles: true, ...extra }));
}

function clickText(text: string) {
  [...document.querySelectorAll<HTMLElement>("button")].find((b) => b.textContent?.trim().startsWith(text))?.click();
}

async function waitFor<T>(get: () => T | null, ms = 3000): Promise<T | null> {
  for (let t = 0; t < ms; t += 100) {
    const v = get();
    if (v) return v;
    await sleep(100);
  }
  return null;
}

/** Type into a React-controlled field the way a person would, a key at a time. */
async function typeInto(el: HTMLTextAreaElement, text: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  el.focus();
  for (const ch of text) {
    set.call(el, el.value + ch);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(38 + Math.random() * 45);
  }
}

// ─── Talking to the page ──────────────────────────────────────────────────

const tell = (msg: Record<string, unknown>) => {
  if (EMBEDDED) window.parent.postMessage({ type: "flock-demo", ...msg }, "*");
  else showCaption(msg);
};

let started = false;
let paused = false;

async function run() {
  if (started) return;
  started = true;
  for (let i = 0; i < SCENES.length; i++) {
    while (paused) await sleep(200);
    tell({ event: "scene", index: i, total: SCENES.length, caption: SCENES[i].caption });
    await SCENES[i].run();
  }
  tell({ event: "ended" });
}

window.addEventListener("message", (e) => {
  const d = e.data as { type?: string; action?: string } | null;
  if (!d || d.type !== "flock-demo-control") return;
  if (d.action === "play") {
    paused = false;
    void run();
  } else if (d.action === "pause") {
    paused = true;
  } else if (d.action === "restart") {
    location.reload();
  }
});

// Standalone (the full-screen link): play now, with the captions on top.
let captionEl: HTMLDivElement | null = null;
function showCaption(msg: Record<string, unknown>) {
  if (!captionEl) {
    captionEl = document.createElement("div");
    captionEl.setAttribute("role", "status");
    captionEl.style.cssText =
      "position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:200;max-width:min(560px,90vw);" +
      "padding:10px 16px;border-radius:999px;background:rgba(17,19,24,.88);color:#fff;font:500 14px/1.4 -apple-system,system-ui,sans-serif;" +
      "text-align:center;box-shadow:0 8px 30px rgba(0,0,0,.25);pointer-events:none";
    document.body.appendChild(captionEl);
  }
  captionEl.textContent = msg.event === "ended" ? "That's flock. Download it free at theflock.sh." : String(msg.caption ?? "");
}

setTimeout(() => {
  tell({ event: "ready" });
  if (!EMBEDDED) void run();
}, 1500);
