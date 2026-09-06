// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import type { PrDetails } from "../lib/tauri";

const api = vi.hoisted(() => ({ details: vi.fn() }));
vi.mock("../lib/tauri", () => ({ githubPrDetails: api.details, githubPrDiff: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: vi.fn() }));
vi.mock("./DiffView", () => ({ default: () => <div>Diff</div> }));
vi.mock("./MergeQueueModal", () => ({ default: () => <div>Queue manager</div> }));
vi.mock("./PrWatchSettings", () => ({ default: () => <div>Watched repos</div> }));
vi.mock("../lib/useFocusTrap", () => ({ useFocusTrap: () => {} }));
import PrManagerModal from "./PrManagerModal";

function props(): ComponentProps<typeof PrManagerModal> {
  return {
    prs: [1, 2].map((number) => ({ number, title: `Change ${number}`, author: "author", repo: "team/repo", state: "open", body: "", updated_at: new Date().toISOString(), head_ref: `branch-${number}` })),
    prError: null, onClose: vi.fn(), onReview: vi.fn(), reviewingPr: null, onReviewAll: vi.fn(), summaries: {}, ghUser: "remi", mergeQueue: [],
    onQueueAdd: vi.fn(async () => {}), onQueueRemove: vi.fn(async () => {}), onQueueReorder: vi.fn(async () => {}), onApprove: vi.fn(async () => {}), onMergeNow: vi.fn(async () => {}), resolveRepoPaths: vi.fn(async () => ({})),
  };
}
const details: PrDetails = { checks: [{ name: "Unit tests", status: "completed", conclusion: "failure", html_url: null }], reviews: [{ author: "teammate", state: "CHANGES_REQUESTED", body: "Handle the offline case.", submitted_at: "2026-09-05T10:00:00Z" }], head_ref: "feature", base_ref: "main", state: "open", merged: false, approved: false };

beforeEach(() => { api.details.mockReset().mockResolvedValue(details); });
afterEach(cleanup);

describe("PR action intent", () => {
  it("shows the actor, merge consequences, checks and expandable reviewer feedback beside explicit actions", async () => {
    await act(async () => { render(<PrManagerModal {...props()} />); });
    expect(screen.getByRole("button", { name: "Review with agent" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve on GitHub" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Queue auto-merge" })).toBeTruthy();
    expect(screen.getByText("@remi")).toBeTruthy();
    expect(screen.getByText(/Queued PRs merge automatically in order/)).toBeTruthy();
    expect(screen.getByText("Unit tests")).toBeTruthy();
    const feedback = screen.getByText("changes requested · @teammate");
    expect(feedback.tagName).toBe("SUMMARY");
    expect(screen.getByText("Handle the offline case.")).toBeTruthy();
  });

  it("natively disables both review controls and explains a different PR's startup", async () => {
    const p = { ...props(), reviewingPr: 2 };
    const rendered = render(<PrManagerModal {...p} />);
    await act(async () => {});
    const review = screen.getByRole("button", { name: "Review with agent" }) as HTMLButtonElement;
    const all = screen.getByRole("button", { name: /Review all with agents/ }) as HTMLButtonElement;
    expect(review.disabled).toBe(true);
    expect(all.disabled).toBe(true);
    expect(screen.getByText(/An agent review is starting for PR #2/)).toBeTruthy();
    fireEvent.click(review); fireEvent.click(all);
    expect(p.onReview).not.toHaveBeenCalled();
    expect(p.onReviewAll).not.toHaveBeenCalled();
    rendered.rerender(<PrManagerModal {...p} reviewingPr={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Review with agent" }));
    expect(p.onReview).toHaveBeenCalledWith(p.prs[0]);
  });

  it("keeps a readable busy state for the selected review", async () => {
    await act(async () => { render(<PrManagerModal {...props()} reviewingPr={1} />); });
    const review = screen.getByRole("button", { name: "Starting review…" });
    expect(review.getAttribute("aria-busy")).toBe("true");
    expect((review as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Starting an agent for PR #1…")).toBeTruthy();
  });

  it("dispatches approval and queue actions independently and reports an approval failure", async () => {
    const p = props();
    p.onApprove = vi.fn().mockRejectedValue(new Error("GitHub is unavailable"));
    await act(async () => { render(<PrManagerModal {...p} />); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Approve on GitHub" })); });
    expect(p.onApprove).toHaveBeenCalledWith("team/repo", 1);
    expect(screen.getByText("GitHub is unavailable")).toBeTruthy();
    expect(p.onQueueAdd).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Queue auto-merge" })); });
    expect(p.onQueueAdd).toHaveBeenCalledWith(p.prs[0]);
    expect(p.onReview).not.toHaveBeenCalled();
  });
});
