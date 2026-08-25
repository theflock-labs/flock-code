//! Where flock keeps its data on disk, and the one-time move of the
//! pre-rebrand `~/.clarence` to `~/.flock`.
//!
//! This directory is not a cache: it holds the workspaces DB, the user's
//! GitHub token, ~150 MB of Whisper models and worktree bookkeeping. So the
//! migration is written to fail *safe* rather than fail *clean* — every path
//! through it either ends with the data at the new location or leaves the old
//! directory exactly as it was and keeps reading from there. Nothing here ever
//! deletes user data.
//!
//! Both the desktop app and the TUI call [`shared_data_dir`]; there is
//! deliberately one implementation of the move, because two divergent copies of
//! "must never destroy the old directory" is how a user loses a year of
//! workspaces.
//!
//! Known gap: worktree paths recorded in the DB (and the `gitdir` links git
//! keeps inside each repo) still point at `~/.clarence/worktrees/…` after the
//! move. The worktrees themselves travel with the directory and their contents
//! are intact, but git's back-links are absolute, so `git worktree list` in the
//! parent repo shows the old path until someone runs `git worktree repair`
//! there. Repairing that needs the repo list plus a git invocation per repo,
//! which is above this module's pay grade; see the rebrand notes.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Directory name under `$HOME`, and its pre-rebrand predecessor.
pub const DIR_NAME: &str = ".flock";
pub const LEGACY_DIR_NAME: &str = ".clarence";

/// Workspace database file name, and its pre-rebrand predecessor.
pub const DB_FILE: &str = "flock.db";
pub const LEGACY_DB_FILE: &str = "clarence.db";

/// What [`resolve_dir`] actually did, for logging and for tests.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Migration {
    /// Nothing to do: `~/.flock` was already there (every launch after the
    /// first), or there was no `~/.clarence` to move (fresh install).
    NotNeeded,
    /// Moved wholesale by an atomic rename. The common case: both directories
    /// sit in `$HOME`, so they share a filesystem.
    Moved,
    /// Rename was refused (different filesystems, or `$HOME` is a mount point
    /// with odd semantics), so the contents were copied. The old directory is
    /// deliberately left behind: the copy is verified but not trusted enough to
    /// delete 150 MB of the user's models on its word.
    Copied,
    /// Could not migrate at all. The old directory is untouched and callers
    /// keep using it, so the user sees their data rather than an empty app.
    Failed(String),
}

/// Outcome of resolving the data directory: the path to actually use, plus how
/// it got there.
///
/// The outcome is returned rather than logged, because the log file itself
/// lives inside the directory being resolved — the desktop app has to resolve
/// the path *before* it can open a log to write to. Callers log this once the
/// subscriber is up.
#[derive(Debug, Clone)]
pub struct Resolved {
    pub dir: PathBuf,
    pub migration: Migration,
    /// Set when the directory is in the right place but `clarence.db` could not
    /// be renamed to `flock.db`. Not fatal: [`db_path_in`] still opens the old
    /// name and the next launch retries the rename.
    pub db_rename_error: Option<String>,
}

pub fn home_dir() -> PathBuf {
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/tmp"))
}

/// The shared `~/.flock`, migrating from `~/.clarence` on the first call of the
/// process. Memoized: the migration is idempotent, but there is no reason to
/// re-stat two directories on every token read, and one answer per process
/// means every module agrees on the location even if the filesystem changes
/// underfoot.
pub fn shared_data_dir() -> PathBuf {
    shared().dir.clone()
}

/// How the shared directory got where it is. Log this once, after the log file
/// exists; see [`Resolved`].
pub fn shared_data_dir_outcome() -> &'static Resolved {
    shared()
}

fn shared() -> &'static Resolved {
    static RESOLVED: OnceLock<Resolved> = OnceLock::new();
    RESOLVED.get_or_init(|| {
        let home = home_dir();
        let resolved = resolve_dir(&home.join(LEGACY_DIR_NAME), &home.join(DIR_NAME));
        // flock-pty cannot resolve this itself (this crate depends on it) and
        // must never invent `$HOME/.flock`: that create_dir_all would look
        // like a finished migration and strand a failed one under ~/.clarence.
        flock_pty::container::set_shared_dir(resolved.dir.clone());
        resolved
    })
}

/// The workspace DB inside the shared data directory.
pub fn db_path() -> PathBuf {
    db_path_in(&shared_data_dir())
}

/// The DB file to open inside `dir`. Normally `flock.db`, but falls back to the
/// pre-rebrand `clarence.db` when only that one exists — which is what a failed
/// migration leaves behind, and also what a `FLOCK_DATA_DIR` pointed at an old
/// directory contains. Opening the new name there would silently create an
/// empty database next to the real one.
pub fn db_path_in(dir: &Path) -> PathBuf {
    let current = dir.join(DB_FILE);
    if !current.exists() {
        let legacy = dir.join(LEGACY_DB_FILE);
        if legacy.exists() {
            return legacy;
        }
    }
    current
}

/// Resolve `current`, migrating `legacy` into it if `current` is absent.
///
/// Safe to call on every launch. The one invariant that matters: on any failure
/// this returns a directory that still has the user's data in it, and `legacy`
/// is left byte-identical.
pub fn resolve_dir(legacy: &Path, current: &Path) -> Resolved {
    // Post-migration launches, and fresh installs that have already run once.
    // Still repair the DB name: a previous run could have moved the directory
    // and then died before renaming the file inside it.
    //
    // `is_dir`, not `exists`: something that is there but isn't a directory
    // must not be mistaken for a finished migration, or a stray `~/.flock` file
    // would strand the real data under the old name with no way back.
    if current.is_dir() {
        return Resolved {
            dir: current.to_path_buf(),
            migration: Migration::NotNeeded,
            db_rename_error: rename_db(current).err().map(|e| e.to_string()),
        };
    }

    // Fresh install: nothing to bring forward.
    if !legacy.is_dir() {
        return Resolved {
            dir: current.to_path_buf(),
            migration: Migration::NotNeeded,
            db_rename_error: None,
        };
    }

    let migration = match std::fs::rename(legacy, current) {
        Ok(()) => {
            // A rename that returns Ok has already happened atomically, so this
            // is a belt-and-braces check against a filesystem that lied rather
            // than a real recovery path — but if it did lie, the old directory
            // is still the one with the data in it.
            if current.is_dir() {
                Migration::Moved
            } else if legacy.is_dir() {
                return Resolved {
                    dir: legacy.to_path_buf(),
                    migration: Migration::Failed(
                        "rename reported success but neither directory looks right".into(),
                    ),
                    db_rename_error: None,
                };
            } else {
                Migration::Moved
            }
        }
        Err(rename_err) => match copy_across(legacy, current) {
            Ok(()) => Migration::Copied,
            Err(copy_err) => {
                // Both routes refused. Keep using the old directory: a user with
                // their data under the old name is inconvenienced, a user with
                // an empty new directory thinks they lost everything.
                return Resolved {
                    dir: legacy.to_path_buf(),
                    migration: Migration::Failed(format!(
                        "rename failed ({rename_err}); copy failed ({copy_err})"
                    )),
                    db_rename_error: None,
                };
            }
        },
    };

    // A failure here means the directory moved but the file name inside it
    // didn't, which `db_path_in` absorbs and the next launch retries.
    Resolved {
        dir: current.to_path_buf(),
        migration,
        db_rename_error: rename_db(current).err().map(|e| e.to_string()),
    }
}

/// Rename `clarence.db` to `flock.db` in place, sidecars included.
///
/// The `-wal` has to travel with its database: SQLite matches it by file name,
/// so a `flock.db` sitting next to a `clarence.db-wal` opens *without* the
/// transactions in that WAL and silently loses the tail of the user's history.
/// All-or-nothing for the same reason — a half-applied rename is the one state
/// where the WAL gets orphaned, so any failure rolls the earlier renames back.
fn rename_db(dir: &Path) -> std::io::Result<()> {
    let target = dir.join(DB_FILE);
    let source = dir.join(LEGACY_DB_FILE);
    // Already renamed, or nothing to rename. Never clobber an existing
    // flock.db: if both names are present the new one is authoritative.
    if target.exists() || !source.exists() {
        return Ok(());
    }

    let mut moves: Vec<(PathBuf, PathBuf)> = Vec::with_capacity(3);
    for suffix in ["", "-wal", "-shm"] {
        let from = dir.join(format!("{LEGACY_DB_FILE}{suffix}"));
        if from.exists() {
            moves.push((from, dir.join(format!("{DB_FILE}{suffix}"))));
        }
    }

    let mut done: Vec<(PathBuf, PathBuf)> = Vec::with_capacity(moves.len());
    for (from, to) in moves {
        match std::fs::rename(&from, &to) {
            Ok(()) => done.push((from, to)),
            Err(e) => {
                for (orig, moved) in done.into_iter().rev() {
                    let _ = std::fs::rename(moved, orig);
                }
                return Err(e);
            }
        }
    }
    Ok(())
}

/// Copy `legacy` to `current` when a rename can't cross the gap.
///
/// Stages into a sibling scratch directory and only renames it into place once
/// the copy is complete and verified, so an interrupted copy can never leave a
/// partial `~/.flock` that the next launch would mistake for a finished
/// migration. The scratch directory is ours, so it's the only thing here that
/// is ever deleted.
fn copy_across(legacy: &Path, current: &Path) -> std::io::Result<()> {
    let name = current
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(DIR_NAME);
    let staging = current.with_file_name(format!("{name}.migrating"));
    let _ = std::fs::remove_dir_all(&staging);

    let result = copy_tree(legacy, &staging).and_then(|_| {
        let want = dir_stats(legacy)?;
        let got = dir_stats(&staging)?;
        if want == got {
            Ok(())
        } else {
            Err(std::io::Error::other(format!(
                "copy verification failed: {want:?} in the source, {got:?} in the copy"
            )))
        }
    });

    match result {
        Ok(()) => match std::fs::rename(&staging, current) {
            Ok(()) => Ok(()),
            Err(e) => {
                let _ = std::fs::remove_dir_all(&staging);
                Err(e)
            }
        },
        Err(e) => {
            let _ = std::fs::remove_dir_all(&staging);
            Err(e)
        }
    }
}

fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let src = entry.path();
        let dst = to.join(entry.file_name());
        // Symlinks are copied as links, not followed: `~/.clarence` can hold a
        // link into a model cache elsewhere, and dereferencing it would both
        // duplicate gigabytes and quietly change what the app writes through.
        let meta = entry.metadata()?;
        if meta.file_type().is_symlink() {
            #[cfg(unix)]
            std::os::unix::fs::symlink(std::fs::read_link(&src)?, &dst)?;
        } else if meta.is_dir() {
            copy_tree(&src, &dst)?;
        } else {
            std::fs::copy(&src, &dst)?;
        }
    }
    Ok(())
}

/// (file count, total bytes) over a tree, symlinks counted but not followed.
/// Cheap enough on a directory this size and catches a copy that ran out of
/// disk halfway through, which `fs::copy` alone would report per-file and a
/// caller could otherwise shrug off.
fn dir_stats(dir: &Path) -> std::io::Result<(u64, u64)> {
    let mut files = 0u64;
    let mut bytes = 0u64;
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let meta = entry.metadata()?;
        if meta.file_type().is_symlink() {
            files += 1;
        } else if meta.is_dir() {
            let (f, b) = dir_stats(&entry.path())?;
            files += f;
            bytes += b;
        } else {
            files += 1;
            bytes += meta.len();
        }
    }
    Ok((files, bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// Isolated scratch directory. Deliberately not `tempfile`: flock-core has
    /// no dev-dependencies and this needs one unique path, not a crate.
    fn scratch(label: &str) -> PathBuf {
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "flock-paths-{}-{}-{}",
            label,
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &Path, body: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    /// A `~/.clarence` with the things that actually hurt to lose.
    fn populate_legacy(dir: &Path) {
        write(&dir.join(LEGACY_DB_FILE), "sqlite-main");
        write(&dir.join(format!("{LEGACY_DB_FILE}-wal")), "sqlite-wal");
        write(&dir.join("github_token"), "ghp_secret");
        write(&dir.join("whisper-models/base.en.bin"), "weights");
        write(&dir.join("worktrees/repo-feature/README"), "worktree");
    }

    #[test]
    fn fresh_install_uses_the_new_directory() {
        let home = scratch("fresh");
        let legacy = home.join(LEGACY_DIR_NAME);
        let current = home.join(DIR_NAME);

        let r = resolve_dir(&legacy, &current);

        assert_eq!(r.migration, Migration::NotNeeded);
        assert_eq!(r.dir, current);
        // Resolution doesn't create anything; callers do that when they write.
        assert!(!current.exists());
        assert_eq!(db_path_in(&r.dir), current.join(DB_FILE));

        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn migrates_an_existing_clarence_directory() {
        let home = scratch("migrate");
        let legacy = home.join(LEGACY_DIR_NAME);
        let current = home.join(DIR_NAME);
        populate_legacy(&legacy);

        let r = resolve_dir(&legacy, &current);

        assert_eq!(r.migration, Migration::Moved);
        assert_eq!(r.dir, current);
        assert_eq!(r.db_rename_error, None);
        assert!(!legacy.exists(), "the old directory should be gone after a move");
        assert_eq!(
            std::fs::read_to_string(current.join("github_token")).unwrap(),
            "ghp_secret"
        );
        assert!(current.join("whisper-models/base.en.bin").exists());
        assert!(current.join("worktrees/repo-feature/README").exists());
        // Renamed, WAL alongside it, and the old names gone.
        assert_eq!(std::fs::read_to_string(current.join(DB_FILE)).unwrap(), "sqlite-main");
        assert_eq!(
            std::fs::read_to_string(current.join(format!("{DB_FILE}-wal"))).unwrap(),
            "sqlite-wal"
        );
        assert!(!current.join(LEGACY_DB_FILE).exists());
        assert!(!current.join(format!("{LEGACY_DB_FILE}-wal")).exists());
        assert_eq!(db_path_in(&r.dir), current.join(DB_FILE));

        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn second_launch_after_a_migration_is_a_no_op() {
        let home = scratch("idempotent");
        let legacy = home.join(LEGACY_DIR_NAME);
        let current = home.join(DIR_NAME);
        populate_legacy(&legacy);

        assert_eq!(resolve_dir(&legacy, &current).migration, Migration::Moved);
        // Something the user did between launches, to prove the second pass
        // doesn't reset the directory.
        write(&current.join("voice_enabled"), "1");

        let second = resolve_dir(&legacy, &current);

        assert_eq!(second.migration, Migration::NotNeeded);
        assert_eq!(second.dir, current);
        assert_eq!(std::fs::read_to_string(current.join("voice_enabled")).unwrap(), "1");
        assert_eq!(std::fs::read_to_string(current.join(DB_FILE)).unwrap(), "sqlite-main");

        let _ = std::fs::remove_dir_all(&home);
    }

    /// A `~/.clarence` left over from a pre-rebrand install running alongside a
    /// migrated `~/.flock`. The new directory wins and the old one is never
    /// touched, let alone merged.
    #[test]
    fn an_existing_new_directory_wins_and_the_old_one_survives() {
        let home = scratch("both");
        let legacy = home.join(LEGACY_DIR_NAME);
        let current = home.join(DIR_NAME);
        populate_legacy(&legacy);
        write(&current.join(DB_FILE), "newer");

        let r = resolve_dir(&legacy, &current);

        assert_eq!(r.migration, Migration::NotNeeded);
        assert_eq!(r.dir, current);
        assert_eq!(std::fs::read_to_string(current.join(DB_FILE)).unwrap(), "newer");
        assert_eq!(
            std::fs::read_to_string(legacy.join(LEGACY_DB_FILE)).unwrap(),
            "sqlite-main"
        );

        let _ = std::fs::remove_dir_all(&home);
    }

    /// The move can't happen (here: the destination's parent is a file, which
    /// defeats both rename and copy). The user must still find their data.
    #[test]
    fn a_failed_move_keeps_the_old_directory_and_falls_back_to_it() {
        let home = scratch("failed");
        let legacy = home.join(LEGACY_DIR_NAME);
        populate_legacy(&legacy);
        // Destination underneath a regular file: every route to it fails.
        let blocker = home.join("blocker");
        write(&blocker, "not a directory");
        let current = blocker.join(DIR_NAME);

        let r = resolve_dir(&legacy, &current);

        assert!(matches!(r.migration, Migration::Failed(_)), "{:?}", r.migration);
        assert_eq!(r.dir, legacy, "must fall back to reading the old location");
        assert_eq!(
            std::fs::read_to_string(legacy.join("github_token")).unwrap(),
            "ghp_secret"
        );
        assert!(legacy.join("whisper-models/base.en.bin").exists());
        assert_eq!(
            std::fs::read_to_string(legacy.join(LEGACY_DB_FILE)).unwrap(),
            "sqlite-main"
        );
        // And the caller still opens the right database in that directory.
        assert_eq!(db_path_in(&r.dir), legacy.join(LEGACY_DB_FILE));

        let _ = std::fs::remove_dir_all(&home);
    }

    /// Something that isn't a directory sitting at `~/.flock` must not be read
    /// as "already migrated" — that would leave the real data under the old
    /// name while the app pointed at a file.
    #[test]
    fn a_stray_flock_file_does_not_look_like_a_finished_migration() {
        let home = scratch("stray");
        let legacy = home.join(LEGACY_DIR_NAME);
        let current = home.join(DIR_NAME);
        populate_legacy(&legacy);
        write(&current, "not a directory");

        let r = resolve_dir(&legacy, &current);

        assert!(matches!(r.migration, Migration::Failed(_)), "{:?}", r.migration);
        assert_eq!(r.dir, legacy);
        assert_eq!(
            std::fs::read_to_string(legacy.join(LEGACY_DB_FILE)).unwrap(),
            "sqlite-main"
        );
        // The staging directory the copy attempt used must not survive it.
        assert!(!home.join(format!("{DIR_NAME}.migrating")).exists());

        let _ = std::fs::remove_dir_all(&home);
    }

    /// The copy fallback, exercised directly: it verifies, leaves no scratch
    /// directory behind, and does not delete the source.
    #[test]
    fn the_copy_fallback_verifies_and_keeps_the_source() {
        let home = scratch("copy");
        let legacy = home.join(LEGACY_DIR_NAME);
        let current = home.join(DIR_NAME);
        populate_legacy(&legacy);

        copy_across(&legacy, &current).unwrap();

        assert!(legacy.join(LEGACY_DB_FILE).exists(), "source must survive a copy");
        assert_eq!(
            std::fs::read_to_string(current.join("whisper-models/base.en.bin")).unwrap(),
            "weights"
        );
        assert!(!home.join(format!("{DIR_NAME}.migrating")).exists(), "scratch dir left behind");
        assert_eq!(dir_stats(&legacy).unwrap(), dir_stats(&current).unwrap());

        let _ = std::fs::remove_dir_all(&home);
    }

    /// A previous run that moved the directory but died before renaming the DB.
    /// The next launch repairs it rather than opening an empty database.
    #[test]
    fn a_partial_migration_gets_the_db_renamed_on_the_next_launch() {
        let home = scratch("partial");
        let legacy = home.join(LEGACY_DIR_NAME);
        let current = home.join(DIR_NAME);
        write(&current.join(LEGACY_DB_FILE), "sqlite-main");
        write(&current.join(format!("{LEGACY_DB_FILE}-wal")), "sqlite-wal");

        let r = resolve_dir(&legacy, &current);

        assert_eq!(r.migration, Migration::NotNeeded);
        assert_eq!(std::fs::read_to_string(current.join(DB_FILE)).unwrap(), "sqlite-main");
        assert_eq!(
            std::fs::read_to_string(current.join(format!("{DB_FILE}-wal"))).unwrap(),
            "sqlite-wal"
        );
        assert_eq!(db_path_in(&r.dir), current.join(DB_FILE));

        let _ = std::fs::remove_dir_all(&home);
    }

    /// Both database names present: the new one is authoritative and the rename
    /// must not clobber it.
    #[test]
    fn rename_db_never_clobbers_an_existing_flock_db() {
        let dir = scratch("clobber");
        write(&dir.join(DB_FILE), "keep me");
        write(&dir.join(LEGACY_DB_FILE), "stale");

        rename_db(&dir).unwrap();

        assert_eq!(std::fs::read_to_string(dir.join(DB_FILE)).unwrap(), "keep me");
        assert_eq!(std::fs::read_to_string(dir.join(LEGACY_DB_FILE)).unwrap(), "stale");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
