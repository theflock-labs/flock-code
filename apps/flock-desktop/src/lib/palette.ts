// Workspace accent palette.
//
// These are token references, not hex, and that is the whole point: the accent
// is painted on whichever theme happens to be active, so a literal value is a
// value that is wrong on two of the three. The eight slots are defined once per
// theme in global.css as --ws-accent-1..8, with Daybreak carrying its own
// deepened cut; the pastels this file used to return measured 1.2:1 against
// Daybreak's paper, which is a workspace with no visible accent at all.
//
// Slot order is identity: a workspace's accent comes from its position in the
// list, so slot 4 must stay the green one in every theme or workspaces swap
// colours when the theme changes.

const SLOTS = 8;

export const workspaceColor = (index: number): string =>
  `var(--ws-accent-${(index % SLOTS) + 1})`;
