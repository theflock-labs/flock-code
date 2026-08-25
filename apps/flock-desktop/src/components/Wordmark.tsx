// The flock logotype: lowercase always, with the `fl` drawn rather than set
// and its `l` doubling as the wave crest. One component so the mark stays
// identical everywhere it appears (sidebar, splash, sign-in gate, voice HUD).
// Size in px; the stem, its side-bearings and the crest all scale from it.
// Per-surface color is set via CSS on `className` — the f and the resting stem
// are both `currentColor`, so a surface that inverts the mark inverts the wave
// with it.
//
// The f is drawn because it is no longer Outfit's f as shipped: Outfit ends the
// curl at 730 while the l and the k both stop at 720, so in the one word we set
// more than any other the first letter overshot the two beside it by ten units.
// The curl is translated down 10 — every x unchanged, baseline untouched, so
// this is Outfit's drawing exactly, no longer overshooting. Changed 2026-07-29.
//
// Styles are scoped here rather than in global.css: the crest is the mark, and
// splitting its geometry across two files is how a logotype drifts. The class
// names are the mark's own, so nothing in the app's stylesheet can reach in and
// restyle it by accident.

/** Sky, rose, apricot. This order is the mark — never re-order, never split
 *  them up, never let one appear without the others. */
const CREST = ["#62ACFF", "#F2A8C4", "#FDB89B"];

/** One palette, every theme. A deeper cut for Daybreak was tried on
 *  2026-07-29 and rejected on sight — taking the warm end down far enough to
 *  hold contrast on paper turns it to rust, and a rust stem is not this mark.
 *  What it costs: on #FCFBF8 these measure 2.29, 1.82 and 1.62 to one, so the
 *  l reads because the four ink letters around it complete the word, not
 *  because the stem holds its own. On every dark theme here they clear 8:1
 *  and the question does not arise. Same call, same numbers, as brand.css.
 *
 *  MORE CHROMA, AND THE HIGH NOTE IS THE BIRD'S, as of 2026-07-29. The old
 *  set had rose as both the palest hue and the brightest, so the top of the
 *  stem's sweep was the stop carrying least colour and the crest read washed.
 *  The sky gained chroma (#7FB4F0 -> #62ACFF), rose deepened (#F6C6D8 ->
 *  #F2A8C4) so it is no longer the brightest, and the peach was replaced
 *  outright by the goose's own wing, #FDB89B — the crest and the bird now
 *  share a colour rather than merely agreeing about one. On paper this is
 *  also strictly better than what it replaced: 2.09/1.45/1.64 became
 *  2.29/1.82/1.62. Change the wing in GooseMark.tsx PALETTES.firstlight and
 *  the third value here has to follow it. */

/** Seconds for the crest to drift one tile. The old crest crossed in about a
 *  second and then held for eight, which read as a flash rather than as
 *  something living; this is the slowest drift that still reads as motion
 *  head-on, and the only speed that stays calm in the corner of the eye on a
 *  mark that is on screen all day. Same number as the website. */
const DRIFT = 14;

// Below this the crest is frozen rather than dropped: a stem a pixel and a
// half wide cannot carry three drifting hues without turning to mud, but it
// reads perfectly well holding one of them, and switching to ink here would
// put a black l back exactly where the mark is smallest.
const CREST_MIN_PX = 14;

/** THE WHOLE WORD IS DRAWN. It was a drawn `fl` beside live `ock` text until
 *  2026-07-29, and those two can never be made to agree: the drawn half is a
 *  masked box whose edges snap to device pixels, the text half is hinted
 *  glyphs rasterised at their true fractional height, and the f landed a
 *  pixel short of the k at 19, 24 and 48px. Measured across seven sizes, the
 *  mixed build was off by ±1px at four of them; drawn whole it is 0 at all
 *  seven. Box snapping now moves the entire word by a sub-pixel and can never
 *  move its letters against each other.
 *
 *  Two mask images in 1000-unit em coordinates, flipped into SVG's y-down
 *  space by the transform, sharing one viewBox so they register exactly.
 *  Generated from Outfit-var at wght 500 — the axis defaults to 100, so an
 *  uninstantiated read gives Thin outlines and Thin advances. Keep both
 *  identical to brand.css's `--wm-word` / `--wm-stem`. */
const outline = (d: string) =>
  `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' ` +
  `viewBox='0 -720 2095 730'><path transform='scale(1,-1)' d='${d}' ` +
  `fill='%23fff'/></svg>")`;

/** Every letter of the word except the l, as one path: the corrected f
 *  followed by o, c and k at their own advances with the logotype's -18/1000
 *  tracking between them. Outfit at wght 500, 1000 upm. */
const WM_WORD = outline(
  "M127 0V523Q127 575 151.9 619.9Q177.1 665 223.4 692.4Q270 720 333 " +
  "720V617Q285 617 261 589.5Q237 562 237 524V0ZM12 380V480H463V380ZM851 " +
  "-10Q781 -10 724 23.5Q667 57 633.5 114Q600 171 600 241Q600 311 633.5 " +
  "367Q667 423 724 456.5Q781 490 851 490Q922 490 979 457Q1036 424 1069.5 " +
  "367.5Q1103 311 1103 241Q1103 171 1069.5 114Q1036 57 979 23.5Q922 -10 " +
  "851 -10ZM851 96Q892 96 923.5 114.5Q955 133 972.5 166Q990 199 990 " +
  "241Q990 283 972 315Q954 347 923 365.5Q892 384 851 384Q811 384 779.5 " +
  "365.5Q748 347 730.5 315Q713 283 713 241Q713 199 730.5 166Q748 133 " +
  "779.5 114.5Q811 96 851 96ZM1397 -10Q1326 -10 1268.5 23Q1211 56 1178 " +
  "113Q1145 170 1145 240Q1145 311 1178 367.5Q1211 424 1268.5 457Q1326 " +
  "490 1397 490Q1453 490 1501.5 468.5Q1550 447 1584 407L1512 334Q1491 " +
  "359 1461.5 371.5Q1432 384 1397 384Q1356 384 1324.5 365.5Q1293 347 " +
  "1275.5 315Q1258 283 1258 240Q1258 198 1275.5 165.5Q1293 133 1324.5 " +
  "114.5Q1356 96 1397 96Q1432 96 1461.5 108.5Q1491 121 1512 146L1584 " +
  "73Q1550 33 1501.5 11.5Q1453 -10 1397 -10ZM1950 0 1747 245 1949 " +
  "480H2080L1848 216L1853 279L2090 0ZM1645 0V720H1755V0Z",
);

/** The l, alone, so the crest can be painted through it. */
const WM_STEM = outline("M417 0V720H527V0Z");

/** The word's total advance, in ems. 2095 units at 1000 upm. */
const WM_WIDTH = 2.095;

const STYLES = `
.flock-wordmark {
  display: inline-block;
  font-family: var(--font-sans);
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  /* text-transform is reset because the mark sits inside uppercase chrome in
     several places and is lowercase in all of them. The tracking is the
     brand's own value, not a reset — it has to beat whatever letter-spacing
     that chrome inherits down. */
  text-transform: none;
  letter-spacing: -0.018em;
}
/* TWO MASKED BOXES, ONE DRAWING. ::before is f, o, c and k in currentColor;
   ::after is the l alone, carrying the crest, painting over it — which is
   also the fl ligature, since the f's crossbar runs to x=463 under a stem
   that starts at 417 and the crest wins in the overlap.

   Both boxes are the word's full advance and share one viewBox, so every
   letter is placed by the same resample. The box edges still snap to device
   pixels, but that now moves the whole word together by a sub-pixel instead
   of moving a drawn f against a hinted k.

   THE BOX REACHES BELOW THE BASELINE, AND IT HAS TO. Outfit's o and c are
   round, so they overshoot to -10 the way round letters always do. A viewBox
   that started at the baseline sliced both of them flat across the bottom —
   the mask clips, it does not overflow. So the drawing spans -10 to 720, the
   box is 0.73em rather than 0.72, and vertical-align pulls it down the extra
   0.01em so the baseline still lands where the box bottom used to.

   Anything added to this drawing must be measured the same way: take the
   glyph's real yMin, do not assume it is zero. Geometry and construction are
   brand.css's \`.wordmark-word\` — keep the two in step. */
.flock-word {
  display: inline-block;
  vertical-align: -0.01em;
  position: relative;
  width: ${WM_WIDTH}em;
  height: 0.73em;
  --wm-word: ${WM_WORD};
  --wm-stem: ${WM_STEM};
  --crest-1: ${CREST[0]};
  --crest-2: ${CREST[1]};
  --crest-3: ${CREST[2]};
}
.flock-word::before,
.flock-word::after {
  content: "";
  position: absolute;
  inset: 0;
  -webkit-mask-size: 100% 100%;
  mask-size: 100% 100%;
  -webkit-mask-repeat: no-repeat;
  mask-repeat: no-repeat;
}
.flock-word::before {
  background: currentColor;
  -webkit-mask-image: var(--wm-word);
  mask-image: var(--wm-word);
}
/* ONE BOX, FOUR COLOUR STOPS. This was four stacked spans until 2026-07-29,
   and that is what drew black horizontal lines through the l in the app, and
   white ones on iOS Safari.

   A glyph's stem has two horizontal edges. Four boxes have eight, six of them
   interior, and each carried its own mask resampled to its own fractional
   height — so every interior boundary was two antialiased edges meeting.
   Whether they overlapped invisibly or left a line was decided by where they
   landed on the device pixel grid, which belongs to the renderer, not to us.

   Colour stops inside a single paint cannot do that: there is no geometry
   between band three and band four to antialias. A gradient stop shifts
   colour; it can never let the surface behind through, which is the failure
   that strips the l and leaves the word reading as a profanity. */
/* ONE GRADIENT, TILED, ALWAYS MOVING. The crest was four flat bands changing
   colour in place; then a single sweep passing over an ink stem, which moved
   but arrived and left, so the mark spent most of every cycle as a dead black
   bar. It is now a repeating gradient the stem never leaves: sky, rose, peach
   and back to sky, two stem-heights per tile, drifting upward forever.

   THE TILE IS A LOOP. First stop and last stop are the same hue,
   background-repeat is on, and the animation translates by exactly one tile,
   so the frame after the last is identical to the first and there is no seam.
   That is also why the timing is linear: any easing would slow the drift at
   the loop point and the wrap would tick, once every cycle, forever.

   No ink anywhere in the gradient, so legibility rides on the hues — which is
   what --crest-1/2/3 above are for, and why Daybreak gets its own set.

   Only background-position animates, so this composites without a paint per
   frame. Geometry and timing are brand.css's, to the em. */
.flock-word::after {
  background-image: linear-gradient(
    to bottom,
    var(--crest-1) 0%,
    var(--crest-2) 33.33%,
    var(--crest-3) 66.67%,
    var(--crest-1) 100%
  );
  background-size: 100% 200%;
  background-repeat: repeat;
  -webkit-mask-image: var(--wm-stem);
  mask-image: var(--wm-stem);
  animation: flock-crest ${DRIFT}s linear infinite;
}
/* THE CREST RISES: sky sits above rose above peach in the tile and the
   translation is negative, so the image slides up and a fixed point on the
   stem meets sky first, then rose, then peach, then sky again.

   1.44em is one tile — 200% of the 0.72em box. In em rather than percent
   because percentage background-position resolves against the positioning
   area minus the image, which for a tiled image taller than its box is not
   the tile height, and the loop would drift. */
@keyframes flock-crest {
  from { background-position: 0 0; }
  to   { background-position: 0 -1.46em; }
}
/* Reduced motion: the drift stops, the colour does not. Every resting
   position shows crest hues now, so there is no frame to choose. */
@media (prefers-reduced-motion: reduce) {
  .flock-word::after { animation: none; }
}
/* There was an .on-crest variant here for one release, which flattened the
   stem to ink so the mark could sit on a pastel plate in the rail. It is gone,
   and so is the plate: a surface that forces the logotype to drop the crest is
   a surface the logotype should not be on. See .brand in global.css. */
/* Below CREST_MIN_PX the crest is frozen, not dropped. Three drifting hues
   inside a stem a pixel and a half wide is mud, but one of them held still is
   a legible letter, and switching to ink here would put a black l back
   exactly where the mark is smallest. Parked a third of a tile in, which puts
   the stem across the sky-to-rose blend rather than on the tile's own seam. */
.flock-word.is-static::after {
  animation: none;
  background-position: 0 -0.487em;
}
`;

interface WordmarkProps {
  /** Size in px. It is the mark's em, not a font-size — no text is set. Under
   *  14 the crest stops drifting and holds one hue. */
  size?: number;
  /** Extra class for per-surface color/layout overrides. */
  className?: string;
}

export default function Wordmark({ size = 16, className = "" }: WordmarkProps) {
  const cls = `flock-wordmark${className ? ` ${className}` : ""}`;
  // The crest holds still at small sizes; the drawing is the same at every one.
  const word = `flock-word${size < CREST_MIN_PX ? " is-static" : ""}`;

  return (
    // role="img" and the label are not optional: the element has no text at
    // all now, so without them the mark announces as nothing.
    <span className={cls} style={{ fontSize: size }} role="img" aria-label="flock">
      <style>{STYLES}</style>
      {/* Every letter is paint. Nothing here is text, which is the whole point
          — a drawn letter and a hinted one cannot be made to sit on the same
          baseline at every size, and this mark spent a version finding out. */}
      <span className={word} />
    </span>
  );
}
