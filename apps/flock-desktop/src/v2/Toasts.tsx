import { useCallback, useEffect, useRef, useState } from "react";
import { XIcon } from "./icons";

// What used to be a notification log behind a titlebar pill is now what lucy
// does: a short note in the corner when something happened you did not see
// happen, gone on its own. The sidebar's dots carry agent state; these carry
// failures, finished merges and "an agent in another thread needs you".

export type ToastKind = "info" | "success" | "failure";

export interface ToastInput {
  kind: ToastKind;
  text: string;
  detail?: string;
  action?: { label: string; run: () => void };
  /** Same key replaces the toast already showing instead of stacking. */
  key?: string;
}

export interface Toast extends ToastInput {
  id: number;
}

const LIFETIME: Record<ToastKind, number> = { info: 6000, success: 5000, failure: 12000 };
const MAX = 4;

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const t = timers.current.get(id);
    if (t) clearTimeout(t);
    timers.current.delete(id);
    setToasts((prev) => prev.filter((x) => x.id !== id));
  }, []);

  const push = useCallback(
    (input: ToastInput) => {
      const id = next.current++;
      setToasts((prev) => {
        const kept = input.key ? prev.filter((x) => x.key !== input.key) : prev;
        return [...kept, { ...input, id }].slice(-MAX);
      });
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), LIFETIME[input.kind]),
      );
    },
    [dismiss],
  );

  useEffect(() => {
    const all = timers.current;
    return () => {
      for (const t of all.values()) clearTimeout(t);
      all.clear();
    };
  }, []);

  return { toasts, push, dismiss };
}

export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div className="v2-toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="v2-toast" data-kind={t.kind}>
          <span className="v2-dot" />
          <div className="v2-toast-text">
            {t.text}
            {t.detail && <small>{t.detail}</small>}
            {t.action && (
              <button
                type="button"
                className="v2-toast-action"
                onClick={() => {
                  onDismiss(t.id);
                  t.action!.run();
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
          <button type="button" className="v2-icon-btn" aria-label="Dismiss" onClick={() => onDismiss(t.id)}>
            <XIcon size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
