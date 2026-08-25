// App-wide theme switching. Chrome colors (sidebar, dialogs, badges, etc.)
// are all driven by the CSS variables in global.css, keyed off the
// `data-theme` attribute on <html> — see the `:root[data-theme="..."]`
// blocks there. xterm.js can't read CSS variables, so its per-theme colors
// are mirrored here in XTERM_THEMES and kept in sync by hand.
//
// One long-standing quirk, left as found: Daybreak inverts the ANSI black and
// white slots, so `white` is ink and `black` is the paper tone. That keeps
// programs printing white text legible on a light ground, at the cost of
// making explicit black text invisible. Both conventions lose something and
// the tradeoff predates the rebrand, so changing it is a call for a human.

export type ThemeId = "dark" | "light" | "graphite" | "high-contrast";

export const THEMES: { id: ThemeId; label: string }[] = [
  { id: "dark", label: "Nightfall" },
  { id: "light", label: "Daybreak" },
  { id: "graphite", label: "Graphite" },
  { id: "high-contrast", label: "High Contrast" },
];

const STORAGE_KEY = "flock:theme";
const FOLLOW_KEY = "flock:theme-follow-system";
const THEME_EVENT = "flock:theme-changed";

// Pre-rebrand keys, read as a fallback so an existing install keeps the theme
// its user chose instead of snapping back to Nightfall on the first launch
// after the rename. Nothing writes them any more; drop these a few releases
// out, once no one is upgrading from 0.7.x.
const LEGACY_STORAGE_KEY = "clarence:theme";
const LEGACY_FOLLOW_KEY = "clarence:theme-follow-system";

/** The app's theme when nothing has been picked, and the dark half of
 *  "inherit from system". Graphite rather than Nightfall: the navy carries the
 *  brand where the brand is the subject (the site, the mark, the splash), but
 *  the cockpit is a frame around other people's output — terminals, diffs,
 *  agent TUIs that bring their own palettes — and a neutral ground is the one
 *  that does not tint all of it.
 *
 *  Nothing is stored until the swatch row is used, so this also changes the
 *  appearance of every existing install that never picked a theme. That is the
 *  point of moving it, but it is worth knowing it is not only new users. */
const DEFAULT_THEME: ThemeId = "graphite";

/** The user's explicit theme pick — what the swatch row highlights. */
export function getStoredTheme(): ThemeId {
  const v = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
  return THEMES.some((t) => t.id === v) ? (v as ThemeId) : DEFAULT_THEME;
}

/** Whether the app mirrors the OS light/dark appearance instead of the pick. */
export function getFollowSystem(): boolean {
  return (localStorage.getItem(FOLLOW_KEY) ?? localStorage.getItem(LEGACY_FOLLOW_KEY)) === "1";
}

/** The OS appearance, mapped onto our two base themes. Dark resolves to
 *  DEFAULT_THEME, not to Nightfall: someone who turns on "inherit from system"
 *  expects the dark theme they already know, and handing them a different one
 *  than the app opens with would read as a bug in the toggle. */
export function systemTheme(): ThemeId {
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : DEFAULT_THEME;
}

/** The theme actually shown: the system's when following, else the pick. */
export function getEffectiveTheme(): ThemeId {
  return getFollowSystem() ? systemTheme() : getStoredTheme();
}

// Reflect a theme in the DOM and notify listeners (xterm, goose). Does not
// touch stored preferences — callers below decide what to persist.
function reflectTheme(theme: ThemeId) {
  document.documentElement.setAttribute("data-theme", theme);
  window.dispatchEvent(new CustomEvent<ThemeId>(THEME_EVENT, { detail: theme }));
}

/** User picked a theme from the swatch row: stop following the OS, persist. */
export function applyTheme(theme: ThemeId) {
  localStorage.setItem(FOLLOW_KEY, "0");
  localStorage.setItem(STORAGE_KEY, theme);
  reflectTheme(theme);
}

/** Toggle "inherit from system": mirror the OS live, or fall back to the pick. */
export function setFollowSystem(follow: boolean) {
  localStorage.setItem(FOLLOW_KEY, follow ? "1" : "0");
  reflectTheme(getEffectiveTheme());
}

// Apply the effective theme on boot and keep it in sync with the OS while
// "inherit from system" is on. Call once at startup.
export function initTheme() {
  reflectTheme(getEffectiveTheme());
  window
    .matchMedia?.("(prefers-color-scheme: light)")
    .addEventListener?.("change", () => {
      if (getFollowSystem()) reflectTheme(systemTheme());
    });
}

/** Subscribe to theme changes made via applyTheme(). Returns an unsubscribe fn. */
export function onThemeChange(handler: (theme: ThemeId) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<ThemeId>).detail);
  window.addEventListener(THEME_EVENT, listener);
  return () => window.removeEventListener(THEME_EVENT, listener);
}

export function getXtermTheme(theme: ThemeId) {
  return XTERM_THEMES[theme];
}

/** The terminal face, for every xterm the app opens — local panes and the
 *  mirrored co-pilot view alike, so a shared session looks like the pane it
 *  came from.
 *
 *  Hack leads here even though IBM Plex Mono is the brand's code face, and the
 *  reason is coverage rather than taste: the Plex cut vendored in
 *  src/assets/fonts is the website's latin subset, 229 codepoints with no
 *  box-drawing, block or geometric glyphs at all. Every agent that runs a TUI
 *  draws its frames and spinners out of exactly those ranges, so putting Plex
 *  first would send each one through per-glyph fallback into a font with
 *  different advance widths — which is how a terminal's columns come apart.
 *  Hack carries the full set. Plex still owns chrome and metadata via
 *  --font-mono in global.css, where nothing has to line up in columns.
 *  Swap the order the day a complete Plex Mono is vendored. */
export const TERMINAL_FONT_FAMILY =
  '"Hack", "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, Monaco, "Cascadia Code", Consolas, monospace';

const XTERM_THEMES: Record<ThemeId, Record<string, string>> = {
  // Nightfall — the brand's night palette: paper as the ground, ink as the
  // foreground and the cursor, and the ANSI slots mapped onto the status and
  // crest colours (bad/ok/warn/action/rose) so a terminal reads as part of
  // the same app rather than a rectangle of somebody else's palette. Every
  // slot below clears 4.5:1 against the background except `black`, which is
  // the recessed paper tone by ANSI convention and is a fill, not a text
  // colour — see the header note on that slot.
  dark: {
    background: "#0b1524",
    foreground: "#ece9e2",
    cursor: "#ece9e2",
    cursorAccent: "#0b1524",
    selectionBackground: "#7fb4f033",
    black: "#0f1b2e",
    red: "#ff8f84",
    green: "#4fffb0",
    yellow: "#ffc48a",
    blue: "#5b8cff",
    magenta: "#f6c6d8",
    cyan: "#8fdde8",
    white: "#ece9e2",
    brightBlack: "#7e8aa0",
    brightRed: "#ffb3ab",
    brightGreen: "#93ffcd",
    brightYellow: "#ffe0b8",
    brightBlue: "#93b4ff",
    brightMagenta: "#ffd9e8",
    brightCyan: "#b3ecf4",
    brightWhite: "#ffffff",
  },
  // Graphite — neutral greys, no hue spent on chrome. The ANSI slots keep the
  // same *roles* as Nightfall (red/green/yellow are the status trio, magenta
  // and cyan are crest-adjacent) but `blue` is the one that has to change
  // meaning: there is no interaction blue in this theme, so the slot takes the
  // ink tone rather than inventing a hue the palette doesn't contain. A program
  // that colours its output blue reads as plain text here, which is the correct
  // reading of a theme whose whole position is that chrome carries no hue.
  // Mirror any edits into the [data-theme="graphite"] block in global.css.
  graphite: {
    background: "#121212",
    foreground: "#f2f1ee",
    cursor: "#f2f1ee",
    cursorAccent: "#121212",
    selectionBackground: "#f2f1ee29",
    black: "#191919",
    red: "#f08c80",
    green: "#7dd6a4",
    yellow: "#e8c07a",
    blue: "#c6c5c1",
    magenta: "#f6c6d8",
    cyan: "#8fdde8",
    white: "#f2f1ee",
    brightBlack: "#8b8a86",
    brightRed: "#f6afa6",
    brightGreen: "#a3e5c0",
    brightYellow: "#f2d5a4",
    brightBlue: "#e2e1de",
    brightMagenta: "#ffd9e8",
    brightCyan: "#b3ecf4",
    brightWhite: "#ffffff",
  },
  // High Contrast — pure black canvas, pure white ink, saturated ANSI for
  // maximum legibility. Mirror any edits into the [data-theme="high-contrast"]
  // token block in global.css.
  "high-contrast": {
    background: "#000000",
    foreground: "#ffffff",
    cursor: "#ffffff",
    cursorAccent: "#000000",
    selectionBackground: "#ffffff59",
    black: "#000000",
    red: "#ff6b6b",
    green: "#4dff91",
    yellow: "#ffe500",
    blue: "#66ccff",
    magenta: "#ff8ad8",
    cyan: "#6cf5ff",
    white: "#ffffff",
    brightBlack: "#a6a6a6",
    brightRed: "#ff9a9a",
    brightGreen: "#8affb8",
    brightYellow: "#fff07a",
    brightBlue: "#a6ddff",
    brightMagenta: "#ffb8e6",
    brightCyan: "#a6faff",
    brightWhite: "#ffffff",
  },
  // Daybreak — ink on paper, the same slot-for-slot mapping as Nightfall.
  // The bright* row goes *deeper* than its base rather than lighter: on paper
  // a lighter variant is a quieter one, and the old cut of this theme had
  // bright red/green/magenta/cyan sitting at 3–3.5:1, i.e. unreadable at the
  // sizes a terminal actually uses. Deepened until each hue clears 7:1.
  // brightBlack is the exception and stays a mid grey at 4.8:1 — it is the
  // dim-text slot, so making it AAA would defeat what programs use it for.
  // `black` is the paper tone here, inverted like `white`; see the note in
  // the header about that pairing.
  light: {
    background: "#fcfbf8",
    foreground: "#0b1b33",
    cursor: "#0b1b33",
    cursorAccent: "#fcfbf8",
    selectionBackground: "#7fb4f04d",
    black: "#f4f2ec",
    red: "#b4483f",
    green: "#1d7a4e",
    yellow: "#9a6231",
    blue: "#1e5eff",
    magenta: "#a4457e",
    cyan: "#0e7d94",
    white: "#0b1b33",
    brightBlack: "#61708a",
    brightRed: "#8f3931",
    brightGreen: "#14603c",
    brightYellow: "#7a4a22",
    brightBlue: "#1849c9",
    brightMagenta: "#7e2f5c",
    brightCyan: "#0a5d6e",
    brightWhite: "#060f1e",
  },
};
