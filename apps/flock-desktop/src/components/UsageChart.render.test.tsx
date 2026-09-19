// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import UsageChart from "./UsageChart";
import { formatCompact, formatUsd } from "../lib/format";

const series = [
  { day: "2026-09-01", tokens_total: 100, cost_usd: 0.5 },
  { day: "2026-09-02", tokens_total: 1100, cost_usd: 3 },
  { day: "2026-09-03", tokens_total: 4100, cost_usd: 4.25 },
];

beforeEach(() => {
  // Supply layout that jsdom cannot measure; keep the actual Recharts tree.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0, y: 0, top: 0, left: 0, right: 600, bottom: 240,
    width: 600, height: 240, toJSON: () => ({}),
  });
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.stubGlobal("localStorage", { getItem: () => null });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("usage chart with Recharts", () => {
  it("renders daily bars and moves peak emphasis when switching to spend", async () => {
    const { container } = render(<UsageChart series={series} loading={false} />);
    const bars = () => Array.from(container.querySelectorAll(".recharts-bar-rectangle path"));
    await waitFor(() => expect(bars()).toHaveLength(2));
    expect(bars().map((bar) => bar.getAttribute("fill-opacity"))).toEqual(["0.42", "0.95"]);
    expect(Number(bars()[1].getAttribute("height"))).toBeGreaterThan(Number(bars()[0].getAttribute("height")));
    expect(container.querySelector(".usage-chart-total")?.textContent).toContain(formatCompact(4000));

    fireEvent.click(screen.getByRole("tab", { name: "Spend" }));
    await waitFor(() => expect(bars().map((bar) => bar.getAttribute("fill-opacity"))).toEqual(["0.95", "0.42"]));
    expect(Number(bars()[0].getAttribute("height"))).toBeGreaterThan(Number(bars()[1].getAttribute("height")));
    expect(container.querySelector(".usage-chart-total")?.textContent).toContain(formatUsd(3.75));
  });

  it("receives real tooltip payloads during keyboard navigation and metric changes", async () => {
    const { container } = render(<UsageChart series={series} loading={false} />);
    const chart = await screen.findByRole("application");
    fireEvent.focus(chart);
    const value = () => container.querySelector(".usage-chart-tip-value")?.textContent;
    await waitFor(() => expect(value()).toBe(`${formatCompact(1000)}tokens`));

    fireEvent.keyDown(chart, { key: "ArrowRight" });
    await waitFor(() => expect(value()).toBe(`${formatCompact(3000)}tokens`));
    expect(container.querySelector(".usage-chart-tip-day")?.textContent).toBe(
      new Date("2026-09-03T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    );

    fireEvent.click(screen.getByRole("tab", { name: "Spend" }));
    await waitFor(() => expect(value()).toBe(`${formatUsd(1.25)}spend`));
    fireEvent.blur(chart);
    await waitFor(() => expect(container.querySelector(".usage-chart-tip")).toBeNull());
  });
});
