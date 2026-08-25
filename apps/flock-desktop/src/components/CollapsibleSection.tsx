import { useEffect, useState, type ReactNode } from "react";
import { onActivateKey } from "../lib/a11y";
import IconButton from "./IconButton";

interface Props {
  /** Stable key used to persist the open/closed state across launches. */
  id: string;
  /** Header label — compose freely (count spans, status dots, etc.). */
  title: ReactNode;
  /** Right-aligned controls (e.g. "+" new, "⤢ manage"). Clicks here never
   *  toggle the section — the whole rest of the header is the fold handle. */
  actions?: ReactNode;
  /** Folded by default the first time it's seen (before any user toggle). */
  defaultOpen?: boolean;
  /** Which rail this section currently lives on. When set (together with
   *  `onToggleDock`) the header grows a move button that sends it to the
   *  other rail. */
  dockSide?: "left" | "right";
  /** Send this section to the other rail. */
  onToggleDock?: () => void;
  children: ReactNode;
}

const KEY = (id: string) => `flock:sidebar:sec:${id}`;

/** Persist a section's open/closed state. Unset (never toggled) falls back to
 *  `defaultOpen`, so first-run defaults can change without stomping a user's
 *  saved choice. */
function useSectionOpen(id: string, defaultOpen: boolean) {
  const [open, setOpen] = useState<boolean>(() => {
    const stored = localStorage.getItem(KEY(id));
    return stored === null ? defaultOpen : stored === "1";
  });
  useEffect(() => {
    localStorage.setItem(KEY(id), open ? "1" : "0");
  }, [id, open]);
  // Let anything (e.g. the titlebar's uncommitted-changes bar) pop a section
  // open by id without threading a controlled prop through the whole tree.
  useEffect(() => {
    const onOpen = (e: Event) => {
      if ((e as CustomEvent).detail === id) setOpen(true);
    };
    window.addEventListener("flock:open-section", onOpen);
    return () => window.removeEventListener("flock:open-section", onOpen);
  }, [id]);
  return [open, setOpen] as const;
}

/**
 * A sidebar section whose header folds its body away on click. The header
 * sticks to the top of the scroll area while its body scrolls under it, so
 * the section you're reading is always labelled, and the count stays visible
 * even when collapsed. State persists per `id`.
 */
export default function CollapsibleSection({ id, title, actions, defaultOpen = true, dockSide, onToggleDock, children }: Props) {
  const [open, setOpen] = useSectionOpen(id, defaultOpen);
  const otherRail = dockSide === "left" ? "right" : "left";
  return (
    <section className={`sb-sec${open ? "" : " collapsed"}`}>
      <div
        className="sb-sec-header"
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onActivateKey(() => setOpen((v) => !v))}
        role="button"
        tabIndex={0}
        aria-expanded={open}
      >
        <span className="sb-sec-chevron"><Chevron /></span>
        <span className="sb-sec-title">{title}</span>
        {(actions || onToggleDock) && (
          // Swallow clicks so hitting an action button never folds the section.
          <span className="sb-sec-actions" onClick={(e) => e.stopPropagation()}>
            {actions}
            {onToggleDock && (
              <IconButton
                className="sb-sec-dock-btn"
                label={`Move to ${otherRail} panel`}
                icon={<DockPanelIcon toRight={otherRail === "right"} />}
                onClick={onToggleDock}
              />
            )}
          </span>
        )}
      </div>
      {open && <div className="sb-sec-body">{children}</div>}
    </section>
  );
}

// "Dock to the side panel" — the same rounded-window language as SplitRightIcon,
// but with the divider pushed to one third so the destination reads as a slim
// rail. That rail is a soft tint (fill-opacity, not a solid block) so the glyph
// stays in the app's hairline outline family instead of turning into a heavy
// filled shape. Toggles which side the rail is on.
function DockPanelIcon({ toRight }: { toRight: boolean }) {
  const divX = toRight ? 15 : 9;
  const rail = toRight
    ? "M15 5h3a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-3z"
    : "M9 5H6a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h3z";
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={rail} fill="currentColor" fillOpacity="0.9" stroke="none" />
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <line x1={divX} y1="4.5" x2={divX} y2="19.5" />
    </svg>
  );
}

// Points down when open; CSS rotates it -90° (to point right) when collapsed.
function Chevron() {
  return (
    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}
