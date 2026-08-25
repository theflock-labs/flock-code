import { useState } from "react";
import GooseMark from "./GooseMark";
import Wordmark from "./Wordmark";
import {
  claimHandle,
  getIdConfig,
  getMyProfile,
  isIdConfigured,
  setIdConfig,
  signIn,
  type IdProvider,
} from "../lib/flockId";

interface Props {
  /** Session check still in flight: render the shell without controls so a
   * signed-in user never sees sign-in buttons flash on launch. */
  checking: boolean;
  /** Signed in but no handle yet → skip straight to the claim step. */
  needsHandle: boolean;
  /** Sign-in / handle-claim finished — the app re-reads ID state. */
  onReady: () => void;
}

const GoogleMark = () => (
  <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
  </svg>
);

/** Full-screen entrance: flock requires a flock ID, and this is the
 * first thing a new user sees — a title screen, not a form. Handles the
 * whole ladder in place: backend config (dev builds without baked env),
 * federated sign-in, handle claim. */
export default function SignInGate({ checking, needsHandle, onReady }: Props) {
  const [configured, setConfigured] = useState(isIdConfigured());
  const [busy, setBusy] = useState<IdProvider | null>(null);
  const [error, setError] = useState("");
  const [phase, setPhase] = useState<"signin" | "handle">(needsHandle ? "handle" : "signin");
  const [handleInput, setHandleInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [urlInput, setUrlInput] = useState(getIdConfig().url);
  const [keyInput, setKeyInput] = useState(getIdConfig().anonKey);

  const doSignIn = async (provider: IdProvider) => {
    setError("");
    setBusy(provider);
    try {
      await signIn(provider);
      const profile = await getMyProfile().catch(() => null);
      if (profile?.handle) onReady();
      else setPhase("handle");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const saveHandle = async () => {
    const handle = handleInput.trim().toLowerCase();
    if (!handle || saving) return;
    setSaving(true);
    setError("");
    try {
      await claimHandle(handle);
      onReady();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  // Empty chrome around the card is the drag region; the card itself is not,
  // which a bare data-tauri-drag-region gives for free (direct clicks only).
  // On macOS this attribute is the only thing that moves the window — the
  // -webkit-app-region in the stylesheet is a Windows path. See App.tsx.
  return (
    <div className="signin-gate" data-tauri-drag-region>
      <div className="signin-gate-glow" aria-hidden="true" />
      <div className="signin-gate-inner">
        <div style={{ marginBottom: 18 }} className="goose-bob"><GooseMark width={92} flap /></div>
        <Wordmark size={54} className="signin-gate-wordmark" />

        {checking ? (
          <div className="signin-gate-checking">
            <span className="signin-gate-pulse" />
          </div>
        ) : !configured ? (
          <div className="signin-gate-stage">
            <p className="signin-gate-copy">
              This build isn't pointed at a flock ID backend yet.
              Paste the project URL and anon key.
            </p>
            <input
              className="signin-gate-field"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              placeholder="https://xxxx.supabase.co"
              autoComplete="off"
              spellCheck={false}
            />
            <input
              className="signin-gate-field"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder="anon key"
              autoComplete="off"
              spellCheck={false}
            />
            <button
              className="signin-gate-claim"
              disabled={!urlInput.trim() || !keyInput.trim()}
              onClick={() => {
                setIdConfig(urlInput, keyInput);
                setConfigured(isIdConfigured());
              }}
            >
              Connect
            </button>
          </div>
        ) : phase === "signin" ? (
          <div className="signin-gate-stage">
            <p className="signin-gate-copy">
              Your agents are waiting. Sign in to take the chair.
            </p>
            <button
              className="signin-provider-btn"
              disabled={busy !== null}
              onClick={() => doSignIn("google")}
            >
              <GoogleMark />
              <span>{busy === "google" ? "Waiting for your browser…" : "Continue with Google"}</span>
            </button>
            <p className="signin-gate-fineprint">
              Sign-in opens your browser and brings you straight back.
            </p>
          </div>
        ) : (
          <div className="signin-gate-stage">
            <p className="signin-gate-copy">
              Welcome aboard. Pick the handle your friends will know you by.
            </p>
            <div className="signin-handle-row">
              <span className="signin-handle-at">@</span>
              <input
                className="signin-gate-field signin-handle-input"
                value={handleInput}
                onChange={(e) => {
                  setHandleInput(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ""));
                  setError("");
                }}
                onKeyDown={(e) => { if (e.key === "Enter") saveHandle(); }}
                placeholder="your-handle"
                autoComplete="off"
                spellCheck={false}
                autoFocus
              />
            </div>
            <button
              className="signin-gate-claim"
              onClick={saveHandle}
              disabled={saving || handleInput.trim().length < 3}
            >
              {saving ? "Claiming…" : "Claim handle"}
            </button>
            <p className="signin-gate-fineprint">
              Lowercase letters, digits, - and _. Three characters or more.
            </p>
          </div>
        )}

        {error && <div className="signin-gate-error">{error}</div>}
      </div>
    </div>
  );
}
