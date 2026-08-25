import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface MenuItem {
  label: string;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  divider?: boolean;
  shortcut?: string;
  /** Nested items shown in a hover flyout. A parent with a submenu ignores its
   *  own onClick — hovering (or clicking) it opens the flyout instead. */
  submenu?: MenuItem[];
}

interface Props {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

// Width the flyout is allowed to claim when deciding whether to open left vs
// right of its parent. Matches .ctx-menu min-width.
const SUBMENU_WIDTH = 240;

export default function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [hovered, setHovered] = useState<number | null>(null);
  // Which parent's flyout is open, and where. Kept sticky on mouse-leave so the
  // pointer can travel from the parent row into the flyout without it closing.
  const [flyout, setFlyout] = useState<{ index: number; x: number; y: number } | null>(null);
  const [subHovered, setSubHovered] = useState<number | null>(null);

  // Position to stay on-screen
  useLayoutEffect(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let nx = x;
    let ny = y;
    if (nx + rect.width + 8 > vw) nx = vw - rect.width - 8;
    if (ny + rect.height + 8 > vh) ny = vh - rect.height - 8;
    setPos({ x: nx, y: ny });
  }, [x, y]);

  const openFlyout = (index: number, row: HTMLElement) => {
    const r = row.getBoundingClientRect();
    const opensLeft = r.right + SUBMENU_WIDTH + 8 > window.innerWidth;
    // Which side to open on is a question about the SCREEN, so it is asked in
    // viewport coordinates.
    const vx = opensLeft ? r.left - SUBMENU_WIDTH + 4 : r.right - 4;
    const vy = r.top - 4;
    // Where to put it is a question about this MENU, because the flyout is a
    // descendant of it (see the render, which needs that for the outside-click
    // guard) and `.ctx-menu` carries a backdrop-filter. A filtered ancestor
    // becomes the containing block for `position: fixed` descendants, so the
    // viewport coordinates above were being applied relative to the menu's own
    // top-left and the flyout opened one menu-width off, usually past the edge
    // of the window: the submenu looked empty because it was somewhere else.
    // Positioning it explicitly relative to the menu makes that question moot
    // rather than answering it correctly by luck.
    const menu = ref.current?.getBoundingClientRect();
    // Minus the 1px border: an absolutely positioned child is placed against
    // its offset parent's PADDING box, and getBoundingClientRect gives the
    // border box.
    setFlyout({ index, x: vx - (menu?.left ?? 0) - 1, y: vy - (menu?.top ?? 0) - 1 });
    setSubHovered(null);
  };

  // Dismiss on outside click / escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Escape backs out of an open flyout first, then closes the whole menu.
      if (e.key === "Escape") {
        if (flyout) setFlyout(null);
        else onClose();
        return;
      }
      // Arrow nav (top level only — submenus are mouse-driven)
      const actionable = items
        .map((it, i) => ({ it, i }))
        .filter(({ it }) => !it.divider && !it.disabled);
      if (actionable.length === 0) return;
      if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        const cur = actionable.findIndex(({ i }) => i === hovered);
        const next = actionable[(cur + 1) % actionable.length];
        setHovered(next.i);
      }
      if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        const cur = actionable.findIndex(({ i }) => i === hovered);
        const next =
          actionable[(cur - 1 + actionable.length) % actionable.length];
        setHovered(next.i);
      }
      if (e.key === "Enter" && hovered !== null) {
        e.preventDefault();
        // Never auto-close a submenu parent on Enter — there's nothing to run.
        if (items[hovered]?.submenu?.length) return;
        items[hovered]?.onClick?.();
        onClose();
      }
    };
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [hovered, items, onClose, flyout]);

  const flyoutItems = flyout ? items[flyout.index]?.submenu ?? [] : [];

  return (
    <div
      ref={ref}
      className="ctx-menu"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) =>
        it.divider ? (
          <div key={`d${i}`} className="ctx-divider" />
        ) : (
          <div
            key={i}
            className={[
              "ctx-item",
              it.danger && "danger",
              it.disabled && "disabled",
              (hovered === i || flyout?.index === i) && "hovered",
            ]
              .filter(Boolean)
              .join(" ")}
            onMouseEnter={(e) => {
              if (it.disabled) return;
              setHovered(i);
              if (it.submenu?.length) openFlyout(i, e.currentTarget);
              else setFlyout(null);
            }}
            onMouseLeave={() => setHovered(null)}
            onClick={() => {
              if (it.disabled) return;
              if (it.submenu?.length) return; // parents open on hover, don't act
              it.onClick?.();
              onClose();
            }}
          >
            <span className="label">{it.label}</span>
            {it.submenu?.length ? (
              <span className="ctx-caret">›</span>
            ) : (
              it.shortcut && <span className="shortcut">{it.shortcut}</span>
            )}
          </div>
        ),
      )}

      {/* Flyout rendered as a descendant of the menu so the outside-click guard
          (ref.contains) treats clicks inside it as inside the menu. */}
      {flyout && flyoutItems.length > 0 && (
        <div className="ctx-menu ctx-submenu" style={{ left: flyout.x, top: flyout.y }}>
          {flyoutItems.map((sit, si) =>
            sit.divider ? (
              <div key={`sd${si}`} className="ctx-divider" />
            ) : (
              <div
                key={si}
                className={[
                  "ctx-item",
                  sit.danger && "danger",
                  sit.disabled && "disabled",
                  subHovered === si && "hovered",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onMouseEnter={() => !sit.disabled && setSubHovered(si)}
                onMouseLeave={() => setSubHovered(null)}
                onClick={() => {
                  if (sit.disabled) return;
                  sit.onClick?.();
                  onClose();
                }}
              >
                <span className="label">{sit.label}</span>
                {sit.shortcut && <span className="shortcut">{sit.shortcut}</span>}
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}
