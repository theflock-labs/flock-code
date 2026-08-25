import { useEffect, useRef } from "react";
import ModalCloseButton from "./ModalCloseButton";
import DiffView, { type ReviewConfig } from "./DiffView";
import { useFocusTrap } from "../lib/useFocusTrap";

interface Props {
  /** Small uppercase eyebrow above the title (e.g. "WORKING TREE"). */
  eyebrow: string;
  /** Main title line (e.g. repo/branch or the PR title). */
  title: string;
  /** Returns the raw unified-diff text to render. */
  load: () => Promise<string>;
  onClose: () => void;
  /** File path to reveal + highlight when the modal opens. */
  initialPath?: string;
  /** When set, shows an "open on GitHub" action in the toolbar. */
  externalUrl?: string;
  /** Shown when the diff comes back empty. */
  emptyMessage?: string;
  /** When set, lines can be annotated and the notes sent to an agent. */
  review?: ReviewConfig;
}

/** Standalone diff modal, wrapping the reusable DiffView in modal chrome.
 * Used by the git panel for the working-tree diff. */
export default function DiffModal({ eyebrow, title, load, onClose, initialPath, externalUrl, emptyMessage, review }: Props) {
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef);

  useEffect(() => {
    // Capture phase + stopPropagation so that when this modal is stacked over
    // another, Esc closes only this one — not both.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div className="modal-overlay" onClick={(e) => { e.stopPropagation(); onClose(); }}>
      <div className="modal diff-modal" ref={modalRef} role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <ModalCloseButton onClose={onClose} />
        <div className="modal-header diff-modal-header">
          <div className="step">{eyebrow}</div>
          <div className="title">{title}</div>
        </div>

        <div className="modal-body diff-modal-body">
          <DiffView load={load} initialPath={initialPath} externalUrl={externalUrl} emptyMessage={emptyMessage} review={review} />
        </div>

        <div className="modal-footer">
          <span className="kbd">esc</span><span>close</span>
        </div>
      </div>
    </div>
  );
}
