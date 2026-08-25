import { useCallback, useEffect, useRef, useState } from "react";

/* The draggable seam between a dock rail and the work surface. One instance
   per rail, absolutely positioned inside .app-main off the same width the
   rail renders at.

   Both rails are CSS-`zoom`ed by --ui-scale, so a stored width of 240 renders
   as 240 × scale px while pointer coordinates stay in plain viewport px.
   Every measurement here divides back out by the scale before writing the
   variable — skip that and the rail outruns the cursor at any text size but
   Small.

   During a drag the width variable is written straight to <html> rather than
   lifted into App state: App owns the whole workspace tree, and re-rendering
   it once per pointermove to move one edge is waste the terminals feel. The
   committed value goes up to React (and localStorage) once, on pointerup. */

export const SIDEBAR_W = { key: "flock:sidebar-w", fallback: 240, min: 180, max: 480 };
export const RIGHT_RAIL_W = { key: "flock:right-rail-w", fallback: 260, min: 200, max: 520 };

type RailSpec = typeof SIDEBAR_W;

/** Restore a persisted rail width, clamped to its own bounds — a stored value
 *  from a wider window (or a hand-edited one) must not come back unusable. */
export function loadRailWidth(spec: RailSpec): number {
  const stored = parseFloat(localStorage.getItem(spec.key) ?? "");
  if (!Number.isFinite(stored)) return spec.fallback;
  return Math.min(spec.max, Math.max(spec.min, stored));
}

export function saveRailWidth(spec: RailSpec, width: number) {
  localStorage.setItem(spec.key, String(Math.round(width)));
}

function uiScale(): number {
  const n = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ui-scale"));
  return Number.isFinite(n) && n > 0 ? n : 1;
}

interface Props {
  side: "left" | "right";
  /** CSS variable this seam drives, e.g. "--sidebar-w". */
  cssVar: string;
  spec: RailSpec;
  /** Current committed width — the base for keyboard nudges. */
  width: number;
  onCommit: (width: number) => void;
  label: string;
}

export function RailResizer({ side, cssVar, spec, width, onCommit, label }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const live = useRef(width);
  const dragging = useRef(false);
  const [active, setActive] = useState(false);

  const clamp = useCallback((px: number) => {
    // The upper bound is whichever comes first: the rail's own maximum or
    // leaving 320px of work surface. Without the second term a narrow window
    // lets a rail swallow the panes it exists to sit beside.
    const room = window.innerWidth / uiScale() - 320;
    return Math.max(spec.min, Math.min(spec.max, Math.min(px, room)));
  }, [spec]);

  const widthAt = useCallback((clientX: number) => {
    const host = ref.current?.parentElement?.getBoundingClientRect();
    if (!host) return live.current;
    const rendered = side === "left" ? clientX - host.left : host.right - clientX;
    return clamp(rendered / uiScale());
  }, [side, clamp]);

  const apply = useCallback((px: number) => {
    live.current = px;
    document.documentElement.style.setProperty(cssVar, `${Math.round(px)}px`);
  }, [cssVar]);

  const endDrag = useCallback(() => {
    if (!dragging.current) return;
    dragging.current = false;
    setActive(false);
    document.body.classList.remove("rail-resizing");
    onCommit(live.current);
  }, [onCommit]);

  // Belt-and-braces: if this seam unmounts mid-drag (the rail collapses, the
  // last docked section leaves) the body class would otherwise be stranded
  // and the whole window would keep a col-resize cursor.
  useEffect(() => () => document.body.classList.remove("rail-resizing"), []);

  const onPointerDown = (e: React.PointerEvent) => {
    // xterm's accessibility layer opts back into text selection, so without
    // this a drag across the panes leaves a highlight behind it.
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    dragging.current = true;
    live.current = width;
    setActive(true);
    document.body.classList.add("rail-resizing");
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    apply(widthAt(e.clientX));
  };

  const onPointerUp = (e: React.PointerEvent) => {
    (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    window.getSelection()?.removeAllRanges();
    endDrag();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 24 : 8;
    const grow = side === "left" ? "ArrowRight" : "ArrowLeft";
    const shrink = side === "left" ? "ArrowLeft" : "ArrowRight";
    if (e.key !== grow && e.key !== shrink) return;
    e.preventDefault();
    onCommit(clamp(width + (e.key === grow ? step : -step)));
  };

  return (
    <div
      ref={ref}
      className={`rail-seam rail-seam-${side}${active ? " dragging" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(width)}
      aria-valuemin={spec.min}
      aria-valuemax={spec.max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onCommit(spec.fallback)}
    />
  );
}
