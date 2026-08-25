// `import type` — the SDK is pulled in at connect time by the dynamic import in
// connectPresence below, never at module scope. Ably is the single heaviest
// runtime dependency in the app, and nothing about presence is needed to paint
// the first frame: a signed-out user never connects at all, and a signed-in one
// connects after the shell is already up. A static import here put all of it in
// the startup chunk regardless.
import type Ably from "ably";
// Imported for use below AND re-exported, so every existing
// `import { MY_WINDOW_ID } from "./presence"` keeps resolving. A bare
// `export { ... } from` would re-export without binding it locally, and this
// module uses it twice.
import { MY_WINDOW_ID } from "./windowId";
export { MY_WINDOW_ID };

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PresenceMember {
  login: string;
  agentCount: number;
}

export type PresenceEvent =
  | { kind: "online";  login: string; agentCount: number; windowId?: string }
  | { kind: "offline"; login: string }
  | { kind: "update";  login: string; agentCount: number; windowId?: string };

/** Coarse health of our own presence connection, for a status light.
 *   connected  → live on the channel (green)
 *   connecting → establishing or transiently dropped, Ably retrying (amber)
 *   failed     → can't connect at all, e.g. presence auth rejected our token
 *                (red). This is the silent case that used to just look like
 *                "all friends offline" with no explanation. */
export type PresenceStatus = "connecting" | "connected" | "failed";

// ─── Singleton client ─────────────────────────────────────────────────────────

type PresenceData = { agent_count?: number; window_id?: string };

let client: Ably.Realtime | null = null;
let presenceChannel: Ably.RealtimeChannel | null = null;
let currentFriends: Set<string> = new Set();
let onEventHandler: ((e: PresenceEvent) => void) | null = null;
let onStatusHandler: ((s: PresenceStatus) => void) | null = null;

// MY_WINDOW_ID now lives in ./windowId and is re-exported at the top of this
// file, so every existing `from "./presence"` import still resolves. The move
// is explained there: it is a uuid with no dependencies, and keeping it in a
// module that imports the Ably SDK is what stopped presence from ever being
// code-split.

const AUTH_URL = (typeof import.meta !== "undefined" && (import.meta as any).env?.VITE_ABLY_AUTH_URL)
  || "https://presence-auth.vercel.app/api/auth";

/** Pull the current presence set and re-emit "online" for every friend in it.
 *
 * Presence "enter" events only fire on transitions, so this backfill is how we
 * learn about friends who were already online across a gap we couldn't see:
 * the initial join, a friend added mid-session, and (critically) every
 * reconnect. Ably re-syncs the member map on re-attach but does not replay
 * "enter" for members that were already present, so after a network blip or
 * the hourly token re-auth an online friend would silently look offline until
 * they next changed something. Re-running this on each "connected" keeps the
 * roster from decaying over a long session. Best-effort; safe to call anytime. */
async function backfillOnlineFriends(): Promise<void> {
  if (!presenceChannel || !onEventHandler) return;
  try {
    const members = await presenceChannel.presence.get();
    for (const m of members) {
      if (!currentFriends.has(m.clientId)) continue;
      const data = m.data as PresenceData | undefined;
      onEventHandler({ kind: "online", login: m.clientId, agentCount: data?.agent_count ?? 0, windowId: data?.window_id });
    }
  } catch { /* ignore — best effort */ }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Connect to Ably and join the global presence channel.
 *
 * `getToken` is called on every Ably (re)auth rather than capturing a token
 * once: flock ID access tokens expire hourly, so the auth service needs a
 * fresh one each time. Pass a getter returning the current Supabase access
 * token (or a GitHub token on legacy installs — the auth service takes both). */
export async function connectPresence(
  getToken: () => Promise<string>,
  friends: string[],
  agentCount: number,
  onEvent: (e: PresenceEvent) => void,
  onStatus?: (s: PresenceStatus) => void,
): Promise<void> {
  // Disconnect any existing session first
  disconnectPresence();
  currentFriends = new Set(friends);
  onEventHandler = onEvent;
  onStatusHandler = onStatus ?? null;
  onStatusHandler?.("connecting");

  // The one place the SDK is used as a value, which is why the module-scope
  // import above can be type-only. Loaded here, on the way to a connection that
  // is about to be made anyway — the await costs nothing next to the round trip
  // to the auth endpoint that follows it.
  const AblyRuntime = (await import("ably")).default;

  client = new AblyRuntime.Realtime({
    authUrl: AUTH_URL,
    authMethod: "POST",
    authHeaders: { "Content-Type": "application/json" },
    authParams: {},
    authCallback: async (_data, callback) => {
      try {
        const res = await fetch(AUTH_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: await getToken() }),
        });
        if (!res.ok) throw new Error(`auth failed: ${res.status} ${res.statusText}`);
        callback(null, await res.json());
      } catch (e: any) {
        console.error("[Presence] Auth error:", e.message);
        callback(e, null);
      }
    },
  });

  client.connection.on("connected", () => {
    onStatusHandler?.("connected");
    // Re-sync the roster on every (re)connect — not just the first — so friends
    // who stayed online across a network drop or token re-auth don't decay to
    // offline. No-op on the very first connect (we back-fill again after enter).
    backfillOnlineFriends().catch(() => {});
  });
  // "failed" is terminal (bad token, exhausted retries); "disconnected"/
  // "suspended" are transient with Ably auto-retrying. Surface the first as a
  // red light and the rest as amber "connecting" so a rejected presence token
  // stops masquerading as "all friends offline".
  client.connection.on("failed", () => {
    console.error("[Presence] Connection failed");
    onStatusHandler?.("failed");
  });
  client.connection.on("disconnected", () => onStatusHandler?.("connecting"));
  client.connection.on("suspended", () => onStatusHandler?.("connecting"));

  presenceChannel = client.channels.get("flock:presence");

  presenceChannel.presence.subscribe("enter", (member) => {
    if (!currentFriends.has(member.clientId)) return;
    const data = member.data as PresenceData | undefined;
    onEvent({ kind: "online", login: member.clientId, agentCount: data?.agent_count ?? 0, windowId: data?.window_id });
  });

  presenceChannel.presence.subscribe("leave", (member) => {
    if (!currentFriends.has(member.clientId)) return;
    onEvent({ kind: "offline", login: member.clientId });
  });

  presenceChannel.presence.subscribe("update", (member) => {
    if (!currentFriends.has(member.clientId)) return;
    const data = member.data as PresenceData | undefined;
    onEvent({ kind: "update", login: member.clientId, agentCount: data?.agent_count ?? 0, windowId: data?.window_id });
  });

  // Wait for connection before announcing. "failed" is terminal (e.g. the
  // auth service rejected our token) — reject right away instead of sitting
  // out the full timeout. Listeners are removed on settle either way so they
  // don't pile up across reconnect cycles.
  await new Promise<void>((resolve, reject) => {
    const conn = client!.connection;
    const settle = (err?: Error) => {
      clearTimeout(timeout);
      conn.off("connected", onConnected);
      conn.off("failed", onFailed);
      err ? reject(err) : resolve();
    };
    const timeout = setTimeout(() => settle(new Error("connection timeout")), 10000);
    const onConnected = () => settle();
    const onFailed = () => settle(new Error("presence connection failed"));
    conn.on("connected", onConnected);
    conn.on("failed", onFailed);
    if (conn.state === "connected") settle();
    else if (conn.state === "failed") settle(new Error("presence connection failed"));
  });

  // Announce ourselves with current agent count and unique window ID
  await presenceChannel.presence.enter({ agent_count: agentCount, window_id: MY_WINDOW_ID });

  // Sync already-online friends on initial connection
  await backfillOnlineFriends();
}

/** Update our own agent count (called whenever panes are spawned or closed). */
export async function updateAgentCount(count: number): Promise<void> {
  if (!presenceChannel) return;
  await presenceChannel.presence.update({ agent_count: count, window_id: MY_WINDOW_ID });
}

/** Update which friends we care about (called when the friend list changes). */
export function updateFriends(friends: string[]): void {
  currentFriends = new Set(friends);
}

/** Re-emit "online" for every tracked friend currently in the presence set.
 * Presence "enter" events only fire on transitions, so a friend who was
 * already online when you added them (or before you connected) would look
 * offline until they next changed something — this backfills that. */
export async function resyncFriendPresence(): Promise<void> {
  await backfillOnlineFriends();
}

export function getAblyClient(): Ably.Realtime | null { return client; }
export function getPresenceChannel(): Ably.RealtimeChannel | null { return presenceChannel; }

/** Gracefully leave presence and close the connection. */
export function disconnectPresence(): void {
  if (presenceChannel) {
    presenceChannel.presence.leave().catch(() => {});
    presenceChannel = null;
  }
  if (client) {
    client.close();
    client = null;
  }
  onEventHandler = null;
  onStatusHandler = null;
}
