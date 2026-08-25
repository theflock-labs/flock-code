import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelDraft, clearReview, commitDraft, composeAnnotationPrompt, formatAnchor, getReview,
  removeAnnotation, resetAllReviews, retargetDraft, setDraftNote, startDraft, subscribeAnnotations,
  type DiffAnnotation,
} from "./diffAnnotations";

const note = (over: Partial<DiffAnnotation> = {}): DiffAnnotation => ({
  id: "n1",
  anchor: { path: "src/foo.ts", side: "new", line: 42, endLine: 42 },
  code: [{ sign: "+", text: "const x = 1;" }],
  note: "this leaks when the promise rejects",
  ...over,
});

describe("composeAnnotationPrompt", () => {
  it("says nothing when there is nothing to say", () => {
    expect(composeAnnotationPrompt([])).toBe("");
  });

  // A composer that was opened and abandoned must not be able to inject a
  // header with no body into the agent's input line.
  it("ignores notes whose text is blank", () => {
    expect(composeAnnotationPrompt([note({ note: "   \n " })])).toBe("");
  });

  it("writes one comment as file, quoted code, note", () => {
    expect(composeAnnotationPrompt([note()], { title: "the working tree" })).toBe(
      [
        "Review notes on the working tree — 1 comment across 1 file. " +
        "Please address each one; if a note is ambiguous, ask before changing anything.",
        "",
        "src/foo.ts",
        "  1. line 42",
        "     + const x = 1;",
        "     note: this leaks when the promise rejects",
      ].join("\n"),
    );
  });

  it("defaults the subject when the caller names none", () => {
    expect(composeAnnotationPrompt([note()])).toContain("Review notes on the diff — 1 comment");
  });

  it("quotes a range with every line's marker intact", () => {
    const prompt = composeAnnotationPrompt([note({
      anchor: { path: "src/foo.ts", side: "new", line: 42, endLine: 44 },
      code: [
        { sign: " ", text: "before();" },
        { sign: "-", text: "old();" },
        { sign: "+", text: "fresh();" },
      ],
    })]);
    expect(prompt).toContain("  1. lines 42-44");
    expect(prompt).toContain("       before();");
    expect(prompt).toContain("     - old();");
    expect(prompt).toContain("     + fresh();");
  });

  // "line 42" on a deleted line means 42 of the *old* file; without the marker
  // the agent goes to line 42 of the file on disk, which after a big hunk is a
  // different function entirely.
  it("marks old-side line numbers as pre-change", () => {
    const prompt = composeAnnotationPrompt([note({
      anchor: { path: "src/foo.ts", side: "old", line: 7, endLine: 7 },
      code: [{ sign: "-", text: "gone();" }],
    })]);
    expect(prompt).toContain("  1. line 7 (before the change)");
  });

  it("groups by file, numbers continuously, and counts both", () => {
    const prompt = composeAnnotationPrompt([
      note({ id: "a", anchor: { path: "src/b.ts", side: "new", line: 3, endLine: 3 }, note: "second file" }),
      note({ id: "b", anchor: { path: "src/a.ts", side: "new", line: 9, endLine: 9 }, note: "later line" }),
      note({ id: "c", anchor: { path: "src/a.ts", side: "new", line: 1, endLine: 1 }, note: "first line" }),
    ], { fileOrder: ["src/a.ts", "src/b.ts"] });
    const lines = prompt.split("\n");
    expect(lines[0]).toContain("3 comments across 2 files");
    expect(lines.filter((l) => l === "src/a.ts" || l === "src/b.ts")).toEqual(["src/a.ts", "src/b.ts"]);
    expect(prompt.indexOf("1. line 1")).toBeLessThan(prompt.indexOf("2. line 9"));
    expect(prompt.indexOf("2. line 9")).toBeLessThan(prompt.indexOf("3. line 3"));
  });

  // A note can outlive the hunk it was written against (the agent kept working
  // while the modal was shut). It still has to reach the agent, just last.
  it("puts files the diff no longer lists after the ones it does", () => {
    const prompt = composeAnnotationPrompt([
      note({ id: "a", anchor: { path: "src/gone.ts", side: "new", line: 1, endLine: 1 }, note: "orphan" }),
      note({ id: "b", anchor: { path: "src/here.ts", side: "new", line: 1, endLine: 1 }, note: "live" }),
    ], { fileOrder: ["src/here.ts"] });
    expect(prompt.indexOf("src/here.ts")).toBeLessThan(prompt.indexOf("src/gone.ts"));
  });

  it("caps a huge range and says how much it dropped", () => {
    const code = Array.from({ length: 34 }, (_, i) => ({ sign: "+" as const, text: `line ${i}` }));
    const prompt = composeAnnotationPrompt([note({ code })]);
    expect(prompt).toContain("     + line 29");
    expect(prompt).not.toContain("+ line 30");
    expect(prompt).toContain("… 4 more lines");
  });

  it("caps a single very long line", () => {
    const prompt = composeAnnotationPrompt([note({ code: [{ sign: "+", text: "x".repeat(500) }] })]);
    expect(prompt).toContain(`+ ${"x".repeat(200)}…`);
    expect(prompt).not.toContain("x".repeat(201));
  });

  it("indents a multi-line note under its own item", () => {
    const prompt = composeAnnotationPrompt([note({ note: "first line\nsecond line" })]);
    expect(prompt).toContain("     note: first line\n     second line");
  });

  // The whole reason the quoted code is indented rather than fenced: a diff of
  // a Markdown file would close the fence early and the rest of the review
  // would be read as prose.
  it("never emits a code fence, whatever the diff contains", () => {
    const prompt = composeAnnotationPrompt([note({ code: [{ sign: "+", text: "```ts" }] })]);
    expect(prompt).toContain("     + ```ts");
    expect(prompt.split("\n").some((l) => l.startsWith("```"))).toBe(false);
  });

  it("trims trailing whitespace off quoted code", () => {
    const prompt = composeAnnotationPrompt([note({ code: [{ sign: " ", text: "  " }] })]);
    expect(prompt.split("\n").every((l) => l === l.trimEnd())).toBe(true);
  });
});

describe("formatAnchor", () => {
  it("names a single line and a range differently", () => {
    expect(formatAnchor({ path: "a", side: "new", line: 3, endLine: 3 })).toBe("line 3");
    expect(formatAnchor({ path: "a", side: "new", line: 3, endLine: 8 })).toBe("lines 3-8");
  });
});

describe("the review store", () => {
  const KEY = "working:/repo";
  const anchor = { path: "src/foo.ts", side: "new" as const, line: 5, endLine: 5 };
  const code = [{ sign: "+" as const, text: "boom();" }];

  beforeEach(() => resetAllReviews());

  // useSyncExternalStore re-renders forever if getSnapshot hands back a new
  // object each call, so an untouched review must be the *same* empty state.
  it("returns a stable snapshot while nothing changes", () => {
    expect(getReview(KEY)).toBe(getReview(KEY));
    startDraft(KEY, anchor, code);
    expect(getReview(KEY)).toBe(getReview(KEY));
  });

  it("turns a draft into an annotation on commit", () => {
    startDraft(KEY, anchor, code);
    setDraftNote(KEY, "  rename this  ");
    commitDraft(KEY);
    const review = getReview(KEY);
    expect(review.draft).toBeNull();
    expect(review.annotations).toHaveLength(1);
    expect(review.annotations[0].note).toBe("rename this");
    expect(review.annotations[0].anchor).toEqual(anchor);
  });

  it("treats committing an empty note as a cancel", () => {
    startDraft(KEY, anchor, code);
    setDraftNote(KEY, "   ");
    commitDraft(KEY);
    expect(getReview(KEY)).toEqual({ annotations: [], draft: null });
  });

  // Shift-clicking a second line is a correction to the selection, not a
  // decision to retype the comment.
  it("keeps the typed note when the range is stretched", () => {
    startDraft(KEY, anchor, code);
    setDraftNote(KEY, "half a sentence");
    retargetDraft(KEY, { ...anchor, endLine: 9 }, [...code, { sign: "+", text: "more();" }]);
    expect(getReview(KEY).draft).toEqual({
      anchor: { path: "src/foo.ts", side: "new", line: 5, endLine: 9 },
      code: [{ sign: "+", text: "boom();" }, { sign: "+", text: "more();" }],
      note: "half a sentence",
    });
  });

  it("keeps reviews apart by key", () => {
    startDraft(KEY, anchor, code);
    setDraftNote(KEY, "one");
    commitDraft(KEY);
    expect(getReview("working:/other").annotations).toHaveLength(0);
    expect(getReview(KEY).annotations).toHaveLength(1);
  });

  it("removes one note and discards the rest", () => {
    startDraft(KEY, anchor, code);
    setDraftNote(KEY, "one");
    commitDraft(KEY);
    startDraft(KEY, { ...anchor, line: 6, endLine: 6 }, code);
    setDraftNote(KEY, "two");
    commitDraft(KEY);
    const [first] = getReview(KEY).annotations;
    removeAnnotation(KEY, first.id);
    expect(getReview(KEY).annotations.map((a) => a.note)).toEqual(["two"]);
    clearReview(KEY);
    expect(getReview(KEY).annotations).toHaveLength(0);
  });

  it("notifies subscribers on every mutation and stops on unsubscribe", () => {
    const fn = vi.fn();
    const off = subscribeAnnotations(fn);
    startDraft(KEY, anchor, code);
    setDraftNote(KEY, "x");
    commitDraft(KEY);
    expect(fn.mock.calls.length).toBe(3);
    off();
    cancelDraft(KEY);
    clearReview(KEY);
    expect(fn.mock.calls.length).toBe(3);
  });
});
