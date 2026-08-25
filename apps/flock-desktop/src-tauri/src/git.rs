// Read-only git overview for a workspace's repo — branch, working-tree
// status, and recent commits. Shells out to `git` (same approach as
// github.rs); everything here is read-only and safe to run on any path.

use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct GitFileChange {
    pub path: String,
    /// Friendly one-letter status: M, A, D, R, C, U (conflict), ? (untracked).
    pub status: String,
    /// True when the change is in the index (staged).
    pub staged: bool,
}

#[derive(Debug, Serialize)]
pub struct GitCommit {
    /// Full 40-char hash — used to wire up parent/child links in the graph.
    pub hash: String,
    pub short: String,
    /// Full hashes of this commit's parents (2+ means a merge).
    pub parents: Vec<String>,
    /// Branch/tag names pointing at this commit (e.g. "main", "origin/main").
    pub refs: Vec<String>,
    /// True when HEAD points here (the tip of the checked-out branch).
    pub is_head: bool,
    pub subject: String,
    pub author: String,
    pub date: String,
}

#[derive(Debug, Default, Serialize)]
pub struct GitOverview {
    pub is_repo: bool,
    pub branch: String,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub changes: Vec<GitFileChange>,
    pub commits: Vec<GitCommit>,
}

/// One checkout of the repo — the main working copy or a linked worktree —
/// with enough live status to render "which agent is on which branch".
#[derive(Debug, Serialize)]
pub struct WorktreeStatus {
    /// Absolute path of the checkout (matches a pane's cwd when an agent owns it).
    pub path: String,
    /// Branch checked out here; empty when HEAD is detached.
    pub branch: String,
    /// Short HEAD sha — the display fallback for detached checkouts.
    pub head: String,
    /// True for the repo's own working copy (first entry of `git worktree list`).
    pub is_main: bool,
    pub detached: bool,
    pub locked: bool,
    /// Directory is gone or otherwise stale — `git worktree prune` would drop it.
    pub prunable: bool,
    /// Count of changed files (staged + unstaged + untracked).
    pub dirty: u32,
    pub ahead: u32,
    pub behind: u32,
}

#[derive(Debug, Serialize)]
pub struct BranchInfo {
    pub name: String,
    /// Worktree where this branch is checked out, if anywhere — git allows a
    /// branch in at most one worktree, so this is what makes a branch
    /// unavailable to other agents.
    pub worktree_path: Option<String>,
}

/// Everything the UI needs to map agents to branches in one call: every
/// checkout of the repo plus every local branch and where it's held.
#[derive(Debug, Default, Serialize)]
pub struct RepoMap {
    pub is_repo: bool,
    pub worktrees: Vec<WorktreeStatus>,
    pub branches: Vec<BranchInfo>,
}

/// The refs a new workspace can branch from or check out. Deliberately lighter
/// than `RepoMap`: no per-worktree dirty/ahead/behind probes (those shell out
/// once per checkout), because this runs while a dialog is open rather than on
/// the background poll.
#[derive(Debug, Default, Serialize)]
pub struct BranchOptions {
    pub is_repo: bool,
    /// Branch checked out in the main working copy; empty when detached.
    pub current: String,
    /// The repo's default branch as a base ref ("origin/main"), falling back to
    /// a local name when there's no origin. Empty when neither can be found.
    pub default_ref: String,
    /// Local branches, each with the worktree holding it (if any).
    pub local: Vec<BranchInfo>,
    /// Remote-tracking branches ("origin/main"), minus the symbolic `*/HEAD`.
    pub remote: Vec<String>,
}

fn git(repo: &str, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8(out.stdout)
        .ok()
        .map(|s| s.trim_end().to_string())
}

/// A stable identity for the repo at `repo` — `(key, display_name)` — used to
/// anchor knowledge to its codebase in the knowledge graph. Prefers the origin
/// remote (stable across clones, branches, and worktrees of the same project);
/// falls back to the repo's top-level path when there is no remote. Returns
/// None outside a git repo, in which case knowledge just isn't repo-anchored.
pub fn repo_identity(repo: &str) -> Option<(String, String)> {
    if let Some(url) = git(repo, &["config", "--get", "remote.origin.url"]).filter(|u| !u.is_empty())
    {
        let trimmed = url.trim().trim_end_matches('/').trim_end_matches(".git");
        // Last path segment for the display name: owner/repo → repo, and the
        // SSH form git@host:owner/repo → repo too (split on both '/' and ':').
        let name = trimmed.rsplit(['/', ':']).next().unwrap_or(trimmed);
        return Some((trimmed.to_string(), name.to_string()));
    }
    let top = git(repo, &["rev-parse", "--show-toplevel"]).filter(|t| !t.is_empty())?;
    let name = std::path::Path::new(&top)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(&top);
    Some((format!("path:{top}"), name.to_string()))
}

/// Like `git`, but returns stdout even when git exits non-zero. Needed for
/// `git diff --no-index`, which exits 1 whenever the two inputs differ (i.e.
/// every time it produces the diff we actually want).
fn git_allow_fail(repo: &str, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .ok()?;
    String::from_utf8(out.stdout).ok()
}

/// Append each untracked file in `repo_path`, rendered against `/dev/null`, to
/// an already-built diff. `git diff` never reports files it hasn't been told
/// about, so without this a contender whose whole contribution is new files
/// shows an empty diff — which reads as "this agent did nothing" rather than
/// "git was asked the wrong question".
fn append_untracked(repo_path: &str, out: &mut String) {
    let Some(list) = git(repo_path, &["ls-files", "--others", "--exclude-standard"]) else {
        return;
    };
    for f in list.lines().filter(|l| !l.is_empty()) {
        if let Some(d) = git_allow_fail(repo_path, &["diff", "--no-index", "--", "/dev/null", f]) {
            let d = d.trim_end();
            if d.is_empty() {
                continue;
            }
            if !out.is_empty() && !out.ends_with('\n') {
                out.push('\n');
            }
            out.push_str(d);
            out.push('\n');
        }
    }
}

/// The full working-tree diff for a repo, as a single unified-diff string:
/// every uncommitted change to tracked files (staged and unstaged, vs HEAD)
/// plus each untracked file rendered against `/dev/null` so brand-new files
/// show their full contents. Empty string when the tree is clean or the path
/// isn't a git repo.
pub fn working_diff(repo_path: &str) -> String {
    let mut out = git(repo_path, &["diff", "HEAD"]).unwrap_or_default();
    append_untracked(repo_path, &mut out);
    out
}

/// The commit `repo_path`'s HEAD is on, full sha. A race pins its base here the
/// moment it starts: naming a *branch* as the base would move under the
/// comparison the first time anything lands on the main checkout, and every
/// contender's diff would silently change meaning while the user was reading it.
pub fn head_sha(repo_path: &str) -> Option<String> {
    git(repo_path, &["rev-parse", "HEAD"]).filter(|s| !s.is_empty())
}

/// Everything the checkout at `work_path` has done since `base`, as one
/// unified-diff string: committed, staged, unstaged and untracked alike.
///
/// That breadth is the point. An agent that committed its work and an agent
/// that left it in the working tree have both done the same amount, and a
/// comparison that only counted one of them would rank the contenders on when
/// they happened to run `git commit`.
///
/// `base` is verified to resolve *before* the diff is taken. `git diff` against
/// an unknown ref exits non-zero with no stdout, which `git()` turns into
/// `None` and this would otherwise report as "no changes" — one bad base ref
/// would make every contender in the race look empty, with nothing raised.
pub fn diff_against(work_path: &str, base: &str) -> Result<String, String> {
    let base = base.trim();
    if base.is_empty() || base.starts_with('-') || base.contains('\0') {
        return Err(format!("invalid base ref: '{base}'"));
    }
    let verify = format!("{base}^{{commit}}");
    if git(work_path, &["rev-parse", "--verify", "--quiet", &verify]).is_none() {
        return Err(format!("base ref '{base}' doesn't resolve to a commit here"));
    }

    // `--` terminates the revision list: without it a base that shares a name
    // with a path in the tree is ambiguous and git refuses outright.
    let mut out = git(work_path, &["diff", base, "--"]).unwrap_or_default();
    append_untracked(work_path, &mut out);
    Ok(out)
}

/// Commit everything in the checkout at `work_path` onto whatever branch it
/// has out, and report whether there was anything to commit.
///
/// Two callers, one reason: an agent's work is normally still in its working
/// tree when you want to do something with it. Merging that branch would merge
/// a tip that predates the work; removing that worktree is refused outright by
/// `git worktree remove` (it won't discard uncommitted changes, and rightly).
/// Committing first turns both into ordinary operations, and leaves the work
/// recoverable on the branch either way.
pub fn commit_all(work_path: &str, message: &str) -> Result<bool, String> {
    if message.contains('\0') {
        return Err("invalid commit message".to_string());
    }
    let dirty = git(work_path, &["status", "--porcelain", "-uall"]).unwrap_or_default();
    if dirty.trim().is_empty() {
        return Ok(false);
    }
    let add = std::process::Command::new("git")
        .args(["-C", work_path, "add", "-A"])
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;
    if !add.status.success() {
        return Err(first_error_line(&add.stderr, "git add failed"));
    }
    let commit = std::process::Command::new("git")
        .args(["-C", work_path, "commit", "-m", message])
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;
    if !commit.status.success() {
        // Almost always a missing `user.email`/`user.name`, which the user can
        // only fix if they are told which one it was.
        return Err(first_error_line(&commit.stderr, "git commit failed"));
    }
    Ok(true)
}

/// What `merge_branch` did. A conflict is a reported outcome rather than an
/// `Err` because the UI has something useful to say about it — which files —
/// and an error string only carries one line.
#[derive(Debug, Serialize)]
pub struct MergeReport {
    /// The contender's worktree had uncommitted work, which was committed onto
    /// its branch before merging.
    pub committed: bool,
    pub merged: bool,
    /// Paths that conflicted. Non-empty only when `merged` is false, and the
    /// merge has been aborted by then — the checkout is back where it started.
    pub conflicts: Vec<String>,
    /// git's own one-line reason when `merged` is false.
    pub message: String,
}

/// Merge `branch` into whatever `repo_path` currently has checked out — "merge
/// the winner" of a race.
///
/// When `worktree_path` is given, any uncommitted work there is committed onto
/// `branch` first. That is not a convenience: agents routinely end a turn with
/// everything still in the working tree, and merging a branch whose tip
/// predates the work would merge *nothing* while reporting success. `message`
/// labels both that commit and the merge commit, so the caller should phrase it
/// to read as either.
///
/// Always `--no-ff`. A fast-forward would leave no record that a merge
/// happened, and the losers' "commits that exist nowhere else" count — the one
/// thing standing between the user and permanently deleted work — is computed
/// against the refs this merge creates.
pub fn merge_branch(
    repo_path: &str,
    worktree_path: Option<&str>,
    branch: &str,
    message: &str,
) -> Result<MergeReport, String> {
    let branch = branch.trim();
    if !valid_branch_name(repo_path, branch) {
        return Err(format!("invalid branch name: '{branch}'"));
    }
    // Reaches a `-m` argument. A leading dash is safe there (it's consumed as
    // the option's value); a NUL is not.
    if message.contains('\0') {
        return Err("invalid commit message".to_string());
    }
    let message = if message.trim().is_empty() {
        format!("Merge branch '{branch}'")
    } else {
        message.to_string()
    };

    // Merging a branch into itself is a no-op git reports as "Already up to
    // date", which in the UI would read as a successful merge that changed
    // nothing. Say what actually happened instead.
    if current_branch(repo_path).as_deref() == Some(branch) {
        return Err(format!(
            "'{branch}' is the branch checked out here — nothing to merge into"
        ));
    }

    let mut committed = false;
    if let Some(wt) = worktree_path.filter(|p| !p.trim().is_empty()) {
        // Only commit into a checkout that is still on this branch. The user
        // (or the agent) can have switched it since the race started, and
        // `add -A && commit` there would put the contender's work on an
        // unrelated branch and then merge the untouched original.
        let on = current_branch(wt).unwrap_or_default();
        if on != branch {
            return Err(format!(
                "{wt} is on '{on}', not '{branch}' — put it back on its branch before merging"
            ));
        }
        committed = commit_all(wt, &message)?;
    }

    let out = std::process::Command::new("git")
        .args(["-C", repo_path, "merge", "--no-ff", "-m", &message, branch])
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;
    if out.status.success() {
        return Ok(MergeReport {
            committed,
            merged: true,
            conflicts: Vec::new(),
            message: String::new(),
        });
    }

    // Name the conflicted paths before undoing the merge — after `--abort` the
    // index is clean and there is nothing left to read them from.
    let conflicts: Vec<String> = git(repo_path, &["diff", "--name-only", "--diff-filter=U"])
        .unwrap_or_default()
        .lines()
        .filter(|l| !l.is_empty())
        .map(|s| s.to_string())
        .collect();
    // Aborting, rather than leaving conflict markers in the user's own
    // checkout: this runs behind a one-click "merge the winner", and a button
    // that can leave the main working copy mid-merge is not one you can press
    // without reading the source first. Fails harmlessly when no merge ever
    // started (git refused up front because local changes were in the way).
    let _ = std::process::Command::new("git")
        .args(["-C", repo_path, "merge", "--abort"])
        .output();

    // git writes the interesting part of a failed merge to stdout ("CONFLICT
    // (content): …", "Your local changes … would be overwritten") and only
    // sometimes to stderr, so fall back across both.
    let mut reason = first_error_line(&out.stderr, "");
    if reason.is_empty() {
        reason = first_error_line(&out.stdout, "git merge failed");
    }
    Ok(MergeReport { committed, merged: false, conflicts, message: reason })
}

/// git's own explanation for a failed command: the `fatal:`/`error:`/`CONFLICT`
/// line when there is one, otherwise the last thing it said. Deliberately not
/// the *first* line — git leads with progress chatter that explains nothing.
fn first_error_line(bytes: &[u8], fallback: &str) -> String {
    let text = String::from_utf8_lossy(bytes);
    let lines: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    lines
        .iter()
        .find(|l| l.starts_with("fatal:") || l.starts_with("error:") || l.starts_with("CONFLICT"))
        .or_else(|| lines.last())
        .copied()
        .unwrap_or(fallback)
        .trim_start_matches("fatal: ")
        .trim_start_matches("error: ")
        .to_string()
}

/// The repo's current branch as it is *right now* (not the stale value stored
/// at workspace-creation time). Falls back to `detached@<short-sha>` when HEAD
/// isn't on a branch, and `None` when the path isn't a git repo.
pub fn current_branch(repo_path: &str) -> Option<String> {
    let b = git(repo_path, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    if b == "HEAD" {
        git(repo_path, &["rev-parse", "--short", "HEAD"]).map(|s| format!("detached@{s}"))
    } else {
        Some(b)
    }
}

pub fn overview(repo_path: &str) -> GitOverview {
    let is_repo = git(repo_path, &["rev-parse", "--is-inside-work-tree"]).as_deref() == Some("true");
    if !is_repo {
        return GitOverview::default();
    }

    // current_branch (not bare rev-parse) so detached HEAD reads
    // "detached@<sha>" instead of a literal "HEAD" badge in the panel.
    let branch = current_branch(repo_path).unwrap_or_default();
    let upstream = git(
        repo_path,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    );

    // `--left-right --count @{u}...HEAD` prints "<behind>\t<ahead>": left side
    // (@{u}) is commits you're missing, right side (HEAD) is commits you're
    // ahead by. Absent an upstream, git errors → treated as 0/0.
    let (behind, ahead) = git(repo_path, &["rev-list", "--left-right", "--count", "@{u}...HEAD"])
        .map(|s| {
            let mut it = s.split_whitespace();
            let b = it.next().and_then(|x| x.parse().ok()).unwrap_or(0);
            let a = it.next().and_then(|x| x.parse().ok()).unwrap_or(0);
            (b, a)
        })
        .unwrap_or((0, 0));

    let changes = git(repo_path, &["status", "--porcelain=v1", "-uall"])
        .map(|s| parse_status(&s))
        .unwrap_or_default();

    // Unit-separator (\x1f) between fields so subjects with any punctuation
    // parse cleanly. %H full hash, %P space-separated parent hashes (for the
    // commit graph), %D ref names (branch/tag decorations), %cr = committer
    // date, relative ("3 hours ago").
    let commits = git(
        repo_path,
        &["log", "-n", "120", "--pretty=format:%H%x1f%h%x1f%P%x1f%D%x1f%s%x1f%an%x1f%cr"],
    )
    .map(|s| parse_log(&s))
    .unwrap_or_default();

    GitOverview {
        is_repo: true,
        branch,
        upstream,
        ahead,
        behind,
        changes,
        commits,
    }
}

fn parse_status(out: &str) -> Vec<GitFileChange> {
    out.lines()
        .filter(|l| l.len() >= 3)
        .map(|line| {
            let x = line.as_bytes()[0] as char; // index (staged) status
            let y = line.as_bytes()[1] as char; // worktree status
            let untracked = x == '?';
            let staged = !untracked && x != ' ';
            // Prefer the staged code, else the worktree code.
            let code = if staged { x } else { y };
            let raw = &line[3..];
            // Renames/copies print "old -> new"; keep just the new path so the
            // UI doesn't treat the whole arrow string as a filename.
            let path = if matches!(code, 'R' | 'C') {
                raw.rsplit(" -> ").next().unwrap_or(raw).to_string()
            } else {
                raw.to_string()
            };
            let status = match code {
                '?' => "?",
                'M' => "M",
                'A' => "A",
                'D' => "D",
                'R' => "R",
                'C' => "C",
                'U' => "U",
                _ => "M",
            }
            .to_string();
            GitFileChange { path, status, staged }
        })
        .collect()
}

// Parses git's `%D` decoration (e.g. "HEAD -> main, origin/main, tag: v1")
// into a list of ref names plus whether HEAD points here. "HEAD -> " and
// "tag: " prefixes are stripped; bare "HEAD" (detached) and noise like
// "grafted" are dropped. "origin/HEAD" (an alias for the remote's default
// branch) and "origin/<branch>" pills that duplicate an already-shown local
// "<branch>" are dropped too — the ahead/behind counters already convey
// local/remote sync, so a second pill saying the same thing is just clutter.
fn parse_refs(deco: &str) -> (Vec<String>, bool) {
    let mut refs = Vec::new();
    let mut is_head = false;
    for part in deco.split(',') {
        let p = part.trim();
        if p.is_empty() {
            continue;
        }
        if let Some(rest) = p.strip_prefix("HEAD -> ") {
            is_head = true;
            refs.push(rest.to_string());
        } else if p == "HEAD" {
            is_head = true;
        } else if p == "origin/HEAD" {
            continue; // alias for the remote's default branch tip; not useful per-commit
        } else if let Some(tag) = p.strip_prefix("tag: ") {
            refs.push(tag.to_string());
        } else if p == "grafted" {
            continue;
        } else {
            refs.push(p.to_string());
        }
    }

    let locals: std::collections::HashSet<String> = refs
        .iter()
        .filter(|r| !r.starts_with("origin/"))
        .cloned()
        .collect();
    refs.retain(|r| match r.strip_prefix("origin/") {
        Some(local) => !locals.contains(local),
        None => true,
    });

    (refs, is_head)
}

/// Snapshot every checkout of the repo (main working copy + linked worktrees)
/// and every local branch, in one call — the data behind "which agent is on
/// which branch". Dirty/ahead/behind run per live worktree; prunable ones
/// (directory deleted out from under git) are listed but not probed.
pub fn repo_map(repo_path: &str) -> RepoMap {
    let is_repo = git(repo_path, &["rev-parse", "--is-inside-work-tree"]).as_deref() == Some("true");
    if !is_repo {
        return RepoMap::default();
    }

    let mut worktrees = git(repo_path, &["worktree", "list", "--porcelain"])
        .map(|s| parse_worktree_list(&s))
        .unwrap_or_default();

    for wt in &mut worktrees {
        if wt.prunable {
            continue;
        }
        wt.dirty = git(&wt.path, &["status", "--porcelain=v1", "-uall"])
            .map(|s| s.lines().filter(|l| !l.is_empty()).count() as u32)
            .unwrap_or(0);
        // Same "<behind>\t<ahead>" parse as overview(); no upstream → 0/0.
        if let Some(s) = git(&wt.path, &["rev-list", "--left-right", "--count", "@{u}...HEAD"]) {
            let mut it = s.split_whitespace();
            wt.behind = it.next().and_then(|x| x.parse().ok()).unwrap_or(0);
            wt.ahead = it.next().and_then(|x| x.parse().ok()).unwrap_or(0);
        }
    }

    RepoMap { is_repo: true, worktrees, branches: local_branches(repo_path) }
}

/// Every local branch with the worktree holding it, if any.
///
/// `%(worktreepath)` is empty for branches not checked out anywhere. Unit
/// separator between fields, same trick as the log format above.
fn local_branches(repo_path: &str) -> Vec<BranchInfo> {
    git(
        repo_path,
        &["for-each-ref", "refs/heads", "--format=%(refname:short)\u{1f}%(worktreepath)"],
    )
    .map(|out| {
        out.lines()
            .filter_map(|line| {
                let mut parts = line.split('\u{1f}');
                let name = parts.next()?.to_string();
                if name.is_empty() {
                    return None;
                }
                let wt = parts.next().unwrap_or("").to_string();
                // Existing directory only. git keeps reporting `%(worktreepath)`
                // for a worktree whose directory is gone — a killed session, a
                // deleted checkout, a moved data directory — and every picker
                // reads this field as "occupied, choose something else". Left
                // alone, one dead worktree locks its branch out of the app
                // permanently, with nothing on screen saying why or how to undo
                // it. `git worktree list` calls these prunable; they hold
                // nothing, so neither should we.
                let live = !wt.is_empty() && std::path::Path::new(&wt).exists();
                Some(BranchInfo {
                    name,
                    worktree_path: if live { Some(wt) } else { None },
                })
            })
            .collect()
    })
    .unwrap_or_default()
}

/// Local + remote-tracking refs for the "branch from what?" pickers in the new
/// workspace dialog, plus the repo's default branch to preselect.
pub fn branch_options(repo_path: &str) -> BranchOptions {
    let is_repo = git(repo_path, &["rev-parse", "--is-inside-work-tree"]).as_deref() == Some("true");
    if !is_repo {
        return BranchOptions::default();
    }

    let current = git(repo_path, &["rev-parse", "--abbrev-ref", "HEAD"])
        .filter(|b| b != "HEAD")
        .unwrap_or_default();

    // `origin/HEAD` is a symbolic ref, not a branch anyone can base work on —
    // it's the *answer* to "what's the default branch", so read it separately
    // and drop every `*/HEAD` from the pickable list. Filter on the FULL
    // refname: `%(refname:short)` renders `refs/remotes/origin/HEAD` as plain
    // `origin`, which no `/HEAD` suffix test would catch.
    let remote: Vec<String> = git(repo_path, &["for-each-ref", "refs/remotes", "--format=%(refname)"])
        .map(|out| {
            out.lines()
                .filter(|r| !r.ends_with("/HEAD"))
                .filter_map(|r| r.strip_prefix("refs/remotes/"))
                .filter(|n| !n.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();

    let local = local_branches(repo_path);

    // Preference order for the base ref we preselect: the remote's declared
    // default, then the conventional names, then whatever is checked out. A
    // remote ref wins over a local one of the same name — branching from
    // `origin/main` is what people mean by "start from main", and it's what
    // makes the fetch toggle meaningful.
    let default_ref = git(repo_path, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
        .filter(|r| !r.is_empty())
        .or_else(|| {
            ["origin/main", "origin/master"]
                .iter()
                .find(|c| remote.iter().any(|r| r == *c))
                .map(|c| c.to_string())
        })
        .or_else(|| {
            ["main", "master"]
                .iter()
                .find(|c| local.iter().any(|b| b.name == **c))
                .map(|c| c.to_string())
        })
        .unwrap_or_else(|| current.clone());

    BranchOptions { is_repo: true, current, default_ref, local, remote }
}

/// Run `git` with a wall-clock ceiling, killing the child if it overruns.
/// `std::process::Command` has no timeout and network git can block for
/// minutes; every caller here sits behind a modal, so a hang is a wedged app.
fn git_with_timeout(repo: &str, args: &[&str], secs: u64) -> Result<std::process::Output, String> {
    let mut child = std::process::Command::new("git")
        .arg("-C")
        .arg(repo)
        // Fail fast instead of blocking on a credential prompt with no tty to
        // answer it: no terminal prompt, no askpass helper, no SSH interaction.
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "true")
        .env("SSH_ASKPASS", "true")
        .env("GIT_SSH_COMMAND", "ssh -oBatchMode=yes")
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to run git: {e}"))?;

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(secs);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("git took longer than {secs}s"));
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(e) => return Err(format!("failed to run git: {e}")),
        }
    }
    child.wait_with_output().map_err(|e| format!("failed to run git: {e}"))
}

/// Bring a base ref up to date before branching from it, so a new workspace
/// doesn't start on a week-old `origin/main`.
///
/// Only remote-tracking refs are fetchable: `base_ref` must be
/// `<remote>/<branch>` for a remote this repo actually has. A local ref is
/// already current by definition, so that's a silent no-op rather than an
/// error — the caller passes whatever the user picked.
pub fn fetch_base(repo_path: &str, base_ref: &str) -> Result<(), String> {
    let base_ref = base_ref.trim();
    if base_ref.is_empty() || base_ref.starts_with('-') || base_ref.contains('\0') {
        return Ok(());
    }
    let Some((remote, branch)) = base_ref.split_once('/') else {
        return Ok(());
    };
    if branch.is_empty() {
        return Ok(());
    }
    let remotes = git(repo_path, &["remote"]).unwrap_or_default();
    if !remotes.lines().any(|r| r == remote) {
        return Ok(());
    }

    // Explicit refspec so the remote-tracking ref is what gets updated (a bare
    // `git fetch <remote> <branch>` writes FETCH_HEAD but leaves
    // `refs/remotes/<remote>/<branch>` untouched on older git).
    let refspec = format!("refs/heads/{branch}:refs/remotes/{remote}/{branch}");
    let out = git_with_timeout(repo_path, &["fetch", remote, &refspec], 30)?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let reason = err
            .lines()
            .map(str::trim)
            .find(|l| !l.is_empty())
            .unwrap_or("git fetch failed");
        return Err(reason.trim_start_matches("fatal: ").to_string());
    }
    Ok(())
}

/// True when `name` is a valid branch name git would accept.
pub fn valid_branch_name(repo_path: &str, name: &str) -> bool {
    let name = name.trim();
    // `check-ref-format --branch` resolves shorthands like `@{-1}` and `-`
    // into a real branch name rather than rejecting them, so screen those out
    // first. `@{` is the only `@` form that's a shorthand; a bare `@` means
    // HEAD. Everything else `@` is legal in a branch name.
    if name.is_empty()
        || name.starts_with('-')
        || name == "HEAD"
        || name == "@"
        || name.contains('\0')
        || name.contains("@{")
    {
        return false;
    }
    git(repo_path, &["check-ref-format", "--branch", name]).is_some()
}

// `git worktree list --porcelain` prints one attribute-per-line block per
// worktree, blocks separated by a blank line; the first block is always the
// main working copy:
//   worktree /abs/path
//   HEAD <sha>
//   branch refs/heads/name     (or `detached` on its own line)
//   locked [reason] / prunable [reason]
fn parse_worktree_list(out: &str) -> Vec<WorktreeStatus> {
    let mut result = Vec::new();
    for block in out.split("\n\n") {
        let mut path = String::new();
        let mut head = String::new();
        let mut branch = String::new();
        let mut detached = false;
        let mut locked = false;
        let mut prunable = false;
        for line in block.lines() {
            if let Some(p) = line.strip_prefix("worktree ") {
                path = p.to_string();
            } else if let Some(h) = line.strip_prefix("HEAD ") {
                head = h.chars().take(8).collect();
            } else if let Some(b) = line.strip_prefix("branch ") {
                branch = b.strip_prefix("refs/heads/").unwrap_or(b).to_string();
            } else if line == "detached" {
                detached = true;
            } else if line == "locked" || line.starts_with("locked ") {
                locked = true;
            } else if line == "prunable" || line.starts_with("prunable ") {
                prunable = true;
            }
        }
        if path.is_empty() {
            continue;
        }
        result.push(WorktreeStatus {
            path,
            branch,
            head,
            is_main: result.is_empty(),
            detached,
            locked,
            prunable,
            dirty: 0,
            ahead: 0,
            behind: 0,
        });
    }
    result
}

/// Commits on `branch` unreachable from every other ref (other branches and
/// remotes) — the work that would be permanently lost if the branch were
/// deleted. Drives the keep/delete prompt when closing a pane. 0 when the
/// branch doesn't exist or the count can't be computed.
pub fn branch_unmerged_count(repo_path: &str, branch: &str) -> u32 {
    if branch.is_empty() || branch.starts_with('-') || branch.contains('\0') {
        return 0;
    }
    // NOT --all: it includes every worktree's HEAD, and the branch being
    // tested is checked out in the very worktree being torn down — its own
    // HEAD would make every commit "reachable elsewhere" and the count 0.
    // --branches/--remotes/--tags cover real refs only; --exclude patterns
    // match short names (refs/heads/-prefixed patterns match nothing here)
    // and reset after --branches, so remotes/tags stay unfiltered — a commit
    // that's pushed or tagged is not lost by deleting the local branch.
    let refname = format!("refs/heads/{branch}");
    let exclude = format!("--exclude={branch}");
    git(
        repo_path,
        &["rev-list", "--count", &refname, "--not", &exclude, "--branches", "--remotes", "--tags"],
    )
    .and_then(|s| s.trim().parse().ok())
    .unwrap_or(0)
}

fn parse_log(out: &str) -> Vec<GitCommit> {
    out.lines()
        .filter_map(|line| {
            let mut parts = line.split('\u{1f}');
            let hash = parts.next()?.to_string();
            let short = parts.next().unwrap_or("").to_string();
            let parents = parts
                .next()
                .unwrap_or("")
                .split_whitespace()
                .map(|s| s.to_string())
                .collect();
            let (refs, is_head) = parse_refs(parts.next().unwrap_or(""));
            Some(GitCommit {
                hash,
                short,
                parents,
                refs,
                is_head,
                subject: parts.next().unwrap_or("").to_string(),
                author: parts.next().unwrap_or("").to_string(),
                date: parts.next().unwrap_or("").to_string(),
            })
        })
        .collect()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[test]
    fn parse_status_rename_keeps_new_path() {
        let out = "R  old/name.rs -> new/name.rs\n M plain.rs\n?? untracked.txt";
        let changes = parse_status(out);
        assert_eq!(changes[0].path, "new/name.rs");
        assert_eq!(changes[0].status, "R");
        assert!(changes[0].staged);
        assert_eq!(changes[1].path, "plain.rs");
        assert_eq!(changes[1].status, "M");
        assert!(!changes[1].staged);
        assert_eq!(changes[2].path, "untracked.txt");
        assert_eq!(changes[2].status, "?");
    }

    /// Scratch repo with a commit on `main` and a `feature` branch, plus an
    /// `origin` remote pointing at itself so remote-tracking refs exist.
    pub(crate) fn scratch_repo(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("flock-git-{tag}-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.to_str().unwrap();
        for args in [
            vec!["init", "-b", "main"],
            vec!["config", "user.email", "t@example.com"],
            vec!["config", "user.name", "T"],
        ] {
            git(p, &args).unwrap();
        }
        std::fs::write(dir.join("README.md"), "hi").unwrap();
        git(p, &["add", "."]).unwrap();
        git(p, &["commit", "-m", "init"]).unwrap();
        git(p, &["branch", "feature"]).unwrap();
        // A remote that is this same repo: fetching then materializes
        // refs/remotes/origin/*, which is what the base-ref picker lists.
        git(p, &["remote", "add", "origin", p]).unwrap();
        git(p, &["fetch", "origin"]).unwrap();
        git(p, &["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]).unwrap();
        dir
    }

    #[test]
    fn branch_options_lists_refs_and_finds_the_default() {
        let dir = scratch_repo("opts");
        let opts = branch_options(dir.to_str().unwrap());

        assert!(opts.is_repo);
        assert_eq!(opts.current, "main");
        assert_eq!(opts.default_ref, "origin/main");

        let local: Vec<&str> = opts.local.iter().map(|b| b.name.as_str()).collect();
        assert!(local.contains(&"main") && local.contains(&"feature"));
        // The main checkout holds `main`, so it's unavailable to a new agent.
        let main = opts.local.iter().find(|b| b.name == "main").unwrap();
        assert!(main.worktree_path.is_some());
        assert!(opts.local.iter().find(|b| b.name == "feature").unwrap().worktree_path.is_none());

        assert!(opts.remote.contains(&"origin/main".to_string()));
        // `refs/remotes/origin/HEAD` shortens to a bare "origin" — it's not a
        // branch and must never appear as something to branch from.
        assert!(!opts.remote.iter().any(|r| r == "origin" || r.ends_with("/HEAD")));

        std::fs::remove_dir_all(&dir).ok();
    }

    /// A worktree directory that no longer exists must not keep holding its
    /// branch. git goes on reporting `%(worktreepath)` for one until somebody
    /// prunes it, which used to leave the branch permanently unpickable in the
    /// new-workspace dialog: the agent was long gone, the checkout was long
    /// gone, and the only symptom was a greyed-out row with no way back.
    #[test]
    fn a_deleted_worktree_releases_its_branch() {
        let dir = scratch_repo("prunable");
        let p = dir.to_str().unwrap();
        let wt = dir.join("wt-feature");
        git(p, &["worktree", "add", wt.to_str().unwrap(), "feature"]).unwrap();

        let held = branch_options(p);
        let feature = held.local.iter().find(|b| b.name == "feature").unwrap();
        assert!(feature.worktree_path.is_some(), "a live worktree holds its branch");

        // Exactly what a force-quit, a manual `rm -rf`, or a moved data
        // directory leaves behind: registration intact, directory gone.
        std::fs::remove_dir_all(&wt).unwrap();

        let freed = branch_options(p);
        let feature = freed.local.iter().find(|b| b.name == "feature").unwrap();
        assert!(
            feature.worktree_path.is_none(),
            "a worktree whose directory is gone must release its branch"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn branch_options_is_empty_outside_a_repo() {
        let dir = std::env::temp_dir().join(format!("flock-git-norepo-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!branch_options(dir.to_str().unwrap()).is_repo);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn valid_branch_name_screens_git_shorthands() {
        let dir = scratch_repo("valid");
        let p = dir.to_str().unwrap();
        for good in ["refactor-auth", "feat/login-v2", "release-1.2"] {
            assert!(valid_branch_name(p, good), "{good} should be valid");
        }
        // `-`, `@{-1}` and `HEAD` all *resolve* under `check-ref-format
        // --branch` instead of being rejected, so they're screened separately.
        for bad in ["", "  ", "-", "@", "HEAD", "@{-1}", "a..b", "has space", "a~1"] {
            assert!(!valid_branch_name(p, bad), "{bad:?} should be invalid");
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The race comparison stands on `diff_against` telling the truth about a
    /// contender that never committed and about one that only added files.
    /// Both were silent-empty before this existed, and an empty diff in the
    /// compare view is indistinguishable from an agent that did nothing.
    #[test]
    fn diff_against_sees_committed_uncommitted_and_untracked_work() {
        let repo = scratch_repo("diffbase");
        let p = repo.to_str().unwrap();
        let base = head_sha(p).unwrap();
        assert_eq!(base.len(), 40, "head_sha returns a full sha");

        let wt = repo.join("wt-contender");
        let w = wt.to_str().unwrap();
        git(p, &["worktree", "add", "-b", "contender", w, &base]).unwrap();

        // Committed work.
        std::fs::write(wt.join("README.md"), "hi\ncommitted\n").unwrap();
        git(w, &["add", "."]).unwrap();
        git(w, &["commit", "-m", "c"]).unwrap();
        // Uncommitted work on a tracked file.
        std::fs::write(wt.join("README.md"), "hi\ncommitted\ndirty\n").unwrap();
        // A brand-new file the agent never added.
        std::fs::write(wt.join("new.txt"), "fresh\n").unwrap();

        let diff = diff_against(w, &base).unwrap();
        assert!(diff.contains("committed"), "committed work missing:\n{diff}");
        assert!(diff.contains("dirty"), "uncommitted work missing:\n{diff}");
        assert!(diff.contains("new.txt"), "untracked file missing:\n{diff}");

        // A base that doesn't resolve must say so rather than return "".
        assert!(diff_against(w, "nope-not-a-ref").is_err());
        assert!(diff_against(w, "").is_err());
        assert!(diff_against(w, "--output=/tmp/pwned").is_err());

        std::fs::remove_dir_all(&repo).ok();
    }

    /// Merging the winner has to work for the common case — an agent that left
    /// everything uncommitted — and has to leave the user's checkout untouched
    /// when it can't.
    #[test]
    fn merge_branch_commits_the_worktree_first_and_aborts_on_conflict() {
        let repo = scratch_repo("merge");
        let p = repo.to_str().unwrap();
        let base = head_sha(p).unwrap();

        let wt = repo.join("wt-a");
        let w = wt.to_str().unwrap();
        git(p, &["worktree", "add", "-b", "cand-a", w, &base]).unwrap();
        // Nothing committed on the branch at all: the whole contribution is
        // sitting in the working tree, exactly as an agent leaves it.
        std::fs::write(wt.join("a.txt"), "from a\n").unwrap();

        let report = merge_branch(p, Some(w), "cand-a", "take a").unwrap();
        assert!(report.committed, "uncommitted work must be committed first");
        assert!(report.merged, "merge failed: {}", report.message);
        assert!(repo.join("a.txt").exists(), "merged work must land in the checkout");
        // --no-ff, so the merge is a commit of its own with two parents.
        let parents = git(p, &["rev-list", "--parents", "-n", "1", "HEAD"]).unwrap();
        assert_eq!(parents.split_whitespace().count(), 3, "expected a merge commit");

        // A second contender that touched the same file conflicts. The user's
        // checkout must come back clean, not mid-merge.
        let wt2 = repo.join("wt-b");
        let w2 = wt2.to_str().unwrap();
        git(p, &["worktree", "add", "-b", "cand-b", w2, &base]).unwrap();
        std::fs::write(wt2.join("a.txt"), "from b\n").unwrap();
        let report = merge_branch(p, Some(w2), "cand-b", "take b").unwrap();
        assert!(!report.merged);
        assert_eq!(report.conflicts, vec!["a.txt".to_string()]);
        // Aborted, not left mid-merge: no MERGE_HEAD, no unmerged index
        // entries, and the winner's content still in place. (Not a bare
        // `status --porcelain` check — this scratch repo keeps its linked
        // worktrees inside itself, so they always show as untracked.)
        assert!(
            git(p, &["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]).is_none(),
            "a failed merge must not leave the checkout mid-merge"
        );
        assert!(git(p, &["diff", "--name-only", "--diff-filter=U"]).unwrap().trim().is_empty());
        assert_eq!(std::fs::read_to_string(repo.join("a.txt")).unwrap(), "from a\n");

        // Merging the checked-out branch into itself is refused by name, not
        // reported as a merge that changed nothing.
        assert!(merge_branch(p, None, "main", "x").is_err());
        assert!(merge_branch(p, None, "-oops", "x").is_err());

        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn fetch_base_ignores_refs_it_cannot_fetch() {
        let dir = scratch_repo("fetch");
        let p = dir.to_str().unwrap();
        // Local ref, no remote in the name: nothing to do, not an error.
        assert!(fetch_base(p, "main").is_ok());
        // Unknown remote: skipped rather than shelling out to a doomed fetch.
        assert!(fetch_base(p, "nosuchremote/main").is_ok());
        assert!(fetch_base(p, "").is_ok());
        // Real remote (this repo) — actually fetches.
        assert!(fetch_base(p, "origin/main").is_ok());
        std::fs::remove_dir_all(&dir).ok();
    }
}
