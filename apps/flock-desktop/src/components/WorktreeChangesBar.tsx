import { useEffect, useRef, useState } from "react";
import { onActivateKey } from "../lib/a11y";
import type { RepoMap } from "../lib/tauri";
import type { Workspace } from "../types";

/** Titlebar counter pinned to the left, mirroring the usage bar on the right:
 * total uncommitted files across every worktree in every workspace. It's the
 * "how much unsaved work is in flight" glance. Clicking drops a breakdown by
 * workspace; picking one focuses it and pops open its Git section.
 *
 * Data is read straight from `repoMaps` (already polled every 10s for the
 * branch UI) — each worktree carries a `dirty` file count — so there's no extra
 * fetch. Renders nothing when everything's committed. */
export default function WorktreeChangesBar({
  workspaces,
  repoMaps,
  onOpenGit,
}: {
  workspaces: Workspace[];
  repoMaps: Record<string, RepoMap>;
  onOpenGit: (workspaceId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // One row per dirty worktree, deduped by path so a repo shared across two
  // workspaces isn't counted twice. Ordered by most changes first.
  const seen = new Map<string, { wsId: string; wsName: string; branch: string; dirty: number }>();
  for (const ws of workspaces) {
    const map = repoMaps[ws.id];
    if (!map?.is_repo) continue;
    for (const wt of map.worktrees) {
      if (wt.dirty <= 0 || seen.has(wt.path)) continue;
      seen.set(wt.path, {
        wsId: ws.id,
        wsName: ws.name,
        branch: wt.branch || wt.head || "detached",
        dirty: wt.dirty,
      });
    }
  }
  const rows = [...seen.values()].sort((a, b) => b.dirty - a.dirty);
  const total = rows.reduce((n, r) => n + r.dirty, 0);
  if (total === 0) return null;

  const tip = `${total} uncommitted file${total === 1 ? "" : "s"} across ${rows.length} worktree${rows.length === 1 ? "" : "s"}`;

  return (
    <div className="changes-mount" ref={ref}>
      <div
        className="changes-bar clickable"
        title={tip}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onActivateKey(() => setOpen((o) => !o))}
      >
        <span className="changes-icon">±</span>
        <span className="changes-count">{total}</span>
      </div>

      {open && (
        <div className="usage-popover left" role="dialog">
          <div className="settings-section-header usage-header">
            <span>Uncommitted changes</span>
          </div>
          <div className="changes-list">
            {rows.map((r) => (
              <button
                key={r.wsId + r.branch}
                className="changes-row"
                onClick={() => {
                  onOpenGit(r.wsId);
                  setOpen(false);
                }}
              >
                <span className="changes-row-name">{r.wsName}</span>
                <span className="changes-row-branch">{r.branch}</span>
                <span className="changes-row-count">{r.dirty}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
