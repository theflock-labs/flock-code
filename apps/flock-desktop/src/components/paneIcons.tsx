// Line icons for the workspace-header and pane-topbar action rows (the
// "right-hand side" controls, both at the workspace level and the per-agent
// pane level). Stroke style matches the app's other inline icons (2px,
// round caps, currentColor) — see friendIcons.tsx for the same convention.
//
// These replace ambiguous Unicode glyphs (⇆, ⇅, ⊡, ⧉) that read fine once
// you already know what they do, but don't communicate it on first glance.

interface IconProps {
  size?: number;
}

/** Pane split into left/right columns — "Split Right". */
export function SplitRightIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="12" y1="4" x2="12" y2="20" />
    </svg>
  );
}

/** A shell window with a prompt — "open this folder in a real terminal". */
export function TerminalIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7.5 10 L10 12.5 L7.5 15" />
      <line x1="13" y1="15.5" x2="16.5" y2="15.5" />
    </svg>
  );
}

/** Pane split into top/bottom rows — "Split Down". */
export function BroadcastIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="5" cy="12" r="2.2" fill="currentColor" stroke="none" />
      <path d="M9 12 H20" />
      <path d="M9 12 L17 6.5" />
      <path d="M9 12 L17 17.5" />
    </svg>
  );
}

/** One point forking into three — "Race agents": the same prompt going three
 * ways. Deliberately the git-branch gesture rather than a trophy or a
 * stopwatch: what a race actually produces is branches, and that is also what
 * the compare view is comparing. */
export function RaceIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="5" cy="12" r="2.2" fill="currentColor" stroke="none" />
      <path d="M7.5 12 H11" />
      <path d="M11 12 C 14 12, 14 5.5, 17 5.5" />
      <path d="M11 12 H17" />
      <path d="M11 12 C 14 12, 14 18.5, 17 18.5" />
      <circle cx="19" cy="5.5" r="1.9" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.9" fill="currentColor" stroke="none" />
      <circle cx="19" cy="18.5" r="1.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function SplitDownIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="3" y1="12" x2="21" y2="12" />
    </svg>
  );
}

/** Four corner brackets pointing outward — "Zoom" (fill the grid). */
export function ExpandIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 3H5a2 2 0 0 0-2 2v3" />
      <path d="M16 3h3a2 2 0 0 1 2 2v3" />
      <path d="M8 21H5a2 2 0 0 1-2-2v-3" />
      <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
    </svg>
  );
}

/** Four corner brackets pointing inward — "Unzoom" (back to the grid). */
export function CollapseIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 3v3a2 2 0 0 1-2 2H3" />
      <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
      <path d="M3 16h3a2 2 0 0 1 2 2v3" />
      <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
    </svg>
  );
}

/** Box with an arrow breaking out its top-right corner — "Pop out into its
 *  own window" (the standard "open in new window/tab" glyph). */
export function PopOutIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

/** Window with its left side-rail — "toggle the left sidebar". The rail fills
 *  when the sidebar is showing and hollows when it's hidden, so the glyph
 *  doubles as a state readout. Distinct from SplitRightIcon (a centred divider,
 *  no fill) so a layout toggle never reads as a pane split. */
export function PanelLeftIcon({ size = 14, filled = true }: IconProps & { filled?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {filled && <path d="M9 5H6a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h3z" fill="currentColor" fillOpacity="0.9" stroke="none" />}
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="9" y1="4.5" x2="9" y2="19.5" />
    </svg>
  );
}

/** Window with its right side-rail — "toggle the right panel". Mirror of
 *  PanelLeftIcon; rail fills when the right rail is showing. */
export function PanelRightIcon({ size = 14, filled = true }: IconProps & { filled?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {filled && <path d="M15 5h3a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-3z" fill="currentColor" fillOpacity="0.9" stroke="none" />}
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="15" y1="4.5" x2="15" y2="19.5" />
    </svg>
  );
}

/** Pencil — "Rename" (edit a tab name). */
export function PencilIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}
