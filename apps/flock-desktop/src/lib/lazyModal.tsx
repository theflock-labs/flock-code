import { lazy, Suspense, type ComponentType } from "react";

/** A lazily-loaded component that also knows how to warm itself. */
export type LazyModal<P> = ComponentType<P> & { preload: () => void };

/**
 * Wrap a dialog in `React.lazy` AND its own `<Suspense>`, so the call site does
 * not change at all — `<SettingsDialog ... />` still reads as a component.
 *
 * The per-modal boundary is the whole point. `React.lazy` needs a `Suspense`
 * somewhere above it, and the obvious move — one boundary near the root — is
 * wrong here: a root boundary with `fallback={null}` unmounts the ENTIRE app
 * for as long as any one chunk is resolving. Opening Settings would blank the
 * cockpit, terminals included, and xterm instances do not survive being
 * unmounted (panes are kept mounted and merely hidden for exactly this
 * reason). A boundary per modal
 * suspends only the modal.
 *
 * `fallback={null}` rather than a spinner: these chunks come off local disk in
 * a few milliseconds, and a spinner that flashes for two frames is worse than
 * nothing appearing for two frames.
 *
 * WHY ANY OF THIS. Seventeen dialogs were imported statically by App.tsx and
 * therefore parsed, evaluated and kept resident at launch whether or not the
 * user ever opened one. That included SettingsDialog (1,305 lines) and the
 * stats modals, which pull recharts and lodash behind them — a charting library
 * loaded before the first frame of an app whose first frame has no charts in it.
 */
export function lazyModal<P extends object>(
  load: () => Promise<{ default: ComponentType<P> }>,
): LazyModal<P> {
  // `lazy()` widens its result in a way that loses the prop type through a
  // spread, so the component is narrowed back to what it actually is. The
  // call-site types come from `P`, which is inferred from the loader — so a
  // wrong prop at a call site is still a compile error.
  const Inner = lazy(load) as unknown as ComponentType<P>;
  const Wrapped = (props: P) => (
    <Suspense fallback={null}>
      <Inner {...props} />
    </Suspense>
  );
  // Fire-and-forget. A failed warm is not an error: the real render path calls
  // the same loader again and its rejection is the one that should surface.
  (Wrapped as LazyModal<P>).preload = () => { void load().catch(() => {}); };
  return Wrapped as LazyModal<P>;
}

/**
 * Warm a set of modals once the app is idle.
 *
 * Splitting a dialog trades startup work for a delay at open time, and for most
 * of them that trade is free — nobody notices 4ms when they chose to open
 * Settings. But a command palette on ⌘K and the push-to-talk overlay are
 * different: those are reflexes, and a chunk fetch inside the keystroke is
 * exactly the kind of stutter this change is supposed to remove. So the
 * latency-sensitive ones are fetched during the first idle window instead —
 * after the shell has painted and the panes have spawned, which is the part
 * that was actually competing for startup time.
 */
export function preloadWhenIdle(modals: Array<{ preload: () => void }>) {
  const run = () => modals.forEach((m) => m.preload());
  const ric = (globalThis as any).requestIdleCallback as
    | ((cb: () => void, opts?: { timeout: number }) => number)
    | undefined;
  if (ric) ric(run, { timeout: 4000 });
  else setTimeout(run, 2000);
}
