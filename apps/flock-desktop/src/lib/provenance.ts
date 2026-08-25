// Date-range arithmetic for the provenance export, kept out of the component
// because every bug this code can have is an off-by-one that silently changes
// what an audit export contains.
//
// The record itself lives in SQLite and is written by the backend; see
// src-tauri/src/provenance.rs. Here we only turn what the two <input
// type="date"> fields say into the epoch-second window the command wants, and
// back again for display.

/** `YYYY-MM-DD` in the *user's* timezone.
 *
 * Not `toISOString().slice(0, 10)`, which is the UTC day: west of Greenwich
 * that names yesterday for most of the evening, so "today" in the picker would
 * open on a range that excludes the session the user just ran. */
export function toDayString(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Epoch seconds for local midnight at the start of `day` (`YYYY-MM-DD`).
 * NaN for anything that isn't a day, which the caller treats as "no range". */
export function dayStart(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return NaN;
  return Math.floor(new Date(y, m - 1, d, 0, 0, 0, 0).getTime() / 1000);
}

/** The half-open window `[from, to)` in epoch seconds for two picked days,
 * **inclusive of the last one**.
 *
 * The end is local midnight of the day *after* `toDay`. Taking the end day's
 * own midnight instead is the classic export bug: the report says it covers up
 * to Friday and contains nothing from Friday, which is precisely the day
 * anyone checking on us would look at first. */
export function dayRangeToEpoch(fromDay: string, toDay: string): { from: number; to: number } {
  const from = dayStart(fromDay);
  const end = dayStart(toDay);
  const to = Number.isNaN(end) ? NaN : end + 86_400;
  return { from, to };
}

/** True when both ends parsed and the window is non-empty. A backwards range
 * is refused rather than silently swapped: an export that quietly covered a
 * different period than the one asked for is worse than one that didn't run. */
export function isValidRange(fromDay: string, toDay: string): boolean {
  const { from, to } = dayRangeToEpoch(fromDay, toDay);
  return Number.isFinite(from) && Number.isFinite(to) && from < to;
}

/** The window the panel opens on: the last 30 days, ending today. */
export function defaultRange(now: Date = new Date()): { fromDay: string; toDay: string } {
  const start = new Date(now);
  start.setDate(start.getDate() - 29);
  return { fromDay: toDayString(start), toDay: toDayString(now) };
}

/** `flock-provenance-2026-07-11_2026-08-09.csv` — the range is in the name
 * because these files get filed away and asked about months later. */
export function suggestFilename(fromDay: string, toDay: string, format: "csv" | "json"): string {
  return `flock-provenance-${fromDay}_${toDay}.${format}`;
}

/** `1h 02m` / `4m 03s` / `12s`, matching the CSV's own duration column so the
 * screen and the file never disagree. Empty for a session still running. */
export function durationLabel(startedAt: number, endedAt: number | null): string {
  if (endedAt === null) return "";
  const secs = Math.max(0, endedAt - startedAt);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (h > 0) return `${h}h ${pad(m)}m`;
  if (m > 0) return `${m}m ${pad(s)}s`;
  return `${s}s`;
}

/** Micros → dollars. Stored as an integer so a summed column can't drift; the
 * value itself is an estimate priced from token counts. */
export function costUsd(micros: number): number {
  return micros / 1_000_000;
}

/** What the pane was: a jailed agent, an isolated worktree, or the shared
 * checkout. This is the column a security reviewer reads first. */
export function isolationLabel(s: { secure: boolean; worktree: boolean }): string {
  if (s.secure) return "container";
  if (s.worktree) return "worktree";
  return "checkout";
}
