// Line icons for the status, git and pull-request surfaces — the last set of
// controls in the app that were still drawn with Unicode symbols.
//
// WHY THESE EXIST AT ALL, since the same argument will come up again the next
// time a "✓" looks like the quickest way to mark something done:
//
// The two bundled chrome faces carry the Google "latin" subset — 229 codepoints
// for IBM Plex Mono, 228 for Outfit. Every symbol below is outside it, and
// (unlike the arrows, which were merely subsetted out and have since been added
// back) outside the UPSTREAM faces too: neither Outfit nor IBM Plex Mono has
// ever contained ⑂, ⊘, ⚠, ⧉, ⟳, ◆ or ✗ at any subset size. So a symbol here was
// never going to render in the app's own type. It fell through to whatever
// macOS supplied, and not even consistently to one thing — ✓ ✗ ● ▾ resolve to
// SF Mono, while ◆ ⟳ ⧉ ⑂ exist in neither SF face and land in Menlo or Apple
// Symbols. Two glyphs sitting side by side in one row came from two different
// typefaces at two different weights and optical sizes.
//
// That is what made the chrome look assembled rather than drawn, and it is not
// something a font stack can fix. It also produced duplicates nobody chose: two
// check marks in the codebase (U+2713 and U+2714) and two refresh arrows
// (U+21BB and U+27F3), because a symbol picked from a character palette carries
// no memory of the last one picked.
//
// Stroke style matches the app's other inline icons (2px, round caps,
// currentColor) — see paneIcons.tsx, which started this migration and named
// exactly this problem in its own header.
//
// Text arrows are NOT in here on purpose. "Settings → Graph" is a sentence, not
// an icon, and → ← ↗ are now in both subsets. Keyboard glyphs (⌘ ⇧ ⌥ ⌃ ⏎ ⇥) are
// not here either: no text face has them, they are drawn by the OS in every
// Mac app, and .kbd asks for the system UI font by name so that is a decision
// rather than an accident.

interface IconProps {
  size?: number;
}

function svg(children: React.ReactNode, size: number, strokeWidth = 2) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** Circular arrow — "refresh"/"re-read this from the source". Replaces both ↻
 *  and ⟳, which were the same button in six different panels. */
export function RefreshIcon({ size = 13 }: IconProps) {
  return svg(
    <>
      <path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1" />
      <polyline points="20.5 4 20.5 9 15.5 9" />
    </>,
    size,
  );
}

/** Arrow leaving a box — "this opens somewhere outside flock" (GitHub, the
 *  browser). Replaces ↗ used as a trailing link marker. */
export function ExternalLinkIcon({ size = 12 }: IconProps) {
  return svg(
    <>
      <path d="M14 4h6v6" />
      <line x1="20" y1="4" x2="11" y2="13" />
      <path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
    </>,
    size,
  );
}

/** Circle with a bar — "this is unavailable", not "this failed". Replaces ⊘ on
 *  the offline/not-connected/not-signed-in empty states. Deliberately not the
 *  same shape as XIcon: one is a state, the other is an outcome. */
export function BlockedIcon({ size = 12 }: IconProps) {
  return svg(
    <>
      <circle cx="12" cy="12" r="9" />
      <line x1="5.6" y1="18.4" x2="18.4" y2="5.6" />
    </>,
    size,
  );
}

/** Triangle with a bang — "something went wrong fetching this". Replaces ⚠,
 *  which on Apple platforms was one variation selector away from rendering as
 *  a full-colour emoji in an app whose design language forbids them. */
export function WarningIcon({ size = 12 }: IconProps) {
  return svg(
    <>
      <path d="M12 3.8 21 19.2H3z" />
      <line x1="12" y1="10" x2="12" y2="14" />
      <line x1="12" y1="16.6" x2="12" y2="16.7" />
    </>,
    size,
  );
}

/** Two arrows passing — "review": work going out and coming back. Replaces ⇄. */
export function ReviewIcon({ size = 12 }: IconProps) {
  return svg(
    <>
      <path d="M4 8h13l-3.5-3.5" />
      <path d="M20 16H7l3.5 3.5" />
    </>,
    size,
  );
}

/** Arrow curving back into a box — "bring this pane back into the cockpit".
 *  The mirror of PopOutIcon in paneIcons.tsx, and drawn to read as its
 *  opposite. Replaces ↩. */
export function BringBackIcon({ size = 12 }: IconProps) {
  return svg(
    <>
      <path d="M6 11v6a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2H8" />
      <polyline points="3 8 8 4 8 12" />
    </>,
    size,
  );
}

/** Arrow dropping into a tray — "add this to the merge queue", and the merge
 *  queue's own mark in the status bar. Replaces ⇥, which is the Tab KEY and
 *  was doing duty as a "push it in" arrow two rows away from the real ⇥ Tab
 *  hints in the spawn dialogs. */
export function QueueIcon({ size = 12 }: IconProps) {
  return svg(
    <>
      <path d="M12 3v9" />
      <polyline points="8 8.5 12 12.5 16 8.5" />
      <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
    </>,
    size,
  );
}

/** A speech mark — "there are N review notes on this file". Replaces the ◆
 *  that followed the count in the diff file list, where a diamond said
 *  nothing about what was being counted. */
export function NoteIcon({ size = 11 }: IconProps) {
  return svg(<path d="M20 14a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z" />, size);
}

/** A small filled lozenge, used purely as a mark on empty-state placeholders
 *  where the old ◆ was decoration rather than meaning. */
export function DiamondIcon({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 3.5 20.5 12 12 20.5 3.5 12z" />
    </svg>
  );
}

/** Disclosure caret. One component with a direction, rather than the ▸/▾ pair
 *  — they were two codepoints with different optical weights standing in for
 *  one control in two states. */
export function CaretIcon({ size = 10, open = false }: IconProps & { open?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{
        transform: open ? "rotate(90deg)" : "none",
        transition: "transform 120ms ease",
      }}
    >
      <polyline points="9 5 16 12 9 19" />
    </svg>
  );
}
