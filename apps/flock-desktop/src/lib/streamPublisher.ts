import type Ably from "ably";
import { resizePty, sendInput } from "./tauri";
import { noteInjectedInput } from "./terminalRegistry";

interface StreamState {
  channel: Ably.RealtimeChannel;
  buffer: Uint8Array[];
  bufferedBytes: number;
  flushTimer: number | null;
  paneId: string;
  lastCols: number;
  lastRows: number;
  unsubReady?: () => void;
  unsubInput?: () => void;
}

const activeStreams = new Map<string, StreamState>();
/** Latest known PTY dims for every pane, kept up-to-date by Terminal.tsx. */
const knownDims = new Map<string, { cols: number; rows: number }>();

/** Owner's Terminal records its current dims here so startStream can publish them. */
export function recordDims(paneId: string, cols: number, rows: number) {
  knownDims.set(paneId, { cols, rows });
}

// Batch output: publish at most ~20/sec per pane, well under Ably's 50/sec
// per-connection limit even with multiple panes streaming.
const FLUSH_INTERVAL_MS = 60;
const MAX_BUFFER_BYTES = 16 * 1024;

function flush(paneId: string) {
  const s = activeStreams.get(paneId);
  if (!s || s.buffer.length === 0) return;
  // Concatenate buffered chunks into one Uint8Array
  const total = new Uint8Array(s.bufferedBytes);
  let offset = 0;
  for (const chunk of s.buffer) {
    total.set(chunk, offset);
    offset += chunk.length;
  }
  s.buffer = [];
  s.bufferedBytes = 0;
  if (s.flushTimer !== null) {
    clearTimeout(s.flushTimer);
    s.flushTimer = null;
  }
  // Ably encodes Uint8Array as base64 over the wire automatically
  s.channel.publish("data", total).catch(() => {});
}

export interface StartStreamOptions {
  /** Co-pilot streams accept typed input from the remote side; observe
   * streams are strictly read-only. */
  allowInput?: boolean;
  /** The one clientId (partner handle) whose keystrokes we accept. Ably stamps
   * the publisher's verified clientId on every message, so this gates input to
   * the actual co-pilot partner — anyone else who learned the channel name is
   * ignored. Required for input to be honored at all. */
  allowedInputFrom?: string;
}

/** Publish dims + clear + a SIGWINCH-forced redraw so a (re)joining viewer
 * gets a correctly sized, fully painted screen. Runs on stream start and
 * again on every "ready" a viewer sends after subscribing — Ably does not
 * replay messages for late subscribers, which is exactly what a viewer is:
 * they attach only after the accept message round-trips. */
async function bootstrapViewer(state: StreamState) {
  const { paneId, channel } = state;
  // A pane spawned moments ago may not have mounted its Terminal yet, so
  // its dims aren't recorded — wait briefly rather than skipping.
  let dims = knownDims.get(paneId);
  for (let i = 0; !dims && i < 10; i++) {
    await new Promise((r) => setTimeout(r, 200));
    dims = knownDims.get(paneId);
  }
  if (!dims || !activeStreams.has(paneId)) return;

  state.lastCols = dims.cols;
  state.lastRows = dims.rows;

  // 1. Tell the viewer how to size their grid
  await channel.publish("dims", dims).catch(() => {});
  // 2. Clear the viewer's terminal so stale partial frames vanish
  const clear = new TextEncoder().encode("\x1b[H\x1b[2J\x1b[3J");
  await channel.publish("data", clear).catch(() => {});
  // 3. Toggle PTY rows by 1 to fire SIGWINCH and force the source app to
  //    redraw. Toggling rows (not cols) avoids reflowing line widths so
  //    the owner's view only flickers vertically for a frame.
  //    Re-read knownDims at each call — a fit can land between the two
  //    awaits and a captured pair would undo it (see forceAgentRepaint).
  await new Promise((r) => setTimeout(r, 40));
  const bump = knownDims.get(paneId) ?? dims;
  await resizePty(paneId, bump.rows + 1, bump.cols).catch(() => {});
  await new Promise((r) => setTimeout(r, 40));
  const restore = knownDims.get(paneId) ?? bump;
  await resizePty(paneId, restore.rows, restore.cols).catch(() => {});
  state.lastCols = restore.cols;
  state.lastRows = restore.rows;
}

export function startStream(paneId: string, channel: Ably.RealtimeChannel, opts: StartStreamOptions = {}) {
  const state: StreamState = {
    channel, buffer: [], bufferedBytes: 0, flushTimer: null, paneId,
    lastCols: 0, lastRows: 0,
  };
  activeStreams.set(paneId, state);

  // requestFit is unused on purpose. A remote fit must never drive the
  // owner's PTY: the owner's Terminal has its own size, and resizing here
  // is the same hazard as capturing rows/cols across an await.

  // Every viewer announces itself after subscribing; re-run the bootstrap
  // so late joiners and re-mounts get a clean, correctly sized frame.
  const readyHandler = () => { bootstrapViewer(state); };
  channel.subscribe("ready", readyHandler);
  state.unsubReady = () => channel.unsubscribe("ready", readyHandler);

  // Co-pilot: the partner's keystrokes land in this PTY. Gate strictly on the
  // publisher's Ably-verified clientId — a third party who learned the channel
  // UUID must never be able to inject input (that would be remote code
  // execution, since agents run with permission-bypass flags).
  if (opts.allowInput && opts.allowedInputFrom) {
    const allowedFrom = opts.allowedInputFrom;
    const inputHandler = (msg: Ably.Message) => {
      if (msg.clientId !== allowedFrom) return;
      const text = (msg.data as { text?: string } | undefined)?.text;
      if (typeof text !== "string" || text.length === 0 || text.length > 4096) return;
      sendInput(paneId, new TextEncoder().encode(text)).catch(() => {});
      // The partner's keystrokes never pass through our xterm, so mirror them
      // into the input-line sniffer — otherwise the owner's "Send to Prompt
      // Queue" would only see the half of the line they typed themselves.
      noteInjectedInput(paneId, text);
    };
    channel.subscribe("input", inputHandler);
    state.unsubInput = () => channel.unsubscribe("input", inputHandler);
  }

  bootstrapViewer(state);
}

/** Owner publishes their current PTY dimensions so observers can match grid. */
export function publishDims(paneId: string, cols: number, rows: number) {
  const s = activeStreams.get(paneId);
  if (!s) return;
  if (cols === s.lastCols && rows === s.lastRows) return;
  s.lastCols = cols;
  s.lastRows = rows;
  s.channel.publish("dims", { cols, rows }).catch(() => {});
}

export function stopStream(paneId: string) {
  const s = activeStreams.get(paneId);
  if (!s) return;
  if (s.flushTimer !== null) clearTimeout(s.flushTimer);
  flush(paneId); // send any pending bytes before detaching
  s.unsubReady?.();
  s.unsubInput?.();
  s.channel.detach().catch(() => {});
  activeStreams.delete(paneId);
}

/** Called by Terminal.tsx on every PTY output event. Batches into ~60ms windows. */
export function publishBytes(paneId: string, bytes: Uint8Array) {
  const s = activeStreams.get(paneId);
  if (!s) return;
  s.buffer.push(bytes);
  s.bufferedBytes += bytes.length;
  // Flush immediately if the buffer grows large
  if (s.bufferedBytes >= MAX_BUFFER_BYTES) {
    flush(paneId);
    return;
  }
  // Otherwise schedule a flush
  if (s.flushTimer === null) {
    s.flushTimer = window.setTimeout(() => flush(paneId), FLUSH_INTERVAL_MS);
  }
}

export function isStreaming(paneId: string): boolean {
  return activeStreams.has(paneId);
}
