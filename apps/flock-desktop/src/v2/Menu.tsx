import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export type MenuEntry =
  | {
      label: string;
      hint?: string;
      icon?: ReactNode;
      danger?: boolean;
      disabled?: boolean;
      checked?: boolean;
      onSelect: () => void;
    }
  | { separator: true }
  | { heading: string };

/** One floating list, opened from a button: under it, aligned to its left
 *  edge, flipped up or in when the window is too small. Escape, a click
 *  elsewhere, or picking an item closes it. Arrow keys move, Enter picks. */
export function Menu({
  anchor,
  entries,
  onClose,
  align = "start",
  label,
}: {
  anchor: DOMRect;
  entries: MenuEntry[];
  onClose: () => void;
  align?: "start" | "end";
  label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const [active, setActive] = useState(-1);
  const items = entries.flatMap((e, i) => ("onSelect" in e && !e.disabled ? [i] : []));

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = align === "end" ? anchor.right - w : anchor.left;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    let top = anchor.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, anchor.top - h - 6);
    setAt({ top, left });
  }, [anchor, align]);

  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (items.length === 0) return;
        setActive((cur) => {
          const pos = items.indexOf(cur);
          const next = e.key === "ArrowDown" ? (pos + 1) % items.length : (pos - 1 + items.length) % items.length;
          return items[pos === -1 ? (e.key === "ArrowDown" ? 0 : items.length - 1) : next];
        });
      } else if (e.key === "Enter" && active >= 0) {
        e.preventDefault();
        const entry = entries[active];
        if (entry && "onSelect" in entry) {
          onClose();
          entry.onSelect();
        }
      }
    };
    // Deferred a tick so the click that opened the menu isn't the one that closes it.
    const t = setTimeout(() => document.addEventListener("pointerdown", away, true), 0);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", onClose);
    return () => {
      clearTimeout(t);
      document.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose, entries, items, active]);

  return createPortal(
    <div
      ref={ref}
      className="v2-menu"
      role="menu"
      aria-label={label}
      style={at ? { top: at.top, left: at.left } : { top: anchor.bottom + 6, left: anchor.left, visibility: "hidden" }}
    >
      {entries.map((e, i) => {
        if ("separator" in e) return <div key={i} className="v2-menu-sep" role="separator" />;
        if ("heading" in e) {
          return (
            <div key={i} className="v2-menu-label">
              {e.heading}
            </div>
          );
        }
        return (
          <button
            key={i}
            type="button"
            role={e.checked === undefined ? "menuitem" : "menuitemradio"}
            aria-checked={e.checked}
            className={`v2-menu-item${e.danger ? " danger" : ""}`}
            data-active={i === active || undefined}
            disabled={e.disabled}
            onPointerEnter={() => setActive(i)}
            onClick={() => {
              onClose();
              e.onSelect();
            }}
          >
            {e.icon}
            <span>{e.label}</span>
            {e.hint && <small>{e.hint}</small>}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}

/** A button that opens a Menu under itself. */
export function useMenu() {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  return {
    open: anchor !== null,
    anchor,
    // The rect is read now, in the handler: React clears `currentTarget` once
    // the handler returns, and the state updater runs after that.
    toggle: (e: { currentTarget: Element }) => {
      const rect = e.currentTarget.getBoundingClientRect();
      setAnchor((a) => (a ? null : rect));
    },
    /** Open at a rect already known: another menu's anchor, to step into a
     *  second list from the first. */
    openAt: (rect: DOMRect) => setAnchor(rect),
    close: () => setAnchor(null),
  };
}
