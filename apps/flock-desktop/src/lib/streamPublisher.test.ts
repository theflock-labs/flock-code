import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The owner's side of a co-pilot/observe stream. Both properties under test
// are about who is allowed to resize the OWNER's pty, so `resizePty` is the
// observation point.
const resizePty = vi.fn(async () => {});
vi.mock("./tauri", () => ({
  resizePty: (...a: unknown[]) => resizePty(...(a as [])),
  sendInput: vi.fn(async () => {}),
}));
vi.mock("./terminalRegistry", () => ({ noteInjectedInput: vi.fn() }));

const { recordDims, startStream, stopStream } = await import("./streamPublisher");

/** Minimal stand-in for an Ably channel: records subscriptions and lets a
 *  test fire one, which is how a viewer announcing itself reaches the
 *  bootstrap. */
function fakeChannel() {
  const handlers = new Map<string, (msg: unknown) => void>();
  return {
    handlers,
    publish: vi.fn(async () => {}),
    subscribe: vi.fn((event: string, fn: (msg: unknown) => void) => { handlers.set(event, fn); }),
    unsubscribe: vi.fn((event: string) => { handlers.delete(event); }),
    detach: vi.fn(async () => {}),
    fire: (event: string, data?: unknown) => handlers.get(event)?.({ data } as unknown),
  };
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => { resizePty.mockClear(); });
afterEach(() => { stopStream("pane-1"); });

describe("the SIGWINCH bump a joining viewer triggers", () => {
  it("restores the dims the pane has NOW, not the ones captured before the sleep", async () => {
    // The hazard: a fit can land between the two resize calls,
    // and a captured pair undoes it — leaving xterm and the pty disagreeing
    // with nothing left to correct them.
    recordDims("pane-1", 80, 24);
    const channel = fakeChannel();
    startStream("pane-1", channel as never);
    channel.fire("ready");

    // The user resizes the window while the bump is in flight.
    await settle(50);
    recordDims("pane-1", 120, 40);
    await settle(120);

    expect(resizePty.mock.calls.length).toBeGreaterThanOrEqual(2);
    const last = resizePty.mock.calls.at(-1);
    expect(last).toEqual(["pane-1", 40, 120]);
    // …and never a restore to the stale pair, which is what the bug did.
    expect(resizePty.mock.calls).not.toContainEqual(["pane-1", 24, 80]);
  });

  it("bumps by one row and puts it back when nothing moves", async () => {
    recordDims("pane-1", 100, 30);
    const channel = fakeChannel();
    startStream("pane-1", channel as never);
    channel.fire("ready");
    await settle(170);

    expect(resizePty.mock.calls).toContainEqual(["pane-1", 31, 100]);
    expect(resizePty.mock.calls.at(-1)).toEqual(["pane-1", 30, 100]);
  });
});

describe("a remote viewer cannot resize the owner's pty", () => {
  it("subscribes to no channel event that would", async () => {
    recordDims("pane-1", 80, 24);
    const channel = fakeChannel();
    startStream("pane-1", channel as never, { allowInput: true, allowedInputFrom: "partner" });
    // "ready" (bootstrap) and "input" (co-pilot keystrokes) are the whole
    // surface. "fit" used to be here, clamped — but clamped or not, the
    // owner's terminal has its own size and a viewer's window is not it.
    expect([...channel.handlers.keys()].sort()).toEqual(["input", "ready"]);
  });

  it("ignores a fit message even if a viewer still publishes one", async () => {
    recordDims("pane-1", 80, 24);
    const channel = fakeChannel();
    startStream("pane-1", channel as never);
    resizePty.mockClear();
    channel.fire("fit", { cols: 400, rows: 200 });
    await settle(20);
    expect(resizePty).not.toHaveBeenCalled();
  });
});
