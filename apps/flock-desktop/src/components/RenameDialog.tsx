import { useEffect, useRef, useState } from "react";
import ModalCloseButton from "./ModalCloseButton";
import { useFocusTrap } from "../lib/useFocusTrap";

interface Props {
  title: string;
  initial: string;
  onConfirm: (newName: string) => void;
  onCancel: () => void;
}

export default function RenameDialog({
  title,
  initial,
  onConfirm,
  onCancel,
}: Props) {
  const [name, setName] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter" && name.trim()) onConfirm(name.trim());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [name, onCancel, onConfirm]);

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" ref={modalRef} role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <ModalCloseButton onClose={onCancel} />
        <div className="modal-header">
          <div className="step">RENAME</div>
          <div className="title">{title}</div>
        </div>

        <div className="modal-body">
          <input
            ref={inputRef}
            className="modal-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div className="modal-footer">
          <span className="kbd">↵</span>
          <span>save</span>
          <span className="kbd">esc</span>
          <span>cancel</span>
        </div>
      </div>
    </div>
  );
}
