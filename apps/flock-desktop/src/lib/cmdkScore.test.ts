// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { matchCommand, noteCommandRun, frecencyBonus, frecencySnapshot, clearFrecency, type Scorable } from "./cmdkScore";

// The rankings pinned here are the ones a real-session study measured the
// old scorer failing. They are written as *orderings*, never as absolute
// scores, so the tuning can move without the intent moving.

interface Row extends Scorable { id: string }

const SESSION: Row[] = [
  // agents
  { id: "hazel", label: "Hazel", hint: "flock-code", keywords: "claude", context: "/Users/remi/git/flock-code" },
  { id: "ozzy", label: "Ozzy", hint: "flock-code", keywords: "claude", context: "/Users/remi/git/flock-code" },
  { id: "pip", label: "Pip", hint: "flock-code", keywords: "codex", context: "/Users/remi/git/flock-code" },
  { id: "wren", label: "Wren", hint: "flock-site", keywords: "claude", context: "/Users/remi/git/flock-site" },
  // workspaces
  { id: "ws-code", label: "flock-code", hint: "master", context: "/Users/remi/git/flock-code" },
  { id: "ws-site", label: "flock-site", hint: "main", context: "/Users/remi/git/flock-site" },
  { id: "ws-infra", label: "infra", hint: "main", context: "/Users/remi/git/infra" },
  // verbs
  { id: "spawn", label: "New agent here", hint: "flock-code", keywords: "spawn launch claude codex opencode" },
  { id: "race", label: "Race agents on one prompt", hint: "flock-code", keywords: "fan out parallel worktree compare" },
  { id: "diff", label: "Show uncommitted changes", hint: "flock-code", keywords: "diff git status uncommitted" },
  { id: "new-ws", label: "New workspace", keywords: "create repo clone worktree" },
  { id: "queue", label: "Capture a prompt for later", keywords: "queue idea note" },
  { id: "prs", label: "Pull requests", keywords: "github pr checks review" },
  { id: "mq", label: "Merge queue", keywords: "github merge" },
  { id: "stats", label: "Your usage and stats", keywords: "metrics tokens spend chart achievements" },
  { id: "settings", label: "Settings", hint: "⌘,", keywords: "preferences theme appearance security graph" },
];

const rank = (q: string): string[] =>
  SESSION.map((r) => ({ r, m: matchCommand(q, r) }))
    .filter((x): x is { r: Row; m: NonNullable<ReturnType<typeof matchCommand>> } => x.m !== null)
    .sort((a, b) => a.m.score - b.m.score)
    .map((x) => x.r.id);

describe("cmdk ranking", () => {
  /* The headline regression from the study: three workspaces and two GitHub
   * rows beat the one command that means "git". */
  it("puts the git command first for \"git\", ahead of repo paths and github", () => {
    expect(rank("git")[0]).toBe("diff");
  });

  /* And the reason it used to lose: a repo path is `context`, which is a whole
   * tier below a curated keyword and can never outrank one. */
  it("never lets a repo path outrank a keyword", () => {
    const r = rank("git");
    const paths = ["ws-code", "ws-site", "ws-infra", "hazel", "ozzy"];
    const firstPath = Math.min(...paths.map((id) => r.indexOf(id)).filter((i) => i >= 0));
    expect(r.indexOf("diff")).toBeLessThan(firstPath);
    expect(r.indexOf("mq")).toBeLessThan(firstPath);
  });

  it("ranks the row that starts with the query first for \"pr\"", () => {
    // Old order: Capture a prompt (10), Settings (12), Race agents (19), Pull
    // requests (22) — the only row that begins with it came fourth.
    expect(rank("pr")[0]).toBe("prs");
  });

  it("puts a label match above any keyword match", () => {
    // "claude" is a keyword on three agents and on "New agent here"; nothing
    // has it as a label, so the tier ordering is all that decides. Add a row
    // that does.
    const withLabel: Row[] = [...SESSION, { id: "lbl", label: "claude", keywords: "" }];
    const best = withLabel
      .map((r) => ({ r, m: matchCommand("claude", r) }))
      .filter((x) => x.m)
      .sort((a, b) => a.m!.score - b.m!.score)[0];
    expect(best.r.id).toBe("lbl");
  });

  it("matches an acronym", () => {
    expect(rank("nw")[0]).toBe("new-ws");
  });

  it("still matches a subsequence", () => {
    expect(rank("nwspc")).toContain("new-ws");
  });

  /* A single vowel matched 100% of the list. Ranking, not filtering, is the
   * fix for one character — but the top of the list has to be defensible. */
  it("does not let one character return a list in arbitrary order", () => {
    const r = rank("s");
    // Rows whose label *starts* with s come before rows that merely contain one.
    expect(r.indexOf("settings")).toBeLessThan(r.indexOf("stats"));
    expect(r.indexOf("settings")).toBeLessThan(r.indexOf("prs"));
  });

  /* The spread floor. Without it "cl" pulled in anything with a c before an l
   * anywhere, which is most English. */
  it("drops a subsequence whose characters are scattered too far apart", () => {
    const far: Scorable = { label: "Capture a prompt for later" };
    // c…l spans nearly the whole label.
    expect(matchCommand("cl", far)?.field).not.toBe("label");
    const near: Scorable = { label: "Clone" };
    expect(matchCommand("cl", near)).not.toBeNull();
  });

  it("reports which hidden field matched, so the row can explain itself", () => {
    const m = matchCommand("claude", SESSION.find((r) => r.id === "hazel")!);
    expect(m?.field).toBe("keywords");
    expect(m?.note).toBe("claude");
    expect(m?.ranges).toEqual([]);
  });

  it("returns label ranges for highlighting", () => {
    const m = matchCommand("work", { label: "New workspace" });
    expect(m?.ranges).toEqual([[4, 8]]);
  });

  it("treats an empty query as a match for everything, at equal cost", () => {
    const scores = SESSION.map((r) => matchCommand("", r)?.score);
    expect(new Set(scores)).toEqual(new Set([0]));
  });
});

describe("cmdk frecency", () => {
  // Node 22 installs its own experimental `localStorage` global, and in this
  // runner it shadows jsdom's with an object that has no getItem. The module
  // guards against exactly that (frecency degrades to "no history", nothing
  // throws), which is right in production and useless for testing the store —
  // so put a real one in place first.
  beforeEach(() => {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => store.set(k, String(v)),
        removeItem: (k: string) => store.delete(k),
      },
    });
    clearFrecency();
  });

  it("prefers a command you have run", () => {
    noteCommandRun("new-ws");
    const uses = frecencySnapshot();
    expect(frecencyBonus("new-ws", uses)).toBeGreaterThan(0);
    expect(frecencyBonus("race", uses)).toBe(0);
  });

  it("decays, so last quarter's habit loses to this morning's", () => {
    const now = Date.now();
    const old = now - 90 * 24 * 3600 * 1000;
    noteCommandRun("race", old);
    noteCommandRun("race", old);
    noteCommandRun("race", old);
    noteCommandRun("new-ws", now);
    const uses = frecencySnapshot();
    expect(frecencyBonus("new-ws", uses, now)).toBeGreaterThan(frecencyBonus("race", uses, now));
  });

  /* The bound is the contract: history reorders rows that matched the same
   * way and can never promote one across a field tier. */
  it("can never lift a keyword match above a label match", () => {
    for (let i = 0; i < 500; i++) noteCommandRun("hot");
    expect(frecencyBonus("hot", frecencySnapshot())).toBeLessThan(1000);
  });

  /* Pane ids are minted fresh on every restore, so an uncapped store grows
   * forever with keys that can never match again. */
  it("caps how many ids it remembers", () => {
    for (let i = 0; i < 200; i++) noteCommandRun(`pane:${i}`);
    expect(Object.keys(frecencySnapshot()).length).toBeLessThanOrEqual(60);
  });
});
