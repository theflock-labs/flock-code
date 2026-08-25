import { useEffect, useState } from "react";
import { gitOverview, gitWorkingDiff, type GitOverview, type RepoMap, type WorktreeStatus } from "../lib/tauri";
import { isWindowActive, onWindowActiveChange } from "../lib/windowActive";
import type { Workspace } from "../types";
import GitGraph from "./GitGraph";
import DiffModal from "./DiffModal";
import { BranchIcon } from "./settingsIcons";

interface Props {
  repoPath: string;
  workspace: Workspace;
  /** Live worktree/branch snapshot polled by App — drives the agents table
   * and orphaned-worktree list. Undefined until the first poll lands. */
  repoMap?: RepoMap;
  /** Checkout whose status + commits are shown below the agents table — the
   * focused agent's cwd, falling back to the main checkout. */
  overviewPath: string;
  onSelectPane: (paneId: string) => void;
  onAdoptWorktree: (wt: WorktreeStatus) => void;
  onPruneWorktree: (wt: WorktreeStatus) => void;
  /** Drop text into a pane's input line without submitting it — how the diff
   * viewer's review notes get back to the agent that wrote the code. */
  onSendPrompt: (paneId: string, text: string) => void;
}

/**
 * Inline git overview that expands underneath a workspace card in the sidebar.
 * Top: the agent-to-branch map (every checkout of the repo and which agent
 * owns it) plus orphaned worktrees. Below: working-tree changes and recent
 * commits for the focused agent's checkout.
 */
export default function GitPanel({ repoPath, workspace, repoMap, overviewPath, onSelectPane, onAdoptWorktree, onPruneWorktree, onSendPrompt }: Props) {
  const [data, setData] = useState<GitOverview | null>(null);
  const [error, setError] = useState(false);
  // When set, the diff modal is open; `path` (if any) is the file to reveal.
  const [diff, setDiff] = useState<{ path?: string } | null>(null);

  useEffect(() => {
    let alive = true;
    const refresh = () =>
      gitOverview(overviewPath)
        .then((o) => { if (alive) { setData(o); setError(false); } })
        .catch(() => { if (alive) setError(true); });
    refresh();
    // Poll while the panel is open so edits made outside the app (or in
    // another pane's terminal) show up without having to close/reopen the
    // panel — a fresh mount was previously the only thing that refetched.
    //
    // Skipped while the window is hidden, which matters more here than
    // anywhere else in the app: one tick spawns six git subprocesses (see
    // git::overview), two of which — `status --porcelain -uall` and
    // `log -n 120` — walk the whole tree. At 2.5s that was 2.4 processes a
    // second against the user's repo while they were doing something else
    // entirely. Nothing is lost by pausing: the panel is a view of state that
    // is still there when they come back, and coming back refreshes it.
    const id = setInterval(() => { if (isWindowActive()) refresh(); }, 2500);
    const unsubActive = onWindowActiveChange((active) => { if (active) refresh(); });
    return () => { alive = false; clearInterval(id); unsubActive(); };
  }, [overviewPath]);

  const staged = data?.changes.filter((c) => c.staged) ?? [];
  const untracked = data?.changes.filter((c) => !c.staged && c.status === "?") ?? [];
  const changed = data?.changes.filter((c) => !c.staged && c.status !== "?") ?? [];

  // The agent whose checkout the overview below is showing, if any.
  const overviewPane = workspace.panes.find((p) => !p.streamId && p.cwd === overviewPath);

  // Who may receive the diff's review notes. Restricted to agents sitting in
  // the very checkout being diffed: in a worktree workspace every agent has
  // its own copy of the tree, so "src/foo.ts:42" handed to a sibling points at
  // a different version of that file and it would edit code nobody reviewed.
  // (Without worktrees every pane shares repo_path, so this is everyone.)
  const reviewTargets = workspace.panes.filter((p) => !p.streamId && p.cwd === (overviewPath || repoPath));

  const worktrees = repoMap?.worktrees ?? [];
  const paneByCwd = new Map(workspace.panes.filter((p) => !p.streamId).map((p) => [p.cwd, p]));
  const orphans = worktrees.filter((wt) => !wt.is_main && !paneByCwd.has(wt.path));
  const mainWt = worktrees.find((wt) => wt.is_main);

  return (
    <div className="ws-git-panel" onClick={(e) => e.stopPropagation()}>
      {/* ─── Agents × branches ─────────────────────────────────────── */}
      {repoMap?.is_repo && (
        <>
          <div className="git-section-label">
            Agents<span className="git-count">{workspace.panes.filter((p) => !p.streamId).length}</span>
          </div>
          <div className="git-agents">
            {mainWt && (
              <CheckoutRow
                label="main checkout"
                muted
                wt={mainWt}
                active={overviewPath === mainWt.path && !overviewPane}
              />
            )}
            {workspace.panes.filter((p) => !p.streamId).map((p) => {
              const wt = worktrees.find((t) => t.path === p.cwd);
              return (
                <CheckoutRow
                  key={p.id}
                  label={p.displayName ?? p.kind}
                  wt={wt}
                  fallbackBranch={p.worktree?.branch || workspace.branch}
                  active={p.cwd === overviewPath && overviewPane?.id === p.id}
                  onClick={() => onSelectPane(p.id)}
                />
              );
            })}
          </div>

          {orphans.length > 0 && (
            <>
              <div className="git-section-label">
                Worktrees<span className="git-count">{orphans.length}</span>
                <span className="git-orphan-hint">no agent attached</span>
              </div>
              <div className="git-agents">
                {orphans.map((wt) => (
                  <div key={wt.path} className="git-orphan-row" title={wt.path}>
                    <span className="git-orphan-branch"><BranchIcon size={10} /> {wt.branch || `detached@${wt.head}`}</span>
                    {wt.dirty > 0 && <span className="git-checkout-dirty">{wt.dirty}</span>}
                    {wt.prunable && <span className="git-orphan-prunable">stale</span>}
                    <span className="spacer" />
                    {!wt.prunable && (
                      <button
                        className="git-orphan-btn"
                        title="Spawn an agent in this worktree"
                        onClick={() => onAdoptWorktree(wt)}
                      >
                        Adopt
                      </button>
                    )}
                    <button
                      className="git-orphan-btn danger"
                      title="Remove this worktree"
                      onClick={() => onPruneWorktree(wt)}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}

      {error ? (
        <div className="git-empty">Couldn't read git for this repo.</div>
      ) : !data ? (
        <div className="git-empty">Loading…</div>
      ) : !data.is_repo ? (
        <div className="git-empty">Not a git repository.</div>
      ) : (
        <>
          {/* ─── Changes (of the focused checkout) ──────────────────── */}
          {/* Branch + tracking ride in this header rather than a separate
             row above: the highlighted agents row already marks *which*
             checkout is shown, so a standalone branch badge just repeated
             the branch/dirty/ahead-behind it carries. */}
          <div className="git-section-label git-changes-head">
            Changes
            <span
              className="git-branch-badge"
              title={overviewPane ? `${overviewPane.displayName ?? overviewPane.kind}'s checkout` : "main checkout"}
            >
              {data.branch || "detached"}
            </span>
            {(data.ahead > 0 || data.behind > 0) && (
              <span className="git-tracking">
                {data.ahead > 0 && <span className="git-ahead">↑{data.ahead}</span>}
                {data.behind > 0 && <span className="git-behind">↓{data.behind}</span>}
              </span>
            )}
            <span className="git-count git-changes-count">{data.changes.length}</span>
            {data.changes.length > 0 && (
              <button className="git-diff-link" onClick={() => setDiff({})} title="View diff of all changes">
                diff
              </button>
            )}
          </div>
          {data.changes.length === 0 ? (
            <div className="git-clean">Working tree clean</div>
          ) : (
            <div className="git-changes">
              {staged.length > 0 && <div className="git-group-label">Staged</div>}
              {staged.map((c, i) => <FileRow key={`s${i}`} status={c.status} path={c.path} onOpen={() => setDiff({ path: c.path })} />)}
              {changed.length > 0 && <div className="git-group-label">Changed</div>}
              {changed.map((c, i) => <FileRow key={`c${i}`} status={c.status} path={c.path} onOpen={() => setDiff({ path: c.path })} />)}
              {untracked.length > 0 && <div className="git-group-label">Untracked</div>}
              {untracked.map((c, i) => <FileRow key={`u${i}`} status={c.status} path={c.path} onOpen={() => setDiff({ path: c.path })} />)}
            </div>
          )}

          {/* ─── Commit graph ───────────────────────────────────────── */}
          <div className="git-section-label">Recent commits</div>
          {data.commits.length === 0 ? (
            <div className="git-clean">No commits yet</div>
          ) : (
            <GitGraph commits={data.commits} repoPath={overviewPath || repoPath} />
          )}
        </>
      )}

      {diff && (
        <DiffModal
          eyebrow={overviewPane ? (overviewPane.displayName ?? overviewPane.kind).toUpperCase() : "WORKING TREE"}
          title={data?.branch || "Changes"}
          load={() => gitWorkingDiff(overviewPath || repoPath)}
          initialPath={diff.path}
          emptyMessage="Working tree is clean — nothing to diff."
          onClose={() => setDiff(null)}
          review={{
            // Keyed by the checkout, not by this component: the same diff
            // reopened after an accidental Esc must still have its notes, and
            // a sibling agent's worktree is a different review entirely.
            reviewKey: `working:${overviewPath || repoPath}`,
            title: "the working tree",
            targets: reviewTargets.map((p) => ({ id: p.id, label: p.displayName ?? p.kind })),
            defaultTargetId: overviewPane?.id,
            onSend: (paneId, prompt) => {
              onSendPrompt(paneId, prompt);
              // Focus the pane and get out of the way: the prompt is sitting
              // unsubmitted in its input line and the user is meant to read it
              // before pressing enter, which they cannot do behind a modal.
              onSelectPane(paneId);
              setDiff(null);
            },
          }}
        />
      )}
    </div>
  );
}

/** One row of the agents table: who (agent or main checkout), which branch,
 * how dirty, how far ahead/behind. */
function CheckoutRow({ label, wt, fallbackBranch, active, muted, onClick }: {
  label: string;
  wt?: WorktreeStatus;
  fallbackBranch?: string;
  active?: boolean;
  muted?: boolean;
  onClick?: () => void;
}) {
  const branch = wt ? wt.branch || (wt.head ? `detached@${wt.head}` : "") : fallbackBranch ?? "";
  const body = (
    <>
      <span className={`git-checkout-dot${muted ? " muted" : ""}`} />
      <span className="git-checkout-name">{label}</span>
      <span className="git-checkout-branch" title={wt?.path}>{branch || "?"}</span>
      {wt && wt.dirty > 0 && <span className="git-checkout-dirty" title={`${wt.dirty} changed file${wt.dirty === 1 ? "" : "s"}`}>{wt.dirty}</span>}
      {wt && wt.ahead > 0 && <span className="git-ahead">↑{wt.ahead}</span>}
      {wt && wt.behind > 0 && <span className="git-behind">↓{wt.behind}</span>}
    </>
  );
  return onClick ? (
    <button className={`git-checkout-row${active ? " active" : ""}`} onClick={onClick} title="Focus this agent">
      {body}
    </button>
  ) : (
    <div className={`git-checkout-row${active ? " active" : ""}${muted ? " muted" : ""}`}>{body}</div>
  );
}

function FileRow({ status, path, onOpen }: { status: string; path: string; onOpen: () => void }) {
  const segs = path.split("/");
  const name = segs.pop() ?? path;
  // Show just the immediate parent folder as context (prefixed with …/ when
  // it's nested deeper), so the filename stays the prominent, identifiable bit.
  const dir = segs.length ? (segs.length > 1 ? "…/" : "") + segs[segs.length - 1] + "/" : "";
  return (
    <button className="git-file-row" title={`${path} — click to view diff`} onClick={onOpen}>
      <span className={`git-file-status git-status-${statusClass(status)}`} title={statusLabel(status)}>
        {status}
      </span>
      <span className="git-file-name">{name}</span>
      {dir && <span className="git-file-dir">{dir}</span>}
      {/* Subtle, always-present cue that the row opens a diff — brightens on hover. */}
      <span className="git-file-diff-hint" aria-hidden="true">diff ›</span>
    </button>
  );
}

function statusClass(status: string): string {
  switch (status) {
    case "A": return "add";
    case "D": return "del";
    case "?": return "new";
    case "U": return "conflict";
    default: return "mod";
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case "A": return "Added";
    case "D": return "Deleted";
    case "?": return "Untracked";
    case "U": return "Conflict";
    case "R": return "Renamed";
    case "C": return "Copied";
    default: return "Modified";
  }
}
