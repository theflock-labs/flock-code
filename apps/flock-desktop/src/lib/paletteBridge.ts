// ⌘K from a popped-out agent window.
//
// A popped-out pane is its own webview (PoppedPaneWindow) and never sees the
// cockpit's keydown handler, so ⌘K did nothing there — you had to find the main
// window with the mouse first, which is precisely the thing a command bar
// exists to avoid.
//
// The palette itself cannot usefully live in that second window: every command
// it offers acts on the cockpit's state (workspaces, tabs, layout), and a
// second copy would need that whole tree mirrored across webviews. So the
// popped window *summons* — it asks the cockpit to open its palette and take
// focus.
//
// The wire is a `storage` write, the same mechanism lib/uiScale.ts uses to push
// a text-size change between webviews: `storage` fires only in the *other*
// documents on the origin, which is exactly the delivery this needs and is
// something CustomEvents cannot do across windows. The value is a timestamp
// rather than a flag, so two summons in a row are two distinct writes and the
// second one still fires.

const KEY = "flock:cmdk-summon";

/** Ask the cockpit window to open its command bar. Safe to call from any
 *  webview; a no-op in the cockpit itself, which does not hear its own writes. */
export function summonPalette(): void {
  try {
    localStorage.setItem(KEY, String(Date.now()));
  } catch { /* private mode / quota — the shortcut degrades to doing nothing */ }
}

/** Cockpit side. Returns an unsubscribe fn. */
export function onPaletteSummon(handler: () => void): () => void {
  const listener = (e: StorageEvent) => {
    if (e.key === KEY && e.newValue !== null) handler();
  };
  window.addEventListener("storage", listener);
  return () => window.removeEventListener("storage", listener);
}
