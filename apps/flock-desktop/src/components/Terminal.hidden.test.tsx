// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";

// Every workspace and every tab keeps its Terminal mounted, so a pane whose
// workspace is hidden still receives pty output. It holds that output instead
// of rendering it, and replays it on reveal. The whole value of that trade is
// that the replay is lossless — these tests are what say so, because the
// symptom of getting it wrong (a background agent's answer quietly missing
// after a workspace switch) is invisible until a user hits it.

/** The live pty subscriber Terminal registers, captured per test. */
let emit: ((data: Uint8Array) => void) | null = null;
const resizeCalls: [string, number, number][] = [];
/** Set by a test to run on each resizePty call — used to simulate a fit
 *  landing in the middle of the repaint's two resizes. */
let resizeSpy: (() => void) | null = null;

vi.mock("../lib/tauri", () => ({
  subscribePaneOutput: vi.fn((_id: string, cb: (d: Uint8Array) => void) => {
    emit = cb;
    return Promise.resolve(() => {});
  }),
  onPtyExit: vi.fn(() => Promise.resolve(() => {})),
  resizePty: vi.fn((id: string, rows: number, cols: number) => {
    resizeCalls.push([id, rows, cols]);
    // Hook so a test can simulate a fit landing mid-flight.
    resizeSpy?.();
    return Promise.resolve();
  }),
  sendInput: vi.fn(() => Promise.resolve()),
}));

/** Writes seen by the terminal, in order, decoded for readable failures. */
const writes: string[] = [];

/** The most recently constructed fake terminal, so a test can move its
 *  dimensions the way a real fit would and assert what the PTY is told. */
let lastTerm: { cols: number; rows: number } | null = null;
/** The handler Terminal registers with term.onResize. Real xterm calls this
 *  from inside fit() whenever the fit changes rows/cols — including for a pane
 *  whose workspace is in the background, which is the case the reveal-repaint
 *  tests below are about. */
let fireResize: ((d: { cols: number; rows: number }) => void) | null = null;

vi.mock("@xterm/xterm", () => {
  class FakeTerminal {
    cols = 80;
    rows = 24;
    constructor() { lastTerm = this as unknown as { cols: number; rows: number }; }
    options: Record<string, unknown> = {};
    buffer = { active: { viewportY: 0, baseY: 0, cursorY: 0 } };
    write(data: Uint8Array | string, cb?: () => void) {
      writes.push(typeof data === "string" ? data : new TextDecoder().decode(data));
      cb?.();
    }
    loadAddon() {}
    open() {}
    focus() {}
    dispose() {}
    refresh() {}
    scrollToBottom() {}
    clearSelection() {}
    getSelection() { return ""; }
    attachCustomKeyEventHandler() {}
    onData() { return { dispose() {} }; }
    onResize(cb: (d: { cols: number; rows: number }) => void) {
      fireResize = cb;
      return { dispose() {} };
    }
  }
  return { Terminal: FakeTerminal };
});

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class { fit() {} },
}));
vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class {},
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("../lib/terminalLinks", () => ({ registerTerminalLinks: () => ({ dispose() {} }) }));
vi.mock("../lib/streamPublisher", () => ({
  publishBytes: vi.fn(), publishDims: vi.fn(), recordDims: vi.fn(),
}));
vi.mock("../lib/restoreHistory", () => ({ getRestoreHistory: () => null }));
vi.mock("../lib/theme", () => ({
  getEffectiveTheme: () => "dark",
  getXtermTheme: () => ({}),
  onThemeChange: () => () => {},
  TERMINAL_FONT_FAMILY: "monospace",
}));
vi.mock("../lib/uiScale", () => ({
  getStoredPaneFontSize: () => 13, onPaneFontSizeChange: () => () => {},
}));

import Terminal from "./Terminal";

const enc = new TextEncoder();

/** Flush the promise chain the subscribe path awaits before `emit` is live. */
async function settle() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe("hidden panes defer rendering", () => {
  beforeEach(() => {
    writes.length = 0;
    resizeCalls.length = 0;
    emit = null;
    window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      cb(0); return 0;
    }) as typeof window.requestAnimationFrame;
    // jsdom ships neither of these; the mount effect uses both.
    vi.stubGlobal("ResizeObserver", class {
      observe() {} unobserve() {} disconnect() {}
    });
    // jsdom has no font loading API; the mount effect re-measures glyphs once
    // the Hack webfont resolves.
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { load: () => Promise.resolve([]), ready: Promise.resolve() },
    });
  });
  afterEach(cleanup);

  it("writes straight through while visible", async () => {
    render(<Terminal paneId="p1" focused visible />);
    await settle();
    act(() => emit!(enc.encode("hello")));
    expect(writes).toContain("hello");
  });

  it("holds output while hidden and replays it verbatim on reveal", async () => {
    const view = render(<Terminal paneId="p1" focused visible={false} />);
    await settle();

    act(() => {
      emit!(enc.encode("first "));
      emit!(enc.encode("second "));
      emit!(enc.encode("third"));
    });
    // Nothing painted: this is the whole point of the change.
    expect(writes).toEqual([]);

    await act(async () => { view.rerender(<Terminal paneId="p1" focused visible />); });

    // One write, carrying every byte in arrival order — a pane that was
    // hidden must end up in exactly the state it would have reached had it
    // been visible the whole time.
    expect(writes).toEqual(["first second third"]);
  });

  it("keeps the newest output when the backlog exceeds the cap", async () => {
    const view = render(<Terminal paneId="p1" focused visible={false} />);
    await settle();

    // 512 KB cap: six 100 KB chunks overflow it, so the oldest are dropped
    // rather than allowed to grow without bound behind a hidden workspace.
    act(() => {
      for (const tag of ["a", "b", "c", "d", "e", "f"]) {
        emit!(enc.encode(tag.repeat(100 * 1024)));
      }
    });
    await act(async () => { view.rerender(<Terminal paneId="p1" focused visible />); });

    expect(writes).toHaveLength(1);
    const painted = writes[0];
    expect(painted.length).toBeLessThanOrEqual(512 * 1024);
    // The tail survives; the head is what gets dropped.
    expect(painted.endsWith("f")).toBe(true);
    expect(painted.startsWith("a")).toBe(false);

    // A truncated backlog may begin mid-escape-sequence, so the flush asks the
    // agent to repaint via the two-resize SIGWINCH trick: some adjacent pair
    // differs by exactly one row, which is what guarantees the signal.
    const calls = resizeCalls.filter(([id]) => id === "p1");
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const bumped = calls.some(([, rows], i) => i > 0 && calls[i - 1][1] === rows + 1);
    expect(bumped).toBe(true);

    // And the last thing the PTY is told is the terminal's real size.
    expect(calls.at(-1)).toEqual(["p1", lastTerm!.rows, lastTerm!.cols]);
  });

  it("leaves the pty on the terminal's size when a fit races the repaint", async () => {
    // The bug this guards: opening a new agent splits the layout, which
    // resizes every *other* pane in the tab. If the repaint's two resizes
    // carry dimensions captured before their awaits, the second one puts the
    // PTY back to the pre-split size after the fit had already corrected it —
    // and nothing ever fixes it, because xterm only calls resizePty when its
    // own dimensions change, and they will not change again. The agent then
    // paints frames sized for a pane it no longer has: the duplicated splash
    // and the wrapped line-tails down the left edge.
    const view = render(<Terminal paneId="p1" focused visible={false} />);
    await settle();

    // A fit lands the moment the first resize goes out — exactly the window a
    // captured pair would clobber.
    let fitted = false;
    resizeCalls.length = 0;
    const onFirstResize = () => {
      if (fitted) return;
      fitted = true;
      lastTerm!.rows = 40;
      lastTerm!.cols = 74;
    };

    act(() => {
      for (const tag of ["a", "b", "c", "d", "e", "f"]) {
        emit!(enc.encode(tag.repeat(100 * 1024)));
      }
    });
    resizeSpy = onFirstResize;
    await act(async () => { view.rerender(<Terminal paneId="p1" focused visible />); });
    // Let the settling frame run.
    await act(async () => {
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      await Promise.resolve();
    });
    resizeSpy = null;

    const calls = resizeCalls.filter(([id]) => id === "p1");
    expect(calls.at(-1)).toEqual(["p1", 40, 74]);
  });

  // ─── The "scrambled until you resize the window" bug ────────────────────
  //
  // A background workspace's panes stay mounted, so their ResizeObserver still
  // fires: resize the window, drag a rail or change the pane font size while
  // looking at workspace A, and workspace B's hidden xterms re-fit and rewrap
  // their alt-screen contents. A hidden mount deliberately does not drive the
  // PTY (a borrowed pane's other mount may be sized to a different tile), so
  // the agent is never told, and it owns every glyph in that buffer.
  //
  // Re-syncing the size on reveal is not enough to repair it. Claude Code runs
  // under CLAUDE_CODE_NO_FLICKER=1, whose renderer is differential: told only
  // that the size changed, it repaints what it thinks changed and leaves the
  // rewrapped garbage. term.refresh() faithfully repaints xterm's buffer, and
  // xterm's buffer is the corrupted thing. Only a size change the agent cannot
  // no-op makes it redraw everything — forceAgentRepaint's +1 row and back.
  //
  // These two pin that the debt is recorded exactly when drift happened, and
  // not otherwise: firing it on every reveal would make every workspace switch
  // pay for a full agent repaint.
  it("forces an agent repaint on reveal when a fit moved the pane while hidden", async () => {
    const view = render(<Terminal paneId="p1" focused visible />);
    await settle();

    await act(async () => { view.rerender(<Terminal paneId="p1" focused visible={false} />); });

    // The window got resized while this workspace sat in the background: xterm
    // re-fits, rewraps, and tells its onResize handler — which is where the
    // hidden mount has to notice that it now owes a repaint.
    resizeCalls.length = 0;
    act(() => {
      lastTerm!.rows = 40;
      lastTerm!.cols = 74;
      fireResize!({ rows: 40, cols: 74 });
    });
    // Nothing may reach the PTY from a hidden mount.
    expect(resizeCalls).toEqual([]);

    await act(async () => { view.rerender(<Terminal paneId="p1" focused visible />); });
    await act(async () => {
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      await Promise.resolve();
    });

    // The +1 row is the whole signature of forceAgentRepaint: a size the agent
    // cannot mistake for "nothing changed", followed immediately by the real
    // one. Without it the reveal only ever re-asserts 40x74 — which the PTY may
    // already be on, raising no SIGWINCH at all.
    const rows = resizeCalls.filter(([id]) => id === "p1").map(([, r]) => r);
    expect(rows).toContain(41);
    expect(resizeCalls.filter(([id]) => id === "p1").at(-1)).toEqual(["p1", 40, 74]);
  });

  it("does not force a repaint on reveal when nothing moved while hidden", async () => {
    const view = render(<Terminal paneId="p1" focused visible />);
    await settle();
    resizeCalls.length = 0;

    await act(async () => { view.rerender(<Terminal paneId="p1" focused visible={false} />); });
    await act(async () => { view.rerender(<Terminal paneId="p1" focused visible />); });
    await act(async () => {
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      await Promise.resolve();
    });

    const rows = resizeCalls.filter(([id]) => id === "p1").map(([, r]) => r);
    expect(rows).not.toContain(25); // 24 + 1 — no forceAgentRepaint ran
  });

  it("does not replay anything when nothing arrived while hidden", async () => {
    const view = render(<Terminal paneId="p1" focused visible={false} />);
    await settle();
    await act(async () => { view.rerender(<Terminal paneId="p1" focused visible />); });
    expect(writes).toEqual([]);
  });
});

// A *visible* pane batches too, on a much shorter horizon: xterm repaints the
// frame after its buffer changed, so the write rate is the repaint rate, and
// writing every arriving pty batch hands that decision to the producer. These
// pin the two halves of the bargain — that a quiet pane still pays nothing in
// latency, and that batching one never loses or reorders a byte.
describe("visible panes coalesce writes", () => {
  beforeEach(() => {
    writes.length = 0;
    resizeCalls.length = 0;
    emit = null;
    vi.useFakeTimers();
    window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      cb(0); return 0;
    }) as typeof window.requestAnimationFrame;
    vi.stubGlobal("ResizeObserver", class {
      observe() {} unobserve() {} disconnect() {}
    });
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { load: () => Promise.resolve([]), ready: Promise.resolve() },
    });
  });
  afterEach(() => { vi.useRealTimers(); cleanup(); });

  it("writes the first batch immediately, then batches what follows", async () => {
    render(<Terminal paneId="p1" focused visible />);
    await settle();

    // Quiet pane: straight through. This is the interactive case — the batch
    // is the echo of a keystroke and any delay would be felt.
    act(() => emit!(enc.encode("a")));
    expect(writes).toEqual(["a"]);

    // Inside the gap: held, not written.
    act(() => { emit!(enc.encode("b")); emit!(enc.encode("c")); });
    expect(writes).toEqual(["a"]);

    // …and delivered as one write when the gap is up, in arrival order.
    await act(async () => { await vi.advanceTimersByTimeAsync(40); });
    expect(writes).toEqual(["a", "bc"]);
  });

  it("hands held bytes to the screen before the pane starts hiding them", async () => {
    // A pane can go hidden with a batch still inside the write gap. Those
    // bytes are older than anything the hidden path will collect, so they have
    // to land first or the reveal repaints the pane out of order.
    const view = render(<Terminal paneId="p1" focused visible />);
    await settle();

    act(() => emit!(enc.encode("one")));
    act(() => emit!(enc.encode("two")));   // held: inside the gap
    expect(writes).toEqual(["one"]);

    await act(async () => { view.rerender(<Terminal paneId="p1" focused visible={false} />); });
    expect(writes).toEqual(["one", "two"]);

    act(() => emit!(enc.encode("three")));
    await act(async () => { view.rerender(<Terminal paneId="p1" focused visible />); });
    expect(writes).toEqual(["one", "two", "three"]);
  });
});
