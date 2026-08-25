import { useCallback, useEffect, useState } from "react";
import { claudeUsage, codexUsage, type ClaudeUsage } from "./tauri";

type UsageFetcher = (force: boolean) => Promise<ClaudeUsage>;

/** Shared usage fetcher for both the titlebar bars and the Settings section,
 * parameterized by which agent's endpoint to hit. The backend caches results
 * for 180s, so polling at that cadence (the default) never hits the network
 * more than it should; multiple mounts just share the cache. `now` ticks every
 * 30s so "resets in …" / "updated …ago" stay honest without refetching. */
export function useAgentUsage(fetcher: UsageFetcher, pollMs = 180_000) {
  const [usage, setUsage] = useState<ClaudeUsage | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(
    async (force: boolean) => {
      setLoading(true);
      setError("");
      try {
        setUsage(await fetcher(force));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [fetcher],
  );

  useEffect(() => {
    load(false);
    const poll = setInterval(() => load(false), pollMs);
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [load, pollMs]);

  return { usage, now, loading, error, refresh: () => load(true) };
}

/** Claude-specific convenience wrapper (Settings section). */
export const useClaudeUsage = (pollMs?: number) => useAgentUsage(claudeUsage, pollMs);
/** Codex-specific convenience wrapper. */
export const useCodexUsage = (pollMs?: number) => useAgentUsage(codexUsage, pollMs);
