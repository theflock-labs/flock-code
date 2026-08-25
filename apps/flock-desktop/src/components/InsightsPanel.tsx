import { useEffect, useState } from "react";
import { graphInsights, type InsightsSummary } from "../lib/tauri";
import { getGraphUrl } from "../lib/graphSettings";

/** What the graph is being read for, computed entirely from the telemetry
 * tables. Self-contained (its own scoped styles) so it can be mounted anywhere
 * without touching global.css.
 *
 * Mount it behind any trigger:
 *   {showInsights && <InsightsPanel onClose={() => setShowInsights(false)} />}
 *
 * Every figure here is windowed and every one of them can fall. That is the
 * whole reason the panel was rewritten: its headline used to be
 * `sum(grounding_hits)` labelled "facts reused instead of re-derived" — a
 * lifetime count of bullet lines the hook printed, which kept climbing through
 * the entire period in which the write half of the graph was dead on every
 * relaunch. A number that cannot go down when the feature stops working is not
 * a measurement of the feature.
 *
 * Precisely what is claimed, and what is not:
 *  - Coverage counts recorded facts that were injected into at least one
 *    prompt. It does not claim an agent read them.
 *  - Facts injected is volume. The same three facts across a hundred prompts
 *    is 300, which is exactly how the old number reached its impressive
 *    figures.
 *  - Empty passes are shown because they are the denominator, and the honest
 *    majority on a young graph.
 *  - **None of this shows that grounding changed an agent's output.** That
 *    requires an A/B against the same prompts with grounding off. We have not
 *    run one, and the panel says so on screen rather than only here.
 *
 * Cost-per-outcome was removed rather than relabelled: it divided whole-account
 * model spend by merged PRs, so it moved when Claude was used outside flock and
 * when a typo fix was merged, and was not attributable to the graph in either
 * direction. Attributed spend lives in Settings → Usage, where it is computed
 * per session id.
 */
export default function InsightsPanel({ onClose }: { onClose: () => void }) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<InsightsSummary | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setErr(null);
    // Same graph the sidebar strip reads. Called bare this fell back to the
    // local engine, so a team on a hosted graph opened "Team Insights" onto an
    // empty local database and read it as the feature not working.
    graphInsights(days, getGraphUrl())
      .then((d) => live && (setData(d), setLoading(false)))
      .catch((e) => live && (setErr(String(e)), setLoading(false)));
    return () => {
      live = false;
    };
  }, [days]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const r = data?.recall;
  // Coverage is only defined against something recorded, and the empty share
  // only against a pass that can say what it surfaced. Where the denominator
  // is zero the answer is "—", never a confident 0%.
  const coverage =
    r && r.knowledge_total > 0 ? Math.round((r.facts_recalled / r.knowledge_total) * 100) : null;
  const emptyShare =
    r && r.ground_passes > 0 ? Math.round((r.silent_passes / r.ground_passes) * 100) : null;

  // Three ways there is no honest figure to print, and all three end in the
  // same place — the words "not enough data yet" — rather than in a confident
  // 0% that a reader would take for "the graph is failing":
  //   - no pass in the window can say what it surfaced, so coverage's numerator
  //     has no evidence behind it (and `passes_unrecorded` may mean passes did
  //     fire and did find things nobody can now name);
  //   - nothing is recorded, so coverage has no denominator;
  //   - the pipeline is live but has done nothing at all.
  // Telling "never ran" apart from "ran and was not recorded" is exactly the
  // distinction whose absence hid the graph being dead for a whole release.
  const isEmpty =
    !!r &&
    (r.ground_passes === 0 ||
      r.knowledge_total === 0 ||
      (r.facts_injected === 0 && data.reads === 0 && data.writes === 0));

  return (
    <div className="flock-ins-overlay" onClick={onClose}>
      <style>{STYLES}</style>
      <div className="flock-ins-panel" onClick={(e) => e.stopPropagation()}>
        <header className="flock-ins-head">
          <div>
            <div className="flock-ins-eyebrow">flock · Graph Insights</div>
            <h2 className="flock-ins-title">What the graph is being read for</h2>
          </div>
          <div className="flock-ins-windows">
            {[7, 30, 90].map((d) => (
              <button
                key={d}
                className={`flock-ins-win${d === days ? " on" : ""}`}
                onClick={() => setDays(d)}
              >
                {d}d
              </button>
            ))}
          </div>
        </header>

        {loading ? (
          <div className="flock-ins-state">Reading the graph…</div>
        ) : err ? (
          <div className="flock-ins-state flock-ins-err">
            Couldn't read insights. Is the graph engine running?
            <div className="flock-ins-errmsg">{err}</div>
          </div>
        ) : data && r && isEmpty ? (
          <div className="flock-ins-empty">
            <div className="flock-ins-empty-title">Not enough data yet</div>
            <p className="flock-ins-empty-body">
              {r.ground_passes === 0
                ? `No grounding pass in the last ${days} days recorded which facts it surfaced${
                    r.passes_unrecorded > 0
                      ? `. ${r.passes_unrecorded.toLocaleString()} older ${r.passes_unrecorded === 1 ? "pass" : "passes"} ran before that was recorded, and cannot say what they found`
                      : ""
                  }.`
                : r.knowledge_total === 0
                  ? `${r.ground_passes.toLocaleString()} ${r.ground_passes === 1 ? "prompt was" : "prompts were"} checked against the graph in the last ${days} days, but nothing is recorded in it, so there is nothing recall could read back.`
                  : `Grounding is running: ${r.ground_passes.toLocaleString()} ${r.ground_passes === 1 ? "prompt was" : "prompts were"} checked against the graph in the last ${days} days, and none of them found anything to inject.`}
            </p>
            <p className="flock-ins-empty-body">
              These numbers start moving once your agents record decisions and
              attempts with the graph tools, and the grounding hook finds them
              relevant to a prompt.
            </p>
          </div>
        ) : data && r ? (
          <>
            <div className="flock-ins-hero">
              <div className="flock-ins-hero-num">{coverage === null ? "—" : `${coverage}%`}</div>
              <div className="flock-ins-hero-label">
                of recorded knowledge was read back
                <span className="flock-ins-hero-sub">
                  {r.facts_recalled.toLocaleString()} of {r.knowledge_total.toLocaleString()} live
                  facts were injected into at least one prompt in the last {days} days. This falls
                  when recall stops, and when the graph grows faster than it is read.
                </span>
              </div>
            </div>

            <div className="flock-ins-grid">
              <Metric
                value={emptyShare === null ? "—" : `${emptyShare}%`}
                label={`of grounding passes surfaced nothing (${r.silent_passes.toLocaleString()} of ${r.ground_passes.toLocaleString()})`}
                accent={emptyShare !== null && emptyShare >= 50}
              />
              <Metric
                value={r.facts_injected.toLocaleString()}
                label={`facts injected into prompts, last ${days} days — volume, and the same fact counts each time`}
              />
              <Metric
                value={r.knowledge_total.toLocaleString()}
                label="live facts recorded in the graph"
              />
            </div>

            <div className="flock-ins-foot">
              <Stat n={r.ground_passes} l="grounding passes" />
              <Stat n={data.reads} l="graph reads" />
              <Stat n={data.writes} l="graph writes" />
              {r.passes_unrecorded > 0 && (
                <Stat n={r.passes_unrecorded} l="older passes that cannot say what they surfaced" />
              )}
              {/* On screen, not only in the source. Everything above measures
                  retrieval; a reader is entitled to know nobody has shown the
                  answers got better. */}
              <span className="flock-ins-note">
                These count what the graph retrieved and put in front of an
                agent. None of them shows that it changed the agent's output —
                that needs an A/B against the same prompts with grounding off,
                which has not been run.
              </span>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

function Metric({ value, label, accent }: { value: string; label: string; accent?: boolean }) {
  return (
    <div className={`flock-ins-metric${accent ? " accent" : ""}`}>
      <div className="flock-ins-metric-val">{value}</div>
      <div className="flock-ins-metric-label">{label}</div>
    </div>
  );
}

function Stat({ n, l }: { n: number; l: string }) {
  return (
    <span className="flock-ins-stat">
      <b>{n.toLocaleString()}</b> {l}
    </span>
  );
}

// A `formatMoney` helper lived here for cost-per-outcome. It went with the
// metric: this panel now shows no money at all, because no dollar figure the
// graph telemetry can produce is attributable to the graph. Settings → Usage
// owns spend, attributed per session id.

const STYLES = `
.flock-ins-overlay {
  position: fixed; inset: 0; z-index: 200;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
  display: flex; align-items: center; justify-content: center;
  padding: 24px;
}
.flock-ins-panel {
  width: 100%; max-width: 600px;
  background: var(--bg-card);
  /* Same chrome as .modal in global.css — full hairline, 12px radius, the
     shared --lift-3 elevation. Kept in step by hand because this panel ships
     its own <style>; if the modal's chrome moves, move it here too. */
  border: 1px solid var(--border-hover);
  border-radius: 12px;
  box-shadow: var(--lift-3);
  padding: 22px 24px 20px;
  color: var(--text-hi);
  font-family: var(--font-sans);
  zoom: var(--ui-scale, 1);
}
.flock-ins-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 20px; }
.flock-ins-eyebrow {
  font-family: var(--font-mono);
  font-size: 9px; font-weight: 600; letter-spacing: 1.5px; text-transform: uppercase;
  color: var(--text-low); margin-bottom: 8px;
}
/* A written sentence, so it reads in sans; the mono eyebrow above it carries
   the terminal voice. */
.flock-ins-title {
  font-family: var(--font-sans);
  font-weight: 600; font-size: 18px; letter-spacing: -0.3px; margin: 0;
  color: var(--text-hi); line-height: 1.2;
}
.flock-ins-windows { display: flex; gap: 4px; flex-shrink: 0; }
.flock-ins-win {
  font-family: var(--font-mono); font-size: 10px;
  padding: 5px 10px; border-radius: 6px; cursor: pointer;
  background: var(--bg-window); color: var(--text-mid);
  border: 1px solid var(--border-subtle);
  transition: border-color 0.12s ease-out, color 0.12s ease-out;
}
.flock-ins-win:hover { border-color: var(--text-low); color: var(--text-hi); }
.flock-ins-win.on { color: var(--mint); border-color: color-mix(in srgb, var(--mint) 45%, transparent); background: color-mix(in srgb, var(--mint) 8%, transparent); }

.flock-ins-hero {
  display: flex; align-items: center; gap: 18px;
  padding: 16px 18px; margin-bottom: 10px;
  border: 1px solid var(--border-subtle);
  border-radius: 7px;
  background: var(--bg-window);
}
.flock-ins-hero-num {
  font-family: var(--font-mono);
  font-size: 44px; font-weight: 600; line-height: 1;
  color: var(--mint); font-variant-numeric: tabular-nums;
}
.flock-ins-hero-label { font-size: 14px; color: var(--text-hi); font-weight: 600; line-height: 1.4; }
.flock-ins-hero-sub { display: block; font-size: 12px; color: var(--text-mid); font-weight: 400; margin-top: 4px; }

.flock-ins-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 16px; }
.flock-ins-metric {
  border: 1px solid var(--border-subtle);
  border-radius: 7px; padding: 14px 15px; background: var(--bg-window);
}
.flock-ins-metric.accent { border-color: color-mix(in srgb, var(--yellow) 30%, transparent); }
.flock-ins-metric-val {
  font-family: var(--font-mono);
  font-size: 24px; font-weight: 600; color: var(--text-hi);
  font-variant-numeric: tabular-nums; margin-bottom: 6px;
}
.flock-ins-metric.accent .flock-ins-metric-val { color: var(--yellow); }
.flock-ins-metric-label { font-size: 11.5px; color: var(--text-mid); line-height: 1.35; }

.flock-ins-foot { display: flex; align-items: center; flex-wrap: wrap; gap: 14px; padding-top: 14px; border-top: 1px solid var(--border-subtle); }
.flock-ins-stat { font-size: 12px; color: var(--text-mid); font-variant-numeric: tabular-nums; }
.flock-ins-stat b { color: var(--text-hi); font-weight: 600; }
.flock-ins-note { flex: 1; min-width: 200px; font-size: 11.5px; color: var(--text-low); line-height: 1.4; }

.flock-ins-state { padding: 44px 0; text-align: center; color: var(--text-mid); font-size: 13px; }
.flock-ins-err { color: var(--orange, #ff7030); }
.flock-ins-errmsg { margin-top: 8px; font-family: var(--font-mono); font-size: 11px; color: var(--text-low); }

.flock-ins-empty {
  padding: 20px 18px; border: 1px solid var(--border-subtle);
  border-radius: 7px; background: var(--bg-window);
}
.flock-ins-empty-title {
  font-family: var(--font-sans); font-size: 14px; font-weight: 600;
  color: var(--text-hi); margin-bottom: 10px;
}
.flock-ins-empty-body {
  font-size: 12.5px; color: var(--text-mid); line-height: 1.5; margin: 0 0 8px;
}
.flock-ins-empty-body:last-child { margin-bottom: 0; }
`;
