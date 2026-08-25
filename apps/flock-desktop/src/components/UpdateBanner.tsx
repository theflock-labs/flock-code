import { useEffect, useRef, useState } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import { checkForUpdate, downloadUpdate, installAndRestart } from "../lib/updater";
import { subscribeReleaseAnnouncements } from "../lib/flockId";

// Re-check on launch and then every few hours, so a long-running cockpit
// still notices a release without a restart.
const RECHECK_MS = 6 * 60 * 60 * 1000;

/**
 * Silent-download / prompt-to-restart updater, mirroring Claude Desktop: the
 * user only ever sees a small "Restart to update to vX.Y.Z" pill once the new
 * version is already on disk and one relaunch away.
 */
export default function UpdateBanner() {
  const [ready, setReady] = useState<Update | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const busy = useRef(false);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      // One at a time: a check already downloading shouldn't stack.
      if (busy.current) return;
      busy.current = true;
      try {
        const update = await checkForUpdate();
        if (!update || cancelled) return;
        await downloadUpdate(update);
        if (!cancelled) {
          setDismissed(false);
          setReady(update);
        }
      } finally {
        busy.current = false;
      }
    }

    run();
    const id = setInterval(run, RECHECK_MS);
    // Instant path: the moment a release is posted, Supabase Realtime nudges us
    // to re-check now rather than waiting up to RECHECK_MS for the poll.
    const unsub = subscribeReleaseAnnouncements(() => { void run(); });
    return () => {
      cancelled = true;
      clearInterval(id);
      unsub();
    };
  }, []);

  if (!ready || dismissed) return null;

  const restart = async () => {
    setRestarting(true);
    try {
      await installAndRestart(ready);
    } catch (e) {
      // Install failed (rare) — let them dismiss and try again next launch.
      console.error("update install failed", e);
      setRestarting(false);
    }
  };

  return (
    <div className="update-banner" role="status">
      <span className="update-banner-dot" aria-hidden />
      <span className="update-banner-text">
        Restart to update to <strong>v{ready.version}</strong>
      </span>
      <button className="update-banner-btn" onClick={restart} disabled={restarting}>
        {restarting ? "Restarting…" : "Restart"}
      </button>
      <button
        className="update-banner-x"
        onClick={() => setDismissed(true)}
        aria-label="Later"
        disabled={restarting}
      >
        ×
      </button>
    </div>
  );
}
