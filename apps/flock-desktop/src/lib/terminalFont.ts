import type { Terminal } from "@xterm/xterm";
import { TERMINAL_FONT_FAMILY } from "./theme";

const STORAGE_KEY = "flock:terminal-font";
const CHANGE_EVENT = "flock:terminal-font-changed";
export const TERMINAL_FONT_NAME_MAX = 100;
export const TERMINAL_FONT_PRESETS = [
  "SF Mono", "Menlo", "Monaco", "Cascadia Mono", "Consolas",
  "JetBrains Mono", "Fira Code", "Hack",
];

/** One family name, not a CSS font stack. Empty means System default. */
export function normalizeTerminalFont(value: string | null): string {
  return (value ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, TERMINAL_FONT_NAME_MAX);
}

export function getStoredTerminalFont(): string {
  try { return normalizeTerminalFont(localStorage.getItem(STORAGE_KEY)); }
  catch { return ""; }
}

function quoteFont(name: string): string {
  return `"${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function getTerminalFontFamily(name = getStoredTerminalFont()): string {
  const font = normalizeTerminalFont(name);
  return font ? `${quoteFont(font)}, ${TERMINAL_FONT_FAMILY}` : TERMINAL_FONT_FAMILY;
}

export function applyTerminalFont(name: string): string {
  const font = normalizeTerminalFont(name);
  if (font) localStorage.setItem(STORAGE_KEY, font);
  else localStorage.removeItem(STORAGE_KEY);
  window.dispatchEvent(new CustomEvent<string>(CHANGE_EVENT, { detail: font }));
  return font;
}

/** CustomEvents reach this window; storage events reach popped-out windows. */
export function onTerminalFontChange(handler: (font: string) => void): () => void {
  const local = (event: Event) => handler((event as CustomEvent<string>).detail);
  const storage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY || event.key === null) {
      handler(normalizeTerminalFont(event.newValue));
    }
  };
  window.addEventListener(CHANGE_EVENT, local);
  window.addEventListener("storage", storage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, local);
    window.removeEventListener("storage", storage);
  };
}

/** Start xterm with the system stack, then select the saved face only once
 * its normal and bold glyphs are ready. This also covers opt-in bundled Hack.
 * Font changes must not race each other or finish against an unmounted pane. */
export function bindTerminalFont(term: Pick<Terminal, "options">, refit: () => void): () => void {
  let revision = 0;
  const update = (font: string) => {
    const request = ++revision;
    const family = getTerminalFontFamily(font);
    const commit = () => {
      if (request !== revision) return;
      term.options.fontFamily = family;
      refit();
    };
    if (!font || !document.fonts) { commit(); return; }
    const face = `${term.options.fontSize ?? 13}px ${quoteFont(font)}`;
    void Promise.allSettled([document.fonts.load(`400 ${face}`), document.fonts.load(`700 ${face}`)])
      .then(commit); // A missing face falls back to the system stack.
  };
  const unsubscribe = onTerminalFontChange(update);
  update(getStoredTerminalFont());
  return () => { revision++; unsubscribe(); };
}
