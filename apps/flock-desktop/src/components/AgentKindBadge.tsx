import { agentColor, agentLabel } from "../lib/agents";
import AgentLogo from "./AgentLogo";

/** Official agent logo + label for an agent kind, used everywhere one is shown
 * (pane topbars, sidebar rows, popout windows, agent pickers) so the same
 * kind reads identically — same mark, same color, same label text — no matter
 * which corner of the UI it's in. Pass `iconOnly` to drop the label (the
 * sidebar rows do this to reclaim horizontal space); the logo keeps its
 * accessible name via `title`/aria-label. `size` tunes the mark to its
 * surroundings — the pane topbar sets 12 so it sits level with 11px text
 * instead of towering over it. */
export default function AgentKindBadge({
  kind,
  className,
  iconOnly,
  size,
}: {
  kind: string;
  className?: string;
  iconOnly?: boolean;
  size?: number;
}) {
  const label = agentLabel(kind);
  return (
    <span
      className={`agent-kind-badge${iconOnly ? " icon-only" : ""}${className ? ` ${className}` : ""}`}
      style={{ ["--kind-color" as never]: agentColor(kind) }}
      title={iconOnly ? label : undefined}
      aria-label={iconOnly ? label : undefined}
    >
      <AgentLogo kind={kind} size={size} className="agent-kind-badge-logo" />
      {!iconOnly && label}
    </span>
  );
}
