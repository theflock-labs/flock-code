// Whether GitHub integration (PR checks, notifications) is active. Separate
// from connection state — a user can stay signed in with `gh` but turn the
// in-app integration off. Frontend-only preference, no backend involved.

const STORAGE_KEY = "flock:github-integration-enabled";

export function getGithubIntegrationEnabled(): boolean {
  const v = localStorage.getItem(STORAGE_KEY);
  return v === null ? true : v === "true";
}

export function setGithubIntegrationEnabled(enabled: boolean) {
  localStorage.setItem(STORAGE_KEY, String(enabled));
}
