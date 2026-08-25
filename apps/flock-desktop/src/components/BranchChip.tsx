import { useEffect, useMemo, useRef, useState } from "react";
import { checkoutInWorktree, type RepoMap } from "../lib/tauri";
import type { Workspace } from "../types";
import { BranchIcon } from "./settingsIcons";

interface Props {
  /** The checkout this chip controls — a pane's worktree path, or the
   * workspace's repo_path for the shared main checkout. */
  cwd: string;
  workspace: Workspace;
  repoMap?: RepoMap;
  /** Fallback branch label when the repo map hasn't loaded yet. */
  fallbackBranch?: string;
  /** Shared main checkout (not an isolated worktree) — the picker warns that
   * switching affects every agent using it. */
  shared?: boolean;
  className?: string;
  /** Called after a successful checkout so the app refreshes its git state
   * immediately instead of waiting for the next poll. */
  onGitChanged: () => void;
}

/** Live branch chip with a click-to-open branch picker. Shows the branch
 * actually checked out at `cwd` (from the polled repo map), its dirty count
 * and ahead/behind, and lets the user switch to — or create — a branch in
 * that checkout. Branches held by another worktree are shown disabled with
 * their holder, mirroring git's own one-branch-per-worktree rule. */
export default function BranchChip({ cwd, workspace, repoMap, fallbackBranch, shared, className, onGitChanged }: Props) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  // Anchor the fixed-position dropdown to the chip (a pane-topbar clips
  // anything absolutely positioned inside it).
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);

  const wt = repoMap?.worktrees.find((t) => t.path === cwd);
  const branch = wt ? wt.branch || (wt.head ? `detached@${wt.head}` : "") : fallbackBranch ?? "";

  /** Agent display name (or "main checkout") holding a given worktree path. */
  const holderOf = (path: string): string => {
    const pane = workspace.panes.find((p) => p.cwd === path);
    if (pane) return pane.displayName ?? pane.kind;
    const holder = repoMap?.worktrees.find((t) => t.path === path);
    if (holder?.is_main) return "main checkout";
    return path.split("/").pop() ?? "another worktree";
  };

  const branches = useMemo(() => {
    const list = repoMap?.branches ?? [];
    const q = filter.trim().toLowerCase();
    return q ? list.filter((b) => b.name.toLowerCase().includes(q)) : list;
  }, [repoMap, filter]);

  const exactMatch = branches.some((b) => b.name === filter.trim());
  const canCreate = filter.trim().length > 0 && !exactMatch && !filter.trim().startsWith("-");

  useEffect(() => {
    if (open) {
      setFilter("");
      setError(null);
      const r = chipRef.current?.getBoundingClientRect();
      if (r) setAnchor({ x: r.left, y: r.bottom + 4 });
      // Focus the filter box once the dropdown has rendered.
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  // Getting *out* of the picker, from wherever focus ended up. The click-away
  // overlay below only fires when the click actually lands on it, and Escape
  // used to be handled on the filter box alone — so once a click on a row, on
  // the card's padding, or on the pane behind moved focus, neither exit
  // worked and the dropdown sat there. Both listeners are on the document in
  // the capture phase: that beats xterm, which owns keydown while a terminal
  // has focus. Escape is swallowed rather than passed on, so dismissing the
  // menu can't double as an interrupt to the agent underneath.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      chipRef.current?.focus();
    };
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      // The chip is excluded so its own onClick keeps ownership of the toggle
      // (closing here first would leave the click to reopen it).
      if (pickerRef.current?.contains(target) || chipRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown, true);
    };
  }, [open]);

  const doCheckout = async (name: string, create: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await checkoutInWorktree(cwd, name, create);
      setOpen(false);
      onGitChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!branch && !repoMap) return null;

  return (
    <>
      <button
        ref={chipRef}
        className={`branch-chip${open ? " open" : ""}${className ? ` ${className}` : ""}`}
        title={
          wt
            ? `${shared ? "Shared checkout" : "Isolated git worktree"} at ${wt.path}` +
              (wt.dirty > 0 ? ` — ${wt.dirty} changed file${wt.dirty === 1 ? "" : "s"}` : "") +
              "\nClick to switch branch"
            : "Click to switch branch"
        }
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
      >
        <span className="branch-chip-glyph">{shared ? "@" : <BranchIcon size={10} />}</span>
        <span className="branch-chip-name">{branch || "…"}</span>
        {wt && wt.dirty > 0 && <span className="branch-chip-dirty">{wt.dirty}</span>}
        {wt && wt.ahead > 0 && <span className="branch-chip-ahead">↑{wt.ahead}</span>}
        {wt && wt.behind > 0 && <span className="branch-chip-behind">↓{wt.behind}</span>}
      </button>

      {open && anchor && (
        <>
          {/* Click-away layer under the dropdown. */}
          <div className="branch-picker-overlay" onMouseDown={(e) => { e.stopPropagation(); setOpen(false); }} />
          <div
            ref={pickerRef}
            className="branch-picker"
            style={{ left: Math.min(anchor.x, window.innerWidth - 300), top: anchor.y }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {shared && (
              <div className="branch-picker-warning">
                Shared checkout — switching moves every agent in this workspace.
              </div>
            )}
            <input
              ref={inputRef}
              className="branch-picker-input"
              placeholder="Filter or create branch…"
              value={filter}
              disabled={busy}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                // Escape is handled by the document listener above, for the
                // whole picker rather than just this box.
                if (e.key === "Enter") {
                  const q = filter.trim();
                  if (!q) return;
                  const hit = branches.find((b) => b.name === q) ?? (branches.length === 1 ? branches[0] : undefined);
                  if (hit) {
                    if (!hit.worktree_path || hit.worktree_path === cwd) doCheckout(hit.name, false);
                  } else if (canCreate) {
                    doCheckout(q, true);
                  }
                }
              }}
            />
            <div className="branch-picker-list">
              {branches.map((b) => {
                const isCurrent = b.name === branch;
                const heldElsewhere = !!b.worktree_path && b.worktree_path !== cwd;
                return (
                  <button
                    key={b.name}
                    className={`branch-picker-row${isCurrent ? " current" : ""}${heldElsewhere ? " held" : ""}`}
                    disabled={busy || isCurrent || heldElsewhere}
                    title={heldElsewhere ? `Checked out by ${holderOf(b.worktree_path!)}` : undefined}
                    onClick={() => doCheckout(b.name, false)}
                  >
                    <span className="branch-picker-row-name">{b.name}</span>
                    {isCurrent && <span className="branch-picker-row-note">current</span>}
                    {heldElsewhere && <span className="branch-picker-row-note">held by {holderOf(b.worktree_path!)}</span>}
                  </button>
                );
              })}
              {branches.length === 0 && !canCreate && (
                <div className="branch-picker-empty">No matching branches</div>
              )}
              {canCreate && (
                <button className="branch-picker-row create" disabled={busy} onClick={() => doCheckout(filter.trim(), true)}>
                  <span className="branch-picker-row-name">+ Create "{filter.trim()}"</span>
                </button>
              )}
            </div>
            {busy && <div className="branch-picker-status">Switching…</div>}
            {error && <div className="branch-picker-error">{error}</div>}
          </div>
        </>
      )}
    </>
  );
}
