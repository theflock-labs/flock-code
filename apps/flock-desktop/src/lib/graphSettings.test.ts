// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getGraphEnabled, getGraphExplorerView, getGraphUrl, isTeamGraph, setGraphExplorerView, setGraphUrl } from "./graphSettings";
import { graphSnippets } from "./graphSnippets";

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
});
afterEach(() => vi.unstubAllGlobals());

it("defaults to the searchable list when no valid view preference is saved", () => {
  expect(getGraphExplorerView()).toBe("list");
  localStorage.setItem("flock:graph-explorer-view", "retired-view");
  expect(getGraphExplorerView()).toBe("list");
});

it.each(["list", "graph", "recall"] as const)("remembers the %s view without enabling Graph or changing its connection", (view) => {
  const url = "postgresql://member:secret@team.example/graph";
  setGraphUrl(url);
  setGraphExplorerView(view);
  expect(getGraphExplorerView()).toBe(view);
  expect(getGraphEnabled()).toBe(false);
  expect(getGraphUrl()).toBe(url);
});

it("resolves default and legacy settings through the native local engine", () => {
  expect(getGraphUrl()).toBe("");
  for (const host of ["127.0.0.1", "localhost"]) {
    localStorage.setItem("flock:graph-url", `postgresql://flock:flock@${host}:15432/flock_kg`);
    expect(getGraphUrl()).toBe("");
    expect(isTeamGraph()).toBe(false);
  }
});

it("preserves an explicit team URL and removes it when switching local", () => {
  const url = "postgresql://member:secret@team.example/graph";
  setGraphUrl(url);
  expect(getGraphUrl()).toBe(url);
  expect(isTeamGraph()).toBe(true);
  setGraphUrl("");
  expect(localStorage.getItem("flock:graph-url")).toBeNull();
  expect(isTeamGraph()).toBe(false);
});

it("local registration snippets contain no database credentials", () => {
  for (const snippet of Object.values(graphSnippets("/Applications/flock app/flock-mcp", ""))) {
    expect(snippet.code).not.toContain("FLOCK_KG_URL");
    expect(snippet.code).not.toContain("postgresql://");
  }
});

it("quotes team credentials and executable paths instead of interpolating shell code", () => {
  const path = "/tmp/tool path/'$(touch nope)";
  const url = "postgresql://user:p'ass&word@team/graph";
  const snippets = graphSnippets(path, url);
  const server = JSON.parse(snippets.opencode.code).mcp["flock-graph"];
  expect(server.command).toEqual([path]);
  expect(server.environment.FLOCK_KG_URL).toBe(url);
  expect(snippets.claude.code).toContain("'FLOCK_KG_URL=postgresql://user:p'\"'\"'ass&word@team/graph'");
  expect(snippets.codex.code).toContain(`command = ${JSON.stringify(path)}`);
});
