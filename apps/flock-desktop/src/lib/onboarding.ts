// First-launch onboarding, gated the same way as theme/uiScale prefs — a
// simple localStorage flag, no backend persistence needed for this.

const STORAGE_KEY = "flock:onboarding-seen";
const FIRST_AGENT_KEY = "flock:first-agent-launched";
export const FIRST_AGENT_LAUNCHED_EVENT = "flock:first-agent-launched";
export const OPEN_FEATURE_TOUR_EVENT = "flock:open-feature-tour";

export function hasSeenOnboarding(): boolean {
  return localStorage.getItem(STORAGE_KEY) === "1";
}

export function markOnboardingSeen(): void {
  localStorage.setItem(STORAGE_KEY, "1");
}

export function hasLaunchedFirstAgent(): boolean {
  try { return localStorage.getItem(FIRST_AGENT_KEY) === "1"; }
  catch { return false; }
}

/** Called after a successful spawn, never when a user merely opens setup. */
export function markFirstAgentLaunched(): void {
  if (hasLaunchedFirstAgent()) return;
  // A storage problem must never make a successful backend spawn roll back.
  try {
    localStorage.setItem(FIRST_AGENT_KEY, "1");
    window.dispatchEvent(new Event(FIRST_AGENT_LAUNCHED_EVENT));
  } catch { /* The tour remains available from Settings. */ }
}
