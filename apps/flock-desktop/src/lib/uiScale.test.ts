// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  applyPaneFontSize,
  applyUiScale,
  BASE_PANE_FONT_SIZE,
  getScaleFactor,
  getStoredPaneFontSize,
  onPaneFontSizeChange,
  PANE_FONT_MAX,
  PANE_FONT_MIN,
  stepPaneFontSize,
  stepUiScale,
} from "./uiScale";

/**
 * The whole point of the split is that the two sizes move on their own, and
 * the whole risk of it is that an existing install wakes up with panes at a
 * size it never chose. Both are pinned here.
 */

describe("text size", () => {
  // Node 22 puts its own half-configured `localStorage` on globalThis, which
  // shadows jsdom's and has no `clear`. Same substitution secureSettings.test
  // and budgets.test make, for the same reason.
  beforeAll(() => {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
        clear: () => store.clear(),
      },
    });
  });

  beforeEach(() => localStorage.clear());

  it("starts an unconfigured pane at whatever the old single setting produced", () => {
    // An install that had picked Large under the combined setting: panes were
    // rendered at round(13 × 1.23) = 16, and must stay there.
    localStorage.setItem("flock:ui-scale", "lg");
    expect(getStoredPaneFontSize()).toBe(Math.round(BASE_PANE_FONT_SIZE * getScaleFactor("lg")));
  });

  it("stops tracking the app scale once a pane size is stored", () => {
    applyPaneFontSize(15);
    applyUiScale("xl");
    expect(getStoredPaneFontSize()).toBe(15);

    stepUiScale(-1);
    expect(getStoredPaneFontSize()).toBe(15);
  });

  it("clamps in both directions instead of running off the end", () => {
    expect(applyPaneFontSize(2)).toBe(PANE_FONT_MIN);
    expect(stepPaneFontSize(-1)).toBe(PANE_FONT_MIN);
    expect(applyPaneFontSize(900)).toBe(PANE_FONT_MAX);
    expect(stepPaneFontSize(1)).toBe(PANE_FONT_MAX);
  });

  it("steps by one point and notifies live terminals", () => {
    applyPaneFontSize(13);
    const seen: number[] = [];
    const off = onPaneFontSizeChange((px) => seen.push(px));
    expect(stepPaneFontSize(1)).toBe(14);
    expect(stepPaneFontSize(-1)).toBe(13);
    off();
    stepPaneFontSize(1);
    expect(seen).toEqual([14, 13]);
  });

  it("ignores a garbage stored value rather than handing xterm a NaN", () => {
    localStorage.setItem("flock:pane-font-size", "not-a-number");
    expect(getStoredPaneFontSize()).toBe(Math.round(BASE_PANE_FONT_SIZE * getScaleFactor("md")));
  });

  it("treats a blank stored pane size as unset, not as 8px", () => {
    // Number("") is 0, which clampPaneFont would turn into PANE_FONT_MIN.
    localStorage.setItem("flock:pane-font-size", "");
    expect(getStoredPaneFontSize()).toBe(Math.round(BASE_PANE_FONT_SIZE * getScaleFactor("md")));
  });

  it("freezes the migrated size so later chrome-scale changes leave panes alone", () => {
    // main.tsx does this on boot: persist whatever the old combined setting
    // produced, then the two knobs move independently.
    localStorage.setItem("flock:ui-scale", "lg");
    const migrated = getStoredPaneFontSize();
    applyPaneFontSize(migrated);
    applyUiScale("sm");
    expect(getStoredPaneFontSize()).toBe(migrated);
  });

  it("re-emits a pane size written by another window", () => {
    const seen: number[] = [];
    const off = onPaneFontSizeChange((px) => seen.push(px));
    window.dispatchEvent(new StorageEvent("storage", {
      key: "flock:pane-font-size",
      newValue: "18",
    }));
    off();
    expect(seen).toEqual([18]);
  });
});
