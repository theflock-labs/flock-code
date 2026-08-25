//! Open a real, un-jailed terminal emulator at a directory.
//!
//! flock's panes are agent panes: a PTY the app owns, often inside the
//! secure-mode container, with an agent CLI already attached. Plenty of work
//! doesn't fit that — `aws sso login`, editing /etc/hosts, a quick `ssh` — and
//! that's what this is for. It hands the folder to whatever terminal the user
//! actually lives in, exactly as if they'd opened it from Finder.
//!
//! Detection is a bundle-path scan rather than `mdfind`: it's instant, needs no
//! Spotlight index, and the set of macOS terminals is small and stable. An app
//! the user doesn't have simply never appears in the picker.
//!
//! Two launch shapes, because the terminals disagree about folders:
//!   - `Folder` — the app handles a directory argument through LaunchServices
//!     (`open -a Warp <dir>`). Terminal.app, iTerm2 and Warp all do this.
//!   - `Args` — the app ignores folder-open events and needs a CLI flag, passed
//!     via `open -na <bundle> --args …`. `-n` is required: without a new
//!     instance, LaunchServices just activates the running app and drops the
//!     arguments on the floor.
//! Anything unknown falls back to `Folder`, whose worst case is a terminal that
//! opens at the user's home directory instead of the workspace.
//!
//! Each app also carries its real icon (extracted from the bundle, not redrawn)
//! so the picker and the header button show what the user recognizes.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use uuid::Uuid;

/// A terminal emulator found on this machine.
#[derive(serde::Serialize, Clone, Debug)]
pub struct TerminalApp {
    /// Stable key the frontend stores as the user's preference.
    pub id: String,
    pub name: String,
    /// Absolute path of the located .app bundle.
    pub path: String,
    /// The app's own icon as a `data:image/png;base64,…` URI, or null when the
    /// bundle keeps its icon somewhere we can't read (an asset catalog with no
    /// standalone .icns). The UI falls back to a generic glyph.
    pub icon: Option<String>,
}

enum Launch {
    /// `open -a <bundle> <dir>`
    Folder,
    /// `open -na <bundle> --args <flags…>`, with "{dir}" substituted inside
    /// each flag (so both `--cwd {dir}` and `--working-directory={dir}` work).
    Args(&'static [&'static str]),
}

struct Known {
    id: &'static str,
    name: &'static str,
    bundle: &'static str,
    launch: Launch,
}

// Order matters twice over: it's the order of the picker, and the frontend
// takes the first entry as the default when the user hasn't chosen. Purpose-
// built terminals come first, Terminal.app last — it's the one every Mac has,
// so leading with it would make the default wrong for most people.
const KNOWN: &[Known] = &[
    // Ghostty does NOT open a folder handed to it by LaunchServices (its own
    // issue tracker says as much); the CLI flag is the supported route.
    // `--window-save-state=never` keeps this window from restoring an old
    // session, which would land the user somewhere other than the directory
    // they asked for.
    Known {
        id: "ghostty",
        name: "Ghostty",
        bundle: "Ghostty.app",
        launch: Launch::Args(&["--working-directory={dir}", "--window-save-state=never"]),
    },
    Known { id: "warp", name: "Warp", bundle: "Warp.app", launch: Launch::Folder },
    Known { id: "iterm2", name: "iTerm2", bundle: "iTerm.app", launch: Launch::Folder },
    Known { id: "wezterm", name: "WezTerm", bundle: "WezTerm.app", launch: Launch::Args(&["start", "--cwd", "{dir}"]) },
    Known { id: "kitty", name: "kitty", bundle: "kitty.app", launch: Launch::Args(&["--directory", "{dir}"]) },
    Known { id: "alacritty", name: "Alacritty", bundle: "Alacritty.app", launch: Launch::Args(&["--working-directory", "{dir}"]) },
    Known { id: "rio", name: "Rio", bundle: "Rio.app", launch: Launch::Args(&["--working-dir", "{dir}"]) },
    Known { id: "tabby", name: "Tabby", bundle: "Tabby.app", launch: Launch::Folder },
    Known { id: "hyper", name: "Hyper", bundle: "Hyper.app", launch: Launch::Folder },
    Known { id: "terminal", name: "Terminal", bundle: "Terminal.app", launch: Launch::Folder },
];

fn search_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![
        PathBuf::from("/Applications"),
        PathBuf::from("/Applications/Utilities"),
        PathBuf::from("/System/Applications"),
        PathBuf::from("/System/Applications/Utilities"),
    ];
    if let Ok(home) = std::env::var("HOME") {
        dirs.push(PathBuf::from(home).join("Applications"));
    }
    dirs
}

fn locate(bundle: &str) -> Option<PathBuf> {
    search_dirs()
        .into_iter()
        .map(|d| d.join(bundle))
        .find(|p| p.is_dir())
}

/// The app's own icon, as a PNG data URI.
///
/// Read out of the bundle rather than shipped as hand-drawn SVGs: it's always
/// the icon the user actually recognizes from their Dock, it stays right when
/// an app rebrands, and it costs nothing per newly supported terminal.
/// `sips` (in every macOS) does the .icns → PNG conversion — no image crate
/// understands .icns, and NSWorkspace's icon API wants the main thread, which a
/// Tauri command doesn't run on.
fn icon_data_uri(bundle: &Path) -> Option<String> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, Option<String>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(hit) = cache.lock().ok()?.get(bundle) {
        return hit.clone();
    }
    let icon = extract_icon(bundle);
    if let Ok(mut c) = cache.lock() {
        c.insert(bundle.to_path_buf(), icon.clone());
    }
    icon
}

fn extract_icon(bundle: &Path) -> Option<String> {
    let res = bundle.join("Contents/Resources");
    let mut icns: Vec<PathBuf> = std::fs::read_dir(&res)
        .ok()?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("icns"))
        })
        .collect();
    if icns.is_empty() {
        return None;
    }
    icns.sort();
    // A bundle can ship several .icns (document types, status-bar items), so
    // prefer the conventional app-icon names before falling back to the first.
    let stem = bundle.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    let named = |want: &str| {
        icns.iter()
            .find(|p| p.file_stem().and_then(|s| s.to_str()) == Some(want))
            .cloned()
    };
    let pick = named("AppIcon").or_else(|| named(stem)).unwrap_or_else(|| icns[0].clone());

    // 64px covers both the 16px picker rows and the header button at 2x.
    let out = std::env::temp_dir().join(format!("flock-appicon-{}.png", Uuid::new_v4()));
    let ok = Command::new("sips")
        .args(["-s", "format", "png", "-Z", "64"])
        .arg(&pick)
        .arg("--out")
        .arg(&out)
        .output()
        .ok()
        .is_some_and(|o| o.status.success());
    let bytes = if ok { std::fs::read(&out).ok() } else { None };
    let _ = std::fs::remove_file(&out);
    bytes.map(|b| format!("data:image/png;base64,{}", STANDARD.encode(b)))
}

/// Every known terminal emulator installed on this machine, in picker order.
/// Empty off macOS, which is how the frontend knows to hide the button.
pub fn detect() -> Vec<TerminalApp> {
    KNOWN
        .iter()
        .filter_map(|k| {
            locate(k.bundle).map(|p| TerminalApp {
                id: k.id.to_string(),
                name: k.name.to_string(),
                icon: icon_data_uri(&p),
                path: p.to_string_lossy().to_string(),
            })
        })
        .collect()
}

/// Async + blocking pool: the icon extraction shells out to `sips` once per
/// installed terminal on the first call, which has no business happening on the
/// main thread while the window is painting.
#[tauri::command]
pub async fn list_terminal_apps() -> Result<Vec<TerminalApp>, String> {
    tokio::task::spawn_blocking(detect)
        .await
        .map_err(|e| e.to_string())
}

/// Open `dir` in the terminal app identified by `app_id`.
///
/// `app_id` is matched against the known table rather than taken as a path, so
/// a bad value fails instead of launching something arbitrary. The directory
/// must exist: `open` on a missing path is a confusing no-op otherwise.
#[tauri::command]
pub fn open_terminal_at(app_id: String, dir: String) -> Result<(), String> {
    let known = KNOWN
        .iter()
        .find(|k| k.id == app_id)
        .ok_or_else(|| format!("unknown terminal app: {app_id}"))?;
    let bundle = locate(known.bundle).ok_or_else(|| format!("{} isn't installed", known.name))?;
    if !Path::new(&dir).is_dir() {
        return Err(format!("no such directory: {dir}"));
    }

    let mut cmd = Command::new("open");
    match known.launch {
        Launch::Folder => {
            cmd.arg("-a").arg(&bundle).arg(&dir);
        }
        Launch::Args(flags) => {
            cmd.arg("-na").arg(&bundle).arg("--args");
            for f in flags {
                cmd.arg(f.replace("{dir}", &dir));
            }
        }
    }
    let status = cmd.status().map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(format!("{} refused to open {dir}", known.name));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_unique_and_dir_placeholder_is_used_once() {
        let mut ids: Vec<&str> = KNOWN.iter().map(|k| k.id).collect();
        ids.sort_unstable();
        let count = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), count, "duplicate terminal id in KNOWN");

        for k in KNOWN {
            if let Launch::Args(flags) = k.launch {
                assert_eq!(
                    flags.iter().filter(|f| f.contains("{dir}")).count(),
                    1,
                    "{} needs exactly one {{dir}} placeholder",
                    k.id
                );
            }
        }
    }

    /// The substitution has to work inside a flag (`--working-directory={dir}`,
    /// which is the only form Ghostty accepts) as well as standalone.
    #[test]
    fn dir_substitutes_inside_a_flag() {
        let ghostty = KNOWN.iter().find(|k| k.id == "ghostty").unwrap();
        let Launch::Args(flags) = ghostty.launch else {
            panic!("Ghostty ignores folder-open events — it must stay on Args");
        };
        let built: Vec<String> = flags.iter().map(|f| f.replace("{dir}", "/tmp/x")).collect();
        assert!(built.contains(&"--working-directory=/tmp/x".to_string()), "{built:?}");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn detected_apps_carry_their_own_icon() {
        // Terminal.app is the one bundle guaranteed present, and it ships a
        // standalone .icns — if this ever returns None, the sips extraction
        // broke and every picker row silently falls back to the glyph.
        let found = detect();
        let terminal = found.iter().find(|a| a.id == "terminal").unwrap();
        let icon = terminal.icon.as_deref().expect("no icon extracted for Terminal.app");
        assert!(icon.starts_with("data:image/png;base64,"), "{icon:.40}");
        assert!(icon.len() > 500, "icon suspiciously small: {} bytes", icon.len());
    }

    #[test]
    fn unknown_app_is_rejected_before_anything_launches() {
        let err = open_terminal_at("not-a-terminal".into(), "/tmp".into()).unwrap_err();
        assert!(err.contains("unknown terminal app"), "{err}");
    }

    #[test]
    fn missing_directory_is_rejected() {
        // Only meaningful where at least one terminal is installed; elsewhere
        // the "not installed" error fires first, which is also a rejection.
        let err = open_terminal_at("terminal".into(), "/nope/definitely/not/here".into())
            .unwrap_err();
        assert!(err.contains("no such directory") || err.contains("isn't installed"), "{err}");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn terminal_app_is_always_found_on_macos() {
        let found = detect();
        assert!(
            found.iter().any(|a| a.id == "terminal"),
            "Terminal.app ships with every Mac; detection found {found:?}",
        );
    }
}
