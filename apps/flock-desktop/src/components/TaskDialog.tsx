import { useEffect, useRef, useState } from "react";
import ModalCloseButton from "./ModalCloseButton";
import { Avatar } from "./Avatar";
import { useFocusTrap } from "../lib/useFocusTrap";

interface Props {
  toLogin: string;
  toAvatar?: string;
  onSend: (prompt: string) => void;
  onClose: () => void;
}

export default function TaskDialog({ toLogin, toAvatar, onSend, onClose }: Props) {
  const [prompt, setPrompt] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef);

  useEffect(() => {
    textareaRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = () => {
    const p = prompt.trim();
    if (!p) return;
    onSend(p);
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal task-dialog" ref={modalRef} role="dialog" aria-modal="true" aria-label={`Send task to ${toLogin}`} onClick={(e) => e.stopPropagation()}>
        <ModalCloseButton onClose={onClose} />
        <div className="modal-header">
          <div className="step">HANDOFF</div>
          <div className="title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {toAvatar && <Avatar url={toAvatar} seed={toLogin} style={{ width: 20, height: 20, borderRadius: "50%" }} />}
            Send task to {toLogin}
          </div>
        </div>
        <div className="modal-body" style={{ padding: "16px 20px" }}>
          <textarea
            ref={textareaRef}
            className="task-prompt-input"
            placeholder="What should their agent work on?"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
            }}
            rows={5}
          />
          <p className="settings-hint">⌘↵ to send</p>
        </div>
        <div className="modal-footer" style={{ justifyContent: "flex-end", gap: 8 }}>
          <button className="btn-ghost settings-btn" onClick={onClose}>Cancel</button>
          <button className="btn-mint-solid settings-btn" onClick={submit} disabled={!prompt.trim()}>
            Send task
          </button>
        </div>
      </div>
    </div>
  );
}
