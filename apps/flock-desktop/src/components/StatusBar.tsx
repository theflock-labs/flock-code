import { claudeUsage, codexUsage, type MergeQueueItem, type RepoMap } from "../lib/tauri";
import type { Workspace } from "../types";
import AgentUsageBar from "./AgentUsageBar";
import BudgetChip from "./BudgetChip";
import GrokUsageChip from "./GrokUsageChip";
import OpencodeSpendChip from "./OpencodeSpendChip";
import WorktreeChangesBar from "./WorktreeChangesBar";
import { QueueIcon } from "./statusIcons";

/** The slim status strip along the bottom edge of the window — the calm home
 * for ambient telemetry that used to crowd the titlebar: uncommitted changes on
 * the left, Codex + Claude session usage on the right. Popovers open upward.
 * Keeping this out of the titlebar means it never fights window-dragging and
 * stays reliably clickable (the titlebar is a macOS drag region). */
export default function StatusBar({
  workspaces,
  repoMaps,
  mergeQueue,
  onOpenGit,
  onOpenMergeQueue,
  onOpenCommandBar,
}: {
  workspaces: Workspace[];
  repoMaps: Record<string, RepoMap>;
  mergeQueue: MergeQueueItem[];
  onOpenGit: (workspaceId: string) => void;
  onOpenMergeQueue: () => void;
  onOpenCommandBar: () => void;
}) {
  return (
    <div className="status-bar">
      <div className="status-bar-section left">
        {/* The app's only permanent mention of ⌘K. The empty-workspace screen
            names it once and then disappears forever on the first workspace,
            and there is no menu bar to fall back on — so a user who missed it
            in that one moment had no way left to learn the palette exists.
            Lowest-weight thing on the strip: a reminder, not a button. */}
        <button className="cmdk-cue" onClick={onOpenCommandBar} title="Command bar — run anything, or type a prompt for an agent">
          <kbd>⌘K</kbd>
        </button>
        <WorktreeChangesBar workspaces={workspaces} repoMaps={repoMaps} onOpenGit={onOpenGit} />
        <MergeQueueChip queue={mergeQueue} onOpen={onOpenMergeQueue} />
      </div>
      <div className="status-bar-section right">
        {/* Spend-to-date sits left of the plan meters: the meters answer "how
            much of my subscription is left", this answers "what has today
            cost", and the second is the one a budget is written against. */}
        <BudgetChip workspaces={workspaces} />
        <OpencodeSpendChip />
        <GrokUsageChip />
        <AgentUsageBar
          agent="codex"
          side="right"
          label="Codex"
          panelTitle="Codex usage limits"
          fetcher={codexUsage}
        />
        <AgentUsageBar
          agent="claude"
          side="right"
          label="Claude"
          panelTitle="Claude usage limits"
          fetcher={claudeUsage}
        />
      </div>
    </div>
  );
}

/** What the queue head is doing, in two words — the chip's at-a-glance text.
 * The full story (per-item statuses, notes, reordering) lives in the modal. */
function headLabel(head: MergeQueueItem): string {
  switch (head.status) {
    case "checks_pending": return "waiting on checks";
    case "rebasing": return "updating branch";
    case "blocked": return head.note ?? "blocked";
    case "failed": return "failed";
    case "merging": return "merging";
    default: return "queued";
  }
}

/** Ambient merge-queue presence: hidden while the queue is empty, otherwise a
 * count + the head item's state, tinted like the modal's status chips. Click
 * opens the Merge Queue modal, where the queue is managed. */
function MergeQueueChip({ queue, onOpen }: { queue: MergeQueueItem[]; onOpen: () => void }) {
  if (queue.length === 0) return null;
  const head = queue[0];
  return (
    <button
      className={`changes-bar clickable mq-statusbar mq-${head.status}`}
      title={`Merge queue — next: ${head.repo}#${head.number} (${headLabel(head)})`}
      onClick={onOpen}
    >
      <span className="mq-statusbar-icon"><QueueIcon size={11} /></span>
      <span className="mq-statusbar-count">{queue.length}</span>
      <span className="mq-statusbar-label">{headLabel(head)}</span>
    </button>
  );
}
