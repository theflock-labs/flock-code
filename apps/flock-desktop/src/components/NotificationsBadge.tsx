import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { onActivateKey } from "../lib/a11y";
import type { CheckRun, WorkspaceChecks } from "../lib/tauri";

export type NotificationStatus = "success" | "failure" | "running" | "info";

/** "pr" = pull-request / CI check events (always prioritized); "agent" =
 * per-agent session chatter (session started, working, finished…). */
export type NotificationCategory = "pr" | "agent";

export interface Notification {
  id: string;
  time: number;
  status: NotificationStatus;
  category: NotificationCategory;
  /** Trips the unread dot and floats to the top. PR events are always
   * priority; agent events only when the agent is actually blocked on you. */
  priority: boolean;
  text: string;
  /** Secondary context line under the title — for agent events this is what
   * the pane is working on (its intent) or where it lives (workspace · agent
   * kind). Kept separate from `text` so the row can render it dimmer. */
  detail?: string;
  url?: string;
  /** Present on agent-category notifications — lets clicking them jump
   * straight to the pane that raised it, same as clicking it in the sidebar. */
  workspaceId?: string;
  paneId?: string;
}

/** An agent whose live status is blocked on the user right now (awaiting_input
 * / blocked) — distinct from the notification *log*, which only records the
 * moment attention was first raised and can be stale. */
export interface AttentionAgent {
  workspaceId: string;
  paneId: string;
  name: string;
  workspaceName: string;
}

/** Live pane tally, for the headline's fallback. Counted from current pane
 * status at render, never from the event log. */
export interface AgentTally {
  working: number;
  total: number;
}

interface Props {
  checks: WorkspaceChecks | null;
  notifications: Notification[];
  attentionAgents: AttentionAgent[];
  agents: AgentTally;
  onOpenPr: () => void;
  onOpenPane: (workspaceId: string, paneId: string) => void;
}

/** Classify a PR's checks into a single overall status. Exported so App.tsx
 * can reuse the same rule when deciding whether to log a "checks passed/
 * failed" notification on a status transition. */
export function overallCheckStatus(checks: CheckRun[]): NotificationStatus {
  if (checks.length === 0) return "info";
  if (checks.some((c) => checkClass(c) === "failure")) return "failure";
  if (checks.some((c) => checkClass(c) === "running")) return "running";
  return "success";
}

function checkClass(c: CheckRun): "success" | "failure" | "running" | "neutral" {
  if (c.conclusion === "success") return "success";
  if (c.conclusion === "failure" || c.conclusion === "timed_out" || c.conclusion === "action_required") return "failure";
  if (c.status === "in_progress") return "running";
  return "neutral";
}

/**
 * Always-visible notification bell, inline in the workspace header. Colored
 * by the focused PR's current check status when there is one; otherwise a
 * plain outline. Click opens a chronological feed of everything that's
 * happened (check pass/fail, new PRs, etc) rather than just a snapshot.
 */
export default function NotificationsBadge({ checks, notifications, attentionAgents, agents, onOpenPr, onOpenPane }: Props) {
  const [open, setOpen] = useState(false);
  // Persisted with the log itself: the log survives a restart, so a lastSeen
  // that resets to 0 makes every event the user already read count as unread
  // again and the bell opens the app claiming a dozen new things.
  const [lastSeen, setLastSeen] = useState(() => {
    const raw = Number(localStorage.getItem(LAST_SEEN_KEY));
    return Number.isFinite(raw) ? raw : 0;
  });
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDocClick);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = () => {
    setOpen((v) => {
      const next = !v;
      if (next) {
        const now = Date.now();
        setLastSeen(now);
        try { localStorage.setItem(LAST_SEEN_KEY, String(now)); } catch { /* ignore */ }
      }
      return next;
    });
  };

  const overall = checks && checks.checks.length > 0 ? overallCheckStatus(checks.checks) : null;
  // Only priority events (PR checks, or an agent actually blocked on you) trip
  // the unread bell — agent activity chatter no longer keeps it lit.
  const unreadCount = notifications.filter((n) => n.time > lastSeen && n.priority).length;
  const sorted = [...notifications].sort((a, b) => b.time - a.time);
  // Collapse runs of the identical event (e.g. "Agent is working" logged
  // repeatedly) into their most-recent occurrence so the feed reads as
  // distinct moments rather than a stutter.
  const activity = sorted.filter((n, i) => {
    const prev = sorted[i - 1];
    return !(prev && prev.text === n.text && prev.detail === n.detail && prev.status === n.status);
  });
  // The always-visible label prefers live checks (as a compound "1 in
  // progress, 3 successful checks" roll-up), then the latest PR event, and
  // falls back to a live tally of the agents themselves.
  const latestPr = sorted.find((n) => n.category === "pr");
  // A live "needs input" outranks everything: it's the one thing the user has
  // to act on. Drawn from current pane status, so it stays accurate even after
  // a later "is working" event would otherwise have buried it in the log.
  const attention = attentionAgents.length > 0;
  const attentionText = attentionAgents.length === 1
    ? `${attentionAgents[0].name} needs input`
    : `${attentionAgents.length} agents need input`;
  const attentionSub = attentionAgents.length === 1 ? attentionAgents[0].workspaceName : undefined;
  const primaryText = attention
    ? attentionText
    : checks && checks.checks.length > 0
      ? `${checksSummary(checks.checks)} checks`
      : checks
        ? `#${checks.pr_number} — no checks`
        : latestPr
          ? latestPr.text
          : agentSummary(agents);

  return (
    <div className="pr-badge-root" ref={rootRef}>
      <button
        className={`pr-badge${attention ? " pr-badge-attention" : overall ? ` pr-badge-${overall}` : ""}`}
        onClick={toggle}
        title={attention ? attentionAgents.map((a) => `${a.name} · ${a.workspaceName}`).join("\n") : checks?.pr_title ?? "Notifications"}
      >
        {attention ? (
          <>
            <span className="pr-badge-bell">
              <BellIcon />
              <span className="pr-badge-bell-count">{attentionAgents.length}</span>
            </span>
            <span className="pr-badge-label">{primaryText}{attentionSub ? ` · ${attentionSub}` : ""}</span>
          </>
        ) : overall ? (
          <>
            <span className="pr-badge-num">#{checks!.pr_number}</span>
            <CheckGlyph status={overall} size={14} />
            <span className="pr-badge-label">{primaryText}</span>
            {unreadCount > 0 && (
              <span className="pr-badge-bell">
                <BellIcon />
                <span className="pr-badge-bell-count">{unreadCount}</span>
              </span>
            )}
          </>
        ) : (
          <>
            <span className={`pr-badge-bell${unreadCount > 0 ? "" : " pr-badge-bell-muted"}`}>
              <BellIcon />
              {unreadCount > 0 && <span className="pr-badge-bell-count">{unreadCount}</span>}
            </span>
            <span className="pr-badge-label">{primaryText}</span>
          </>
        )}
      </button>

      {open && (
        <>
        <div className="pr-popover-caret" aria-hidden="true" />
        <div className="pr-popover">
          {attention && (
            <div className="pr-popover-attention">
              <div className="pr-popover-activity-head">Waiting on you</div>
              {attentionAgents.map((a) => (
                <button
                  key={a.paneId}
                  className="pr-popover-activity-row pr-popover-activity-row-2line pr-popover-attention-row"
                  onClick={() => { onOpenPane(a.workspaceId, a.paneId); setOpen(false); }}
                  title={`${a.name} · ${a.workspaceName}`}
                >
                  <CheckGlyph status="attention" size={13} />
                  <span className="pr-popover-activity-body">
                    <span className="pr-popover-activity-text">{a.name} needs input</span>
                    <span className="pr-popover-activity-detail">{a.workspaceName}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
          {checks ? (
            <div className="pr-popover-card">
              <div className="pr-popover-pr-header">
                <span className={`pr-state-badge pr-state-${checks.pr_state}`}>{checks.pr_state}</span>
                <button className="pr-popover-title" onClick={() => { onOpenPr(); setOpen(false); }}>
                  {checks.pr_title} <span className="pr-popover-pr-number">#{checks.pr_number}</span>
                </button>
              </div>
              {checks.pr_author && (
                <div className="pr-popover-desc">
                  {checks.pr_author} wants to merge {checks.commits} commit{checks.commits === 1 ? "" : "s"} into{" "}
                  <code className="pr-popover-ref">{checks.base_ref}</code> from <code className="pr-popover-ref">{checks.head_ref}</code>
                </div>
              )}
              {(checks.additions > 0 || checks.deletions > 0) && (
                <div className="pr-popover-stats">
                  <span className="pr-popover-stat-add">+{checks.additions.toLocaleString()}</span>
                  <span className="pr-popover-stat-del">-{checks.deletions.toLocaleString()}</span>
                </div>
              )}
              {checks.checks.length > 0 && (
                <>
                  <div className="pr-popover-divider" />
                  <div className="pr-popover-checks-summary">
                    <CheckGlyph status={overall ?? "success"} size={14} />
                    <span>{checksSummary(checks.checks)}</span>
                  </div>
                  <div className="pr-popover-checkruns">
                    {checks.checks.map((c) => (
                      <div
                        key={c.name}
                        className={`pr-popover-checkrun${c.html_url ? " pr-popover-checkrun-linked" : ""}`}
                        onClick={() => c.html_url && openUrl(c.html_url).catch(console.error)}
                        // Only a real link gets button semantics: an unlinked
                        // check row is a fact, not a control.
                        role={c.html_url ? "button" : undefined}
                        tabIndex={c.html_url ? 0 : undefined}
                        onKeyDown={c.html_url ? onActivateKey(() => openUrl(c.html_url!).catch(console.error)) : undefined}
                      >
                        <CheckGlyph status={checkClass(c)} size={13} />
                        <span className="pr-popover-checkrun-name">{c.name}</span>
                        <span className="pr-popover-checkrun-status">{checkLabel(c)}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
              <button className="pr-gh-link" onClick={() => { onOpenPr(); setOpen(false); }}>
                Open on GitHub
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M6 3.5h6.5V10M12.5 3.5L4 12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
          ) : null}

          {/* A compact, capped activity tail — not a full chronological feed.
             The PR card above is the hero; recent agent/PR events sit under it
             as a quiet strip so the popover reads as a card, not a list. */}
          {activity.length > 0 ? (
            <div className="pr-popover-activity">
              <div className="pr-popover-activity-head">{checks ? "Recent activity" : "Notifications"}</div>
              {activity.slice(0, ACTIVITY_CAP).map((n) => (
                <ActivityRow key={n.id} n={n} onOpenPane={onOpenPane} onNavigate={() => setOpen(false)} />
              ))}
              {activity.length > ACTIVITY_CAP && (
                <div className="pr-popover-activity-more">+{activity.length - ACTIVITY_CAP} earlier</div>
              )}
            </div>
          ) : !checks ? (
            <div className="pr-popover-empty">Nothing yet — PR checks and agent updates show up here.</div>
          ) : null}
        </div>
        </>
      )}
    </div>
  );
}

/** Where the "you've read up to here" mark lives, beside the log it belongs
 * to (`flock:notifications`). */
const LAST_SEEN_KEY = "flock:notifications:lastSeen";

/**
 * The headline of last resort — what the agents are doing right now, counted
 * from live pane status.
 *
 * This is deliberately not "the most recent agent event". Those read as states
 * ("Hazel is working", "Kip needs your attention") but are only ever a record
 * of a moment, so the bar went on announcing a turn that ended an hour ago as
 * if it were happening. The log keeps that history, with timestamps, one click
 * away in the popover; the bar itself only says things that are true now.
 */
function agentSummary({ working, total }: AgentTally): string {
  if (total === 0) return "No agents running";
  if (working === 0) return total === 1 ? "1 agent idle" : `${total} agents idle`;
  return working === 1 ? "1 agent working" : `${working} agents working`;
}

/** How many recent events the popover surfaces before collapsing the rest
 * into a "+N earlier" line — keeps the popover a card with a short tail
 * rather than an unbounded feed. */
const ACTIVITY_CAP = 4;

/** One compact activity row — a colored status dot, the event text, and a
 * relative timestamp. PR items open their GitHub URL; agent items jump to the
 * pane that raised them. */
function ActivityRow({ n, onOpenPane, onNavigate }: {
  n: Notification;
  onOpenPane: (workspaceId: string, paneId: string) => void;
  onNavigate: () => void;
}) {
  const linkable = !!n.url || (!!n.workspaceId && !!n.paneId);
  return (
    <button
      className={`pr-popover-activity-row${n.detail ? " pr-popover-activity-row-2line" : ""}`}
      onClick={() => {
        if (n.url) openUrl(n.url).catch(console.error);
        else if (n.workspaceId && n.paneId) onOpenPane(n.workspaceId, n.paneId);
        onNavigate();
      }}
      disabled={!linkable}
      title={n.detail ? `${n.text} — ${n.detail}` : n.text}
    >
      <CheckGlyph status={n.status === "info" ? "neutral" : n.status} size={13} />
      <span className="pr-popover-activity-body">
        <span className="pr-popover-activity-text">{n.text}</span>
        {n.detail && <span className="pr-popover-activity-detail">{n.detail}</span>}
      </span>
      <span className="pr-popover-activity-time">{relativeTime(n.time)}</span>
    </button>
  );
}

function BellIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className="pr-bell-icon">
      <path
        d="M8 2c-2.2 0-3.5 1.7-3.5 4v2.2c0 .5-.2 1-.6 1.4L3 10.7c-.5.5-.1 1.3.6 1.3h8.8c.7 0 1.1-.8.6-1.3l-.9-1.1c-.4-.4-.6-.9-.6-1.4V6c0-2.3-1.3-4-3.5-4z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path d="M6.3 13a1.8 1.8 0 0 0 3.4 0" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function relativeTime(t: number): string {
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** GitHub-Actions-style filled status dot — a solid colored circle with a
 * check/x/pulse cut out of it in the card's background color, rather than a
 * bare text glyph, to match the check-run icons a GitHub PR page uses. */
function CheckGlyph({ status, size = 12 }: { status: string; size?: number }) {
  const cls = `pr-popover-glyph pr-popover-glyph-${status}`;
  // "running" is a GitHub-style progress donut — a dim track ring with a
  // bright arc riding on top — rather than a flat filled dot, so an in-progress
  // check reads as actively spinning at a glance.
  if (status === "running") {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={cls} style={{ flexShrink: 0 }}>
        <circle cx="8" cy="8" r="6" className="pr-popover-glyph-track" strokeWidth="2.2" fill="none" />
        <path d="M8 2 A6 6 0 0 1 14 8" className="pr-popover-glyph-arc" strokeWidth="2.2" strokeLinecap="round" fill="none" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={cls} style={{ flexShrink: 0 }}>
      {status === "neutral" ? (
        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.4" />
      ) : (
        <circle cx="8" cy="8" r="7" fill="currentColor" />
      )}
      {status === "success" && (
        <path d="M4.7 8.3l2.1 2.1 4.3-4.6" className="pr-popover-glyph-mark" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      )}
      {status === "failure" && (
        <path d="M5.4 5.4l5.2 5.2M10.6 5.4l-5.2 5.2" className="pr-popover-glyph-mark" strokeWidth="1.6" strokeLinecap="round" />
      )}
    </svg>
  );
}

/** Compound roll-up like GitHub's own PR status line — "1 in progress, 3
 * successful", "2 failing, 4 successful" — listing every non-empty state
 * rather than only the one driving the overall color, so the summary matches
 * the check list right beneath it. */
function checksSummary(checks: CheckRun[]): string {
  const count = (k: string) => checks.filter((c) => checkClass(c) === k).length;
  const parts: string[] = [];
  const fail = count("failure");
  const run = count("running");
  const ok = count("success");
  if (fail) parts.push(`${fail} failing`);
  if (run) parts.push(`${run} in progress`);
  if (ok) parts.push(`${ok} successful`);
  return parts.length > 0 ? parts.join(", ") : `${checks.length} pending`;
}

/** "in_progress" → "Running", "action_required" → "Action required", etc. —
 * humanized status label for a single check row, matching GitHub's own
 * check-run wording rather than echoing the raw API enum value. */
function checkLabel(c: CheckRun): string {
  const raw = c.conclusion ?? (c.status === "in_progress" ? "running" : c.status);
  return raw.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}
