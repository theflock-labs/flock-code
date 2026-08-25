import { listMyOrgs, type OrgSummary } from "./flockId";
import { graphMirrorMembership } from "./tauri";
import { getGraphEnabled } from "./graphSettings";

// Which org/team this machine works as. Selection is local (like theme or
// dock layout); membership itself lives server-side in flock ID. The
// selection is mirrored into the local knowledge graph so agent spawns carry
// FLOCK_ORG_ID/TEAM_ID (see graph_mirror_membership).

export interface ActiveTeam {
  orgId: string;
  /** null = the whole org, no team scoping. */
  teamId: string | null;
}

const KEY = "flock:active-team";
const CHANGE_EVENT = "flock:active-team-changed";

export function getActiveTeam(): ActiveTeam | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    return typeof v?.orgId === "string" ? { orgId: v.orgId, teamId: v.teamId ?? null } : null;
  } catch {
    return null;
  }
}

export function setActiveTeam(t: ActiveTeam | null): void {
  if (t) localStorage.setItem(KEY, JSON.stringify(t));
  else localStorage.removeItem(KEY);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function onActiveTeamChange(fn: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, fn);
  return () => window.removeEventListener(CHANGE_EVENT, fn);
}

/** Push the active membership into the local graph. Best-effort: a down
 * engine just means the next sync (launch, or the next selection change)
 * retries. Clears a selection whose membership was revoked server-side. */
export async function syncActiveTeamMirror(orgs?: OrgSummary[]): Promise<void> {
  if (!getGraphEnabled()) return;
  const active = getActiveTeam();
  if (!active) return;
  const list = orgs ?? (await listMyOrgs().catch(() => [] as OrgSummary[]));
  const org = list.find((o) => o.id === active.orgId);
  if (!org) {
    setActiveTeam(null);
    return;
  }
  const team = active.teamId
    ? org.teams.find((t) => t.id === active.teamId && t.joined) ?? null
    : null;
  await graphMirrorMembership({
    orgId: org.id,
    orgName: org.name,
    teamId: team?.id ?? null,
    teamName: team?.name ?? null,
    role: org.role,
  }).catch(() => {});
}
