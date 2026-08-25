// Shared number formatting. One source of truth — StatsModal, UsageChart and
// the opencode usage surfaces previously each carried their own copy with
// subtly different rounding.

/** 1234567 → "1,234,567" (locale-aware). */
export function formatCount(n: number): string {
  return n.toLocaleString();
}

/** 1_882_438 → "1.9M", 263_455 → "263.5K" (locale-aware compact). */
export function formatCompact(n: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

/** Adaptive dollars for stat displays: cents below $100, whole dollars above. */
export function formatUsd(n: number): string {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: n >= 100 ? 0 : 2 })}`;
}

/** Exact cents ("$12.30") for line items where truncation would read as a
 *  different amount. */
export function formatUsdExact(usd: number): string {
  return `$${usd.toFixed(2)}`;
}
