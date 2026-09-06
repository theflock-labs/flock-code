// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import OnboardingDialog from "./OnboardingDialog";
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
afterEach(cleanup);

describe("onboarding entry points", () => {
  it("opens first-agent setup from a single introduction", () => {
    const start = vi.fn();
    render(<OnboardingDialog onDone={vi.fn()} onStart={start} />);
    expect(screen.getByRole("dialog", { name: "Welcome to flock" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Set up my first agent" }));
    expect(start).toHaveBeenCalledTimes(1);
  });
  it("preserves the optional tour and teaches the current branch controls", () => {
    render(<OnboardingDialog mode="tour" onDone={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText(/Choose New branch in Customize/)).toBeTruthy();
    expect(screen.queryByText(/Turn on.*separate worktrees/)).toBeNull();
  });
  it("allows Escape to leave the intro", () => {
    const done = vi.fn();
    render(<OnboardingDialog onDone={done} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(done).toHaveBeenCalledTimes(1);
  });
});
