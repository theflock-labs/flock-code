import { useEffect, useMemo, useRef, useState } from "react";
import { matchCommand, noteCommandRun, frecencyBonus, frecencySnapshot } from "../lib/cmdkScore";

/** One runnable thing. `hint` is the right-hand column: where the command
 * lands (a workspace name) or what it costs (a shortcut), never a description
 * of what the label already said. */
export interface Command {
  id: string;
  label: string;
  hint?: string;
  group: string;
  /** Marks a command that exists because something is waiting on the user.
   * Attention rows sort above everything regardless of match quality. */
  attention?: boolean;
  /** Extra match text that should not be shown — curated synonyms, the verbs
   * someone might reach for instead of the label's wording. Competitive with
   * the label in ranking, one tier down. */
  keywords?: string;
  /** Machine identifiers: repo paths, branches, session ids. Searchable, and
   * deliberately ranked below `keywords` so they can never win a query they
   * only match by accident — see lib/cmdkScore.ts for the "git" case that
   * made this its own field. */
  context?: string;
  /** What this row is about *right now* — an agent's status and task. The
   * palette covers the sidebar when it opens, so a row that says less than
   * the sidebar row it hides is a downgrade the user paid a keystroke for. */
  detail?: string;
  run: () => void;
}

interface Props {
  open: boolean;
  onClose: () => void;
  commands: Command[];
  /**
   * Rows for text that is not a command — the palette's answer to "I want to
   * say something to an agent". Called with the typed text; returns targets.
   *
   * This is the whole reason to press ⌘K rather than use the button that does
   * the same thing: every verb in the list is also one click away, but there
   * is no other keyboard path from "an idea" to "an agent is working on it".
   */
  promptActions?: (text: string) => Command[];
}

/** A scored row plus what the caller needs to explain why it is here. */
interface Row {
  cmd: Command;
  ranges: [number, number][];
  /** Set when the match came from a field the row does not display. */
  note?: string;
}

/**
 * ⌘K. The app's command surface, and the reason the chrome is allowed to be as
 * quiet as it now is: every action that used to need a visible affordance is
 * reachable here by name, so the affordance does not have to be on screen at
 * rest to be findable.
 *
 * Five things about it that are decisions, not defaults:
 *
 * - It opens over the work rather than replacing it, with the scrim at a low
 *   enough alpha that you can still see which workspace you are in. A palette
 *   that blanks the screen makes you re-orient on the way out.
 * - Agents that need input sort to the top and stay there while you type, so
 *   the palette doubles as the answer to "who is waiting on me".
 * - **Anything that is not a command is a prompt.** Type a phrase and the
 *   bottom of the list becomes the agents you can hand it to. `>` forces that
 *   mode for a phrase that would otherwise match a command. Prompts are
 *   *injected, never submitted* — the text lands in the agent's input line and
 *   you press Enter yourself, the same contract the diff-review composer uses.
 * - Rows say why they matched. A hit in a hidden field shows the word that
 *   hit; a hit in the label is highlighted. Typing "cl" used to surface four
 *   agent names with no c and no l anywhere on the row.
 * - It closes on Escape and on any successful run. There is no pinned mode and
 *   no query history; it is summoned, used, and gone. History lives in the
 *   *ranking* (lib/cmdkScore.ts) rather than in the text box, because a
 *   palette you type into blind has to stay predictable.
 */
export default function CommandBar({ open, onClose, commands, promptActions }: Props) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Fresh query on every open. A palette that remembers what you typed last
  // time shows you the results of a question you already answered.
  useEffect(() => {
    if (open) {
      setQuery("");
      setCursor(0);
      // Focus after paint: the input does not exist until this render commits.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // `>` forces prompt mode, for the phrase that would otherwise match a verb.
  const forced = query.startsWith(">");
  const promptText = (forced ? query.slice(1) : query).trim();
  // A single word is a command search; a phrase is something you want to say.
  // Prompt rows are *appended*, never substituted, so a query that does match
  // a command never loses it — except under `>`, which is the explicit ask.
  const wantsPrompt =
    !!promptActions && promptText.length > 0 &&
    (forced || /\s/.test(query.trim()));

  const commandRows: Row[] = useMemo(() => {
    if (forced) return [];
    const uses = frecencySnapshot();
    const scored = commands
      .map((c) => ({ c, m: matchCommand(query, c) }))
      .filter((r): r is { c: Command; m: NonNullable<typeof r.m> } => r.m !== null)
      .map((r) => ({
        ...r,
        // Frecency is a tiebreak *within* a match tier — see cmdkScore. On an
        // empty query every score is 0 and this would reorder the roster, so
        // it only applies once the user has actually asked for something.
        s: r.m.score - (query.trim() ? frecencyBonus(r.c.id, uses) : 0),
      }))
      .sort((a, b) => {
        // Attention first, always. Sorting it by relevance would let a typo
        // bury the only row that is asking for something.
        if (!!a.c.attention !== !!b.c.attention) return a.c.attention ? -1 : 1;
        return a.s - b.s;
      });
    // Cluster into contiguous groups, in order of each group's best match.
    //
    // Without this the list is in pure score order and a group can appear more
    // than once: the workspace-scoped "New agent here" (Start) sorts between
    // the global "Show uncommitted changes" (Review) and "New workspace"
    // (Start), so the rendered list printed Start, Review, Start, Review. The
    // header logic in the render is "draw when the group changes", which is
    // correct and was reporting the truth about a list that was wrong.
    //
    // A Map preserves insertion order, so the first group is still whichever
    // group owns the best-scoring row (which, because attention sorts first, is
    // "Needs you" whenever anything is waiting). Order *within* a group stays
    // by score.
    const byGroup = new Map<string, Row[]>();
    for (const { c, m } of scored) {
      const row: Row = { cmd: c, ranges: m.ranges, note: m.note };
      const bucket = byGroup.get(c.group);
      if (bucket) bucket.push(row);
      else byGroup.set(c.group, [row]);
    }
    return Array.from(byGroup.values()).flat().slice(0, 40);
  }, [commands, query, forced]);

  const promptRows: Row[] = useMemo(
    () => (wantsPrompt ? promptActions!(promptText).map((cmd) => ({ cmd, ranges: [] })) : []),
    // promptActions is rebuilt every render in App; depending on it would
    // rebuild this list on every unrelated state change. The text is what
    // decides the contents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [wantsPrompt, promptText],
  );

  // Prompt rows go last unless nothing else matched, in which case they are
  // the answer rather than an afterthought.
  const results = useMemo(
    () => (commandRows.length === 0 ? promptRows : [...commandRows, ...promptRows]),
    [commandRows, promptRows],
  );

  // Clamp rather than reset: retyping a character that narrows the list should
  // not throw the selection back to the top if the current row still matches.
  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, results.length - 1)));
  }, [results.length]);

  useEffect(() => {
    if (!open) return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-idx="${cursor}"]`);
    // Optional call, not just optional chain on the element: jsdom has no
    // scrollIntoView, and a palette should not be the reason a test file needs
    // a DOM polyfill.
    row?.scrollIntoView?.({ block: "nearest" });
  }, [cursor, open, results.length]);

  if (!open) return null;

  const runAt = (i: number) => {
    const row = results[i];
    if (!row) return;
    noteCommandRun(row.cmd.id);
    onClose();
    // After the close, so a command that opens a dialog is not racing the
    // palette's own teardown for the focus.
    requestAnimationFrame(() => row.cmd.run());
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, results.length - 1));
      return;
    }
    if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      runAt(cursor);
    }
  };

  // Group headers are drawn only when the group changes, so a filtered list
  // does not print six headers over six single rows.
  let lastGroup = "";
  const inPromptMode = promptRows.length > 0;

  return (
    <div className="cmdk-scrim" onMouseDown={onClose}>
      <div
        className="cmdk-panel"
        role="dialog"
        aria-label="Command bar"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="cmdk-field">
          <input
            ref={inputRef}
            className="cmdk-input"
            value={query}
            placeholder="What should happen?"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <kbd className="cmdk-esc">esc</kbd>
        </div>

        <div className="cmdk-list" ref={listRef}>
          {results.length === 0 ? (
            <div className="cmdk-empty">
              {query.trim()
                ? "Nothing matches that. Add a space to send it to an agent instead."
                : "Nothing matches that."}
            </div>
          ) : (
            results.map((row, i) => {
              const header = row.cmd.group !== lastGroup ? row.cmd.group : null;
              lastGroup = row.cmd.group;
              return (
                <div key={row.cmd.id}>
                  {header && <div className="cmdk-group">{header}</div>}
                  <div
                    className={`cmdk-row${i === cursor ? " sel" : ""}${row.cmd.attention ? " attn" : ""}`}
                    data-idx={i}
                    role="button"
                    tabIndex={-1}
                    onMouseMove={() => setCursor(i)}
                    onClick={() => runAt(i)}
                  >
                    <span className="cmdk-label">
                      <Highlighted text={row.cmd.label} ranges={row.ranges} />
                      {row.cmd.detail && <span className="cmdk-detail">{row.cmd.detail}</span>}
                    </span>
                    {/* The word that matched, when it isn't on the row. Without
                        it, a keyword hit reads as the list being broken. */}
                    {row.note && <span className="cmdk-note">{row.note}</span>}
                    {row.cmd.hint && <span className="cmdk-hint">{row.cmd.hint}</span>}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {inPromptMode && (
          // Said once, on the surface, because "sends to the agent" and "types
          // into the agent" are different promises and only one of them is
          // safe to make about text a user has not re-read.
          <div className="cmdk-foot">
            <kbd>↵</kbd> puts the text in that agent&apos;s input line — you still press enter yourself
          </div>
        )}
      </div>
    </div>
  );
}

/** The label with the matched characters marked. Ranges come from the scorer,
 *  are non-overlapping and in order, so this is one pass. */
function Highlighted({ text, ranges }: { text: string; ranges: [number, number][] }) {
  if (ranges.length === 0) return <>{text}</>;
  const out: React.ReactNode[] = [];
  let at = 0;
  ranges.forEach(([s, e], i) => {
    if (s > at) out.push(text.slice(at, s));
    out.push(<mark className="cmdk-hit" key={i}>{text.slice(s, e)}</mark>);
    at = e;
  });
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}
