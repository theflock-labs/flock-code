import type { ClaudeUsage, UsageBar, UsageSpend } from "../lib/tauri";
import { RefreshIcon } from "./statusIcons";

/** Presentational breakdown of Claude usage limits — session, weekly (all
 * models + any per-model window like Fable), and pay-as-you-go credits. Pure:
 * given a fetched `ClaudeUsage` it renders; the fetching lives in
 * `useClaudeUsage`. Shared by the Settings section and the titlebar popover so
 * both read identically. */
export default function ClaudeUsagePanel({
  usage,
  now,
  loading,
  error,
  onRefresh,
  title = "Claude usage limits",
  sessionHeading = "Plan usage limits",
  footnote,
}: {
  usage: ClaudeUsage | null;
  now: number;
  loading: boolean;
  error: string;
  onRefresh: () => void;
  title?: string;
  sessionHeading?: string;
  footnote?: string;
}) {
  const session = usage?.bars.filter((b) => b.group === "session") ?? [];
  const weekly = usage?.bars.filter((b) => b.group === "weekly") ?? [];
  const other = usage?.bars.filter((b) => b.group !== "session" && b.group !== "weekly") ?? [];

  return (
    <>
      <div className="settings-section-header usage-header">
        <span>{title}</span>
        {usage?.plan && <span className="usage-plan">{usage.plan}</span>}
        <div className="spacer" />
        <button
          className="usage-refresh"
          onClick={onRefresh}
          disabled={loading}
          title="Refresh usage"
        >
          {loading ? "…" : <RefreshIcon size={12} />}
        </button>
      </div>

      {error && !usage && <div className="usage-error">{error}</div>}
      {!error && !usage && loading && <div className="settings-hint">Loading usage…</div>}

      {usage && (
        <>
          {session.length > 0 && (
            <div className="usage-group">
              <div className="usage-group-title">{sessionHeading}</div>
              {session.map((b) => (
                <UsageMeter key={b.kind + b.label} bar={b} now={now} />
              ))}
            </div>
          )}

          {(weekly.length > 0 || other.length > 0) && (
            <div className="usage-group">
              <div className="usage-group-title">Weekly limits</div>
              {[...weekly, ...other].map((b) => (
                <UsageMeter key={b.kind + b.label} bar={b} now={now} />
              ))}
            </div>
          )}

          {usage.spend && <SpendMeter spend={usage.spend} />}

          <div className="usage-footer">
            <span>Updated {relativeAgo(now - usage.fetched_at_ms)}</span>
            {error && <span className="usage-footer-err">· {error}</span>}
            {footnote && <div className="settings-hint" style={{ marginTop: 8 }}>{footnote}</div>}
          </div>
        </>
      )}
    </>
  );
}

function UsageMeter({ bar, now }: { bar: UsageBar; now: number }) {
  const pct = clampPct(bar.percent);
  return (
    <div className={`usage-meter${bar.is_active ? " active" : ""}`}>
      <div className="usage-meter-head">
        <span className="usage-meter-label">{bar.label}</span>
        <span className="usage-meter-pct">{Math.round(bar.percent)}% used</span>
      </div>
      <div className="usage-bar">
        <div className={`usage-bar-fill sev-${bar.severity}`} style={{ width: `${pct}%` }} />
      </div>
      {bar.resets_at && (
        <div className="usage-meter-reset">Resets {resetsIn(bar.resets_at, now)}</div>
      )}
    </div>
  );
}

function SpendMeter({ spend }: { spend: UsageSpend }) {
  const used = money(spend.used_minor, spend.exponent, spend.currency);
  const limit = money(spend.limit_minor, spend.exponent, spend.currency);
  const pct = clampPct(spend.percent);
  return (
    <div className="usage-group">
      <div className="usage-group-title">Usage credits</div>
      {!spend.enabled && (
        <div className="settings-hint" style={{ marginTop: 0 }}>
          Off — credits cover you when you hit a plan limit.
        </div>
      )}
      <div className="usage-meter">
        <div className="usage-meter-head">
          <span className="usage-meter-label">
            {used} spent <span className="usage-meter-of">of {limit}</span>
          </span>
          <span className="usage-meter-pct">{Math.round(spend.percent)}% used</span>
        </div>
        <div className="usage-bar">
          <div
            className={`usage-bar-fill ${spend.percent >= 100 ? "sev-critical" : "sev-normal"}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    </div>
  );
}

// ─── formatting ──────────────────────────────────────────────────────────────

function clampPct(p: number): number {
  return Math.max(0, Math.min(100, p));
}

/** Minor units (cents) → "€2.69". Falls back to a currency code prefix for
 * anything without a well-known symbol. */
function money(minor: number, exponent: number, currency: string): string {
  const value = minor / Math.pow(10, exponent);
  const symbols: Record<string, string> = { EUR: "€", USD: "$", GBP: "£" };
  const sym = symbols[currency];
  const amount = value.toFixed(exponent);
  return sym ? `${sym}${amount}` : `${amount} ${currency}`;
}

/** "Resets in 3 hr 13 min" / "Resets in 23 min" / "Resets now". */
function resetsIn(iso: string, now: number): string {
  const ms = new Date(iso).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `in ${mins} min`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hrs < 24) return rem ? `in ${hrs} hr ${rem} min` : `in ${hrs} hr`;
  const days = Math.floor(hrs / 24);
  const remHrs = hrs % 24;
  return remHrs ? `in ${days}d ${remHrs} hr` : `in ${days}d`;
}

function relativeAgo(ms: number): string {
  const secs = Math.max(0, Math.round(ms / 1000));
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  return `${hrs} hr ago`;
}
