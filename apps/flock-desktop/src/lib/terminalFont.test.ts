// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TERMINAL_FONT_FAMILY } from "./theme";
import {
  applyTerminalFont, bindTerminalFont, getStoredTerminalFont,
  getTerminalFontFamily, onTerminalFontChange,
} from "./terminalFont";

const subscriptions: (() => void)[] = [];
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
});
afterEach(() => { subscriptions.splice(0).forEach(off => off()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function pendingFont() {
  let resolve!: (fonts: FontFace[]) => void;
  const promise = new Promise<FontFace[]>(done => { resolve = done; });
  return { promise, resolve: () => resolve([]) };
}

describe("terminal font preference", () => {
  it("starts with system typography, persists a choice, and resets it", () => {
    expect(getTerminalFontFamily()).toBe(TERMINAL_FONT_FAMILY);
    applyTerminalFont("  Menlo  ");
    expect(getStoredTerminalFont()).toBe("Menlo");
    expect(getTerminalFontFamily()).toBe(`"Menlo", ${TERMINAL_FONT_FAMILY}`);
    applyTerminalFont("");
    expect(localStorage.getItem("flock:terminal-font")).toBeNull();
    expect(getTerminalFontFamily()).toBe(TERMINAL_FONT_FAMILY);
  });

  it("treats a custom name as one quoted family and retains a fallback", () => {
    expect(getTerminalFontFamily('A"B\\C, serif')).toBe(`"A\\"B\\\\C, serif", ${TERMINAL_FONT_FAMILY}`);
    applyTerminalFont("\n\t");
    expect(getStoredTerminalFont()).toBe("");
  });

  it("notifies current and popped-out windows, including resetting in another window", () => {
    const changed = vi.fn();
    const off = onTerminalFontChange(changed);
    subscriptions.push(off);
    applyTerminalFont("Menlo");
    window.dispatchEvent(new StorageEvent("storage", { key: "flock:terminal-font", newValue: "Monaco" }));
    window.dispatchEvent(new StorageEvent("storage", { key: "flock:terminal-font", newValue: null }));
    window.dispatchEvent(new StorageEvent("storage", { key: "unrelated", newValue: "Hack" }));
    expect(changed.mock.calls.map(([font]) => font)).toEqual(["Menlo", "Monaco", ""]);
    off();
    applyTerminalFont("Hack");
    expect(changed).toHaveBeenCalledTimes(3);
  });

  it("waits for both weights before switching and refitting a saved bundled font", async () => {
    applyTerminalFont("Hack");
    const regular = pendingFont();
    const bold = pendingFont();
    const load = vi.fn((font: string) => font.startsWith("400") ? regular.promise : bold.promise);
    Object.defineProperty(document, "fonts", { configurable: true, value: { load } });
    const term = { options: { fontFamily: TERMINAL_FONT_FAMILY, fontSize: 15 } };
    const refit = vi.fn();
    subscriptions.push(bindTerminalFont(term, refit));
    expect(load.mock.calls.map(([font]) => font)).toEqual(['400 15px "Hack"', '700 15px "Hack"']);
    regular.resolve();
    await Promise.resolve();
    expect(refit).not.toHaveBeenCalled();
    bold.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(term.options.fontFamily).toBe(getTerminalFontFamily("Hack"));
    expect(refit).toHaveBeenCalledTimes(1);
  });

  it("cannot let a slow font load replace a newer selection or touch a disposed pane", async () => {
    const pending = pendingFont();
    Object.defineProperty(document, "fonts", { configurable: true, value: { load: () => pending.promise } });
    const term = { options: { fontFamily: TERMINAL_FONT_FAMILY, fontSize: 13 } };
    const refit = vi.fn();
    const off = bindTerminalFont(term, refit);
    subscriptions.push(off);
    applyTerminalFont("Hack");
    applyTerminalFont("");
    const callsAfterReset = refit.mock.calls.length;
    pending.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(term.options.fontFamily).toBe(TERMINAL_FONT_FAMILY);
    expect(refit).toHaveBeenCalledTimes(callsAfterReset);
    applyTerminalFont("Menlo");
    off();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(refit).toHaveBeenCalledTimes(callsAfterReset);
  });

  it("continues with system fallbacks when a requested font fails to load", async () => {
    Object.defineProperty(document, "fonts", { configurable: true, value: { load: () => Promise.reject(new Error("Unavailable")) } });
    const term = { options: { fontFamily: TERMINAL_FONT_FAMILY, fontSize: 13 } };
    const refit = vi.fn();
    subscriptions.push(bindTerminalFont(term, refit));
    applyTerminalFont("Unavailable Mono");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(term.options.fontFamily).toBe(`"Unavailable Mono", ${TERMINAL_FONT_FAMILY}`);
    expect(refit).toHaveBeenCalledTimes(2);
  });
});
