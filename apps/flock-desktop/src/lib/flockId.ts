// flock ID: federated sign-in (Google via Supabase Auth) and the friend
// graph. This is the account that friendships hang off; GitHub stays
// connected separately for repo/PR work.
//
// Desktop OAuth flow: Rust binds a one-shot loopback listener
// (auth_callback_listen), we send the system browser to Supabase with
// redirectTo pointing at it, the redirect's PKCE code comes back on the
// `flock-id://callback` event, and supabase-js exchanges it for a session
// (verifier lives in this webview's localStorage, so the exchange must
// happen in the window that started the flow).

import { createClient, type SupabaseClient, type Session, type RealtimeChannel } from "@supabase/supabase-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";

// Baked in at build time for releases; the localStorage override lets a dev
// point at their own Supabase project without rebuilding.
const URL_KEY = "flock:id-url";
const ANON_KEY = "flock:id-anon-key";

export function getIdConfig(): { url: string; anonKey: string } {
  const env = (import.meta as { env?: Record<string, string> }).env ?? {};
  return {
    url: localStorage.getItem(URL_KEY) || env.VITE_SUPABASE_URL || "",
    anonKey: localStorage.getItem(ANON_KEY) || env.VITE_SUPABASE_ANON_KEY || "",
  };
}

export function setIdConfig(url: string, anonKey: string): void {
  localStorage.setItem(URL_KEY, url.trim());
  localStorage.setItem(ANON_KEY, anonKey.trim());
  client = null; // next call rebuilds against the new project
}

export function isIdConfigured(): boolean {
  const { url, anonKey } = getIdConfig();
  return url.length > 0 && anonKey.length > 0;
}

let client: SupabaseClient | null = null;

export function supabase(): SupabaseClient {
  if (!client) {
    const { url, anonKey } = getIdConfig();
    if (!url || !anonKey) throw new Error("flock ID is not configured");
    client = createClient(url, anonKey, {
      auth: {
        flowType: "pkce",
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    });
  }
  return client;
}

// ─── Sign in / out ────────────────────────────────────────────────────────────

export type IdProvider = "google";

/** Full federated sign-in round trip. Resolves with the session once the
 * user has finished in the browser; rejects on provider error or the
 * listener's 5-minute timeout. */
export async function signIn(provider: IdProvider): Promise<Session> {
  const sb = supabase();
  const port = await invoke<number>("auth_callback_listen");

  const { data, error } = await sb.auth.signInWithOAuth({
    provider,
    options: {
      redirectTo: `http://127.0.0.1:${port}/auth/callback`,
      skipBrowserRedirect: true,
    },
  });
  if (error || !data?.url) throw new Error(error?.message ?? "could not start sign-in");

  const query = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      unlistenP.then((u) => u());
      reject(new Error("sign-in timed out"));
    }, 300_000);
    const unlistenP = listen<{ query: string }>("flock-id://callback", (e) => {
      clearTimeout(timer);
      unlistenP.then((u) => u());
      resolve(e.payload.query);
    });
    openUrl(data.url).catch((err) => {
      clearTimeout(timer);
      unlistenP.then((u) => u());
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });

  const params = new URLSearchParams(query);
  const oauthError = params.get("error_description") ?? params.get("error");
  if (oauthError) throw new Error(oauthError);
  const code = params.get("code");
  if (!code) throw new Error("no code in sign-in callback");

  const { data: exchanged, error: exchangeError } = await sb.auth.exchangeCodeForSession(code);
  if (exchangeError || !exchanged.session) {
    throw new Error(exchangeError?.message ?? "code exchange failed");
  }
  return exchanged.session;
}

export async function signOut(): Promise<void> {
  await supabase().auth.signOut();
}

export async function getSession(): Promise<Session | null> {
  if (!isIdConfigured()) return null;
  const { data } = await supabase().auth.getSession();
  return data.session;
}

export function onAuthChange(handler: (session: Session | null) => void): () => void {
  if (!isIdConfigured()) return () => {};
  const { data } = supabase().auth.onAuthStateChange((_event, session) => handler(session));
  return () => data.subscription.unsubscribe();
}

// ─── Profile ──────────────────────────────────────────────────────────────────

export interface IdProfile {
  id: string;
  handle: string | null;
  display_name: string | null;
  avatar_url: string | null;
}

// ─── Social usage stats ────────────────────────────────────────────────────

export interface UserStats {
  prompts_sent: number;
  agents_launched: number;
  workspaces_created: number;
  /** Cumulative Claude Code tokens spent (all-time, this flock account). */
  tokens_total: number;
  /** Estimated USD equivalent of that token spend (from cost_usd_micros). */
  cost_usd: number;
  /** ISO timestamp the profile was created — "member since". */
  member_since: string | null;
}

/** A friend's (or your own) usage stats, for the friends-pane info modal. RLS
 *  only returns rows for the caller's own id or a friendship edge, so this is
 *  safe to call with any friend's profile id. Returns zeroed stats if the user
 *  has no stats row yet. */
export async function getUserStats(profileId: string): Promise<UserStats> {
  const sb = supabase();
  const [statsRes, profRes] = await Promise.all([
    sb.from("user_stats")
      .select("prompts_sent, agents_launched, workspaces_created, tokens_total, cost_usd_micros")
      .eq("id", profileId)
      .maybeSingle(),
    sb.from("profiles").select("created_at").eq("id", profileId).maybeSingle(),
  ]);
  // A missing row (friend with no activity yet) is a genuine zero; an actual
  // query error (table absent before the migration, or a read failure) is not,
  // so surface it and let the modal show its "not available" state instead of a
  // misleading 0.
  if (statsRes.error) throw new Error(statsRes.error.message);
  const s = statsRes.data;
  return {
    prompts_sent: s?.prompts_sent ?? 0,
    agents_launched: s?.agents_launched ?? 0,
    workspaces_created: s?.workspaces_created ?? 0,
    tokens_total: s?.tokens_total ?? 0,
    cost_usd: (s?.cost_usd_micros ?? 0) / 1_000_000,
    member_since: (profRes.data as { created_at?: string } | null)?.created_at ?? null,
  };
}

/** Set your own cumulative Claude Code token + USD totals (absolute snapshot;
 *  the RPC keeps the max). Best-effort — swallow failures like the counters. */
export async function setUsageTotals(tokensTotal: number, costUsd: number): Promise<void> {
  const session = await getSession();
  if (!session) return;
  const { error } = await supabase().rpc("set_usage_totals", {
    p_tokens_total: Math.max(0, Math.round(tokensTotal)),
    p_cost_usd_micros: Math.max(0, Math.round(costUsd * 1_000_000)),
  });
  if (error) throw new Error(error.message);
}

/** One day's cumulative usage snapshot. Per-day *deltas* are derived by the UI
 *  diffing consecutive points, so these are the running totals as of `day`. */
export interface UsageDailyPoint {
  /** Calendar day, "YYYY-MM-DD". */
  day: string;
  tokens_total: number;
  cost_usd: number;
}

/** Record today's cumulative token/USD snapshot into the daily history (the My
 *  Info usage chart). Monotonic per day, keyed to the caller. Best-effort. */
export async function recordUsageDaily(tokensTotal: number, costUsd: number): Promise<void> {
  const session = await getSession();
  if (!session) return;
  const { error } = await supabase().rpc("record_usage_daily", {
    p_tokens_total: Math.max(0, Math.round(tokensTotal)),
    p_cost_usd_micros: Math.max(0, Math.round(costUsd * 1_000_000)),
  });
  if (error) throw new Error(error.message);
}

/** Fetch the last `days` of daily cumulative snapshots for a profile, oldest
 *  first. RLS scopes rows to self or a friendship edge (so this is safe for a
 *  friend's id too). Empty until the daily sync has run at least once. */
export async function getUsageSeries(profileId: string, days = 30): Promise<UsageDailyPoint[]> {
  // `days` back from today, inclusive — one extra day of margin so the first
  // visible day still has a prior snapshot to diff against for its delta.
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceIso = since.toISOString().slice(0, 10);
  const { data, error } = await supabase()
    .from("usage_daily")
    .select("day, tokens_total, cost_usd_micros")
    .eq("id", profileId)
    .gte("day", sinceIso)
    .order("day", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({
    day: r.day as string,
    tokens_total: (r.tokens_total as number) ?? 0,
    cost_usd: ((r.cost_usd_micros as number) ?? 0) / 1_000_000,
  }));
}

/** Add to your own counters. Best-effort — vanity stats must never break a
 *  spawn or a prompt, so failures (offline, migration not applied) are swallowed
 *  by the caller. */
export async function bumpStats(d: { prompts?: number; agents?: number; workspaces?: number }): Promise<void> {
  const session = await getSession();
  if (!session) return;
  const { error } = await supabase().rpc("bump_stats", {
    d_prompts: d.prompts ?? 0,
    d_agents: d.agents ?? 0,
    d_workspaces: d.workspaces ?? 0,
  });
  if (error) throw new Error(error.message);
}

export async function getMyProfile(): Promise<IdProfile | null> {
  const session = await getSession();
  if (!session) return null;
  const { data, error } = await supabase()
    .from("profiles")
    .select("id, handle, display_name, avatar_url")
    .eq("id", session.user.id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

/** Claim or change the public handle. Uniqueness is enforced by the DB;
 * surfaces "handle is taken" cleanly. */
export async function claimHandle(handle: string): Promise<void> {
  const session = await getSession();
  if (!session) throw new Error("not signed in");
  const { error } = await supabase()
    .from("profiles")
    .update({ handle: handle.trim().toLowerCase() })
    .eq("id", session.user.id);
  if (error) {
    throw new Error(/duplicate|unique/i.test(error.message) ? "That handle is taken." : error.message);
  }
}

// ─── Friend graph ─────────────────────────────────────────────────────────────

export type FriendState = "accepted" | "pending_out" | "pending_in";

export interface Friend {
  profile: IdProfile;
  state: FriendState;
}

interface FriendshipRow {
  requester: string;
  addressee: string;
  status: "pending" | "accepted";
  requester_profile: IdProfile;
  addressee_profile: IdProfile;
}

export async function listIdFriends(): Promise<Friend[]> {
  const session = await getSession();
  if (!session) return [];
  const me = session.user.id;
  const { data, error } = await supabase()
    .from("friendships")
    .select(
      "requester, addressee, status," +
        "requester_profile:profiles!friendships_requester_fkey(id, handle, display_name, avatar_url)," +
        "addressee_profile:profiles!friendships_addressee_fkey(id, handle, display_name, avatar_url)",
    )
    .returns<FriendshipRow[]>();
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => {
    const outgoing = row.requester === me;
    return {
      profile: outgoing ? row.addressee_profile : row.requester_profile,
      state: row.status === "accepted" ? "accepted" : outgoing ? "pending_out" : "pending_in",
    };
  });
}

/** Send a friend request to an exact handle. */
export async function sendFriendRequest(handle: string): Promise<IdProfile> {
  const session = await getSession();
  if (!session) throw new Error("not signed in");
  const { data: matches, error: lookupError } = await supabase().rpc("lookup_handle", {
    q: handle,
  });
  if (lookupError) throw new Error(lookupError.message);
  const target: IdProfile | undefined = matches?.[0];
  if (!target) throw new Error(`No one goes by "${handle.trim()}".`);
  if (target.id === session.user.id) throw new Error("That's you.");
  const { error } = await supabase()
    .from("friendships")
    .insert({ requester: session.user.id, addressee: target.id });
  if (error) {
    throw new Error(/duplicate|unique/i.test(error.message) ? "Already connected or pending." : error.message);
  }
  return target;
}

export async function acceptFriendRequest(requesterId: string): Promise<void> {
  const session = await getSession();
  if (!session) throw new Error("not signed in");
  const { error } = await supabase()
    .from("friendships")
    .update({ status: "accepted", responded_at: new Date().toISOString() })
    .eq("requester", requesterId)
    .eq("addressee", session.user.id);
  if (error) throw new Error(error.message);
}

/** Cancel an outgoing request, decline an incoming one, or unfriend. */
export async function removeFriendship(otherId: string): Promise<void> {
  const session = await getSession();
  if (!session) throw new Error("not signed in");
  const me = session.user.id;
  const { error } = await supabase()
    .from("friendships")
    .delete()
    .or(`and(requester.eq.${me},addressee.eq.${otherId}),and(requester.eq.${otherId},addressee.eq.${me})`);
  if (error) throw new Error(error.message);
}

/** Live-update the friend graph: fires `onChange` whenever any `friendships`
 * row the user can see is inserted/updated/deleted (RLS scopes this to rows
 * involving them), so incoming requests and acceptances land without a
 * reload. Best-effort — if realtime isn't enabled on the project the channel
 * simply never fires and the caller's polling fallback covers it. */
export function subscribeFriendships(onChange: () => void): () => void {
  if (!isIdConfigured()) return () => {};
  let channel: RealtimeChannel | null = null;
  getSession().then((session) => {
    if (!session) return;
    channel = supabase()
      .channel("flock:friendships")
      .on("postgres_changes", { event: "*", schema: "public", table: "friendships" }, () => onChange())
      .subscribe();
  }).catch(() => {});
  return () => { if (channel) supabase().removeChannel(channel).catch(() => {}); };
}

/** Realtime "an update was posted" nudge: fires whenever a row is inserted into
 * the public `releases` table (written by release.sh right after it publishes
 * latest.json), so a running app shows the update pill the moment we ship
 * instead of on its next poll. Public + works signed-out; best-effort — if
 * realtime isn't enabled the app's own recheck interval still catches it. */
export function subscribeReleaseAnnouncements(onRelease: () => void): () => void {
  if (!isIdConfigured()) return () => {};
  const channel = supabase()
    .channel("flock:releases")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "releases" }, () => onRelease())
    .subscribe();
  return () => { supabase().removeChannel(channel).catch(() => {}); };
}

// ─── Invites & referrals ──────────────────────────────────────────────────────

export type AddFriendResult = "requested" | "invited" | "already" | "self";

/** One box, two behaviors: an email goes through the invite-aware RPC
 * (request if they exist, recorded invite if not); anything else is treated
 * as a handle. A leading @ on handles is tolerated — the sidebar shows
 * handles that way. */
export async function addFriendOrInvite(input: string): Promise<AddFriendResult> {
  const q = input.trim();
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(q)) {
    const { data, error } = await supabase().rpc("add_friend_by_email", { target_email: q });
    if (error) throw new Error(error.message);
    return data as AddFriendResult;
  }
  await sendFriendRequest(q.replace(/^@/, ""));
  return "requested";
}

/** How many invited people actually signed up — the free-after-beta meter. */
export async function getReferralCount(): Promise<number> {
  const session = await getSession();
  if (!session) return 0;
  const { count, error } = await supabase()
    .from("referrals")
    .select("*", { count: "exact", head: true })
    .eq("inviter", session.user.id);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

/** Prefilled personal invite, sent from the inviter's own mail app —
 * better deliverability and conversion than any transactional email. */
export function inviteMailto(email: string, myHandle: string | null): string {
  const subject = "Join me in flock";
  const body =
    `I run my coding agents in flock, a cockpit for Claude Code, OpenCode, and Codex.\n\n` +
    `Grab it here: https://theflock.sh${myHandle ? `/?ref=${encodeURIComponent(myHandle)}` : ""}\n\n` +
    `Sign in with Google using this email address and we'll be connected automatically` +
    (myHandle ? ` (I'm @${myHandle} in there).` : `.`);
  return `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/** Delivery endpoint for invite emails (presence-auth Vercel service). */
const INVITE_URL =
  ((import.meta as { env?: Record<string, string> }).env?.VITE_INVITE_URL) ||
  "https://presence-auth.vercel.app/api/invite";

/** Ask flock's mail service to deliver the invite. The invite row is
 * already recorded by add_friend_by_email; this is delivery only. Throws
 * when the service can't send (e.g. sending domain not verified yet) — the
 * caller falls back to a prefilled mailto so the invite still goes out. */
export async function sendInviteEmail(email: string): Promise<void> {
  const session = await getSession();
  if (!session) throw new Error("not signed in");
  const res = await fetch(INVITE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: session.access_token, email }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `invite send failed (${res.status})`);
  }
}

// ─── Realtime friend-graph events ─────────────────────────────────────────────

export type FriendEvent =
  | { kind: "request_in"; from: IdProfile }
  | { kind: "accepted"; by: IdProfile };

/** Live friendship changes for the signed-in user: incoming requests
 * (INSERT where we're the addressee) and accepts of our outgoing requests
 * (UPDATE to accepted where we're the requester). RLS scopes what the
 * socket may see; the filters scope what we ask for. */
export function subscribeFriendEvents(
  myId: string,
  onEvent: (e: FriendEvent) => void,
): () => void {
  if (!isIdConfigured()) return () => {};
  const sb = supabase();

  const profileOf = async (id: string): Promise<IdProfile | null> => {
    const { data } = await sb
      .from("profiles")
      .select("id, handle, display_name, avatar_url")
      .eq("id", id)
      .maybeSingle();
    return data;
  };

  const channel = sb
    .channel(`friendships:${myId}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "friendships", filter: `addressee=eq.${myId}` },
      async (payload) => {
        const row = payload.new as { requester: string; status: string };
        const from = await profileOf(row.requester);
        if (from) onEvent(row.status === "accepted"
          ? { kind: "accepted", by: from } // invite-signup auto-friendships arrive pre-accepted
          : { kind: "request_in", from });
      },
    )
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "friendships", filter: `requester=eq.${myId}` },
      async (payload) => {
        const row = payload.new as { addressee: string; status: string };
        if (row.status !== "accepted") return;
        const by = await profileOf(row.addressee);
        if (by) onEvent({ kind: "accepted", by });
      },
    )
    .subscribe();

  return () => { sb.removeChannel(channel).catch(() => {}); };
}

// ─── Orgs & teams (008_orgs_teams.sql) ────────────────────────────────────────
// Server-side tenancy. All writes go through SECURITY DEFINER RPCs; reads ride
// the member-scoped RLS. The desktop mirrors the active membership into the
// local knowledge graph (same UUIDs) so agent spawns are tenant-scoped.

export type OrgRole = "owner" | "admin" | "member";

export interface TeamSummary {
  id: string;
  name: string;
  /** Whether the signed-in user has joined this team. */
  joined: boolean;
}

export interface OrgSummary {
  id: string;
  name: string;
  role: OrgRole;
  teams: TeamSummary[];
}

export interface OrgMember {
  id: string;
  handle: string | null;
  avatar_url: string | null;
  role: OrgRole;
}

export interface OrgInvite {
  org_id: string;
  org_name: string;
  invited_by_handle: string | null;
}

/** Every org the signed-in user belongs to, with its teams and which of them
 * they've joined. */
export async function listMyOrgs(): Promise<OrgSummary[]> {
  const session = await getSession();
  if (!session) return [];
  const sb = supabase();
  const [{ data: memberships, error: mErr }, { data: joined, error: jErr }] = await Promise.all([
    sb.from("org_members")
      .select("role, orgs(id, name, teams(id, name))")
      .eq("profile_id", session.user.id)
      .returns<{ role: OrgRole; orgs: { id: string; name: string; teams: { id: string; name: string }[] } }[]>(),
    sb.from("team_members").select("team_id").eq("profile_id", session.user.id),
  ]);
  if (mErr) throw new Error(mErr.message);
  if (jErr) throw new Error(jErr.message);
  const mine = new Set((joined ?? []).map((r) => r.team_id as string));
  return (memberships ?? []).map((m) => ({
    id: m.orgs.id,
    name: m.orgs.name,
    role: m.role,
    teams: (m.orgs.teams ?? []).map((t) => ({ ...t, joined: mine.has(t.id) })),
  }));
}

export async function createOrg(name: string): Promise<string> {
  const { data, error } = await supabase().rpc("create_org", { p_name: name });
  if (error) throw new Error(error.message);
  return data as string;
}

export async function createTeam(orgId: string, name: string): Promise<string> {
  const { data, error } = await supabase().rpc("create_team", { p_org: orgId, p_name: name });
  if (error) {
    throw new Error(/duplicate|unique/i.test(error.message) ? "That team already exists." : error.message);
  }
  return data as string;
}

/** Invite an exact handle. Returns "member" when they already belong. */
export async function inviteToOrg(orgId: string, handle: string): Promise<"invited" | "member"> {
  const { data, error } = await supabase().rpc("invite_to_org", { p_org: orgId, p_handle: handle });
  if (error) {
    throw new Error(/no such handle/i.test(error.message) ? `No one goes by "${handle.trim()}".` : error.message);
  }
  return data as "invited" | "member";
}

export async function respondOrgInvite(orgId: string, accept: boolean): Promise<void> {
  const { error } = await supabase().rpc("respond_org_invite", { p_org: orgId, p_accept: accept });
  if (error) throw new Error(error.message);
}

export async function joinTeam(teamId: string): Promise<void> {
  const { error } = await supabase().rpc("join_team", { p_team: teamId });
  if (error) throw new Error(error.message);
}

export async function leaveTeam(teamId: string): Promise<void> {
  const { error } = await supabase().rpc("leave_team", { p_team: teamId });
  if (error) throw new Error(error.message);
}

export async function leaveOrg(orgId: string): Promise<void> {
  const { error } = await supabase().rpc("leave_org", { p_org: orgId });
  if (error) throw new Error(error.message);
}

/** Roster with handles — a definer RPC because teammates aren't necessarily
 * friends, so a plain profiles join would come back with nulls. */
export async function listOrgMembers(orgId: string): Promise<OrgMember[]> {
  const { data, error } = await supabase().rpc("list_org_members", { p_org: orgId });
  if (error) throw new Error(error.message);
  return (data ?? []) as OrgMember[];
}

export async function listMyOrgInvites(): Promise<OrgInvite[]> {
  const session = await getSession();
  if (!session) return [];
  const { data, error } = await supabase().rpc("my_org_invites");
  if (error) throw new Error(error.message);
  return (data ?? []) as OrgInvite[];
}
