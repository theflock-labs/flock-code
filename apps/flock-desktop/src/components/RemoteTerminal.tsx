import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { createDragSelect } from "../lib/dragSelect";
import { getAblyClient } from "../lib/presence";
import { subscribeToStream } from "../lib/session";
import { getEffectiveTheme, getXtermTheme, TERMINAL_FONT_FAMILY } from "../lib/theme";

interface Props {
  streamId: string;
  focused: boolean;
  /** Co-pilot panes accept typing (keystrokes travel to the owner's PTY);
   * observe panes are strictly read-only. */
  interactive?: boolean;
}

/**
 * An xterm that renders bytes published to `flock:stream:{streamId}`.
 * Sizes its grid to match the source PTY (received via "dims") so cursor
 * positioning lands on the right cell; the container CSS-scales the xterm
 * to fit the available space.
 *
 * On mount it publishes "ready" — the owner replies with dims, a clear, and
 * a forced redraw. Without that handshake a viewer only ever sees output
 * produced after it attached, painted on a default 80x24 grid: the garbled
 * half-screen bug. Ably does not replay messages to late subscribers.
 */
export default function RemoteTerminal({ streamId, focused, interactive }: Props) {
  const outerRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);

  useEffect(() => {
    if (!containerRef.current || !outerRef.current) return;
    const term = new XTerm({
      scrollback: 1500,
      fontSize: 13,
      fontFamily: TERMINAL_FONT_FAMILY,
      lineHeight: 1.1,
      theme: getXtermTheme(getEffectiveTheme()),
      disableStdin: !interactive,
      cursorBlink: !!interactive,
      // Same reason as Terminal.tsx: an agent in mouse-reporting mode takes
      // every drag, so without this there is no way to select the output. An
      // observed pane is read-only, which makes copying out of it the ONLY
      // thing you can do with one.
      macOptionClickForcesSelection: true,
    });
    term.open(containerRef.current);
    termRef.current = term;

    // Plain drag selects here too. A mirrored pane is the one people are most
    // likely to want to copy out of, since it is someone else's output they
    // cannot scroll back to on their own machine. See lib/dragSelect.ts.
    const dragSelect = createDragSelect({
      screen: () => containerRef.current?.querySelector<HTMLElement>(".xterm-screen") ?? null,
      mouseReporting: () => term.modes.mouseTrackingMode !== "none",
      focus: () => term.focus(),
    });
    const onCaptureMouseDown = (e: MouseEvent) => dragSelect.onCaptureMouseDown(e);
    const onDragMove = (e: MouseEvent) => dragSelect.onMouseMove(e);
    const onDragUp = (e: MouseEvent) => dragSelect.onMouseUp(e);
    const dragHost = containerRef.current;
    dragHost.addEventListener("mousedown", onCaptureMouseDown, true);
    window.addEventListener("mousemove", onDragMove);
    window.addEventListener("mouseup", onDragUp);

    // CSS transform-scale the xterm to fill its outer container
    const fitToOuter = () => {
      if (!outerRef.current || !containerRef.current) return;
      const inner = containerRef.current.firstElementChild as HTMLElement | null;
      if (!inner) return;
      const ow = outerRef.current.clientWidth;
      const oh = outerRef.current.clientHeight;
      const iw = inner.scrollWidth || inner.clientWidth;
      const ih = inner.scrollHeight || inner.clientHeight;
      if (iw === 0 || ih === 0) return;
      const scale = Math.min(ow / iw, oh / ih);
      containerRef.current.style.transform = `scale(${scale})`;
    };

    const client = getAblyClient();
    const ch = client?.channels.get(`flock:stream:${streamId}`) ?? null;

    // Grid sizing from the owner
    let unsubDims = () => {};
    if (ch) {
      const dimsHandler = (msg: { data?: { cols?: number; rows?: number } }) => {
        const { cols, rows } = msg.data ?? {};
        if (typeof cols === "number" && typeof rows === "number") {
          term.resize(cols, rows);
          requestAnimationFrame(fitToOuter);
        }
      };
      ch.subscribe("dims", dimsHandler);
      unsubDims = () => ch.unsubscribe("dims", dimsHandler);
    }

    const unsubData = subscribeToStream(streamId, (bytes) => {
      term.write(bytes);
      requestAnimationFrame(fitToOuter);
    });

    // Handshake: tell the owner we're attached so it re-sends dims and
    // forces a full redraw. attach() first so nothing published in response
    // can race past us.
    if (ch) {
      ch.attach()
        .then(() => ch.publish("ready", { at: Date.now() }))
        .catch(() => {});
    }

    // Co-pilot: forward keystrokes to the owner's PTY.
    let inputDisposer: { dispose(): void } | null = null;
    if (interactive && ch) {
      inputDisposer = term.onData((data) => {
        ch.publish("input", { text: data }).catch(() => {});
      });
    }

    const ro = new ResizeObserver(fitToOuter);
    ro.observe(outerRef.current);
    requestAnimationFrame(fitToOuter);
    setTimeout(fitToOuter, 80);

    return () => {
      dragHost.removeEventListener("mousedown", onCaptureMouseDown, true);
      window.removeEventListener("mousemove", onDragMove);
      window.removeEventListener("mouseup", onDragUp);
      dragSelect.dispose();
      unsubDims();
      unsubData();
      inputDisposer?.dispose();
      ro.disconnect();
      term.dispose();
      termRef.current = null;
    };
  }, [streamId, interactive]);

  // Interactive panes take keyboard focus like local terminals do.
  useEffect(() => {
    if (focused && interactive) termRef.current?.focus();
  }, [focused, interactive]);

  return (
    <div className={`terminal-pane remote-pane${focused ? " focused" : ""}`}
         style={{ width: "100%", height: "100%", position: "relative" }}>
      <div className="remote-pane-badge">{interactive ? "SHARED" : "LIVE"}</div>
      <div ref={outerRef} className="remote-outer">
        <div ref={containerRef} className="remote-inner" />
      </div>
    </div>
  );
}
