import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { rectZoomFactor } from "./rectZoom";

const MAXW = 380;

/** Shared "full agent intent" floating tooltip. Both the pane topbar and the
 *  sidebar show a single-line, ellipsis-clipped intent label; hovering reveals
 *  the whole thing in a real card (not the native `title`, which renders small,
 *  low-contrast, after an OS delay, and truncates). Left-anchored + clamped to
 *  the viewport (the intent can be a multi-sentence prompt), portaled to <body>
 *  so it escapes any overflow:hidden, and zoom-corrected for scaled topbars.
 *
 *  Usage: spread `anchorProps` and attach `ref` on the label element, render
 *  `tipNode` inside it. Pass `disabled` to suppress the tip (e.g. while a
 *  dropdown owns the same element), and call `hide` on mousedown/click. */
export function useFloatingTip<T extends HTMLElement>(
  full: string,
  opts?: { disabled?: boolean },
) {
  const ref = useRef<T>(null);
  const [tip, setTip] = useState<{ x: number; y: number; side: "top" | "bottom" } | null>(null);

  const show = () => {
    if (opts?.disabled) return;
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const zoom = rectZoomFactor(el);
    const bottom = rect.bottom * zoom;
    // Assume a tallish card; flip above only when there's clearly no room below.
    const side = bottom + 160 > window.innerHeight ? "top" : "bottom";
    const x = Math.max(8, Math.min(rect.left * zoom, window.innerWidth - MAXW - 8));
    setTip({ x, y: side === "bottom" ? bottom + 7 : rect.top * zoom - 7, side });
  };
  const hide = () => setTip(null);

  const anchorProps = { onMouseEnter: show, onMouseLeave: hide, onFocus: show, onBlur: hide };

  const tipNode = tip
    ? createPortal(
        <div
          role="tooltip"
          className={`intent-tooltip intent-tooltip-${tip.side}`}
          style={{ left: tip.x, top: tip.y, maxWidth: MAXW }}
        >
          <div className="intent-tooltip-head">Agent intent</div>
          <div className="intent-tooltip-body">{full}</div>
        </div>,
        document.body,
      )
    : null;

  return { ref, anchorProps, tipNode, hide };
}
