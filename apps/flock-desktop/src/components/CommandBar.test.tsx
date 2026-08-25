// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import CommandBar, { type Command } from "./CommandBar";

function cmd(over: Partial<Command> & { id: string; label: string }): Command {
  return { group: "Agents", run: () => {}, ...over };
}

const base: Command[] = [
  cmd({ id: "a", label: "Settings", group: "App" }),
  cmd({ id: "b", label: "New workspace", group: "Start" }),
  cmd({ id: "c", label: "Hazel", group: "Agents", hint: "src-tauri" }),
  cmd({
    id: "d",
    label: "Ozzy is waiting on you",
    group: "Needs you",
    hint: "flock-code",
    attention: true,
  }),
];

const rows = () => screen.getAllByRole("button").map((el) => el.textContent);

const type = (value: string) =>
  fireEvent.change(screen.getByPlaceholderText("What should happen?"), { target: { value } });

describe("CommandBar", () => {
  afterEach(cleanup);

  it("renders nothing while closed", () => {
    const { container } = render(<CommandBar open={false} onClose={() => {}} commands={base} />);
    expect(container.firstChild).toBeNull();
  });

  /* The whole reason the palette exists: on an empty query the first row is
   * whoever is blocked, not whatever happens to be first in the array. */
  it("floats an agent that needs input above everything on an empty query", () => {
    render(<CommandBar open onClose={() => {}} commands={base} />);
    expect(rows()[0]).toContain("Ozzy is waiting on you");
  });

  /* And it stays there while you type something that matches other rows
   * better, because an attention row is a message rather than a search hit. */
  it("keeps the attention row first even when the query matches others better", () => {
    render(<CommandBar open onClose={() => {}} commands={base} />);
    fireEvent.change(screen.getByPlaceholderText("What should happen?"), {
      target: { value: "s" },
    });
    expect(rows()[0]).toContain("Ozzy is waiting on you");
  });

  it("matches a subsequence, not just a substring", () => {
    render(<CommandBar open onClose={() => {}} commands={base} />);
    fireEvent.change(screen.getByPlaceholderText("What should happen?"), {
      target: { value: "nwk" }, // n-e-W  W-or-K-space
    });
    expect(rows().some((r) => r?.includes("New workspace"))).toBe(true);
  });

  it("matches on the hint, so an agent is findable by its workspace", () => {
    render(<CommandBar open onClose={() => {}} commands={base} />);
    fireEvent.change(screen.getByPlaceholderText("What should happen?"), {
      target: { value: "src-tauri" },
    });
    expect(rows().some((r) => r?.includes("Hazel"))).toBe(true);
  });

  it("runs the row under the cursor on Enter and closes first", () => {
    const order: string[] = [];
    const onClose = vi.fn(() => order.push("close"));
    const commands = [cmd({ id: "x", label: "Only", run: () => order.push("run") })];
    render(<CommandBar open onClose={onClose} commands={commands} />);
    const input = screen.getByPlaceholderText("What should happen?");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onClose).toHaveBeenCalled();
    // run() is deferred a frame so a command that opens a dialog is not racing
    // the palette's teardown for focus. Only the ordering is asserted here.
    expect(order[0]).toBe("close");
  });

  it("moves the cursor with the arrow keys", () => {
    render(<CommandBar open onClose={() => {}} commands={base} />);
    const input = screen.getByPlaceholderText("What should happen?");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const selected = document.querySelectorAll(".cmdk-row.sel");
    expect(selected).toHaveLength(1);
    expect(selected[0].textContent).not.toContain("Ozzy is waiting on you");
  });

  /* Score order interleaved groups, so the list rendered Start, Review, Start,
   * Review and printed four headers for two groups. Every group must be
   * contiguous and named exactly once. */
  it("draws each group once, with its rows contiguous", () => {
    const many: Command[] = [
      cmd({ id: "s1", label: "New agent here", group: "Start" }),
      cmd({ id: "r1", label: "Show uncommitted changes", group: "Review" }),
      cmd({ id: "s2", label: "New workspace", group: "Start" }),
      cmd({ id: "r2", label: "Pull requests", group: "Review" }),
    ];
    render(<CommandBar open onClose={() => {}} commands={many} />);
    const headers = Array.from(document.querySelectorAll(".cmdk-group")).map(
      (el) => el.textContent,
    );
    expect(headers).toEqual([...new Set(headers)]);
    expect(headers).toHaveLength(2);
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(<CommandBar open onClose={onClose} commands={base} />);
    fireEvent.keyDown(screen.getByPlaceholderText("What should happen?"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  /* A query that matches nothing must not leave the previous results on
   * screen, which is what a stale cursor clamp used to do. */
  it("says so when nothing matches", () => {
    render(<CommandBar open onClose={() => {}} commands={base} />);
    type("zzzzzz");
    expect(screen.getByText(/Nothing matches that/)).toBeTruthy();
  });
});

// ─── Prompt mode ─────────────────────────────────────────────────────────────
//
// The reason to press ⌘K rather than click the button that does the same
// thing. Every verb in the list is also one click away; handing a phrase to an
// agent is not available anywhere else on the keyboard.

const sent: string[] = [];
const promptActions = (text: string): Command[] => [
  cmd({ id: `send:hazel`, label: "Hazel", group: "Send to", run: () => sent.push(`hazel:${text}`) }),
  cmd({ id: `send:new`, label: "A new agent here", group: "Send to", run: () => sent.push(`new:${text}`) }),
];

describe("CommandBar prompt mode", () => {
  afterEach(() => { cleanup(); sent.length = 0; });

  /* One word is a command search. A phrase is something you want to say — and
   * the command matches are kept, never replaced, so a query that does mean a
   * command never loses it. */
  it("offers agents once the query is a phrase, without dropping commands", () => {
    render(<CommandBar open onClose={() => {}} commands={base} promptActions={promptActions} />);
    type("new workspace");
    const r = rows();
    expect(r.some((x) => x?.includes("New workspace"))).toBe(true);
    expect(r.some((x) => x?.includes("A new agent here"))).toBe(true);
  });

  it("does not offer agents for a single word", () => {
    render(<CommandBar open onClose={() => {}} commands={base} promptActions={promptActions} />);
    type("settings");
    expect(rows().some((x) => x?.includes("A new agent here"))).toBe(false);
  });

  /* `>` is the escape hatch for a phrase that would otherwise rank as a
   * command — and it suppresses the command list entirely, because it is an
   * explicit statement of intent. */
  it("forces prompt mode with a leading >", () => {
    render(<CommandBar open onClose={() => {}} commands={base} promptActions={promptActions} />);
    type(">settings");
    const r = rows();
    expect(r.some((x) => x?.includes("Hazel"))).toBe(true);
    expect(r.some((x) => x === "Settings")).toBe(false);
  });

  it("passes the typed text, without the > marker, to the target", async () => {
    render(<CommandBar open onClose={() => {}} commands={[]} promptActions={promptActions} />);
    type("> fix the flaky resize test ");
    fireEvent.click(screen.getByText("Hazel"));
    // run() is deferred a frame so a command that opens a dialog is not racing
    // the palette's teardown for focus.
    await waitFor(() => expect(sent).toEqual(["hazel:fix the flaky resize test"]));
  });

  /* The contract for the Enter key, stated on the surface. "Sends to the
   * agent" and "types into the agent" are different promises and only one of
   * them is safe to make about text the user has not re-read. */
  it("states that the prompt is injected rather than submitted", () => {
    render(<CommandBar open onClose={() => {}} commands={base} promptActions={promptActions} />);
    type("fix the resize test");
    expect(screen.getByText(/you still press enter yourself/)).toBeTruthy();
  });

  it("shows no such footer when the palette is being used as a menu", () => {
    render(<CommandBar open onClose={() => {}} commands={base} promptActions={promptActions} />);
    type("settings");
    expect(screen.queryByText(/you still press enter yourself/)).toBeNull();
  });
});

// ─── Explaining itself ───────────────────────────────────────────────────────

describe("CommandBar match feedback", () => {
  afterEach(cleanup);

  it("highlights the characters it matched in the label", () => {
    render(<CommandBar open onClose={() => {}} commands={base} />);
    type("work");
    const hit = document.querySelector(".cmdk-hit");
    expect(hit?.textContent).toBe("work");
  });

  /* Typing "cl" used to surface four agent names whose rows contained no c and
   * no l anywhere — matched on the hidden keyword "claude", with nothing on
   * screen saying so. The list looked broken at the moment it was working. */
  it("names the hidden word when the match was not in the label", () => {
    const withKeyword = [cmd({ id: "z", label: "Hazel", keywords: "claude" })];
    render(<CommandBar open onClose={() => {}} commands={withKeyword} />);
    type("claude");
    expect(document.querySelector(".cmdk-note")?.textContent).toBe("claude");
  });

  it("shows what an agent is doing, so the row is not poorer than the sidebar", () => {
    const withDetail = [cmd({ id: "z", label: "Hazel", detail: "working · fix the resize test" })];
    render(<CommandBar open onClose={() => {}} commands={withDetail} />);
    expect(screen.getByText("working · fix the resize test")).toBeTruthy();
  });
});
