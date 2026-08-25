import { describe, it, expect } from "vitest";
import { groupByProject, projectFor } from "./projectGrouping";
import type { Workspace } from "../types";

/** Only the fields the grouping reads; stubbing the rest of Workspace
 *  faithfully would just make the cases unreadable. */
const ws = (name: string, repo_path: string): Workspace =>
  ({ id: name, name, repo_path } as unknown as Workspace);

const shape = (list: Workspace[]) =>
  groupByProject(list).map((g) => [g.project, g.items.map((i) => i.ws.name)] as const);

describe("projectFor", () => {
  it("names the folder the repo sits in", () => {
    expect(projectFor("/Users/r/git/flock-meta/flock-code")).toBe("flock-meta");
    expect(projectFor("/Users/r/git/flock-meta/flock-website")).toBe("flock-meta");
  });

  /* Grouping on the parent alone would put every repo in ~/git into a group
   * called "git" — the flat list again, with a useless header over it. */
  it("refuses to name a code root", () => {
    for (const p of [
      "/Users/r/git/trader-dashboard",
      "/Users/r/code/thing",
      "/Users/r/Documents/thing",
      "/Users/r/dev/thing",
      "/Users/r/Projects/thing",
    ]) {
      expect(projectFor(p)).toBeNull();
    }
  });

  it("refuses the home folder and shallow paths", () => {
    expect(projectFor("/Users/r/myrepo")).toBeNull();
    expect(projectFor("/home/r/myrepo")).toBeNull();
    expect(projectFor("/repo")).toBeNull();
    expect(projectFor("")).toBeNull();
  });

  it("is case-insensitive about code-root names", () => {
    expect(projectFor("/Users/r/GitHub/thing")).toBeNull();
    expect(projectFor("/Users/r/SRC/thing")).toBeNull();
  });

  it("reads windows paths", () => {
    expect(projectFor("C:\\dev\\proj\\a")).toBe("proj");
    expect(projectFor("C:\\dev\\loose")).toBeNull();
  });
});

describe("groupByProject", () => {
  /* The case this was built for, and the one the first implementation got
   * wrong: with only these two open the group must still appear. */
  it("groups two repos that share a folder, even with nothing else open", () => {
    expect(
      shape([
        ws("flock-code", "/Users/r/git/flock-meta/flock-code"),
        ws("flock-website", "/Users/r/git/flock-meta/flock-website"),
      ]),
    ).toEqual([["flock-meta", ["flock-code", "flock-website"]]]);
  });

  it("keeps root-level repos ungrouped and above the named groups", () => {
    expect(
      shape([
        ws("flock-code", "/Users/r/git/flock-meta/flock-code"),
        ws("trader", "/Users/r/git/trader-dashboard"),
        ws("flock-website", "/Users/r/git/flock-meta/flock-website"),
      ]),
    ).toEqual([
      [null, ["trader"]],
      ["flock-meta", ["flock-code", "flock-website"]],
    ]);
  });

  /* Opening or closing an unrelated repo must not move anything between
   * groups — the first implementation's shared-root rule did exactly that. */
  it("does not change a workspace's group when another repo opens", () => {
    const flock = [
      ws("flock-code", "/Users/r/git/flock-meta/flock-code"),
      ws("flock-website", "/Users/r/git/flock-meta/flock-website"),
    ];
    const before = shape(flock).find(([p]) => p === "flock-meta");
    const after = shape([...flock, ws("trader", "/Users/r/git/trader-dashboard")]).find(
      ([p]) => p === "flock-meta",
    );
    expect(after).toEqual(before);
  });

  it("stays completely flat when nothing has a project", () => {
    expect(
      shape([
        ws("a", "/Users/r/git/alpha"),
        ws("b", "/Users/r/git/beta"),
        ws("c", "/Users/r/git/gamma"),
      ]),
    ).toEqual([[null, ["a", "b", "c"]]]);
  });

  it("keeps two workspaces on one repo together and in order", () => {
    expect(
      shape([
        ws("src-tauri", "/Users/r/git/flock-meta/flock-code"),
        ws("other", "/Users/r/git/standalone"),
        ws("src-tauri-2", "/Users/r/git/flock-meta/flock-code"),
      ]),
    ).toEqual([
      [null, ["other"]],
      ["flock-meta", ["src-tauri", "src-tauri-2"]],
    ]);
  });

  /* Drag-reorder addresses workspaces by their position in the original array,
   * so regrouping has to hand that index back untouched. */
  it("preserves each workspace's original index", () => {
    const list = [
      ws("a", "/Users/r/git/alpha"),
      ws("b", "/Users/r/git/proj/one"),
      ws("c", "/Users/r/git/proj/two"),
    ];
    expect(
      groupByProject(list)
        .flatMap((g) => g.items)
        .map((i) => [i.ws.name, i.index] as const)
        .sort(),
    ).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
    ]);
  });

  it("groups several projects at once", () => {
    expect(
      shape([
        ws("one", "/Users/r/git/proj-a/one"),
        ws("two", "/Users/r/git/proj-b/two"),
        ws("loose", "/Users/r/git/loose"),
      ]),
    ).toEqual([
      [null, ["loose"]],
      ["proj-a", ["one"]],
      ["proj-b", ["two"]],
    ]);
  });

  it("ignores workspaces with no repo path", () => {
    expect(
      shape([
        ws("copilot", ""),
        ws("flock-code", "/Users/r/git/flock-meta/flock-code"),
      ]),
    ).toEqual([
      [null, ["copilot"]],
      ["flock-meta", ["flock-code"]],
    ]);
  });

  it("handles zero and one", () => {
    expect(shape([])).toEqual([[null, []]]);
    expect(shape([ws("solo", "/Users/r/git/solo")])).toEqual([[null, ["solo"]]]);
  });
});
