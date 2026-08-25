mod agent_session;
mod auth_callback;
mod bundle;
mod claude_code_usage;
mod claude_context;
mod claude_usage;
mod clipboard_image;
mod codex_usage;
mod commands;
mod opencode_stats;
mod events;
mod git;
mod github;
mod graph;
mod grok_context;
mod grok_usage;
mod hooks;
mod pr_watch;
mod provenance;
mod pty_bridge;
mod state;
mod terminals;
mod voice;
mod worktree;
mod worktree_setup;

use flock_core::WorkspaceManager;
use state::AppState;
use std::{collections::HashMap, path::{Path, PathBuf}, sync::Arc};
use tauri::{Emitter, Manager};
use tokio::sync::RwLock;

/// How long quitting waits for `docker rm -f` to clear this run's jails.
/// Generous for a healthy daemon (a handful of removals is well under a
/// second) and short enough that a wedged one is a pause, not a hang.
const EXIT_REAP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // First statement, before anything can read a container path. Resolving
    // the shared directory is what injects it into flock-pty
    // (`container::set_shared_dir`), and until that has happened
    // `host_flock_dir()` answers `None`: the build context refuses to write,
    // jailed hook logs have nowhere to go, and `egress::policy` fails closed
    // and logs. Today the ordering also holds by accident — the migration is
    // logged a few lines down — but "by accident" is how the pre-rebrand
    // version of this went wrong, and a debug build's `data_dir()` never
    // touches the shared resolver at all.
    let _ = flock_core::paths::shared_data_dir();
    if let Some(log_path) = log_path() {
        roll_log(&log_path);
        if let Ok(file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
        {
            // NOTE: the crate is named `flock-desktop` in Cargo.toml but its
            // `[lib] name` (and therefore every tracing target string emitted
            // from this file) is `flock_desktop_lib` — a bare "flock=debug"
            // filter does NOT match that target (EnvFilter matches whole
            // `::`-delimited segments, not substrings), so every log line from
            // this crate was being silently dropped. List all our crates
            // explicitly instead of relying on a prefix match.
            let _ = tracing_subscriber::fmt()
                .with_writer(file)
                .with_env_filter(
                    tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
                        tracing_subscriber::EnvFilter::new(
                            "flock_desktop_lib=debug,flock_core=debug,flock_pty=debug",
                        )
                    }),
                )
                .try_init();
        }
    }

    log_data_dir_migration();

    // An install that predates the rebrand is still /Applications/Clarence.app,
    // which is the name macOS shows in Finder, the Dock and the privacy panes.
    // Rename it before anything else: the re-exec below is only free while no
    // window, PTY or database handle exists yet.
    if let Some(exe) = bundle::rename_to_flock() {
        // current_exe() still reports the path this process was exec'd from,
        // which no longer exists — and that is the path the updater unpacks
        // over. Come back up from the new one instead of running a session that
        // cannot install an update. Same mechanism Tauri's own restart uses.
        let args: Vec<_> = std::env::args_os().skip(1).collect();
        match std::process::Command::new(&exe).args(args).spawn() {
            Ok(_) => return,
            // The bundle moved but the relaunch didn't take. Carry on in this
            // process: a running app beats an exited one, and the next launch
            // starts cleanly from the new path.
            Err(e) => tracing::warn!(
                target: "flock_desktop_lib",
                exe = %exe.display(),
                error = %e,
                "could not relaunch from the renamed bundle; continuing"
            ),
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        // Auto-update: the frontend calls check()/downloadAndInstall() via the
        // JS plugin; relaunch after install needs the process plugin.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // Clipboard writes go through NSPasteboard directly — WKWebView's
        // navigator.clipboard rejects when the document isn't focused, which
        // silently dropped copies (see src/lib/clipboard.ts).
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let state = match tauri::async_runtime::block_on(init_state()) {
                Ok(state) => state,
                Err(e) => {
                    // Say it in words, in a window. This runs before any window
                    // exists, so the panic that used to be here read as a bounce
                    // off the Dock: nothing on screen, and the reason only in a
                    // log file inside the very directory that just failed to
                    // open. A locked or corrupt database is also the one startup
                    // failure a user can actually act on, which is why the path
                    // is in the message.
                    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
                    tracing::error!(target: "flock_desktop_lib", error = %e, "could not initialize state");
                    app.dialog()
                        .message(format!(
                            "flock could not open its workspace database.\n\n{e}\n\n\
                             It lives in {}. Quitting any other copy of flock and \
                             reopening usually clears this.",
                            data_dir().display()
                        ))
                        .kind(MessageDialogKind::Error)
                        .title("flock can't start")
                        .blocking_show();
                    std::process::exit(1);
                }
            };
            // Sessions the previous run never got to close (a crash, a
            // force-quit, a laptop that slept and never woke) are closed out at
            // their last recorded activity before anything can spawn a new one.
            // Left alone they read as still running, and every duration derived
            // from them grows for the life of the install.
            {
                let wm = std::sync::Arc::clone(&state.wm);
                tauri::async_runtime::block_on(provenance::close_orphans(&wm));
            }
            app.manage(state);
            build_menu(app.handle())?;
            hooks::refresh_installed();
            hooks::ensure_grok();
            hooks::spawn_watcher(app.handle().clone());
            // Leftover secure-pane containers first, then the egress proxies
            // that served them. `--rm` does not fire when the docker client is
            // killed, so a force-quit leaves the jail running; restore would
            // then start a second agent on the same bind-mount. Only collects
            // jails whose owner process is gone, so a second flock's live
            // panes stay up. Proxies after panes: a leftover pane on the
            // network would otherwise keep its proxy alive. Blocking docker
            // calls, hence off the setup thread.
            std::thread::spawn(|| {
                if let Some(docker) = flock_pty::container::docker_path() {
                    flock_pty::container::reap_orphan_panes(&docker);
                    flock_pty::egress::reap_orphan_proxies(&docker);
                }
            });
            // Keep a copy of the knowledge graph outside its Docker volume.
            // No-ops quietly for the majority who never turn the graph on.
            graph::spawn_auto_backup(None);
            // Ship flock's Claude Code custom themes into ~/.claude/themes so
            // host-launched agents can select a theme matching the workspace.
            // Best-effort: a missing $HOME must not block startup.
            if let Err(e) = flock_pty::themes::install_host() {
                tracing::warn!(target: "flock_desktop_lib", "failed to install Claude Code themes: {e}");
            }
            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id() == "settings" {
                let _ = app.emit("menu://settings", ());
            }
        })
        .on_window_event(|window, event| {
            // Detect a popped-out pane window (label "pane-{id}") going away
            // at the native window-lifecycle level, rather than relying on
            // that window's own JS to emit a notification from inside its
            // close-requested handler — emitting from within that handler
            // risks contending with Tauri's own close-negotiation state for
            // the same window, which was hanging the whole app instead of
            // just closing it.
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if let Some(pane_id) = window.label().strip_prefix("pane-") {
                    let pane_id = pane_id.to_string();
                    let app = window.app_handle().clone();
                    tauri::async_runtime::spawn(async move {
                        let state = app.state::<AppState>();
                        // If the pane still exists, the window was just
                        // dismissed (not explicitly closed via the popout's
                        // own "close agent" button, which removes it from
                        // state itself before destroying the window) — bring
                        // the still-alive pane back into its workspace grid.
                        let workspace_id = {
                            let panes = state.panes.read().await;
                            panes.get(&pane_id).map(|e| e.workspace_id.clone())
                        };
                        if let Some(workspace_id) = workspace_id {
                            let _ = app.emit(
                                "pane-popout-closed",
                                serde_json::json!({
                                    "workspaceId": workspace_id,
                                    "paneId": pane_id,
                                    "action": "return",
                                }),
                            );
                        }
                    });
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::debug_log,
            commands::list_workspaces,
            commands::create_workspace,
            commands::reorder_workspaces,
            commands::list_panes,
            commands::spawn_pane,
            commands::container_status,
            commands::egress_policy,
            commands::set_egress_policy,
            commands::agent_cli_status,
            commands::send_input,
            commands::stage_image_bytes,
            commands::stage_image_file,
            commands::subscribe_pane_output,
            commands::unsubscribe_pane_output,
            commands::ack_pane_attention,
            commands::persist_pane_buffers,
            commands::get_persisted_pane_buffer,
            commands::resize_pty,
            commands::close_pane,
            commands::get_agent_pref,
            commands::set_agent_pref,
            commands::has_claude_session,
            commands::claude_session_exists,
            commands::capture_agent_session,
            commands::cwd,
            terminals::list_terminal_apps,
            terminals::open_terminal_at,
            commands::github_check,
            commands::github_store_pat,
            claude_usage::claude_usage,
            claude_code_usage::claude_code_usage,
            claude_code_usage::claude_spend_windows,
            claude_context::claude_context_usage,
            codex_usage::codex_usage,
            grok_usage::grok_usage,
            opencode_stats::opencode_stats,
            commands::github_oauth_start,
            commands::github_oauth_poll,
            commands::github_disconnect,
            commands::github_list_prs,
            commands::github_list_friends,
            commands::github_list_repos,
            commands::github_pr_details,
            commands::github_pr_diff,
            commands::github_workspace_checks,
            commands::github_workspace_prs,
            commands::github_repo_web_url,
            commands::github_checkout_pr,
            commands::github_checkout_pr_worktree,
            commands::github_approve_pr,
            commands::github_merge_pr,
            commands::pr_watch_get_config,
            commands::pr_watch_set_config,
            commands::pr_watch_poll,
            commands::pr_review_set_summary,
            commands::pr_review_get_summaries,
            commands::summarize_review,
            commands::merge_queue_list,
            commands::merge_queue_add,
            commands::merge_queue_remove,
            commands::merge_queue_reorder,
            commands::merge_queue_tick,
            commands::merge_queue_inspect,
            commands::github_update_pr_branch,
            commands::save_workspace_state,
            commands::restore_workspace,
            commands::rename_workspace,
            commands::delete_workspace,
            commands::has_github_token,
            commands::get_identity,
            commands::set_handle,
            commands::list_friends,
            commands::add_friend,
            commands::remove_friend,
            commands::voice_get_enabled,
            commands::voice_set_enabled,
            commands::voice_model_status,
            commands::voice_download_model,
            commands::voice_available_models,
            commands::voice_get_model,
            commands::voice_set_model,
            commands::voice_list_input_devices,
            commands::voice_get_input_device,
            commands::voice_set_input_device,
            commands::voice_get_language,
            commands::voice_set_language,
            commands::voice_get_vocab,
            commands::voice_set_vocab,
            commands::voice_get_cleanup,
            commands::voice_set_cleanup,
            commands::voice_start_recording,
            commands::voice_stop_recording,
            commands::voice_prewarm,
            commands::voice_get_stats,
            commands::create_worktree,
            commands::remove_worktree,
            commands::checkout_in_worktree,
            commands::git_overview,
            commands::git_working_diff,
            commands::current_branch,
            commands::git_repo_map,
            commands::git_branch_options,
            commands::worktree_setup_get,
            commands::worktree_setup_set,
            commands::git_fetch_base,
            commands::branch_unmerged_count,
            commands::git_head_sha,
            commands::git_diff_against,
            commands::git_commit_all,
            commands::git_merge_branch,
            commands::summarize_intent,
            commands::install_agent_hook,
            commands::uninstall_agent_hook,
            commands::agent_hook_status,
            commands::auth_callback_listen,
            commands::graph_status,
            commands::graph_up,
            commands::graph_insights,
            commands::graph_down,
            commands::graph_overview,
            commands::graph_list_nodes,
            commands::graph_recall,
            commands::graph_node_neighbors,
            commands::graph_subgraph,
            commands::graph_brief,
            commands::graph_mirror_membership,
            commands::graph_mcp_config,
            commands::graph_ground_hook,
            commands::read_clipboard_image,
            commands::read_image_files,
            commands::queue_add,
            commands::queue_list,
            commands::queue_update_text,
            commands::queue_delete,
            commands::queue_launch,
            provenance::provenance_report,
            provenance::provenance_export,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            // Best-effort: once we exit, our live jails become leftovers.
            // Another flock's owner-pid is still alive, so those stay.
            // Exit, not ExitRequested: the latter is preventable, and a hung
            // docker would freeze quit. Blocking docker calls, hence off the
            // event-loop thread — same as startup.
            if matches!(event, tauri::RunEvent::Exit) {
                // Wait for the rm, but not forever. The work has to finish
                // before the process is gone, so this blocks — and a plain
                // `join()` would put a hung or wedged docker daemon directly
                // in front of the user's quit, which is a worse bug than the
                // leftover container it is trying to remove. Bounded wait
                // instead: the thread is detached on timeout, the next launch
                // reaps whatever it did not get to (`reap_orphan_panes`), and
                // quitting stays something that always works.
                let (done_tx, done_rx) = std::sync::mpsc::channel();
                std::thread::spawn(move || {
                    if let Some(docker) = flock_pty::container::docker_path() {
                        flock_pty::container::reap_owned_panes(&docker);
                    }
                    let _ = done_tx.send(());
                });
                if done_rx.recv_timeout(EXIT_REAP_TIMEOUT).is_err() {
                    tracing::warn!(
                        target: "flock_desktop_lib",
                        "docker did not finish removing this run's jails in {EXIT_REAP_TIMEOUT:?}; the next launch will reap them"
                    );
                }
            }
        });
}

async fn init_state() -> anyhow::Result<AppState> {
    let dir = data_dir();
    std::fs::create_dir_all(&dir)?;
    // `db_path_in`, not a bare join: a data dir that predates the rebrand (a
    // failed migration, or a FLOCK_DATA_DIR still pointing at an old one) holds
    // `clarence.db`, and opening `flock.db` there would create an empty
    // database beside the user's real one.
    let db_path = flock_core::paths::db_path_in(&dir);
    let queue_images_dir = dir.join("queue-images");
    std::fs::create_dir_all(&queue_images_dir)?;
    let pool = flock_core::db::init_pool(&db_path).await?;
    let wm = Arc::new(WorkspaceManager::new(pool));
    Ok(AppState {
        wm,
        panes: Arc::new(RwLock::new(HashMap::new())),
        voice: Arc::new(voice::VoiceState::default()),
        queue_images_dir,
    })
}

fn home_dir() -> PathBuf {
    flock_core::paths::home_dir()
}

/// Workspace DB + log location. Precedence:
///   1. FLOCK_DATA_DIR (or the deprecated CLARENCE_DATA_DIR), if set — an
///      explicit override for either build.
///   2. Debug builds (`tauri dev`) → ~/.flock-dev, isolated by default so a
///      dev instance run alongside the installed app doesn't restore the same
///      saved workspaces and re-spawn duplicate agents into the same repos.
///   3. Release builds → the shared ~/.flock.
/// GitHub token, voice models, and the graph engine deliberately stay shared
/// (they read ~/.flock directly): they're machine-level, not
/// instance-level, and duplicating them costs more than it isolates.
///
/// Cases 2 and 3 both go through the `~/.clarence` migration in flock-core; the
/// dev directory was renamed by the same rebrand and would otherwise strand a
/// developer's local workspaces just as thoroughly as the shared one.
fn data_dir() -> PathBuf {
    let explicit = std::env::var("FLOCK_DATA_DIR")
        // Deprecated: drop the CLARENCE_* fallback a few releases out, once
        // nobody's launch agent or shell profile still exports it.
        .or_else(|_| std::env::var("CLARENCE_DATA_DIR"))
        .ok()
        .filter(|d| !d.trim().is_empty());

    match explicit {
        Some(dir) => PathBuf::from(dir),
        None if cfg!(debug_assertions) => {
            let home = home_dir();
            flock_core::paths::resolve_dir(&home.join(".clarence-dev"), &home.join(".flock-dev")).dir
        }
        None => flock_core::paths::shared_data_dir(),
    }
}

/// Report how the shared data directory got where it is. Called once tracing is
/// up: the migration itself has to run before that, because the log file it
/// would write to lives inside the directory being migrated.
fn log_data_dir_migration() {
    use flock_core::paths::Migration;
    let outcome = flock_core::paths::shared_data_dir_outcome();
    let dir = outcome.dir.display();
    match &outcome.migration {
        Migration::NotNeeded => {}
        Migration::Moved => tracing::info!(dir = %dir, "migrated ~/.clarence to ~/.flock"),
        Migration::Copied => tracing::info!(
            dir = %dir,
            "copied ~/.clarence to ~/.flock; the old directory was left in place and can be removed by hand"
        ),
        Migration::Failed(err) => tracing::warn!(
            dir = %dir,
            error = %err,
            "could not migrate ~/.clarence to ~/.flock; still reading the old location"
        ),
    }
    if let Some(err) = &outcome.db_rename_error {
        tracing::warn!(error = %err, "could not rename clarence.db to flock.db; opening the old name");
    }
}

fn log_path() -> Option<PathBuf> {
    let dir = data_dir();
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("desktop.log"))
}

/// Size above which the log is rolled aside at launch.
const MAX_LOG_BYTES: u64 = 8 * 1024 * 1024;

/// Keep one previous log and start a fresh one, so `desktop.log` cannot grow
/// for the life of the install.
///
/// At launch only, which is the whole design: the subscriber holds an open
/// handle for the session, so rolling underneath it would write into an unlinked
/// inode until the next restart. A session long enough to matter is rare, and
/// the cost of getting it wrong — losing the log a user is being asked to send
/// — is worse than a large file.
///
/// One generation is deliberate. The previous log is what a bug report needs;
/// the one before that has never been asked for. Best-effort throughout: no log
/// rotation is worth failing a launch over.
fn roll_log(path: &Path) {
    let Ok(meta) = std::fs::metadata(path) else { return };
    if meta.len() <= MAX_LOG_BYTES {
        return;
    }
    // rename, not copy: atomic, and it cannot half-succeed into a truncated
    // previous log.
    let _ = std::fs::rename(path, path.with_extension("log.1"));
}

/// Build the native menu bar. Replaces Tauri's bare default so the app
/// (flock) submenu carries a "Settings…" item — otherwise Preferences is
/// unreachable from the menu bar entirely.
fn build_menu(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};

    let settings_item = MenuItemBuilder::with_id("settings", "Settings…")
        .accelerator("CmdOrCtrl+,")
        .build(app)?;

    let app_menu = SubmenuBuilder::new(app, "flock")
        .item(&PredefinedMenuItem::about(app, Some("About flock"), None)?)
        .separator()
        .item(&settings_item)
        .separator()
        .item(&PredefinedMenuItem::services(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::hide(app, None)?)
        .item(&PredefinedMenuItem::hide_others(app, None)?)
        .item(&PredefinedMenuItem::show_all(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, Some("Quit flock"))?)
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .build()?;

    let window_menu = SubmenuBuilder::new(app, "Window")
        .item(&PredefinedMenuItem::minimize(app, None)?)
        .item(&PredefinedMenuItem::close_window(app, None)?)
        .build()?;

    let menu = MenuBuilder::new(app)
        .item(&app_menu)
        .item(&edit_menu)
        .item(&window_menu)
        .build()?;

    app.set_menu(menu)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn scratch(label: &str) -> PathBuf {
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "flock-log-{}-{}-{}",
            label,
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn an_oversized_log_is_rolled_aside() {
        let dir = scratch("big");
        let log = dir.join("desktop.log");
        std::fs::write(&log, vec![b'x'; (MAX_LOG_BYTES + 1) as usize]).unwrap();

        roll_log(&log);

        // The current log is gone rather than truncated: the caller reopens it
        // with create(true), and the previous one is what a bug report needs.
        assert!(!log.exists());
        assert_eq!(
            std::fs::metadata(dir.join("desktop.log.1")).unwrap().len(),
            MAX_LOG_BYTES + 1
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_normal_log_is_left_alone() {
        let dir = scratch("small");
        let log = dir.join("desktop.log");
        std::fs::write(&log, b"one line\n").unwrap();

        roll_log(&log);

        assert_eq!(std::fs::read(&log).unwrap(), b"one line\n");
        assert!(!dir.join("desktop.log.1").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rolling_twice_keeps_one_generation() {
        let dir = scratch("gen");
        let log = dir.join("desktop.log");

        std::fs::write(&log, vec![b'a'; (MAX_LOG_BYTES + 1) as usize]).unwrap();
        roll_log(&log);
        std::fs::write(&log, vec![b'b'; (MAX_LOG_BYTES + 1) as usize]).unwrap();
        roll_log(&log);

        // Deliberate: the older generation is overwritten, not kept as .2. It
        // has never been the one anyone asks for.
        let kept = std::fs::read(dir.join("desktop.log.1")).unwrap();
        assert_eq!(kept[0], b'b');
        assert!(!dir.join("desktop.log.2").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_log_is_not_an_error() {
        let dir = scratch("missing");
        roll_log(&dir.join("desktop.log")); // must not panic
        let _ = std::fs::remove_dir_all(&dir);
    }
}
