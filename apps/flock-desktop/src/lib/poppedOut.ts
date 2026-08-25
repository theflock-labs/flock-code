// Live pane-${id} pop-out windows, and where each one should fold back.
//
// poppedOutIds is "is the window live?", not "did we pull a leaf out of a
// tab?". popOutPane removes the leaf only from the tab you clicked, so a
// borrowed pane's other workspace still lays that id out — and the stray
// existing-window path never removes a leaf at all. Grid Terminals treat
// these ids like hidden so they cannot fight the pop-out on resizePty.
//
// Origin is only *where* to re-insert. Clearing the id must not wait on a
// successful insert: the window-is-gone event always fires, and a no-op
// insert (leaf still in the owner tab, origin's workspace already deleted)
// is the common return after those paths.

export interface PopoutOrigin {
  workspaceId: string;
  tabId: string;
}

export interface PopoutBook {
  ids: ReadonlySet<string>;
  origins: Map<string, PopoutOrigin>;
}

export function emptyPopoutBook(): PopoutBook {
  return { ids: new Set(), origins: new Map() };
}

/** Record a live pane-${id} window. `onlyIfMissing` keeps a first origin
 *  (the tab that originally popped) when a later click just focuses a
 *  stray existing window from a different tab. */
export function markPoppedOut(
  book: PopoutBook,
  paneId: string,
  origin?: PopoutOrigin,
  onlyIfMissing = false,
): PopoutBook {
  if (origin && !(onlyIfMissing && book.origins.has(paneId))) {
    book.origins.set(paneId, origin);
  }
  if (book.ids.has(paneId)) return book;
  const ids = new Set(book.ids);
  ids.add(paneId);
  return { ids, origins: book.origins };
}

/** The window is gone. Always unhide every grid Terminal for this id.
 *  Returns the origin so the caller can try to re-insert — insert success
 *  must not gate this. */
export function releasePoppedOut(book: PopoutBook, paneId: string): {
  book: PopoutBook;
  origin: PopoutOrigin | undefined;
} {
  const origin = book.origins.get(paneId);
  book.origins.delete(paneId);
  if (!book.ids.has(paneId)) return { book, origin };
  const ids = new Set(book.ids);
  ids.delete(paneId);
  return { book: { ids, origins: book.origins }, origin };
}

/** Windows we are about to destroy (owner workspace going away). */
export function releasePoppedOutMany(book: PopoutBook, paneIds: Iterable<string>): PopoutBook {
  let next = book;
  for (const id of paneIds) next = releasePoppedOut(next, id).book;
  return next;
}
