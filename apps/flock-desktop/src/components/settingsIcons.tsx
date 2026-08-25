// One icon per Settings section, for the dialog's left rail.
//
// Same convention as paneIcons.tsx and friendIcons.tsx: 24-unit viewBox, 2px
// round-capped strokes, currentColor — so a section's glyph inherits whatever
// the row's text colour is doing (ghost at rest, full ink when selected) and
// never has to be restyled per theme.
//
// DELIBERATELY MONOCHROME LINE ART, NOT SYSTEM SETTINGS' COLOURED TILES.
// macOS fills each preference icon with its own saturated rounded square, and
// copying that here would put thirteen competing colour chips down the side of
// a dialog whose entire redesign was about spending colour only where it means
// something (a workspace's identity, an agent that needs you). The shape does
// the identifying; the colour stays available for state.
//
// Every glyph is drawn on the same optical weight so no single row reads
// heavier than its neighbours — the failure mode for an icon set like this is
// one busy glyph pulling the eye every time the rail is scanned.

interface IconProps {
  size?: number;
}

const svg = (children: React.ReactNode, size: number) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);

/** Account — a person. */
export function PersonIcon({ size = 15 }: IconProps) {
  return svg(
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c0-3.5 3.1-5.5 7-5.5s7 2 7 5.5" />
    </>,
    size,
  );
}

/** Usage Details — a bar chart. */
export function ChartIcon({ size = 15 }: IconProps) {
  return svg(
    <>
      <line x1="6" y1="19" x2="6" y2="12" />
      <line x1="12" y1="19" x2="12" y2="6" />
      <line x1="18" y1="19" x2="18" y2="15" />
    </>,
    size,
  );
}

/** Appearance — a half-filled circle, the standard light/dark mark. */
export function AppearanceIcon({ size = 15 }: IconProps) {
  return svg(
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none" />
    </>,
    size,
  );
}

/** Voice — a microphone. */
export function MicIcon({ size = 15 }: IconProps) {
  return svg(
    <>
      <rect x="9.5" y="3" width="5" height="10" rx="2.5" />
      <path d="M6 11a6 6 0 0 0 12 0" />
      <line x1="12" y1="17" x2="12" y2="20.5" />
    </>,
    size,
  );
}

/** Branches — a commit forking off a trunk. */
export function BranchIcon({ size = 15 }: IconProps) {
  return svg(
    <>
      <line x1="7" y1="4" x2="7" y2="20" />
      <circle cx="7" cy="20" r="1.6" />
      <circle cx="17" cy="8" r="1.6" />
      <path d="M17 9.6v2c0 2.5-2 3.4-4.5 3.9C10.4 15.9 7 16.4 7 19" />
    </>,
    size,
  );
}

/** GitHub — the octocat silhouette, simplified to a single filled path. */
export function GithubIcon({ size = 15 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

/** Graph — three linked nodes. */
export function GraphIcon({ size = 15 }: IconProps) {
  return svg(
    <>
      <circle cx="6" cy="17" r="2.2" />
      <circle cx="17" cy="17" r="2.2" />
      <circle cx="12" cy="6" r="2.2" />
      <line x1="10.6" y1="7.8" x2="7.3" y2="15" />
      <line x1="13.4" y1="7.8" x2="15.8" y2="15" />
    </>,
    size,
  );
}

/** Teams — two people. */
export function TeamsIcon({ size = 15 }: IconProps) {
  return svg(
    <>
      <circle cx="9" cy="8.5" r="3" />
      <path d="M3 19c0-3 2.7-4.8 6-4.8s6 1.8 6 4.8" />
      <path d="M16 6.2a3 3 0 0 1 0 5.6" />
      <path d="M17.5 14.6c2 .6 3.5 2 3.5 4.4" />
    </>,
    size,
  );
}

/** Integrations — a plug-in block joining a frame. */
export function PuzzleIcon({ size = 15 }: IconProps) {
  return svg(
    <>
      <path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9" />
      <path d="M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9" />
      <path d="M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15" />
      <path d="M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15" />
      <rect x="9" y="9" width="6" height="6" rx="1.4" />
    </>,
    size,
  );
}

/** Provenance — a document with ruled lines: the exportable record. */
export function RecordIcon({ size = 15 }: IconProps) {
  return svg(
    <>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v4h4" />
      <line x1="9" y1="12.5" x2="15" y2="12.5" />
      <line x1="9" y1="16" x2="15" y2="16" />
    </>,
    size,
  );
}

/** Security — a shield. */
export function ShieldIcon({ size = 15 }: IconProps) {
  return svg(<path d="M12 3l7 3v5.5c0 4.3-2.9 7.7-7 9.5-4.1-1.8-7-5.2-7-9.5V6z" />, size);
}

/** About — an info mark. */
export function InfoIcon({ size = 15 }: IconProps) {
  return svg(
    <>
      <circle cx="12" cy="12" r="8.5" />
      <line x1="12" y1="11" x2="12" y2="16.5" />
      <circle cx="12" cy="7.8" r="0.9" fill="currentColor" stroke="none" />
    </>,
    size,
  );
}
