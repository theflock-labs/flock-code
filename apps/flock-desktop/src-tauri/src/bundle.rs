//! Keep the installed app bundle named `flock.app`.
//!
//! macOS shows an app's *directory name* — `/Applications/flock.app` — in
//! Finder, Spotlight, the Dock, the force-quit list and every System Settings
//! privacy pane (App Management, Screen Recording, Microphone…). `CFBundleName`
//! and `CFBundleDisplayName` barely get a look in. So the bundle's own name is
//! the brand, and it has to say flock.
//!
//! The rebrand renamed the product but could not rename anyone's install:
//! tauri-plugin-updater installs a new version by unpacking it over the
//! *existing* bundle path (`extract_path_from_executable` walks up from the
//! running executable to the enclosing `.app` and replaces it in place). Every
//! install that predates the rebrand is therefore still
//! `/Applications/Clarence.app`, holding a fully rebranded flock binary, and no
//! future update will ever move it. Only the app itself can, once, on launch.
//!
//! Renaming the bundle out from under the running process is safe on macOS: the
//! code signature covers the bundle's contents, not its path, and TCC grants key
//! off the bundle identifier plus that signature, so nothing the user has
//! already allowed is revoked. What does go stale is `current_exe()` — the
//! kernel hands back the path the process was `exec`'d from — which is exactly
//! what the updater follows. Hence the re-exec in [`rename_to_flock`]'s caller.

use std::path::{Path, PathBuf};

/// The pre-rebrand bundle name. Kept as a single literal: this module exists
/// solely to retire it, and it should be deleted whole once no install old
/// enough to still be called this is plausibly out there.
const LEGACY_BUNDLE: &str = "Clarence.app";
const BUNDLE: &str = "flock.app";

const LSREGISTER: &str = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

#[derive(Debug, PartialEq, Eq)]
enum Rename {
    /// Not running from a `Clarence.app` — the overwhelmingly common case, and
    /// every case at all after this has run once.
    NotNeeded,
    /// Renamed; holds the new bundle path.
    Renamed(PathBuf),
    /// A `flock.app` already sits beside the legacy bundle. Two installs of the
    /// same app, so renaming would destroy one of them. Left for the user.
    Blocked(PathBuf),
    Failed(String),
}

/// Rename this app's bundle to `flock.app` if it is still the pre-rebrand
/// `Clarence.app`. Returns the executable to re-exec from when it renamed
/// anything, and `None` in every other case, including failure — a bundle that
/// could not be renamed is still perfectly runnable where it is.
pub fn rename_to_flock() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let bundle = bundle_of(&exe)?;

    match rename_bundle_at(&bundle) {
        Rename::NotNeeded => None,
        Rename::Renamed(new_bundle) => {
            tracing::info!(
                target: "flock_desktop_lib",
                from = %bundle.display(),
                to = %new_bundle.display(),
                "renamed the pre-rebrand app bundle"
            );
            // Launch Services caches the old path, and it is what the privacy
            // panes read to label an app. It notices moves on its own
            // eventually; asking directly means the user isn't looking at
            // "Clarence" in System Settings in the meantime. Best-effort.
            let _ = std::process::Command::new(LSREGISTER)
                .arg("-f")
                .arg(&new_bundle)
                .output();
            Some(new_bundle.join("Contents/MacOS").join(exe.file_name()?))
        }
        Rename::Blocked(existing) => {
            tracing::warn!(
                target: "flock_desktop_lib",
                bundle = %bundle.display(),
                existing = %existing.display(),
                "still running from the pre-rebrand bundle: a flock.app already exists beside it, \
                 so renaming would overwrite a second install. Remove whichever is unwanted by hand."
            );
            None
        }
        Rename::Failed(err) => {
            tracing::warn!(
                target: "flock_desktop_lib",
                bundle = %bundle.display(),
                error = %err,
                "could not rename the pre-rebrand app bundle; continuing from it"
            );
            None
        }
    }
}

/// The `.app` enclosing an executable, i.e. `<bundle>/Contents/MacOS/<exe>`.
/// `None` for anything else — notably `cargo run` / `tauri dev`, which run the
/// bare binary out of `target/`.
fn bundle_of(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    if macos.file_name()? != "MacOS" {
        return None;
    }
    let contents = macos.parent()?;
    if contents.file_name()? != "Contents" {
        return None;
    }
    let bundle = contents.parent()?;
    bundle
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("app"))
        .then(|| bundle.to_path_buf())
}

fn rename_bundle_at(bundle: &Path) -> Rename {
    let Some(name) = bundle.file_name().and_then(|n| n.to_str()) else {
        return Rename::NotNeeded;
    };
    // Case-insensitively: the disk is, so a `clarence.app` typed by hand is the
    // same directory to everything that reads it.
    if !name.eq_ignore_ascii_case(LEGACY_BUNDLE) {
        return Rename::NotNeeded;
    }
    let Some(parent) = bundle.parent() else {
        return Rename::NotNeeded;
    };
    let target = parent.join(BUNDLE);
    // `symlink_metadata`, not `exists`: a broken symlink named flock.app is
    // still something a rename would silently replace.
    if target.symlink_metadata().is_ok() {
        return Rename::Blocked(target);
    }
    match std::fs::rename(bundle, &target) {
        Ok(()) => Rename::Renamed(target),
        Err(e) => Rename::Failed(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// A unique empty directory. The crate carries no dev-dependencies and this
    /// needs one path, not a crate.
    fn scratch(label: &str) -> PathBuf {
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "flock-bundle-{}-{}-{}",
            label,
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// An app bundle with an executable where macOS puts one.
    fn make_bundle(parent: &Path, name: &str) -> PathBuf {
        let bundle = parent.join(name);
        std::fs::create_dir_all(bundle.join("Contents/MacOS")).unwrap();
        std::fs::write(bundle.join("Contents/MacOS/flock-desktop"), "mach-o").unwrap();
        bundle
    }

    #[test]
    fn renames_the_pre_rebrand_bundle() {
        let apps = scratch("legacy");
        let bundle = make_bundle(&apps, LEGACY_BUNDLE);

        let outcome = rename_bundle_at(&bundle);

        assert_eq!(outcome, Rename::Renamed(apps.join(BUNDLE)));
        assert!(!bundle.exists());
        // Contents came along, so the running executable's inode is untouched.
        assert!(apps.join(BUNDLE).join("Contents/MacOS/flock-desktop").exists());

        let _ = std::fs::remove_dir_all(&apps);
    }

    #[test]
    fn leaves_an_already_renamed_bundle_alone() {
        let apps = scratch("current");
        let bundle = make_bundle(&apps, BUNDLE);

        assert_eq!(rename_bundle_at(&bundle), Rename::NotNeeded);
        assert!(bundle.exists());

        let _ = std::fs::remove_dir_all(&apps);
    }

    #[test]
    fn never_overwrites_a_second_install() {
        let apps = scratch("both");
        let legacy = make_bundle(&apps, LEGACY_BUNDLE);
        let current = make_bundle(&apps, BUNDLE);
        std::fs::write(current.join("Contents/MacOS/flock-desktop"), "the other one").unwrap();

        assert_eq!(rename_bundle_at(&legacy), Rename::Blocked(current.clone()));

        assert!(legacy.exists());
        assert_eq!(
            std::fs::read_to_string(current.join("Contents/MacOS/flock-desktop")).unwrap(),
            "the other one"
        );

        let _ = std::fs::remove_dir_all(&apps);
    }

    #[test]
    fn finds_the_enclosing_bundle() {
        let exe = Path::new("/Applications/Clarence.app/Contents/MacOS/flock-desktop");
        assert_eq!(
            bundle_of(exe),
            Some(PathBuf::from("/Applications/Clarence.app"))
        );
    }

    #[test]
    fn a_bare_binary_has_no_bundle() {
        // `tauri dev` and `cargo run` both land here.
        assert_eq!(
            bundle_of(Path::new("/repo/target/debug/flock-desktop")),
            None
        );
        assert_eq!(
            bundle_of(Path::new("/opt/Contents/MacOS/flock-desktop")),
            None
        );
    }
}
