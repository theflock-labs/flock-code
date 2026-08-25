// flock Graph opt-in. Strictly off by default — the graph runs local
// infrastructure (Docker + Postgres) and shares context between agents, so
// it only ever activates by explicit user choice.

const STORAGE_KEY = "flock:graph-enabled";
const EVENT = "flock:graph-enabled-changed";

/** Cross-component request to open the flock Graph setup wizard —
 * dispatched from Settings and the onboarding tutorial, handled in App. */
export const OPEN_GRAPH_SETUP_EVENT = "flock:open-graph-setup";

/** Cross-component request to open the full Graph Explorer, dispatched from
 * the sidebar Graph card and handled in App. */
export const OPEN_GRAPH_EXPLORER_EVENT = "flock:open-graph-explorer";

export function getGraphEnabled(): boolean {
  return localStorage.getItem(STORAGE_KEY) === "1";
}

export function setGraphEnabled(enabled: boolean): void {
  localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
  window.dispatchEvent(new CustomEvent<boolean>(EVENT, { detail: enabled }));
}

/** Subscribe to opt-in changes. Returns an unsubscribe fn. */
export function onGraphEnabledChange(handler: (enabled: boolean) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<boolean>).detail);
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}

// ── Graph location ──────────────────────────────────────────────────────────
// Default: the local Docker engine flock manages. Teams can instead point
// every teammate's flock at one centrally hosted Postgres, turning the
// graph into shared team memory: decisions, attempts, and file ownership
// visible to every cockpit that connects.

const URL_KEY = "flock:graph-url";

export const DEFAULT_GRAPH_URL = "postgresql://flock:flock@127.0.0.1:15432/flock_kg";

export function getGraphUrl(): string {
  const v = localStorage.getItem(URL_KEY)?.trim();
  return v || DEFAULT_GRAPH_URL;
}

export function setGraphUrl(url: string): void {
  const v = url.trim();
  if (!v || v === DEFAULT_GRAPH_URL) localStorage.removeItem(URL_KEY);
  else localStorage.setItem(URL_KEY, v);
  // Re-announce the enabled state so everything that bakes the URL in rebuilds
  // against the new one — above all the grounding hooks, whose command string
  // embeds FLOCK_KG_URL literally at install time. Without this, switching to a
  // team graph left every agent's per-prompt recall pointed at the old database
  // until the next app launch, with nothing on screen to suggest it.
  if (getGraphEnabled()) {
    window.dispatchEvent(new CustomEvent<boolean>(EVENT, { detail: true }));
  }
}

/** True when pointing at a team-hosted graph rather than the managed local engine. */
export function isTeamGraph(): boolean {
  return getGraphUrl() !== DEFAULT_GRAPH_URL;
}
