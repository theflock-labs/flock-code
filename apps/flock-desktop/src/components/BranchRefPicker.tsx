import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { CaretIcon } from "./statusIcons";

export interface RefOption {
  name: string;
  /** Right-aligned annotation: "default", "current", "held by Pluto". */
  note?: string;
  /** Unpickable, with `note` explaining why (git allows a branch in one
   * worktree only, so a held branch can't be checked out again). */
  disabled?: boolean;
  /** Section heading this option sits under. */
  group?: string;
}

interface Props {
  value: string;
  options: RefOption[];
  onPick: (name: string) => void;
  placeholder?: string;
  disabled?: boolean;
  ariaLabel: string;
}

/** Filterable ref combobox for the new-workspace dialog.
 *
 * Sibling to BranchChip's picker rather than an extraction of it: that one
 * performs a checkout and owns the busy/error lifecycle of a live git command,
 * this one only reports a selection back to a form. Sharing the `.branch-picker`
 * CSS keeps them looking identical without coupling the two behaviors. */
export default function BranchRefPicker({ value, options, onPick, placeholder, disabled, ariaLabel }: Props) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const btnRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Anchored via fixed positioning: the dialog body scrolls and clips.
  const [anchor, setAnchor] = useState<{ x: number; y: number; w: number } | null>(null);

  const matches = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? options.filter((o) => o.name.toLowerCase().includes(q)) : options;
  }, [options, filter]);

  useEffect(() => {
    if (!open) return;
    setFilter("");
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setAnchor({ x: r.left, y: r.bottom + 4, w: r.width });
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  const pick = (name: string) => {
    onPick(name);
    setOpen(false);
  };

  let lastGroup: string | undefined;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`sd-ref${open ? " open" : ""}`}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        // The trigger is narrow, so a long ref clips — hover reveals the whole thing.
        title={value || undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`sd-ref-name${value ? "" : " placeholder"}`}>{value || placeholder || "Pick a branch…"}</span>
        <span className="sd-ref-caret"><CaretIcon size={9} open /></span>
      </button>

      {open && anchor && (
        <>
          <div className="branch-picker-overlay" onMouseDown={() => setOpen(false)} />
          <div
            className="branch-picker"
            role="listbox"
            aria-label={ariaLabel}
            style={{
              left: Math.min(anchor.x, window.innerWidth - 300),
              top: anchor.y,
              minWidth: Math.max(anchor.w, 220),
            }}
          >
            <input
              ref={inputRef}
              className="branch-picker-input"
              placeholder="Filter…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                // Both keys are claimed by the enclosing dialog (Escape
                // cancels, Enter creates the workspace) via a window listener,
                // so stop them here or filtering a branch closes the dialog or
                // spawns everything.
                if (e.key === "Escape") { e.stopPropagation(); setOpen(false); }
                else if (e.key === "Enter") {
                  e.preventDefault();
                  e.stopPropagation();
                  const hit = matches.find((o) => !o.disabled);
                  if (hit) pick(hit.name);
                }
              }}
            />
            <div className="branch-picker-list">
              {matches.map((o) => {
                const heading = o.group && o.group !== lastGroup ? o.group : null;
                lastGroup = o.group;
                return (
                  // Fragment, not a wrapper element: the list is a flex column
                  // and a wrapper would become the flex item, collapsing the
                  // rows' width and swallowing the gap.
                  <Fragment key={`${o.group ?? ""}/${o.name}`}>
                    {heading && <div className="branch-picker-group">{heading}</div>}
                    <button
                      type="button"
                      role="option"
                      aria-selected={o.name === value}
                      className={`branch-picker-row${o.name === value ? " current" : ""}${o.disabled ? " held" : ""}`}
                      disabled={o.disabled}
                      onClick={() => pick(o.name)}
                    >
                      <span className="branch-picker-row-name">{o.name}</span>
                      {o.note && <span className="branch-picker-row-note">{o.note}</span>}
                    </button>
                  </Fragment>
                );
              })}
              {matches.length === 0 && <div className="branch-picker-empty">No matching refs</div>}
            </div>
          </div>
        </>
      )}
    </>
  );
}
