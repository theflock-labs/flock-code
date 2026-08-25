// First-launch onboarding, gated the same way as theme/uiScale prefs — a
// simple localStorage flag, no backend persistence needed for this.

const STORAGE_KEY = "flock:onboarding-seen";

export function hasSeenOnboarding(): boolean {
  return localStorage.getItem(STORAGE_KEY) === "1";
}

export function markOnboardingSeen(): void {
  localStorage.setItem(STORAGE_KEY, "1");
}
