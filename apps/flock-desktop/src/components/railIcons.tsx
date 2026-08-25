// Glyphs for the sidebar's own tab bar — the Home / Friends segmented control
// at the top of the rail, and nothing else.
//
// A fourth icon file rather than a shared one, following the convention the
// other three already set: friendIcons.tsx owns the friends surface,
// paneIcons.tsx the pane and workspace-header actions, settingsIcons.tsx the
// Settings nav. Each surface owns its glyphs, so none of them can be changed
// out from under another by an edit made somewhere else.
//
// Same construction as those: 24-unit viewBox, 2px round-capped strokes,
// currentColor — so a tab's glyph inherits whatever its label is doing (ghost
// at rest, full ink when selected) with no second rule to keep in step.

interface IconProps {
  size?: number;
}

/** Home — the workspaces, agents, git and queue surface. A house, which is
 *  what every app on this platform means by "the main view". */
export function HomeIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" />
    </svg>
  );
}

/** Friends — two people.
 *  Deliberately NOT settingsIcons' TeamsIcon, though both draw two figures:
 *  that one means a Team (an org you belong to) and this one means the people
 *  you have added. Two meanings that happen to look alike are still two
 *  meanings, and sharing one drawing between them would make a later change to
 *  either silently move the other. */
export function FriendsIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="9" cy="8.5" r="3.2" />
      <path d="M3.5 19c0-3.1 2.6-5 5.5-5s5.5 1.9 5.5 5" />
      <path d="M16.5 6.4a3.2 3.2 0 0 1 0 4.2" />
      <path d="M18 13.9c1.7.7 2.5 2.2 2.5 4.1" />
    </svg>
  );
}
