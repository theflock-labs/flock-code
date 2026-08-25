import { useEffect, useState } from "react";

// The goose — flock's bird, the HD sprite (36x16: feathered wingtips, a real
// neck, an eye that reads, shaded wing and bill), straight from
// flock-website/brand/generate-goose.py. This bare sprite IS the in-app
// mark; the night-disc version exists only in the macOS app icon. `flap`
// animates the two-frame wingbeat, sprite-style.
//
// One bird, every theme: sky body, apricot wing. It used to shift palette with
// the theme, which meant the app had three different geese depending on where
// you looked. A mark that changes colour is not one mark.
//
// THE WING SWEEPS BACK, as of 2026-07-29. It used to sit five cells forward of
// its root, toward the bill, which is the pose a goose holds to kill speed on
// approach — tail pointing one way and wing the other, so the mark read as
// static. Same wing, same row widths cell for cell, mirrored and then sheared
// so both edges rake; the bounding box did not move. The downstroke still
// leans forward on purpose: that is the power stroke, so the two frames now
// row rather than both pointing the same way. Reasoning in full lives in
// flock-website/scripts/generate-goose.py, which is the sprite's source.
//
// THE NECK IS SHORT, same day. The head dropped a row and moved a column in
// toward the shoulder, and the eye slid two columns forward, one cell in from
// the front of the skull. A shoulder now carries the head into the back rather
// than leaving it floating over a notch, and the belly runs into the tail
// instead of cutting away under it. Everything above the waterline is one mass
// at 16px, which is the size that decides the mark.

type Variant = "mint" | "dawn" | "ink" | "firstlight";

const PALETTES: Record<Variant, Record<string, string>> = {
  // Nightfall: the classic goose — mint body, blue wing, gold beak.
  mint: { M: "#4fffb0", T: "#2fc98c", B: "#4daffe", D: "#2f89d8", Y: "#e8ff3a", Z: "#c3d631" },
  // Daybreak: the dawn goose — sky body, rose wing, peach beak.
  dawn: { M: "#7fb4f0", T: "#4a7bc0", B: "#f6c6d8", D: "#d89ab8", Y: "#ffb59e", Z: "#e0906e" },
  // High-contrast option: navy ink body, action-blue wing, peach beak.
  ink:  { M: "#0b1b33", T: "#060f1e", B: "#1e5eff", D: "#1849c9", Y: "#ff8a63", Z: "#e0704f" },
  // "first light": sky body, apricot wing, gold bill. The bird, everywhere.
  //
  // Blue + pink until 2026-07-28. The wing is drawn on top of the body, so the
  // two are each other's background, and they sat 1.09:1 apart: the wing
  // disappeared in greyscale, at favicon size, and under protanopia and
  // deuteranopia. Now 2.17:1, and 2.18 desaturated. The body keeps the
  // signature's sky hue and drops in lightness; the wing and bill take the warm
  // end of dawn. Chroma falls from 1.73x the sky/rose/peach signature to 1.27x.
  // Rose is unchanged in the wordmark crest, where it belongs.
  //
  // These six values must stay identical to PALETTES["firstlight"] in
  // flock-website/scripts/generate-goose.py.
  firstlight: { M: "#4f89c9", T: "#3a6aa7", B: "#fdb89b", D: "#e1957a", Y: "#e8a962", Z: "#cb8747" },
};

/** What you get when a caller doesn't ask for a palette, whatever the theme.
 *  The other three stay reachable by name: `ink` is the app icon's bird, and
 *  `mint` / `dawn` are the old per-theme pair, kept because they are brand
 *  assets rather than dead code. */
const DEFAULT_VARIANT: Variant = "firstlight";

const UPSTROKE = [
  "..........B.B.B.....................",
  "..........BBBBBB....................",
  "..........BBBBBBB...................",
  "..........BBBBBBBB........MMMM......",
  "..........DBBBBBBBB......MMMMMM.....",
  "..........DDBBBBBBBB.....MMMMKM.....",
  "...........DDBBBBBBBB...MMMMMMMYYYY.",
  "..MMM.......DDBBBBBBB..MMMMMMMYYYZ..",
  "..MMMMMMMMMMMMMDBBBBBMMMMMMMMM......",
  "..TTMMMMMMMMMMMMMMMMMMMMMMMM........",
  "...TTMMMMMMMMMMMMMMMMMMMMM..........",
  "....TTTMMMMMMMMMMMMMMMMMM...........",
  "......TTTTMMMMMMMMMMMMM.............",
  "........TTTTTMMMMMMMM...............",
  "....................................",
  "....................................",
];

// Same body as the upstroke with the down-wing painted over it — the pair is
// one bird with two wings, not two birds, so this frame is derived rather than
// drawn. Change the body above and this has to be rebuilt from it.
const DOWNSTROKE = [
  "....................................",
  "....................................",
  "....................................",
  "..........................MMMM......",
  ".........................MMMMMM.....",
  ".........................MMMMKM.....",
  "........................MMMMMMMYYYY.",
  "..MMM..................MMMMMMMYYYZ..",
  "..MMMMMMMMMMMMMMMMMMMMMMMMMMMM......",
  "..TTMMMMMMMMBBBBBBBBMMMMMMMM........",
  "...TTMMMMMMMBBBBBBBBBMMMMM..........",
  "....TTTMMMMMBBBBBBBBBMMMM...........",
  "......TTTTMMMDBBBBBBBMM.............",
  "........TTTTTMMDDBBBB...............",
  ".................DDBB...............",
  "...................D................",
];

const VOID = "var(--bg-window, #06080c)";
const CELL = 10;
const COLS = 36;
const ROWS = 16;

export default function GooseMark({
  width = 54,
  variant,
  flap = false,
  flapMs = 260,
  flapFor,
}: {
  width?: number;
  /** Explicit palette; defaults to the effective theme's bird. */
  variant?: Variant;
  /** Two-frame wingbeat. Respect it sparingly — motion is seasoning. */
  flap?: boolean;
  /** Wingbeat period; faster reads as excitement (voice bar uses 150). */
  flapMs?: number;
  /** Stop flapping after this many ms and settle wings-up (the Settings
   * goose lands; perpetual motion in a dialog gets annoying). */
  flapFor?: number;
}) {
  const [down, setDown] = useState(false);
  useEffect(() => {
    if (!flap) return;
    const t = setInterval(() => setDown((d) => !d), flapMs);
    let stop: ReturnType<typeof setTimeout> | undefined;
    if (flapFor) {
      stop = setTimeout(() => { clearInterval(t); setDown(false); }, flapFor);
    }
    return () => { clearInterval(t); if (stop) clearTimeout(stop); };
  }, [flap, flapMs, flapFor]);

  const pal = PALETTES[variant ?? DEFAULT_VARIANT];
  const grid = flap && down ? DOWNSTROKE : UPSTROKE;

  const rects: React.ReactNode[] = [];
  grid.forEach((row, y) => {
    [...row].forEach((c, x) => {
      if (c === ".") return;
      rects.push(
        <rect
          key={`${x}-${y}`}
          x={x * CELL}
          y={y * CELL}
          width={CELL}
          height={CELL}
          fill={c === "K" ? VOID : pal[c]}
        />,
      );
    });
  });
  return (
    <svg
      width={width}
      height={(width * ROWS) / COLS}
      viewBox={`0 0 ${COLS * CELL} ${ROWS * CELL}`}
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      {rects}
    </svg>
  );
}
