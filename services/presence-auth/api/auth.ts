import crypto from "crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";

// Mints Ably tokens for flock presence. The clientId is the caller's
// verified identity:
//
//   - flock ID (preferred): a Supabase access token, verified against the
//     project's auth API; clientId = the profile's claimed handle.
//   - GitHub (legacy, pre-flock-ID installs): a GitHub OAuth token;
//     clientId = the GitHub login.
//
// Both paths prove the caller controls the account whose name they'll
// occupy on the presence channel — never trust a self-declared clientId.

interface Identity {
  clientId: string;
}

// Channel ids the caller may be granted. Pane/session ids are uuids today, but
// the check is a conservative charset rather than a uuid match so a future id
// shape doesn't silently lose streaming. What it must never admit is `*` or a
// `:` — either would turn a requested channel into a wildcard grant, handing
// back exactly the blanket capability this scoping exists to remove.
const STREAM_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
/** Ably rejects oversized capability documents, and no real session needs more. */
const MAX_STREAMS = 64;

/** The two channel namespaces in the field at once.
 *
 *  The rename (b338677) moved the client to `flock:*` — presence.ts attaches to
 *  `flock:presence`, session.ts to `flock:inbox:*` and `flock:stream:*` — but
 *  left this capability list on `clarence:*`. Ably capabilities are matched
 *  against the channel name, so a token naming only `clarence:*` denies every
 *  attach a post-rename build makes: presence, directed session control and
 *  pane streaming all fail, and a denied presence attach looks exactly like
 *  "all your friends are offline".
 *
 *  Granting both is what the original comment was reaching for — the point was
 *  never `clarence` specifically, it was not splitting the pool across builds.
 *  Drop the legacy half once pre-rename installs are gone. */
const NAMESPACES = ["flock", "clarence"] as const;

/** Capabilities scoped to one verified identity.
 *
 *   - presence: subscribe + presence only. No `publish`, so nobody can
 *     broadcast spoofable messages to the shared channel.
 *   - inbox: subscribe to your OWN inbox only; publish to anyone's, since that
 *     is how a request reaches its recipient. Directed control messages
 *     (observe/copilot/task, including prompt bodies) ride these per-recipient
 *     channels rather than the shared presence channel.
 *   - stream: pane bytes and input. When the caller names the sessions it
 *     needs, it is granted those and nothing else. The `*` fallback below is
 *     for clients that don't yet ask — see the note in the handler. */
function capabilityFor(clientId: string, streams: string[]): Record<string, string[]> {
  const cap: Record<string, string[]> = {};
  for (const ns of NAMESPACES) {
    cap[`${ns}:presence`] = ["subscribe", "presence"];
    cap[`${ns}:inbox:${clientId}`] = ["subscribe"];
    cap[`${ns}:inbox:*`] = ["publish"];
    if (streams.length > 0) {
      for (const id of streams) cap[`${ns}:stream:${id}`] = ["publish", "subscribe"];
    } else {
      cap[`${ns}:stream:*`] = ["publish", "subscribe"];
    }
  }
  return cap;
}

/** Supabase access tokens are JWTs (two dots); GitHub OAuth tokens
 * (gho_/ghp_) are not. */
function looksLikeJwt(token: string): boolean {
  return token.split(".").length === 3;
}

async function verifyFlockId(token: string): Promise<Identity | null> {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;

  const userRes = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
  });
  if (!userRes.ok) return null;
  const user = await userRes.json();
  if (!user?.id) return null;

  // The handle is the wire identity friends know the user by. RLS lets the
  // user's own token read it.
  const profRes = await fetch(
    `${url}/rest/v1/profiles?id=eq.${user.id}&select=handle`,
    { headers: { apikey: anonKey, Authorization: `Bearer ${token}` } },
  );
  if (!profRes.ok) return null;
  const rows = await profRes.json();
  const handle = rows?.[0]?.handle;
  // No claimed handle yet → no presence identity to occupy.
  return handle ? { clientId: handle } : null;
}

async function verifyGithub(token: string): Promise<Identity | null> {
  const ghRes = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "flock-presence/1.0",
    },
  });
  if (!ghRes.ok) return null;
  const { login } = await ghRes.json();
  // Namespaced, because the two identity sources shared one clientId space.
  // A flock handle and a GitHub login are both bare names, and the inbox
  // channel is keyed on that name — so claiming the handle `alice` handed you
  // subscribe on `inbox:alice`, the same inbox a GitHub-authed user `alice`
  // receives directed control messages on, session uuids and task prompt
  // bodies included. Impersonation on the presence channel came free with it.
  //
  // `.` is the separator precisely because neither name can contain one: the
  // handle check constraint admits only [a-z0-9_-], and GitHub logins are
  // alphanumeric-and-hyphen. Anything drawn from the handle charset (`gh-`)
  // would just be claimable as a handle and reopen the collision. It is also
  // not `:`, which is Ably's channel segment separator.
  return login ? { clientId: `gh.${login}` } : null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });

  const { token, streams } = req.body ?? {};
  if (!token) return res.status(400).json({ error: "missing token" });

  // Opt-in stream scoping. A client that names the sessions it needs gets a
  // token good for those alone; one that names none still gets the blanket
  // `stream:*` it has always had, because revoking it unilaterally would cut
  // streaming off in every installed build.
  //
  // So this narrows the blast radius rather than closing the hole: until the
  // client sends `streams` (and re-authorizes when a new session starts), any
  // signed-in user still holds publish+subscribe on every pane stream, with
  // only the secrecy of the session uuid in front of a live terminal.
  const requested: string[] = Array.isArray(streams)
    ? streams.filter((s: unknown): s is string => typeof s === "string" && STREAM_ID_RE.test(s))
        .slice(0, MAX_STREAMS)
    : [];

  const identity = looksLikeJwt(token)
    ? await verifyFlockId(token)
    : await verifyGithub(token);
  if (!identity) return res.status(401).json({ error: "invalid token" });

  const apiKey = process.env.ABLY_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ABLY_API_KEY not configured" });

  const [keyName] = apiKey.trim().split(":");

  // Ask Ably's REST API to issue a token — no SDK, no HMAC needed
  const basicAuth = Buffer.from(apiKey.trim()).toString("base64");
  const ablyRes = await fetch(`https://rest.ably.io/keys/${keyName}/requestToken`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      keyName,
      clientId: identity.clientId,
      ttl: 3_600_000,
      timestamp: Date.now(),
      nonce: crypto.randomBytes(16).toString("hex"),
      // Scoped to the caller's verified identity, across both live channel
      // namespaces — see capabilityFor.
      capability: JSON.stringify(capabilityFor(identity.clientId, requested)),
    }),
  });

  if (!ablyRes.ok) {
    const err = await ablyRes.text();
    return res.status(500).json({ error: `Ably token request failed: ${err}` });
  }

  const ablyToken = await ablyRes.json();
  res.json(ablyToken);
}
