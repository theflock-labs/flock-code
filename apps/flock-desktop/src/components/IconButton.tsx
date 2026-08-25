import { useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { rectZoomFactor } from "../lib/rectZoom";

interface Props {
  icon: ReactNode;
  /** Shown in the tooltip on hover/focus, and doubles as the button's
   *  accessible name (via aria-label) — say what the button *does*, not
   *  what it's called (e.g. "Close pane", not "Close"). */
  label: string;
  onClick: (e: MouseEvent) => void;
  onMouseDown?: (e: MouseEvent) => void;
  /** Right-click on the control itself — for buttons with a secondary menu
   *  (e.g. "open a terminal" → pick which terminal). */
  onContextMenu?: (e: MouseEvent) => void;
  className: string;
  disabled?: boolean;
}

/** Icon button + tooltip in one, used for every icon-only control across the
 *  app (workspace header, pane topbars, sidebar, dialogs). A real `<button>`
 *  — not a styled `<span>` — so it's keyboard-operable (Enter/Space) and
 *  gets a native accessible role for free; `aria-label` supplies the name
 *  screen readers announce, since there's no visible text.
 *
 *  The tooltip itself is a real floating element (not the native `title`
 *  attribute), so it's actually legible: bigger text, appears immediately,
 *  and — being `position: fixed` — escapes any ancestor's
 *  `overflow: hidden` instead of getting clipped by it. It's purely a
 *  sighted-user affordance duplicating `aria-label`, so hiding it on Escape
 *  never removes information a screen reader user didn't already have
 *  (WCAG 1.4.13 is satisfied by the name being programmatic, not by the
 *  tooltip's hover/focus visibility). Placement always prefers below the
 *  button, flipping above only when there isn't room (e.g. a pane topbar
 *  sitting right under the titlebar). */
export default function IconButton({
  icon, label, onClick, onMouseDown, onContextMenu, className, disabled,
}: Props) {
  const ref = useRef<HTMLButtonElement>(null);
  const [tip, setTip] = useState<{ x: number; y: number; side: "top" | "bottom" } | null>(null);

  const show = () => {
    if (disabled) return;
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const zoom = rectZoomFactor(ref.current!);
    const bottom = rect.bottom * zoom;
    const side = bottom + 34 > window.innerHeight ? "top" : "bottom";
    setTip({
      x: (rect.left + rect.width / 2) * zoom,
      y: side === "bottom" ? bottom + 7 : rect.top * zoom - 7,
      side,
    });
  };
  const hide = () => setTip(null);

  return (
    <button
      ref={ref}
      type="button"
      className={["icon-btn", className, disabled && "disabled"].filter(Boolean).join(" ")}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onMouseDown={(e) => { hide(); onMouseDown?.(e); }}
      onClick={(e) => { if (!disabled) onClick(e); }}
      onContextMenu={onContextMenu && ((e) => { if (!disabled) { hide(); onContextMenu(e); } })}
      onKeyDown={(e: KeyboardEvent) => { if (e.key === "Escape") hide(); }}
      aria-label={label}
      disabled={disabled}
    >
      {icon}
      {/* Portaled to <body>: rendered in place, the tooltip lives inside
          whatever stacking context the button's ancestors create (e.g. a
          sticky sidebar section header at z-index 3), and any later sibling
          context paints over it no matter how high its own z-index is. From
          the body it sits above every layer, always. */}
      {tip && createPortal(
        <div
          role="tooltip"
          className={`icon-tooltip icon-tooltip-${tip.side}`}
          style={{ left: tip.x, top: tip.y }}
        >
          {label}
        </div>,
        document.body,
      )}
    </button>
  );
}
