// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { MergeQueueItemDetail } from "../lib/tauri";

const api = vi.hoisted(() => ({ inspect: vi.fn() }));
vi.mock("../lib/tauri", () => ({ mergeQueueInspect: api.inspect, githubUpdatePrBranch: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: vi.fn() }));
import MergeQueueView from "./MergeQueueModal";

afterEach(cleanup);
describe("merge queue action context", () => {
  it("identifies the actor and keeps approval readable and other actions disabled until it settles", async () => {
    const item: MergeQueueItemDetail = {
      item: { repo: "team/repo", number: 1, title: "A change", position: 0, status: "blocked", note: "not approved" },
      mergeable: true, mergeable_state: "clean", checks: [], approvals: [], conflict_files: [], base_ref: "main", head_ref: "feature",
    };
    api.inspect.mockResolvedValue([item]);
    let finish!: () => void;
    const onApprove = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const onMerge = vi.fn(async () => {});
    await act(async () => { render(<MergeQueueView resolveRepoPaths={async () => ({})} ghUser="remi" onApprove={onApprove} onMergeNow={onMerge} onRemove={async () => {}} onReorder={async () => {}} onOpenPr={vi.fn()} />); });
    expect(screen.getByText("@remi")).toBeTruthy();
    expect(screen.getByText(/Queued PRs merge automatically in order/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve on GitHub" }));
    const busy = screen.getByRole("button", { name: "Approving on GitHub…" }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    expect(busy.getAttribute("aria-busy")).toBe("true");
    const merge = screen.getByRole("button", { name: "Merge now on GitHub" }) as HTMLButtonElement;
    expect(merge.disabled).toBe(true);
    fireEvent.click(merge);
    expect(onMerge).not.toHaveBeenCalled();
    expect(onApprove).toHaveBeenCalledWith("team/repo", 1);
    await act(async () => { finish(); });
    expect((screen.getByRole("button", { name: "Approve on GitHub" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
