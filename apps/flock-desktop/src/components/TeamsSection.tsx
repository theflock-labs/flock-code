import { useCallback, useEffect, useState } from "react";
import {
  createOrg,
  createTeam,
  inviteToOrg,
  respondOrgInvite,
  joinTeam,
  leaveTeam,
  leaveOrg,
  listMyOrgs,
  listMyOrgInvites,
  listOrgMembers,
  type OrgInvite,
  type OrgMember,
  type OrgSummary,
} from "../lib/flockId";
import { getActiveTeam, setActiveTeam, syncActiveTeamMirror, type ActiveTeam } from "../lib/teamSettings";
import { getGraphEnabled } from "../lib/graphSettings";

/** Settings → Teams. Membership lives server-side on flock ID; which
 * org/team this machine works as is a local selection, mirrored into the
 * knowledge graph so agent spawns are tenant-scoped. */
export default function TeamsSection() {
  const [orgs, setOrgs] = useState<OrgSummary[] | null>(null);
  const [invites, setInvites] = useState<OrgInvite[]>([]);
  const [active, setActive] = useState<ActiveTeam | null>(getActiveTeam());
  const [members, setMembers] = useState<Record<string, OrgMember[]>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [newOrgName, setNewOrgName] = useState("");
  const [newTeamName, setNewTeamName] = useState<Record<string, string>>({});
  const [inviteHandle, setInviteHandle] = useState<Record<string, string>>({});
  const [inviteNote, setInviteNote] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const [o, i] = await Promise.all([listMyOrgs(), listMyOrgInvites()]);
      setOrgs(o);
      setInvites(i);
      setError("");
      // Rosters are small; fetch eagerly so the section renders complete.
      const rosters = await Promise.all(o.map((org) => listOrgMembers(org.id).catch(() => [])));
      setMembers(Object.fromEntries(o.map((org, idx) => [org.id, rosters[idx]])));
    } catch (e) {
      setOrgs([]);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  /** Run a mutation, then reload and re-mirror. Every action funnels through
   * here so the server, the list, and the graph mirror can't drift. */
  const act = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await load();
      await syncActiveTeamMirror();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [load]);

  const selectActive = (t: ActiveTeam | null) => {
    setActiveTeam(t);
    setActive(t);
    void syncActiveTeamMirror();
  };

  const graphOff = !getGraphEnabled();

  return (
    <>
      {invites.length > 0 && (
        <div className="settings-section">
          <div className="settings-section-header">Pending invites</div>
          {invites.map((inv) => (
            <div className="org-invite" key={inv.org_id}>
              <span>
                <span className="org-invite-name">{inv.org_name}</span>
                {inv.invited_by_handle && (
                  <span className="org-invite-from"> · invited by @{inv.invited_by_handle}</span>
                )}
              </span>
              <span className="org-invite-actions">
                <button className="btn-mint-solid settings-btn" disabled={busy} onClick={() => act(() => respondOrgInvite(inv.org_id, true))}>Join</button>
                <button className="btn-ghost settings-btn" disabled={busy} onClick={() => act(() => respondOrgInvite(inv.org_id, false))}>Decline</button>
              </span>
            </div>
          ))}
        </div>
      )}

      {orgs === null ? (
        <div className="settings-section"><div className="settings-hint">Loading…</div></div>
      ) : orgs.length === 0 ? (
        <div className="settings-section">
          <div className="settings-section-header">Teams</div>
          <div className="settings-hint">
            You're not in an org yet. Create one below and invite teammates by
            handle — your agents will scope their shared knowledge graph to the
            team, so what one agent learns, the team's agents can build on.
          </div>
        </div>
      ) : (
        <div className="settings-section" style={{ gap: 12 }}>
          {orgs.map((org) => {
            const roster = members[org.id] ?? [];
            const isAdmin = org.role === "owner" || org.role === "admin";
            const joinedTeams = org.teams.filter((t) => t.joined);
            const scopeValue = active?.orgId === org.id ? active.teamId ?? "__org__" : "__off__";
            const scopedHere = active?.orgId === org.id;

            return (
              <div className="org-card" key={org.id}>
                {/* Identity */}
                <div className="org-card-head">
                  <span className="org-card-name">{org.name}</span>
                  <span className={`org-role-badge${org.role === "owner" ? " owner" : ""}`}>{org.role}</span>
                </div>

                {/* Working-as scope — the reason this tab exists. */}
                <div className="org-group">
                  <div className="org-scope-control">
                    <span className="settings-label">Working as</span>
                    <select
                      className="modal-input org-scope-select"
                      disabled={busy}
                      value={scopeValue}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v === "__off__") selectActive(null);
                        else if (v === "__org__") selectActive({ orgId: org.id, teamId: null });
                        else selectActive({ orgId: org.id, teamId: v });
                      }}
                    >
                      <option value="__off__">Off — no team scope</option>
                      <option value="__org__">Whole org · {org.name}</option>
                      {joinedTeams.map((t) => (
                        <option key={t.id} value={t.id}>Team · {t.name}</option>
                      ))}
                    </select>
                  </div>
                  <div className="settings-hint">
                    {scopedHere
                      ? "New agents here share this scope's knowledge graph with teammates working as the same scope."
                      : "Pick a scope to share this machine's agent knowledge graph with your teammates."}
                  </div>
                  {graphOff && scopedHere && (
                    <div className="settings-hint" style={{ color: "var(--yellow)" }}>
                      Turn on the knowledge graph (Graph tab) for this scoping to reach your agents.
                    </div>
                  )}
                </div>

                {/* Teams */}
                <div className="org-group">
                  <div className="org-subhead">Teams{org.teams.length > 0 && <span className="count"> · {org.teams.length}</span>}</div>
                  {org.teams.length > 0 ? (
                    <div className="org-list">
                      {org.teams.map((t) => (
                        <div className="org-list-row" key={t.id}>
                          <span className="org-team-name">
                            <span className={`org-team-dot${active?.orgId === org.id && active.teamId === t.id ? " active" : ""}`} />
                            {t.name}
                          </span>
                          {t.joined ? (
                            <button className="btn-ghost settings-btn" disabled={busy} onClick={() => act(() => leaveTeam(t.id))}>Leave</button>
                          ) : (
                            <button className="btn-ghost settings-btn" disabled={busy} onClick={() => act(() => joinTeam(t.id))}>Join</button>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="settings-hint">No teams yet.{isAdmin ? " Create one to group teammates into a working scope." : ""}</div>
                  )}
                  {isAdmin && (
                    <div className="org-inline-form">
                      <input
                        className="modal-input"
                        placeholder="New team name"
                        value={newTeamName[org.id] ?? ""}
                        onChange={(e) => setNewTeamName((m) => ({ ...m, [org.id]: e.target.value }))}
                      />
                      <button
                        className="btn-ghost settings-btn"
                        disabled={busy || !(newTeamName[org.id] ?? "").trim()}
                        onClick={() => act(async () => {
                          await createTeam(org.id, (newTeamName[org.id] ?? "").trim());
                          setNewTeamName((m) => ({ ...m, [org.id]: "" }));
                        })}
                      >
                        Create team
                      </button>
                    </div>
                  )}
                </div>

                {/* Members */}
                <div className="org-group">
                  <div className="org-subhead">Members<span className="count"> · {roster.length}</span></div>
                  <div className="org-list">
                    {roster.map((m) => {
                      const handle = m.handle ?? null;
                      return (
                        <div className="org-list-row" key={m.id}>
                          <span className="org-member">
                            <span className="org-avatar">{(handle ?? "?").charAt(0).toUpperCase()}</span>
                            <span className="org-member-handle">{handle ? `@${handle}` : "(no handle yet)"}</span>
                          </span>
                          <span className="org-member-role">{m.role}</span>
                        </div>
                      );
                    })}
                  </div>
                  {isAdmin && (
                    <div className="org-inline-form">
                      <input
                        className="modal-input"
                        placeholder="Invite by handle"
                        value={inviteHandle[org.id] ?? ""}
                        onChange={(e) => setInviteHandle((m) => ({ ...m, [org.id]: e.target.value }))}
                      />
                      <button
                        className="btn-ghost settings-btn"
                        disabled={busy || !(inviteHandle[org.id] ?? "").trim()}
                        onClick={() => act(async () => {
                          const result = await inviteToOrg(org.id, (inviteHandle[org.id] ?? "").trim());
                          setInviteNote((m) => ({ ...m, [org.id]: result === "member" ? "Already a member." : "Invite sent." }));
                          setInviteHandle((m) => ({ ...m, [org.id]: "" }));
                        })}
                      >
                        Invite
                      </button>
                    </div>
                  )}
                  {inviteNote[org.id] && <div className="org-inline-note">{inviteNote[org.id]}</div>}
                </div>

                {/* Destructive */}
                <div className="org-card-footer">
                  <button
                    className="btn-ghost settings-btn org-leave-btn"
                    disabled={busy}
                    onClick={() => act(async () => {
                      await leaveOrg(org.id);
                      if (active?.orgId === org.id) selectActive(null);
                    })}
                  >
                    Leave org
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="settings-section">
        <div className="settings-section-header">New org</div>
        <div className="org-inline-form">
          <input
            className="modal-input"
            placeholder="Org name"
            value={newOrgName}
            onChange={(e) => setNewOrgName(e.target.value)}
          />
          <button
            className="btn-ghost settings-btn"
            disabled={busy || !newOrgName.trim()}
            onClick={() => act(async () => {
              const id = await createOrg(newOrgName.trim());
              setNewOrgName("");
              // Creating an org is an intent to work as it.
              selectActive({ orgId: id, teamId: null });
            })}
          >
            Create
          </button>
        </div>
      </div>

      {error && <div className="settings-error" style={{ marginTop: 10 }}>{error}</div>}
    </>
  );
}
