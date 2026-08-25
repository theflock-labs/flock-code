import { describe, expect, it, vi } from "vitest";
import {
  deliverPromptWhenReady,
  READY_TIMEOUT_MS,
  SETTLE_MS,
  type PaneReadiness,
} from "./promptDelivery";

/** A pane whose readiness follows a script, with a clock the test drives so
 *  the 60s timeout and the 900ms settle cost nothing to exercise. */
function harness(states: PaneReadiness[]) {
  let clock = 0;
  const seen: PaneReadiness[] = [];
  const paste = vi.fn<(paneId: string, text: string) => void>();
  const submit = vi.fn<(paneId: string) => Promise<void>>(async () => {});
  const order: string[] = [];
  return {
    paste, submit, order, seen,
    get clock() { return clock; },
    deps: {
      readiness: () => {
        const next = states.length > 1 ? states.shift()! : states[0];
        seen.push(next);
        return next;
      },
      paste: (id: string, text: string) => { order.push("paste"); paste(id, text); },
      submit: async (id: string) => { order.push("submit"); await submit(id); },
      sleep: async (ms: number) => { clock += ms; },
      now: () => clock,
    },
  };
}

describe("waiting for the pane to be the agent's", () => {
  it("does not type into a booting pane", async () => {
    // A fresh pane is a login shell for the first second or two. A multi-line
    // prompt sent into that window is run by bash, one line at a time.
    const h = harness(["booting", "booting", "booting", "ready"]);
    await deliverPromptWhenReady("p1", "review this PR", h.deps);
    expect(h.paste).toHaveBeenCalledWith("p1", "review this PR");
    expect(h.seen.filter((s) => s === "booting")).toHaveLength(3);
  });

  it("waits one beat past the first paint before pasting", async () => {
    // The agent draws a splash before its input line is live; a paste that
    // lands in between is swallowed with no trace.
    const h = harness(["ready"]);
    await deliverPromptWhenReady("p1", "go", h.deps);
    expect(h.clock).toBeGreaterThanOrEqual(SETTLE_MS);
  });

  it("pastes first and submits second", async () => {
    const h = harness(["ready"]);
    await deliverPromptWhenReady("p1", "go", h.deps);
    expect(h.order).toEqual(["paste", "submit"]);
  });
});

describe("the two ways waiting ends badly", () => {
  it("sends nothing at all when the pane is gone", async () => {
    // Closed while we waited. Typing into a reused id is worse than typing
    // nothing.
    const h = harness(["gone"]);
    await deliverPromptWhenReady("p1", "go", h.deps);
    expect(h.paste).not.toHaveBeenCalled();
    expect(h.submit).not.toHaveBeenCalled();
  });

  it("gives up and sends anyway rather than hanging forever", async () => {
    // An agent that never paints — a missing CLI, a jail still building its
    // image — must not leave the caller's loading state pending for good.
    const h = harness(["booting"]);
    await deliverPromptWhenReady("p1", "go", h.deps);
    expect(h.clock).toBeGreaterThan(READY_TIMEOUT_MS);
    expect(h.paste).toHaveBeenCalledWith("p1", "go");
  });
});
