import { useEffect, useRef, useState } from "react";
import ModalCloseButton from "./ModalCloseButton";
import AgentLogo from "./AgentLogo";
import { AGENT_KINDS, AGENT_META, agentColor } from "../lib/agents";
import { useFocusTrap } from "../lib/useFocusTrap";
import { onRadioKey } from "../lib/a11y";
import type { AgentKind, WindowLayout } from "../types";
import "../styles/spawnDialog.css";

interface Props {
  defaultKind: AgentKind;
  /** One line saying where these agents will actually work, given how many
   *  are being spawned. Reporting only: the branch plan was decided when the
   *  workspace was created and this dialog does not offer to change it, since
   *  two places to set one thing is how they drift apart. Without it the
   *  dialog asked "which agent, how many" and left the more consequential
   *  answer — which branch each one lands on — entirely off screen. */
  branchNote?: (agentCount: number) => string;
  onConfirm: (kind: AgentKind, layout: WindowLayout) => void;
  onCancel: () => void;
}

const LAYOUTS: { kind: WindowLayout; label: string; rows: number; cols: number }[] = [
  { kind: "single", label: "1",  rows: 1, cols: 1 },
  { kind: "split",  label: "2",  rows: 1, cols: 2 },
  { kind: "quad",   label: "4",  rows: 2, cols: 2 },
  { kind: "six",    label: "6",  rows: 2, cols: 3 },
  { kind: "eight",  label: "8",  rows: 2, cols: 4 },
  { kind: "twelve", label: "12", rows: 3, cols: 4 },
];

/** Same agent + layout pickers as the New Workspace dialog, reused for
 * spawning into an existing (empty) workspace — the workspace already has
 * a repo, so this skips straight to "which agent, how many". Selection never
 * spawns; only Enter or the Spawn button do. */
export default function SpawnLayoutDialog({ defaultKind, branchNote, onConfirm, onCancel }: Props) {
  const [kind, setKind] = useState<AgentKind>(defaultKind);
  const [layout, setLayout] = useState<WindowLayout>("single");
  const modalRef = useRef<HTMLDivElement>(null);
  const agentGroupRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef);

  // Enter spawns, Escape cancels — from anywhere in the dialog. Agent/layout
  // selection is arrow-driven inside each radiogroup, not a window listener, so
  // the two pickers no longer fight over the arrow keys and the layout picker
  // is finally reachable by keyboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { onCancel(); return; }
      if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); onConfirm(kind, layout); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [kind, layout, onCancel, onConfirm]);

  // Land focus on the selected agent so arrows work the instant the dialog
  // opens, without hunting for the first Tab stop.
  useEffect(() => {
    agentGroupRef.current?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')?.focus();
  }, []);

  const activeLayout = LAYOUTS.find((l) => l.kind === layout);
  const count = activeLayout ? activeLayout.rows * activeLayout.cols : 1;
  const note = branchNote?.(count);

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal sd" ref={modalRef} role="dialog" aria-modal="true" aria-label="Spawn layout" onClick={(e) => e.stopPropagation()}>
        <ModalCloseButton onClose={onCancel} />

        <div className="sd-head">
          <div className="sd-eyebrow">Spawn agents</div>
          <div className="sd-title">Which agent, and how many?</div>
        </div>

        <div className="sd-body">
          {/* Agent */}
          <div className="sd-field">
            <label className="sd-label" id="sd-agent-label">Coding agent</label>
            <div className="sd-agents" role="radiogroup" aria-labelledby="sd-agent-label" ref={agentGroupRef}>
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

          {/* Layout */}
          <div className="sd-field">
            <label className="sd-label" id="sd-layout-label">
              Agents <span className="sd-label-hint">panes to open</span>
            </label>
            <div className="sd-layouts" role="radiogroup" aria-labelledby="sd-layout-label">
              {LAYOUTS.map((l, i) => (
                <div
                  key={l.kind}
                  role="radio"
                  aria-checked={layout === l.kind}
                  aria-label={`${l.label} ${l.label === "1" ? "agent" : "agents"}`}
                  tabIndex={layout === l.kind ? 0 : -1}
                  className={`sd-layout${layout === l.kind ? " selected" : ""}`}
                  onClick={() => setLayout(l.kind)}
                  onKeyDown={(e) => onRadioKey(e, i, LAYOUTS.length, (ni) => setLayout(LAYOUTS[ni].kind))}
                >
                  <LayoutThumb rows={l.rows} cols={l.cols} />
                  <span className="sd-layout-n">{l.label}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Inherited from the workspace, shown so it isn't a surprise. Same
              line, same voice as the New Workspace dialog's. */}
          {note && <div className="sd-branch-hint">{note}</div>}
        </div>

        <div className="sd-foot">
          <div className="sd-foot-keys">
            <span>↑↓ choose</span>
            <span>⇥ switch</span>
            <span>esc cancel</span>
          </div>
          <div className="sd-foot-spacer" />
          <button className="sd-btn-ghost" onClick={onCancel}>Cancel</button>
          <button className="sd-btn-primary" onClick={() => onConfirm(kind, layout)}>
            Spawn {count} {count === 1 ? "agent" : "agents"}
            <span className="sd-kbd">⏎</span>
          </button>
        </div>
      </div>
    </div>
  );
}

/** The little grid-of-cells glyph on each count/layout card. Exported because
 * the race dialog picks a contender count with the same control, and a second
 * copy is how the two drift into looking like different widgets. */
export function LayoutThumb({ rows, cols }: { rows: number; cols: number }) {
  const cells = Array.from({ length: rows * cols });
  return (
    <div
      className="sd-thumb"
      style={{ gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${rows}, 1fr)` }}
    >
      {cells.map((_, i) => (
        <div key={i} className="sd-thumb-cell" />
      ))}
    </div>
  );
}
