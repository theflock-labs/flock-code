import { useCallback, useEffect, useState } from "react";
import {
  githubCheck,
  githubWorkspaceChecks,
  githubWorkspacePrs,
  type WorkspaceChecks,
} from "./tauri";
import { getGithubIntegrationEnabled } from "./githubSettings";
import { isWindowActive, onWindowActiveChange } from "./windowActive";
import type { GitHubStatus, PullRequest } from "../types";

/** GitHub integration state for the focused workspace: connection status, the
 * open-PR list, and CI check status for the checked-out branch's PR. Polling
 * is scoped to `focusedRepoPath` — the backend resolves the live branch via
 * git itself (the workspace's stored `branch` field is only a creation-time
 * default and goes stale as soon as anyone runs `git checkout`). */
export function useGithubPrs(focusedRepoPath: string | null) {
  const [ghStatus, setGhStatus] = useState<GitHubStatus | null>(null);
  const [pullRequests, setPullRequests] = useState<PullRequest[]>([]);
  // Why the PR list couldn't be fetched (null when the last poll succeeded).
  // Surfaced in the sidebar — a silently empty list is indistinguishable
  // from "no open PRs", which hides real problems like a token an org's
  // OAuth-app restrictions reject.
  const [prError, setPrError] = useState<string | null>(null);
  const [wsChecks, setWsChecks] = useState<WorkspaceChecks | null>(null);

  // "Enable GitHub Integration" in Settings → GitHub. Re-read live (not just
  // on mount) since the toggle lives in a dialog that can open/close anytime
  // during this session.
  const [ghIntegrationEnabled, setGhIntegrationEnabledState] = useState(getGithubIntegrationEnabled());
  useEffect(() => {
    const onChange = () => setGhIntegrationEnabledState(getGithubIntegrationEnabled());
    window.addEventListener("flock:github-integration-changed", onChange);
    return () => window.removeEventListener("flock:github-integration-changed", onChange);
  }, []);

  useEffect(() => {
    githubCheck().then(setGhStatus).catch(() => {});
  }, []);

  // Poll GitHub CI check status (GH Actions, SAST scans, etc.) for the open
  // PR matching the focused workspace's currently checked-out branch, for
  // the notification bar.
  useEffect(() => {
    if (!ghIntegrationEnabled || !ghStatus?.connected || !focusedRepoPath) {
      setWsChecks(null);
      return;
    }
    let cancelled = false;
    const poll = () => {
      githubWorkspaceChecks(focusedRepoPath)
        .then((res) => { if (!cancelled) setWsChecks(res); })
        .catch(() => { if (!cancelled) setWsChecks(null); });
    };
    poll();
    // Pause the GitHub API poll while the app is hidden (saves rate limit +
    // network); refresh once on return.
    const interval = setInterval(() => { if (isWindowActive()) poll(); }, 20000);
    const unsub = onWindowActiveChange((active) => { if (active) poll(); });
    return () => { cancelled = true; clearInterval(interval); unsub(); };
  }, [ghIntegrationEnabled, ghStatus?.connected, focusedRepoPath]);

  // Show every open PR (any author) for the focused workspace's repo, so any
  // PR can be picked for review — not just ones you authored. Polled so a PR
  // opened mid-session (e.g. by an agent running `gh pr create`) shows up
  // without restarting.
  useEffect(() => {
    if (!ghIntegrationEnabled || !ghStatus?.connected || !focusedRepoPath) {
      setPullRequests([]);
      setPrError(null);
      return;
    }
    let cancelled = false;
    const poll = () => {
      githubWorkspacePrs(focusedRepoPath)
        .then((res) => { if (!cancelled) { setPullRequests(res); setPrError(null); } })
        .catch((e) => {
          // Keep the last known list on transient failures; only the error
          // note changes. A persistent failure leaves the list empty and
          // the sidebar shows why.
          if (!cancelled) setPrError(e instanceof Error ? e.message : String(e));
        });
    };
    poll();
    const interval = setInterval(() => { if (isWindowActive()) poll(); }, 30000);
    const unsub = onWindowActiveChange((active) => { if (active) poll(); });
    return () => { cancelled = true; clearInterval(interval); unsub(); };
  }, [ghIntegrationEnabled, ghStatus?.connected, focusedRepoPath]);

  const refreshGh = useCallback(async () => {
    const gh = await githubCheck();
    setGhStatus(gh);
    if (!gh.connected) {
      // Friends/presence are flock ID's concern now; disconnecting
      // GitHub only clears the repo-scoped surfaces.
      setPullRequests([]);
      setPrError(null);
    }
  }, []);

  return { ghStatus, pullRequests, prError, wsChecks, ghIntegrationEnabled, refreshGh };
}
