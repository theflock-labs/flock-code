import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import ModalCloseButton from "./ModalCloseButton";
import { useFocusTrap } from "../lib/useFocusTrap";
import { pastedImageFiles, readImageFiles, type PastedImage } from "../lib/queue";
import { queueAdd, readClipboardImage, readImageFilesFromPaths, type QueueItem } from "../lib/tauri";

interface Props {
  onSave: (item: QueueItem) => void;
  onClose: () => void;
}

// A captured image plus a preview object URL. The bytes ride along to queueAdd;
// the url is only for the thumbnail and is revoked on drop / unmount.
interface Draft extends PastedImage {
  url: string;
}

/** Capture a prompt (+ one or more screenshots) into the personal queue without
 *  needing a pane yet. Structural copy of TaskDialog (modal chrome, focus trap,
 *  Escape-to-close, ⌘↵-to-submit) plus a thumbnail strip. Three ways to attach
 *  images, because different sources deliver them differently:
 *   - paste an OS screenshot (web-visible clipboard file),
 *   - paste from Apple Notes etc. (image only on the native pasteboard),
 *   - drag image files in (Tauri file-drop paths), or the explicit button. */
export default function QueueCaptureOverlay({ onSave, onClose }: Props) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<Draft[]>([]);
  const [saving, setSaving] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef);

  const attach = useCallback((imgs: PastedImage[]) => {
    if (imgs.length === 0) return;
    setImages((prev) => [
      ...prev,
      ...imgs.map((p) => ({ ...p, url: URL.createObjectURL(new Blob([p.data], { type: `image/${p.ext}` })) })),
    ]);
    setHint(null);
  }, []);

  useEffect(() => {
    textareaRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Revoke every preview url on unmount so we don't leak blobs.
  useEffect(() => () => { images.forEach((i) => URL.revokeObjectURL(i.url)); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []);

  // File drags never reach the DOM in Tauri — they arrive on the webview's
  // drag-drop stream with real paths. While the overlay is open (it covers the
  // whole window) treat any drop as an image attach; the pane file-drop handler
  // no-ops because there's no pane under the modal.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "enter" || p.type === "over") setDragging(true);
        else if (p.type === "drop") {
          setDragging(false);
          if (p.paths && p.paths.length > 0) {
            readImageFilesFromPaths(p.paths)
              .then((imgs) => {
                if (imgs.length > 0) attach(imgs);
                else setHint("Those weren't image files.");
              })
              .catch((err) => console.error("queue drop read failed", err));
          }
        } else setDragging(false); // leave / cancel
      })
      .then((fn) => { if (cancelled) fn(); else unlisten = fn; });
    return () => { cancelled = true; unlisten?.(); };
  }, [attach]);

  const onPaste = (e: React.ClipboardEvent) => {
    // Web-visible image files (OS screenshot on the clipboard). Collect
    // synchronously — clipboard data is only live during dispatch.
    const files = pastedImageFiles(e.nativeEvent);
    if (files.length > 0) {
      e.preventDefault();
      readImageFiles(files).then(attach).catch((err) => console.error("queue paste failed", err));
      return;
    }
    // No web-visible image file. Apps like Apple Notes put a copied image only
    // on the native pasteboard (the paste event carries just text/html), so
    // always try the native clipboard read here. A plain-text copy finds no
    // image and this no-ops; the text still pastes into the textarea, and
    // onChange strips any stray object-replacement char left by a rich paste.
    readClipboardImage()
      .then((img) => { if (img) attach([img]); })
      .catch((err) => console.error("native clipboard read failed", err));
  };

  const addFromClipboard = async () => {
    try {
      const img = await readClipboardImage();
      if (img) attach([img]);
      else setHint("No image on the clipboard — copy one first.");
    } catch (err) {
      console.error("native clipboard read failed", err);
      setHint("Couldn't read the clipboard.");
    }
  };

  const removeImage = (idx: number) => {
    setImages((prev) => {
      const target = prev[idx];
      if (target) URL.revokeObjectURL(target.url);
      return prev.filter((_, i) => i !== idx);
    });
  };

  const canSave = text.trim().length > 0 || images.length > 0;

  const submit = async () => {
    if (!canSave || saving) return;
    setSaving(true);
    try {
      const item = await queueAdd(text.trim(), images.map((i) => ({ data: i.data, ext: i.ext })));
      images.forEach((i) => URL.revokeObjectURL(i.url));
      onSave(item);
      onClose();
    } catch (err) {
      console.error("queue capture failed", err);
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className={`modal queue-capture-modal${dragging ? " queue-modal-dragging" : ""}`}
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label="Capture a prompt"
        onClick={(e) => e.stopPropagation()}
      >
        <ModalCloseButton onClose={onClose} />
        <div className="modal-header">
          <div className="step">QUEUE</div>
          <div className="title">Capture a prompt</div>
        </div>
        <div className="modal-body" style={{ padding: "16px 20px" }}>
          <textarea
            ref={textareaRef}
            className="task-prompt-input"
            placeholder="Jot a prompt to launch later. Paste or drop screenshots to attach them."
            value={text}
            onChange={(e) => setText(e.target.value.replace(/\uFFFC/g, ""))}
            onPaste={onPaste}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(); }}
            rows={6}
          />
          {images.length > 0 && (
            <div className="queue-thumbs">
              {images.map((img, idx) => (
                <div className="queue-thumb" key={img.url}>
                  <img src={img.url} alt="" />
                  <button type="button" className="queue-thumb-x" title="Remove" onClick={() => removeImage(idx)}>×</button>
                </div>
              ))}
            </div>
          )}
          <div className="queue-capture-actions">
            <button type="button" className="btn-ghost settings-btn" onClick={addFromClipboard}>
              Add screenshot from clipboard
            </button>
            <span className="settings-hint">⌘↵ to save · paste or drop images</span>
          </div>
          {hint && <p className="settings-hint" style={{ color: "var(--yellow)" }}>{hint}</p>}
        </div>
        <div className="modal-footer" style={{ justifyContent: "flex-end", gap: 8 }}>
          <button className="btn-ghost settings-btn" onClick={onClose}>Cancel</button>
          <button className="btn-mint-solid settings-btn" onClick={submit} disabled={!canSave || saving}>
            {saving ? "Saving…" : "Save to queue"}
          </button>
        </div>
        {dragging && <div className="queue-drop-veil">Drop images to attach</div>}
      </div>
    </div>
  );
}
