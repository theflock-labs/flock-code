import type Ably from "ably";
import { MY_WINDOW_ID } from "./windowId";
export { MY_WINDOW_ID };

export interface PresenceMember { login: string; agentCount: number; }
export type PresenceEvent =
  | { kind: "online" | "update"; login: string; agentCount: number; windowId?: string }
  | { kind: "offline"; login: string };
export type PresenceStatus = "connecting" | "connected" | "failed";
export interface RealtimePeer { id: string; handle: string; presence_sharing: boolean; }
export interface StreamGrant {
  stream_id: string; grant_id: string; session_id: string; owner_id: string;
  viewer_id: string; allow_input: boolean; expires_at: string;
}
interface RealtimeContext { identity: RealtimePeer; peers: RealtimePeer[]; streams: StreamGrant[]; }
let client: Ably.Realtime | null = null;
let context: RealtimeContext | null = null;
let authorizationExpires = 0;
let presenceChannel: Ably.RealtimeChannel | null = null;
const channels = new Map<string, Ably.RealtimeChannel>();
const contextListeners = new Set<() => void>();
let currentFriends = new Set<string>();
let onEventHandler: ((e: PresenceEvent) => void) | null = null;
let onStatusHandler: ((s: PresenceStatus) => void) | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let refreshing: Promise<void> | null = null;
let agentCount = 0;
let generation = 0;
const AUTH_URL = (import.meta as { env?: Record<string, string> }).env?.VITE_ABLY_AUTH_URL || "https://presence-auth.vercel.app/api/auth";

export function getRealtimeIdentity(): RealtimePeer | null { return context?.identity ?? null; }
export function peerId(handle: string): string | null { return context?.peers.find(p => p.handle === handle)?.id ?? null; }
export function verifiedHandle(id: string | null | undefined): string | null { return context?.peers.find(p => p.id === id)?.handle ?? null; }
export function getStreamGrant(streamId: string): StreamGrant | null {
  if (Date.now() >= authorizationExpires) return null;
  return context?.streams.find(g => g.stream_id === streamId && Date.parse(g.expires_at) > Date.now()) ?? null;
}
export function onRealtimeContext(handler: () => void): () => void {
  contextListeners.add(handler); return () => { contextListeners.delete(handler); };
}
function notifyContext() { for (const f of contextListeners) f(); }
function emitMember(kind: "online" | "update", id: string, member: Ably.PresenceMessage) {
  // A channel's owner is the only identity allowed to enter it.
  if (member.clientId !== id) return;
  const login = verifiedHandle(id);
  if (!login || !currentFriends.has(login)) return;
  const data = member.data as { agent_count?: number; window_id?: string } | undefined;
  onEventHandler?.({ kind, login, agentCount: typeof data?.agent_count === "number" ? data.agent_count : 0,
    windowId: typeof data?.window_id === "string" ? data.window_id : undefined });
}
async function syncPresenceChannels() {
  if (!client || !context) return;
  const wanted = new Map(context.peers.filter(p => p.presence_sharing &&
    (p.id === context!.identity.id || currentFriends.has(p.handle))).map(p => [p.id, p]));
  for (const [id, ch] of channels) if (!wanted.has(id)) {
    ch.presence.unsubscribe();
    await ch.detach().catch(() => {});
    channels.delete(id);
    const login = verifiedHandle(id);
    if (login) onEventHandler?.({ kind: "offline", login });
  }
  presenceChannel = null;
  for (const [id] of wanted) {
    let ch = channels.get(id);
    if (!ch) {
      ch = client.channels.get(`flock:presence:${id}`);
      channels.set(id, ch);
      ch.presence.subscribe("enter", m => emitMember("online", id, m));
      ch.presence.subscribe("update", m => emitMember("update", id, m));
      ch.presence.subscribe("leave", m => {
        const login = verifiedHandle(id);
        if (m.clientId === id && login && currentFriends.has(login)) onEventHandler?.({ kind: "offline", login });
      });
    }
    if (id === context.identity.id) {
      presenceChannel = ch;
      await ch.presence.enter({ agent_count: agentCount, window_id: MY_WINDOW_ID });
    }
    for (const member of await ch.presence.get()) emitMember("online", id, member);
  }
}

/** Refreshes membership and grants from the server; errors clear local stream
 * authority. Ably tokens expire within 60s even if a removed peer stays offline. */
export function refreshAuthorization(): Promise<void> {
  if (refreshing) return refreshing;
  const current = client;
  if (!current) return Promise.reject(new Error("presence is not connected"));
  refreshing = (async () => {
    try {
      await current.auth.authorize();
      if (client !== current) return;
      notifyContext();
      await syncPresenceChannels();
    } catch (error) {
      if (client === current) { context = null; notifyContext(); onStatusHandler?.("failed"); }
      throw error;
    } finally { refreshing = null; }
  })();
  return refreshing;
}

export async function connectPresence(
  getToken: () => Promise<string>, friends: string[], count: number,
  onEvent: (e: PresenceEvent) => void, onStatus?: (s: PresenceStatus) => void,
): Promise<void> {
  disconnectPresence();
  const epoch = generation;
  currentFriends = new Set(friends); agentCount = count;
  onEventHandler = onEvent; onStatusHandler = onStatus ?? null;
  onStatusHandler?.("connecting");
  const AblyRuntime = (await import("ably")).default;
  if (epoch !== generation) return;
  const created = new AblyRuntime.Realtime({
    authCallback: async (_data, callback) => {
      try {
        const res = await fetch(AUTH_URL, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: await getToken() }), signal: AbortSignal.timeout(20_000) });
        if (!res.ok) throw new Error(`realtime auth failed (${res.status})`);
        const result = await res.json();
        if (epoch !== generation) throw new Error("presence disconnected");
        if (!result.context?.identity?.id || !Array.isArray(result.context.peers) || !Array.isArray(result.context.streams)
            || result.token?.clientId !== result.context.identity.id) throw new Error("invalid realtime authorization");
        if (typeof result.token.expires !== "number" || result.token.expires <= Date.now()) throw new Error("expired realtime token");
        authorizationExpires = Math.min(result.token.expires, Date.now() + 60_000);
        context = result.context;
        callback(null, result.token);
      } catch (e) {
        if (epoch === generation) { context = null; notifyContext(); }
        callback(e instanceof Error ? e.message : String(e), null);
      }
    },
  });
  client = created;
  created.connection.on("connected", () => {
    onStatusHandler?.("connected");
    void syncPresenceChannels().catch(() => onStatusHandler?.("failed"));
  });
  created.connection.on("failed", () => { context = null; notifyContext(); onStatusHandler?.("failed"); });
  created.connection.on("disconnected", () => onStatusHandler?.("connecting"));
  created.connection.on("suspended", () => { context = null; notifyContext(); onStatusHandler?.("connecting"); });
  await new Promise<void>((resolve, reject) => {
    const settle = (error?: Error) => {
      clearTimeout(timeout); created.connection.off("connected", connected); created.connection.off("failed", failed);
      error ? reject(error) : resolve();
    };
    const timeout = setTimeout(() => settle(new Error("presence connection timeout")), 25_000);
    const connected = () => settle();
    const failed = () => settle(new Error("presence connection failed"));
    created.connection.on("connected", connected); created.connection.on("failed", failed);
    if (created.connection.state === "connected") settle();
    else if (created.connection.state === "failed") failed();
  });
  if (epoch !== generation) return;
  await syncPresenceChannels();
  refreshTimer = setInterval(() => { void refreshAuthorization().catch(() => {}); }, 45_000);
}
export async function updateAgentCount(count: number) {
  agentCount = count;
  if (presenceChannel) await presenceChannel.presence.update({ agent_count: count, window_id: MY_WINDOW_ID });
}
export function updateFriends(friends: string[]) { currentFriends = new Set(friends); }
export async function resyncFriendPresence() { await refreshAuthorization(); }
export function getAblyClient(): Ably.Realtime | null { return client; }
export function getPresenceChannel(): Ably.RealtimeChannel | null { return presenceChannel; }
export function disconnectPresence() {
  generation++;
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null; refreshing = null;
  for (const ch of channels.values()) { ch.presence.unsubscribe(); void ch.presence.leave().catch(() => {}); }
  channels.clear(); presenceChannel = null;
  context = null; authorizationExpires = 0; notifyContext();
  client?.close(); client = null;
  onEventHandler = null; onStatusHandler = null;
}
