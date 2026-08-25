import { useRef } from "react";

// The "agent is working" signature: a comet running the length of a strip of
// discrete cells, out and back, cycling the DawnMark crest (sky → rose →
// apricot) as it goes. Styles in global.css (.wb).
//
// The crest is anchored to a shared clock: --wb-t is this strip's mount time
// folded into the wave period, fed to a negative animation-delay in CSS. That
// cancels each strip's own mount offset, so two agents that start working
// seconds apart still show the comet at the same phase — the heads line up
// cell-for-cell instead of drifting independently.
//
// WHY EACH CELL CARRIES TWO CHILDREN.
// The comet has to travel left→right and then right→left. A single animation
// per cell cannot do that: the outbound leg wants cell i to fire at `i * step`
// and the return leg wants it to fire at `half + (last - i) * step`, and those
// two offsets differ by an amount that depends on i — so no one
// `animation-delay` produces both, and keyframe percentages are fixed and
// cannot be parameterised by the cell index either. Two children, one per leg,
// each with its own delay, is the smallest thing that actually works. They
// compose through opacity rather than fighting over `background`, which is
// what two animations on a single element would do.
const WB_PERIOD_MS = 1900;

export default function WorkingBlocks({
  cells = 5,
  className,
}: {
  cells?: number;
  className?: string;
}) {
  // Read once per mount so re-renders don't jump the phase.
  const syncRef = useRef<number>();
  if (syncRef.current === undefined) {
    syncRef.current = performance.now() % WB_PERIOD_MS;
  }
  const last = cells - 1;
  return (
    <span
      className={`wb${className ? ` ${className}` : ""}`}
      aria-hidden="true"
      style={{ ["--wb-t" as never]: `${syncRef.current}ms` }}
    >
      {Array.from({ length: cells }, (_, i) => (
        // --i places this cell on the outbound leg, --j on the return. The
        // return is simply the strip read backwards, so the head that leaves
        // the right edge is the one that comes back from it.
        <i key={i} style={{ ["--i" as never]: i, ["--j" as never]: last - i }}>
          <u className="wb-out" />
          <u className="wb-back" />
        </i>
      ))}
    </span>
  );
}
