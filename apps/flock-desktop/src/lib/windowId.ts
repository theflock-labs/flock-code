// This window's identity, and nothing else.
//
// It lived in lib/presence.ts, which is the correct *conceptual* home — the id
// exists to tell two windows of the same account apart on the presence channel
// — and the wrong physical one. presence.ts imports the Ably SDK, so every
// static importer of MY_WINDOW_ID dragged the whole realtime client into
// whatever chunk it landed in. Sidebar.tsx needs the id to filter itself out of
// its own friends list and imports it at module scope, and Sidebar is on the
// startup path, so App.tsx's `await import("./lib/presence")` could never
// actually split: vite said so on every build ("dynamically imported by
// App.tsx ... but also statically imported by Sidebar.tsx").
//
// A uuid has no dependencies. Keeping it in a file that has none either is what
// makes the dynamic import in App.tsx mean something.
//
// Cached on globalThis so a Vite hot-reload does not mint a new id and make the
// window look like a second one to everybody else on the channel.

export const MY_WINDOW_ID: string = (globalThis as any).__flock_window_id
  ?? ((globalThis as any).__flock_window_id = crypto.randomUUID());
