import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { githubCheck } from "../lib/tauri";
import { Avatar } from "./Avatar";
import type { GitHubStatus } from "../types";
import {
  claimHandle,
  getReferralCount,
  getIdConfig,
  getMyProfile,
  getSession,
  isIdConfigured,
  onAuthChange,
  setIdConfig,
  signIn,
  signOut,
  type IdProfile,
  type IdProvider,
} from "../lib/flockId";

/** Settings → Account: the flock ID. Sign in with Google, claim a handle
 * (that's what friends add you by), sign out. Friendships key off this
 * account; GitHub stays a separate, repo-scoped connection. */
export default function AccountSection() {
  const [configured, setConfigured] = useState(isIdConfigured());
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<IdProfile | null>(null);
  const [busy, setBusy] = useState<IdProvider | null>(null);
  const [error, setError] = useState("");
  const [handleInput, setHandleInput] = useState("");
  const [handleSaving, setHandleSaving] = useState(false);
  const [handleSaved, setHandleSaved] = useState(false);

  // Config inputs shown only while unconfigured (pre-release / self-hosting).
  const [urlInput, setUrlInput] = useState(getIdConfig().url);
  const [keyInput, setKeyInput] = useState(getIdConfig().anonKey);
  const [gh, setGh] = useState<GitHubStatus | null>(null);
  const [referrals, setReferrals] = useState<number | null>(null);

  useEffect(() => {
    githubCheck().then(setGh).catch(() => {});
    getReferralCount().then(setReferrals).catch(() => {});
  }, []);

  const refresh = useCallback(async () => {
    if (!isIdConfigured()) return;
    const s = await getSession().catch(() => null);
    setSession(s);
    if (s) {
      const p = await getMyProfile().catch(() => null);
      setProfile(p);
      setHandleInput(p?.handle ?? "");
    } else {
      setProfile(null);
    }
  }, []);

  useEffect(() => {
    refresh();
    return onAuthChange(() => refresh());
  }, [refresh, configured]);

  const doSignIn = async (provider: IdProvider) => {
    setError("");
    setBusy(provider);
    try {
      await signIn(provider);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const saveHandle = async () => {
    const next = handleInput.trim().toLowerCase();
    if (!next || next === (profile?.handle ?? "")) return;
    setHandleSaving(true);
    setError("");
    try {
      await claimHandle(next);
      setHandleSaved(true);
      setTimeout(() => setHandleSaved(false), 2000);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setHandleSaving(false);
    }
  };

  if (!configured) {
    return (
      <div className="settings-section">
        <div className="settings-section-header">flock ID</div>
        <div className="settings-hint">
          Point flock at your Supabase project: a project URL and anon key
          from Supabase → Settings → API, with Google sign-in enabled under
          Authentication. Release builds ship with this baked in.
        </div>
        <div className="settings-row">
          <span className="settings-label">Project URL</span>
          <input
            className="modal-input"
            style={{ width: 260, padding: "4px 8px", fontSize: 12 }}
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="https://xxxx.supabase.co"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="settings-row">
          <span className="settings-label">Anon key</span>
          <input
            className="modal-input"
            style={{ width: 260, padding: "4px 8px", fontSize: 12 }}
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            placeholder="eyJ…"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="settings-row">
          <span />
          <button
            className="btn-ghost settings-btn"
            disabled={!urlInput.trim() || !keyInput.trim()}
            onClick={() => {
              setIdConfig(urlInput, keyInput);
              setConfigured(isIdConfigured());
            }}
          >
            Save
          </button>
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="settings-section">
        <div className="settings-section-header">flock ID</div>
        <div className="settings-hint">
          One account for friends, shared sessions, and everything to come.
          Sign-in opens your browser; you land back here.
        </div>
        <div className="settings-row" style={{ gap: 8, justifyContent: "flex-start" }}>
          <button
            className="btn-ghost settings-btn"
            disabled={busy !== null}
            onClick={() => doSignIn("google")}
          >
            {busy === "google" ? "Waiting for browser…" : "Sign in with Google"}
          </button>
        </div>
        {error && <div className="settings-hint" style={{ color: "var(--yellow)" }}>{error}</div>}
      </div>
    );
  }

  const provider = (session.user.app_metadata?.provider as string | undefined) ?? "email";
  const providerLabel = provider === "google" ? "Google" : provider;
  const memberSince = session.user.created_at
    ? new Date(session.user.created_at).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })
    : null;

  return (
    <>
      {/* ─── Who you are ─────────────────────────────────────────────── */}
      <div className="settings-section">
        <div className="settings-section-header">flock ID</div>
        <div className="account-card">
          <Avatar
            url={profile?.avatar_url}
            seed={profile?.display_name ?? session.user.email}
            imgClassName="account-avatar"
            fallbackClassName="account-avatar account-avatar-placeholder"
          />
          <div className="account-card-main">
            <div className="account-card-name">
              {profile?.display_name ?? session.user.email}
              {profile?.handle && <span className="account-card-handle">@{profile.handle}</span>}
            </div>
            <div className="account-card-email">{session.user.email}</div>
            {memberSince && <div className="account-card-since">flying since {memberSince}</div>}
          </div>
          <span className="account-provider-chip" title={`Signed in with ${providerLabel}`}>
            via {providerLabel}
          </span>
        </div>
        <div className="settings-row">
          <div>
            <div className="settings-label" style={{ fontWeight: 600, color: "var(--text-hi)" }}>Handle</div>
            <div className="settings-hint" style={{ margin: 0 }}>
              How friends find you. Changing it changes it everywhere.
            </div>
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--mint)" }}>@</span>
            <input
              className="modal-input"
              style={{ width: 140, padding: "4px 8px", fontSize: 12 }}
              value={handleInput}
              onChange={(e) => setHandleInput(e.target.value)}
              placeholder="pick-a-handle"
              autoComplete="off"
              spellCheck={false}
              onKeyDown={(e) => { if (e.key === "Enter") saveHandle(); }}
            />
            <button
              className="btn-ghost settings-btn"
              onClick={saveHandle}
              disabled={handleSaving || handleInput.trim().toLowerCase() === (profile?.handle ?? "")}
            >
              {handleSaving ? "Saving…" : handleSaved ? "Saved" : "Save"}
            </button>
          </div>
        </div>
      </div>

      {/* ─── Referrals ───────────────────────────────────────────────── */}
      <div className="settings-section">
        <div className="settings-section-header">Referrals</div>
        <div className="referral-card">
          <div className="referral-count">{referrals ?? 0}</div>
          <div className="referral-copy">
            <div className="referral-copy-main">
              {referrals === 1 ? "friend joined through you" : "friends joined through you"}
            </div>
            <div className="referral-copy-sub">
              Invite by email from the Friends tab, and see who's joined
              through you.
            </div>
          </div>
        </div>
      </div>

      {/* ─── Connections ─────────────────────────────────────────────── */}
      <div className="settings-section">
        <div className="settings-section-header">Connections</div>
        <div className="settings-row">
          <div>
            <div className="settings-label" style={{ fontWeight: 600, color: "var(--text-hi)" }}>GitHub</div>
            <div className="settings-hint" style={{ margin: 0 }}>
              Powers PRs, checks, and reviews. Managed in the GitHub tab.
            </div>
          </div>
          <span className="conn-status">
            <span className={`conn-dot${gh?.connected ? " on" : ""}`} />
            {gh?.connected ? gh.user ?? "connected" : "not connected"}
          </span>
        </div>
      </div>

      {/* ─── Session ─────────────────────────────────────────────────── */}
      <div className="settings-section">
        <div className="settings-section-header">Session</div>
        <div className="settings-row">
          <div>
            <div className="settings-label" style={{ fontWeight: 600, color: "var(--text-hi)" }}>Sign out</div>
            <div className="settings-hint" style={{ margin: 0 }}>
              Locks the cockpit until the next sign-in. Agents keep running.
            </div>
          </div>
          <button
            className="btn-ghost settings-btn"
            onClick={() => signOut().then(refresh).catch((e) => setError(String(e)))}
          >
            Sign out
          </button>
        </div>
        {error && <div className="settings-hint" style={{ color: "var(--yellow)" }}>{error}</div>}
      </div>
    </>
  );
}
