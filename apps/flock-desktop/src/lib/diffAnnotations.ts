// Inline review notes on a rendered diff, and the prompt they compose into.
//
// Two halves live here on purpose. The store is a module-level singleton
// keyed by a caller-supplied review key rather than React state inside
// DiffView, because DiffView is a leaf that gets torn down for reasons that
// have nothing to do with the review: the diff modal is unmounted on Esc or
// an overlay click, GitPanel repolls every 2.5s, and the PR hub remounts the
// whole detail pane (`key={repo#number}`) when the list refreshes underneath
// it. Notes typed into component state would evaporate on any of those, which
// is exactly the moment they're most expensive to lose — the user has read the
// whole diff and is one click from sending. Surviving a remount also means the
// composer draft survives Esc, so closing the modal by reflex costs nothing.
//
// The other half — composeAnnotationPrompt — is pure so it can be tested
// without a DOM, and so the exact bytes injected into an agent's input line
// are pinned by tests rather than by eyeballing a terminal.

export type DiffSide = "old" | "new";

/** Where a note hangs. Line numbers are the diff's own — `new` numbering for
 *  added/context lines, `old` for deletions, which have no new-side number.
 *  Anchoring on (path, side, line) rather than an index into the parsed diff
 *  is what lets a note re-attach after the diff is re-fetched: an index shifts
 *  as soon as one hunk grows, a line number only moves if that region moved. */
export interface DiffAnchor {
  path: string;
  side: DiffSide;
  /** First line of the commented range. */
  line: number;
  /** Last line of the range; equal to `line` for a single-line note. */
  endLine: number;
}

/** One captured diff line: its marker and its text, without the marker. */
export interface DiffCodeLine {
  sign: "+" | "-" | " ";
  text: string;
}

export interface DiffAnnotation {
  id: string;
  anchor: DiffAnchor;
  /** The diff text the note was written against, snapshotted at creation. The
   *  agent is told what the reviewer was looking at even if the file has moved
   *  on since — a note whose quoted code no longer matches is a signal, not a
   *  corruption. */
  code: DiffCodeLine[];
  note: string;
}

/** The note being typed right now. Same shape as an annotation minus the id:
 *  it only becomes one when the user commits it, so an abandoned composer
 *  never inflates the count or the prompt. */
export interface DiffDraft {
  anchor: DiffAnchor;
  code: DiffCodeLine[];
  note: string;
}

export interface ReviewState {
  annotations: DiffAnnotation[];
  draft: DiffDraft | null;
}

/** Shared empty state. `useSyncExternalStore` calls getSnapshot on every
 *  render and throws "The result of getSnapshot should be cached" (really: it
 *  re-renders forever) if the reference changes when nothing has, so a review
 *  with no notes must hand back this one object rather than a fresh `{}`. */
const EMPTY_REVIEW: ReviewState = { annotations: [], draft: null };

const reviews = new Map<string, ReviewState>();
const listeners = new Set<() => void>();

let idCounter = 0;
/** Local id, not a UUID: `crypto.randomUUID` needs Safari 15.4 and the Vite
 *  build targets safari14 for the Tauri webview. Uniqueness only has to hold
 *  within one app run, which a monotonic counter gives for free. */
function nextId(): string {
  idCounter += 1;
  return `ann-${Date.now().toString(36)}-${idCounter}`;
}

function emit() {
  for (const fn of listeners) fn();
}

function setReview(key: string, next: ReviewState) {
  if (next.annotations.length === 0 && next.draft === null) reviews.delete(key);
  else reviews.set(key, next);
  emit();
}

export function subscribeAnnotations(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function getReview(key: string): ReviewState {
  return reviews.get(key) ?? EMPTY_REVIEW;
}

/** Open (or re-target) the composer. Replacing an open draft is deliberate:
 *  clicking a second line while one is being written moves the note rather
 *  than stacking two composers the user has to reconcile. */
export function startDraft(key: string, anchor: DiffAnchor, code: DiffCodeLine[]) {
  const cur = getReview(key);
  setReview(key, { annotations: cur.annotations, draft: { anchor, code, note: "" } });
}

/** Widen or move the open draft's range while keeping what's already typed —
 *  shift-clicking a second line is a correction to the selection, not a
 *  decision to start the comment over. */
export function retargetDraft(key: string, anchor: DiffAnchor, code: DiffCodeLine[]) {
  const cur = getReview(key);
  if (!cur.draft) return;
  setReview(key, { annotations: cur.annotations, draft: { anchor, code, note: cur.draft.note } });
}

export function setDraftNote(key: string, note: string) {
  const cur = getReview(key);
  if (!cur.draft) return;
  setReview(key, { annotations: cur.annotations, draft: { ...cur.draft, note } });
}

export function cancelDraft(key: string) {
  const cur = getReview(key);
  if (!cur.draft) return;
  setReview(key, { annotations: cur.annotations, draft: null });
}

/** Commit the open draft. A blank note is a cancel — an empty comment carries
 *  nothing to the agent and would still bump the "3 notes" count. */
export function commitDraft(key: string): void {
  const cur = getReview(key);
  const draft = cur.draft;
  if (!draft) return;
  if (draft.note.trim() === "") { cancelDraft(key); return; }
  const annotation: DiffAnnotation = {
    id: nextId(),
    anchor: draft.anchor,
    code: draft.code,
    note: draft.note.trim(),
  };
  setReview(key, { annotations: [...cur.annotations, annotation], draft: null });
}

export function removeAnnotation(key: string, id: string) {
  const cur = getReview(key);
  const annotations = cur.annotations.filter((a) => a.id !== id);
  if (annotations.length === cur.annotations.length) return;
  setReview(key, { annotations, draft: cur.draft });
}

export function clearReview(key: string) {
  if (!reviews.has(key)) return;
  reviews.delete(key);
  emit();
}

/** Test-only escape hatch: the store outlives any one component, so a test
 *  that leaves notes behind would leak them into the next one. */
export function resetAllReviews() {
  reviews.clear();
  idCounter = 0;
  emit();
}

// ── Composition ──────────────────────────────────────────────────────────

/** Where a note's anchor sits in the rendered diff, as a lookup key. The path
 *  goes last: side and line have fixed alphabets, so nothing a path can
 *  contain — a colon included — can make two different anchors collide. */
export function anchorKey(path: string, side: DiffSide, line: number): string {
  return `${side}:${line}:${path}`;
}

/** Human-readable range: "line 42", "lines 42-45", and — only on the old side
 *  — a marker saying which copy of the file those numbers index. Without it
 *  "line 42" on a deletion points the agent at whatever now lives at 42 in the
 *  new file, which after a big hunk is a different function entirely. */
export function formatAnchor(anchor: DiffAnchor): string {
  const range = anchor.endLine > anchor.line
    ? `lines ${anchor.line}-${anchor.endLine}`
    : `line ${anchor.line}`;
  return anchor.side === "old" ? `${range} (before the change)` : range;
}

/** A range wide enough to be a scroll rather than a citation stops being
 *  useful context and starts crowding out the notes in the agent's input box. */
const MAX_CODE_LINES = 30;
/** Minified bundles and long data literals turn one quoted line into a
 *  paragraph; the agent can read the file for the rest. */
const MAX_LINE_CHARS = 200;

function quoteCode(code: DiffCodeLine[], indent: string): string[] {
  const shown = code.slice(0, MAX_CODE_LINES);
  const out = shown.map((l) => {
    const text = l.text.length > MAX_LINE_CHARS ? `${l.text.slice(0, MAX_LINE_CHARS)}…` : l.text;
    return `${indent}${l.sign} ${text}`.trimEnd();
  });
  const hidden = code.length - shown.length;
  if (hidden > 0) out.push(`${indent}  … ${hidden} more line${hidden === 1 ? "" : "s"}`);
  return out;
}

export interface ComposeOptions {
  /** What was reviewed, for the opening line ("the working tree", "PR #12").
   *  Defaults to "the diff". */
  title?: string;
  /** Paths in the order the diff renders them, so the prompt walks the files
   *  in the same order the reviewer read them. Files not listed keep their
   *  insertion order and follow the listed ones. */
  fileOrder?: string[];
}

/**
 * Turn a set of notes into one prompt for an agent.
 *
 * Deliberately indented rather than fenced: a diff of Markdown, of this repo's
 * own CLAUDE.md, or of any file containing ``` would terminate a fenced block
 * early and leave the rest of the review being read as prose. Indentation has
 * no such escape to collide with.
 *
 * Returns "" when there is nothing to say, which is the caller's cue not to
 * inject anything at all — pasting an empty prompt would still dirty the
 * agent's input line.
 */
export function composeAnnotationPrompt(
  annotations: DiffAnnotation[],
  options: ComposeOptions = {},
): string {
  const live = annotations.filter((a) => a.note.trim() !== "");
  if (live.length === 0) return "";

  const order = options.fileOrder ?? [];
  const rank = new Map(order.map((p, i) => [p, i]));
  // Files the diff doesn't list (a note that outlived its file) sort after the
  // ones it does, preserving the order they were written in.
  const fallback = new Map<string, number>();
  for (const a of live) {
    if (!rank.has(a.anchor.path) && !fallback.has(a.anchor.path)) {
      fallback.set(a.anchor.path, order.length + fallback.size);
    }
  }
  const fileRank = (path: string) => rank.get(path) ?? fallback.get(path) ?? Number.MAX_SAFE_INTEGER;

  const sorted = [...live].sort((a, b) => {
    const byFile = fileRank(a.anchor.path) - fileRank(b.anchor.path);
    if (byFile !== 0) return byFile;
    // Old-side notes before new-side ones at the same number: that is the
    // order they appear in a hunk.
    if (a.anchor.line !== b.anchor.line) return a.anchor.line - b.anchor.line;
    if (a.anchor.side !== b.anchor.side) return a.anchor.side === "old" ? -1 : 1;
    return 0;
  });

  const fileCount = new Set(sorted.map((a) => a.anchor.path)).size;
  const title = options.title?.trim() || "the diff";
  const lines: string[] = [
    `Review notes on ${title} — ${sorted.length} comment${sorted.length === 1 ? "" : "s"} ` +
    `across ${fileCount} file${fileCount === 1 ? "" : "s"}. Please address each one; ` +
    `if a note is ambiguous, ask before changing anything.`,
  ];

  let n = 0;
  let currentFile: string | null = null;
  for (const a of sorted) {
    if (a.anchor.path !== currentFile) {
      currentFile = a.anchor.path;
      lines.push("", currentFile);
    }
    n += 1;
    lines.push(`  ${n}. ${formatAnchor(a.anchor)}`);
    lines.push(...quoteCode(a.code, "     "));
    const note = a.note.trim().split("\n");
    lines.push(`     note: ${note[0]}`);
    // Continuation lines keep the note's own line breaks but sit under the
    // same indent, so a multi-paragraph comment can't be mistaken for the
    // start of the next numbered item.
    for (const cont of note.slice(1)) lines.push(`     ${cont}`.trimEnd());
  }

  return lines.join("\n");
}
