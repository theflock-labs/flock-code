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

/** What Settings and ⌘K offer. "graphite" is still a valid stored value (v1's
 *  default) and reads as Dark, which is what v2's dark palette grew out of. */
export const THEMES: { id: ThemeId; label: string }[] = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "high-contrast", label: "High contrast" },
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
const DEFAULT_THEME: ThemeId = "dark";

/** The user's explicit theme pick — what the swatch row highlights. */
export function getStoredTheme(): ThemeId {
  const v = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
  if (v === "graphite") return "dark";
  return THEMES.some((t) => t.id === v) ? (v as ThemeId) : DEFAULT_THEME;
}

/** Whether the app mirrors the OS light/dark appearance instead of the pick. */
export function getFollowSystem(): boolean {
  // Unset means nobody has picked yet: follow the Mac, as lucy-chat does.
  // Picking a theme writes "0", so an explicit choice always wins.
  return (localStorage.getItem(FOLLOW_KEY) ?? localStorage.getItem(LEGACY_FOLLOW_KEY) ?? "1") === "1";
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

/** Default and fallback stack for local and mirrored terminals. An explicit
 *  Appearance preference can select another face; see terminalFont.ts.
 *  Keep xterm's normal/bold defaults for the CLI's ANSI emphasis.
 *  Keep the bundled Plex latin subset out of this stack: it lacks the
 *  box-drawing and block glyphs used by agent TUIs. */
export const TERMINAL_FONT_FAMILY =
  'ui-monospace, "SF Mono", Menlo, Monaco, "Cascadia Mono", Consolas, "Liberation Mono", "DejaVu Sans Mono", monospace';

// v2 palettes. The background is the panel's own paper, so a terminal reads as
// the panel's content rather than a rectangle laid on it; the ANSI slots keep
// their roles (red/green/yellow carry status) at contrast that holds at 12px.
const DARK_TERM: Record<string, string> = {
  background: "#16181d",
  foreground: "#eceef1",
  cursor: "#eceef1",
  cursorAccent: "#16181d",
  selectionBackground: "#b8c1cc40",
  black: "#1f2228",
  red: "#ff7b72",
  green: "#56d394",
  yellow: "#e3b85c",
  blue: "#79aef2",
  magenta: "#d9a0e6",
  cyan: "#6fd1d9",
  white: "#d6d9de",
  brightBlack: "#7c828b",
  brightRed: "#ffa198",
  brightGreen: "#7ee3ad",
  brightYellow: "#f0cd85",
  brightBlue: "#a3c8f7",
  brightMagenta: "#e8bff0",
  brightCyan: "#9be3e8",
  brightWhite: "#ffffff",
};

const XTERM_THEMES: Record<ThemeId, Record<string, string>> = {
  dark: DARK_TERM,
  graphite: DARK_TERM,
  // High Contrast — pure black canvas, pure white ink, saturated ANSI.
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
  // Light — ink on white. Like v1's Daybreak, `white` is ink and `black` the
  // paper tone, so a program that prints "white" text stays legible on a light
  // ground; bright* go deeper rather than lighter, because on paper a lighter
  // colour is a quieter one.
  light: {
    background: "#ffffff",
    foreground: "#111318",
    cursor: "#111318",
    cursorAccent: "#ffffff",
    selectionBackground: "#4d596633",
    black: "#f3f4f6",
    red: "#c21f2d",
    green: "#1f7a43",
    yellow: "#8a5a00",
    blue: "#1f5fbf",
    magenta: "#9b3a8a",
    cyan: "#0b7285",
    white: "#111318",
    brightBlack: "#676c75",
    brightRed: "#a01622",
    brightGreen: "#155c32",
    brightYellow: "#6b4500",
    brightBlue: "#174a96",
    brightMagenta: "#7a2d6c",
    brightCyan: "#085766",
    brightWhite: "#000000",
  },
};
