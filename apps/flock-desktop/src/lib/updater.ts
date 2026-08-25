import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

/**
 * Auto-update, Claude-Desktop style: check quietly, download in the
 * background, then surface a single "Restart to update to vX.Y.Z" prompt.
 * Installing (which swaps the .app bundle on disk) is deferred until the
 * user hits Restart, so an update never interrupts a working session.
 *
 * The `check()` endpoint + signature key live in tauri.conf.json
 * (plugins.updater). A build that isn't updater-signed simply returns null.
 */

/** Look for a newer release. Returns the pending Update, or null if current. */
export async function checkForUpdate(): Promise<Update | null> {
  try {
    const update = await check();
    return update && update.available ? update : null;
  } catch (e) {
    // Offline, no release yet, or a dev build with no signing key — never fatal.
    console.warn("update check failed", e);
    return null;
  }
}

/** Download the pending update's bytes without installing them yet. */
export async function downloadUpdate(update: Update): Promise<void> {
  await update.download();
}

/** Apply the already-downloaded update and relaunch into the new version. */
export async function installAndRestart(update: Update): Promise<void> {
  await update.install();
  await relaunch();
}
