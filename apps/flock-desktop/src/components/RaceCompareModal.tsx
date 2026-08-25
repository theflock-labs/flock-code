import { useEffect, useRef, useState } from "react";
import ModalCloseButton from "./ModalCloseButton";
import DiffView from "./DiffView";
import { useFocusTrap } from "../lib/useFocusTrap";
import { diffTotals, parseUnifiedDiff } from "../lib/diff";
import { contenderState, type ContenderState } from "../lib/race";
import { gitDiffAgainst } from "../lib/tauri";
import type { Pane, RaceState } from "../types";
// Both sheets, deliberately: the footer's confirm button is the dialogs'
// `.sd-btn-primary`, and a shared class is only shared if the component that
// leans on it says so — otherwise it works until the sheet's only other
// importer stops being loaded first.
import "../styles/spawnDialog.css";
import "../styles/race.css";

interface Props {
  race: RaceState;
  /** The workspace's live panes, for each contender's status dot. */
  panes: Pane[];
  /** A merge is in flight — App owns this so the button can't be double-fired
   * while `git merge` is running. */
  merging: boolean;
  onMerge: (branch: string, discardOthers: boolean) => void;
  onClose: () => void;
}

type Stat = { additions: number; deletions: number; files: number } | { error: string };

/** Side-by-side judging for a race: every contender's diff against the commit
 * they all started from, switchable from a rail, with one of them mergeable.
 *
 * Switchable rather than literally side by side. Two diffs at 590px each is
 * narrower than the code being compared, and the thing that actually decides a
 * race — reading one candidate's implementation properly — is exactly what
 * that width takes away. The rail carries the at-a-glance comparison
 * (+/-, files, whether the agent is still going) and the full width goes to
 * whichever one you are reading.
 */
export default function RaceCompareModal({ race, panes, merging, onMerge, onClose }: Props) {
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef);

  // One fetch per contender, started on mount and kept as the promise itself:
  // DiffView takes a `load` thunk and does its own loading state, so handing
  // it the in-flight promise lets the selected panel render "Loading diff…"
  // while the rail fills in behind it — instead of the modal sitting blank
  // until the slowest worktree has been walked.
  const [loaders] = useState(
    () => new Map(race.contenders.map((c) => [c.branch, gitDiffAgainst(c.worktreePath, race.baseSha)] as const)),
  );
  const [stats, setStats] = useState<Record<string, Stat>>({});
  const [selected, setSelected] = useState(race.winnerBranch ?? race.contenders[0]?.branch ?? "");
  const [discardOthers, setDiscardOthers] = useState(false);

  useEffect(() => {
    let alive = true;
    for (const [branch, p] of loaders) {
      p.then((text) => {
        if (!alive) return;
        const files = parseUnifiedDiff(text);
        setStats((s) => ({ ...s, [branch]: { ...diffTotals(files), files: files.length } }));
      }).catch((e) => {
        // Also what keeps a failed fetch from becoming an unhandled rejection:
        // the promise is created before anything is listening to it.
        if (alive) setStats((s) => ({ ...s, [branch]: { error: e instanceof Error ? e.message : String(e) } }));
      });
    }
    return () => { alive = false; };
  }, [loaders]);

  useEffect(() => {
    // Capture phase + stopPropagation so Esc closes only this modal when it is
    // stacked over another — same rule as DiffModal.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const winner = race.contenders.find((c) => c.branch === race.winnerBranch);
  const picked = race.contenders.find((c) => c.branch === selected);
  const losers = race.contenders.filter((c) => c.branch !== selected && c.worktreePath !== picked?.worktreePath);

  return (
    <div className="modal-overlay" onClick={(e) => { e.stopPropagation(); onClose(); }}>
      <div className="modal race-modal" ref={modalRef} role="dialog" aria-modal="true" aria-label="Compare race contenders" onClick={(e) => e.stopPropagation()}>
        <ModalCloseButton onClose={onClose} />
        <div className="modal-header diff-modal-header">
          <div className="step">Race · {race.contenders.length} contenders off {race.baseLabel}</div>
          <div className="title">{race.prompt}</div>
        </div>

        <div className="modal-body race-body">
          <aside className="race-rail">
            {race.contenders.map((c) => (
              <ContenderRow
                key={c.branch}
                name={c.agentName}
                branch={c.branch}
                state={contenderState(c, panes)}
                stat={stats[c.branch]}
                selected={c.branch === selected}
                won={c.branch === race.winnerBranch}
                onClick={() => setSelected(c.branch)}
              />
            ))}
          </aside>

          <div className="race-diff">
            {picked ? (
              <DiffView
                // Remount per contender: DiffView fetches once on mount, which
                // is exactly right when the fetch is already resolved here.
                key={picked.branch}
                load={() => loaders.get(picked.branch) ?? Promise.resolve("")}
                emptyMessage={`${picked.agentName} hasn't changed anything yet.`}
              />
            ) : (
              <div className="diff-view"><div className="diff-view-empty">This race has no contenders left.</div></div>
            )}
          </div>
        </div>

        <div className="modal-footer race-foot">
          {winner ? (
            <span className="race-merged-note">
              Merged <strong>{winner.agentName}</strong> ({winner.branch}).
            </span>
          ) : (
            <>
              <label className={`race-discard${losers.length === 0 ? " disabled" : ""}`}>
                <input
                  type="checkbox"
                  checked={discardOthers && losers.length > 0}
                  disabled={losers.length === 0}
                  onChange={(e) => setDiscardOthers(e.target.checked)}
                />
                <span>
                  Discard the other {losers.length}
                  <span className="race-discard-hint">
                    {" "}— their worktrees and branches are deleted, and nothing on them survives.
                  </span>
                </span>
              </label>
              <div className="sd-foot-spacer" />
              <button
                className="sd-btn-primary"
                disabled={!picked || merging}
                onClick={() => picked && onMerge(picked.branch, discardOthers && losers.length > 0)}
              >
                {merging ? "Merging…" : `Merge ${picked?.agentName ?? ""}`}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const STATE_LABEL: Record<ContenderState, string> = {
  working: "working",
  "needs-input": "needs input",
  resting: "idle",
  // Not a failure: the pane can be closed, popped out, or lost to a restart
  // while the worktree it wrote into is still sitting there, readable and
  // mergeable. Saying "no agent" rather than hiding the row is the point.
  gone: "no agent",
};

function ContenderRow({ name, branch, state, stat, selected, won, onClick }: {
  name: string;
  branch: string;
  state: ContenderState;
  stat: Stat | undefined;
  selected: boolean;
  won: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`race-contender${selected ? " selected" : ""}${won ? " won" : ""}`}
      onClick={onClick}
      aria-pressed={selected}
      title={branch}
    >
      <div className="race-contender-top">
        <span className={`race-dot race-dot-${state}`} aria-hidden="true" />
        <span className="race-contender-name">{name}</span>
        {won && <span className="race-won-tag">merged</span>}
      </div>
      <div className="race-contender-branch">{branch}</div>
      <div className="race-contender-stat">
        {stat === undefined ? (
          <span className="race-stat-pending">reading diff…</span>
        ) : "error" in stat ? (
          <span className="race-stat-error">{stat.error}</span>
        ) : stat.files === 0 ? (
          <span className="race-stat-pending">no changes yet · {STATE_LABEL[state]}</span>
        ) : (
          <>
            <span className="diff-add-count">+{stat.additions}</span>
            <span className="diff-del-count">−{stat.deletions}</span>
            <span className="diff-file-count">{stat.files} file{stat.files === 1 ? "" : "s"}</span>
            <span className="race-contender-state">{STATE_LABEL[state]}</span>
          </>
        )}
      </div>
    </button>
  );
}
