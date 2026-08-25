import { useEffect, useRef } from "react";
import ModalCloseButton from "./ModalCloseButton";
import { useFocusTrap } from "../lib/useFocusTrap";

interface Props {
  title: string;
  /** The branch whose commits are at stake. */
  branch: string;
  /** Commits on the branch unreachable from any other ref. */
  unmerged: number;
  /** One extra line of context ("Its worktree will be removed."). */
  subject?: string;
  /** Proceed, keeping the branch (and its commits) around. */
  onKeep: () => void;
  /** Proceed and delete the branch, discarding the unmerged commits. */
  onDelete: () => void;
  onCancel: () => void;
}

/** Three-way ConfirmDialog variant for tearing down a worktree whose branch
 * has commits that exist nowhere else: keep the branch, delete it anyway, or
 * cancel. Enter maps to the safe choice (keep). */
export default function BranchFateDialog({ title, branch, unmerged, subject, onKeep, onDelete, onCancel }: Props) {
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      else if (e.key === "Enter") onKeep();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, onKeep]);

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal confirm-modal" ref={modalRef} role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <ModalCloseButton onClose={onCancel} />
        <div className="modal-header">
          <div className="title">{title}</div>
        </div>
        <div className="modal-body">
          <div className="confirm-message">
            Branch <strong>{branch}</strong> has {unmerged} commit{unmerged === 1 ? "" : "s"} that exist nowhere
            else — deleting the branch discards {unmerged === 1 ? "it" : "them"} permanently.
            {subject ? <> {subject}</> : null}
          </div>
          <div className="confirm-actions">
            <button className="btn-mint-solid" onClick={onKeep} autoFocus>
              Keep branch
            </button>
            <button className="btn-danger-solid" onClick={onDelete}>
              Delete branch
            </button>
            <button className="btn-ghost" onClick={onCancel}>Cancel</button>
          </div>
        </div>
        <div className="modal-footer">
          <span className="kbd">esc</span><span>cancel</span>
          <span className="kbd">↵</span><span>keep branch</span>
        </div>
      </div>
    </div>
  );
}
