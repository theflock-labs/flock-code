import type Ably from "ably";
import { getAblyClient, getStreamGrant, getRealtimeIdentity, peerId, verifiedHandle, refreshAuthorization } from "./presence";
import { supabase } from "./flockId";
import { MY_WINDOW_ID } from "./windowId";

/** Per-recipient inbox channel for directed session-control messages. Directed
 *  traffic rides these instead of the shared presence channel, so a message
 *  (and the stream UUIDs it carries) reaches only its addressee. The Ably token
 *  grants subscribe on the caller's own inbox only. */
function inboxChannel(login: string): string {
  const id = peerId(login);
  if (!id) throw new Error("accepted friendship required");
  return `flock:inbox:${id}`;
}

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
const sessionPeers = new Map<string, string>();

// ─── Init ─────────────────────────────────────────────────────────────────────

export function initSessions(login: string, onMsg: SessionHandler): () => void {
  myLogin = login;
  sessionPeers.clear();
  const client = getAblyClient();
  if (!client) return () => {};

  const inbox = client.channels.get(inboxChannel(login));
  const handler = async (ablyMsg: Ably.Message) => {
    const data = ablyMsg.data as SessionMsg | undefined;
    if (!data || typeof data !== "object" || typeof data.type !== "string") return;
    if ("session_id" in data && (typeof data.session_id !== "string" || !/^[0-9a-f-]{36}$/i.test(data.session_id))) return;
    if ("panes" in data && (!Array.isArray(data.panes) || data.panes.length > 64 || data.panes.some(p =>
        !p || typeof p.id !== "string" || typeof p.label !== "string" || p.label.length > 256))) return;
    if (data.type === "task_send" && (typeof data.prompt !== "string" || data.prompt.length > 64 * 1024)) return;
    // Authenticity: Ably stamps every message with the publisher's verified
    // clientId, and the token forbids publishing under any other clientId. A
    // self-declared `from` that doesn't match is a spoof attempt (someone
    // impersonating a trusted friend) — drop it. Authorization (is the sender
    // actually a friend) is enforced by the message handler in App.tsx, which
    // can now trust `from` because of this check.
    if (data.from !== verifiedHandle(ablyMsg.clientId)) return;
    // Route: must be addressed to us by login AND by window ID
    if (data.to !== myLogin) return;
    if (data.to_wid && data.to_wid !== MY_WINDOW_ID) return;
    if ("session_id" in data && !["observe_request", "copilot_invite"].includes(data.type)
        && sessionPeers.get(data.session_id) !== ablyMsg.clientId) return;
    if ("session_id" in data && sessionPeers.has(data.session_id)
        && sessionPeers.get(data.session_id) !== ablyMsg.clientId) return;
    // Authorize newly accepted layouts before mounting any remote terminal.
    if (["observe_accept", "copilot_invite", "copilot_accept", "copilot_layout"].includes(data.type)) {
      try { await refreshAuthorization(); } catch { return; }
      if (data.from !== verifiedHandle(ablyMsg.clientId)) return;
    }
    if (data.type === "observe_accept") {
      const grant = getStreamGrant(data.session_id);
      if (!grant || grant.owner_id !== ablyMsg.clientId || grant.viewer_id !== getRealtimeIdentity()?.id
          || grant.session_id !== data.session_id) return;
    }
    if ("panes" in data && data.panes.some(p => {
      const grant = getStreamGrant(p.id);
      return !grant || grant.owner_id !== ablyMsg.clientId || grant.viewer_id !== getRealtimeIdentity()?.id
        || grant.session_id !== data.session_id;
    })) return;
    if (data.type === "observe_end" || data.type === "copilot_end") {
      void revokeSession(data.session_id).catch(() => {});
    }
    onMsg(data);
  };

  inbox.subscribe("session", handler);
  return () => { inbox.unsubscribe("session", handler); inbox.detach().catch(() => {}); };
}

// ─── Send helper ──────────────────────────────────────────────────────────────

async function publish(msg: SessionMsg): Promise<void> {
  const client = getAblyClient();
  if (!client) throw new Error("presence is not connected");
  await client.channels.get(inboxChannel(msg.to)).publish("session", msg);
}
function send(msg: SessionMsg): void {
  void publish(msg).catch(() => console.error("Session message could not be delivered"));
}
async function publishShared(msg: SessionMsg & { session_id: string }, prepare: () => Promise<void> = async () => {}): Promise<void> {
  try { await prepare(); await publish(msg); }
  catch (error) {
    await revokeSession(msg.session_id).catch(() => {});
    throw error;
  }
}

function base(toLogin: string, toWid: string): MsgBase {
  return { from: myLogin, to: toLogin, from_wid: MY_WINDOW_ID, to_wid: toWid };
}

// ─── Observe ──────────────────────────────────────────────────────────────────

export function requestObserve(toLogin: string, toWid: string): string {
  const session_id = crypto.randomUUID();
  sessionPeers.set(session_id, peerId(toLogin) ?? "");
  send({ ...base(toLogin, toWid), type: "observe_request", session_id });
  return session_id;
}

export async function acceptObserve(
  toLogin: string,
  toWid: string,
  session_id: string,
  paneId: string,
  paneLabel: string,
): Promise<void> {
  sessionPeers.set(session_id, peerId(toLogin) ?? "");
  await publishShared({ ...base(toLogin, toWid), type: "observe_accept", session_id, pane_label: paneLabel },
    () => shareStream(toLogin, session_id, session_id, paneId, false));
}

export function declineObserve(toLogin: string, toWid: string, session_id: string) {
  send({ ...base(toLogin, toWid), type: "observe_decline", session_id });
}

export function endObserve(toLogin: string, toWid: string, session_id: string, paneId?: string) {
  if (paneId) import("./streamPublisher").then(({ stopStream }) => stopStream(paneId));
  void revokeSession(session_id).catch(() => {});
  send({ ...base(toLogin, toWid), type: "observe_end", session_id });
}

/** Unused. A remote fit must never drive the owner's PTY — the owner's
 * Terminal has its own size, and resizing from here is the same hazard as
 * capturing rows/cols across an await. Left exported so a viewer can still
 * publish "fit" without anything on this side honoring it. */
export function requestFit(_streamId: string, _cols: number, _rows: number): void {}

export function streamChannels(streamId: string) {
  const client = getAblyClient();
  const grant = getStreamGrant(streamId);
  if (!client || !grant) return null;
  const prefix = `flock:stream:${grant.grant_id}`;
  return { grant, output: client.channels.get(`${prefix}:output`),
    control: client.channels.get(`${prefix}:control`),
    input: grant.allow_input ? client.channels.get(`${prefix}:input`) : null };
}

export function subscribeToStream(session_id: string, onBytes: (bytes: Uint8Array) => void): () => void {
  const channels = streamChannels(session_id);
  if (!channels) return () => {};
  const { output: ch, grant } = channels;
  const handler = (msg: Ably.Message) => {
    if (msg.clientId !== grant.owner_id || getStreamGrant(session_id)?.grant_id !== grant.grant_id) return;
    try {
      const bytes = typeof msg.data === "string"
        ? Uint8Array.from(atob(msg.data), c => c.charCodeAt(0))
        : msg.data instanceof ArrayBuffer ? new Uint8Array(msg.data)
        : msg.data instanceof Uint8Array ? msg.data : null;
      if (bytes && bytes.length <= 64 * 1024) onBytes(bytes);
    } catch { /* malformed output is dropped */ }
  };
  ch.subscribe("data", handler);
  return () => { ch.unsubscribe("data", handler); void ch.detach().catch(() => {}); };
}

async function shareStream(toLogin: string, sessionId: string, streamId: string, paneId: string, allowInput: boolean) {
  if (!getAblyClient()) throw new Error("presence is not connected");
  const { error } = await supabase().rpc("authorize_stream", {
    p_session_id: sessionId, p_stream_id: streamId, p_viewer_handle: toLogin, p_allow_input: allowInput,
  });
  if (error) throw new Error(error.message);
  await refreshAuthorization();
  // A background renewal may have started just before the grant RPC.
  if (!getStreamGrant(streamId)) await refreshAuthorization();
  const channels = streamChannels(streamId);
  if (!channels || channels.grant.owner_id !== getRealtimeIdentity()?.id) throw new Error("stream authorization failed");
  await Promise.all([channels.output.attach(), channels.control.attach(), ...(channels.input ? [channels.input.attach()] : [])]);
  const { startStream } = await import("./streamPublisher");
  startStream(paneId, channels.output, {
    allowInput, allowedInputFrom: channels.grant.viewer_id, controlChannel: channels.control,
    inputChannel: channels.input ?? undefined, streamId, grantId: channels.grant.grant_id,
  });
}
export async function shareCopilotPane(toLogin: string, sessionId: string, paneId: string) {
  await shareStream(toLogin, sessionId, paneId, paneId, true);
}
async function revokeSession(sessionId: string) {
  // Stop producing/accepting bytes immediately, before the network round trip.
  const { stopSessionStreams } = await import("./streamPublisher");
  stopSessionStreams(sessionId);
  const { error } = await supabase().rpc("end_stream_session", { p_session_id: sessionId });
  if (error) console.error("Could not persist session revocation; local sharing has stopped");
  await refreshAuthorization().catch(() => {});
}

// ─── Task handoff ─────────────────────────────────────────────────────────────

export function sendTask(toLogin: string, toWid: string, prompt: string): string {
  const task_id = crypto.randomUUID();
  send({ ...base(toLogin, toWid), type: "task_send", task_id, prompt });
  return task_id;
}

export function acceptTask(toLogin: string, toWid: string, task_id: string) {
  send({ ...base(toLogin, toWid), type: "task_accept", task_id });
}

export function declineTask(toLogin: string, toWid: string, task_id: string) {
  send({ ...base(toLogin, toWid), type: "task_decline", task_id });
}

// ─── Co-pilot ─────────────────────────────────────────────────────────────────

export async function inviteCopilot(
  toLogin: string,
  toWid: string,
  panes: CopilotPane[],
): Promise<string> {
  const session_id = crypto.randomUUID();
  sessionPeers.set(session_id, peerId(toLogin) ?? "");
  await publishShared({ ...base(toLogin, toWid), type: "copilot_invite", session_id, panes }, async () => {
    for (const p of panes) await shareCopilotPane(toLogin, session_id, p.id);
  });
  return session_id;
}

export async function acceptCopilot(
  toLogin: string,
  toWid: string,
  session_id: string,
  myPanes: CopilotPane[],
): Promise<void> {
  sessionPeers.set(session_id, peerId(toLogin) ?? "");
  await publishShared({ ...base(toLogin, toWid), type: "copilot_accept", session_id, panes: myPanes }, async () => {
    for (const p of myPanes) await shareCopilotPane(toLogin, session_id, p.id);
  });
}

export async function endCopilot(
  toLogin: string,
  toWid: string,
  session_id: string,
  myPaneIds: string[],
): Promise<void> {
  const { stopStream } = await import("./streamPublisher");
  myPaneIds.forEach(stopStream);
  await revokeSession(session_id);
  await publish({ ...base(toLogin, toWid), type: "copilot_end", session_id });
}

export function syncCopilotLayout(toLogin: string, toWid: string, session_id: string, panes: CopilotPane[]) {
  send({ ...base(toLogin, toWid), type: "copilot_layout", session_id, panes });
}
