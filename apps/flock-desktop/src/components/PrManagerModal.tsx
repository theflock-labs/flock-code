import { useEffect, useState } from "react";
import { openPath } from "@tauri-apps/plugin-opener";
import { githubPrDetails, githubPrDiff, type PrDetails, type PrReviewSummary, type MergeQueueItem } from "../lib/tauri";
import DiffView from "./DiffView";
import MergeQueueView from "./MergeQueueModal";
import PrWatchSettings from "./PrWatchSettings";
import type { PullRequest } from "../types";
import { Page, PageEmpty } from "../v2/Page";
import { ExternalIcon, PlusIcon } from "../v2/icons";
import "./PrManagerModal.css";

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
  /** Present while the app's sidebar is hidden. */
  onShowSidebar?: () => void;
}

/** Pull requests, as a page of the main panel: the open PRs listed beside the
 * one you picked (its checks, reviews, the agent's review and the diff), the
 * merge queue, and the repos flock watches. Cross-links switch views in place:
 * a queued PR's title opens its detail, a PR's queue place opens the queue. */
export default function PrManagerModal({
  prs, prError, initialPr, initialView, onClose, onReview, reviewingPr, onReviewAll,
  summaries, ghUser, mergeQueue, onQueueAdd, onQueueRemove, onQueueReorder,
  onApprove, onMergeNow, resolveRepoPaths, onShowSidebar,
}: Props) {
  const [view, setView] = useState<PrHubView>(initialView ?? "prs");
  const [selected, setSelected] = useState<number | null>(
    (initialPr != null && prs.some((p) => p.number === initialPr) ? initialPr : prs[0]?.number) ?? null,
  );
  // Keep the selection valid as the PR list refreshes underneath us (a PR can
  // merge/close while the modal is open); fall back to the first PR.
  useEffect(() => {
    if (prs.length === 0) { setSelected(null); return; }
    if (!prs.some((p) => p.number === selected)) setSelected(prs[0].number);
  }, [prs, selected]);

  const repo = prs[0]?.repo;
  const selectedPr = prs.find((p) => p.number === selected) ?? null;

  return (
    <Page<PrHubView>
      title="Pull requests"
      meta={view === "prs" && repo ? <span className="v2-page-meta">{repo}</span> : undefined}
      tabs={[
        { id: "prs", label: "Open", count: prs.length },
        { id: "queue", label: "Merge queue", count: mergeQueue.length, title: "Pull requests that merge by themselves, in order, once approved and green" },
        { id: "repos", label: "Watched repos" },
      ]}
      tab={view}
      onTab={setView}
      onClose={onClose}
      onShowSidebar={onShowSidebar}
      className="v2-prs"
    >
      {view === "repos" ? (
        <div className="v2-page-scroll">
          <PrWatchSettings connected={ghUser !== null} />
        </div>
      ) : view === "queue" ? (
        <div className="v2-page-scroll">
          <MergeQueueView
            resolveRepoPaths={resolveRepoPaths}
            ghUser={ghUser}
            onApprove={onApprove}
            onMergeNow={onMergeNow}
            onRemove={onQueueRemove}
            onReorder={onQueueReorder}
            onOpenPr={(_repo, number) => { setSelected(number); setView("prs"); }}
          />
        </div>
      ) : prs.length === 0 ? (
        <PageEmpty>{prError ? `Couldn't load pull requests: ${prError}` : "No open pull requests."}</PageEmpty>
      ) : (
        <div className="v2-split">
          <aside className="v2-split-list" aria-label="Open pull requests">
            {prError && <p className="v2-note error" style={{ margin: "0.8em 1.1em 0" }}>Couldn't refresh: {prError}</p>}
            <ul className="v2-list">
              {prs.map((pr) => (
                <li key={`${pr.repo}#${pr.number}`}>
                  <PrListItem
                    pr={pr}
                    ghUser={ghUser}
                    selected={pr.number === selected}
                    reviewing={reviewingPr === pr.number}
                    onSelect={() => setSelected(pr.number)}
                  />
                </li>
              ))}
            </ul>
            {prs.length > 1 && (
              <button
                type="button"
                className="v2-row v2-list-foot"
                onClick={onReviewAll}
                disabled={reviewingPr !== null}
                title="Start one review agent per pull request"
              >
                <PlusIcon size={16} />
                Review all with agents
              </button>
            )}
          </aside>

          <section className="v2-split-detail">
            {selectedPr ? (
              <PrDetail
                key={`${selectedPr.repo}#${selectedPr.number}`}
                pr={selectedPr}
                onReview={onReview}
                reviewing={reviewingPr === selectedPr.number}
                reviewingPr={reviewingPr}
                summary={summaries[`${selectedPr.repo}#${selectedPr.number}`]}
                ghUser={ghUser}
                queuedItem={mergeQueue.find((i) => i.repo === selectedPr.repo && i.number === selectedPr.number)}
                onQueueAdd={onQueueAdd}
                onApprove={onApprove}
                onOpenMergeQueue={() => setView("queue")}
              />
            ) : (
              <PageEmpty>Pick a pull request.</PageEmpty>
            )}
          </section>
        </div>
      )}
    </Page>
  );
}

function PrListItem({ pr, ghUser, selected, reviewing, onSelect }: {
  pr: PullRequest;
  ghUser: string | null;
  selected: boolean;
  reviewing: boolean;
  onSelect: () => void;
}) {
  const meta = [
    `#${pr.number}`,
    pr.author && pr.author !== ghUser ? `@${pr.author}` : null,
    pr.head_ref || null,
    pr.updated_at ? relativeTime(pr.updated_at) : null,
  ].filter(Boolean).join(" · ");
  return (
    <button type="button" className="v2-list-row" aria-current={selected || undefined} onClick={onSelect}>
      <span />
      <span>
        <span className="v2-list-title">{pr.title}</span>
        <span className="v2-list-meta">{meta}</span>
      </span>
      {reviewing ? <span className="v2-spinner" role="status" aria-label="Review starting" /> : <span />}
    </button>
  );
}

function PrDetail({ pr, onReview, reviewing, reviewingPr, summary, ghUser, queuedItem, onQueueAdd, onApprove, onOpenMergeQueue }: {
  pr: PullRequest;
  onReview: (pr: PullRequest) => void;
  reviewing: boolean;
  reviewingPr: number | null;
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

  const reviewBusyMessage = reviewingPr === null ? null : reviewing
    ? `Starting an agent for PR #${pr.number}…`
    : `An agent review is starting for PR #${reviewingPr}. You can start another once it is ready.`;

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

  const checkTone = (conclusion: string | null, status: string) =>
    conclusion === "success" ? "ok"
      : conclusion === "failure" || conclusion === "timed_out" ? "bad"
        : status === "in_progress" || status === "queued" ? "busy" : undefined;

  return (
    <div className="v2-detail v2-pr">
      <h2>
        {pr.title} <span className="v2-faint">#{pr.number}</span>
      </h2>
      <p className="v2-detail-sub">
        @{pr.author}
        {headRef && (
          <>
            {" "}wants to merge <code>{headRef}</code>
            {details?.base_ref && <> into <code>{details.base_ref}</code></>}
          </>
        )}
        {pr.updated_at && <> · {relativeTime(pr.updated_at)}</>}
      </p>

      {detailsError ? (
        <p className="v2-note error">Couldn't load checks: {detailsError}</p>
      ) : !details ? (
        <p className="v2-note" role="status">Loading checks…</p>
      ) : details.checks.length + details.reviews.length > 0 ? (
        <div className="v2-chips">
          {details.checks.map((c, i) => (
            <span key={`c${i}`} className="v2-status-chip" data-tone={checkTone(c.conclusion, c.status)} title={`${c.name}: ${c.conclusion ?? c.status}`}>
              {c.name}
            </span>
          ))}
          {details.reviews.map((r, i) => (
            <details key={`r${i}`} className="v2-status-chip">
              <summary>
                {r.state.replaceAll("_", " ").toLowerCase().replace(/^./, (ch) => ch.toUpperCase())} by @{r.author}
              </summary>
              <p>{r.body || "No written feedback."}</p>
            </details>
          ))}
        </div>
      ) : (
        <p className="v2-note">No checks or reviews yet.</p>
      )}

      <div className="v2-detail-actions">
        <button
          type="button"
          className="v2-btn primary"
          title={reviewBusyMessage ?? `Check out ${headRef || `PR #${pr.number}`} and start an agent to review it`}
          disabled={reviewingPr !== null}
          aria-busy={reviewing}
          onClick={() => onReview(pr)}
        >
          {reviewing ? "Starting review…" : "Review with agent"}
        </button>
        <button
          type="button"
          className="v2-btn"
          title={alreadyApproved ? `Already approved as @${ghUser}` : `Approve on GitHub as @${ghUser ?? "your account"}`}
          disabled={approving || alreadyApproved}
          aria-busy={approving}
          onClick={approve}
        >
          {approving ? "Approving…" : alreadyApproved ? "Approved" : "Approve"}
        </button>
        {queuedItem ? (
          <button type="button" className="v2-btn" title="Waiting in the merge queue. Open the queue." onClick={onOpenMergeQueue}>
            In merge queue · {queuedItem.position + 1}
          </button>
        ) : (
          <button
            type="button"
            className="v2-btn"
            title="Merges by itself, in order, once approved and with no failing checks. GitHub's branch rules still apply."
            disabled={queueing}
            aria-busy={queueing}
            onClick={queueMerge}
          >
            {queueing ? "Adding…" : "Add to merge queue"}
          </button>
        )}
        <button type="button" className="v2-icon-btn" aria-label="Open on GitHub" title="Open on GitHub" onClick={() => openPath(ghUrl).catch(console.error)}>
          <ExternalIcon size={15} />
        </button>
      </div>
      {actionError && <p className="v2-note error">{actionError}</p>}
      {reviewBusyMessage && !reviewing && <p className="v2-note" role="status">{reviewBusyMessage}</p>}

      {summary && (
        <section className="v2-detail-section">
          <h3>
            Agent review <span className="v2-faint">· {relativeTime(summary.updated_at)}</span>
          </h3>
          <p className="v2-detail-body" style={{ marginTop: 0 }}>{summary.summary}</p>
        </section>
      )}

      <section className="v2-detail-section v2-pr-diff">
        <DiffView
          load={() => githubPrDiff(pr.repo, pr.number)}
          externalUrl={`${ghUrl}/files`}
          emptyMessage="This pull request has no file changes."
        />
      </section>
    </div>
  );
}

function relativeTime(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 172800) return "yesterday";
  return `${Math.floor(diff / 86400)}d ago`;
}
