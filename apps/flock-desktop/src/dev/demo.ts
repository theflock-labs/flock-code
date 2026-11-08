// The website's demo: the real flock App in a page, with Tauri's IPC mocked and
// made-up projects, agents and people, playing a short story by driving the
// app the way a person would (its shortcuts, its composer, its rows). Built
// static by vite.demo.config.ts into the site's /demo/; never part of the app.
//
// It always runs in a frame of 1280 by 800, so its terminals are exactly the
// size the recordings in them were made at (see "Terminals" below). The page
// that embeds it (theflock.sh) scales that frame to its column; opened on its
// own, the demo is its own host page and frames itself the same way.
//
// The host talks to it with postMessage:
//   to the host:  {type:"flock-demo", event:"ready"} once loaded,
//                 {type:"flock-demo", event:"scene", index, total, caption} at each step,
//                 {type:"flock-demo", event:"ended"} at the end;
//   to the demo:  {type:"flock-demo-control", action:"play" | "pause" | "restart"}.

import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { getEffectiveTheme } from "../lib/theme";
import plex400 from "../assets/fonts/IBMPlexMono-400.woff2?url";
import plex600 from "../assets/fonts/IBMPlexMono-600.woff2?url";
import checkoutRec from "./demo-recordings/checkout.json?url";
import wrenRec from "./demo-recordings/wren.json?url";
import novaRec from "./demo-recordings/nova.json?url";
import finnRec from "./demo-recordings/finn.json?url";
import emailRec from "./demo-recordings/email.json?url";
import searchRec from "./demo-recordings/search.json?url";
import darkmodeRec from "./demo-recordings/darkmode.json?url";
import apiRec from "./demo-recordings/api.json?url";
import docsRec from "./demo-recordings/docs.json?url";

type Args = Record<string, unknown>;
type Channel = { onmessage: (b: ArrayBuffer) => void };

const W = 1280;
const H = 800;
const HOME = "/Users/sam/code";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─── Opened on its own: be the host page ──────────────────────────────────

if (window.parent === window) {
  host();
  // The app runs in the frame; this page only hosts it. Evaluating no further
  // keeps a second copy of the app from starting here.
  await new Promise(() => {});
}

function host() {
  document.title = "flock, a short demo";
  const style = document.createElement("style");
  style.textContent = `
    html, body { margin: 0; height: 100%; background: #f4f5f7; color: #111318; overflow: hidden;
      font: 500 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
    @media (prefers-color-scheme: dark) { html, body { background: #0d0f12; color: #eceef1; } }
    .stage { position: absolute; left: 50%; top: 50%; width: ${W}px; height: ${H}px; transform-origin: 0 0; }
    .stage iframe { width: ${W}px; height: ${H}px; border: 0; border-radius: 12px; display: block;
      box-shadow: 0 0 0 1px rgba(0,0,0,.08), 0 18px 50px rgba(0,0,0,.14); background: transparent; }
    .caption { position: absolute; left: 0; right: 0; text-align: center; padding: 0 16px; opacity: .78; }
    .caption button { font: inherit; color: inherit; background: none; border: 0; padding: 0;
      text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
  `;
  document.head.appendChild(style);
  const stage = document.createElement("div");
  stage.className = "stage";
  const frame = document.createElement("iframe");
  frame.title = "The flock app, playing a short demo";
  frame.src = location.href;
  stage.appendChild(frame);
  const caption = document.createElement("p");
  caption.className = "caption";
  caption.setAttribute("role", "status");
  document.body.append(stage, caption);

  const fit = () => {
    const s = Math.min((innerWidth - 32) / W, (innerHeight - 96) / H, 1);
    const top = Math.max(16, (innerHeight - H * s - 56) / 2);
    stage.style.transform = `translate(${-(W * s) / 2}px, 0) scale(${s})`;
    stage.style.top = `${top}px`;
    caption.style.top = `${top + H * s + 18}px`;
  };
  fit();
  addEventListener("resize", fit);

  const control = (action: string) => frame.contentWindow?.postMessage({ type: "flock-demo-control", action }, "*");
  addEventListener("message", (e) => {
    if (e.source !== frame.contentWindow) return;
    const d = e.data as { type?: string; event?: string; caption?: string } | null;
    if (!d || d.type !== "flock-demo") return;
    if (d.event === "ready") control("play");
    else if (d.event === "scene") caption.textContent = d.caption ?? "";
    else if (d.event === "ended") {
      caption.textContent = "That's flock. ";
      const again = document.createElement("button");
      again.textContent = "Watch again";
      again.onclick = () => {
        caption.textContent = "";
        control("restart");
      };
      caption.appendChild(again);
    }
  });
}

// ─── In the frame: the app ────────────────────────────────────────────────

// A clean first visit every time: the app's own preferences, not the site's.
for (const k of Object.keys(localStorage)) if (k.startsWith("flock:")) localStorage.removeItem(k);
localStorage.setItem("flock:ai-titles", "0");
localStorage.setItem("flock:graph-enabled", "1");
localStorage.setItem("flock:sidebar-collapsed", "0");

// One terminal font on every visitor's machine: the recordings are laid out
// for an exact number of columns, so the cell size cannot be left to whatever
// monospace face a browser picks.
localStorage.setItem("flock:terminal-font", "IBM Plex Mono");
const fontFaces = document.createElement("style");
fontFaces.textContent =
  `@font-face{font-family:"IBM Plex Mono";font-weight:400;src:url(${plex400}) format("woff2")}` +
  `@font-face{font-family:"IBM Plex Mono";font-weight:600;src:url(${plex600}) format("woff2")}`;
document.head.appendChild(fontFaces);
await Promise.all([
  document.fonts.load('400 13px "IBM Plex Mono"'),
  document.fonts.load('600 13px "IBM Plex Mono"'),
]).catch(() => {});

// The window's own buttons, where macOS draws them on the real window
// (tauri.conf.json: 14 px wide, 23 px apart, from x 22, centred on y 33).
const lights = document.createElement("div");
lights.setAttribute("aria-hidden", "true");
lights.style.cssText = "position:fixed;top:0;left:0;z-index:9999;pointer-events:none";
lights.innerHTML = ["#ff5f57", "#febc2e", "#28c840"]
  .map((c, i) => `<span style="position:absolute;left:${22 + i * 23}px;top:26px;width:14px;height:14px;border-radius:50%;background:${c};box-shadow:inset 0 0 0 .5px rgba(0,0,0,.2)"></span>`)
  .join("");
document.body.appendChild(lights);

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
  node("n1", "Decision", "Checkout is one page with three sections", "One form state already served all three steps. One Pay button waits for a cart, an address and a valid card. Rejected: keeping the stepper.", "Pluto", 0.2),
  node("n2", "Decision", "The weekly digest is opt-in", "Asked on the thread, for consent: off until a customer turns it on in Settings, Email preferences.", "Orion", 0.1),
  node("n3", "Attempt", "Debounce search at 400 ms", "Felt laggy while typing names; 250 ms keeps it live without flooding the API, and late answers are dropped.", "Juno", 3, { outcome: "partial" }),
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

// ─── Terminals ────────────────────────────────────────────────────────────
// Every agent's terminal plays a recording of a real Claude Code session
// (2.1.319, on a made-up shop), byte for byte, at exactly the size its pane has
// in this frame: 116 by 34 alone in a thread, 56 by 33 side by side, 56 by 15
// in a grid of four. The agents that live through a split were recorded
// through the same resizes, so Claude Code repaints at the moment flock
// shrinks their pane. A recording plays from the moment its agent starts, on
// screen or not, the way the real backend keeps every pane's output, and
// opening a thread replays what it has so far. In the one-agent threads, long
// stretches where only the spinner moved are cut short.
//
// The sessions were recorded in Claude Code's dark theme. In the light app
// they are shown in its light theme: the same colour roles, Claude Code's own
// light values.

type Recording = { cols: number; rows: number; duration: number; marks: Record<string, number>; chunks: [number, string][] };
const RECORDINGS = {
  checkout: checkoutRec,
  wren: wrenRec,
  nova: novaRec,
  finn: finnRec,
  email: emailRec,
  search: searchRec,
  darkmode: darkmodeRec,
  api: apiRec,
  docs: docsRec,
};
type RecName = keyof typeof RECORDINGS;
const recordings = new Map<RecName, Recording>();
const loading = Promise.all(
  (Object.entries(RECORDINGS) as [RecName, string][]).map(async ([name, url]) => {
    recordings.set(name, (await (await fetch(url)).json()) as Recording);
  }),
);

/** Claude Code's dark-theme colours that its light theme draws differently. */
const LIGHT: Record<string, string> = {"175,135,255":"135,0,255","253,93,177":"255,0,135","235,159,127":"245,149,117","147,165,255":"87,105,247","177,195,255":"117,135,255","177,185,249":"87,105,247","207,215,255":"137,155,255","72,150,140":"0,102,102","136,136,136":"138,138,138","166,166,166":"183,183,183","255,255,255":"0,0,0","0,0,0":"255,255,255","153,153,153":"102,102,102","193,193,193":"142,142,142","80,80,80":"175,175,175","0,204,204":"0,153,153","78,186,101":"44,122,57","255,107,128":"171,43,63","255,193,7":"150,108,30","255,223,57":"200,158,80","34,92,43":"105,219,124","122,41,54":"255,168,180","71,88,74":"199,225,203","105,72,77":"253,210,216","56,166,96":"47,157,68","179,89,107":"209,69,75","55,55,55":"240,240,240","70,70,70":"252,252,252","38,38,38":"245,245,245","38,79,120":"180,213,255","65,60,65":"250,245,250","55,65,70":"230,245,250","80,83,112":"39,47,111","255,120,20":"255,106,0","255,165,70":"255,150,50","122,180,232":"37,99,235"};
const SGR = /\x1b\[([0-9;]*)m/g;

function paint(s: string): string {
  if (getEffectiveTheme() !== "light") return s;
  return s.replace(SGR, (all, params: string) => {
    if (!params.includes("8;2;")) return all;
    const p = params.split(";");
    for (let i = 0; i + 4 < p.length; i++) {
      if ((p[i] === "38" || p[i] === "48") && p[i + 1] === "2") {
        const rgb = `${p[i + 2]},${p[i + 3]},${p[i + 4]}`;
        // Black behind the mascot's eyes is black in both themes.
        const to = p[i] === "48" && rgb === "0,0,0" ? undefined : LIGHT[rgb];
        if (to) [p[i + 2], p[i + 3], p[i + 4]] = to.split(",");
        i += 4;
      }
    }
    return `\x1b[${p.join(";")}m`;
  });
}

const enc = new TextEncoder();

class Term {
  buf = "";
  subs = new Set<Channel>();
  /** The size flock last gave this agent's terminal. */
  cols = 0;
  rows = 0;
  onResize: (() => void) | null = null;
  write(s: string) {
    this.buf += s;
    if (!this.subs.size) return;
    const bytes = enc.encode(paint(s)).buffer as ArrayBuffer;
    for (const ch of this.subs) ch.onmessage(bytes);
  }
  attach(ch: Channel, replay: boolean) {
    this.subs.add(ch);
    if (replay && this.buf) ch.onmessage(enc.encode(paint(this.buf)).buffer as ArrayBuffer);
  }
  resize(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.onResize?.();
  }
}

/** The story's clock: it runs only while the story plays, so nothing moves on
 *  before a visitor has scrolled to the demo, or while it is paused. */
let running = false;
async function storyWait(ms: number) {
  let left = ms;
  let last = performance.now();
  while (left > 0) {
    await sleep(Math.min(left, 100));
    const now = performance.now();
    if (running) left -= now - last;
    last = now;
  }
}

/** One recording, played into one terminal on the story's clock. Where the
 *  recording changed size, it waits for flock to give the pane that size (or
 *  catches up at once if flock got there first), so no frame is ever drawn
 *  for a size the pane does not have. */
class Player {
  private i = 0;
  private at = 0;
  private target = 0;
  private looping = false;
  private reached: Array<{ t: number; done: () => void }> = [];
  private onMarks: Array<{ t: number; fn: () => void }> = [];
  private sizes: Array<{ t: number; cols: number; rows: number }>;
  private nextSize = 0;
  constructor(
    private readonly term: Term,
    private readonly rec: Recording,
  ) {
    this.sizes = Object.entries(rec.marks)
      .filter(([k]) => k.startsWith("size:"))
      .map(([k, t]) => {
        const [cols, rows] = k.slice(5).split("x").map(Number);
        return { t, cols, rows };
      })
      .sort((a, b) => a.t - b.t);
    term.onResize = () => {
      const s = this.sizes[this.nextSize];
      // flock split the pane before the recording got there: what is left at
      // the old size goes out at once, with the repaint right behind it.
      if (s && term.cols === s.cols && term.rows === s.rows && this.at < s.t + 150) this.at = s.t + 150;
    };
  }
  mark(name: string) {
    return this.rec.marks[name] ?? 0;
  }
  /** Run `fn` once the recording passes its mark `name`. */
  on(name: string, fn: () => void) {
    if (name in this.rec.marks) this.onMarks.push({ t: this.rec.marks[name], fn });
    this.settle();
  }
  get ended() {
    return this.i >= this.rec.chunks.length;
  }
  /** Everything up to `t`, at once. */
  jump(t: number) {
    let s = "";
    while (this.i < this.rec.chunks.length && this.rec.chunks[this.i][0] <= t) s += this.rec.chunks[this.i++][1];
    if (s) this.term.write(s);
    this.at = Math.max(this.at, Math.min(t, this.rec.duration));
    while (this.sizes[this.nextSize] && this.sizes[this.nextSize].t <= this.at) this.nextSize++;
    this.settle();
  }
  /** As recorded, up to `until` (the end by default). `from` moves the clock
   *  past a hold first, so what follows it plays at once. */
  play(until = Infinity, from?: number): Promise<void> {
    if (from !== undefined) this.at = Math.max(this.at, from);
    this.target = Math.max(this.target, until);
    const reached = new Promise<void>((done) => this.reached.push({ t: Math.min(until, this.rec.duration), done }));
    if (!this.looping) void this.loop();
    this.settle();
    return reached;
  }
  private settle() {
    const passed = this.ended ? Infinity : this.at;
    this.reached = this.reached.filter((r) => (passed >= r.t ? (r.done(), false) : true));
    this.onMarks = this.onMarks.filter((m) => (passed >= m.t ? (m.fn(), false) : true));
  }
  private async loop() {
    this.looping = true;
    let last = performance.now();
    let held = 0;
    while (!this.ended && this.rec.chunks[this.i][0] <= this.target) {
      const t = this.rec.chunks[this.i][0];
      if (t > this.at) {
        await sleep(Math.min(t - this.at, 50));
        const now = performance.now();
        if (running) this.at = Math.min(t, this.at + (now - last));
        last = now;
        continue;
      }
      const s = this.sizes[this.nextSize];
      if (s && s.t <= t && (this.term.cols !== s.cols || this.term.rows !== s.rows) && held < 4000) {
        // The recording resized here; flock has not split the pane yet.
        await sleep(50);
        held += 50;
        last = performance.now();
        continue;
      }
      held = 0;
      this.jump(t);
      last = performance.now();
    }
    this.at = Math.max(this.at, Math.min(this.target, this.rec.duration));
    this.looping = false;
    this.settle();
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

/** Which recording each agent plays. Wren, Nova and Finn are the agents the
 *  story adds to the checkout thread (src/dev/demoAgentNames.ts names them in
 *  that order); one started from the composer plays a dark mode task. */
const PLAYS: Record<string, RecName> = {
  Pluto: "checkout",
  Wren: "wren",
  Nova: "nova",
  Finn: "finn",
  Orion: "email",
  Juno: "search",
  Atlas: "api",
  Lyra: "docs",
};
const players = new Map<RecName, Player>();

/** Where Pluto's session is when the story opens (ms into it). Its recording
 *  shrinks to half width 5.2 s later and to a quarter 18.8 s later: when the
 *  story adds the second and the fourth agent. */
const CHECKOUT_FROM = 4000;
/** How long Orion works, off screen, before it has a question for you. */
const EMAIL_LEAD = 9000;

function start(paneId: string, which: RecName) {
  const rec = recordings.get(which);
  if (!rec) return;
  const p = new Player(term(paneId), rec);
  players.set(which, p);
  switch (which) {
    case "checkout":
      p.jump(CHECKOUT_FROM);
      status(paneId, "working");
      void p.play().then(() => status(paneId, "idle"));
      break;
    case "wren":
    case "nova":
    case "finn":
      // A new agent waits for its task; it is typed in, and off it goes.
      p.on("working", () => status(paneId, "working"));
      void p.play().then(() => status(paneId, "idle"));
      break;
    case "email": {
      const question = p.mark("question");
      p.jump(Math.max(0, question - EMAIL_LEAD));
      status(paneId, "working");
      void p.play(question - 1);
      break;
    }
    case "darkmode":
      status(paneId, "working");
      void p.play().then(() => status(paneId, "idle"));
      break;
    default:
      // Done before the story starts (search), or waiting for a task (api, docs).
      p.jump(Infinity);
      if (which === "search") status(paneId, "idle");
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
        const which: RecName | undefined = argv.includes("--") ? "darkmode" : PLAYS[name];
        setTimeout(() => {
          void emit("agent://started", { pane_id: id });
          if (which) start(id, which);
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
      case "resize_pty":
        if (new URLSearchParams(location.search).has("debug")) console.log("DEMO resize", nameOf.get(String(args.paneId)), args.cols, args.rows);
        term(String(args.paneId)).resize(Number(args.cols), Number(args.rows));
        return null;
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
        return ((args.sessionIds as string[]) ?? []).map((id, i) => ({ session_id: id, used_tokens: [52_000, 96_000, 131_000][i % 3], window_tokens: 200_000, model: "claude-sonnet-5-5" }));
      case "github_check":
        return { connected: true, user: "sam", avatar_url: null };
      case "github_workspace_prs":
        return PRS;
      case "pr_watch_get_config":
        return { repos: [], auto_review: false, merge_method: "squash", auto_update_branch: false };
      case "pr_watch_poll":
        return { prs: [], fresh: [] };
      case "pr_review_get_summaries":
        return { "acme/storefront#212": { summary: "One page, three sections, same form state, and one Pay button that waits for a cart, an address and a valid card. Tests cover canPay. One nit: the coupon field lost its label.", updated_at: new Date(Date.now() - 20 * 60000).toISOString() } };
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
          "@@ -3,6 +3,13 @@ export function Checkout() {",
          "   const { form, update } = useCheckoutForm();",
          "-  return <Steps form={form} update={update} />;",
          "+  return (",
          "+    <form className=\"checkout\" onSubmit={(e) => e.preventDefault()}>",
          "+      <CartSection form={form} update={update} />",
          "+      <AddressSection form={form} update={update} />",
          "+      <PaymentSection form={form} update={update} />",
          "+      <button type=\"submit\" disabled={!canPay(form)}>Pay</button>",
          "+    </form>",
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
    run: () => storyWait(5000),
  },
  {
    caption: "⌘D puts a second agent in the same thread. Give it a task; both work.",
    run: async () => {
      key("d");
      await storyWait(7000);
    },
  },
  {
    caption: "⌘⇧D adds a third, below.",
    run: async () => {
      key("d", { shiftKey: true });
      await storyWait(6000);
    },
  },
  {
    caption: "And a fourth: four agents, one window, each on its own task.",
    run: async () => {
      // Back to Pluto (⌘[ twice), and split it too.
      key("[", { code: "BracketLeft" });
      await storyWait(300);
      key("[", { code: "BracketLeft" });
      await storyWait(300);
      key("d", { shiftKey: true });
      await storyWait(7400);
    },
  },
  {
    caption: "Meanwhile, another thread needs you.",
    run: async () => {
      const p = players.get("email");
      if (p) {
        // Its question comes up now, whatever is left of its work before it.
        void p.play(p.mark("answer") - 1, p.mark("question") - 1);
        status(paneOf("Orion"), "awaiting_input");
      }
      await storyWait(4000);
    },
  },
  {
    caption: "⌘J takes you straight to it. Answer, and it carries on.",
    run: async () => {
      key("j");
      await storyWait(2600);
      const p = players.get("email");
      const orion = paneOf("Orion");
      if (p) {
        status(orion, "working");
        void p.play(Infinity, p.mark("answer")).then(() => status(orion, "idle"));
      }
      await storyWait(4400);
    },
  },
  {
    caption: "⌘⇧[ takes you back. They kept working while you were away.",
    run: async () => {
      key("[", { code: "BracketLeft", shiftKey: true });
      await storyWait(5000);
    },
  },
  {
    caption: "Pull requests, with checks and an agent's review, in the same window.",
    run: async () => {
      clickText("Pull requests");
      await storyWait(5000);
    },
  },
  {
    caption: "And a memory every agent reads before it works.",
    run: async () => {
      clickText("Graph");
      await storyWait(1200);
      document.querySelector<HTMLElement>(".v2-page .v2-list-row")?.click();
      await storyWait(4300);
    },
  },
  {
    caption: "Twenty agents, one calm window.",
    run: async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await storyWait(3500);
    },
  },
];

function key(k: string, extra: KeyboardEventInit = {}) {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: k, metaKey: true, bubbles: true, ...extra }));
}

function clickText(text: string) {
  [...document.querySelectorAll<HTMLElement>("button")].find((b) => b.textContent?.trim().startsWith(text))?.click();
}

// ─── Talking to the host ──────────────────────────────────────────────────

const tell = (msg: Record<string, unknown>) => window.parent.postMessage({ type: "flock-demo", ...msg }, "*");

let started = false;
let paused = false;

async function run() {
  if (started) return;
  started = true;
  running = true;
  for (let i = 0; i < SCENES.length; i++) {
    while (paused) await sleep(200);
    tell({ event: "scene", index: i, total: SCENES.length, caption: SCENES[i].caption });
    await SCENES[i].run();
  }
  tell({ event: "ended" });
}

window.addEventListener("message", (e) => {
  if (e.source !== window.parent) return;
  const d = e.data as { type?: string; action?: string } | null;
  if (!d || d.type !== "flock-demo-control") return;
  if (d.action === "play") {
    paused = false;
    if (started) running = true;
    void run();
  } else if (d.action === "pause") {
    paused = true;
    running = false;
  } else if (d.action === "restart") {
    location.reload();
  }
});

await loading.catch(() => {});
setTimeout(() => tell({ event: "ready" }), 1500);
