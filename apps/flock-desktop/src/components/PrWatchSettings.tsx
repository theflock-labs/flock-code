// Everything that configures PR watching: which repos are tracked, whether a
// new PR gets an agent, and how the queue lands things. It lives in the PR hub
// (REPOS tab) rather than Settings because the watched set is a working set —
// it changes as projects come and go, and it belongs next to the PR list and
// merge queue it feeds, not three clicks away behind a gear.
//
// Rendered as a standalone component so it has exactly one implementation; the
// config is persisted on every change (there is no Save button), so two copies
// of this UI would race each other through `pr_watch_set_config`.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  prWatchGetConfig, prWatchSetConfig, type PrWatchConfig,
  githubListRepos, type GithubRepo,
} from "../lib/tauri";
import { CheckIcon } from "./friendIcons";

interface Props {
  /** Whether GitHub is connected. The picker needs the API; without it only
   *  the manual `owner/repo` field is meaningful. */
  connected: boolean;
}

export default function PrWatchSettings({ connected }: Props) {
  // Stays null (controls disabled) if the load fails, so a blind save can't
  // clobber the stored config with defaults.
  const [prWatch, setPrWatch] = useState<PrWatchConfig | null>(null);
  const [prWatchError, setPrWatchError] = useState("");
  const [newWatchRepo, setNewWatchRepo] = useState("");
  // The picker's source list. null means "not fetched yet", [] means "fetched,
  // and the account can see nothing".
  const [repoOptions, setRepoOptions] = useState<GithubRepo[] | null>(null);
  const [repoOptionsLoading, setRepoOptionsLoading] = useState(false);
  const [repoOptionsError, setRepoOptionsError] = useState("");

  useEffect(() => {
    prWatchGetConfig()
      .then(setPrWatch)
      .catch((e) => setPrWatchError(e instanceof Error ? e.message : String(e)));
  }, []);

  // Persist-on-change: every mutation writes the whole config back.
  const updatePrWatch = (patch: Partial<PrWatchConfig>) => {
    setPrWatch((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      prWatchSetConfig(next).catch((e) => setPrWatchError(e instanceof Error ? e.message : String(e)));
      return next;
    });
  };

  const addWatchRepo = () => {
    if (!prWatch) return;
    const slug = newWatchRepo.trim()
      .replace(/^https?:\/\/github\.com\//i, "")
      .replace(/\.git$/, "")
      .replace(/\/$/, "");
    if (!/^[\w.-]+\/[\w.-]+$/.test(slug)) {
      setPrWatchError(`"${newWatchRepo.trim()}" doesn't look like owner/repo`);
      return;
    }
    setPrWatchError("");
    setNewWatchRepo("");
    if (!prWatch.repos.includes(slug)) updatePrWatch({ repos: [...prWatch.repos, slug] });
  };

  const toggleWatchRepo = (slug: string) => {
    if (!prWatch) return;
    setPrWatchError("");
    updatePrWatch({
      repos: prWatch.repos.includes(slug)
        ? prWatch.repos.filter((x) => x !== slug)
        : [...prWatch.repos, slug],
    });
  };

  const loadRepoOptions = useCallback(() => {
    setRepoOptionsLoading(true);
    setRepoOptionsError("");
    githubListRepos()
      .then(setRepoOptions)
      .catch((e) => setRepoOptionsError(e instanceof Error ? e.message : String(e)))
      .finally(() => setRepoOptionsLoading(false));
  }, []);

  // Fetch lazily — the sweep is up to five API calls, so it waits until this
  // tab is actually on screen. Not retried after a failure; that's the Retry
  // button's job.
  useEffect(() => {
    if (!connected) return;
    if (repoOptions !== null || repoOptionsLoading || repoOptionsError) return;
    loadRepoOptions();
  }, [connected, repoOptions, repoOptionsLoading, repoOptionsError, loadRepoOptions]);

  // Filter on the same input that takes a manual slug: one box, and typing
  // narrows the list whether or not what you type is a whole repo name.
  const repoQuery = newWatchRepo.trim().toLowerCase();
  const matchingRepos = useMemo(() => {
    if (!repoOptions) return [];
    if (!repoQuery) return repoOptions;
    return repoOptions.filter(
      (r) =>
        r.full_name.toLowerCase().includes(repoQuery) ||
        (r.description ?? "").toLowerCase().includes(repoQuery),
    );
  }, [repoOptions, repoQuery]);

  // Rendering every repo of a heavy org account would put hundreds of rows in
  // a panel nobody scrolls to the bottom of; the count below the cut says so
  // rather than quietly ending the list.
  const REPO_ROW_CAP = 40;
  const shownRepos = matchingRepos.slice(0, REPO_ROW_CAP);
  const hiddenRepoCount = matchingRepos.length - shownRepos.length;

  // The manual-entry escape hatch only earns its space when the typed slug
  // isn't already on offer — a repo past the fetch cap, or a public one the
  // account has no membership in.
  const manualSlug = newWatchRepo.trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
  const showManualAdd =
    /^[\w.-]+\/[\w.-]+$/.test(manualSlug) &&
    !matchingRepos.some((r) => r.full_name.toLowerCase() === manualSlug.toLowerCase()) &&
    !(prWatch?.repos ?? []).includes(manualSlug);

  return (
    <div className="pr-watch-panel">
      <p className="settings-hint">
        Watched repos are polled for new pull requests beyond your open
        workspaces — every new PR is announced, optionally auto-reviewed by an
        agent, and can be queued to merge.
      </p>

      <div className="pr-watch-repos">
        {(prWatch?.repos ?? []).map((r) => (
          <div className="pr-watch-repo-row" key={r}>
            <span className="pr-watch-repo">{r}</span>
            <button
              className="pr-watch-remove"
              title={`Stop watching ${r}`}
              onClick={() => prWatch && updatePrWatch({ repos: prWatch.repos.filter((x) => x !== r) })}
            >
              ×
            </button>
          </div>
        ))}
        {prWatch && prWatch.repos.length === 0 && (
          <div className="settings-hint" style={{ margin: 0 }}>no watched repos yet</div>
        )}
      </div>

      <div className="pr-watch-add-row">
        <input
          className="modal-input"
          style={{ flex: 1, padding: "5px 8px", fontSize: 12, fontFamily: "var(--font-mono)" }}
          placeholder={connected ? "Search your repos, or type owner/repo" : "owner/repo"}
          value={newWatchRepo}
          disabled={!prWatch}
          onChange={(e) => setNewWatchRepo(e.target.value)}
          // Enter watches the top match — searching and then reaching for the
          // mouse to click the one row you filtered down to is the whole cost
          // the picker was meant to remove. It only ever adds; un-watching
          // stays a deliberate click.
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            const top = repoQuery ? shownRepos[0] : undefined;
            if (top && !(prWatch?.repos ?? []).includes(top.full_name)) {
              toggleWatchRepo(top.full_name);
              setNewWatchRepo("");
            } else if (showManualAdd) {
              addWatchRepo();
            }
          }}
        />
        {showManualAdd && (
          <button className="btn-ghost settings-btn" disabled={!prWatch} onClick={addWatchRepo}>
            Add
          </button>
        )}
      </div>

      {/* The picker proper: every repo the account can see, watched state as a
          checkbox, so a slug never has to be recalled. */}
      {connected && (
        <div className="pr-watch-picker">
          {repoOptionsLoading && (
            <div className="pr-watch-picker-note">loading your repos…</div>
          )}
          {repoOptionsError && (
            <div className="pr-watch-picker-note">
              <span className="pr-error-state">couldn’t list your repos: {repoOptionsError}</span>
              <button className="btn-ghost settings-btn" onClick={loadRepoOptions}>Retry</button>
            </div>
          )}
          {repoOptions !== null && !repoOptionsLoading && !repoOptionsError && (
            <>
              <div className="pr-watch-picker-list" role="group" aria-label="Repos available to watch">
                {shownRepos.map((r) => {
                  const on = (prWatch?.repos ?? []).includes(r.full_name);
                  return (
                    <button
                      key={r.full_name}
                      className={`pr-watch-option${on ? " on" : ""}`}
                      role="checkbox"
                      aria-checked={on}
                      disabled={!prWatch}
                      title={r.description ?? r.full_name}
                      onClick={() => toggleWatchRepo(r.full_name)}
                    >
                      <span className="pr-watch-option-check" aria-hidden="true">{on ? <CheckIcon size={10} /> : ""}</span>
                      <span className="pr-watch-option-name">{r.full_name}</span>
                      {r.private && <span className="pr-watch-option-tag">private</span>}
                      {r.fork && <span className="pr-watch-option-tag">fork</span>}
                    </button>
                  );
                })}
                {matchingRepos.length === 0 && (
                  <div className="pr-watch-picker-note">
                    {repoQuery ? "no repo matches — add it by slug above" : "no repos found for this account"}
                  </div>
                )}
              </div>
              {hiddenRepoCount > 0 && (
                <div className="pr-watch-picker-note">
                  {hiddenRepoCount} more — keep typing to narrow
                </div>
              )}
            </>
          )}
        </div>
      )}

      <div className="settings-row" style={{ marginTop: 14 }}>
        <div>
          <div className="settings-label" style={{ fontWeight: 600, color: "var(--text-hi)" }}>Auto-review new PRs</div>
          <div className="settings-hint" style={{ margin: 0 }}>
            Spawn a review agent (in its own worktree workspace) for each new PR.
          </div>
        </div>
        <button
          role="switch" aria-checked={!!prWatch?.auto_review} className={`voice-toggle${prWatch?.auto_review ? " on" : ""}`}
          disabled={!prWatch}
          onClick={() => prWatch && updatePrWatch({ auto_review: !prWatch.auto_review })}
          title={prWatch?.auto_review ? "Disable" : "Enable"}
        >
          <span className="voice-toggle-knob" />
        </button>
      </div>

      <div className="settings-row" style={{ marginTop: 6 }}>
        <span className="settings-label">Merge method</span>
        <select
          className="modal-input"
          style={{ padding: "4px 8px", fontSize: 12, maxWidth: 180 }}
          value={prWatch?.merge_method ?? "squash"}
          disabled={!prWatch}
          title="How the merge queue (and 'merge now') lands PRs"
          onChange={(e) => updatePrWatch({ merge_method: e.target.value as PrWatchConfig["merge_method"] })}
        >
          <option value="squash">squash</option>
          <option value="merge">merge</option>
          <option value="rebase">rebase</option>
        </select>
      </div>

      <div className="settings-row" style={{ marginTop: 6 }}>
        <div>
          <div className="settings-label" style={{ fontWeight: 600, color: "var(--text-hi)" }}>Update branch automatically</div>
          <div className="settings-hint" style={{ margin: 0 }}>
            When the queue head is merely behind its base, push an update
            commit to the PR branch instead of blocking.
          </div>
        </div>
        <button
          role="switch" aria-checked={!!prWatch?.auto_update_branch} className={`voice-toggle${prWatch?.auto_update_branch ? " on" : ""}`}
          disabled={!prWatch}
          onClick={() => prWatch && updatePrWatch({ auto_update_branch: !prWatch.auto_update_branch })}
          title={prWatch?.auto_update_branch ? "Disable" : "Enable"}
        >
          <span className="voice-toggle-knob" />
        </button>
      </div>

      {prWatchError && <div className="settings-error">{prWatchError}</div>}
    </div>
  );
}
