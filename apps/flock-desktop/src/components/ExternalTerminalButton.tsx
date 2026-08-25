import { useEffect, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import IconButton from "./IconButton";
import { ChevronDownIcon } from "./friendIcons";
import { TerminalIcon } from "./paneIcons";
import { rectZoomFactor } from "../lib/rectZoom";
import {
  getPreferredTerminalId,
  onPreferredTerminalChange,
  resolvePreferred,
  setPreferredTerminalId,
  terminalApps,
  terminalAppsSnapshot,
} from "../lib/externalTerminal";
import { openTerminalAt, type TerminalApp } from "../lib/tauri";
import { CheckIcon } from "./friendIcons";

interface Props {
  /** Directory to open — the focused agent's own cwd (its worktree, when the
   *  workspace runs one per agent), falling back to the workspace root. */
  cwd: string;
  /** Surface a failure; the caller routes it to the notification log. */
  onError: (message: string) => void;
  className?: string;
}

/**
 * Opens a plain host terminal at the workspace's directory — the escape hatch
 * for everything that isn't agent work (`aws sso login`, a quick ssh, editing
 * /etc/hosts). Never the secure-mode container: the point is a normal shell
 * with the user's own environment.
 *
 * Left-click launches the chosen terminal; right-click picks a different one
 * and remembers it. The first click with several terminals installed opens the
 * picker instead of guessing — that one prompt is also what teaches the
 * right-click, which is otherwise invisible.
 *
 * Renders nothing when no terminal emulator is found, rather than offering a
 * button that can only fail.
 */
export default function ExternalTerminalButton({ cwd, onError, className }: Props) {
  const [apps, setApps] = useState<TerminalApp[] | null>(terminalAppsSnapshot());
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const [, bumpPref] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    let alive = true;
    terminalApps().then((found) => { if (alive) setApps(found); });
    return () => { alive = false; };
  }, []);
  // The preference lives in localStorage, so a change made from another button
  // (or a second window) has to push a re-render for the tooltip to keep up.
  useEffect(() => onPreferredTerminalChange(bumpPref), []);

  const preferred = apps ? resolvePreferred(apps) : null;
  if (!apps || apps.length === 0) return null;

  // Wear the chosen terminal's own icon once there IS a choice — an explicit
  // pick, or the single installed terminal, which is a choice by default. Until
  // then the generic glyph is honest: nothing has been decided yet.
  const settled = getPreferredTerminalId() !== null || apps.length === 1;
  const icon = settled && preferred?.icon
    ? <img className="term-app-icon" src={preferred.icon} alt="" draggable={false} />
    : <TerminalIcon />;

  const launch = (app: TerminalApp) => {
    openTerminalAt(app.id, cwd).catch((e) =>
      onError(`Couldn't open ${app.name}: ${e instanceof Error ? e.message : e}`),
    );
  };

  // Anchor in viewport coordinates: the header is CSS-`zoom`ed, so a rect read
  // from inside it has to be scaled before a body-portaled menu can use it.
  const anchorRect = (el: HTMLElement): DOMRect => {
    const r = el.getBoundingClientRect();
    const z = rectZoomFactor(el);
    return new DOMRect(r.left * z, r.top * z, r.width * z, r.height * z);
  };

  const openPicker = (el: HTMLElement) => setMenu(anchorRect(el));

  return (
    <>
      {/* Split control: the icon runs the chosen terminal, the caret picks a
          different one. The caret is the whole reason this is two controls —
          hiding "switch terminal" behind a right-click made it invisible. */}
      <span className={`header-split${className ? ` ${className}` : ""}`}>
        <IconButton
          className="header-btn header-split-main"
          icon={icon}
          label={
            !cwd
              ? "No folder to open — this workspace has no repository"
              : `Open this folder in ${preferred?.name ?? "a terminal"}`
          }
          disabled={!cwd}
          onClick={(e) => {
            // Nothing chosen yet and a real choice to make: ask once, then remember.
            if (!getPreferredTerminalId() && apps.length > 1) {
              openPicker(e.currentTarget as HTMLElement);
              return;
            }
            if (preferred) launch(preferred);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            openPicker(e.currentTarget as HTMLElement);
          }}
        />
        <IconButton
          className="header-btn header-split-caret"
          icon={<ChevronDownIcon size={10} />}
          label="Choose which terminal app opens"
          onClick={(e) => openPicker(e.currentTarget as HTMLElement)}
        />
      </span>
      {menu && (
        <TerminalPicker
          anchor={menu}
          apps={apps}
          // Only tick a terminal the user has actually settled on — a check
          // mark on first open would claim a choice nobody made yet.
          currentId={settled ? preferred?.id ?? null : null}
          cwd={cwd}
          onPick={(app) => {
            setPreferredTerminalId(app.id);
            setMenu(null);
            launch(app);
          }}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}

/** Right-aligned to the button (it sits in the header's right-hand cluster, so
 *  a left-anchored menu would hang off the window) and clamped to the viewport.
 *  Portaled + fixed, like the pane intent menu, to escape the header's
 *  overflow + zoom. */
function TerminalPicker({
  anchor, apps, currentId, cwd, onPick, onClose,
}: {
  anchor: DOMRect;
  apps: TerminalApp[];
  currentId: string | null;
  cwd: string;
  onPick: (app: TerminalApp) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const WIDTH = 240;
  const left = Math.max(8, Math.min(anchor.right - WIDTH, window.innerWidth - WIDTH - 8));

  return createPortal(
    <div
      ref={ref}
      className="term-picker"
      role="menu"
      aria-label="Open this folder in"
      style={{ top: anchor.bottom + 6, left, width: WIDTH }}
    >
      <div className="term-picker-head">Open folder in</div>
      {apps.map((app) => (
        <button
          key={app.id}
          type="button"
          role="menuitemradio"
          aria-checked={app.id === currentId}
          className={`term-picker-item${app.id === currentId ? " current" : ""}`}
          onClick={() => onPick(app)}
        >
          {app.icon
            ? <img className="term-app-icon" src={app.icon} alt="" draggable={false} />
            : <span className="term-app-icon term-app-icon-blank" aria-hidden="true"><TerminalIcon size={13} /></span>}
          <span className="term-picker-name">{app.name}</span>
          {app.id === currentId && <span className="term-picker-check" aria-hidden="true"><CheckIcon size={11} /></span>}
        </button>
      ))}
      <div className="term-picker-path" title={cwd}>{cwd}</div>
    </div>,
    document.body,
  );
}
