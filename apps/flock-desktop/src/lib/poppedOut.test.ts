import { describe, expect, it } from "vitest";
import {
  emptyPopoutBook,
  markPoppedOut,
  releasePoppedOut,
  releasePoppedOutMany,
} from "./poppedOut";

const origin = { workspaceId: "borrower", tabId: "borrower-tab" };
const ownerTab = { workspaceId: "owner", tabId: "owner-tab" };

/** The four window-gone paths, against the same book App uses.
 *
 *  The bug this pins: release used to run only when a leaf was re-inserted.
 *  Stray existing never removes a leaf, so a later "return" no-op'd the
 *  insert and left every grid Terminal on visible={false}. */
describe("poppedOut bookkeeping", () => {
  it("stray existing + return (leaf still laid out) unhides without needing an insert", () => {
    // existing-window path: hide the tile, record origin if missing, leave the leaf.
    let book = markPoppedOut(emptyPopoutBook(), "p1", ownerTab, true);
    expect(book.ids.has("p1")).toBe(true);
    expect(book.origins.get("p1")).toEqual(ownerTab);

    // Simulated pane-popout-closed "return": window is gone. Insert would
    // find the leaf still in the owner tab and no-op — release must not wait.
    const released = releasePoppedOut(book, "p1");
    expect(released.book.ids.has("p1")).toBe(false);
    expect(released.origin).toEqual(ownerTab);
    expect(released.book.origins.has("p1")).toBe(false);
  });

  it("existing-window records origin only when it is missing", () => {
    let book = markPoppedOut(emptyPopoutBook(), "p1", origin);
    book = markPoppedOut(book, "p1", ownerTab, true);
    expect(book.origins.get("p1")).toEqual(origin);
    book = markPoppedOut(emptyPopoutBook(), "p1", ownerTab, true);
    expect(book.origins.get("p1")).toEqual(ownerTab);
  });

  it("closed unhides even though there is no leaf to re-insert", () => {
    const book = markPoppedOut(emptyPopoutBook(), "p1", origin);
    const released = releasePoppedOut(book, "p1");
    expect(released.book.ids.has("p1")).toBe(false);
  });

  it("failed insert still unhides — origin is for where, not whether", () => {
    const book = markPoppedOut(emptyPopoutBook(), "p1", origin);
    // Origin's workspace was deleted (borrower gone, owner still shows the tile).
    const { book: next, origin: dest } = releasePoppedOut(book, "p1");
    expect(next.ids.has("p1")).toBe(false);
    expect(dest).toEqual(origin);
    // Caller would look up dest.workspaceId, find nothing, skip insert.
  });

  it("workspace delete unhides every pane whose window we are about to destroy", () => {
    let book = markPoppedOut(emptyPopoutBook(), "p1", origin);
    book = markPoppedOut(book, "p2", ownerTab);
    book = releasePoppedOutMany(book, ["p1", "p2"]);
    expect(book.ids.size).toBe(0);
    expect(book.origins.size).toBe(0);
  });
});
