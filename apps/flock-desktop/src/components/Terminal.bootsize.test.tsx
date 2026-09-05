// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";

// The "agent TUI stuck at 24x80 until the window is resized" bug.
//
// A pane's PTY spawns at 24x80 and the first fit corrects it within ~100ms.
// The agent execs immediately, so those corrections raise SIGWINCH during its
// runtime bootstrap, before anything is listening, and a signal delivered then is
// simply gone. Claude Code lays its splash/login/trust screens out for the
// size it read once, and its differential renderer never revisits them, so
// the TUI sits in the top-left corner of a correctly-sized PTY until some
// later resize raises a SIGWINCH it can hear. Measured live: PTY at 34x121,
// splash drawn for 80 cols, and one +1/-1 row flap redrew it full-width.
//
// So Terminal fires forceAgentRepaint once more at the moment the BootScanner
// says the agent is painting, the earliest instant a SIGWINCH is guaranteed
// to have a listener. These tests pin that second, post-takeover flap; the
// subscribe-time flap fires before the agent exists and cannot cover this.

let emit: ((data: Uint8Array) => void) | null = null;
const resizeCalls: [string, number, number][] = [];

vi.mock("../lib/tauri", () => ({
  subscribePaneOutput: vi.fn((_id: string, cb: (d: Uint8Array) => void) => {
    emit = cb;
    return Promise.resolve(() => {});
  }),
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
    write(_data: Uint8Array | string, cb?: () => void) { cb?.(); }
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
import { AGENT_START_MARKER } from "../lib/agentBoot";

const enc = new TextEncoder();
/** The agent taking the terminal over, the way Claude Code does: the alternate
 *  screen, then a first frame. */
const TAKEOVER = enc.encode("\x1b[?1049h" + "Welcome to Claude Code");

async function settle() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

/** True when some adjacent pair of resize calls is the +1-row flap: the one
 *  signature of forceAgentRepaint, and the only resize an agent cannot read as
 *  "nothing changed". */
function flapped(calls: [string, number, number][]): boolean {
  return calls.some(([, rows], i) => i > 0 && calls[i - 1][1] === rows + 1);
}

describe("agent takeover settles the PTY size", () => {
  beforeEach(() => {
    emit = null;
    resizeCalls.length = 0;
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
  afterEach(cleanup);

  it("flaps the size once the agent paints its first frame", async () => {
    render(<Terminal paneId="p1" focused visible />);
    await settle();
    // Everything so far (the subscribe-time repaint) predates the agent and is
    // exactly what cannot fix this bug. Only what follows the takeover counts.
    resizeCalls.length = 0;

    act(() => {
      emit!(enc.encode(AGENT_START_MARKER));
      emit!(TAKEOVER);
    });
    await settle();

    const calls = resizeCalls.filter(([id]) => id === "p1");
    expect(flapped(calls)).toBe(true);
    // And the PTY is left on the terminal's real size, not the +1.
    expect(calls.at(-1)).toEqual(["p1", 24, 80]);
  });

  it("does not flap again for later output", async () => {
    render(<Terminal paneId="p1" focused visible />);
    await settle();
    act(() => {
      emit!(enc.encode(AGENT_START_MARKER));
      emit!(TAKEOVER);
    });
    await settle();
    resizeCalls.length = 0;

    act(() => emit!(enc.encode("just more agent output, long enough to paint")));
    await settle();
    expect(resizeCalls.filter(([id]) => id === "p1")).toEqual([]);
  });

  it("banks the repaint for reveal when the takeover happens hidden", async () => {
    const view = render(<Terminal paneId="p1" focused visible={false} />);
    await settle();
    act(() => {
      emit!(enc.encode(AGENT_START_MARKER));
      emit!(TAKEOVER);
    });
    // A hidden mount must not drive the PTY, even for the takeover flap.
    expect(resizeCalls.filter(([id]) => id === "p1")).toEqual([]);

    await act(async () => { view.rerender(<Terminal paneId="p1" focused visible />); });
    await act(async () => {
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      await Promise.resolve();
    });
    expect(flapped(resizeCalls.filter(([id]) => id === "p1"))).toBe(true);
  });
});
