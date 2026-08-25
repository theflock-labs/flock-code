import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { openPath } from "@tauri-apps/plugin-opener";
import { CheckIcon, XIcon } from "./friendIcons";
import { RefreshIcon, ExternalLinkIcon } from "./statusIcons";
import {
  mergeQueueInspect,
  githubUpdatePrBranch,
  type MergeQueueItemDetail,
} from "../lib/tauri";

interface Props {
  /** slug → local checkout path for open workspaces, resolved lazily by App.
   * Feeds `git merge-tree` conflict analysis for dirty PRs; resolved once per
   * view mount and reused across refreshes. */
  resolveRepoPaths: () => Promise<Record<string, string>>;
  /** The connected GitHub login — drives the per-card approve action. */
  ghUser: string | null;
  onApprove: (repo: string, number: number) => Promise<void>;
  onMergeNow: (repo: string, number: number) => Promise<void>;
  onRemove: (repo: string, number: number) => Promise<void>;
  onReorder: (repo: string, number: number, position: number) => Promise<void>;
  /** Jump to this PR's detail (checks, reviews, diff) — the host modal
   * switches to its Pull Requests tab and selects the PR. */
  onOpenPr: (repo: string, number: number) => void;
}

/** The MERGE QUEUE tab of the shared PR modal: one card per queued PR showing
 * its validation matrix (every check), latest review per reviewer, and
 * GitHub's mergeability verdict — plus merge-now / update-branch / reorder /
 * remove. Queueing itself happens on the Pull Requests tab; this view is
 * about landing what's already queued. */
export default function MergeQueueView({
  resolveRepoPaths, ghUser, onApprove, onMergeNow, onRemove, onReorder, onOpenPr,
}: Props) {
  // Inspect result: null until the first load resolves; kept (stale) across
  // refreshes so mutations don't blank the list while re-inspecting.
  const [details, setDetails] = useState<MergeQueueItemDetail[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // The repo-path resolution (workspace slugs) is paid once per view mount.
  const repoPathsRef = useRef<Promise<Record<string, string>> | null>(null);

  const inspect = useCallback(async () => {
    setRefreshing(true);
    try {
      repoPathsRef.current ??= resolveRepoPaths().catch(() => ({}));
      const paths = await repoPathsRef.current;
      const d = await mergeQueueInspect(paths);
      setDetails(d);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  }, [resolveRepoPaths]);

  useEffect(() => { void inspect(); }, [inspect]);

  // One mutation at a time across the whole queue (reorder/merge race
  // otherwise); errors surface inline on the card that failed.
  const [busy, setBusy] = useState<{ key: string; action: string } | null>(null);
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({});
  const runOp = useCallback(async (key: string, action: string, op: () => Promise<void>) => {
    setBusy({ key, action });
    setCardErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
    try {
      await op();
      await inspect();
    } catch (e) {
      setCardErrors((prev) => ({ ...prev, [key]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(null);
    }
  }, [inspect]);

  if (details === null) {
    return (
      <div className="mq-view">
        <div className="mq-empty">
          {loadError ? `couldn't inspect the queue — ${loadError}` : "inspecting queue…"}
        </div>
      </div>
    );
  }
  if (details.length === 0) {
    return (
      <div className="mq-view">
        <div className="mq-empty">queue a merge from the Pull Requests tab</div>
      </div>
    );
  }
  return (
    <div className="mq-view">
      <div className="mq-toolbar-slim">
        {loadError && <div className="pr-manager-error mq-load-error">couldn't refresh — {loadError}</div>}
        <button
          className="mq-refresh"
          disabled={refreshing}
          title="Re-inspect every queued PR"
          onClick={() => void inspect()}
        >
          {refreshing ? "refreshing…" : <><RefreshIcon size={11} /> refresh</>}
        </button>
      </div>
      <div className="mq-cards">
        {details.map((d, i) => {
          const key = `${d.item.repo}#${d.item.number}`;
          return (
            <QueueCard
              key={key}
              d={d}
              index={i}
              count={details.length}
              ghUser={ghUser}
              busyAction={busy?.key === key ? busy.action : null}
              disabled={busy !== null}
              error={cardErrors[key] ?? null}
              run={(action, op) => void runOp(key, action, op)}
              onApprove={onApprove}
              onMergeNow={onMergeNow}
              onRemove={onRemove}
              onReorder={onReorder}
              onOpenPr={onOpenPr}
            />
          );
        })}
      </div>
    </div>
  );
}

function QueueCard({ d, index, count, ghUser, busyAction, disabled, error, run, onApprove, onMergeNow, onRemove, onReorder, onOpenPr }: {
  d: MergeQueueItemDetail;
  index: number;
  count: number;
  ghUser: string | null;
  /** The in-flight action on this card, if any — drives its button spinner. */
  busyAction: string | null;
  /** True while any card's mutation runs — queue mutations are serialized. */
  disabled: boolean;
  error: string | null;
  run: (action: string, op: () => Promise<void>) => void;
  onApprove: (repo: string, number: number) => Promise<void>;
  onMergeNow: (repo: string, number: number) => Promise<void>;
  onRemove: (repo: string, number: number) => Promise<void>;
  onReorder: (repo: string, number: number, position: number) => Promise<void>;
  onOpenPr: (repo: string, number: number) => void;
}) {
  const { item } = d;
  const ghUrl = `https://github.com/${item.repo}/pull/${item.number}`;
  const [showAllConflicts, setShowAllConflicts] = useState(false);
  const alreadyApproved = !!ghUser && d.approvals.some(
    (a) => a.author === ghUser && a.state.toUpperCase() === "APPROVED",
  );
  const state = d.mergeable_state;

  return (
    <div className="mq-card">
      <div className="mq-card-head">
        <span className="mq-card-pos">{item.position + 1}</span>
        <button className="mq-card-ref" title="Open on GitHub" onClick={() => openPath(ghUrl).catch(console.error)}>
          {item.repo}#{item.number} <ExternalLinkIcon size={11} />
        </button>
        {/* Title clicks through to the PR's detail on the Pull Requests tab —
            checks, reviews, and the diff live there. */}
        <button
          className="mq-card-title"
          title="Open on the Pull Requests tab — checks, reviews, and the diff"
          onClick={() => onOpenPr(item.repo, item.number)}
        >
          {item.title}
        </button>
        {/* The blocked/failed reason rides inside the chip ("blocked · not
            approved") so the verdict and its why read as one token. */}
        <span className={`mq-chip mq-${item.status}`} title={item.note ?? undefined}>
          {item.status.replace("_", " ")}
          {item.note && (item.status === "blocked" || item.status === "failed") ? ` · ${item.note}` : ""}
        </span>
      </div>

      <div className="pr-branch-flow mq-card-branches" title="source branch → target branch">
        <span className="pr-branch pr-branch-head">{d.head_ref || "unknown"}</span>
        <span className="pr-branch-arrow">→</span>
        <span className="pr-branch pr-branch-base">{d.base_ref || "…"}</span>
      </div>

      {error && <div className="pr-manager-error mq-card-error">{error}</div>}

      <div className="mq-card-section">
        <div className="mq-card-label">Validation</div>
        <div className="pr-detail-checks">
          {d.checks.length === 0 ? (
            <span className="mq-none">no checks reported</span>
          ) : (
            d.checks.map((c, i) => (
              <span
                key={i}
                className={`pr-detail-check ${conclusionClass(c.conclusion, c.status)}`}
                title={`${c.name}: ${c.conclusion ?? c.status}`}
              >
                <span className="pr-check-dot">{conclusionIcon(c.conclusion, c.status)}</span>
                {c.name}
              </span>
            ))
          )}
        </div>
      </div>

      <div className="mq-card-section">
        <div className="mq-card-label">Approvals</div>
        <div className="mq-approvals">
          {d.approvals.length === 0 && <span className="mq-none">no reviews yet</span>}
          {d.approvals.map((a) => (
            <span
              key={a.author}
              className={`mq-approval ${approvalClass(a.state)}`}
              title={`${a.state.replace("_", " ").toLowerCase()} · @${a.author}`}
            >
              {approvalIcon(a.state)} @{a.author}
            </span>
          ))}
          {ghUser && !alreadyApproved && (
            <button
              className="mq-approve-btn"
              title={`Submit an approving review as @${ghUser}`}
              disabled={disabled}
              onClick={() => run("approve", () => onApprove(item.repo, item.number))}
            >
              {busyAction === "approve" ? <span className="pr-review-spinner" /> : <><CheckIcon size={11} /> approve</>}
            </button>
          )}
        </div>
      </div>

      <div className="mq-card-section">
        <div className="mq-card-label">Mergeability</div>
        <div className="mq-mergeable-row">
          {state === "clean" ? (
            <span className="mq-mergeable clean"><CheckIcon size={11} /> clean — no conflicts with {d.base_ref}</span>
          ) : state === "behind" ? (
            <>
              <span className="mq-mergeable behind">behind {d.base_ref}</span>
              <button
                className="mq-update-btn"
                title="Ask GitHub to update the PR branch from its base"
                disabled={disabled}
                onClick={() => run("update", () => githubUpdatePrBranch(item.repo, item.number))}
              >
                {busyAction === "update" ? <span className="pr-review-spinner" /> : "update branch"}
              </button>
            </>
          ) : state === "dirty" ? (
            <span className="mq-mergeable dirty"><XIcon size={11} /> conflicts with {d.base_ref}</span>
          ) : d.mergeable === null ? (
            <span className="mq-mergeable computing">computing…</span>
          ) : (
            <span className="mq-mergeable">{state}</span>
          )}
        </div>
        {state === "dirty" && (
          <div className="mq-conflicts">
            {(showAllConflicts ? d.conflict_files : d.conflict_files.slice(0, 6)).map((f) => (
              <span className="mq-conflict-file" key={f}>{f}</span>
            ))}
            {d.conflict_files.length > 6 && (
              <button className="mq-conflicts-toggle" onClick={() => setShowAllConflicts((v) => !v)}>
                {showAllConflicts ? "show fewer" : `show all ${d.conflict_files.length} files`}
              </button>
            )}
            <span className="mq-conflicts-hint">rebase locally in a workspace to resolve</span>
          </div>
        )}
      </div>

      <div className="mq-card-actions">
        <button
          className="mq-btn"
          title="Merge this PR now, with the configured merge method"
          disabled={disabled}
          onClick={() => run("merge", () => onMergeNow(item.repo, item.number))}
        >
          {busyAction === "merge" ? <span className="pr-review-spinner" /> : "merge now"}
        </button>
        {count > 1 && (
          <>
            <button
              className="mq-btn mq-icon"
              title="Move up"
              disabled={disabled || index === 0}
              onClick={() => run("reorder", () => onReorder(item.repo, item.number, item.position - 1))}
            >
              ↑
            </button>
            <button
              className="mq-btn mq-icon"
              title="Move down"
              disabled={disabled || index === count - 1}
              onClick={() => run("reorder", () => onReorder(item.repo, item.number, item.position + 1))}
            >
              ↓
            </button>
          </>
        )}
        <button
          className="mq-btn"
          title="Remove from queue"
          disabled={disabled}
          onClick={() => run("remove", () => onRemove(item.repo, item.number))}
        >
          {busyAction === "remove" ? <span className="pr-review-spinner" /> : "× remove"}
        </button>
      </div>
    </div>
  );
}

function approvalClass(state: string): string {
  const s = state.toUpperCase();
  if (s === "APPROVED") return "approved";
  if (s === "CHANGES_REQUESTED") return "changes";
  return "comment";
}

function approvalIcon(state: string): ReactNode {
  const s = state.toUpperCase();
  if (s === "APPROVED") return <CheckIcon size={11} />;
  if (s === "CHANGES_REQUESTED") return <XIcon size={11} />;
  return <span className="status-mark" />;
}

function conclusionClass(conclusion: string | null, status: string): string {
  if (conclusion === "success") return "check-success";
  if (conclusion === "failure" || conclusion === "timed_out") return "check-failure";
  if (status === "in_progress") return "check-running";
  return "check-neutral";
}

function conclusionIcon(conclusion: string | null, status: string): ReactNode {
  if (conclusion === "success") return <CheckIcon size={11} />;
  if (conclusion === "failure" || conclusion === "timed_out") return <XIcon size={11} />;
  if (status === "in_progress") return <span className="status-mark filled" />;
  return <span className="status-mark" />;
}
