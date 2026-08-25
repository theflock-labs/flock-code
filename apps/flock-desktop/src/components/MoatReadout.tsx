import { useEffect, useState } from "react";
import { graphInsights, type InsightsSummary } from "../lib/tauri";
import { getGraphEnabled, getGraphUrl } from "../lib/graphSettings";

// The ambient graph readout: one number in the sidebar, visible while you work.
//
// It used to be `sum(grounding_hits)` under the words "rediscoveries avoided".
// That was a lifetime count of bullet lines the grounding hook printed into a
// prompt — not read, not used, not acted on — and being cumulative it could
// only rise. It rose right through the period when the write half of the graph
// was dead on every relaunch, which is the proof that it measured nothing, and
// it was quotable at us by anyone who checked.
//
// What is here now is **coverage**: the share of recorded knowledge that
// anything read back in the last 30 days. It falls when recall stops, and it
// falls when the graph grows faster than it is read — which is the actual
// failure this feature has. Second line is the share of grounding passes that
// surfaced nothing, because a coverage figure with no denominator beside it is
// the same trick in a new costume.
//
// Neither number shows that grounding changed an agent's *output*. They are
// retrieval measurements. Proving an effect on the answer needs an A/B against
// the same prompts with grounding off; we have not run one, and nothing here
// may imply otherwise.

const WINDOW_DAYS = 30;

export default function MoatReadout() {
  const enabled = getGraphEnabled();
  const [data, setData] = useState<InsightsSummary | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    graphInsights(WINDOW_DAYS, getGraphUrl())
      .then((d) => { if (live) setData(d); })
      // A sleeping/unreachable graph just leaves the strip quiet — never an error.
      .catch(() => {});
    return () => { live = false; };
  }, [enabled]);

  // Only meaningful once there's a graph to read.
  if (!enabled) return null;

  // Stay quiet until the first read rather than flashing zeros.
  if (!data) return null;

  const { ground_passes, silent_passes, facts_recalled, knowledge_total } = data.recall;

  // Nothing recorded, or no pass that can say what it surfaced: there is no
  // honest figure to print, so print none. A confident 0% would read as "the
  // graph is failing" when the truth is "nobody has asked it anything yet".
  if (knowledge_total === 0 || ground_passes === 0) {
    return (
      <div
        className="moat-readout"
        title={
          knowledge_total === 0
            ? "No knowledge recorded yet, so there is nothing recall could read back."
            : "No grounding pass in the last 30 days recorded what it surfaced, so coverage cannot be computed."
        }
      >
        <span className="moat-readout-label">Graph</span>
        <span className="moat-readout-hint">not enough data yet</span>
      </div>
    );
  }

  const coverage = Math.round((facts_recalled / knowledge_total) * 100);
  const silentShare = Math.round((silent_passes / ground_passes) * 100);

  return (
    <div
      className="moat-readout"
      title={`Coverage: ${facts_recalled} of ${knowledge_total} recorded facts were put in front of an agent at least once in the last ${WINDOW_DAYS} days. ${silent_passes} of ${ground_passes} grounding passes surfaced nothing. This measures what the graph retrieved — not whether an agent read it, and not whether it changed the answer. That would need an A/B with grounding off, which we have not run.`}
    >
      <span className="moat-readout-num">{coverage}%</span>
      <span className="moat-readout-unit">of the graph read back ({WINDOW_DAYS}d)</span>
      <span className="moat-readout-aside">{silentShare}% passes empty</span>
    </div>
  );
}
