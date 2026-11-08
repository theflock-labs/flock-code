// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ClaudeUsage } from "../lib/tauri";

const usage = vi.hoisted(() => ({ claude: null as ClaudeUsage | null, codex: null as ClaudeUsage | null }));
vi.mock("../lib/tauri", () => ({ claudeUsage: vi.fn(), codexUsage: vi.fn() }));
vi.mock("../lib/useClaudeUsage", async () => {
  const tauri = await import("../lib/tauri");
  return {
    useAgentUsage: (fetcher: unknown) => ({
      usage: fetcher === tauri.claudeUsage ? usage.claude : usage.codex,
      now: Date.parse("2026-11-08T12:00:00Z"),
      loading: false,
      error: "",
      refresh: vi.fn(),
    }),
  };
});
vi.mock("../components/ClaudeUsagePanel", () => ({ default: ({ title }: { title: string }) => <div>{title}</div> }));
import UsageMeters from "./UsageMeters";

const plan = (percent: number, severity = "normal"): ClaudeUsage => ({
  plan: "max",
  bars: [{ kind: "session", group: "session", label: "Current session", percent, severity, resets_at: "2026-11-08T12:47:00Z", is_active: true }],
  spend: null,
  fetched_at_ms: 0,
});

afterEach(() => {
  cleanup();
  usage.claude = null;
  usage.codex = null;
});

describe("the plan usage at the foot of the sidebar", () => {
  it("is not there at all without a figure to show", () => {
    const { container } = render(<UsageMeters />);
    expect(container.innerHTML).toBe("");
  });

  it("shows one line per plan, and when it resets only once the limit is near", () => {
    usage.claude = plan(42);
    usage.codex = plan(81, "warning");
    render(<UsageMeters />);
    const meters = screen.getByRole("button", { name: "Plan usage" });
    expect(meters.textContent).toContain("Claude42%");
    expect(meters.textContent).toContain("Codex81% · 47m");
    expect(meters.querySelector('[data-tone="warn"]')?.textContent).toContain("Codex");
    expect(meters.getAttribute("title")).toContain("Claude: 42% of this window used, resets in 47m");
  });

  it("leaves out a plan at 0%, and the whole block when every plan is", () => {
    usage.claude = plan(20);
    usage.codex = plan(0.3);
    const { container, rerender } = render(<UsageMeters />);
    const meters = screen.getByRole("button", { name: "Plan usage" });
    expect(meters.textContent).toContain("Claude20%");
    expect(meters.textContent).not.toContain("Codex");
    usage.claude = plan(0);
    rerender(<UsageMeters />);
    expect(container.innerHTML).toBe("");
  });

  it("opens the full breakdown, and Escape puts it away", () => {
    usage.claude = plan(42);
    render(<UsageMeters />);
    fireEvent.click(screen.getByRole("button", { name: "Plan usage" }));
    expect(screen.getByRole("dialog", { name: "Plan usage" }).textContent).toContain("Claude usage limits");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Plan usage" })).toBeNull();
  });
});
