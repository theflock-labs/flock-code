// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, screen, act, fireEvent } from "@testing-library/react";
import RaceDialog from "./RaceDialog";

// The two things this dialog must not get wrong: starting a race with no
// prompt (N agents spawned with nothing to do, N worktrees to clean up), and
// swallowing a newline in a prompt that is normally several lines long.

function show(over: Partial<Parameters<typeof RaceDialog>[0]> = {}) {
  const onConfirm = vi.fn();
  render(
    <RaceDialog defaultKind="claude" baseLabel="main" onConfirm={onConfirm} onCancel={() => {}} {...over} />,
  );
  return { onConfirm };
}

const type = (text: string) =>
  fireEvent.change(screen.getByLabelText(/Prompt/), { target: { value: text } });

afterEach(cleanup);

describe("RaceDialog", () => {
  it("won't start a race with nothing to ask", () => {
    show();
    expect((screen.getByRole("button", { name: /Race 3 agents/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("hands back the trimmed prompt, the agent, and the count", async () => {
    const { onConfirm } = show();
    type("  Keep the user signed in  ");
    await act(async () => { (document.querySelectorAll(".sd-layout")[4] as HTMLElement).click(); });
    await act(async () => { screen.getByRole("button", { name: /Race 6 agents/ }).click(); });
    expect(onConfirm).toHaveBeenCalledWith("claude", 6, "Keep the user signed in");
  });

  // Enter is a newline here, not submit — a race prompt is a paragraph. ⌘⏎ is
  // the chord every agent CLI already uses for "send this".
  it("submits on ⌘⏎ and never on a bare Enter", async () => {
    const { onConfirm } = show();
    type("Keep the user signed in");
    await act(async () => { fireEvent.keyDown(window, { key: "Enter" }); });
    expect(onConfirm).not.toHaveBeenCalled();
    await act(async () => { fireEvent.keyDown(window, { key: "Enter", metaKey: true }); });
    expect(onConfirm).toHaveBeenCalledWith("claude", 3, "Keep the user signed in");
  });

  // The dialog opens with the textarea focused, so the chord's real path runs
  // through the textarea's own keydown — which stops propagation of everything
  // else so typing can't trip a global shortcut. It must let ⌘⏎ through, or
  // the advertised submit chord is dead in the dialog's default focus state.
  it("submits on ⌘⏎ typed inside the prompt textarea", async () => {
    const { onConfirm } = show();
    type("Keep the user signed in");
    const textarea = screen.getByLabelText(/Prompt/);
    await act(async () => { fireEvent.keyDown(textarea, { key: "Enter" }); });
    expect(onConfirm).not.toHaveBeenCalled();
    await act(async () => { fireEvent.keyDown(textarea, { key: "Enter", metaKey: true }); });
    expect(onConfirm).toHaveBeenCalledWith("claude", 3, "Keep the user signed in");
  });

  it("names the branches it is about to create before they exist", () => {
    show();
    type("Keep the user signed in");
    expect(document.querySelector(".sd-branch-hint")?.textContent)
      .toContain("race-keep-the-user-signed-in-<agent>");
  });

});
