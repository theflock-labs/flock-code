import { useCallback, useEffect, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import {
  provenanceExport, provenanceReport,
  type ProvenanceReport, type ProvenanceSession,
} from "../lib/tauri";
import {
  costUsd, dayRangeToEpoch, defaultRange, durationLabel, isolationLabel, isValidRange,
  suggestFilename,
} from "../lib/provenance";
import { formatCompact, formatCount, formatUsdExact } from "../lib/format";
import { RefreshIcon } from "./statusIcons";

// The provenance panel: pick a window, see what ran in it, export the record.
//
// Export is the point. The table underneath is there so nobody has to open a
// spreadsheet to find out whether the window they picked holds anything — it is
// capped at ROWS_SHOWN and deliberately not paginated, sortable or filterable.
// The file is the artifact; this is the confirmation.

/** How many sessions the table draws. The export is not limited to these. */
const ROWS_SHOWN = 200;

function fmtWhen(secs: number): string {
  // Local time, unlike the export's UTC: on screen the reader is the person who
  // ran the agents and "14:03" means their afternoon. A file that travels needs
  // the opposite, and says so with a Z.
  return new Date(secs * 1000).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

export default function ProvenanceSection() {
  const initial = defaultRange();
  const [fromDay, setFromDay] = useState(initial.fromDay);
  const [toDay, setToDay] = useState(initial.toDay);
  const [report, setReport] = useState<ProvenanceReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"csv" | "json" | null>(null);
  const [wrote, setWrote] = useState<string | null>(null);

  const valid = isValidRange(fromDay, toDay);

  const load = useCallback(async () => {
    if (!isValidRange(fromDay, toDay)) {
      setReport(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const { from, to } = dayRangeToEpoch(fromDay, toDay);
    try {
      setReport(await provenanceReport(from, to, ROWS_SHOWN));
    } catch (e) {
      setReport(null);
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [fromDay, toDay]);

  useEffect(() => { load(); }, [load]);

  const doExport = useCallback(async (format: "csv" | "json") => {
    if (!isValidRange(fromDay, toDay)) return;
    setBusy(format);
    setError(null);
    setWrote(null);
    try {
      // The native save dialog picks the path; the backend then refuses
      // anything that isn't an absolute path with the right extension in a
      // folder that already exists. A cancelled dialog returns null and is not
      // an error — it is the most common outcome of clicking Export.
      const dest = await save({
        defaultPath: suggestFilename(fromDay, toDay, format),
        filters: [{ name: format.toUpperCase(), extensions: [format] }],
      });
      if (!dest) return;
      const { from, to } = dayRangeToEpoch(fromDay, toDay);
      const res = await provenanceExport(from, to, format, dest);
      // Mirrors the backend's MAX_ROWS. An export that hit the cap dropped
      // the window's oldest sessions, and for a compliance artifact a silent
      // omission is the one failure this panel exists to avoid — say so
      // instead of reporting a clean write.
      const EXPORT_ROW_CAP = 50_000;
      setWrote(
        res.sessions >= EXPORT_ROW_CAP
          ? `Wrote ${formatCount(res.sessions)} sessions to ${res.path} — the export's row cap; the window's oldest sessions were left out. Narrow the range and export again.`
          : `Wrote ${formatCount(res.sessions)} session${res.sessions === 1 ? "" : "s"} to ${res.path}`,
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }, [fromDay, toDay]);

  const sessions = report?.sessions ?? [];
  const totals = report?.totals;

  return (
    <div className="settings-section">
      <div className="settings-section-header">Provenance</div>
      <p className="settings-hint" style={{ marginTop: 0 }}>
        Every agent flock has run on this machine, with who ran it, where, for how long,
        and what it cost. Export it as CSV for a spreadsheet or JSON for a system that
        wants the full status timeline.
      </p>

      <div className="prov-range">
        <label className="prov-field">
          <span>From</span>
          <input
            type="date" className="modal-input" value={fromDay} max={toDay}
            onChange={(e) => setFromDay(e.target.value)}
          />
        </label>
        <label className="prov-field">
          <span>To</span>
          <input
            type="date" className="modal-input" value={toDay} min={fromDay}
            onChange={(e) => setToDay(e.target.value)}
          />
        </label>
        <div className="spacer" />
        <button className="usage-refresh" onClick={load} disabled={loading} title="Refresh">
          {loading ? "…" : <RefreshIcon size={12} />}
        </button>
      </div>

      {!valid && (
        <div className="settings-error">
          Pick an end date on or after the start date.
        </div>
      )}

      {valid && (
        <div className="usage-group">
          <div className="prov-totals">
            <Tile label="Sessions" value={formatCount(totals?.sessions ?? 0)} />
            <Tile label="Prompts" value={formatCount(totals?.prompts ?? 0)} />
            <Tile label="Tokens" value={formatCompact(totals?.tokens ?? 0)} />
            <Tile label="Est. cost" value={formatUsdExact(costUsd(totals?.cost_usd_micros ?? 0))} />
          </div>

          {report?.truncated && (
            <div className="settings-hint">
              More than {ROWS_SHOWN} sessions in this window — the list below is cut, the export is not.
            </div>
          )}

          {sessions.length === 0 ? (
            <div className="settings-hint">
              {loading ? "Loading…" : "No agent sessions in this window."}
            </div>
          ) : (
            <div className="prov-table-wrap">
              <table className="prov-table">
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th>Workspace</th>
                    <th>Branch</th>
                    <th>Ran in</th>
                    <th>Started</th>
                    <th>For</th>
                    <th className="num">Prompts</th>
                    <th className="num">Tokens</th>
                    <th className="num">Est. cost</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((s) => <Row key={s.id} s={s} />)}
                </tbody>
              </table>
            </div>
          )}

          <div className="prov-actions">
            <button
              className="btn-mint-solid settings-btn"
              onClick={() => doExport("csv")}
              disabled={busy !== null}
            >
              {busy === "csv" ? "…" : "Export CSV"}
            </button>
            <button
              className="btn-ghost settings-btn"
              onClick={() => doExport("json")}
              disabled={busy !== null}
            >
              {busy === "json" ? "…" : "Export JSON"}
            </button>
          </div>
        </div>
      )}

      {wrote && <div className="settings-hint prov-wrote">{wrote}</div>}
      {error && <div className="settings-error">{error}</div>}

      {/* Said here as well as inside every export, because the person deciding
          whether to turn this on is reading this screen and not the file. */}
      <p className="settings-hint" style={{ marginTop: 12 }}>
        <strong>What is recorded:</strong> agent name, the flock ID that ran it, workspace,
        repository, branch, working directory, whether it was isolated in its own worktree or
        in the container jail, start and end, every status change, how many prompts were
        submitted, tokens and estimated cost.
        <br />
        <strong>What is not:</strong> prompt text, agent output, file contents and diffs are
        never stored — "prompts" is a count and nothing more. Records cover only agents this
        copy of flock started; another flock on the same machine keeps its own.
        Dollars are an estimate priced from token counts, not a bill.
      </p>
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="prov-tile">
      <div className="prov-tile-value">{value}</div>
      <div className="prov-tile-label">{label}</div>
    </div>
  );
}

function Row({ s }: { s: ProvenanceSession }) {
  const tokens = s.tokens_input + s.tokens_output + s.tokens_cache_read + s.tokens_cache_write;
  const running = s.ended_at === null;
  return (
    <tr>
      <td>
        <span className="prov-agent">{s.agent_name || "—"}</span>
        <span className="prov-sub">{s.agent_kind}</span>
      </td>
      <td>
        {/* Snapshotted at spawn: the workspace may since have been deleted, and
            the row still has to say which one it was. */}
        <span>{s.workspace_name || "—"}</span>
        {s.repo_name && <span className="prov-sub">{s.repo_name}</span>}
      </td>
      <td className="prov-mono">{s.branch || "—"}</td>
      <td><span className={`prov-iso ${isolationLabel(s)}`}>{isolationLabel(s)}</span></td>
      <td>{fmtWhen(s.started_at)}</td>
      <td>{running ? <span className="prov-live">running</span> : durationLabel(s.started_at, s.ended_at)}</td>
      <td className="num">{formatCount(s.prompts)}</td>
      {/* An opencode/codex pane has no transcript flock can read, so its token
          columns are blank rather than a zero that reads as "free". */}
      <td className="num">{tokens > 0 ? formatCompact(tokens) : "—"}</td>
      <td className="num">{tokens > 0 ? formatUsdExact(costUsd(s.cost_usd_micros)) : "—"}</td>
    </tr>
  );
}
