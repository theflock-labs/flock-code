import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The submenu opens where the parent row is.
 *
 * It is rendered as a DESCENDANT of `.ctx-menu` on purpose, so the
 * outside-click guard's `ref.contains` treats a click in the flyout as a click
 * inside the menu. That containment has a cost the original code did not pay:
 * `.ctx-menu` carries a backdrop-filter, and a filtered ancestor becomes the
 * containing block for `position: fixed` descendants. Viewport coordinates
 * were therefore being applied relative to the menu's own corner, so the
 * flyout opened roughly one menu-width down and across, usually past the edge
 * of the window. On screen that reads as a submenu with nothing in it.
 *
 * Two halves, and the bug comes back if either is undone on its own: the CSS
 * has to say `absolute`, and openFlyout has to hand over menu-relative
 * numbers. A test rather than a comment because the two live in different
 * files and each looks correct in isolation.
 */

const CSS = readFileSync(resolve("src/styles/global.css"), "utf8");
const TSX = readFileSync(resolve("src/components/ContextMenu.tsx"), "utf8");

describe("context menu flyout", () => {
  it("is positioned inside its menu, not against the viewport", () => {
    const block = /^\.ctx-submenu\s*\{([\s\S]*?)^\}/m.exec(CSS);
    expect(block).not.toBeNull();
    expect(block![1]).toMatch(/position:\s*absolute/);
  });

  /* Same specificity as `.ctx-menu`, which sets `fixed`, so document order is
   * the only thing deciding this. Moving the rule up the sheet silently
   * restores the bug. */
  it("wins over the fixed positioning it shares a class with", () => {
    expect(CSS.indexOf(".ctx-submenu {")).toBeGreaterThan(CSS.indexOf(".ctx-menu {"));
  });

  it("converts the row's screen position into menu-relative coordinates", () => {
    const fn = /const openFlyout[\s\S]*?\n  };/.exec(TSX);
    expect(fn).not.toBeNull();
    const body = fn![0];
    // The menu's own rect has to enter the arithmetic; without it the numbers
    // stored are viewport coordinates wearing a relative label.
    expect(body).toMatch(/ref\.current\?\.getBoundingClientRect\(\)/);
    expect(body).toMatch(/menu\?\.left/);
    expect(body).toMatch(/menu\?\.top/);
  });
});
