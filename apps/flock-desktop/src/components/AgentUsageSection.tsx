import type { ClaudeUsage } from "../lib/tauri";
import { useAgentUsage } from "../lib/useClaudeUsage";
import ClaudeUsagePanel from "./ClaudeUsagePanel";

/** One agent's usage limits as a Settings section — Claude or Codex, both share
 * the same shape and panel. Fetch/poll live in the shared hook. */
export default function AgentUsageSection({
  fetcher,
  title,
  sessionHeading,
  footnote,
}: {
  fetcher: (force: boolean) => Promise<ClaudeUsage>;
  title: string;
  sessionHeading?: string;
  footnote?: string;
}) {
  const { usage, now, loading, error, refresh } = useAgentUsage(fetcher);
  return (
    <div className="settings-section">
      <ClaudeUsagePanel
        usage={usage}
        now={now}
        loading={loading}
        error={error}
        onRefresh={refresh}
        title={title}
        sessionHeading={sessionHeading}
        footnote={footnote}
      />
    </div>
  );
}
