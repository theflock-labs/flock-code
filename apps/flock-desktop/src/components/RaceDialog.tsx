import { useEffect, useRef, useState } from "react";
import ModalCloseButton from "./ModalCloseButton";
import AgentLogo from "./AgentLogo";
import { LayoutThumb } from "./SpawnLayoutDialog";
import { AGENT_KINDS, AGENT_META, agentColor } from "../lib/agents";
import { useFocusTrap } from "../lib/useFocusTrap";
import { onRadioKey } from "../lib/a11y";
import { raceStem } from "../lib/race";
import type { AgentKind } from "../types";
import "../styles/spawnDialog.css";

interface Props {
  defaultKind: AgentKind;
  /** The branch every contender is cut from, for the hint line. */
  baseLabel: string;
  /** Pre-filled prompt — set when the race was started from the command
   * bar, which is the one entry point where the user has already typed it. */
  initialPrompt?: string;
  onConfirm: (kind: AgentKind, count: number, prompt: string) => void;
  onCancel: () => void;
}

/** Contender counts, in grid shapes the layout engine already builds
 * (`gridDimsFor`). One is missing on purpose: a race of one is just spawning
 * an agent, and every other dialog already does that. */
const COUNTS: { n: number; rows: number; cols: number }[] = [
  { n: 2, rows: 1, cols: 2 },
  { n: 3, rows: 2, cols: 2 },
  { n: 4, rows: 2, cols: 2 },
  { n: 5, rows: 2, cols: 3 },
  { n: 6, rows: 2, cols: 3 },
];

/** Start a fan-out: one prompt, N agents, each in its own worktree off the
 * current HEAD. Same sheet and the same two pickers as Spawn Agents, with the
 * prompt on top — the prompt is the whole point here, so it leads.
 *
 * Enter does NOT confirm: the prompt is a textarea and a multi-line prompt is
 * the normal case. ⌘⏎ (the submit chord every agent CLI already uses) does. */
export default function RaceDialog({ defaultKind, baseLabel, initialPrompt, onConfirm, onCancel }: Props) {
  const [kind, setKind] = useState<AgentKind>(defaultKind);
  const [count, setCount] = useState(3);
  const [prompt, setPrompt] = useState(initialPrompt ?? "");
  const modalRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  useFocusTrap(modalRef);

  const ready = prompt.trim().length > 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { onCancel(); return; }
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.isComposing && ready) {
        e.preventDefault();
        onConfirm(kind, count, prompt.trim());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [kind, count, prompt, ready, onCancel, onConfirm]);

  // Straight into the prompt: it is the only field with no sensible default,
  // and the two pickers below it are reachable by Tab.
  useEffect(() => { promptRef.current?.focus(); }, []);

  // The actual stem the spawn will use, not a description of it — a race
  // leaves N branches in the user's repo and this is the only place they are
  // named before they exist.
  const stem = raceStem(prompt);

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal sd" ref={modalRef} role="dialog" aria-modal="true" aria-label="Race agents" onClick={(e) => e.stopPropagation()}>
        <ModalCloseButton onClose={onCancel} />

        <div className="sd-head">
          <div className="sd-eyebrow">Race agents</div>
          <div className="sd-title">One prompt, several ways</div>
        </div>

        <div className="sd-body">
          <div className="sd-field">
            <label className="sd-label" htmlFor="race-prompt">
              Prompt <span className="sd-label-hint">every contender gets this, verbatim</span>
            </label>
            <textarea
              id="race-prompt"
              ref={promptRef}
              className="sd-input sd-textarea"
              rows={4}
              spellCheck={false}
              placeholder="Rewrite the session store so a reload keeps the user signed in."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              // Escape and ⌘⏎ are handled by the window listener above; stop
              // everything else here so typing a prompt can't trip a global
              // shortcut (⌘D splits the pane behind the dialog).
              onKeyDown={(e) => {
                if (e.key === "Escape") return;
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) return;
                e.stopPropagation();
              }}
            />
          </div>

          <div className="sd-field">
            <label className="sd-label" id="race-agent-label">Coding agent</label>
            <div className="sd-agents" role="radiogroup" aria-labelledby="race-agent-label">
              {AGENT_KINDS.map((k, i) => (
                <div
                  key={k}
                  role="radio"
                  aria-checked={kind === k}
                  aria-label={AGENT_META[k].label}
                  tabIndex={kind === k ? 0 : -1}
                  className={`sd-agent${kind === k ? " selected" : ""}`}
                  style={{ ["--kind-color" as never]: agentColor(k) }}
                  onClick={() => setKind(k)}
                  onKeyDown={(e) => onRadioKey(e, i, AGENT_KINDS.length, (ni) => setKind(AGENT_KINDS[ni]))}
                >
                  <AgentLogo kind={k} size={16} className="sd-agent-logo" />
                  {AGENT_META[k].label}
                </div>
              ))}
            </div>
          </div>

          <div className="sd-field">
            <label className="sd-label" id="race-count-label">
              Contenders <span className="sd-label-hint">one worktree and branch each</span>
            </label>
            <div className="sd-layouts" role="radiogroup" aria-labelledby="race-count-label">
              {COUNTS.map((c, i) => (
                <div
                  key={c.n}
                  role="radio"
                  aria-checked={count === c.n}
                  aria-label={`${c.n} contenders`}
                  tabIndex={count === c.n ? 0 : -1}
                  className={`sd-layout${count === c.n ? " selected" : ""}`}
                  onClick={() => setCount(c.n)}
                  onKeyDown={(e) => onRadioKey(e, i, COUNTS.length, (ni) => setCount(COUNTS[ni].n))}
                >
                  <LayoutThumb rows={c.rows} cols={c.cols} />
                  <span className="sd-layout-n">{c.n}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="sd-branch-hint">
            Cuts {count} branches (<code>{stem}{"-<agent>"}</code>) off {baseLabel}, one worktree each.
            <span className="sd-hint-more"> Compare their diffs when they finish, then merge one.</span>
          </div>
        </div>

        <div className="sd-foot">
          <div className="sd-foot-keys">
            <span>⇥ switch</span>
            <span>esc cancel</span>
          </div>
          <div className="sd-foot-spacer" />
          <button className="sd-btn-ghost" onClick={onCancel}>Cancel</button>
          <button
            className="sd-btn-primary"
            disabled={!ready}
            onClick={() => onConfirm(kind, count, prompt.trim())}
          >
            Race {count} agents
            <span className="sd-kbd">⌘⏎</span>
          </button>
        </div>
      </div>
    </div>
  );
}
