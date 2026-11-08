// The harness's flock ID backend for the stats pages: the real module, with
// stats and a month of usage made up. Swapped in for ../lib/flockId (from
// components) by vite.harness.config.ts; never part of the app.
export * from "../lib/flockId.ts";
import type { UsageDailyPoint, UserStats } from "../lib/flockId.ts";

export async function getUserStats(profileId: string): Promise<UserStats> {
  const friend = profileId !== "harness";
  return {
    prompts_sent: friend ? 412 : 1240,
    agents_launched: friend ? 96 : 312,
    workspaces_created: friend ? 14 : 41,
    tokens_total: friend ? 48_200_000 : 182_400_000,
    cost_usd: friend ? 318.4 : 1240.5,
    member_since: "2026-07-12T09:00:00Z",
  };
}

export async function getUsageSeries(_profileId: string, days = 30): Promise<UsageDailyPoint[]> {
  const out: UsageDailyPoint[] = [];
  let tokens = 120_000_000;
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86_400_000);
    tokens += 1_200_000 + Math.round(Math.abs(Math.sin(i * 1.7)) * 3_600_000);
    out.push({ day: d.toISOString().slice(0, 10), tokens_total: tokens, cost_usd: tokens / 147_000 });
  }
  return out;
}
