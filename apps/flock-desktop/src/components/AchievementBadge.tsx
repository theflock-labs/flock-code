import { useId } from "react";
import type { GlyphKey } from "../lib/achievements";

// A minted-enamel hexagonal seal. Colour is carried entirely by the fill
// gradient and rim (no glow), matching the approved design. White glyph on the
// enamel when earned; desaturated graphite with a dashed rim when locked.

const GLYPHS: Record<GlyphKey, JSX.Element> = {
  // goose formation — the flagship prompt motif
  formation: (
    <g fill="none" strokeLinecap="round" strokeLinejoin="round" strokeWidth={5}>
      <path d="M42 46 L60 58 L78 46" />
      <path d="M34 62 L60 80 L86 62" />
      <circle cx="60" cy="52" r="3.4" fill="currentColor" stroke="none" />
    </g>
  ),
  squadron: (
    <g fill="currentColor" stroke="none">
      <rect x="42" y="42" width="15" height="15" rx="3" />
      <rect x="63" y="42" width="15" height="15" rx="3" />
      <rect x="42" y="63" width="15" height="15" rx="3" />
      <rect x="63" y="63" width="15" height="15" rx="3" opacity="0.5" />
    </g>
  ),
  compass: (
    <>
      <circle cx="60" cy="60" r="19" fill="none" strokeWidth={4.5} />
      <path d="M60 49 L66 60 L60 71 L54 60 Z" fill="currentColor" stroke="none" />
    </>
  ),
  streak: (
    <g fill="currentColor" stroke="none">
      <rect x="42" y="62" width="9" height="18" rx="2" />
      <rect x="55" y="52" width="9" height="28" rx="2" />
      <rect x="68" y="42" width="9" height="38" rx="2" />
    </g>
  ),
  seal: (
    <path
      d="M60 40 L66 54 L81 55 L69 65 L73 80 L60 71 L47 80 L51 65 L39 55 L54 54 Z"
      fill="none"
      strokeWidth={4.5}
      strokeLinejoin="round"
    />
  ),
  graph: (
    <>
      <path d="M46 46 L74 60 M74 60 L48 76 M46 46 L48 76" fill="none" strokeWidth={4.5} />
      <g fill="currentColor" stroke="none">
        <circle cx="46" cy="46" r="6" />
        <circle cx="74" cy="60" r="6" />
        <circle cx="48" cy="76" r="6" />
      </g>
    </>
  ),
  quill: (
    <>
      <g fill="none" strokeWidth={4.5} strokeLinecap="round">
        <path d="M46 76 L74 46" />
        <path d="M74 46 C64 46 54 52 50 66" />
      </g>
      <circle cx="46" cy="76" r="3.6" fill="currentColor" stroke="none" />
    </>
  ),
  archive: (
    <>
      <rect x="42" y="46" width="36" height="30" rx="4" fill="none" strokeWidth={4.5} />
      <path d="M42 58 H78" strokeWidth={4.5} />
      <path d="M54 52 H66" strokeWidth={4} strokeLinecap="round" />
    </>
  ),
};

// flat-top hexagon, cx=60 cy=60 R=50
const HEX = [0, 60, 120, 180, 240, 300]
  .map((a) => {
    const r = (a * Math.PI) / 180;
    return `${(60 + 50 * Math.cos(r)).toFixed(1)},${(60 + 50 * Math.sin(r)).toFixed(1)}`;
  })
  .join(" ");

interface Props {
  glyph: GlyphKey;
  /** CSS custom-property name for the badge hue, e.g. "--violet". */
  hue: string;
  locked?: boolean;
  /** Top tier reached — render in gold regardless of hue. */
  gold?: boolean;
  size?: number;
}

export default function AchievementBadge({ glyph, hue, locked = false, gold = false, size = 108 }: Props) {
  const uid = useId().replace(/[:]/g, "");
  const h = gold ? "var(--yellow)" : `var(${hue})`;

  const top = locked
    ? "color-mix(in srgb, var(--locked, #444c5b) 40%, var(--locked-field, #10151d))"
    : `color-mix(in srgb, ${h} 78%, #ffffff 22%)`;
  const bottom = locked
    ? "var(--locked-field, #10151d)"
    : `color-mix(in srgb, ${h} 82%, #05070c 30%)`;
  const rim = locked ? "var(--locked, #444c5b)" : `color-mix(in srgb, ${h} 60%, #ffffff 40%)`;
  const seat = `color-mix(in srgb, ${h} 55%, #05070c 45%)`;
  const glyphCol = locked ? "var(--locked, #444c5b)" : "#ffffff";

  return (
    <svg className="ach-medal" viewBox="0 0 120 120" width={size} height={size} role="img" aria-hidden="true">
      <defs>
        <linearGradient id={`${uid}f`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={top} />
          <stop offset="1" stopColor={bottom} />
        </linearGradient>
        <linearGradient id={`${uid}s`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity={locked ? 0.04 : 0.22} />
          <stop offset="0.5" stopColor="#fff" stopOpacity={0} />
        </linearGradient>
      </defs>
      {!locked && <polygon points={HEX} fill="none" stroke={seat} strokeWidth={6} strokeLinejoin="round" />}
      <polygon points={HEX} fill={`url(#${uid}f)`} />
      <polygon points={HEX} fill={`url(#${uid}s)`} />
      <polygon
        points={HEX}
        fill="none"
        stroke={rim}
        strokeWidth={locked ? 2 : 2.5}
        strokeLinejoin="round"
        strokeDasharray={locked ? "4 5" : undefined}
        opacity={locked ? 0.7 : 1}
      />
      <g
        stroke={glyphCol}
        opacity={locked ? 0.5 : 1}
        style={{ color: glyphCol, filter: locked ? undefined : "drop-shadow(0 1px 1px rgba(5,7,12,.35))" }}
      >
        {GLYPHS[glyph]}
      </g>
    </svg>
  );
}
