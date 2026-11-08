import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ClaudeUsagePanel from "../components/ClaudeUsagePanel";
import { claudeUsage, codexUsage, type UsageBar } from "../lib/tauri";
import { useAgentUsage } from "../lib/useClaudeUsage";

type Tone = "ok" | "warn" | "bad";

function toneOf(bar: UsageBar): Tone {
  if (bar.severity === "critical" || bar.percent >= 90) return "bad";
  if (bar.severity === "warning" || bar.severity === "warn" || bar.percent >= 75) return "warn";
  return "ok";
}

/** "3h 10m", "25m", "now". */
function resetsIn(iso: string | null, now: number): string | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - now;
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return "now";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return mins % 60 ? `${hrs}h ${mins % 60}m` : `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

/** How much of your plans you have used, at the foot of the sidebar: one quiet
 *  line per agent you are signed in to, for the window you are in now. The bar
 *  keeps the ink until the limit is near, and only then says when it resets.
 *  Click it for the whole picture: the week, per model, credits.
 *
 *  v1 drew this as a game-style XP bar in the title bar; the figures and the
 *  polling (the backend caches for three minutes) are the same. An agent with
 *  no figure (not signed in, endpoint down) or at 0% shows nothing rather than
 *  a dead bar, and with none left the whole block is gone. */
export default function UsageMeters() {
  const claude = useAgentUsage(claudeUsage);
  const codex = useAgentUsage(codexUsage);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);

  const plans = [
    { id: "claude", label: "Claude", title: "Claude usage limits", state: claude },
    { id: "codex", label: "Codex", title: "Codex usage limits", state: codex },
  ]
    .map((p) => ({ ...p, session: p.state.usage?.bars.find((b) => b.group === "session") }))
    // A plan you are not using right now (0%) is not worth a line.
    .filter((p): p is typeof p & { session: UsageBar } => !!p.session && Math.round(p.session.percent) > 0);

  if (plans.length === 0) return null;

  const tip = plans
    .map((p) => {
      const reset = resetsIn(p.session.resets_at, p.state.now);
      return `${p.label}: ${Math.round(p.session.percent)}% of this window used${reset ? `, resets in ${reset}` : ""}`;
    })
    .join("\n");

  return (
    <>
      <button
        ref={button}
        type="button"
        className="v2-usage"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Plan usage"
        title={tip}
        onClick={() => setOpen((o) => !o)}
      >
        {plans.map((p) => {
          const pct = Math.max(0, Math.min(100, p.session.percent));
          const tone = toneOf(p.session);
          const reset = tone === "ok" ? null : resetsIn(p.session.resets_at, p.state.now);
          return (
            <span key={p.id} className="v2-usage-row" data-tone={tone}>
              <span className="v2-usage-label">{p.label}</span>
              <span className="v2-usage-track" aria-hidden="true">
                <span className="v2-usage-fill" style={{ width: `${pct}%` }} />
              </span>
              <span className="v2-usage-pct">
                {Math.round(pct)}%{reset && <span className="v2-usage-reset"> · {reset}</span>}
              </span>
            </span>
          );
        })}
      </button>
      {open && button.current && (
        <UsagePopover anchor={button.current} onClose={() => setOpen(false)}>
          {plans.map((p) => (
            <ClaudeUsagePanel
              key={p.id}
              usage={p.state.usage}
              now={p.state.now}
              loading={p.state.loading}
              error={p.state.error}
              onRefresh={p.state.refresh}
              title={p.title}
            />
          ))}
        </UsagePopover>
      )}
    </>
  );
}

/** The breakdown, floating above the meters it came from. */
function UsagePopover({ anchor, onClose, children }: { anchor: HTMLElement; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; bottom: number } | null>(null);

  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    setAt({ left: Math.max(8, r.left), bottom: Math.max(8, window.innerHeight - r.top + 6) });
  }, [anchor]);

  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", onClose);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div ref={ref} className="v2-usage-pop" role="dialog" aria-label="Plan usage" style={at ?? { visibility: "hidden" }}>
      {children}
    </div>,
    document.body,
  );
}
