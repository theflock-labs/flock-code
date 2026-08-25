import { useContextUsage } from "../lib/contextUsage";

/** How full this agent's context window is: a chip-sized bar plus the token
 * count, sitting with the other pane-topbar markers.
 *
 * A bar rather than a bare percentage because the thing you actually scan a
 * grid for is *which agent is nearly full* — a row of fills answers that in one
 * look, where eight percentages have to be read one at a time. The number rides
 * alongside for when you do want the figure.
 *
 * Renders nothing at all when there's no reading, which covers every case where
 * a meter would be a lie: panes of an agent whose store isn't read here
 * (opencode/codex record usage in their own shapes) and a pane whose agent
 * hasn't been talked to yet. An absent meter and an empty one say different
 * things, so we don't draw the empty one. Jailed panes *do* get a meter — their
 * transcripts are mounted out to a per-workspace host directory (flock-pty
 * `container::run_args`) rather than left inside the container's `$HOME`
 * volume.
 *
 * claude and grok qualify for the same reason: flock imposes the session id at
 * spawn (`--session-id`), so each pane's own conversation is findable. See
 * `claude_context` / `grok_context`. */
const METERED = new Set(["claude", "grok"]);

export default function ContextMeter({
  kind,
  sessionId,
}: {
  kind: string;
  sessionId?: string;
}) {
  const usage = useContextUsage(METERED.has(kind) ? sessionId : undefined);
  if (!usage) return null;

  const frac = Math.min(1, usage.used_tokens / usage.window_tokens);
  // Thresholds are about headroom, not aesthetics: claude auto-compacts in the
  // last stretch of the window, so `hot` is "this agent is about to lose its
  // early context" and `warn` is "start thinking about wrapping the thread up".
  const tone = frac >= 0.85 ? " hot" : frac >= 0.6 ? " warn" : "";

  return (
    <span
      className={`pane-context${tone}`}
      title={`Context: ${usage.used_tokens.toLocaleString()} of ${usage.window_tokens.toLocaleString()} tokens (${Math.round(frac * 100)}%) · ${usage.model || "unknown model"}`}
    >
      <span className="pane-context-track">
        {/* Floor the visible fill so a just-started session still shows a tick
            of color — a track that reads as empty is indistinguishable from the
            no-meter case one pane over. */}
        <span className="pane-context-fill" style={{ width: `${Math.max(2, frac * 100)}%` }} />
      </span>
      <span className="pane-context-label">{compact(usage.used_tokens)}</span>
    </span>
  );
}

/** 86749 → "87k". The topbar is a 26px strip shared with the pane name, chips
 * and three buttons; exact digits here would cost the name its width and tell
 * you nothing the bar didn't. */
function compact(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}
