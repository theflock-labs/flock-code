// One-shot handoff of persisted scrollback from the restore path (App.tsx)
// to the terminal that will render it (Terminal.tsx). Kept out of React state
// so the (potentially large) byte buffers never ride along in re-renders or
// get serialized into saved workspace state. Keyed by the *new* pane id that
// the restored pane was spawned with.

const pending = new Map<string, Uint8Array>();

export function setRestoreHistory(paneId: string, bytes: Uint8Array): void {
  if (bytes.length === 0) return;
  pending.set(paneId, bytes);
  // Auto-expire rather than deleting on read: a restored Terminal mounts once
  // in production, but twice under React StrictMode (mount → unmount → mount),
  // and both must see the history. 20s comfortably covers that, then frees
  // the buffer. A restored pane's Terminal never legitimately remounts later
  // (panes stay mounted across workspace switches), so this can't re-prepend.
  setTimeout(() => pending.delete(paneId), 20000);
}

export function getRestoreHistory(paneId: string): Uint8Array | undefined {
  return pending.get(paneId);
}
