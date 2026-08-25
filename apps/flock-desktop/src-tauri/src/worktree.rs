use std::path::{Path, PathBuf};

fn home_dir() -> PathBuf {
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/tmp"))
}

/// Directory-safe version of a branch name (git worktree paths can't contain
/// most of the punctuation valid in a branch name, e.g. "/").
fn sanitize(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect()
}

/// The worktree currently holding `branch`, if one exists on disk.
///
/// Existence is the point: git keeps reporting `%(worktreepath)` for a
/// worktree whose directory has been deleted, and treating one of those as
/// "occupied" is what used to lock a branch out of the app for good. Same rule
/// as `git::local_branches`.
fn live_worktree_for(repo_path: &str, branch: &str) -> Option<String> {
    let out = std::process::Command::new("git")
        .args([
            "-C",
            repo_path,
            "for-each-ref",
            "--format=%(refname:short)\u{1f}%(worktreepath)",
            "refs/heads",
        ])
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| l.split_once('\u{1f}'))
        .find(|(name, path)| *name == branch && !path.is_empty() && Path::new(path).exists())
        .map(|(_, path)| path.to_string())
}

/// Create a git worktree for `repo_path`. Worktrees live under `base_dir`
/// (defaults to `~/.flock/worktrees/` when `None`), keeping them out of the
/// repo itself so they don't show up as untracked clutter in `git status`.
///
/// With `existing` set, `branch` is checked out as-is; otherwise it's created
/// from `base_ref` (or the repo's current HEAD when `base_ref` is `None`).
/// Branching from a remote-tracking ref like `origin/main` also sets the new
/// branch's upstream, so `git push` works with no extra arguments.
///
/// Returns the absolute path to the worktree: a new one, or the existing one
/// when `existing` names a branch another live worktree already holds.
pub fn create_worktree(
    repo_path: &str,
    branch: &str,
    base_dir: Option<&str>,
    base_ref: Option<&str>,
    existing: bool,
) -> Result<String, String> {
    let branch = branch.trim();
    if !crate::git::valid_branch_name(repo_path, branch) {
        return Err(format!("invalid branch name: '{branch}'"));
    }
    let base_ref = base_ref.map(str::trim).filter(|b| !b.is_empty());
    if let Some(b) = base_ref {
        // Same shape of guard as the branch name: this reaches a git argument
        // list, so no leading dash and no embedded NUL.
        if b.starts_with('-') || b.contains('\0') {
            return Err(format!("invalid base ref: '{b}'"));
        }
    }

    // Already checked out somewhere live? Hand back that worktree instead of
    // failing. git allows a branch in exactly one worktree, so `worktree add`
    // would refuse here, and the dialog's only recourse was to grey the branch
    // out — which read as "this branch is gone" rather than "someone is on it".
    // Two agents sharing one checkout is a real thing to want (a reviewer
    // alongside an author), and it is what the Git panel's Adopt already does.
    if existing {
        if let Some(p) = live_worktree_for(repo_path, branch) {
            return Ok(p);
        }
    }

    let repo = Path::new(repo_path);
    let repo_name = repo
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("repo");

    let worktrees_dir = match base_dir {
        Some(d) if !d.trim().is_empty() => PathBuf::from(d),
        _ => home_dir().join(".flock/worktrees"),
    };
    std::fs::create_dir_all(&worktrees_dir).map_err(|e| e.to_string())?;

    // Branch names are user-chosen now, so the derived directory can collide
    // with one left behind by an earlier workspace. Take the first free slot
    // rather than failing — git refuses to `worktree add` onto a non-empty dir.
    let stem = format!("{}-{}", repo_name, sanitize(branch));
    let mut worktree_path = worktrees_dir.join(&stem);
    for n in 2..100 {
        if !worktree_path.exists() {
            break;
        }
        worktree_path = worktrees_dir.join(format!("{stem}-{n}"));
    }
    let worktree_path_str = worktree_path.to_string_lossy().to_string();

    let mut args = vec!["-C", repo_path, "worktree", "add", &worktree_path_str];
    if existing {
        args.push(branch);
    } else {
        args.push("-b");
        args.push(branch);
        if let Some(b) = base_ref {
            args.push(b);
        }
    }

    let out = std::process::Command::new("git")
        .args(&args)
        .output()
        .map_err(|e| format!("failed to run git: {}", e))?;

    if !out.status.success() {
        // Pass git's own reason through. This used to be a flat "git worktree
        // add failed" to avoid leaking paths, but the branch and base are the
        // user's own input now and the failures are ones only they can fix
        // ("branch already exists", "invalid reference"); a generic message
        // leaves the new-workspace dialog with nothing actionable to show.
        //
        // Take the fatal/error line, NOT the first line: `worktree add` writes
        // progress chatter to stderr too, so the first line is usually the
        // useless "Preparing worktree (new branch 'x')".
        let err = String::from_utf8_lossy(&out.stderr);
        let lines: Vec<&str> = err.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
        let reason = lines
            .iter()
            .find(|l| l.starts_with("fatal:") || l.starts_with("error:"))
            .or_else(|| lines.last())
            .copied()
            .unwrap_or("git worktree add failed");
        return Err(reason
            .trim_start_matches("fatal: ")
            .trim_start_matches("error: ")
            .to_string());
    }

    Ok(worktree_path_str)
}

/// Copy gitignored-but-needed files (`.env` and friends) from the main
/// checkout into a fresh worktree. A worktree only contains tracked files, so
/// without this an agent's very first command tends to fail on a missing local
/// config that every other checkout of the repo has.
///
/// Each pattern is a repo-relative path whose *final* segment may use `*`
/// (`.env*`, `apps/web/.env.local`). Returns how many files were copied.
///
/// Deliberately files-only: matching a directory is skipped, never recursed.
/// A stray `node_modules` or `target` pattern would otherwise copy gigabytes
/// per agent, and the point of this is small local config, not a sync tool.
pub fn carry_over_files(repo_path: &str, worktree_path: &str, patterns: &[String]) -> usize {
    /// Cheap glob over one path segment: `*` matches any run of characters.
    fn matches(pattern: &str, name: &str) -> bool {
        let parts: Vec<&str> = pattern.split('*').collect();
        if parts.len() == 1 {
            return pattern == name;
        }
        let mut rest = name;
        if !rest.starts_with(parts[0]) {
            return false;
        }
        rest = &rest[parts[0].len()..];
        for (i, part) in parts.iter().enumerate().skip(1) {
            if part.is_empty() {
                // Trailing `*` — anything left over is fine.
                if i == parts.len() - 1 {
                    return true;
                }
                continue;
            }
            if i == parts.len() - 1 {
                return rest.len() >= part.len() && rest.ends_with(part);
            }
            match rest.find(part) {
                Some(at) => rest = &rest[at + part.len()..],
                None => return false,
            }
        }
        true
    }

    const MAX_FILES: usize = 50;
    const MAX_BYTES: u64 = 16 * 1024 * 1024;

    let repo = Path::new(repo_path);
    let dest_root = Path::new(worktree_path);
    let mut copied = 0usize;
    let mut bytes = 0u64;

    for pattern in patterns {
        let pattern = pattern.trim().trim_start_matches("./");
        // No escaping out of the repo, and no absolute sources.
        if pattern.is_empty() || pattern.starts_with('/') || pattern.split('/').any(|s| s == "..") {
            continue;
        }
        let (rel_dir, name_pat) = match pattern.rsplit_once('/') {
            Some((d, n)) => (d, n),
            None => ("", pattern),
        };
        let Ok(entries) = std::fs::read_dir(repo.join(rel_dir)) else { continue };

        for entry in entries.flatten() {
            if copied >= MAX_FILES || bytes >= MAX_BYTES {
                return copied;
            }
            let Ok(meta) = entry.metadata() else { continue };
            if !meta.is_file() {
                continue;
            }
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if !matches(name_pat, name) {
                continue;
            }
            let dest = if rel_dir.is_empty() {
                dest_root.join(name)
            } else {
                dest_root.join(rel_dir).join(name)
            };
            // Never clobber: if the file is tracked it's already correct here,
            // and a checked-in default must win over the main checkout's copy.
            if dest.exists() {
                continue;
            }
            if let Some(parent) = dest.parent() {
                if std::fs::create_dir_all(parent).is_err() {
                    continue;
                }
            }
            if std::fs::copy(entry.path(), &dest).is_ok() {
                copied += 1;
                bytes += meta.len();
            }
        }
    }
    copied
}

/// Switch the checkout at `worktree_path` (a linked worktree or the main
/// working copy) to `branch`, creating it from the current HEAD when `create`
/// is set. Fails — with git's own one-line reason — when the branch is
/// already checked out in another worktree or local changes would be
/// clobbered; the caller surfaces that message in the branch picker.
pub fn checkout_in_worktree(worktree_path: &str, branch: &str, create: bool) -> Result<(), String> {
    let branch = branch.trim();
    if branch.is_empty() || branch.starts_with('-') || branch == "HEAD" || branch.contains('\0') {
        return Err(format!("invalid branch name: '{}'", branch));
    }

    let mut args = vec!["-C", worktree_path, "switch"];
    if create {
        args.push("-c");
    }
    args.push(branch);

    let out = std::process::Command::new("git")
        .args(&args)
        .output()
        .map_err(|e| format!("failed to run git: {}", e))?;

    if !out.status.success() {
        // git's first stderr line names the actual conflict ("already used by
        // worktree …", "would be overwritten by checkout") — pass it through
        // so the picker can tell the user why, instead of a generic failure.
        let err = String::from_utf8_lossy(&out.stderr);
        let reason = err
            .lines()
            .map(str::trim)
            .find(|l| !l.is_empty())
            .unwrap_or("git switch failed");
        return Err(reason.trim_start_matches("fatal: ").to_string());
    }
    Ok(())
}

/// Remove a worktree previously created by `create_worktree`, along with its
/// branch. Best-effort: called when a pane using a worktree is closed, so a
/// failure here (e.g. uncommitted changes) shouldn't block the pane from
/// closing — callers should log and move on rather than surface this as a
/// blocking error.
pub fn remove_worktree(repo_path: &str, worktree_path: &str, branch: &str, delete_branch: bool) -> Result<(), String> {
    // Validate branch name before passing to `git branch -D` to prevent
    // abuse of git ref semantics (e.g. branch names starting with "-",
    // "HEAD", or containing null bytes).
    if delete_branch {
        if branch.starts_with('-') || branch == "HEAD" || branch.contains('\0') {
            return Err(format!("invalid branch name: '{}'", branch));
        }
    }

    let out = std::process::Command::new("git")
        // Do not pass --force here: this cleanup runs automatically when a
        // pane, tab, or workspace closes, and --force silently destroys an
        // agent's uncommitted work. A failed cleanup leaves the worktree in
        // place for the user to recover or remove explicitly.
        .args(["-C", repo_path, "worktree", "remove", worktree_path])
        .output()
        .map_err(|e| format!("failed to run git: {}", e))?;

    if !out.status.success() {
        return Err("git worktree remove failed".to_string());
    }

    if delete_branch {
        // Best-effort — the worktree's gone either way, and a leftover local
        // branch is harmless clutter, not worth failing over.
        let _ = std::process::Command::new("git")
            .args(["-C", repo_path, "branch", "-D", branch])
            .output();
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::tests::scratch_repo;

    fn head_branch(path: &std::path::Path) -> String {
        let out = std::process::Command::new("git")
            .args(["-C", path.to_str().unwrap(), "rev-parse", "--abbrev-ref", "HEAD"])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    #[test]
    fn creates_branches_from_a_base_ref_and_checks_out_existing_ones() {
        let repo = scratch_repo("wt");
        let p = repo.to_str().unwrap();
        let base = repo.join("wts");
        let base_dir = Some(base.to_str().unwrap());

        // New branch off an explicit base ref, not whatever HEAD happens to be.
        let path = create_worktree(p, "feat-a", base_dir, Some("origin/main"), false).unwrap();
        assert_eq!(head_branch(std::path::Path::new(&path)), "feat-a");

        // Checking out a branch that already exists.
        let path2 = create_worktree(p, "feature", base_dir, None, true).unwrap();
        assert_eq!(head_branch(std::path::Path::new(&path2)), "feature");

        // Asking again for a branch a live worktree already holds joins that
        // worktree instead of failing. git would refuse a second checkout, and
        // the old behaviour surfaced that refusal as an unpickable row in the
        // new-workspace dialog; sharing the folder is what the user meant.
        // Canonicalised, because git answers with the real path and the temp
        // dir this test runs in is behind macOS's /var -> /private/var
        // symlink. The claim is that it is the same directory, not that two
        // strings match.
        let path3 = create_worktree(p, "feature", base_dir, None, true).unwrap();
        assert_eq!(
            std::fs::canonicalize(&path3).unwrap(),
            std::fs::canonicalize(&path2).unwrap(),
            "a held branch returns its existing worktree"
        );

        // Same for re-creating a branch that exists.
        let err = create_worktree(p, "feat-a", base_dir, Some("origin/main"), false).unwrap_err();
        assert!(err.contains("feat-a"), "unhelpful error: {err}");

        // Directory collision resolves to a free slot rather than failing.
        // Free the branch name but leave the old directory behind, which is
        // what a manually-deleted-then-recreated workspace looks like.
        for args in [
            vec!["-C", p, "worktree", "remove", "--force", &path],
            vec!["-C", p, "branch", "-D", "feat-a"],
        ] {
            std::process::Command::new("git").args(&args).output().unwrap();
        }
        std::fs::create_dir_all(&path).unwrap();
        let path3 = create_worktree(p, "feat-a", base_dir, Some("origin/main"), false).unwrap();
        assert_ne!(path3, path);
        assert_eq!(head_branch(std::path::Path::new(&path3)), "feat-a");

        // Invalid names never reach git.
        assert!(create_worktree(p, "-oops", base_dir, None, false).is_err());
        assert!(create_worktree(p, "has space", base_dir, None, false).is_err());
        assert!(create_worktree(p, "ok", base_dir, Some("--upload-pack=evil"), false).is_err());

        std::fs::remove_dir_all(&repo).ok();
    }

    /// A race branches every contender from a pinned **sha**, not a branch
    /// name, and then tears the losers down. Both halves go through code that
    /// was only ever exercised with branch names and clean checkouts.
    #[test]
    fn contenders_branch_from_a_sha_and_only_tear_down_once_committed() {
        let repo = crate::git::tests::scratch_repo("race-wt");
        let p = repo.to_str().unwrap();
        let base = crate::git::head_sha(p).unwrap();
        let wts = repo.join("wts");
        let base_dir = Some(wts.to_str().unwrap());

        // `create_worktree` only screens base_ref for a leading dash and NUL,
        // so a 40-char sha reaches `git worktree add` verbatim.
        let a = create_worktree(p, "race-x-pluto", base_dir, Some(&base), false).unwrap();
        let b = create_worktree(p, "race-x-nova", base_dir, Some(&base), false).unwrap();
        assert_eq!(head_branch(std::path::Path::new(&a)), "race-x-pluto");
        assert_eq!(head_branch(std::path::Path::new(&b)), "race-x-nova");

        // A losing agent leaves its work uncommitted. `remove_worktree`
        // deliberately never passes --force, so this is refused — which is
        // exactly why the discard path commits first.
        std::fs::write(std::path::Path::new(&b).join("loser.txt"), "half an idea\n").unwrap();
        assert!(
            remove_worktree(p, &b, "race-x-nova", true).is_err(),
            "an uncommitted worktree must not be silently discarded"
        );

        assert!(crate::git::commit_all(&b, "Race: x").unwrap(), "there was work to commit");
        remove_worktree(p, &b, "race-x-nova", true).unwrap();
        assert!(!std::path::Path::new(&b).exists());
        assert!(
            crate::git::branch_unmerged_count(p, "race-x-nova") == 0,
            "the deleted branch should no longer be countable"
        );

        std::fs::remove_dir_all(&repo).ok();
    }

    /// The carry-over glob is hand-rolled (one segment, `*` only), so pin its
    /// behavior — an over-eager match here copies the wrong files into every
    /// agent's worktree.
    #[test]
    fn carry_over_globs() {
        let dir = std::env::temp_dir().join(format!("flock-carry-{}", std::process::id()));
        let src = dir.join("src");
        let dst = dir.join("dst");
        std::fs::create_dir_all(src.join("apps/web")).unwrap();
        std::fs::create_dir_all(&dst).unwrap();
        for f in [".env", ".env.local", ".envrc", "env", "README.md"] {
            std::fs::write(src.join(f), "x").unwrap();
        }
        std::fs::write(src.join("apps/web/.env.local"), "y").unwrap();
        // A directory that matches the pattern must be skipped, not recursed.
        std::fs::create_dir_all(src.join(".env.d")).unwrap();

        let patterns = vec![".env*".to_string(), "apps/web/.env.local".to_string()];
        let n = carry_over_files(src.to_str().unwrap(), dst.to_str().unwrap(), &patterns);

        assert!(dst.join(".env").exists());
        assert!(dst.join(".env.local").exists());
        assert!(dst.join(".envrc").exists());
        assert!(dst.join("apps/web/.env.local").exists());
        // `.env*` must not match the bare `env`, and must not pull unrelated files.
        assert!(!dst.join("env").exists());
        assert!(!dst.join("README.md").exists());
        assert!(!dst.join(".env.d").exists());
        assert_eq!(n, 4);

        // Existing destination files are never clobbered.
        std::fs::write(dst.join(".env"), "keep").unwrap();
        let again = carry_over_files(src.to_str().unwrap(), dst.to_str().unwrap(), &patterns);
        assert_eq!(again, 0);
        assert_eq!(std::fs::read_to_string(dst.join(".env")).unwrap(), "keep");

        // No escaping the repo root.
        assert_eq!(
            carry_over_files(src.to_str().unwrap(), dst.to_str().unwrap(), &["../secret".to_string()]),
            0
        );

        std::fs::remove_dir_all(&dir).ok();
    }
}
