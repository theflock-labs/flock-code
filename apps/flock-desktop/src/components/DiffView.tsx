import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { openPath } from "@tauri-apps/plugin-opener";
import { parseUnifiedDiff, diffTotals, type DiffFile } from "../lib/diff";
import { onActivateKey } from "../lib/a11y";
import {
  anchorKey, cancelDraft, clearReview, commitDraft, composeAnnotationPrompt, formatAnchor,
  getReview, removeAnnotation, retargetDraft, setDraftNote, startDraft, subscribeAnnotations,
  type DiffAnchor, type DiffAnnotation, type DiffCodeLine, type DiffSide,
} from "../lib/diffAnnotations";
import { CaretIcon, ExternalLinkIcon, NoteIcon } from "./statusIcons";

/** A pane that can receive this review's notes. */
export interface ReviewTarget {
  id: string;
  label: string;
}

/** Turns the viewer from read-only into an annotatable review surface. */
export interface ReviewConfig {
  /** Stable identity for this diff's notes. Notes live in a module store keyed
   *  by this string (see lib/diffAnnotations), so it must name the *thing being
   *  reviewed* — a checkout path, a PR — and not the component instance, or
   *  reopening the modal starts from an empty review. */
  reviewKey: string;
  /** What was reviewed, for the prompt's opening line ("the working tree"). */
  title?: string;
  /** Panes the notes can be sent to. Callers must only list agents that can
   *  actually see these paths: in a worktree workspace each agent has its own
   *  checkout, so "src/foo.ts:42" sent to the wrong one points at a different
   *  version of the file and the agent edits something nobody reviewed. */
  targets: ReviewTarget[];
  /** Pre-selected target — normally the agent whose checkout this diff is. */
  defaultTargetId?: string;
  /** Hand the composed prompt to a pane. Expected to inject it into the input
   *  line without submitting, so the user still gets the last word. */
  onSend: (paneId: string, prompt: string) => void;
}

interface Props {
  /** Returns the raw unified-diff text to render. */
  load: () => Promise<string>;
  /** File path to reveal + highlight once the diff has rendered. */
  initialPath?: string;
  /** When set, a small "open on GitHub" action is shown in the toolbar. */
  externalUrl?: string;
  /** Shown when the diff comes back empty. */
  emptyMessage?: string;
  /** When set, lines can be commented on and the notes sent to an agent. */
  review?: ReviewConfig;
}

/** One diff line flattened out of its hunk, with the identity a note anchors
 *  to. Hunk headers and "\ No newline" markers are dropped: they have no line
 *  number, so nothing can hang off them. */
interface FlatLine {
  key: string;
  side: DiffSide;
  n: number;
  sign: DiffCodeLine["sign"];
  text: string;
}

/** Everything one FileBlock needs to draw the review layer. Assembled per file
 *  in the parent so a file with no notes gets an empty, cheap object rather
 *  than each row reaching into the store. */
interface FileReview {
  /** Line keys inside some note's range — tinted so the extent of a
   *  multi-line comment is visible without opening it. */
  notedKeys: Set<string>;
  /** Notes to draw under a given line: the last line of their range, which is
   *  where a reader's eye already is after reading the quoted code. */
  cardsByKey: Map<string, DiffAnnotation[]>;
  /** Line key the composer hangs under, when the open draft is in this file. */
  draftKey: string | null;
  draftNote: string;
  onAdd: (key: string, extend: boolean) => void;
  onRemove: (id: string) => void;
  onDraftChange: (note: string) => void;
  onDraftCommit: () => void;
  onDraftCancel: () => void;
}

const NO_NOTES: DiffAnnotation[] = [];

/** The inner diff viewer: a file-list rail plus a scrollable, syntax-tinted
 * diff body with per-file totals and a scroll-spy. It fills its parent and
 * manages its own fetch/parse lifecycle, so it can be dropped into a modal
 * (DiffModal) or embedded in a master-detail pane (PR manager). Remount it
 * (via `key`) to load a different diff.
 *
 * With `review` set it also becomes a review surface: click a line to comment,
 * shift-click to stretch the comment over a range, then send the lot to an
 * agent as one prompt. */
export default function DiffView({ load, initialPath, externalUrl, emptyMessage, review }: Props) {
  const [files, setFiles] = useState<DiffFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(initialPath ?? null);
  const [target, setTarget] = useState<string | null>(null);

  const blockRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const scrollRef = useRef<HTMLDivElement>(null);

  // "" when annotation is off: the hooks below still have to run (they can't
  // be conditional), and an unnamed review is simply always empty.
  const reviewKey = review?.reviewKey ?? "";
  const { annotations, draft } = useSyncExternalStore(subscribeAnnotations, () => getReview(reviewKey));

  useEffect(() => {
    let alive = true;
    load()
      .then((raw) => { if (alive) { setFiles(parseUnifiedDiff(raw)); setError(null); } })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
    // load is a fresh closure each render; deliberately fetch once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reveal the initially-requested file once the diff has rendered.
  useEffect(() => {
    if (!files || !initialPath) return;
    blockRefs.current.get(initialPath)?.scrollIntoView({ block: "start" });
  }, [files, initialPath]);

  const totals = useMemo(() => (files ? diffTotals(files) : { additions: 0, deletions: 0 }), [files]);

  // Each file's lines in render order, plus a key→index lookup. Ranges are
  // resolved through these indexes rather than through line arithmetic, so a
  // selection that straddles deletions (which have no new-side number) still
  // covers exactly the rows the user dragged across.
  const flat = useMemo(() => {
    const byFile = new Map<string, { lines: FlatLine[]; index: Map<string, number> }>();
    for (const f of files ?? []) {
      const lines: FlatLine[] = [];
      const index = new Map<string, number>();
      for (const h of f.hunks) {
        for (const l of h.lines) {
          const side: DiffSide = l.newN != null ? "new" : "old";
          const n = l.newN ?? l.oldN;
          if (n == null) continue; // "\ No newline at end of file" and friends
          const key = anchorKey(f.path, side, n);
          index.set(key, lines.length);
          lines.push({
            key, side, n,
            sign: l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ",
            text: l.text,
          });
        }
      }
      byFile.set(f.path, { lines, index });
    }
    return byFile;
  }, [files]);

  /** The rows an anchor covers, or null when the diff no longer contains them
   *  — which happens when the agent kept working while the modal was shut and
   *  the re-fetched diff has moved on. Such notes aren't silently dropped;
   *  they surface at the top of the body so they can still be sent or binned. */
  const resolveRange = (anchor: DiffAnchor): FlatLine[] | null => {
    const file = flat.get(anchor.path);
    if (!file) return null;
    const from = file.index.get(anchorKey(anchor.path, anchor.side, anchor.line));
    const to = file.index.get(anchorKey(anchor.path, anchor.side, anchor.endLine));
    if (from == null || to == null) return null;
    return file.lines.slice(Math.min(from, to), Math.max(from, to) + 1);
  };

  // Where a plain click landed, so a later shift-click knows what it is
  // stretching *from*. A ref rather than state: it must not cause a re-render,
  // and losing it on remount only costs the shift-click one extra step.
  const rangeOriginRef = useRef<{ path: string; index: number } | null>(null);

  /** Derive an anchor + captured code from a slice of one file's lines. The
   *  anchor reports new-side numbers whenever the slice has any, because those
   *  are the numbers that match the file on disk the agent is about to edit;
   *  a pure-deletion range has only old-side numbers and says so. */
  const anchorForSlice = (path: string, slice: FlatLine[]): { anchor: DiffAnchor; code: DiffCodeLine[] } => {
    const side: DiffSide = slice.some((l) => l.side === "new") ? "new" : "old";
    const nums = slice.filter((l) => l.side === side).map((l) => l.n);
    return {
      anchor: { path, side, line: Math.min(...nums), endLine: Math.max(...nums) },
      code: slice.map((l) => ({ sign: l.sign, text: l.text })),
    };
  };

  const addNote = (path: string, key: string, extend: boolean) => {
    const file = flat.get(path);
    const clicked = file?.index.get(key);
    if (!file || clicked == null) return;

    // Shift-click stretches the open comment. The origin is the earlier plain
    // click when there was one, otherwise the draft's own start — so a note
    // whose composer survived a remount can still be widened.
    let from = clicked;
    if (extend) {
      const origin = rangeOriginRef.current?.path === path ? rangeOriginRef.current.index : null;
      const draftStart = draft && draft.anchor.path === path
        ? file.index.get(anchorKey(path, draft.anchor.side, draft.anchor.line))
        : null;
      from = origin ?? draftStart ?? clicked;
    } else {
      rangeOriginRef.current = { path, index: clicked };
    }

    const slice = file.lines.slice(Math.min(from, clicked), Math.max(from, clicked) + 1);
    const { anchor, code } = anchorForSlice(path, slice);
    if (extend && draft) retargetDraft(reviewKey, anchor, code);
    else startDraft(reviewKey, anchor, code);
  };

  // Esc must close the composer without closing the modal around it.
  //
  // DiffModal listens for Esc on `window` in the CAPTURE phase, so nothing the
  // textarea does can stop it: capture at window runs before the event has
  // even reached the textarea, and stopPropagation from a descendant is far
  // too late. The only lever is being registered on window first and killing
  // the event outright — React runs a child's mount effect before its
  // parent's, so this listener always precedes the modal's in registration
  // order, and stopImmediatePropagation (not stopPropagation, which spares
  // co-listeners on the same node) is what silences it.
  //
  // Which is also why the deps are empty and the state is read from refs:
  // re-running this effect would re-register the listener *behind* the
  // modal's, and Esc would start eating the whole review again.
  const draftOpenRef = useRef(false);
  draftOpenRef.current = draft !== null;
  const reviewKeyRef = useRef(reviewKey);
  reviewKeyRef.current = reviewKey;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !draftOpenRef.current) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      cancelDraft(reviewKeyRef.current);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const revealFile = (path: string) => {
    setActive(path);
    blockRefs.current.get(path)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // Scroll-spy: keep the sidebar's active file in sync with what's at the top
  // of the diff body, so you always know where you are in a long diff.
  const onScroll = () => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const top = scroller.getBoundingClientRect().top;
    let best: { path: string; dist: number } | null = null;
    for (const [path, el] of blockRefs.current) {
      const dist = Math.abs(el.getBoundingClientRect().top - top);
      if (!best || dist < best.dist) best = { path, dist };
    }
    if (best && best.path !== active) setActive(best.path);
  };

  // Split the review into what can be drawn in place and what can't, and build
  // each file's layer once per render instead of per line.
  const layer = useMemo(() => {
    const perFile = new Map<string, { notedKeys: Set<string>; cardsByKey: Map<string, DiffAnnotation[]> }>();
    const detached: DiffAnnotation[] = [];
    const ensure = (path: string) => {
      let e = perFile.get(path);
      if (!e) { e = { notedKeys: new Set(), cardsByKey: new Map() }; perFile.set(path, e); }
      return e;
    };
    for (const a of annotations) {
      const slice = resolveRange(a.anchor);
      if (!slice || slice.length === 0) { detached.push(a); continue; }
      const e = ensure(a.anchor.path);
      for (const l of slice) e.notedKeys.add(l.key);
      const at = slice[slice.length - 1].key;
      e.cardsByKey.set(at, [...(e.cardsByKey.get(at) ?? []), a]);
    }
    let draftKey: string | null = null;
    if (draft) {
      const slice = resolveRange(draft.anchor);
      if (slice && slice.length > 0) {
        const e = ensure(draft.anchor.path);
        for (const l of slice) e.notedKeys.add(l.key);
        draftKey = slice[slice.length - 1].key;
      }
    }
    return { perFile, detached, draftKey };
    // resolveRange closes over `flat`, which is the only other input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annotations, draft, flat]);

  const targets = review?.targets ?? [];
  // Resolve the target on every render rather than syncing it into state: the
  // pane list can shrink while the modal is open (an agent exits, a worktree
  // is pruned) and a stale id would send the review into a dead pane.
  const activeTarget =
    targets.find((t) => t.id === target) ??
    targets.find((t) => t.id === review?.defaultTargetId) ??
    targets[0] ??
    null;

  const sendNotes = () => {
    if (!review || !activeTarget) return;
    const prompt = composeAnnotationPrompt(annotations, {
      title: review.title,
      fileOrder: (files ?? []).map((f) => f.path),
    });
    if (!prompt) return;
    // Clear before handing off: onSend closes the modal in every caller, and a
    // review that has been delivered must not come back the next time the same
    // key is opened.
    clearReview(reviewKey);
    review.onSend(activeTarget.id, prompt);
  };

  if (error) {
    return (
      <div className="diff-view">
        <div className="diff-view-empty">
          couldn't load diff — {error}
          {externalUrl && (
            <button className="btn-ghost diff-open-external" onClick={() => openPath(externalUrl).catch(console.error)}>
              Open on GitHub instead
            </button>
          )}
        </div>
      </div>
    );
  }
  if (!files) return <div className="diff-view"><div className="diff-view-empty">Loading diff…</div></div>;
  if (files.length === 0) {
    return <div className="diff-view"><div className="diff-view-empty">{emptyMessage ?? "No changes to show."}</div></div>;
  }

  const noteCount = annotations.length;

  return (
    <div className="diff-view">
      <div className="diff-view-bar">
        <span className="diff-add-count">+{totals.additions}</span>
        <span className="diff-del-count">−{totals.deletions}</span>
        <span className="diff-file-count">{files.length} file{files.length === 1 ? "" : "s"} changed</span>
        {review && noteCount === 0 && !draft && (
          <span className="diff-review-hint">click a line to comment · shift-click to extend</span>
        )}
        {externalUrl && (
          <button className="diff-view-external" onClick={() => openPath(externalUrl).catch(console.error)}>
            open on GitHub <ExternalLinkIcon size={11} />
          </button>
        )}
      </div>

      <div className="diff-layout">
        <aside className="diff-file-list">
          {files.map((f) => {
            // Counted off the notes themselves, not off what's drawn: a note
            // whose anchor drifted out of the diff still belongs to this file.
            const n = annotations.reduce((c, a) => (a.anchor.path === f.path ? c + 1 : c), 0);
            return (
              <button
                key={f.path}
                className={`diff-file-item${active === f.path ? " active" : ""}`}
                onClick={() => revealFile(f.path)}
                title={f.oldPath && f.oldPath !== f.path ? `${f.oldPath} → ${f.path}` : f.path}
              >
                <span className={`diff-file-glyph diff-status-${f.status}`}>{statusGlyph(f.status)}</span>
                <span className="diff-file-item-name">{basename(f.path)}</span>
                <span className="diff-file-item-counts">
                  {n > 0 && <span className="diff-file-note-count" title={`${n} review note${n === 1 ? "" : "s"}`}>{n}<NoteIcon size={10} /></span>}
                  {f.additions > 0 && <span className="diff-add-count">+{f.additions}</span>}
                  {f.deletions > 0 && <span className="diff-del-count">−{f.deletions}</span>}
                </span>
              </button>
            );
          })}
        </aside>

        <div className="diff-scroll" ref={scrollRef} onScroll={onScroll}>
          {layer.detached.length > 0 && (
            <div className="diff-detached-notes">
              <div className="diff-detached-head">
                {layer.detached.length} note{layer.detached.length === 1 ? "" : "s"} no longer match this diff — the
                code moved since they were written. They will still be sent.
              </div>
              {layer.detached.map((a) => (
                <NoteCard key={a.id} note={a} onRemove={() => removeAnnotation(reviewKey, a.id)} showAnchor />
              ))}
            </div>
          )}
          {files.map((f) => (
            <FileBlock
              key={f.path}
              file={f}
              registerRef={(el) => { if (el) blockRefs.current.set(f.path, el); else blockRefs.current.delete(f.path); }}
              review={review ? {
                notedKeys: layer.perFile.get(f.path)?.notedKeys ?? EMPTY_KEYS,
                cardsByKey: layer.perFile.get(f.path)?.cardsByKey ?? EMPTY_CARDS,
                draftKey: draft?.anchor.path === f.path ? layer.draftKey : null,
                draftNote: draft?.note ?? "",
                onAdd: (key, extend) => addNote(f.path, key, extend),
                onRemove: (id) => removeAnnotation(reviewKey, id),
                onDraftChange: (note) => setDraftNote(reviewKey, note),
                onDraftCommit: () => commitDraft(reviewKey),
                onDraftCancel: () => cancelDraft(reviewKey),
              } : null}
            />
          ))}
        </div>
      </div>

      {review && noteCount > 0 && (
        <div className="diff-review-bar">
          <span className="diff-review-count">{noteCount} note{noteCount === 1 ? "" : "s"}</span>
          {targets.length === 0 ? (
            <span className="diff-review-nopane">no agent is running in this checkout</span>
          ) : (
            <>
              {targets.length > 1 && (
                <select
                  className="diff-review-target"
                  value={activeTarget?.id ?? ""}
                  onChange={(e) => setTarget(e.target.value)}
                  aria-label="Agent to send the review to"
                >
                  {targets.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                </select>
              )}
              {targets.length === 1 && <span className="diff-review-target-name">→ {targets[0].label}</span>}
            </>
          )}
          <span className="spacer" />
          <button className="btn-ghost diff-review-clear" onClick={() => clearReview(reviewKey)}>discard</button>
          <button
            className="btn-mint-solid diff-review-send"
            disabled={!activeTarget}
            title="Paste the notes into the agent's input line — you still press enter"
            onClick={sendNotes}
          >
            Send to agent
          </button>
        </div>
      )}
    </div>
  );
}

const EMPTY_KEYS: Set<string> = new Set();
const EMPTY_CARDS: Map<string, DiffAnnotation[]> = new Map();

const FileBlock = ({ file, registerRef, review }: {
  file: DiffFile;
  registerRef: (el: HTMLDivElement | null) => void;
  review: FileReview | null;
}) => {
  const [collapsed, setCollapsed] = useState(false);
  const dir = dirname(file.path);

  return (
    <div className="diff-file-block" ref={registerRef}>
      <div
        className="diff-file-block-head"
        onClick={() => setCollapsed((c) => !c)}
        onKeyDown={onActivateKey(() => setCollapsed((c) => !c))}
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
      >
        <span className="diff-block-caret"><CaretIcon size={10} open={!collapsed} /></span>
        <span className={`diff-file-glyph diff-status-${file.status}`}>{statusGlyph(file.status)}</span>
        <span className="diff-block-path">
          {file.oldPath && file.oldPath !== file.path && (
            <span className="diff-block-oldpath">{file.oldPath} → </span>
          )}
          <span className="diff-block-name">{basename(file.path)}</span>
          {dir && <span className="diff-block-dir">{dir}</span>}
        </span>
        <span className="diff-block-counts">
          {file.additions > 0 && <span className="diff-add-count">+{file.additions}</span>}
          {file.deletions > 0 && <span className="diff-del-count">−{file.deletions}</span>}
        </span>
      </div>

      {!collapsed && (
        file.binary ? (
          <div className="diff-binary-note">Binary file — not shown</div>
        ) : file.hunks.length === 0 ? (
          <div className="diff-binary-note">
            {file.status === "renamed" ? "Renamed with no content changes" : "No textual changes"}
          </div>
        ) : (
          <div className={`diff-code${review ? " annotatable" : ""}`}>
            {file.hunks.map((h, hi) => (
              <div className="diff-hunk" key={hi}>
                <div className="diff-line diff-line-hunk">
                  {review && <span className="diff-note-cell" />}
                  <span className="diff-gutter" />
                  <span className="diff-gutter" />
                  <span className="diff-line-text">{h.header}</span>
                </div>
                {h.lines.map((l, li) => {
                  const n = l.newN ?? l.oldN;
                  const key = n == null ? null : anchorKey(file.path, l.newN != null ? "new" : "old", n);
                  const cards = (key && review?.cardsByKey.get(key)) || NO_NOTES;
                  const noted = !!key && !!review?.notedKeys.has(key);
                  return (
                    // The row and anything hanging off it share one wrapper so
                    // the notes can be sticky-positioned against the diff's
                    // horizontal scroll — see .diff-line-group in global.css.
                    <div className="diff-line-group" key={li}>
                      <div className={`diff-line diff-line-${l.kind}${noted ? " diff-line-noted" : ""}`}>
                        {review && (
                          <span className="diff-note-cell">
                            {key && (
                              <button
                                className="diff-note-add"
                                title="Comment on this line — shift-click to extend the range"
                                // Names the side too: a deletion's number is
                                // the old file's, so "line 2" alone points a
                                // screen reader at two different rows.
                                aria-label={`Comment on ${l.kind === "del" ? "removed " : ""}line ${n}`}
                                onClick={(e) => review.onAdd(key, e.shiftKey)}
                              >
                                +
                              </button>
                            )}
                          </span>
                        )}
                        <span className="diff-gutter">{l.oldN ?? ""}</span>
                        <span className="diff-gutter">{l.newN ?? ""}</span>
                        <span className="diff-line-sign">
                          {l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}
                        </span>
                        <span className="diff-line-text">{l.text || " "}</span>
                      </div>
                      {cards.map((a) => (
                        <NoteCard key={a.id} note={a} onRemove={() => review?.onRemove(a.id)} />
                      ))}
                      {review && key && review.draftKey === key && (
                        <NoteComposer
                          note={review.draftNote}
                          onChange={review.onDraftChange}
                          onCommit={review.onDraftCommit}
                          onCancel={review.onDraftCancel}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
};

/** A saved note, drawn under the last line of its range. */
function NoteCard({ note, onRemove, showAnchor }: {
  note: DiffAnnotation;
  onRemove: () => void;
  /** Detached notes have no line to sit under, so they name their own. */
  showAnchor?: boolean;
}) {
  return (
    <div className="diff-note-row">
      <div className="diff-note-card">
        {showAnchor && <div className="diff-note-anchor">{note.anchor.path} · {formatAnchor(note.anchor)}</div>}
        <div className="diff-note-text">{note.note}</div>
        <button className="diff-note-remove" title="Remove this note" aria-label="Remove this note" onClick={onRemove}>×</button>
      </div>
    </div>
  );
}

function NoteComposer({ note, onChange, onCommit, onCancel }: {
  note: string;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // Focus on open, not on every keystroke: the composer re-renders on each
  // character because the text lives in the store, and re-focusing would fight
  // any cursor the user moved.
  useEffect(() => { ref.current?.focus(); }, []);

  return (
    <div className="diff-note-row">
      <div className="diff-note-composer">
        <textarea
          ref={ref}
          className="diff-note-input"
          value={note}
          placeholder="What should the agent change here?"
          rows={2}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            // Plain Enter stays a newline: a review note is often a sentence
            // and a half, and losing the second half to an accidental commit
            // is worse than one extra modifier.
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onCommit(); }
          }}
        />
        <div className="diff-note-actions">
          <span className="diff-note-kbd"><span className="kbd">⌘</span><span className="kbd">↵</span></span>
          <button className="btn-ghost diff-note-cancel" onClick={onCancel}>cancel</button>
          <button className="btn-mint-solid diff-note-save" onClick={onCommit} disabled={note.trim() === ""}>add note</button>
        </div>
      </div>
    </div>
  );
}

function statusGlyph(status: DiffFile["status"]): string {
  switch (status) {
    case "added": return "A";
    case "deleted": return "D";
    case "renamed": return "R";
    default: return "M";
  }
}

function basename(path: string): string {
  const segs = path.split("/");
  return segs[segs.length - 1] || path;
}

function dirname(path: string): string {
  const segs = path.split("/");
  segs.pop();
  return segs.length ? segs.join("/") + "/" : "";
}
