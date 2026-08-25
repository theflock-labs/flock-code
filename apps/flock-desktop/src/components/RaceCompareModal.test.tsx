// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen, act } from "@testing-library/react";

// The compare view is where a race is judged, and every way it can lie is a
// way to merge the wrong branch: a contender whose diff failed to load must
// not read as "changed nothing", and the merge button must always name the
// contender it will actually merge.

const diffs = new Map<string, { text?: string; error?: string }>();

vi.mock("../lib/tauri", () => ({
  gitDiffAgainst: vi.fn((workPath: string) => {
    const d = diffs.get(workPath);
    if (!d) return Promise.resolve("");
    return d.error ? Promise.reject(new Error(d.error)) : Promise.resolve(d.text ?? "");
  }),
}));

import RaceCompareModal from "./RaceCompareModal";
import type { Pane, RaceState } from "../types";

/** A one-file unified diff with `adds` added lines and one deleted line. */
const diffText = (path: string, adds: number) =>
  [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,1 +1,${adds} @@`,
    "-old",
    ...Array.from({ length: adds }, (_, i) => `+line ${i}`),
  ].join("\n") + "\n";

const race: RaceState = {
  prompt: "Keep the user signed in across a reload",
  baseSha: "a".repeat(40),
  baseLabel: "main",
  startedAt: 0,
  contenders: [
    { agentName: "Pluto", branch: "race-keep-signed-in-pluto", worktreePath: "/wt/a" },
    { agentName: "Nova", branch: "race-keep-signed-in-nova", worktreePath: "/wt/b" },
  ],
};

const pane = (over: Partial<Pane>): Pane => ({
  id: "p", workspaceId: "w", kind: "claude", status: "idle", attention: false, cwd: "/wt/a", ...over,
});

/** Render and let the mocked diff promises settle. */
async function show(props: Partial<Parameters<typeof RaceCompareModal>[0]> = {}) {
  const onMerge = vi.fn();
  await act(async () => {
    render(
      <RaceCompareModal race={race} panes={[]} merging={false} onMerge={onMerge} onClose={() => {}} {...props} />,
    );
  });
  return { onMerge };
}

beforeEach(() => {
  diffs.clear();
  diffs.set("/wt/a", { text: diffText("src/session.ts", 3) });
  diffs.set("/wt/b", { text: diffText("src/session.ts", 9) });
});
afterEach(cleanup);

describe("RaceCompareModal", () => {
  it("shows every contender's totals so they can be compared without opening each", async () => {
    await show();
    const rows = document.querySelectorAll(".race-contender");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("Pluto");
    expect(rows[0].textContent).toContain("+3");
    expect(rows[1].textContent).toContain("Nova");
    expect(rows[1].textContent).toContain("+9");
  });

  // A failed read and an empty worktree look identical if you only print a
  // count, and one of those means "this agent did nothing".
  it("says a diff failed rather than reporting it as no changes", async () => {
    diffs.set("/wt/b", { error: "base ref doesn't resolve" });
    await show();
    const rows = document.querySelectorAll(".race-contender");
    expect(rows[1].textContent).toContain("base ref doesn't resolve");
    expect(rows[1].textContent).not.toContain("no changes yet");
  });

  it("reports a contender whose agent is gone without dropping its row", async () => {
    await show({ panes: [pane({ cwd: "/wt/a", status: "working" })] });
    const rows = document.querySelectorAll(".race-contender");
    expect(rows[0].textContent).toContain("working");
    expect(rows[1].textContent).toContain("no agent");
  });

  it("merges the contender the button names, with the discard choice as made", async () => {
    const { onMerge } = await show();
    const merge = screen.getByRole("button", { name: /Merge Pluto/ });

    await act(async () => { merge.click(); });
    expect(onMerge).toHaveBeenCalledWith("race-keep-signed-in-pluto", false);

    // Select the other contender, tick discard, merge again.
    await act(async () => { (document.querySelectorAll(".race-contender")[1] as HTMLElement).click(); });
    await act(async () => { (document.querySelector('.race-discard input') as HTMLInputElement).click(); });
    await act(async () => { screen.getByRole("button", { name: /Merge Nova/ }).click(); });
    expect(onMerge).toHaveBeenLastCalledWith("race-keep-signed-in-nova", true);
  });

  it("stops offering a merge once one has happened, and says which one won", async () => {
    await show({ race: { ...race, winnerBranch: "race-keep-signed-in-nova" } });
    expect(screen.queryByRole("button", { name: /^Merge/ })).toBeNull();
    expect(document.querySelector(".race-merged-note")?.textContent).toContain("Nova");
    expect(document.querySelectorAll(".race-contender.won")).toHaveLength(1);
  });
});
