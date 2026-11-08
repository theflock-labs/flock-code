// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";

// The "agent TUI stuck at 24x80 until the window is resized" bug, and the
// terminal's other jobs now that it is mounted only while its thread is shown.
//
// A pane's PTY spawns at 24x80 and the first fit corrects it within ~100ms,
// while the agent's runtime is still starting, so that SIGWINCH is lost and
// Claude Code lays its first screens out for 80 columns. The boot card drops
// the moment the backend sees the agent paint (src-tauri/src/boot.rs), and
// that is when the terminal hands it one +1/-1 row flap it cannot miss.

let emit: ((data: Uint8Array) => void) | null = null;
const resizeCalls: [string, number, number][] = [];
const writes: string[] = [];
const subscribe = vi.fn((_id: string, cb: (d: Uint8Array) => void, _replay: boolean) => {
  emit = cb;
  return Promise.resolve(() => {});
});

vi.mock("../lib/tauri", () => ({
  subscribePaneOutput: (id: string, cb: (d: Uint8Array) => void, replay: boolean) => subscribe(id, cb, replay),
  onPtyExit: vi.fn(() => Promise.resolve(() => {})),
  resizePty: vi.fn((id: string, rows: number, cols: number) => {
    resizeCalls.push([id, rows, cols]);
    return Promise.resolve();
  }),
  sendInput: vi.fn(() => Promise.resolve()),
}));

vi.mock("@xterm/xterm", () => {
  class FakeTerminal {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    buffer = { active: { viewportY: 0, baseY: 0, cursorY: 0 } };
    modes = { mouseTrackingMode: "none" };
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
    onResize() { return { dispose() {} }; }
  }
  return { Terminal: FakeTerminal };
});

vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class { onContextLoss() {} dispose() {} } }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("../lib/terminalLinks", () => ({ registerTerminalLinks: () => ({ dispose() {} }) }));
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

async function settle() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

/** True when some adjacent pair of resize calls is the +1-row flap. */
function flapped(calls: [string, number, number][]): boolean {
  return calls.some(([, rows], i) => i > 0 && calls[i - 1][1] === rows + 1);
}

describe("a terminal mounted for the thread on screen", () => {
  beforeEach(() => {
    emit = null;
    resizeCalls.length = 0;
    writes.length = 0;
    subscribe.mockClear();
    window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      cb(0); return 0;
    }) as typeof window.requestAnimationFrame;
    vi.stubGlobal("ResizeObserver", class {
      observe() {} unobserve() {} disconnect() {}
    });
  });
  afterEach(cleanup);

  it("asks for the output ring, then for a repaint, when it mounts", async () => {
    render(<Terminal paneId="p1" focused />);
    await settle();
    expect(subscribe).toHaveBeenCalledWith("p1", expect.any(Function), true);
    expect(flapped(resizeCalls.filter(([id]) => id === "p1"))).toBe(true);
  });

  it("flaps the size once the boot card drops", async () => {
    const view = render(<Terminal paneId="p1" focused booting />);
    await settle();
    resizeCalls.length = 0;

    await act(async () => { view.rerender(<Terminal paneId="p1" focused booting={false} />); });
    await settle();

    const calls = resizeCalls.filter(([id]) => id === "p1");
    expect(flapped(calls)).toBe(true);
    // And the PTY is left on the terminal's real size, not the +1.
    expect(calls.at(-1)).toEqual(["p1", 24, 80]);
  });

  it("does not flap again for later output", async () => {
    const view = render(<Terminal paneId="p1" focused booting />);
    await settle();
    await act(async () => { view.rerender(<Terminal paneId="p1" focused booting={false} />); });
    await settle();
    resizeCalls.length = 0;

    act(() => emit!(enc.encode("just more agent output, long enough to paint")));
    await settle();
    expect(resizeCalls.filter(([id]) => id === "p1")).toEqual([]);
  });

  it("writes a quiet pane's output at once and batches a stream", async () => {
    vi.useFakeTimers();
    try {
      render(<Terminal paneId="p1" focused />);
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      act(() => emit!(enc.encode("first")));
      expect(writes).toContain("first");
      act(() => {
        emit!(enc.encode("a"));
        emit!(enc.encode("b"));
      });
      expect(writes).not.toContain("ab");
      act(() => { vi.advanceTimersByTime(40); });
      expect(writes).toContain("ab");
    } finally {
      vi.useRealTimers();
    }
  });
});
