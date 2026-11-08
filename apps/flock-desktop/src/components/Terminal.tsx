import { memo, useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { openUrl } from "@tauri-apps/plugin-opener";
import { registerTerminalLinks } from "../lib/terminalLinks";
import { onPtyExit, resizePty, sendInput, subscribePaneOutput } from "../lib/tauri";
import { publishDims, recordDims } from "../lib/streamPublisher";
import { getRestoreHistory } from "../lib/restoreHistory";
import { getEffectiveTheme, getXtermTheme, onThemeChange, TERMINAL_FONT_FAMILY } from "../lib/theme";
import { getStoredPaneFontSize, onPaneFontSizeChange } from "../lib/uiScale";
import { bindTerminalFont } from "../lib/terminalFont";
import { noteInjectedInput, registerSniffer, registerTerminal, unregisterSniffer, unregisterTerminal } from "../lib/terminalRegistry";
import { handleImagePaste } from "../lib/imageAttach";
import { IntentSniffer } from "../lib/intentSniffer";
import { copyText } from "../lib/clipboard";
import { createDragSelect } from "../lib/dragSelect";
import { flashPanePill } from "../lib/panePill";

// One agent's terminal, mounted only while its thread is on screen.
//
// v1 kept every pane of every workspace mounted (hidden with visibility) and
// streamed every byte of every agent into the webview, buffering the hidden
// ones; twenty agents meant twenty xterms and twenty live IPC streams whatever
// you were looking at. v2 mounts a terminal when its thread is shown and
// disposes it when you leave. Coming back, the subscription replays the pane's
// output ring (the backend keeps it, see PaneOutput) and the agent is asked to
// repaint, so the screen is current without the webview having watched it.

interface Props {
  paneId: string;
  focused: boolean;
  /** Fires with each non-empty prompt the user submits into this pane. */
  onIntentCaptured?: (paneId: string, text: string) => void;
  /** When set (broadcast is on for this tab), input typed here is replicated
   * to every pane id in the group, this one included. */
  broadcastGroup?: readonly string[] | null;
  /** True while flock's boot card covers the pane. When it drops, the agent
   * has just started painting and is sent one size change it cannot miss. */
  booting?: boolean;
}

/** Floor on the gap between two `term.write` calls. xterm's WebGL renderer
 *  redraws the whole viewport on the frame after its buffer changes, so what
 *  sets the repaint rate is how often the buffer is touched. A pane that has
 *  been quiet writes immediately (an echoed keystroke never waits); only
 *  sustained output is batched, to about two frames. Nothing is dropped. */
const MIN_WRITE_GAP_MS = 32;

/** Ceiling on live WebGL contexts in this webview. A webview hands out a fixed
 *  number (WebKit and Chromium both around 16) and silently kills the oldest
 *  to honour a new one; only on-screen panes are mounted now, so this is a
 *  backstop, sized to flock's largest grid. */
const MAX_WEBGL_CONTEXTS = 12;
let liveWebglContexts = 0;
/** Set once if this webview cannot give us WebGL at all. */
let webglUnavailable = false;

/** Whether the viewport is following the tail (within a line of the bottom). */
function isFollowingTail(term: XTerm): boolean {
  const b = term.buffer.active;
  return b.viewportY >= b.baseY - 1;
}

/** Make a full-screen TUI repaint the whole pane by handing it a guaranteed
 *  SIGWINCH: +1 row, then back. Dimensions are read at each call, never
 *  captured, so a fit landing between the awaits cannot be undone by them. */
function forceAgentRepaint(paneId: string, term: XTerm): void {
  resizePty(paneId, term.rows + 1, term.cols)
    .then(() => resizePty(paneId, term.rows, term.cols))
    .then(() => {
      requestAnimationFrame(() => {
        resizePty(paneId, term.rows, term.cols).catch(() => {});
      });
    })
    .catch(() => { /* pane may already be gone */ });
}

function fitKeepingBottom(term: XTerm, fit: FitAddon): void {
  const following = isFollowingTail(term);
  try { fit.fit(); } catch { return; }
  if (following) term.scrollToBottom();
}

function concatChunks(chunks: readonly Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const merged = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) { merged.set(c, offset); offset += c.length; }
  return merged;
}

function Terminal({ paneId, focused, onIntentCaptured, broadcastGroup, booting }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const onIntentRef = useRef(onIntentCaptured);
  onIntentRef.current = onIntentCaptured;
  const broadcastRef = useRef(broadcastGroup);
  broadcastRef.current = broadcastGroup;
  const focusedRef = useRef(focused);
  focusedRef.current = focused;

  useEffect(() => {
    if (!containerRef.current) return;
    const host = containerRef.current;

    const term = new XTerm({
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: getStoredPaneFontSize(),
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: "bar",
      cursorWidth: 2,
      allowProposedApi: true,
      // Unlimited scrollback is gigabytes across a long day of agents.
      scrollback: 1000,
      theme: getXtermTheme(getEffectiveTheme()),
      // With copy-on-select, right-click selecting a word would overwrite the
      // clipboard just by opening the context menu.
      rightClickSelectsWord: false,
      // Agents run with mouse reporting on (it carries the wheel), so a drag
      // never starts xterm's own selection; ⌥-drag is the escape hatch.
      macOptionClickForcesSelection: true,
      // OSC 8 hyperlinks: http(s) only, opened in the system browser. The text
      // is agent output, so any other scheme behind a friendly label is refused.
      linkHandler: {
        allowNonHttpProtocols: false,
        activate(event, uri) {
          event.preventDefault();
          if (!/^https?:\/\//i.test(uri)) return;
          openUrl(uri).catch(console.error);
        },
      },
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    registerTerminalLinks(term);
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        event.preventDefault();
        openUrl(uri).catch(console.error);
      }),
    );
    termRef.current = term;
    registerTerminal(paneId, term);

    // Every submitted prompt, so App can name the thread and keep a history.
    const sniffer = new IntentSniffer();
    registerSniffer(paneId, sniffer);

    term.onData((data) => {
      const bytes = new TextEncoder().encode(data);
      const group = broadcastRef.current;
      const targets = group && group.length ? group : [paneId];
      for (const target of targets) {
        sendInput(target, bytes).catch(console.error);
        if (target !== paneId) noteInjectedInput(target, data);
      }
      const prompt = sniffer.feed(data);
      if (prompt !== null) onIntentRef.current?.(paneId, prompt);
    });

    // Image paste: route image bytes to the agent (or a staged file); text
    // pastes fall through to xterm untouched.
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const blobs: Blob[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) blobs.push(file);
        }
      }
      if (blobs.length === 0) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      handleImagePaste(paneId, blobs).catch(console.error);
    };
    host.addEventListener("paste", onPaste, true);

    // Copy on select, keyed off the gesture (a left press in this pane, then
    // its release) so a scrollback trim can never rewrite the clipboard.
    let selectionGesture = false;
    const onPointerDown = (e: PointerEvent) => {
      if (e.button === 0) selectionGesture = true;
    };
    const onPointerUp = () => {
      if (!selectionGesture) return;
      selectionGesture = false;
      if (!focusedRef.current) return;
      const selection = term.getSelection();
      if (!selection) return;
      copyText(selection).catch(() => flashPanePill(paneId, "copy failed", true));
    };
    host.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerUp);

    // A plain drag selects, with no modifier (see lib/dragSelect.ts).
    const dragSelect = createDragSelect({
      screen: () => host.querySelector<HTMLElement>(".xterm-screen") ?? null,
      mouseReporting: () => term.modes.mouseTrackingMode !== "none",
      focus: () => term.focus(),
    });
    const onCaptureMouseDown = (e: MouseEvent) => dragSelect.onCaptureMouseDown(e);
    const onDragMove = (e: MouseEvent) => dragSelect.onMouseMove(e);
    const onDragUp = (e: MouseEvent) => dragSelect.onMouseUp(e);
    const onDragCancel = () => dragSelect.cancel();
    host.addEventListener("mousedown", onCaptureMouseDown, true);
    window.addEventListener("mousemove", onDragMove);
    window.addEventListener("mouseup", onDragUp);
    window.addEventListener("pointercancel", onDragCancel);
    window.addEventListener("blur", onDragCancel);
    document.addEventListener("visibilitychange", onDragCancel);

    // macOS line editing: ⌘⌫ kill line, ⌘← / ⌘→ start / end of line, and
    // ⌥← / ⌥→ word movement (xterm 6 dropped its own mapping).
    const CMD_LINE_KEYS: Record<string, number> = { Backspace: 0x15, ArrowLeft: 0x01, ArrowRight: 0x05 };
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && navigator.platform.startsWith("Mac")) {
        const word = e.key === "ArrowLeft" ? "\x1bb" : e.key === "ArrowRight" ? "\x1bf" : null;
        if (word) {
          e.preventDefault();
          term.input(word, true);
          return false;
        }
      }
      if (!e.metaKey || e.altKey || e.ctrlKey) return true;
      const byte = CMD_LINE_KEYS[e.key];
      if (byte === undefined) return true;
      e.preventDefault();
      sendInput(paneId, new Uint8Array([byte])).catch(console.error);
      return false;
    });

    // Before the first fit, so the initial resize reaches the PTY.
    term.onResize(({ cols, rows }) => {
      resizePty(paneId, rows, cols).catch(console.error);
      // A friend watching or co-piloting this pane sizes their copy to it.
      recordDims(paneId, cols, rows);
      publishDims(paneId, cols, rows);
    });

    term.open(host);
    fit.fit();

    // The GPU renderer, while there is a context to spare.
    let webgl: WebglAddon | null = null;
    const releaseWebgl = () => {
      if (!webgl) return;
      const addon = webgl;
      webgl = null;
      liveWebglContexts--;
      addon.dispose();
    };
    if (!webglUnavailable && liveWebglContexts < MAX_WEBGL_CONTEXTS) {
      try {
        const addon = new WebglAddon();
        addon.onContextLoss(() => {
          releaseWebgl();
          term.refresh(0, term.rows - 1);
        });
        term.loadAddon(addon);
        webgl = addon;
        liveWebglContexts++;
      } catch {
        webglUnavailable = true;
      }
    }

    // Live writes, coalesced (see MIN_WRITE_GAP_MS).
    let lastWriteAt = -Infinity;
    let held: Uint8Array[] = [];
    let heldTimer: ReturnType<typeof setTimeout> | null = null;
    const writeToTerm = (bytes: Uint8Array) => {
      lastWriteAt = performance.now();
      const following = isFollowingTail(term);
      term.write(bytes, following ? () => term.scrollToBottom() : undefined);
    };
    const flushHeld = () => {
      if (heldTimer !== null) { clearTimeout(heldTimer); heldTimer = null; }
      if (held.length === 0) return;
      const chunks = held;
      held = [];
      writeToTerm(concatChunks(chunks));
    };
    const writeLive = (data: Uint8Array) => {
      if (heldTimer === null) {
        const since = performance.now() - lastWriteAt;
        if (since >= MIN_WRITE_GAP_MS) {
          writeToTerm(data);
          return;
        }
        heldTimer = setTimeout(flushHeld, MIN_WRITE_GAP_MS - since);
      }
      held.push(data);
    };

    // Pre-restart history for agents that do not resume themselves, painted
    // once, above whatever the fresh process prints.
    const history = getRestoreHistory(paneId);
    if (history && history.length > 0) {
      term.write(history);
      term.write("\r\n\x1b[2m──────────  previous session restored  ──────────\x1b[0m\r\n");
    }

    // The backend sends the output ring (the current screen) as the first
    // frame, atomically with joining the live set, then streams. The ring can
    // begin mid-sequence, so once subscribed the agent is asked to repaint.
    let cancelled = false;
    let unsubOutput: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;
    subscribePaneOutput(paneId, writeLive, true).then((fn) => {
      if (cancelled) { fn(); return; }
      unsubOutput = fn;
      forceAgentRepaint(paneId, term);
    });
    onPtyExit(paneId, (code) => {
      flushHeld();
      term.write(`\r\n\x1b[2m[process exited with code ${code}]\x1b[0m\r\n`);
    }).then((fn) => {
      if (cancelled) { fn(); return; }
      unlistenExit = fn;
    });

    const ro = new ResizeObserver(() => fitKeepingBottom(term, fit));
    ro.observe(host);

    const unsubscribeTheme = onThemeChange((theme) => {
      term.options.theme = getXtermTheme(theme);
    });
    const unsubscribeScale = onPaneFontSizeChange((px) => {
      term.options.fontSize = px;
      fitKeepingBottom(term, fit);
    });
    const unsubscribeFont = bindTerminalFont(term, () => fitKeepingBottom(term, fit));

    if (focusedRef.current) term.focus();

    return () => {
      cancelled = true;
      if (heldTimer !== null) clearTimeout(heldTimer);
      held = [];
      ro.disconnect();
      host.removeEventListener("paste", onPaste, true);
      host.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      host.removeEventListener("mousedown", onCaptureMouseDown, true);
      window.removeEventListener("mousemove", onDragMove);
      window.removeEventListener("mouseup", onDragUp);
      window.removeEventListener("pointercancel", onDragCancel);
      window.removeEventListener("blur", onDragCancel);
      document.removeEventListener("visibilitychange", onDragCancel);
      dragSelect.dispose();
      unsubscribeTheme();
      unsubscribeScale();
      unsubscribeFont();
      if (unsubOutput) unsubOutput();
      if (unlistenExit) unlistenExit();
      unregisterSniffer(paneId, sniffer);
      unregisterTerminal(paneId, term);
      releaseWebgl();
      term.dispose();
      termRef.current = null;
    };
  }, [paneId]);

  // Focus follows the focused pane.
  useEffect(() => {
    if (focused) termRef.current?.focus();
  }, [focused]);

  // The agent's first frame can be laid out for the spawn-time 24x80: the fit
  // that corrects the PTY lands while its runtime is still starting, and a
  // SIGWINCH sent then is lost. The moment the boot card drops the agent is
  // demonstrably painting, so it gets one size change it cannot have missed.
  const wasBooting = useRef(booting);
  useEffect(() => {
    const term = termRef.current;
    if (wasBooting.current && !booting && term) forceAgentRepaint(paneId, term);
    wasBooting.current = booting;
  }, [booting, paneId]);

  return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
}

export default memo(Terminal);
