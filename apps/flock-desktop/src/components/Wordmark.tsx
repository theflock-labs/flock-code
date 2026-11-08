// The flock logotype: the word "flock", lowercase, drawn in pixels on the
// goose's own grid, so the bird and the word read as one mark. One component
// so the mark stays identical everywhere it appears (sidebar, sign-in, the
// voice bar).
//
// REDRAWN 2026-11-08, with the goose. The word was Outfit 500 outlines until
// then: a clean geometric sans, which sat beside the new pixel bird like two
// logos. Now every letter is cells with the bird's two-cell weight, 12 cells
// tall (8 for the x-height), set one cell apart.
//
// THE l IS THE CREST, and it must always read as an l: without it the word
// turns into a profanity, so the stem is never faint and never ink-less. Its
// four segments take the bird's colours, the bill's peach and orange at the
// top and the body's blues below, and drift upward slowly (14 s for the whole
// stem, gently, and not at all for people who ask for reduced motion). The
// colours live in v2.css per theme (--wm-1 … --wm-4, top to bottom).
//
// `size` keeps its old meaning, the logotype's font size in px, so callers
// keep their numbers: the word is 0.73em tall as the drawn one was, and the
// cell is rounded to half pixels so it lands on whole device pixels on a
// Retina display and the letters stay crisp.

/** '#' ink (currentColor); '1'…'4' the crest, top to bottom. */
const WORD = [
  "..####.11................##.....",
  ".#####.11................##.....",
  ".##....11................##.....",
  ".##....22................##.....",
  "#####..22...###.....####.##...##",
  "#####..22..#####...#####.##..##.",
  ".##....33.##...##.##.....##.##..",
  ".##....33.##...##.##.....####...",
  ".##....33.##...##.##.....####...",
  ".##....44.##...##.##.....##.##..",
  ".##....44..#####...#####.##..##.",
  ".##....44...###.....####.##...##",
];

const COLS = WORD[0].length;
const ROWS = WORD.length;

const STYLES = `
.flock-wordmark {
  display: inline-block;
  vertical-align: middle;
  flex: none;
  --wm-1: #eaae86;
  --wm-2: #fcd0af;
  --wm-3: #a1bfef;
  --wm-4: #6282bb;
}
.flock-wordmark .wm-c {
  animation: flock-crest 14s ease-in-out infinite;
}
.flock-wordmark .wm-c1 { fill: var(--wm-1); animation-delay: 0s; }
.flock-wordmark .wm-c2 { fill: var(--wm-2); animation-delay: -3.5s; }
.flock-wordmark .wm-c3 { fill: var(--wm-3); animation-delay: -7s; }
.flock-wordmark .wm-c4 { fill: var(--wm-4); animation-delay: -10.5s; }
/* Segment n starts (n - 1) quarters into the cycle, so the stem rests at
   colours 1-4 top to bottom and each colour climbs one segment a quarter. */
@keyframes flock-crest {
  0%, 100% { fill: var(--wm-1); }
  25% { fill: var(--wm-2); }
  50% { fill: var(--wm-3); }
  75% { fill: var(--wm-4); }
}
@media (prefers-reduced-motion: reduce) {
  .flock-wordmark .wm-c { animation: none; }
}
`;

let injected = false;
function injectStyles() {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const el = document.createElement("style");
  el.dataset.flockWordmark = "";
  el.textContent = STYLES;
  document.head.appendChild(el);
}

export default function Wordmark({ size = 27, className }: { size?: number; className?: string }) {
  injectStyles();
  const cell = Math.max(0.5, Math.round(((size * 0.73) / ROWS) * 2) / 2);
  const ink: React.ReactNode[] = [];
  const crest: React.ReactNode[] = [];
  WORD.forEach((row, y) =>
    [...row].forEach((c, x) => {
      if (c === ".") return;
      if (c === "#") ink.push(<rect key={`i${x}-${y}`} x={x} y={y} width={1} height={1} />);
      else crest.push(<rect key={`c${x}-${y}`} className={`wm-c wm-c${c}`} x={x} y={y} width={1} height={1} />);
    }),
  );
  return (
    <svg
      className={`flock-wordmark flock-word${className ? ` ${className}` : ""}`}
      width={COLS * cell}
      height={ROWS * cell}
      viewBox={`0 0 ${COLS} ${ROWS}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label="flock"
    >
      <g fill="currentColor">{ink}</g>
      {crest}
    </svg>
  );
}
