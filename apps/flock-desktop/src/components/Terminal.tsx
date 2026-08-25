import { memo, useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { openUrl } from "@tauri-apps/plugin-opener";
import { registerTerminalLinks } from "../lib/terminalLinks";
import { BootScanner, PAINT_GRACE_MS } from "../lib/agentBoot";
import { onPtyExit, resizePty, sendInput, subscribePaneOutput } from "../lib/tauri";
import { getRestoreHistory } from "../lib/restoreHistory";
import { publishBytes, publishDims, recordDims } from "../lib/streamPublisher";
import { getEffectiveTheme, getXtermTheme, onThemeChange, TERMINAL_FONT_FAMILY } from "../lib/theme";
import { getStoredPaneFontSize, onPaneFontSizeChange } from "../lib/uiScale";
import { noteInjectedInput, registerSniffer, registerTerminal, unregisterSniffer, unregisterTerminal } from "../lib/terminalRegistry";
import { handleImagePaste } from "../lib/imageAttach";
import { IntentSniffer } from "../lib/intentSniffer";
import { copyText } from "../lib/clipboard";
import { createDragSelect } from "../lib/dragSelect";
import { flashPanePill } from "../lib/panePill";

interface Props {
  paneId: string;
  focused: boolean;
  /** Whether this pane's workspace is the currently-visible one. Panes for
   * background workspaces stay mounted (visibility: hidden) so their
   * content survives switching — but WebKit sometimes fails to repaint
   * xterm's canvas after being hidden, so we force a redraw on return. */
  visible: boolean;
  /** Fires with each non-empty prompt the user submits into this pane, so
   * App can fold it into the pane's rolling intent history. Omitted for
   * popped-out windows (their agent is already running with an intent). */
  onIntentCaptured?: (paneId: string, text: string) => void;
  /** When set (broadcast/"sync input" is on for this tab), input typed here is
   * replicated to every pane id in the group — the visible panes of the tab,
   * this one included. null/undefined means send to this pane only. */
  broadcastGroup?: readonly string[] | null;
  /** Whether this is the pane's canonical mount — the instance rendered by the
   * workspace that OWNS the pane. A tab borrowing a pane from another
   * workspace renders a second Terminal on the same PTY, and per-pane
   * side effects that must happen exactly once (mirroring bytes to
   * co-pilot/observe streams) belong to the primary alone. Defaults to true;
   * only PaneArea's borrowed tiles pass false. */
  primary?: boolean;
  /** Fires once, when the agent takes the terminal over from flock's own boot
   * plumbing (see lib/agentBoot). App uses it to lift the boot card, so a pane
   * shows a shell prompt, an `npm ci` or an image build only if the user asks
   * to watch. Also fires if the process dies first — a dead pane must never sit
   * behind a card claiming it is starting. */
  onAgentStart?: (paneId: string) => void;
}

/** Cap on output held for a pane whose workspace/tab is hidden. Every pane of
 *  every workspace stays mounted and keeps receiving pty output, so a hidden
 *  agent spewing a build log must not grow this without bound. 512 KB holds
 *  comfortably more than the 500-line scrollback can ever show, while keeping
 *  the worst case across a few dozen hidden panes in the tens of megabytes;
 *  overflow drops the oldest bytes and the flush then repaints
 *  authoritatively (see flushPending). */
const MAX_PENDING_BYTES = 512 * 1024;

/** Floor on the gap between two `term.write` calls into a *visible* pane.
 *
 *  xterm refreshes on the animation frame after its buffer changed, and its
 *  WebGL renderer redraws the whole viewport when it does — a streaming pane
 *  scrolls every row, so there is no such thing as a small repaint here. What
 *  sets the repaint rate is therefore how often the buffer is touched, and
 *  writing each batch on arrival hands that decision to the producer: a pty
 *  that reports 10× a second is 10 full-viewport redraws a second, and one
 *  that dribbles is 60, because every frame finds something new.
 *
 *  UNMEASURED. Profiling located the cost — a synchronous IPC to the GPU
 *  process per WebGL canvas per frame, driven by how often the buffer is
 *  touched — but the two A/B sweeps that would have sized this fix were both
 *  discarded as invalid: the first measured a build that never rendered a
 *  terminal, the second was swamped by window occlusion (an unchanged build
 *  varied 11-25% of a core depending on which windows were on top). Treat the
 *  benefit as a hypothesis until someone re-runs it on an unobstructed,
 *  otherwise-idle machine. Nothing is dropped or reordered — the same bytes reach xterm, in the same order, in
 *  fewer calls, and one parse of a 4× larger buffer costs far less than four
 *  parses plus three extra repaints.
 *
 *  32 ms is ~2 display frames: fast enough that a scrolling pane still reads
 *  as continuous motion, slow enough to halve the frame rate a saturated pane
 *  would otherwise sustain. It is a *floor on the gap*, not a fixed cadence —
 *  a pane that has been quiet writes immediately (see `writeLive`), so an
 *  echoed keystroke never waits, and only sustained output is batched. */
const MIN_WRITE_GAP_MS = 32;

/** Ceiling on live WebGL contexts across every mounted terminal.
 *
 *  The renderer is the point of this addon — xterm's default paints each cell
 *  as DOM, which is what a twelve-pane grid of repainting TUIs spends its main
 *  thread on. But one context per terminal is not free and not unbounded: a
 *  webview hands out a fixed number (WebKit and Chromium both sit around 16)
 *  and silently kills the oldest to honour a new one. Every workspace stays
 *  mounted for the life of the app, so "one per terminal" would mean three
 *  workspaces of agents quietly evicting each other's renderers.
 *
 *  So a context is attached when a pane becomes visible and released when it
 *  hides (see the `visible` effect), which naturally scopes them to the one
 *  grid on screen; this cap is what keeps that true if the policy is ever
 *  loosened. Twelve is flock's largest grid preset. */
const MAX_WEBGL_CONTEXTS = 12;

/** Live contexts, shared across every Terminal in this webview — the resource
 *  being budgeted belongs to the webview, not to any one pane. */
let liveWebglContexts = 0;

/** One hidden→visible backlog flush per frame, shared across every Terminal.
 *  A workspace switch reveals every pane of that grid at once, and writing
 *  each pane's 512 KB cap in the same turn is a multi-hundred-ms main-thread
 *  stall — the window stops accepting clicks until it finishes. */
let revealFlushChain: Promise<void> = Promise.resolve();

function enqueueRevealFlush(work: () => void): () => void {
  let cancelled = false;
  revealFlushChain = revealFlushChain.then(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          if (!cancelled) work();
          resolve();
        });
      }),
  );
  return () => {
    cancelled = true;
  };
}

/** Set once if this webview can't give us WebGL at all (software rendering, a
 *  driver blocklist, a remote session). Construction is the only way to find
 *  out, and the answer can't change while the app runs, so ask once rather
 *  than throwing inside every pane that becomes visible. */
let webglUnavailable = false;

/** Whether the viewport is pinned to (or within a line of) the bottom — i.e.
 *  the user is "following" live output rather than scrolled up reading history.
 *  The 1-line tolerance absorbs a reflow that nudges the scroll a row off the
 *  bottom, which is exactly what strands new output above the fold. */
function isFollowingTail(term: XTerm): boolean {
  const b = term.buffer.active;
  return b.viewportY >= b.baseY - 1;
}

/** Make a full-screen TUI repaint the whole pane, by handing it a guaranteed
 *  SIGWINCH: two resizes, so the dimensions are certain to have changed.
 *
 *  Every dimension here is read off the terminal at the moment its call is
 *  made, and never captured up front. That is the whole point of the helper.
 *  A fit can land in the middle of these awaits — opening an agent splits the
 *  layout, which resizes every *other* pane in the tab — and a captured pair
 *  would then put the PTY back to the pre-split size after the fit had just
 *  corrected it. Nothing would ever fix that: xterm calls resizePty only when
 *  its own dimensions change, and they would not change again. The agent goes
 *  on painting frames for a geometry the pane no longer has, which is what the
 *  duplicated splash and the wrapped line-tails down the left edge are.
 *
 *  Re-asserting a size the PTY already has costs nothing — the kernel raises
 *  SIGWINCH only on an actual change — so the settling pass below is free in
 *  the overwhelmingly common case where nothing raced. */
function forceAgentRepaint(paneId: string, term: XTerm): void {
  resizePty(paneId, term.rows + 1, term.cols)
    .then(() => resizePty(paneId, term.rows, term.cols))
    .then(() => {
      // One settling pass on the next frame, for a fit that interleaved with
      // the two calls above and left its own resizePty behind ours.
      requestAnimationFrame(() => {
        resizePty(paneId, term.rows, term.cols).catch(() => {});
      });
    })
    .catch(() => { /* pane may already be gone */ });
}

/** Re-fit, preserving tail-follow. A resize reflows the buffer and can leave
 *  the viewport a row short of the bottom; if we were following before the fit,
 *  snap back so streaming output keeps landing in view. */
function fitKeepingBottom(term: XTerm, fit: FitAddon): void {
  const following = isFollowingTail(term);
  try { fit.fit(); } catch { return; }
  if (following) term.scrollToBottom();
}

/** One buffer out of many, in order. */
function concatChunks(chunks: readonly Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const merged = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) { merged.set(c, offset); offset += c.length; }
  return merged;
}

function Terminal({ paneId, focused, visible, onIntentCaptured, broadcastGroup, onAgentStart, primary = true }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // This pane's GPU renderer, while it holds one. Null whenever the pane is
  // hidden, the budget is spent, or the context was lost — in all three cases
  // xterm falls back to painting DOM, which is correct, just slower.
  const webglRef = useRef<WebglAddon | null>(null);
  // Prompt sniffer. The onData handler below is registered once (keyed on
  // paneId) so it can't close over live props — route them through refs.
  const onIntentRef = useRef(onIntentCaptured);
  onIntentRef.current = onIntentCaptured;
  // Same, for the one-shot "the agent has the terminal now" callback.
  const onAgentStartRef = useRef(onAgentStart);
  onAgentStartRef.current = onAgentStart;
  // Same reason: onData reads the live broadcast group through a ref. Only the
  // focused pane's onData fires, so only it fans out.
  const broadcastRef = useRef(broadcastGroup);
  broadcastRef.current = broadcastGroup;
  // Copy-on-select gating (below) also lives in the once-per-pane mount
  // effect, so it reads focus/visibility through refs too.
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const primaryRef = useRef(primary);
  primaryRef.current = primary;
  // The sniffer is created inside the mount effect but the reveal effect has
  // to re-register it (the registry follows the instance the user can see).
  const snifferRef = useRef<IntentSniffer | null>(null);
  // Set when the subscribe-time authoritative repaint was skipped because the
  // pane was hidden; the reveal effect settles the debt.
  const repaintOwedRef = useRef(false);
  // Output that arrived while this pane was hidden, still un-rendered. Writing
  // it on arrival is pure waste: rendering, not parsing, is ~97% of a pane's
  // cost, and a hidden pane renders to nothing anyone can see. Held as the
  // exact received chunks so the flush replays the byte stream unchanged.
  const pendingRef = useRef<Uint8Array[]>([]);
  const pendingBytesRef = useRef(0);
  // Set when the cap above forced us to drop the head of the backlog, so the
  // flush knows it may have started mid-escape-sequence.
  const pendingTruncatedRef = useRef(false);
  // Live-write coalescing (see MIN_WRITE_GAP_MS). Bytes for a *visible* pane
  // that arrived inside the gap since the last write, and the timer that will
  // write them. Unbounded is fine where the hidden-pane backlog is not: this
  // drains every 32 ms no matter what, so it holds one gap's worth of output.
  const liveRef = useRef<Uint8Array[]>([]);
  const liveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // -Infinity, not 0: a pane that has never written must count as having been
  // quiet forever, so its first batch goes straight through on any clock —
  // including a test clock that starts at zero.
  const lastWriteAtRef = useRef(-Infinity);

  /** Paint everything that arrived while this pane was hidden as a single
   *  write. One parse of the whole backlog costs a fraction of one render, so
   *  collapsing N hidden renders into one visible render is most of the win —
   *  and replaying the identical bytes keeps the buffer and scrollback exactly
   *  what they would have been had the pane never been hidden. */
  const flushPending = () => {
    const term = termRef.current;
    if (!term || pendingRef.current.length === 0) return;
    const chunks = pendingRef.current;
    const truncated = pendingTruncatedRef.current;
    pendingRef.current = [];
    pendingBytesRef.current = 0;
    pendingTruncatedRef.current = false;

    const merged = concatChunks(chunks);

    const following = isFollowingTail(term);
    term.write(merged, () => {
      if (following) term.scrollToBottom();
      if (truncated) {
        // The backlog lost its head to the cap, so this write may have begun
        // mid-escape-sequence. Ask the agent for one authoritative repaint —
        // the same trick the subscribe path uses when adopting a ring
        // snapshot. This is the path most exposed to the race the helper
        // guards: a pane flushes its backlog exactly when it becomes visible,
        // which is also when its container gets a size and the fit fires.
        forceAgentRepaint(paneId, term);
      }
    });
  };

  /** Hand bytes to xterm, keeping the viewport pinned to the tail if it was
   *  pinned before. Reading `following` *before* the write and re-pinning
   *  *after* is the part that matters: xterm auto-scrolls on write only when
   *  it is exactly at the bottom, so a reflow that left the scroll a row short
   *  would otherwise strand every later batch above the fold. A user who has
   *  scrolled up to read is not following, and is left where they are. */
  const writeToTerm = (bytes: Uint8Array) => {
    const term = termRef.current;
    if (!term) return;
    lastWriteAtRef.current = performance.now();
    const following = isFollowingTail(term);
    term.write(bytes, following ? () => term.scrollToBottom() : undefined);
  };

  /** Write everything held back by the gap, and close the timer. */
  const flushLive = () => {
    if (liveTimerRef.current !== null) {
      clearTimeout(liveTimerRef.current);
      liveTimerRef.current = null;
    }
    const chunks = liveRef.current;
    if (chunks.length === 0) return;
    liveRef.current = [];
    writeToTerm(concatChunks(chunks));
  };

  /** A batch for a pane that is on screen. Written straight through when this
   *  pane has been quiet for a whole gap — the interactive case, where the
   *  batch is an echoed keystroke and any delay is felt — and otherwise held
   *  until the gap is up, which is the streaming case. */
  const writeLive = (data: Uint8Array) => {
    if (liveTimerRef.current === null) {
      const since = performance.now() - lastWriteAtRef.current;
      if (since >= MIN_WRITE_GAP_MS) {
        writeToTerm(data);
        return;
      }
      liveTimerRef.current = setTimeout(flushLive, MIN_WRITE_GAP_MS - since);
    }
    liveRef.current.push(data);
  };

  /** Give this pane back its WebGL context. Safe to call when it holds none. */
  const releaseWebgl = () => {
    const addon = webglRef.current;
    if (!addon) return;
    webglRef.current = null;
    liveWebglContexts--;
    // Disposing reinstates xterm's DOM renderer, so the pane keeps painting.
    addon.dispose();
  };

  /** Hand this pane a WebGL context, if there is one to spare. Requires an
   *  already-open terminal: the addon reads the opened element's dimensions as
   *  it loads, and throws when there is none. */
  const claimWebgl = () => {
    const term = termRef.current;
    if (!term || webglRef.current || webglUnavailable) return;
    if (liveWebglContexts >= MAX_WEBGL_CONTEXTS) return;
    try {
      const addon = new WebglAddon();
      // The webview may revoke the context at any time — a GPU reset, or its
      // own budget being spent elsewhere. Hand it back and repaint rather than
      // leaving the pane frozen on a dead canvas; the DOM renderer takes over
      // and the next reveal asks for a context again.
      addon.onContextLoss(() => {
        releaseWebgl();
        term.refresh(0, term.rows - 1);
      });
      term.loadAddon(addon);
      webglRef.current = addon;
      liveWebglContexts++;
    } catch {
      webglUnavailable = true;
    }
  };

  // Mount + connect. One xterm instance per pane, persisted across re-renders.
  useEffect(() => {
    if (!containerRef.current) return;

    const term = new XTerm({
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: getStoredPaneFontSize(),
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: "bar",
      cursorWidth: 2,
      allowProposedApi: true,
      // Cap scrollback — default is unlimited growth which causes GB of RAM
      // across many long-running agent sessions.
      scrollback: 500,
      // Disable the overview ruler minimap canvas (extra memory per terminal).
      overviewRulerWidth: 0,
      // flock's palette mapped onto xterm.js's theme (per active app theme —
      // xterm can't read CSS variables, so this is kept in sync by hand).
      theme: getXtermTheme(getEffectiveTheme()),
      // xterm's macOS default selects the word under a right-click. Combined
      // with copy-on-select, merely opening the pane context menu overwrote
      // the clipboard with whatever word sat under the cursor.
      rightClickSelectsWord: false,
      // WITHOUT THIS THERE IS NO WAY TO SELECT TEXT IN A PANE.
      //
      // Agents run with mouse reporting on (see the CLAUDE_CODE_NO_FLICKER /
      // DISABLE_MOUSE_CLICKS pair in spawn_pane: ?1000 has to stay, because it
      // is what carries the wheel). While an app is in mouse mode xterm hands
      // every drag to it and never starts a selection of its own, and this
      // flag is the documented escape hatch: hold a modifier and the drag
      // becomes an ordinary selection instead, with no mouse event emitted.
      //
      // It defaults to FALSE, so the "hold Option to select" behaviour the
      // rest of this app documents was never actually wired up — Option-drag
      // did nothing and a pane's output simply could not be copied.
      macOptionClickForcesSelection: true,
      // OSC 8 hyperlinks (`ESC ] 8 ;; URL ESC \ text ESC ] 8 ;; ESC \`) are a
      // separate channel from the two text-matching providers below: the URL
      // is carried in the escape sequence, never written into the buffer, so
      // neither registerTerminalLinks nor WebLinksAddon can see it — the label
      // is all they get. xterm still underlines such a link on hover, but with
      // no handler set its click path is a browser `confirm()`, which is inert
      // in the Tauri webview. That is the "underlines but does nothing" half of
      // clickable-link flakiness, and no amount of pattern matching can fix it.
      //
      // `allowNonHttpProtocols` stays off and the scheme is re-checked here
      // anyway: this text is agent output, downstream of whatever repo the
      // agent was pointed at, and an OSC 8 link can put any scheme behind
      // innocuous-looking label text. Same reasoning as terminalLinks' open vs
      // reveal allowlist — the user is clicking what they believe is a URL.
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
    // Paths and URLs, rejoined across the wraps an agent puts in its own
    // output. Registered before WebLinksAddon so it wins the rows they both
    // match: the addon would link only the first row of a wrapped URL, and
    // xterm gives the earlier provider priority. Disposed with the terminal.
    registerTerminalLinks(term);
    // Still loaded behind it, for any URL shape the provider above misses. The
    // addon's default handler uses window.open, which is inert inside the
    // Tauri webview — route clicks through the opener plugin so links land in
    // the OS default browser instead.
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        event.preventDefault();
        openUrl(uri).catch(console.error);
      }),
    );
    termRef.current = term;
    fitRef.current = fit;
    // The registry maps a pane id to ONE xterm, and a borrowed pane has two
    // mounts. The entry belongs to the instance the user can interact with —
    // registered here for the primary (whose ownership is standing, visible or
    // not) and for any instance mounting on screen; the reveal effect below
    // moves it to whichever instance just became visible. A hidden borrowed
    // mount registering here would steal the owner's entry while pointing at
    // an xterm nobody can see.
    if (primaryRef.current || visibleRef.current) registerTerminal(paneId, term);

    // Sniff every submitted prompt so App can track where the task has moved
    // on to, not just what it started as. A fresh sniffer per mount so a
    // StrictMode remount (or pane reuse) starts clean. Registered so the pane
    // context menu can read/clear the current (un-submitted) input line.
    const sniffer = new IntentSniffer();
    snifferRef.current = sniffer;
    if (primaryRef.current || visibleRef.current) registerSniffer(paneId, sniffer);

    // Pipe xterm input → backend. With broadcast on, replicate to every pane in
    // the group (this one included); otherwise just this pane.
    term.onData((data) => {
      const bytes = new TextEncoder().encode(data);
      const group = broadcastRef.current;
      const targets = group && group.length ? group : [paneId];
      for (const target of targets) {
        sendInput(target, bytes).catch(console.error);
        // Broadcast targets get the bytes without their own xterm ever seeing
        // them, so feed their sniffers directly or their input lines go stale.
        if (target !== paneId) noteInjectedInput(target, data);
      }
      // Feed the sniffer unconditionally so the live input line stays accurate
      // even for popped-out panes; the intent callback is what's optional.
      const prompt = sniffer.feed(data);
      if (prompt !== null) onIntentRef.current?.(paneId, prompt);
    });

    // Image paste. xterm's own paste path only understands text (an image
    // paste would otherwise vanish), so intercept in the capture phase: when
    // the clipboard carries image bytes, consume the event and route it — to
    // Claude's native `[Image #N]` chip on a host Claude pane, or to a staged
    // workspace file (`.flock/images/…`) otherwise. Plain-text pastes fall
    // through untouched to xterm.
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
      if (blobs.length === 0) return; // not an image paste — let xterm handle it
      e.preventDefault();
      e.stopImmediatePropagation();
      handleImagePaste(paneId, blobs).catch(console.error);
    };
    const pasteHost = containerRef.current;
    pasteHost?.addEventListener("paste", onPaste, true);

    // Copy on select, keyed off the *gesture* (left-button release after a
    // press that started in this pane) rather than xterm's onSelectionChange.
    // That event also fires when scrollback trim shifts a leftover selection —
    // including in hidden background panes, since every workspace stays
    // mounted — silently rewriting the clipboard with stale terminal text
    // long after the user last touched the pane. Gating on a gesture in the
    // focused, visible pane means only a deliberate selection copies. The
    // release is watched on window, not the container: dragging a long
    // selection routinely ends outside the pane. One write per gesture also
    // kills the old race where per-mousemove async writes could land out of
    // order and leave a partial selection on the clipboard.
    let selectionGesture = false;
    const onPointerDown = (e: PointerEvent) => {
      if (e.button === 0) selectionGesture = true;
    };
    const onPointerUp = () => {
      if (!selectionGesture) return;
      selectionGesture = false;
      if (!focusedRef.current || !visibleRef.current) return;
      const selection = term.getSelection();
      if (!selection) return;
      // A swallowed failure means the next paste emits whatever was on the
      // clipboard before, with no hint why — so surface it.
      copyText(selection).catch(() => flashPanePill(paneId, "copy failed", true));
    };
    pasteHost?.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerUp);

    // A plain drag selects, with no modifier. See lib/dragSelect.ts for why
    // this needs an arbitration layer at all: the agent has mouse reporting on
    // for the wheel's sake, and xterm refuses to start a selection while it
    // does. Registered in the CAPTURE phase on the container so it sees the
    // press before xterm's own listeners on the screen element inside it.
    const dragSelect = createDragSelect({
      screen: () => containerRef.current?.querySelector<HTMLElement>(".xterm-screen") ?? null,
      mouseReporting: () => term.modes.mouseTrackingMode !== "none",
      focus: () => term.focus(),
    });
    const onCaptureMouseDown = (e: MouseEvent) => dragSelect.onCaptureMouseDown(e);
    const onDragMove = (e: MouseEvent) => dragSelect.onMouseMove(e);
    const onDragUp = (e: MouseEvent) => dragSelect.onMouseUp(e);
    containerRef.current?.addEventListener("mousedown", onCaptureMouseDown, true);
    // On window, not the pane: a selection that runs off the edge of the pane
    // still has to finish, and a release outside it still has to be seen or
    // the next click would be treated as the tail of a gesture that never
    // ended.
    window.addEventListener("mousemove", onDragMove);
    window.addEventListener("mouseup", onDragUp);
    // A native window-drag, a workspace hide, or the webview losing focus
    // eats the mouseup. Drop the held press rather than leaving the pane
    // waiting for a release that will never come.
    const onDragCancel = () => dragSelect.cancel();
    window.addEventListener("pointercancel", onDragCancel);
    window.addEventListener("blur", onDragCancel);
    document.addEventListener("visibilitychange", onDragCancel);

    // macOS line-editing shortcuts. Terminal.app/iTerm2 bind these Cmd combos
    // to the readline control bytes the shell (and agent prompts) expect, but
    // xterm has no such mapping — a Cmd+arrow isn't a real escape sequence — so
    // they'd otherwise do nothing. Worse, returning false from this handler
    // only stops *xterm* from processing the key; the webview still runs its
    // own default, and macOS treats Cmd+← as a "go back" gesture. That's why
    // these felt flaky: sometimes the byte we send lands, sometimes the webview
    // eats the keystroke first. preventDefault() kills the webview default so
    // every one lands, every time.
    //   Cmd+Backspace → Ctrl+U (0x15)  kill line (whole line in zsh)
    //   Cmd+←         → Ctrl+A (0x01)  jump to start of line
    //   Cmd+→         → Ctrl+E (0x05)  jump to end of line
    const CMD_LINE_KEYS: Record<string, number> = {
      Backspace: 0x15,
      ArrowLeft: 0x01,
      ArrowRight: 0x05,
    };
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      if (!e.metaKey || e.altKey || e.ctrlKey) return true;
      const byte = CMD_LINE_KEYS[e.key];
      if (byte === undefined) return true;
      e.preventDefault();
      sendInput(paneId, new Uint8Array([byte])).catch(console.error);
      return false;
    });

    // Register BEFORE fit.fit() so the first resize event reaches resizePty.
    // If onResize is registered after fit.fit(), the initial resize fires into
    // the void (no handler yet) and subsequent fits see identical dimensions
    // so xterm skips re-firing — resizePty is never called.
    term.onResize(({ cols, rows }) => {
      // Only the on-screen instance drives the PTY. A borrowed pane has a
      // second mount in another workspace's tab, both always mounted, and if
      // a hidden one answered its ResizeObserver here the PTY would end up
      // sized for a tile nobody is looking at — the exact dims-drift this
      // file's comments warn about, with nothing left to correct it. The
      // same race is a popped-out pane: popOutPane removes the leaf only
      // from the tab you clicked, so the other workspace that still lays
      // that id out would stay visible in this webview while PoppedPaneWindow
      // (a second webview) also has visible={true}. PaneArea treats a live
      // pane-${id} window like hidden so only the pop-out calls resizePty.
      // A hidden instance's xterm may drift from the PTY instead, which the
      // reveal effect repairs with an explicit resync the moment it matters.
      if (!visibleRef.current) {
        // ...but resyncing the SIZE is not enough to repair the SCREEN, and
        // that gap is the "scrambled until you resize the window" bug.
        //
        // Reaching here means xterm just reflowed its buffer to a geometry the
        // agent was never told about — the window or a rail was resized, the
        // pane font size changed, or this workspace's own layout moved while it
        // sat in the background. xterm rewrapped the alt-screen contents to fit;
        // the agent, which owns every glyph in there, did not participate.
        //
        // On reveal the resync below does raise a real SIGWINCH, and for a
        // shell that is the end of it — the scrollback is xterm's own and xterm
        // rewrapped it correctly. An agent TUI is the opposite: flock launches
        // Claude Code with CLAUDE_CODE_NO_FLICKER=1, whose renderer is
        // *differential*. It repaints what it believes changed, and it believes
        // nothing changed except the size, so the rewrapped garbage underneath
        // is never overwritten. term.refresh() cannot help either — it faithfully
        // repaints xterm's buffer, and xterm's buffer is the corrupted thing.
        // Only the agent can regenerate that content, so only the agent can fix
        // it, and the one way to make it redraw everything is a size change it
        // cannot no-op.
        //
        // That is exactly what forceAgentRepaint is (+1 row, then back), and the
        // debt mechanism to defer it to reveal time already exists — it was just
        // never raised for this case, only for a pane that mounted hidden. So a
        // background workspace could drift with nothing recording that it had.
        // Resizing the window afterwards "fixed" it only because that is another
        // SIGWINCH, arriving when the pane happens to be visible.
        repaintOwedRef.current = true;
        return;
      }
      resizePty(paneId, rows, cols).catch(console.error);
      recordDims(paneId, cols, rows);
      publishDims(paneId, cols, rows);
    });

    term.open(containerRef.current);
    fit.fit();
    // Only now that the terminal is open can it take a renderer, and only if
    // this pane is the one on screen. A pane mounting into a background
    // workspace gets its context on first reveal instead.
    if (visibleRef.current) claimWebgl();

    // xterm measures glyph width via canvas at open() time. If the Hack
    // webfont (font-display: swap) hasn't finished loading yet, it
    // silently measures the fallback font instead and never re-measures
    // once the real font arrives — DOM text reflows automatically on a
    // font swap, but xterm's canvas does not. Force a re-fit + redraw
    // once the font is actually ready.
    document.fonts
      .load(`${term.options.fontSize}px "Hack"`)
      .catch(() => {})
      .finally(() => {
        fit.fit();
        term.refresh(0, term.rows - 1);
      });

    // Bind backend PTY output → xterm. `cancelled` guards the async
    // registrations against unmount-before-resolve (StrictMode remounts,
    // fast pane churn) — otherwise the resolved subscription leaks with
    // nothing holding its unsubscribe fn.
    let cancelled = false;
    let unsubOutput: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;

    // Restored session: if App stashed this pane's pre-restart scrollback
    // (agents that don't resume themselves — opencode/codex), paint it first
    // as read-only history, above whatever the freshly spawned process prints.
    const history = getRestoreHistory(paneId);
    if (history && history.length > 0) {
      term.write(history);
      term.write("\r\n\x1b[2m──────────  previous session restored  ──────────\x1b[0m\r\n");
    }

    // Boot card lifecycle. The grace timer covers the case the scanner can't:
    // an agent that is launched and then says nothing at all, where waiting for
    // a paint would mean waiting forever.
    const boot = new BootScanner();
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const agentStarted = () => {
      clearTimeout(graceTimer);
      graceTimer = undefined;
      onAgentStartRef.current?.(paneId);
    };

    // Adopting an already-running PTY (popout window, pane returning to the
    // grid) must not depend on the agent redrawing at the right moment — that's
    // a race we lost in both directions before. The subscribe is deterministic:
    // the backend sends the output-ring snapshot (the current screen) as the
    // first frame, atomically with joining the live set, so the snapshot and
    // live bytes arrive in order over one ordered channel — nothing is lost or
    // double-written, and there's no seq bookkeeping to get wrong.
    subscribePaneOutput(paneId, (data) => {
      // Exactly once per pane: a borrowed pane's second mount receives the
      // same bytes on its own subscription, and mirroring from both meant a
      // remote viewer saw every byte twice.
      if (primaryRef.current) publishBytes(paneId, data); // mirror to co-pilot/observe streams
      // Before the visibility branch: a pane whose workspace is in the
      // background still boots, and its card has to lift on its own.
      const signal = boot.feed(data);
      if (signal === "start") agentStarted();
      else if (signal === "armed") graceTimer = setTimeout(agentStarted, PAINT_GRACE_MS);
      // Hidden pane (background workspace or background tab): hold the bytes
      // and render them once, on reveal. Every pane of every workspace stays
      // mounted and keeps streaming, so without this a user looking at one
      // 12-pane grid also pays to repaint every pane of every *other* tab and
      // workspace — measured at roughly a 40% share of main-thread blocking
      // time. The mirrors above stay live, so status, co-pilot streams and the
      // attention pills are unaffected by the deferral.
      if (!visibleRef.current) {
        pendingRef.current.push(data);
        pendingBytesRef.current += data.length;
        // Keep at least one chunk so a single oversized batch still paints.
        while (pendingBytesRef.current > MAX_PENDING_BYTES && pendingRef.current.length > 1) {
          pendingBytesRef.current -= pendingRef.current.shift()!.length;
          pendingTruncatedRef.current = true;
        }
        return;
      }
      writeLive(data);
    }, true).then((fn) => {
      if (cancelled) { fn(); return; }
      unsubOutput = fn;
      // Belt-and-braces: the ring can begin mid-escape-sequence, so ask the
      // TUI itself for one authoritative repaint. By now the subscription is
      // live, so unlike the pre-open fit() redraw, this one can't be lost.
      // Hidden mounts hold the debt instead of SIGWINCHing a PTY that another,
      // visible instance may be sized to; the reveal effect settles it.
      if (visibleRef.current) forceAgentRepaint(paneId, term);
      else repaintOwedRef.current = true;
    });
    onPtyExit(paneId, (code) => {
      // Ahead of the notice, or it lands in front of the agent's last words.
      flushLive();
      term.write(`\r\n\x1b[2m[process exited with code ${code}]\x1b[0m\r\n`);
      // Whatever it died of, the user needs to see it, not a boot card.
      agentStarted();
    }).then((fn) => {
      if (cancelled) { fn(); return; }
      unlistenExit = fn;
    });

    // Resize observer for container size changes. Keep the tail pinned across
    // the reflow so a resize mid-answer doesn't strand output above the fold.
    const ro = new ResizeObserver(() => {
      fitKeepingBottom(term, fit);
    });
    ro.observe(containerRef.current);

    // Live-update colors when the user switches themes in Settings.
    const unsubscribeTheme = onThemeChange((theme) => {
      term.options.theme = getXtermTheme(theme);
    });

    // Live-update font size when the user changes agent pane text size (in
    // Settings, or with ⌘+ / ⌘-). Fewer/more columns fit, so the pty has to
    // hear about it — fitKeepingBottom re-fits and pins the tail, which is
    // what keeps a mid-answer resize from stranding output above the fold.
    const unsubscribeScale = onPaneFontSizeChange((px) => {
      term.options.fontSize = px;
      fitKeepingBottom(term, fit);
    });

    return () => {
      cancelled = true;
      clearTimeout(graceTimer);
      if (liveTimerRef.current !== null) clearTimeout(liveTimerRef.current);
      liveTimerRef.current = null;
      liveRef.current = [];
      ro.disconnect();
      pasteHost?.removeEventListener("paste", onPaste, true);
      pasteHost?.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      containerRef.current?.removeEventListener("mousedown", onCaptureMouseDown, true);
      window.removeEventListener("mousemove", onDragMove);
      window.removeEventListener("mouseup", onDragUp);
      window.removeEventListener("pointercancel", onDragCancel);
      window.removeEventListener("blur", onDragCancel);
      document.removeEventListener("visibilitychange", onDragCancel);
      dragSelect.dispose();
      unsubscribeTheme();
      unsubscribeScale();
      if (unsubOutput) unsubOutput();
      if (unlistenExit) unlistenExit();
      unregisterSniffer(paneId, sniffer);
      unregisterTerminal(paneId, term);
      snifferRef.current = null;
      // Before term.dispose(), which disposes loaded addons itself but knows
      // nothing about the shared budget this one was drawn from.
      releaseWebgl();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [paneId]);

  // Focus xterm when it becomes the active pane — and also when it becomes
  // *visible* while already being the active pane. Without the `visible`
  // dep, switching tabs/workspaces never re-focuses the revealed terminal
  // (its `focused` prop never transitioned — it was focused all along, just
  // hidden), so keystrokes go nowhere until the user clicks the pane.
  useEffect(() => {
    if (focused && visible && termRef.current) {
      termRef.current.focus();
    }
  }, [focused, visible]);

  // Force a hard redraw when this pane's workspace becomes visible again.
  // Re-fitting alone isn't enough: if the container's measured size didn't
  // actually change while hidden, fit() is a no-op and the stale canvas
  // never gets touched — term.refresh() forces the repaint unconditionally.
  useEffect(() => {
    if (!visible) {
      // Anything still inside the write gap belongs on screen *before* this
      // pane starts holding output back for its reveal, or the two backlogs
      // interleave and the pane repaints in the wrong order. At most one gap's
      // worth of bytes, so writing it to a pane about to be hidden is not the
      // repeated waste the reveal-time flush exists to avoid.
      flushLive();
      // Drop any leftover selection when the workspace is hidden. Belt and
      // braces with the gesture gate above: a live selection in a hidden pane
      // keeps tracking buffer trims, and there's nothing it could legitimately
      // be for once the pane is off-screen.
      termRef.current?.clearSelection();
      // A hidden pane renders to nothing, so its context is pure cost — and
      // holding it is what would starve the grid the user actually switched to.
      releaseWebgl();
      return;
    }
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    // The registry follows the instance the user can see: for a borrowed pane
    // (two mounts, one pane id) this is what makes Copy read the selection the
    // user just dragged, in whichever tab they dragged it.
    registerTerminal(paneId, term);
    if (snifferRef.current) registerSniffer(paneId, snifferRef.current);
    // Ahead of the backlog flush: painting it through the GPU renderer is the
    // whole point, and a reveal after a busy spell is the largest single write
    // a pane ever does.
    claimWebgl();
    // One pane per frame. A workspace switch used to flush every backlog
    // in this turn and the main thread would not accept clicks until it
    // had parsed the lot.
    return enqueueRevealFlush(() => {
      if (!visibleRef.current || termRef.current !== term) return;
      // Paint the backlog first so the refit and forced redraw below land on the
      // finished buffer rather than on a screen that is about to change.
      flushPending();
      requestAnimationFrame(() => {
        if (!visibleRef.current || termRef.current !== term) return;
        try {
          // Retry a claim the line above may have lost: on a workspace switch
          // React runs these effects in tree order, so when the revealed
          // workspace comes earlier in the array its claims ran before the
          // hidden one's releases and were refused at the cap. By this frame
          // every release has run — without the retry the losing panes stayed
          // on the DOM renderer until their next hide/reveal cycle, and the
          // same switch reproduced the same starvation every time.
          claimWebgl();
          fitKeepingBottom(term, fit);
          // Explicit resync, reading the dims fresh (never across an await —
          // see forceAgentRepaint): while this instance was hidden it stopped
          // driving the PTY, and a borrowed pane's other mount may have sized
          // it for a different tile. If the dims already agree this is a no-op
          // (same-size TIOCSWINSZ raises no SIGWINCH); if they drifted, this is
          // the one place that corrects them.
          resizePty(paneId, term.rows, term.cols).catch(console.error);
          if (repaintOwedRef.current) {
            repaintOwedRef.current = false;
            forceAgentRepaint(paneId, term);
          }
          term.refresh(0, term.rows - 1);
        } catch {
          /* ignore */
        }
      });
    });
  }, [visible]);

  return (
    <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
  );
}

// The heaviest leaf (one xterm per pane, all workspaces kept mounted). Its
// props are stable — paneId is fixed, focused/visible are booleans that only
// change on real focus/visibility transitions, and onIntentCaptured is a
// useCallback in App. So memo skips re-running every terminal on unrelated App
// re-renders (notifications, dialogs, other panes' status), while still
// re-rendering on an actual focus/visibility change.
export default memo(Terminal);
