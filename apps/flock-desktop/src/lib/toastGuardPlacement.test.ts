import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * SUPPRESSING A POP-UP MUST NOT SUPPRESS THE EVENT.
 *
 * "Don't show again" is a request to stop being interrupted, not a request to
 * be kept in the dark. Three of the four suppressible toasts are a real person
 * asking to pair, to watch, or to hand over work; a guard that sat one line too
 * high would drop those on the floor and nothing on screen would ever say so.
 *
 * The property is positional and lives in App.tsx, so it is pinned at the
 * source rather than through a render: every `isToastSuppressed` guard has to
 * come AFTER the `pushNotification` for the same event, and every raise site
 * has to have one. A missing guard is a nuisance; a misplaced one is silence.
 */

const APP = readFileSync(resolve("src/App.tsx"), "utf8").split("\n");

const guardLines = APP.flatMap((l, i) => (/if \(isToastSuppressed\(/.test(l) ? [i] : []));
// A RAISE, not the dismiss handler, which is the one call that only ever
// removes (`prev.filter`) and must stay unguarded — a suppressed kind still
// has to be dismissable if one is already on screen.
const raiseLines = APP.flatMap((l, i) =>
  /setSessionToasts\(\(prev\) =>/.test(l) && !/prev\.filter/.test(l) ? [i] : [],
);

describe("toast suppression guards", () => {
  it("guards every site that raises a toast", () => {
    expect(raiseLines.length).toBeGreaterThan(0);
    expect(guardLines).toHaveLength(raiseLines.length);
  });

  /* Each guard is the last thing before its raise, and the notification for
   * the same event is already behind it. The window has to clear the PR case,
   * where a `for` loop of pushes and the `const tabs = …` map sit between the
   * two, and each of these blocks starts with `if (msg.type === …)` well
   * inside it, so it cannot reach the previous event's push. */
  it.each(guardLines)("logs the event before deciding whether to interrupt (line %i)", (i) => {
    const before = APP.slice(Math.max(0, i - 24), i).join("\n");
    expect(before).toMatch(/pushNotification\(/);
  });

  it("puts the guard before the raise it guards, not after", () => {
    for (const g of guardLines) {
      const next = raiseLines.find((r) => r > g);
      expect(next).toBeDefined();
      // Nothing but comments and plain statements between the two; if another
      // guard intervenes, one raise site is running unguarded.
      expect(guardLines.filter((o) => o > g && o < next!)).toHaveLength(0);
    }
  });
});
