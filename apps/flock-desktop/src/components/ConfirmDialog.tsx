import { useEffect, useRef } from "react";
import ModalCloseButton from "./ModalCloseButton";
import { useFocusTrap } from "../lib/useFocusTrap";

interface Props {
  title: string;
  message: React.ReactNode;
  confirmLabel: string;
  /** Renders the confirm button in the destructive (red) style. */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({ title, message, confirmLabel, danger, onConfirm, onCancel }: Props) {
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      else if (e.key === "Enter") onConfirm();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, onConfirm]);

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal confirm-modal" ref={modalRef} role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <ModalCloseButton onClose={onCancel} />
        <div className="modal-header">
          <div className="title">{title}</div>
        </div>
        <div className="modal-body">
          <div className="confirm-message">{message}</div>
          <div className="confirm-actions">
            <button className={danger ? "btn-danger-solid" : "btn-mint-solid"} onClick={onConfirm} autoFocus>
              {confirmLabel}
            </button>
            <button className="btn-ghost" onClick={onCancel}>Cancel</button>
          </div>
        </div>
        <div className="modal-footer">
          <span className="kbd">esc</span><span>cancel</span>
          <span className="kbd">↵</span><span>confirm</span>
        </div>
      </div>
    </div>
  );
}
