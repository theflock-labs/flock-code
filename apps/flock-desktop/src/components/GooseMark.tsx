import { useEffect, useState } from "react";

// The goose: flock's bird, drawn as pixels (38 by 23 cells). This bare sprite
// is the in-app mark, beside the wordmark; `flap` beats its wing, two frames,
// sprite-style.
//
// REDRAWN 2026-11-08 from the owner's reference: a goose in flight with its
// wing raised, the body shaded in five blues (a highlight along the back, a
// shadow under the belly), a cream wing and breast, an orange bill and feet
// tucked under, and an eye with a dark pupil. It replaces the 36 by 16 flat
// "firstlight" sprite (sky body, apricot wing), whose palettes and variants
// went with it: no caller asked for any but the default. The wing and the
// body stay far apart in lightness (cream on blue), so the bird keeps its
// shape in greyscale and at small sizes, which is what the old apricot wing
// was there to fix.
//
// The second frame is the same wing lowered onto the back (squashed toward
// it and raked a little back), derived from the first rather than drawn, so
// the two stay one bird. The flock website draws the same sprite.

const PALETTE: Record<string, string> = {
  h: "#a1bfef", // body highlight
  l: "#7da1db", // body light
  g: "#6282bb", // body
  m: "#5171a5", // body mid
  d: "#3b5178", // body shade
  n: "#23324b", // body shadow
  w: "#f7ede4", // wing, belly
  c: "#decdbd", // wing
  s: "#c1b09f", // wing shade
  u: "#aa9a8a", // wing shadow
  q: "#fcd0af", // bill highlight
  p: "#eaae86", // bill, feet light
  o: "#d3885a", // bill, feet
  r: "#a05f3c", // bill shade
  b: "#613925", // bill, feet dark
  k: "#0e1117", // eye
};

const UPSTROKE = [
  "...........w.w........................",
  "...........wwww.......................",
  ".........s.cwwww......................",
  ".........scccwwww.....................",
  ".........wccccwwww....................",
  ".........ssccccwwww........nhhhh......",
  ".........wwcccccwww.......nmgllhh.....",
  ".........sccccccwwww......dmgdkdh.....",
  "..........uusscccwwww.....dmgdkdlg....",
  "h..........sscccccwwww...nndmmgllppqqq",
  "lhh.........uuusssswww..dmnddddmooooo.",
  "mmlhhhhlldddnnnuuuucwwgmmmmnnnnnbbbb..",
  "nmmmllggggmdddddddlllggmmmmmd.........",
  ".dddmmmmlllllllllllllggmmmmln.........",
  "..nnnmmmmmggglllllllgggmwww...........",
  "...nnndmmmmmggggggggggwwww............",
  "....nnnndmmmmmmmmmmmlwwwww............",
  ".....nnnnndmmmmmmmmmwwwww.............",
  ".......nnnndddmmmmmccccc..............",
  ".........nbboumnnuussss...............",
  "..........bor..uuuuu..................",
  ".........brpr.........................",
  "........oopp..........................",
];

const DOWNSTROKE = [
  "......................................",
  "......................................",
  "......................................",
  "......................................",
  "......................................",
  "...........................nhhhh......",
  "...........s.wwwww........nmgllhh.....",
  "...........scccwwwww......dmgdkdh.....",
  "..........ssccccwwww......dmgdkdlg....",
  "h.........sccccccwwww....nndmmgllppqqq",
  "lhh........sscccccwwww..dmnddddmooooo.",
  "mmlhhhhlldddnnnuuuucwwgmmmmnnnnnbbbb..",
  "nmmmllggggmdddddddlllggmmmmmd.........",
  ".dddmmmmlllllllllllllggmmmmln.........",
  "..nnnmmmmmggglllllllgggmwww...........",
  "...nnndmmmmmggggggggggwwww............",
  "....nnnndmmmmmmmmmmmlwwwww............",
  ".....nnnnndmmmmmmmmmwwwww.............",
  ".......nnnndddmmmmmccccc..............",
  ".........nbboumnnuussss...............",
  "..........bor..uuuuu..................",
  ".........brpr.........................",
  "........oopp..........................",
];

const CELL = 10;
const COLS = 38;
const ROWS = 23;

export default function GooseMark({
  width = 54,
  flap = false,
  flapMs = 260,
  flapFor,
}: {
  width?: number;
  /** Two-frame wingbeat. Respect it sparingly — motion is seasoning. */
  flap?: boolean;
  /** Wingbeat period; faster reads as excitement (voice bar uses 150). */
  flapMs?: number;
  /** Stop flapping after this many ms and settle wings-up (the sign-in goose
   *  lands; perpetual motion gets annoying). */
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

  const grid = flap && down ? DOWNSTROKE : UPSTROKE;
  const rects: React.ReactNode[] = [];
  grid.forEach((row, y) => {
    [...row].forEach((c, x) => {
      if (c === ".") return;
      rects.push(<rect key={`${x}-${y}`} x={x * CELL} y={y * CELL} width={CELL} height={CELL} fill={PALETTE[c]} />);
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

/** The sprite as a standalone SVG document, for the README and the website. */
export function gooseSvg(cell = 10): string {
  const rects: string[] = [];
  UPSTROKE.forEach((row, y) =>
    [...row].forEach((c, x) => {
      if (c !== ".") rects.push(`<rect x="${x * cell}" y="${y * cell}" width="${cell}" height="${cell}" fill="${PALETTE[c]}"/>`);
    }),
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${COLS * cell} ${ROWS * cell}" width="${COLS * cell}" height="${ROWS * cell}" shape-rendering="crispEdges">${rects.join("")}</svg>`;
}
