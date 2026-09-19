// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

let handleKey: (event: KeyboardEvent) => boolean;

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options = {};
    buffer = { active: { viewportY: 0, baseY: 0, cursorY: 0 } };
    private dataHandler?: (data: string) => void;
    input(data: string) { this.dataHandler?.(data); }
    onData(handler: (data: string) => void) { this.dataHandler = handler; return { dispose() {} }; }
    attachCustomKeyEventHandler(handler: typeof handleKey) { handleKey = handler; }
    write(_data: Uint8Array | string, done?: () => void) { done?.(); }
    loadAddon() {}
    open() {}
    focus() {}
    dispose() {}
    refresh() {}
    scrollToBottom() {}
    clearSelection() {}
    getSelection() { return ""; }
    onResize() { return { dispose() {} }; }
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class { dispose() {} } }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("../lib/tauri", () => ({
  subscribePaneOutput: vi.fn(() => Promise.resolve(() => {})),
  onPtyExit: vi.fn(() => Promise.resolve(() => {})),
  resizePty: vi.fn(() => Promise.resolve()),
  sendInput: vi.fn(() => Promise.resolve()),
}));
vi.mock("../lib/terminalLinks", () => ({ registerTerminalLinks: () => ({ dispose() {} }) }));
vi.mock("../lib/streamPublisher", () => ({ publishBytes: vi.fn(), publishDims: vi.fn(), recordDims: vi.fn() }));
vi.mock("../lib/restoreHistory", () => ({ getRestoreHistory: () => null }));
vi.mock("../lib/theme", () => ({
  getEffectiveTheme: () => "dark", getXtermTheme: () => ({}),
  onThemeChange: () => () => {}, TERMINAL_FONT_FAMILY: "monospace",
}));
vi.mock("../lib/uiScale", () => ({ getStoredPaneFontSize: () => 13, onPaneFontSizeChange: () => () => {} }));

import Terminal from "./Terminal";
import { sendInput } from "../lib/tauri";

describe("macOS terminal editing shortcuts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 0; });
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it.each([["ArrowLeft", "\u001bb"], ["ArrowRight", "\u001bf"]])(
    "keeps Option+%s word movement and broadcasts the same input",
    async (key, expected) => {
      render(<Terminal paneId="p1" focused visible broadcastGroup={["p1", "p2"]} />);
      await act(async () => { await Promise.resolve(); });
      const event = new KeyboardEvent("keydown", { key, altKey: true, cancelable: true });
      expect(handleKey(event)).toBe(false);
      expect(event.defaultPrevented).toBe(true);
      expect(vi.mocked(sendInput).mock.calls.map(([id, bytes]) => [id, new TextDecoder().decode(bytes)])).toEqual([
        ["p1", expected], ["p2", expected],
      ]);
    },
  );

  it.each([
    { key: "ArrowLeft", altKey: true, shiftKey: true },
    { key: "ArrowRight", altKey: true, ctrlKey: true },
    { key: "ArrowUp", altKey: true },
    { key: "ArrowLeft" },
  ])("leaves other arrow combinations to xterm: %j", async (options) => {
    render(<Terminal paneId="p1" focused visible />);
    await act(async () => { await Promise.resolve(); });
    const event = new KeyboardEvent("keydown", { ...options, cancelable: true });
    expect(handleKey(event)).toBe(true);
    expect(event.defaultPrevented).toBe(false);
    expect(sendInput).not.toHaveBeenCalled();
  });

  it("leaves Alt-arrow untouched on other platforms", async () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
    render(<Terminal paneId="p1" focused visible />);
    await act(async () => { await Promise.resolve(); });
    expect(handleKey(new KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true }))).toBe(true);
    expect(sendInput).not.toHaveBeenCalled();
  });
});
