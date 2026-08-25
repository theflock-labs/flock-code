// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isToastSuppressed,
  onToastSuppressionChange,
  showAllToasts,
  suppressToast,
  suppressedToasts,
  unsuppressToast,
} from "./toastSuppression";

describe("toast suppression", () => {
  // Node 22 puts its own half-configured `localStorage` on globalThis, which
  // shadows jsdom's. Same substitution budgets.test.ts makes.
  beforeAll(() => {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
        clear: () => store.clear(),
      },
    });
  });
  beforeEach(() => localStorage.clear());

  it("interrupts until told not to", () => {
    expect(isToastSuppressed("pr_opened")).toBe(false);
    suppressToast("pr_opened");
    expect(isToastSuppressed("pr_opened")).toBe(true);
  });

  it("silences one kind without silencing the rest", () => {
    suppressToast("pr_opened");
    expect(isToastSuppressed("task_send")).toBe(false);
    expect(isToastSuppressed("copilot_invite")).toBe(false);
  });

  it("has a way back, per kind and wholesale", () => {
    suppressToast("pr_opened");
    suppressToast("task_send");
    expect(suppressedToasts()).toEqual(["pr_opened", "task_send"]);
    unsuppressToast("pr_opened");
    expect(suppressedToasts()).toEqual(["task_send"]);
    showAllToasts();
    expect(suppressedToasts()).toEqual([]);
  });

  /* Settings renders the list of what is hidden and can be open behind the
   * very toast being silenced. The native `storage` event does not fire in the
   * document that wrote it, so without this the panel shows a stale list. */
  it("tells an open Settings panel that something changed", () => {
    const seen = vi.fn();
    const off = onToastSuppressionChange(seen);
    suppressToast("pr_opened");
    unsuppressToast("pr_opened");
    expect(seen).toHaveBeenCalledTimes(2);
    off();
    suppressToast("task_send");
    expect(seen).toHaveBeenCalledTimes(2);
  });

  /* Corrupted storage must fail towards INTERRUPTING. The alternative reading
   * is that unparseable JSON silently swallows a friend's request to pair. */
  it("interrupts when it cannot tell what was suppressed", () => {
    localStorage.setItem("flock:toasts-off", "{not json");
    expect(isToastSuppressed("task_send")).toBe(false);
    localStorage.setItem("flock:toasts-off", '["pr_opened"]');
    expect(isToastSuppressed("pr_opened")).toBe(false);
  });

  /* An unknown key written by a newer build survives a round trip, so
   * downgrading and upgrading does not quietly turn a pop-up back on. */
  it("preserves kinds it does not recognise", () => {
    localStorage.setItem("flock:toasts-off", '{"from_the_future":true}');
    suppressToast("pr_opened");
    expect(JSON.parse(localStorage.getItem("flock:toasts-off")!)).toEqual({
      from_the_future: true,
      pr_opened: true,
    });
  });
});
