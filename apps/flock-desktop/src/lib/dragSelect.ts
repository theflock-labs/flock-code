// Plain drag selects text in a pane, with no modifier held.
//
// THE PROBLEM. Agents run with mouse reporting on, because `?1000` is what
// carries the WHEEL (see the CLAUDE_CODE_NO_FLICKER / DISABLE_MOUSE_CLICKS
// pair in spawn_pane, and the 0.7.30 regression where dropping it turned
// scrolling into prompt-history navigation). While an app is in mouse mode
// xterm hands every left-button press straight to it and never starts a
// selection, so a plain drag did nothing at all. xterm's only escape hatch is
// `macOptionClickForcesSelection`, which is a modifier, and "hold Option to
// copy the thing on your screen" is not something a terminal should ask.
//
// THE ARBITRATION. A press is ambiguous: it might become a drag, which the
// user wants to select, or stay a click, which the agent wants to receive.
// Nothing can tell the two apart at mousedown, so this holds the press instead
// of guessing, and decides once the answer is known:
//
//   press            swallowed, remembered, not shown to anyone yet
//   moved past N px  synthesised as a mousedown WITH altKey, so xterm takes it
//                    as a forced selection anchored at the original cell
//   released in place  replayed unmodified, press then release, so the agent
//                    gets the click it would have got
//
// The cost is that a click reaches the agent on mouse-UP rather than mouse-
// down. That is a few milliseconds on a gesture nobody times, and it is the
// entire price of not having to hold a modifier.
//
// WHY SYNTHETIC EVENTS RATHER THAN A FORK OF XTERM. The decision this works
// around lives in xterm's SelectionService: on macOS it starts a selection
// only when `altKey && macOptionClickForcesSelection`. It is not configurable
// and there is no API for "select even though the app wants mouse events".
// Handing it an event that satisfies its own condition is the smallest lie
// that gets the right behaviour, and it keeps xterm doing all the actual
// selection work: hit testing, cell snapping, autoscroll, word and line
// expansion on double and triple click.

export interface DragSelectHost {
  /** The element xterm binds its mouse listeners to (`.xterm-screen`). Read
   *  lazily because it does not exist until `term.open()` has run. */
  screen(): HTMLElement | null;
  /** Whether the agent currently has mouse reporting on. When it does not,
   *  xterm selects on a plain drag by itself and this must not interfere. */
  mouseReporting(): boolean;
  /** Focus the terminal. We swallow the press that would otherwise have done
   *  it, so clicking an unfocused pane has to keep working. */
  focus(): void;
  /** Pixels of travel before a press counts as a drag. */
  threshold?: number;
}

export interface DragSelect {
  onCaptureMouseDown(e: MouseEvent): void;
  onMouseMove(e: MouseEvent): void;
  onMouseUp(e: MouseEvent): void;
  cancel(): void;
  dispose(): void;
}

/** Events this module made, so its own capture handler ignores them.
 *  A WeakSet rather than a flag: dispatchEvent is synchronous and re-enters
 *  the capture listener before the dispatching call returns, so a flag would
 *  have to be set and cleared around every dispatch and would be wrong the
 *  first time someone added one and forgot. */
const MINE = new WeakSet<Event>();

function copyMouseEvent(source: MouseEvent, type: string, altKey: boolean): MouseEvent {
  return new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    // No `view`. Nothing on the receiving side reads it, and passing a Window
    // across realms is exactly the sort of thing that throws in one embedder
    // and not another.
    clientX: source.clientX,
    clientY: source.clientY,
    screenX: source.screenX,
    screenY: source.screenY,
    button: source.button,
    buttons: type === "mouseup" ? 0 : 1,
    detail: source.detail,
    altKey,
    shiftKey: source.shiftKey,
    ctrlKey: source.ctrlKey,
    metaKey: source.metaKey,
  });
}

export function createDragSelect(host: DragSelectHost): DragSelect {
  const threshold = host.threshold ?? 4;
  let pending: MouseEvent | null = null;
  let dragging = false;

  const send = (e: MouseEvent) => {
    MINE.add(e);
    host.screen()?.dispatchEvent(e);
  };

  return {
    onCaptureMouseDown(e) {
      if (MINE.has(e)) return;
      // Left button only. A right-click is the context menu's, and a middle
      // click is paste on some setups; neither is ever a selection.
      if (e.button !== 0) return;
      // Option held is the existing forced-selection path, which xterm handles
      // itself. Intercepting it would replace a working gesture with a copy of
      // itself for no gain.
      if (e.altKey) return;
      // No mouse mode means xterm already selects on a plain drag. Stepping in
      // here would delay every click in a plain shell for nothing.
      if (!host.mouseReporting()) return;

      pending = e;
      // A second or third click is unambiguous the moment it arrives: nobody
      // double-clicks to send an agent two clicks. Forced through immediately
      // rather than waiting for travel, because word and line selection are
      // gestures with no drag in them at all and waiting would mean they never
      // fire. xterm does the word and line expansion from `detail`, which is
      // copied across.
      dragging = e.detail >= 2;
      // Capture phase, so this runs before xterm's own listeners further down
      // the tree and they never see the press.
      e.stopPropagation();
      // preventDefault would also suppress the focus this press should give
      // the pane, so focus explicitly instead of relying on the default.
      e.preventDefault();
      host.focus();
      if (dragging) send(copyMouseEvent(e, "mousedown", true));
    },

    onMouseMove(e) {
      if (MINE.has(e)) return;
      if (!pending || dragging) return;
      if (Math.hypot(e.clientX - pending.clientX, e.clientY - pending.clientY) < threshold) return;
      dragging = true;
      // Anchored at the ORIGINAL press, not at the current position: the user
      // began selecting where they pressed, and starting from wherever the
      // pointer had reached by the time we made up our mind would drop the
      // first few characters of every selection.
      send(copyMouseEvent(pending, "mousedown", true));
    },

    onMouseUp(e) {
      // The replay below is dispatched with `bubbles: true`, because xterm's
      // own listeners sit on an ancestor of the screen element. So it reaches
      // `window`, which is exactly where this handler is registered.
      if (MINE.has(e)) return;
      // State cleared BEFORE anything is dispatched, so a re-entrant call
      // finds nothing held and does nothing, rather than replaying the same
      // click and dispatching another mouseup that re-enters again. That
      // recursion opened a browser tab per level, as fast as the stack could
      // grow. Both this and the guard above independently prevent it; the bug
      // shipped because the only re-entrancy test went through mousedown.
      const held = pending;
      const wasDrag = dragging;
      pending = null;
      dragging = false;
      if (held && !wasDrag) {
        // It was a click after all. Replay it whole, in order, unmodified, so
        // the agent sees exactly the gesture the user made.
        send(copyMouseEvent(held, "mousedown", false));
        send(copyMouseEvent(e, "mouseup", false));
      }
    },

    dispose() {
      pending = null;
      dragging = false;
    },

    /** Drop a held press without replaying it. The mouseup that would have
     *  settled the gesture never arrives if the window loses focus, the
     *  pointer is cancelled (a native window-drag stole it), or the pane
     *  hides. Leaving `pending` set means the next move is treated as the
     *  tail of a drag the user is no longer making, and the pane looks
     *  frozen until a later mouseup happens to land. */
    cancel() {
      pending = null;
      dragging = false;
    },
  };
}
