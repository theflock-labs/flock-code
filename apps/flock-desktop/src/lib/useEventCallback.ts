import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * A callback with a permanently stable identity that always runs the newest
 * closure.
 *
 * WHY THIS EXISTS, because "just use useCallback" is the obvious answer and is
 * the wrong one here.
 *
 * Sidebar and PaneArea are both wrapped in `React.memo`. Between them App.tsx
 * passes 54 handler props, and — measured, not guessed — *none* of them had a
 * stable identity: 9 were inline arrows written at the call site and the other
 * 45 were plain `const foo = (...) => {}` declarations inside the component
 * body, which React re-creates on every render. `memo` compares props, finds a
 * fresh function on every one of them, and re-renders. So the memo did nothing
 * except add a failed comparison — and PaneArea is rendered once per workspace
 * and every workspace stays mounted (hidden, never unmounted, so terminals
 * survive switches), so a single `setState` anywhere in a 5,300-line component
 * re-rendered every pane header, branch chip and context meter in every open
 * workspace.
 *
 * `useCallback` would fix the identity and introduce a worse problem: 45
 * hand-written dependency arrays over a component with 27 pieces of state. A
 * missing dep there is a stale closure — a handler that acts on a workspace
 * list from three renders ago — and that is a data-corruption bug, not a
 * rendering one. It is exactly the trade this app should not take.
 *
 * The ref-latest pattern has no dependency array to get wrong. The returned
 * function is created once and never changes; it forwards to a ref that is
 * repointed at the fresh closure after every commit. Callers always run the
 * newest code, `memo` always sees the same identity.
 *
 * This is React's own `useEffectEvent` proposal, written out by hand until it
 * ships.
 *
 * THE ONE RULE: do not call the returned function during render. Between a
 * render and its commit the ref still points at the previous closure, so a
 * render-phase call reads stale state. Event handlers, effects and timers all
 * run after commit and are safe — which covers every handler prop in this app.
 */
export function useEventCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  // useLayoutEffect, not useEffect: it flushes before the browser paints, so a
  // handler fired from a layout effect in a child (a ResizeObserver-driven fit,
  // for instance) already sees this render's closure rather than the last one.
  useLayoutEffect(() => {
    ref.current = fn;
  });
  return useCallback((...args: A) => ref.current(...args), []);
}
