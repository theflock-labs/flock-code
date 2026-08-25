// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import DiffModal from "./DiffModal";
import { resetAllReviews } from "../lib/diffAnnotations";

// The annotation flow is only worth anything end to end: a note that can't be
// clicked into existence, or that dies when the modal is dismissed, or that
// reaches the agent as the wrong line, is worse than no note. So this drives
// the real DiffView inside the real DiffModal — the modal matters, because its
// window-capture Esc handler is the thing the composer has to survive.

vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: vi.fn(() => Promise.resolve()) }));

const DIFF = [
  "diff --git a/src/foo.ts b/src/foo.ts",
  "index 1111111..2222222 100644",
  "--- a/src/foo.ts",
  "+++ b/src/foo.ts",
  "@@ -1,3 +1,4 @@",
  " export function foo() {",
  "-  return 1;",
  "+  const x = 1;",
  "+  return x;",
  " }",
  "",
].join("\n");

const onSend = vi.fn();
const onClose = vi.fn();

function open(reviewKey = "working:/repo") {
  return render(
    <DiffModal
      eyebrow="WORKING TREE"
      title="main"
      load={() => Promise.resolve(DIFF)}
      onClose={onClose}
      review={{
        reviewKey,
        title: "the working tree",
        targets: [{ id: "pane-1", label: "Pluto" }, { id: "pane-2", label: "Nova" }],
        defaultTargetId: "pane-1",
        onSend,
      }}
    />,
  );
}

/** Mount and let the (already-resolved) diff load settle. */
async function opened(reviewKey?: string) {
  const view = open(reviewKey);
  await act(async () => {});
  return view;
}

const comment = (label: string, init?: MouseEventInit) =>
  fireEvent.click(screen.getByLabelText(label), init);

const write = (text: string) =>
  fireEvent.change(screen.getByPlaceholderText("What should the agent change here?"), {
    target: { value: text },
  });

beforeEach(() => {
  resetAllReviews();
  onSend.mockClear();
  onClose.mockClear();
  // jsdom has no layout, so DiffView's scroll-spy plumbing needs a stub.
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

describe("annotating a diff", () => {
  it("turns a clicked line into a note and sends it as a prompt", async () => {
    await opened();
    comment("Comment on line 2"); // the added `const x = 1;`
    write("use a const, not a let");
    fireEvent.click(screen.getByText("add note"));

    expect(screen.getByText("use a const, not a let")).toBeTruthy();
    expect(screen.getByText("1 note")).toBeTruthy();

    fireEvent.click(screen.getByText("Send to agent"));
    expect(onSend).toHaveBeenCalledTimes(1);
    const [paneId, prompt] = onSend.mock.calls[0];
    expect(paneId).toBe("pane-1");
    expect(prompt).toBe([
      "Review notes on the working tree — 1 comment across 1 file. " +
      "Please address each one; if a note is ambiguous, ask before changing anything.",
      "",
      "src/foo.ts",
      "  1. line 2",
      "     +   const x = 1;",
      "     note: use a const, not a let",
    ].join("\n"));
  });

  // The reviewer is meant to read the prompt in the pane before pressing
  // enter, so the review is spent once it's been handed over.
  it("empties the review after sending", async () => {
    await opened();
    comment("Comment on line 2");
    write("note");
    fireEvent.click(screen.getByText("add note"));
    fireEvent.click(screen.getByText("Send to agent"));
    expect(screen.queryByText("Send to agent")).toBeNull();
    expect(screen.queryByText("note")).toBeNull();
  });

  it("stretches one note over a shift-clicked range, quoting every line", async () => {
    await opened();
    comment("Comment on removed line 2"); // the deletion
    comment("Comment on line 3", { shiftKey: true }); // down to `return x;`
    write("keep the early return");
    fireEvent.click(screen.getByText("add note"));
    fireEvent.click(screen.getByText("Send to agent"));

    const prompt: string = onSend.mock.calls[0][1];
    expect(prompt).toContain("  1. lines 2-3");
    expect(prompt).toContain("     -   return 1;");
    expect(prompt).toContain("     +   const x = 1;");
    expect(prompt).toContain("     +   return x;");
  });

  it("sends to the picked agent rather than the default", async () => {
    await opened();
    comment("Comment on line 1");
    write("rename this");
    fireEvent.click(screen.getByText("add note"));
    fireEvent.change(screen.getByLabelText("Agent to send the review to"), { target: { value: "pane-2" } });
    fireEvent.click(screen.getByText("Send to agent"));
    expect(onSend.mock.calls[0][0]).toBe("pane-2");
  });

  it("numbers a deletion by the old file and says so", async () => {
    await opened();
    comment("Comment on removed line 2");
    write("this was load-bearing");
    fireEvent.click(screen.getByText("add note"));
    fireEvent.click(screen.getByText("Send to agent"));
    expect(onSend.mock.calls[0][1]).toContain("  1. line 2 (before the change)");
  });

  it("drops a note again", async () => {
    await opened();
    comment("Comment on line 2");
    write("never mind");
    fireEvent.click(screen.getByText("add note"));
    fireEvent.click(screen.getByLabelText("Remove this note"));
    expect(screen.queryByText("never mind")).toBeNull();
    expect(screen.queryByText("Send to agent")).toBeNull();
  });
});

describe("what the review has to survive", () => {
  // DiffModal listens for Esc on window in the capture phase, so without the
  // composer's own capture listener the first Esc closes the whole modal and
  // takes the half-written note with it.
  it("lets Esc close the composer without closing the modal", async () => {
    await opened();
    comment("Comment on line 2");
    const box = screen.getByPlaceholderText("What should the agent change here?");
    fireEvent.keyDown(box, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByPlaceholderText("What should the agent change here?")).toBeNull();
  });

  it("still closes the modal on Esc once no composer is open", async () => {
    await opened();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // The notes live in a module store keyed by the checkout, not in DiffView's
  // state, so dismissing the modal by reflex costs nothing.
  it("keeps saved notes across a full unmount and reopen", async () => {
    const view = await opened();
    comment("Comment on line 2");
    write("still here?");
    fireEvent.click(screen.getByText("add note"));
    view.unmount();

    await opened();
    expect(screen.getByText("still here?")).toBeTruthy();
    expect(screen.getByText("1 note")).toBeTruthy();
  });

  it("keeps a different checkout's review separate", async () => {
    const view = await opened("working:/repo");
    comment("Comment on line 2");
    write("only for this checkout");
    fireEvent.click(screen.getByText("add note"));
    view.unmount();

    await opened("working:/other");
    expect(screen.queryByText("only for this checkout")).toBeNull();
  });

  it("commits the composer on cmd-enter, and keeps plain enter as a newline", async () => {
    await opened();
    comment("Comment on line 2");
    const box = screen.getByPlaceholderText("What should the agent change here?");
    fireEvent.change(box, { target: { value: "first line" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(screen.getByPlaceholderText("What should the agent change here?")).toBeTruthy();
    fireEvent.keyDown(box, { key: "Enter", metaKey: true });
    expect(screen.queryByPlaceholderText("What should the agent change here?")).toBeNull();
    expect(screen.getByText("first line")).toBeTruthy();
  });
});

describe("a diff with no agent to send to", () => {
  it("says so instead of offering a dead send button", async () => {
    render(
      <DiffModal
        eyebrow="WORKING TREE"
        title="main"
        load={() => Promise.resolve(DIFF)}
        onClose={onClose}
        review={{ reviewKey: "working:/repo", targets: [], onSend }}
      />,
    );
    await act(async () => {});
    comment("Comment on line 2");
    write("nobody is listening");
    fireEvent.click(screen.getByText("add note"));
    expect(screen.getByText("no agent is running in this checkout")).toBeTruthy();
    expect(screen.getByText("Send to agent").hasAttribute("disabled")).toBe(true);
  });
});
