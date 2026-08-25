import { useEffect, useRef, useState, type ReactNode } from "react";
import { openPath } from "@tauri-apps/plugin-opener";
import { CheckIcon, XIcon } from "./friendIcons";
import { ExternalLinkIcon, QueueIcon, ReviewIcon } from "./statusIcons";
import { githubPrDetails, githubPrDiff, type PrDetails, type PrReviewSummary, type MergeQueueItem } from "../lib/tauri";
import ModalCloseButton from "./ModalCloseButton";
import IconButton from "./IconButton";
import DiffView from "./DiffView";
import MergeQueueView from "./MergeQueueModal";
import PrWatchSettings from "./PrWatchSettings";
import { useFocusTrap } from "../lib/useFocusTrap";
import type { PullRequest } from "../types";

export type PrHubView = "prs" | "queue" | "repos";

interface Props {
  prs: PullRequest[];
  /** Why the PR list couldn't be fetched, if the last poll failed. */
  prError: string | null;
  /** PR number to select on open (e.g. the one whose review button was
   * clicked); falls back to the first PR when absent or already gone. */
  initialPr?: number;
  /** Which tab opens first: the PR cockpit or the merge queue. */
  initialView?: PrHubView;
  onClose: () => void;
  onReview: (pr: PullRequest) => void;
  /** Number of the PR currently being checked out + reviewed, if any. */
  reviewingPr: number | null;
  onReviewAll: () => void;
  /** Stored agent-review summaries, keyed "repo#number". */
  summaries: Record<string, PrReviewSummary>;
  /** The connected GitHub login — used to grey the approve button once
   * this user's approval is already on the PR. */
  ghUser: string | null;
  /** The merge queue, in order — drives the tab count and the per-PR queued
   * chip; the MERGE QUEUE tab fetches its own rich detail via inspect. */
  mergeQueue: MergeQueueItem[];
  onQueueAdd: (pr: PullRequest) => Promise<void>;
  onQueueRemove: (repo: string, number: number) => Promise<void>;
  onQueueReorder: (repo: string, number: number, position: number) => Promise<void>;
  onApprove: (repo: string, number: number) => Promise<void>;
  onMergeNow: (repo: string, number: number) => Promise<void>;
  /** slug → local checkout path for open workspaces (conflict analysis). */
  resolveRepoPaths: () => Promise<Record<string, string>>;
}

/** The shared GitHub cockpit: one modal, two tabs. PULL REQUESTS is the
 * master-detail view (list rail + checks/reviews/diff); MERGE QUEUE is the
 * queue manager (validation matrix, approvals, mergeability, reordering).
 * Cross-links switch tabs in place — a queued card's title jumps to that PR's
 * detail, and a PR's "in merge queue" chip jumps to the queue. */
export default function PrManagerModal({
  prs, prError, initialPr, initialView, onClose, onReview, reviewingPr, onReviewAll,
  summaries, ghUser, mergeQueue, onQueueAdd, onQueueRemove, onQueueReorder,
  onApprove, onMergeNow, resolveRepoPaths,
}: Props) {
  const [view, setView] = useState<PrHubView>(initialView ?? "prs");
  const [selected, setSelected] = useState<number | null>(
    (initialPr != null && prs.some((p) => p.number === initialPr) ? initialPr : prs[0]?.number) ?? null,
  );
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Keep the selection valid as the PR list refreshes underneath us (a PR can
  // merge/close while the modal is open); fall back to the first PR.
  useEffect(() => {
    if (prs.length === 0) { setSelected(null); return; }
    if (!prs.some((p) => p.number === selected)) setSelected(prs[0].number);
  }, [prs, selected]);

  const repo = prs[0]?.repo;
  const selectedPr = prs.find((p) => p.number === selected) ?? null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal pr-manager-modal" ref={modalRef} role="dialog" aria-modal="true" aria-label="Pull requests and merge queue" onClick={(e) => e.stopPropagation()}>
        <ModalCloseButton onClose={onClose} />
        <div className="modal-header">
          {/* The eyebrow doubles as the tab bar — same size and voice as the
              step line it replaces, so switching surfaces costs no chrome. */}
          <div className="pr-hub-tabs" role="tablist">
            <button
              className={`pr-hub-tab${view === "prs" ? " active" : ""}`}
              role="tab"
              aria-selected={view === "prs"}
              onClick={() => setView("prs")}
            >
              PULL REQUESTS{prs.length > 0 && ` · ${prs.length}`}
            </button>
            <span className="pr-hub-tab-sep">/</span>
            <button
              className={`pr-hub-tab${view === "queue" ? " active" : ""}`}
              role="tab"
              aria-selected={view === "queue"}
              onClick={() => setView("queue")}
            >
              MERGE QUEUE{mergeQueue.length > 0 && ` · ${mergeQueue.length}`}
            </button>
            <span className="pr-hub-tab-sep">/</span>
            <button
              className={`pr-hub-tab${view === "repos" ? " active" : ""}`}
              role="tab"
              aria-selected={view === "repos"}
              onClick={() => setView("repos")}
            >
              REPOS
            </button>
          </div>
          <div className="title">
            {view === "queue" ? "Merge Queue" : view === "repos" ? "Watched Repos" : repo ?? "Pull Requests"}
          </div>
        </div>

        <div className="modal-body pr-manager-body">
          {view === "repos" ? (
            <PrWatchSettings connected={ghUser !== null} />
          ) : view === "queue" ? (
            <MergeQueueView
              resolveRepoPaths={resolveRepoPaths}
              ghUser={ghUser}
              onApprove={onApprove}
              onMergeNow={onMergeNow}
              onRemove={onQueueRemove}
              onReorder={onQueueReorder}
              onOpenPr={(_repo, number) => { setSelected(number); setView("prs"); }}
            />
          ) : prs.length === 0 ? (
            <div className="pr-manager-empty">
              {prError ? "nothing loaded yet" : "no open pull requests on this repo"}
            </div>
          ) : (
            <div className="pr-manager-split">
              <aside className="pr-list-rail">
                {prError && (
                  <div className="pr-manager-error pr-list-error">couldn't refresh — {prError}</div>
                )}
                <div className="pr-list-scroll">
                  {prs.map((pr) => (
                    <PrListItem
                      key={`${pr.repo}#${pr.number}`}
                      pr={pr}
                      selected={pr.number === selected}
                      reviewing={reviewingPr === pr.number}
                      onSelect={() => setSelected(pr.number)}
                    />
                  ))}
                </div>
                {prs.length > 1 && (
                  <button className="btn-mint-solid pr-review-all" onClick={onReviewAll}>
                    + Review all with agents
                  </button>
                )}
              </aside>

              <section className="pr-detail-pane">
                {selectedPr ? (
                  <PrDetail
                    key={`${selectedPr.repo}#${selectedPr.number}`}
                    pr={selectedPr}
                    onReview={onReview}
                    reviewing={reviewingPr === selectedPr.number}
                    reviewDisabled={reviewingPr !== null}
                    summary={summaries[`${selectedPr.repo}#${selectedPr.number}`]}
                    ghUser={ghUser}
                    queuedItem={mergeQueue.find((i) => i.repo === selectedPr.repo && i.number === selectedPr.number)}
                    onQueueAdd={onQueueAdd}
                    onApprove={onApprove}
                    onOpenMergeQueue={() => setView("queue")}
                  />
                ) : (
                  <div className="pr-detail-placeholder">Select a pull request to see its diff.</div>
                )}
              </section>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <span className="kbd">esc</span><span>close</span>
        </div>
      </div>
    </div>
  );
}

function PrListItem({ pr, selected, reviewing, onSelect }: {
  pr: PullRequest;
  selected: boolean;
  reviewing: boolean;
  onSelect: () => void;
}) {
  return (
    <button className={`pr-list-item${selected ? " selected" : ""}`} onClick={onSelect}>
      <div className="pr-list-item-top">
        <span className="pr-number">#{pr.number}</span>
        <span className="pr-list-item-title">{pr.title}</span>
        {reviewing && <span className="pr-review-spinner" />}
      </div>
      <span className="pr-list-item-meta">
        @{pr.author}
        {pr.head_ref && <> · {pr.head_ref}</>}
        {pr.updated_at && <> · {relativeTime(pr.updated_at)}</>}
      </span>
    </button>
  );
}

function PrDetail({ pr, onReview, reviewing, reviewDisabled, summary, ghUser, queuedItem, onQueueAdd, onApprove, onOpenMergeQueue }: {
  pr: PullRequest;
  onReview: (pr: PullRequest) => void;
  reviewing: boolean;
  reviewDisabled: boolean;
  /** Stored agent-review summary for this PR, if one exists. */
  summary?: PrReviewSummary;
  ghUser: string | null;
  /** This PR's merge-queue entry, when queued. */
  queuedItem?: MergeQueueItem;
  onQueueAdd: (pr: PullRequest) => Promise<void>;
  onApprove: (repo: string, number: number) => Promise<void>;
  onOpenMergeQueue: () => void;
}) {
  // Checks/reviews are fetched once when this PR becomes the selected one
  // (the component is remounted per-PR via `key`), so we pay one API
  // round-trip per PR the user actually opens. `detailsRefresh` re-runs the
  // fetch after an approve, so the fresh review chip appears.
  const [details, setDetails] = useState<PrDetails | null>(null);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [detailsRefresh, setDetailsRefresh] = useState(0);
  const [approving, setApproving] = useState(false);
  const [queueing, setQueueing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    githubPrDetails(pr.repo, pr.number)
      .then((d) => { if (!cancelled) { setDetails(d); setDetailsError(null); } })
      .catch((e) => { if (!cancelled) setDetailsError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [pr.repo, pr.number, detailsRefresh]);

  const ghUrl = `https://github.com/${pr.repo}/pull/${pr.number}`;
  // Prefer the details fetch (always has the branch); fall back to whatever the
  // list gave us (only populated for workspace-sourced PRs).
  const headRef = details?.head_ref || pr.head_ref;
  const alreadyApproved = !!ghUser && !!details?.reviews.some(
    (r) => r.author === ghUser && r.state.toUpperCase() === "APPROVED",
  );

  const approve = async () => {
    if (approving || alreadyApproved) return;
    setActionError(null);
    setApproving(true);
    try {
      await onApprove(pr.repo, pr.number);
      setDetailsRefresh((n) => n + 1); // pull the new review chip in
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setApproving(false);
    }
  };

  const queueMerge = async () => {
    if (queueing || queuedItem) return;
    setActionError(null);
    setQueueing(true);
    try {
      await onQueueAdd(pr);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setQueueing(false);
    }
  };

  return (
    <div className="pr-detail">
      <div className="pr-detail-head">
        <div className="pr-detail-titlerow">
          <span className="pr-number">#{pr.number}</span>
          <span className="pr-detail-title">{pr.title}</span>
          <div className="pr-detail-actions">
            <button
              className={`pr-action-btn pr-approve-btn${approving ? " loading" : ""}${alreadyApproved ? " done" : ""}`}
              title={alreadyApproved
                ? `Already approved as @${ghUser}`
                : `Submit an approving review as @${ghUser ?? "the connected user"}`}
              disabled={approving || alreadyApproved}
              onClick={approve}
            >
              {approving
                ? <span className="pr-review-spinner" />
                : <><CheckIcon size={11} /> {alreadyApproved ? "approved" : "approve"}</>}
            </button>
            {queuedItem ? (
              <button
                className="pr-queued-chip"
                title="Waiting in the merge queue — click to manage it"
                onClick={onOpenMergeQueue}
              >
                in merge queue · #{queuedItem.position + 1} <ExternalLinkIcon size={10} />
              </button>
            ) : (
              <button
                className={`pr-action-btn pr-queue-btn${queueing ? " loading" : ""}`}
                title="Add to the merge queue — merges automatically once approved and green, in order"
                disabled={queueing}
                onClick={queueMerge}
              >
                {queueing ? <span className="pr-review-spinner" /> : <><QueueIcon size={11} /> queue merge</>}
              </button>
            )}
            <button
              className={`pr-review-btn${reviewing ? " loading" : ""}`}
              title={reviewing
                ? "Checking out branch and starting agent…"
                : `Check out ${headRef || `PR #${pr.number}`} and start an agent to review it`}
              onClick={() => { if (!reviewDisabled) onReview(pr); }}
            >
              {reviewing ? <span className="pr-review-spinner" /> : <><ReviewIcon size={11} /> review</>}
            </button>
            <IconButton
              className="pr-manager-gh-btn"
              icon={<ExternalLinkIcon size={13} />}
              label="Open on GitHub"
              onClick={() => openPath(ghUrl).catch(console.error)}
            />
          </div>
        </div>
        <div className="pr-detail-meta">
          @{pr.author}
          {pr.updated_at && <> · {relativeTime(pr.updated_at)}</>}
        </div>
        {actionError && <div className="pr-manager-error">{actionError}</div>}
        {(headRef || details?.base_ref) && (
          <div className="pr-branch-flow" title="source branch → target branch">
            <span className="pr-branch pr-branch-head">{headRef || "unknown"}</span>
            <span className="pr-branch-arrow">→</span>
            <span className="pr-branch pr-branch-base">{details?.base_ref || "…"}</span>
          </div>
        )}

        {detailsError ? (
          <div className="pr-manager-error">couldn't load checks — {detailsError}</div>
        ) : details && (details.checks.length > 0 || details.reviews.length > 0) ? (
          <div className="pr-detail-status">
            {details.checks.length > 0 && (
              <div className="pr-detail-checks">
                {details.checks.map((c, i) => (
                  <span
                    key={i}
                    className={`pr-detail-check ${conclusionClass(c.conclusion, c.status)}`}
                    title={`${c.name}: ${c.conclusion ?? c.status}`}
                  >
                    <span className="pr-check-dot">{conclusionIcon(c.conclusion, c.status)}</span>
                    {c.name}
                  </span>
                ))}
              </div>
            )}
            {details.reviews.length > 0 && (
              <div className="pr-detail-reviews">
                {details.reviews.map((r, i) => (
                  <span key={i} className={`pr-detail-review pr-review-${r.state.toLowerCase()}`} title={r.body}>
                    {r.state.replace("_", " ").toLowerCase()} · @{r.author}
                  </span>
                ))}
              </div>
            )}
          </div>
        ) : null}
      </div>

      {summary && (
        <div className="pr-agent-review">
          <div className="pr-agent-review-label">
            AGENT REVIEW
            <span className="pr-agent-review-time">{relativeTime(summary.updated_at)}</span>
          </div>
          <div className="pr-agent-review-text">{summary.summary}</div>
        </div>
      )}

      <DiffView
        load={() => githubPrDiff(pr.repo, pr.number)}
        externalUrl={`${ghUrl}/files`}
        emptyMessage="This pull request has no file changes."
      />
    </div>
  );
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

function relativeTime(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 172800) return "yesterday";
  return `${Math.floor(diff / 86400)}d ago`;
}
