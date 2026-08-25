import { useEffect, useState } from "react";
import { graphRecall, type RecallReport } from "../lib/tauri";
import { getGraphUrl } from "../lib/graphSettings";

/**
 * Recall: the one view in the Graph Explorer that is about the graph *working*
 * rather than the graph existing.
 *
 * Everything else here counts what was written. This counts what was read back
 * — each grounding pass with the exact facts it injected into an agent's
 * prompt, and which knowledge is being retrieved at all. That distinction is
 * the whole point: a graph with four hundred nodes that nothing ever recalls is
 * a wiki nobody opens, and until the grounding hook started recording its
 * `fact_ids` there was no way to tell that apart from a graph doing real work.
 *
 * Two things are deliberately shown rather than smoothed over:
 *  - **Passes that surfaced nothing** stay in the list. They are the honest
 *    majority early on, and a UI that hid them would make a silent graph look
 *    busy.
 *  - **Retracted facts** are marked. A fact that was injected on Tuesday and
 *    forgotten on Wednesday is the most useful row on the page — it says an
 *    agent acted on something the team has since disowned.
 */
export default function GraphRecallView({ workspaceId }: { workspaceId: string | null }) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<RecallReport | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setErr(null);
    graphRecall(workspaceId, days, getGraphUrl())
      .then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) setErr(String(e)); });
    return () => { live = false; };
  }, [workspaceId, days]);

  if (err) {
    return (
      <div className="gxr">
        <style>{STYLES}</style>
        <div className="gxr-empty">The graph engine is offline.</div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="gxr">
        <style>{STYLES}</style>
        <div className="gxr-empty">Reading the recall log…</div>
      </div>
    );
  }

  const { passes, top, stats } = data;
  // Both figures come from the window the selector names, not from the 40
  // passes the list happens to hold. Counting the rendered rows answered a
  // different question than the one on the button, and it flattered a busy
  // recent hour on a quiet quarter.
  //
  // Coverage is the share of *recorded* knowledge that anything read back — the
  // number that says whether the graph is memory or a filing cabinet, and the
  // only one here that falls when the graph stops working. It does not say an
  // agent read what was injected, and nothing on this page shows that grounding
  // changed an agent's output: that needs an A/B with grounding off, which has
  // not been run.
  const coverage =
    stats.knowledge_total > 0
      ? Math.round((stats.facts_recalled / stats.knowledge_total) * 100)
      : null;

  return (
    <div className="gxr">
      <style>{STYLES}</style>

      <div className="gxr-head">
        <div className="gxr-lede">
          What the graph actually told your agents — every automatic recall, and
          the facts it put in front of them.
        </div>
        <div className="gxr-windows">
          {[7, 30, 90].map((d) => (
            <button key={d} className={`gxr-win${d === days ? " on" : ""}`} onClick={() => setDays(d)}>
              {d}d
            </button>
          ))}
        </div>
      </div>

      <div className="gxr-strip">
        <Stat
          value={
            stats.ground_passes === 0
              ? "—"
              : `${stats.passes_with_facts}/${stats.ground_passes}`
          }
          label={`grounding passes that found something, last ${days} days`}
        />
        <Stat
          value={coverage === null ? "—" : `${coverage}%`}
          label={`of recorded knowledge read back (${stats.facts_recalled} of ${stats.knowledge_total})`}
          accent={coverage !== null && coverage < 25}
        />
      </div>

      {stats.passes_unrecorded > 0 && (
        <div className="gxr-caveat">
          {stats.passes_unrecorded.toLocaleString()} older{" "}
          {stats.passes_unrecorded === 1 ? "pass is" : "passes are"} excluded from both figures:
          they predate the record of which facts were injected, and guessing either way would be a
          number nobody could check.
        </div>
      )}

      {passes.length === 0 ? (
        <div className="gxr-empty">
          No recall recorded yet. Grounding logs what it surfaced from the moment
          an agent's next prompt runs with the graph enabled — passes recorded
          before that can report their count but not their contents.
        </div>
      ) : (
        <div className="gxr-cols">
          <div className="gxr-col">
            <div className="gxr-col-head">Recent recalls</div>
            <div className="gxr-passes">
              {passes.map((p, i) => (
                <div className={`gxr-pass${p.facts.length === 0 ? " quiet" : ""}`} key={`${p.ts}-${i}`}>
                  <div className="gxr-pass-head">
                    <span className="gxr-pass-when">{relTime(p.ts)}</span>
                    <span className="gxr-pass-who">{p.agent_id ?? "unnamed agent"}</span>
                    <span className="gxr-pass-n">
                      {p.facts.length === 0 ? "nothing surfaced" : `${p.facts.length} fact${p.facts.length === 1 ? "" : "s"}`}
                    </span>
                  </div>
                  {p.facts.map((f) => (
                    <div className="gxr-fact" key={f.id} title={f.body ?? f.label}>
                      <span className="gxr-fact-kind">{f.kind}</span>
                      <span className="gxr-fact-label">{f.label}</span>
                      {f.archived && <span className="gxr-flag">retracted since</span>}
                      {!f.archived && f.superseded && <span className="gxr-flag">superseded since</span>}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>

          <div className="gxr-col">
            <div className="gxr-col-head">Most recalled</div>
            {top.length === 0 ? (
              <div className="gxr-none">Nothing has been recalled in this window.</div>
            ) : (
              <div className="gxr-top">
                {top.slice(0, 12).map((t) => (
                  <div className="gxr-top-row" key={t.id}>
                    <span className="gxr-top-n">{t.recalls}</span>
                    <span className="gxr-top-kind">{t.kind}</span>
                    <span className="gxr-top-label">{t.label}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ value, label, accent }: { value: string; label: string; accent?: boolean }) {
  return (
    <div className={`gxr-stat${accent ? " warn" : ""}`}>
      <span className="gxr-stat-val">{value}</span>
      <span className="gxr-stat-label">{label}</span>
    </div>
  );
}

function relTime(iso: string): string {
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const STYLES = `
.gxr { display: flex; flex-direction: column; gap: 12px; height: 100%; overflow: hidden; padding: 2px 2px 0; }
.gxr-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.gxr-lede { font-size: 12px; color: var(--text-mid); line-height: 1.45; max-width: 60ch; }
.gxr-windows { display: flex; gap: 4px; flex-shrink: 0; }
.gxr-win {
  font-family: var(--font-mono); font-size: 10px; padding: 4px 9px; border-radius: 6px; cursor: pointer;
  background: var(--bg-window); color: var(--text-mid); border: 1px solid var(--border-subtle);
}
.gxr-win.on { color: var(--mint); border-color: color-mix(in srgb, var(--mint) 45%, transparent); }

.gxr-strip { display: flex; gap: 8px; }
.gxr-stat {
  flex: 1; display: flex; align-items: baseline; gap: 8px;
  border: 1px solid var(--border-subtle); border-radius: 7px; padding: 10px 12px; background: var(--bg-window);
}
.gxr-stat.warn { border-color: color-mix(in srgb, var(--yellow) 30%, transparent); }
.gxr-stat-val { font-family: var(--font-mono); font-size: 18px; font-weight: 600; color: var(--text-hi); font-variant-numeric: tabular-nums; }
.gxr-stat.warn .gxr-stat-val { color: var(--yellow); }
.gxr-stat-label { font-size: 11.5px; color: var(--text-mid); line-height: 1.3; }

.gxr-cols { display: grid; grid-template-columns: 1.6fr 1fr; gap: 12px; flex: 1; min-height: 0; }
.gxr-col { display: flex; flex-direction: column; min-height: 0; }
.gxr-col-head {
  font-family: var(--font-mono); font-size: 9px; font-weight: 600; letter-spacing: 1.4px;
  text-transform: uppercase; color: var(--text-low); margin-bottom: 8px;
}
.gxr-passes, .gxr-top { overflow-y: auto; display: flex; flex-direction: column; gap: 8px; padding-right: 4px; }

.gxr-pass { border: 1px solid var(--border-subtle); border-radius: 7px; padding: 9px 11px; background: var(--bg-window); }
.gxr-pass.quiet { opacity: 0.5; }
.gxr-pass-head { display: flex; align-items: baseline; gap: 8px; font-size: 11px; color: var(--text-low); margin-bottom: 4px; }
.gxr-pass-when { color: var(--text-mid); }
.gxr-pass-who { font-family: var(--font-mono); font-size: 10px; }
.gxr-pass-n { margin-left: auto; font-variant-numeric: tabular-nums; }

.gxr-fact { display: flex; align-items: baseline; gap: 7px; padding: 3px 0; font-size: 12px; min-width: 0; }
.gxr-fact-kind {
  font-family: var(--font-mono); font-size: 9px; letter-spacing: 0.5px; text-transform: uppercase;
  color: var(--text-low); flex-shrink: 0;
}
.gxr-fact-label { color: var(--text-hi); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gxr-flag {
  flex-shrink: 0; font-size: 9.5px; padding: 1px 5px; border-radius: 4px;
  color: var(--yellow); border: 1px solid color-mix(in srgb, var(--yellow) 35%, transparent);
}

.gxr-top-row { display: flex; align-items: baseline; gap: 8px; padding: 5px 0; font-size: 12px; border-bottom: 1px solid var(--border-subtle); min-width: 0; }
.gxr-top-n { font-family: var(--font-mono); font-weight: 600; color: var(--mint); font-variant-numeric: tabular-nums; min-width: 2ch; text-align: right; }
.gxr-top-kind { font-family: var(--font-mono); font-size: 9px; text-transform: uppercase; color: var(--text-low); flex-shrink: 0; }
.gxr-top-label { color: var(--text-hi); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.gxr-caveat { font-size: 11px; color: var(--text-low); line-height: 1.4; max-width: 78ch; margin-top: -4px; }

.gxr-empty, .gxr-none { padding: 28px 4px; color: var(--text-mid); font-size: 12.5px; line-height: 1.5; max-width: 62ch; }
.gxr-none { padding: 10px 0; color: var(--text-low); }
`;
