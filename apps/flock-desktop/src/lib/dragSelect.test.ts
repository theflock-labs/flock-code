// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDragSelect, type DragSelectHost } from "./dragSelect";

/**
 * The press is ambiguous and the arbitration is the whole module, so it is
 * tested as a state machine over real DOM events rather than through xterm.
 *
 * Two failures matter more than the rest and each has a test of its own: a
 * click that never reaches the agent (the terminal stops responding to clicks
 * entirely), and a selection anchored at the wrong cell (every selection
 * quietly loses its first characters).
 */

function harness(mouseReporting = true) {
  const screen = document.createElement("div");
  document.body.appendChild(screen);
  const seen: MouseEvent[] = [];
  for (const type of ["mousedown", "mouseup"]) {
    screen.addEventListener(type, (e) => seen.push(e as MouseEvent));
  }
  const focus = vi.fn();
  const host: DragSelectHost = {
    screen: () => screen,
    mouseReporting: () => mouseReporting,
    focus,
  };
  return { screen, seen, focus, ds: createDragSelect(host) };
}

function press(x: number, y: number, opts: MouseEventInit = {}) {
  return new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, ...opts });
}
function release(x: number, y: number) {
  return new MouseEvent("mouseup", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
}
function move(x: number, y: number) {
  return new MouseEvent("mousemove", { bubbles: true, clientX: x, clientY: y });
}

describe("drag to select", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("turns a drag into a forced selection xterm will accept", () => {
    const { seen, ds } = harness();
    ds.onCaptureMouseDown(press(100, 100));
    expect(seen).toHaveLength(0); // held, shown to nobody yet
    ds.onMouseMove(move(120, 100));
    expect(seen).toHaveLength(1);
    expect(seen[0].type).toBe("mousedown");
    expect(seen[0].altKey).toBe(true);
  });

  /* Anchoring at the current pointer instead of the press would silently drop
   * the first few characters of every selection. */
  it("anchors the selection where the press was, not where the drag noticed", () => {
    const { seen, ds } = harness();
    ds.onCaptureMouseDown(press(100, 100));
    ds.onMouseMove(move(140, 160));
    expect(seen[0].clientX).toBe(100);
    expect(seen[0].clientY).toBe(100);
  });

  /* If this breaks, clicking anything inside an agent's UI stops working. */
  it("replays a click in full when the press never moved", () => {
    const { seen, ds } = harness();
    ds.onCaptureMouseDown(press(50, 50));
    ds.onMouseUp(release(50, 50));
    expect(seen.map((e) => e.type)).toEqual(["mousedown", "mouseup"]);
    expect(seen.every((e) => e.altKey === false)).toBe(true);
    expect(seen[0].clientX).toBe(50);
  });

  it("does not also deliver a click after a drag", () => {
    const { seen, ds } = harness();
    ds.onCaptureMouseDown(press(10, 10));
    ds.onMouseMove(move(60, 10));
    ds.onMouseUp(release(60, 10));
    expect(seen.map((e) => e.type)).toEqual(["mousedown"]);
  });

  it("ignores travel under the threshold, which is a click with a shaky hand", () => {
    const { seen, ds } = harness();
    ds.onCaptureMouseDown(press(10, 10));
    ds.onMouseMove(move(12, 11));
    ds.onMouseUp(release(12, 11));
    expect(seen.map((e) => e.type)).toEqual(["mousedown", "mouseup"]);
    expect(seen[0].altKey).toBe(false);
  });

  it("swallows the press it is holding, and focuses in its place", () => {
    const { ds, focus } = harness();
    const e = press(10, 10);
    const stopped = vi.spyOn(e, "stopPropagation");
    ds.onCaptureMouseDown(e);
    expect(stopped).toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
    expect(focus).toHaveBeenCalled();
  });

  /* With no mouse mode xterm selects on a plain drag by itself. Stepping in
   * would delay every click in a plain shell to fix nothing. */
  it("keeps out of the way when the agent is not asking for mouse events", () => {
    const { seen, ds, focus } = harness(false);
    const e = press(10, 10);
    const stopped = vi.spyOn(e, "stopPropagation");
    ds.onCaptureMouseDown(e);
    ds.onMouseMove(move(80, 10));
    ds.onMouseUp(release(80, 10));
    expect(stopped).not.toHaveBeenCalled();
    expect(seen).toHaveLength(0);
    expect(focus).not.toHaveBeenCalled();
  });

  it("leaves Option-drag to xterm, which already handles it", () => {
    const { seen, ds } = harness();
    const e = press(10, 10, { altKey: true });
    const stopped = vi.spyOn(e, "stopPropagation");
    ds.onCaptureMouseDown(e);
    expect(stopped).not.toHaveBeenCalled();
    expect(seen).toHaveLength(0);
  });

  it("leaves the right button to the context menu", () => {
    const { seen, ds } = harness();
    const e = press(10, 10, { button: 2 });
    const stopped = vi.spyOn(e, "stopPropagation");
    ds.onCaptureMouseDown(e);
    expect(stopped).not.toHaveBeenCalled();
    expect(seen).toHaveLength(0);
  });

  /* dispatchEvent is synchronous and re-enters the capture listener before it
   * returns, so an unguarded replay would hold its own event and, on the next
   * release, replay that one too, forever. */
  it("does not intercept the events it made itself", () => {
    const { seen, ds } = harness();
    const screen = document.querySelector("div")!;
    screen.addEventListener("mousedown", (e) => ds.onCaptureMouseDown(e as MouseEvent), true);
    ds.onCaptureMouseDown(press(10, 10));
    ds.onMouseUp(release(10, 10));
    expect(seen.map((e) => e.type)).toEqual(["mousedown", "mouseup"]);
  });

  /* Word and line selection contain no drag at all, so waiting for travel
   * would mean they never fired. Nobody double-clicks to send two clicks. */
  it.each([[2, "word"], [3, "line"]])("forces a selection on click %i, for %s selection", (detail) => {
    const { seen, ds } = harness();
    ds.onCaptureMouseDown(press(10, 10, { detail }));
    expect(seen).toHaveLength(1);
    expect(seen[0].altKey).toBe(true);
    expect(seen[0].detail).toBe(detail);
    ds.onMouseUp(release(10, 10));
    expect(seen).toHaveLength(1); // and no click replayed on top of it
  });

  /* THE ONE THAT CRASHED A MAC.
   *
   * The replayed mouseup is dispatched with `bubbles: true`, because xterm's
   * own listeners sit on an ancestor of the screen element. It therefore
   * reaches `window`, which is where the real handler is registered, and
   * re-entered onMouseUp while the held press had not yet been cleared. Each
   * level replayed another click and dispatched another mouseup, so one click
   * on a link opened browser tabs as fast as the stack could recurse.
   *
   * Two independent guards, because either alone would have prevented it and
   * the bug got past a test that only simulated re-entry through mousedown:
   * the module ignores events it made, and it clears its state BEFORE it
   * dispatches anything. */
  it("does not re-enter itself through the mouseup it dispatches", () => {
    const { seen, ds } = harness();
    const screen = document.querySelector("div")!;
    let depth = 0;
    // Exactly how Terminal.tsx wires it: mouseup on window, and the replay
    // bubbles up to it.
    screen.addEventListener("mouseup", (e) => {
      if (++depth > 50) throw new Error("runaway: onMouseUp re-entered itself");
      ds.onMouseUp(e as MouseEvent);
    });
    ds.onCaptureMouseDown(press(10, 10));
    ds.onMouseUp(release(10, 10));
    expect(seen.map((e) => e.type)).toEqual(["mousedown", "mouseup"]);
  });

  it("forgets a held press when the pane goes away mid-gesture", () => {
    const { seen, ds } = harness();
    ds.onCaptureMouseDown(press(10, 10));
    ds.dispose();
    ds.onMouseUp(release(10, 10));
    expect(seen).toHaveLength(0);
  });

  /* A window-drag or a focus loss eats the mouseup. If cancel did not
   * drop the press, the next move would open a selection the user is
   * not making, and the pane would ignore clicks until a stray mouseup. */
  it("cancel drops a held press without replaying it", () => {
    const { seen, ds } = harness();
    ds.onCaptureMouseDown(press(10, 10));
    ds.cancel();
    ds.onMouseMove(move(80, 10));
    ds.onMouseUp(release(80, 10));
    expect(seen).toHaveLength(0);
  });
});
