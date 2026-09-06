import crypto from "node:crypto";
import type { VercelRequest, VercelResponse } from "./http.ts";

export interface Peer { id: string; handle: string; presence_sharing: boolean; }
export interface StreamGrant {
  stream_id: string; grant_id: string; session_id: string;
  owner_id: string; viewer_id: string; allow_input: boolean; expires_at: string;
}
export interface RealtimeContext { identity: Peer; peers: Peer[]; streams: StreamGrant[]; }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HANDLE = /^[a-z0-9][a-z0-9_-]{2,31}$/;
export const TOKEN_TTL_MS = 60_000;

/** The only source of grants is the authenticated database RPC, never request
 * body channel IDs. Legacy/global channels intentionally have no capability. */
export function capabilityFor(context: RealtimeContext): Record<string, string[]> {
  const { identity, peers, streams } = context;
  if (!identity || !UUID.test(identity.id) || !HANDLE.test(identity.handle)
      || !Array.isArray(peers) || !Array.isArray(streams) || streams.length > 128) {
    throw new Error("invalid realtime context");
  }
  const cap: Record<string, string[]> = { [`flock:inbox:${identity.id}`]: ["subscribe", "publish"] };
  if (identity.presence_sharing === true) cap[`flock:presence:${identity.id}`] = ["presence", "subscribe"];
  const peerIds = new Set<string>([identity.id]);
  for (const peer of peers) {
    if (!UUID.test(peer.id) || !HANDLE.test(peer.handle)) throw new Error("invalid peer");
    peerIds.add(peer.id);
    cap[`flock:inbox:${peer.id}`] = peer.id === identity.id ? ["subscribe", "publish"] : ["publish"];
    if (peer.presence_sharing === true) cap[`flock:presence:${peer.id}`] = peer.id === identity.id
      ? ["presence", "subscribe"] : ["subscribe"];
  }
  for (const g of streams) {
    if (![g.stream_id, g.grant_id, g.session_id, g.owner_id, g.viewer_id].every(id => UUID.test(id))
        || !peerIds.has(g.owner_id) || !peerIds.has(g.viewer_id)
        || ![g.owner_id, g.viewer_id].includes(identity.id)
        || !Number.isFinite(Date.parse(g.expires_at)) || Date.parse(g.expires_at) <= Date.now()) {
      throw new Error("invalid stream grant");
    }
    const owner = g.owner_id === identity.id;
    const self = g.owner_id === g.viewer_id;
    const name = `flock:stream:${g.grant_id}`;
    cap[`${name}:output`] = self ? ["publish", "subscribe"] : [owner ? "publish" : "subscribe"];
    cap[`${name}:control`] = self ? ["publish", "subscribe"] : [owner ? "subscribe" : "publish"];
    if (g.allow_input === true) cap[`${name}:input`] = self ? ["publish", "subscribe"] : [owner ? "subscribe" : "publish"];
  }
  return cap;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });
  const { token, streams } = req.body ?? {};
  if (typeof token !== "string" || token.length < 16 || token.length > 16_384
      || token.split(".").length !== 3 || streams !== undefined) {
    return res.status(400).json({ error: "Supabase token required; client stream grants are not accepted" });
  }
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  const apiKey = process.env.ABLY_API_KEY?.trim();
  if (!url || !anonKey || !apiKey || !apiKey.includes(":")) return res.status(503).json({ error: "auth service unavailable" });
  try {
    // PostgREST verifies the access token and auth.uid(). The SECURITY DEFINER
    // RPC returns only this identity, accepted peers and active consent grants.
    const ctxRes = await fetch(`${url}/rest/v1/rpc/realtime_context`, {
      method: "POST", headers: { apikey: anonKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}", signal: AbortSignal.timeout(8_000),
    });
    if (!ctxRes.ok) return res.status(ctxRes.status === 401 ? 401 : 403).json({ error: "realtime authorization failed" });
    const context = await ctxRes.json() as RealtimeContext;
    const capability = capabilityFor(context);
    const [keyName] = apiKey.split(":");
    const ablyRes = await fetch(`https://rest.ably.io/keys/${encodeURIComponent(keyName)}/requestToken`, {
      method: "POST", headers: { Authorization: `Basic ${Buffer.from(apiKey).toString("base64")}`, "Content-Type": "application/json" },
      body: JSON.stringify({ keyName, clientId: context.identity.id, ttl: TOKEN_TTL_MS,
        timestamp: Date.now(), nonce: crypto.randomBytes(16).toString("hex"), capability: JSON.stringify(capability) }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!ablyRes.ok) return res.status(502).json({ error: "realtime token unavailable" });
    return res.json({ token: await ablyRes.json(), context });
  } catch {
    return res.status(503).json({ error: "realtime authorization unavailable" });
  }
}
