import { useEffect, useRef, useState } from "react";
import { onActivateKey } from "../lib/a11y";
import { useAgentUsage } from "../lib/useClaudeUsage";
import type { ClaudeUsage } from "../lib/tauri";
import ClaudeUsagePanel from "./ClaudeUsagePanel";

/** A compact, always-visible XP bar in the titlebar — World-of-Warcraft style,
 * tracking one agent's *current session* usage (how much of its rolling window
 * you've burned). Clicking pops out the full breakdown (session / weekly /
 * credits) right there, without opening Settings. Hovering shows the exact
 * %/reset.
 *
 * Generic over the agent: pass the fetcher + labels + which side it's pinned
 * to. Claude sits on the right, Codex on the left. Data + polling live in
 * `useAgentUsage` (180s cache). Renders nothing until there's a real session
 * figure (not signed in / endpoint down → no dead bar). */
export default function AgentUsageBar({
  fetcher,
  label,
  panelTitle,
  sessionHeading,
  footnote,
  side,
  agent,
}: {
  fetcher: (force: boolean) => Promise<ClaudeUsage>;
  /** Short titlebar label, e.g. "Claude usage". */
  label: string;
  /** Popover heading, e.g. "Claude usage limits". */
  panelTitle: string;
  /** Overrides the session-group title. Grok's bar is context, not a plan. */
  sessionHeading?: string;
  footnote?: string;
  side: "left" | "right";
  /** Accent hook, e.g. "claude" | "codex" — drives the normal-state fill color. */
  agent: string;
}) {
  const { usage, now, loading, error, refresh } = useAgentUsage(fetcher);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const session = usage?.bars.find((b) => b.group === "session");
  if (!session) return null;

  const pct = Math.max(0, Math.min(100, session.percent));
  const reset = session.resets_at ? resetsIn(session.resets_at, now) : null;
  const tip = `${label} · ${Math.round(session.percent)}% used${reset ? ` · resets ${reset}` : ""}`;

  return (
    <div className={`xp-mount ${side}`} ref={ref}>
      <div
        className={`xp-bar agent-${agent} sev-${session.severity} clickable`}
        title={tip}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onActivateKey(() => setOpen((o) => !o))}
      >
        <span className="xp-bar-label">{label}</span>
        <div className="xp-bar-track">
          <div className="xp-bar-fill" style={{ width: `${pct}%` }} />
          <div className="xp-bar-ticks" />
        </div>
        <span className="xp-bar-pct">{Math.round(session.percent)}%</span>
      </div>

      {open && (
        <div className={`usage-popover ${side}`} role="dialog">
          <ClaudeUsagePanel
            usage={usage}
            now={now}
            loading={loading}
            error={error}
            onRefresh={refresh}
            title={panelTitle}
            sessionHeading={sessionHeading}
            footnote={footnote}
          />
        </div>
      )}
    </div>
  );
}

/** "in 3 hr 13 min" / "in 23 min" / "now". */
function resetsIn(iso: string, now: number): string {
  const ms = new Date(iso).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `in ${mins} min`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hrs < 24) return rem ? `in ${hrs} hr ${rem} min` : `in ${hrs} hr`;
  const days = Math.floor(hrs / 24);
  return `in ${days}d`;
}
