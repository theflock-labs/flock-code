import type Ably from "ably";
import { getAblyClient } from "./presence";
import { MY_WINDOW_ID } from "./windowId";

/** Per-recipient inbox channel for directed session-control messages. Directed
 *  traffic rides these instead of the shared presence channel, so a message
 *  (and the stream UUIDs it carries) reaches only its addressee. The Ably token
 *  grants subscribe on the caller's own inbox only. */
function inboxChannel(login: string): string { return `flock:inbox:${login}`; }

// ─── Message types ────────────────────────────────────────────────────────────

export interface CopilotPane { id: string; label: string; }

// Every message carries window IDs so both windows with the same login
// can route correctly in the self-test (and in real use with multiple devices).
interface MsgBase {
  from: string;
  to: string;
  from_wid: string; // sender's MY_WINDOW_ID
  to_wid: string;   // recipient's windowId from presence data
}

export type SessionMsg =
  | MsgBase & { type: "observe_request";  session_id: string }
  | MsgBase & { type: "observe_accept";   session_id: string; pane_label: string }
  | MsgBase & { type: "observe_decline";  session_id: string }
  | MsgBase & { type: "observe_end";      session_id: string }
  | MsgBase & { type: "task_send";        task_id: string; prompt: string }
  | MsgBase & { type: "task_accept";      task_id: string }
  | MsgBase & { type: "task_decline";     task_id: string }
  | MsgBase & { type: "copilot_invite";   session_id: string; panes: CopilotPane[] }
  | MsgBase & { type: "copilot_accept";   session_id: string; panes: CopilotPane[] }
  | MsgBase & { type: "copilot_layout";   session_id: string; panes: CopilotPane[] }
  | MsgBase & { type: "copilot_end";      session_id: string };

export type SessionHandler = (msg: SessionMsg) => void;

// ─── Module state ─────────────────────────────────────────────────────────────

let myLogin = "";

// ─── Init ─────────────────────────────────────────────────────────────────────

export function initSessions(login: string, onMsg: SessionHandler): () => void {
  myLogin = login;
  const client = getAblyClient();
  if (!client) return () => {};

  const inbox = client.channels.get(inboxChannel(login));
  const handler = (ablyMsg: Ably.Message) => {
    const data = ablyMsg.data as SessionMsg | undefined;
    if (!data) return;
    // Authenticity: Ably stamps every message with the publisher's verified
    // clientId, and the token forbids publishing under any other clientId. A
    // self-declared `from` that doesn't match is a spoof attempt (someone
    // impersonating a trusted friend) — drop it. Authorization (is the sender
    // actually a friend) is enforced by the message handler in App.tsx, which
    // can now trust `from` because of this check.
    if (data.from !== ablyMsg.clientId) return;
    // Route: must be addressed to us by login AND by window ID
    if (data.to !== myLogin) return;
    if (data.to_wid && data.to_wid !== MY_WINDOW_ID) return;
    onMsg(data);
  };

  inbox.subscribe("session", handler);
  return () => { inbox.unsubscribe("session", handler); inbox.detach().catch(() => {}); };
}

// ─── Send helper ──────────────────────────────────────────────────────────────

function publish(msg: SessionMsg) {
  getAblyClient()?.channels.get(inboxChannel(msg.to)).publish("session", msg);
}

function base(toLogin: string, toWid: string): MsgBase {
  return { from: myLogin, to: toLogin, from_wid: MY_WINDOW_ID, to_wid: toWid };
}

// ─── Observe ──────────────────────────────────────────────────────────────────

export function requestObserve(toLogin: string, toWid: string): string {
  const session_id = crypto.randomUUID();
  publish({ ...base(toLogin, toWid), type: "observe_request", session_id });
  return session_id;
}

export async function acceptObserve(
  toLogin: string,
  toWid: string,
  session_id: string,
  paneId: string,
  paneLabel: string,
): Promise<void> {
  const client = getAblyClient();
  if (client) {
    const { startStream } = await import("./streamPublisher");
    const ch = client.channels.get(`flock:stream:${session_id}`);
    await ch.attach();
    startStream(paneId, ch);
  }
  publish({ ...base(toLogin, toWid), type: "observe_accept", session_id, pane_label: paneLabel });
}

export function declineObserve(toLogin: string, toWid: string, session_id: string) {
  publish({ ...base(toLogin, toWid), type: "observe_decline", session_id });
}

export function endObserve(toLogin: string, toWid: string, session_id: string, paneId?: string) {
  if (paneId) import("./streamPublisher").then(({ stopStream }) => stopStream(paneId));
  publish({ ...base(toLogin, toWid), type: "observe_end", session_id });
}

/** Unused. A remote fit must never drive the owner's PTY — the owner's
 * Terminal has its own size, and resizing from here is the same hazard as
 * capturing rows/cols across an await. Left exported so a viewer can still
 * publish "fit" without anything on this side honoring it. */
export function requestFit(streamId: string, cols: number, rows: number): void {
  const client = getAblyClient();
  if (!client) return;
  const ch = client.channels.get(`flock:stream:${streamId}`);
  ch.publish("fit", { cols, rows }).catch(() => {});
}

export function subscribeToStream(
  session_id: string,
  onBytes: (bytes: Uint8Array) => void,
): () => void {
  const client = getAblyClient();
  if (!client) return () => {};
  const ch = client.channels.get(`flock:stream:${session_id}`);
  const handler = (msg: any) => {
    try {
      const bytes = typeof msg.data === "string"
        ? Uint8Array.from(atob(msg.data), (c) => c.charCodeAt(0))
        : msg.data instanceof ArrayBuffer
        ? new Uint8Array(msg.data)
        : msg.data instanceof Uint8Array
        ? msg.data
        : null;
      if (bytes) onBytes(bytes);
    } catch { /* ignore decode errors */ }
  };
  ch.subscribe("data", handler);
  return () => { ch.unsubscribe("data", handler); ch.detach().catch(() => {}); };
}

// ─── Task handoff ─────────────────────────────────────────────────────────────

export function sendTask(toLogin: string, toWid: string, prompt: string): string {
  const task_id = crypto.randomUUID();
  publish({ ...base(toLogin, toWid), type: "task_send", task_id, prompt });
  return task_id;
}

export function acceptTask(toLogin: string, toWid: string, task_id: string) {
  publish({ ...base(toLogin, toWid), type: "task_accept", task_id });
}

export function declineTask(toLogin: string, toWid: string, task_id: string) {
  publish({ ...base(toLogin, toWid), type: "task_decline", task_id });
}

// ─── Co-pilot ─────────────────────────────────────────────────────────────────

export async function inviteCopilot(
  toLogin: string,
  toWid: string,
  panes: CopilotPane[],
): Promise<string> {
  const session_id = crypto.randomUUID();
  const client = getAblyClient();
  if (client) {
    const { startStream } = await import("./streamPublisher");
    for (const p of panes) {
      const ch = client.channels.get(`flock:stream:${p.id}`);
      await ch.attach();
      // Only the invited partner (toLogin) may type into our panes.
      startStream(p.id, ch, { allowInput: true, allowedInputFrom: toLogin });
    }
  }
  publish({ ...base(toLogin, toWid), type: "copilot_invite", session_id, panes });
  return session_id;
}

export async function acceptCopilot(
  toLogin: string,
  toWid: string,
  session_id: string,
  myPanes: CopilotPane[],
): Promise<void> {
  const client = getAblyClient();
  if (client) {
    const { startStream } = await import("./streamPublisher");
    for (const p of myPanes) {
      const ch = client.channels.get(`flock:stream:${p.id}`);
      await ch.attach();
      // Only the co-pilot partner (toLogin) may type into our panes.
      startStream(p.id, ch, { allowInput: true, allowedInputFrom: toLogin });
    }
  }
  publish({ ...base(toLogin, toWid), type: "copilot_accept", session_id, panes: myPanes });
}

export async function endCopilot(
  toLogin: string,
  toWid: string,
  session_id: string,
  myPaneIds: string[],
): Promise<void> {
  const { stopStream } = await import("./streamPublisher");
  myPaneIds.forEach(stopStream);
  publish({ ...base(toLogin, toWid), type: "copilot_end", session_id });
}

export function syncCopilotLayout(toLogin: string, toWid: string, session_id: string, panes: CopilotPane[]) {
  publish({ ...base(toLogin, toWid), type: "copilot_layout", session_id, panes });
}
