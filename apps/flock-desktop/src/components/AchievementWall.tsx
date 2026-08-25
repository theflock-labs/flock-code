import { useState, type CSSProperties } from "react";
import AchievementBadge from "./AchievementBadge";
import type { ResolvedAchievement } from "../lib/achievements";

// A single row of small seals (earned first) with a "+N" toggle that expands to
// the full wrapped grid. Name / rank / progress surface in a caption strip on
// hover or keyboard focus, so the row stays compact inside the stats modal.

const COLLAPSED = 6;

function statusLine(a: ResolvedAchievement): string {
  if (a.earned) {
    const tier = a.def.tiers.length > 1 ? ` · rank ${a.rank} of ${a.def.tiers.length}` : "";
    return a.rankName + tier;
  }
  return `${a.have.toLocaleString()} / ${a.need.toLocaleString()}${a.def.unit ? ` ${a.def.unit}` : ""}`;
}

interface Props {
  items: ResolvedAchievement[];
}

export default function AchievementWall({ items }: Props) {
  const earned = items.filter((a) => a.earned).length;
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const active = items.find((a) => a.def.id === hoverId) ?? null;

  // Earned first, so the collapsed row leads with what's unlocked.
  const ordered = [...items].sort((a, b) => Number(b.earned) - Number(a.earned));
  const shown = expanded ? ordered : ordered.slice(0, COLLAPSED);
  const hidden = ordered.length - shown.length;

  return (
    <div className="stats-group">
      <div className="stats-group-head ach-head">
        <span>Achievements</span>
        <span className="ach-count">{earned} of {items.length} earned</span>
      </div>

      <div className={`ach-grid${expanded ? " expanded" : ""}`} onMouseLeave={() => setHoverId(null)}>
        {shown.map((a) => {
          const gold = a.maxed;
          return (
            <button
              key={a.def.id}
              type="button"
              className={`ach-seal ${a.earned ? "earned" : "locked"}${gold ? " gold" : ""}`}
              style={{ "--h": gold ? "var(--yellow)" : `var(${a.def.hue})` } as CSSProperties}
              onMouseEnter={() => setHoverId(a.def.id)}
              onFocus={() => setHoverId(a.def.id)}
              onBlur={() => setHoverId(null)}
              aria-label={`${a.def.name} — ${statusLine(a)}`}
            >
              <AchievementBadge glyph={a.def.glyph} hue={a.def.hue} locked={!a.earned} gold={gold} size={34} />
            </button>
          );
        })}

        {hidden > 0 && !expanded && (
          <button type="button" className="ach-more" onClick={() => setExpanded(true)} aria-label={`Show ${hidden} more achievements`}>
            +{hidden}
          </button>
        )}
        {expanded && (
          <button type="button" className="ach-more" onClick={() => setExpanded(false)} aria-label="Show fewer achievements">
            Less
          </button>
        )}
      </div>

      <div className="ach-detail" aria-live="polite">
        {active ? (
          <>
            <span className="ach-detail-name">{active.def.name}</span>
            <span className="ach-detail-status">{statusLine(active)}</span>
            <span className="ach-detail-desc">{active.def.desc}</span>
          </>
        ) : (
          <span className="ach-detail-hint">Hover a seal for details</span>
        )}
      </div>
    </div>
  );
}
