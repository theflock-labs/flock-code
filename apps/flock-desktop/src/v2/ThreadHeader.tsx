import { memo, useRef, useState } from "react";
import { useContextUsage } from "../lib/contextUsage";
import { Menu, useMenu, type MenuEntry } from "./Menu";
import { BranchIcon, DiffIcon, MoreIcon, PanelLeftIcon, SplitIcon } from "./icons";

const METERED = new Set(["claude", "grok"]);

/** How full the agent's context window is, drawn the way lucy-chat draws
 *  usage: a thin circle with the share used filled in from twelve o'clock —
 *  ink, the warm mark from 60%, red from 85%. Nothing at all without a reading. */
export function ContextRing({ kind, sessionId }: { kind: string; sessionId?: string }) {
  const usage = useContextUsage(METERED.has(kind) ? sessionId : undefined);
  if (!usage) return null;
  const frac = Math.min(1, usage.used_tokens / Math.max(1, usage.window_tokens));
  const level = frac >= 0.85 ? "high" : frac >= 0.6 ? "mid" : "low";
  const color = level === "high" ? "var(--danger)" : level === "mid" ? "var(--mark)" : "var(--ink-2)";
  // A pie: a stroke as wide as the radius it is drawn on, dashed to the share.
  const r = 3.25;
  const c = 2 * Math.PI * r;
  return (
    <span
      className="v2-icon-btn"
      role="img"
      aria-label={`Context ${Math.round(frac * 100)}% full`}
      title={`Context: ${usage.used_tokens.toLocaleString()} of ${usage.window_tokens.toLocaleString()} tokens (${Math.round(frac * 100)}%)${usage.model ? ` · ${usage.model}` : ""}`}
      style={{ cursor: "default" }}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="6.9" fill="none" stroke={level === "low" ? "var(--ink-3)" : color} strokeWidth="1.3" />
        <circle
          cx="8"
          cy="8"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={r * 2}
          strokeDasharray={`${Math.max(0.4, frac * c)} ${c}`}
          transform="rotate(-90 8 8)"
        />
      </svg>
    </span>
  );
}

interface Props {
  title: string;
  project: string;
  branch?: string;
  /** Branches the thread's agents are on, when they differ from `branch`. */
  otherBranches?: string[];
  kind?: string;
  sessionId?: string;
  secure?: boolean;
  race?: boolean;
  sidebarHidden: boolean;
  changesOpen: boolean;
  canRename: boolean;
  onShowSidebar: () => void;
  onRename: (name: string) => void;
  onToggleChanges: () => void;
  onSplit: () => void;
  onCompareRace?: () => void;
  menu: () => MenuEntry[];
}

/** The main panel's bar: what this thread is, where it runs, and its tools —
 *  the context ring, changes, add an agent, and one quiet "…" for the rest. */
function ThreadHeader({
  title,
  project,
  branch,
  otherBranches,
  kind,
  sessionId,
  secure,
  race,
  sidebarHidden,
  changesOpen,
  canRename,
  onShowSidebar,
  onRename,
  onToggleChanges,
  onSplit,
  onCompareRace,
  menu,
}: Props) {
  const [renaming, setRenaming] = useState(false);
  const kept = useRef(false);
  const more = useMenu();
  return (
    <header className="v2-head" data-tauri-drag-region>
      {sidebarHidden && (
        <button type="button" className="v2-icon-btn" aria-label="Show sidebar" title="Show sidebar (⌘\)" onClick={onShowSidebar}>
          <PanelLeftIcon size={16} />
        </button>
      )}
      {renaming ? (
        <input
          className="v2-rename"
          aria-label="Thread name"
          defaultValue={title}
          autoFocus
          maxLength={60}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.blur();
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              kept.current = true;
              e.currentTarget.blur();
            }
          }}
          onBlur={(e) => {
            if (!kept.current && e.currentTarget.value.trim() && e.currentTarget.value.trim() !== title) onRename(e.currentTarget.value);
            kept.current = false;
            setRenaming(false);
          }}
        />
      ) : (
        <h1
          className="v2-head-title"
          title={canRename ? `${title} — double-click to rename` : title}
          onDoubleClick={canRename ? () => setRenaming(true) : undefined}
        >
          {title}
        </h1>
      )}
      <div className="v2-head-meta" data-tauri-drag-region>
        <span data-tauri-drag-region>{project}</span>
        {branch && (
          <span className="v2-pill" title={otherBranches?.length ? `Agents on: ${[branch, ...otherBranches].join(", ")}` : `On ${branch}`}>
            <BranchIcon size={12} />
            <span>{branch}</span>
            {otherBranches && otherBranches.length > 0 && <span>+{otherBranches.length}</span>}
          </span>
        )}
        {secure && (
          <span className="v2-pill" title="Secure mode: these agents run in a Docker jail that sees only this project">
            jailed
          </span>
        )}
        {race && onCompareRace && (
          <button type="button" className="v2-chip" onClick={onCompareRace} title="Compare every contender's diff and merge the winner">
            Compare race
          </button>
        )}
      </div>
      <div className="v2-head-tools">
        {kind && <ContextRing kind={kind} sessionId={sessionId} />}
        <button
          type="button"
          className="v2-icon-btn"
          aria-label="Changes"
          aria-pressed={changesOpen}
          title="Changes and branches"
          onClick={onToggleChanges}
        >
          <DiffIcon size={16} />
        </button>
        <button type="button" className="v2-icon-btn" aria-label="Add an agent beside this one" title="Add an agent (⌘D)" onClick={onSplit}>
          <SplitIcon size={16} />
        </button>
        <button type="button" className="v2-icon-btn" aria-label="More" aria-expanded={more.open} onClick={more.toggle}>
          <MoreIcon size={16} />
        </button>
        {more.anchor && <Menu anchor={more.anchor} entries={menu()} onClose={more.close} align="end" label={title} />}
      </div>
    </header>
  );
}

export default memo(ThreadHeader);
