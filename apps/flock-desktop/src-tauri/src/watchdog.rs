//! Keeps flock's window usable when its web view is not.
//!
//! Everything flock draws lives in one WebKit web view, which runs in its own
//! process (WebContent). The agents do not: they live in this process, with
//! their terminals' output kept in the backend's rings. So when the web view
//! goes wrong, the symptom is "flock froze, but my agents keep working". That
//! is how it failed: with several busy Claude Code panes on screen, the web
//! view grew from 160 MB to 6 GB in under a minute in one test and to 16.9 GB
//! in another, until macOS was swapping it (no clicks land) and then killing
//! processes system-wide. The trigger was not deterministic; this module does
//! not need it to be. Every few seconds it:
//!
//! - asks the page to answer (`ui_pong`), and logs when the page is silent or
//!   reports that its own JavaScript was blocked;
//! - reads the web view process's memory and logs each new gigabyte;
//! - restarts the web view process when it passes a hard limit (a quarter of
//!   the Mac's memory, kept between 3 and 8 GB), or when the page has not
//!   answered for three minutes while it is on screen and this process's
//!   main thread is fine.
//!   WebKit reloads the page, and the restore path reattaches every agent that
//!   is still running (`restoreWorkspace` in App.tsx), so a restart costs a
//!   repaint, not an agent. At most once per ten minutes, so a page that keeps
//!   failing cannot be restarted in a loop;
//! - checks that this process's main thread still runs, and logs when it does
//!   not — the main thread runs every synchronous command and hands every
//!   message to the page, so it is the other way a window stops taking clicks.

use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

const TICK: Duration = Duration::from_secs(5);
/// The main thread counts as stalled once a probe has waited this long for
/// it: in practice, one that is still waiting a tick after it was sent.
const MAIN_STALL_MS: u64 = 4_000;
/// A silent page is logged after this long, then every 30 s while it lasts.
const SILENT_LOG_MS: u64 = 15_000;
/// A page silent this long, with a healthy main thread, is restarted.
const SILENT_RESTART_MS: u64 = 180_000;
const RESTART_COOLDOWN: Duration = Duration::from_secs(600);
const GB: u64 = 1 << 30;

static START: OnceLock<Instant> = OnceLock::new();
static LAST_PONG_MS: AtomicU64 = AtomicU64::new(0);
static LAST_MAIN_MS: AtomicU64 = AtomicU64::new(0);
static WEB_PID: AtomicI32 = AtomicI32::new(0);
static SHOWN: AtomicBool = AtomicBool::new(true);
static RECOVERY_NOTE: Mutex<Option<String>> = Mutex::new(None);

fn now_ms() -> u64 {
    START.get_or_init(Instant::now).elapsed().as_millis() as u64
}

/// The page's answer to a ping. `lag_ms` is how late its own one-second timer
/// ran since the last answer while the window was visible: how long its
/// JavaScript was blocked.
#[tauri::command]
pub async fn ui_pong(lag_ms: u64) {
    LAST_PONG_MS.store(now_ms(), Ordering::Relaxed);
    if lag_ms >= 2_000 {
        tracing::warn!(target: "flock_desktop_lib::watchdog", "the page's JavaScript was blocked for {lag_ms} ms");
    }
}

/// Why the window was restarted, once, for the page that comes back.
#[tauri::command]
pub async fn take_recovery_note() -> Option<String> {
    RECOVERY_NOTE.lock().ok()?.take()
}

pub fn start(app: AppHandle) {
    let _ = std::thread::Builder::new()
        .name("flock-watchdog".into())
        .spawn(move || run(app));
}

/// What the watchdog should do about the web view right now.
#[derive(Debug, PartialEq)]
pub(crate) enum Verdict {
    Fine,
    Restart(String),
}

/// The restart decision, kept pure so it can be tested. `rss` is the web view
/// process's resident memory, `silent_ms` how long since the page answered,
/// `main_ms` how long since the main thread last ran.
pub(crate) fn verdict(rss: Option<u64>, limit: u64, silent_ms: u64, main_ms: u64) -> Verdict {
    if let Some(bytes) = rss.filter(|b| *b > limit) {
        return Verdict::Restart(format!("it had grown to {:.1} GB", bytes as f64 / GB as f64));
    }
    // Only when this process's own main thread is fine: a page that cannot be
    // reached because the main thread is stuck is not the page's fault, and
    // restarting it would not help.
    if silent_ms > SILENT_RESTART_MS && main_ms < MAIN_STALL_MS {
        return Verdict::Restart(format!("it had not responded for {} s", silent_ms / 1000));
    }
    Verdict::Fine
}

/// A quarter of the Mac's memory, kept between 3 and 8 GB. A healthy flock
/// window uses a few hundred MB.
pub(crate) fn hard_limit(physical: u64) -> u64 {
    (physical / 4).clamp(3 * GB, 8 * GB)
}

fn physical_memory() -> u64 {
    std::process::Command::new("/usr/sbin/sysctl")
        .args(["-n", "hw.memsize"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse().ok())
        .unwrap_or(16 * GB)
}

fn resident_bytes(pid: i32) -> Option<u64> {
    let out = std::process::Command::new("/bin/ps")
        .args(["-o", "rss=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    let kb: u64 = String::from_utf8_lossy(&out.stdout).trim().parse().ok()?;
    Some(kb * 1024)
}

/// The web view's content process, from WebKit's `_webProcessIdentifier`: a
/// private but long-standing WKWebView property, checked for before use.
#[cfg(target_os = "macos")]
fn web_process_id(webview: *mut std::ffi::c_void) -> i32 {
    use objc2::runtime::AnyObject;
    use objc2::{msg_send, sel};
    let wv = webview as *mut AnyObject;
    if wv.is_null() {
        return 0;
    }
    unsafe {
        let responds: bool = msg_send![wv, respondsToSelector: sel!(_webProcessIdentifier)];
        if !responds {
            return 0;
        }
        let pid: i32 = msg_send![wv, _webProcessIdentifier];
        pid
    }
}

#[cfg(not(target_os = "macos"))]
fn web_process_id(_webview: *mut std::ffi::c_void) -> i32 {
    0
}

fn run(app: AppHandle) {
    // FLOCK_WATCHDOG_LIMIT_MB lowers the limit, to exercise a restart in a test.
    let limit = std::env::var("FLOCK_WATCHDOG_LIMIT_MB")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .map(|mb| mb << 20)
        .unwrap_or_else(|| hard_limit(physical_memory()));
    tracing::info!(target: "flock_desktop_lib::watchdog", "watching the window (restart above {} MB)", limit >> 20);
    LAST_PONG_MS.store(now_ms(), Ordering::Relaxed);
    LAST_MAIN_MS.store(now_ms(), Ordering::Relaxed);

    let mut last_tick = Instant::now();
    let mut logged_gb = 0u64;
    let mut silent_logged_at = 0u64;
    // When the last main-thread probe was sent, and whether one was late.
    let mut probe_sent = 0u64;
    let mut main_stalled = false;
    let mut last_restart: Option<Instant> = None;
    let mut held_back = false;
    let mut seen_pid = 0i32;

    loop {
        std::thread::sleep(TICK);
        // A long gap means the Mac slept (or this thread was starved): every
        // clock is stale, and a page that "did not answer" was simply asleep.
        if last_tick.elapsed() > TICK * 4 {
            LAST_PONG_MS.store(now_ms(), Ordering::Relaxed);
            LAST_MAIN_MS.store(now_ms(), Ordering::Relaxed);
            last_tick = Instant::now();
            continue;
        }
        last_tick = Instant::now();
        let t = now_ms();

        // The main thread: has the probe sent last tick run yet? It only has
        // to be picked up, so anything near a whole tick is a stall.
        let ran = LAST_MAIN_MS.load(Ordering::Relaxed);
        let waiting = ran < probe_sent;
        let main_ms = if waiting { t.saturating_sub(probe_sent) } else { 0 };
        if main_ms >= MAIN_STALL_MS {
            if !main_stalled {
                tracing::warn!(target: "flock_desktop_lib::watchdog", "the main thread has not run for {} s", main_ms / 1000);
                main_stalled = true;
            }
        } else if main_stalled && !waiting {
            tracing::warn!(target: "flock_desktop_lib::watchdog", "the main thread ran again after {} s", ran.saturating_sub(probe_sent) / 1000);
            main_stalled = false;
        }
        let Some(window) = app.get_webview_window("main") else { continue };
        // Nothing more is queued for a main thread that has not taken the last.
        if !waiting {
            let probe = window.clone();
            probe_sent = now_ms();
            let _ = app.run_on_main_thread(move || {
                LAST_MAIN_MS.store(now_ms(), Ordering::Relaxed);
                // On the main thread these getters answer directly.
                let shown = probe.is_visible().unwrap_or(true) && !probe.is_minimized().unwrap_or(false);
                SHOWN.store(shown, Ordering::Relaxed);
            });
            // Re-read every tick: a restarted web view is a new process.
            let _ = window.with_webview(|wv| WEB_PID.store(web_process_id(wv.inner()), Ordering::Relaxed));
            let _ = window.eval("window.__flockPing && window.__flockPing()");
        }
        // A hidden or minimized window is not expected to answer promptly.
        if !SHOWN.load(Ordering::Relaxed) {
            LAST_PONG_MS.store(t, Ordering::Relaxed);
        }

        let pid = WEB_PID.load(Ordering::Relaxed);
        let rss = if pid > 0 { resident_bytes(pid) } else { None };
        if pid > 0 && pid != seen_pid {
            // A new process outside a restart of ours means WebKit's own
            // crashed or was killed, which is worth knowing when reading a log.
            let mb = rss.map(|b| b >> 20).unwrap_or(0);
            tracing::info!(target: "flock_desktop_lib::watchdog", "the window's web view is process {pid} ({mb} MB)");
            seen_pid = pid;
        }
        if let Some(bytes) = rss {
            let gb = bytes / GB;
            if gb > logged_gb {
                tracing::warn!(target: "flock_desktop_lib::watchdog", "the window's web view (process {pid}) uses {:.1} GB", bytes as f64 / GB as f64);
            }
            logged_gb = gb;
        }

        let silent_ms = t.saturating_sub(LAST_PONG_MS.load(Ordering::Relaxed));
        if silent_ms > SILENT_LOG_MS && t.saturating_sub(silent_logged_at) > 30_000 {
            tracing::warn!(target: "flock_desktop_lib::watchdog", "the page has not answered for {} s", silent_ms / 1000);
            silent_logged_at = t;
        }

        if let Verdict::Restart(reason) = verdict(rss, limit, silent_ms, main_ms) {
            if pid <= 0 {
                continue;
            }
            if last_restart.is_some_and(|at| at.elapsed() < RESTART_COOLDOWN) {
                if !held_back {
                    tracing::warn!(target: "flock_desktop_lib::watchdog", "not restarting the web view again ({reason}): it was restarted less than ten minutes ago");
                    held_back = true;
                }
                continue;
            }
            tracing::warn!(target: "flock_desktop_lib::watchdog", "restarting the web view (process {pid}) because {reason}; the agents keep running");
            if let Ok(mut note) = RECOVERY_NOTE.lock() {
                *note = Some(format!("flock restarted its window because {reason}. Your agents kept running."));
            }
            // WebKit sees its content process end and reloads the page.
            let _ = std::process::Command::new("/bin/kill").args(["-9", &pid.to_string()]).status();
            last_restart = Some(Instant::now());
            held_back = false;
            logged_gb = 0;
            LAST_PONG_MS.store(now_ms(), Ordering::Relaxed);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_normal_window_is_left_alone() {
        assert_eq!(verdict(Some(400 << 20), 4 * GB, 2_000, 100), Verdict::Fine);
        assert_eq!(verdict(None, 4 * GB, 2_000, 100), Verdict::Fine);
    }

    #[test]
    fn a_ballooned_web_view_is_restarted_even_while_it_answers() {
        assert!(matches!(verdict(Some(5 * GB), 4 * GB, 1_000, 100), Verdict::Restart(r) if r.contains("5.0 GB")));
    }

    #[test]
    fn a_silent_page_is_restarted_only_when_the_main_thread_is_fine() {
        assert!(matches!(verdict(Some(GB), 4 * GB, 181_000, 100), Verdict::Restart(r) if r.contains("181 s")));
        assert_eq!(verdict(Some(GB), 4 * GB, 181_000, 30_000), Verdict::Fine);
        assert_eq!(verdict(Some(GB), 4 * GB, 60_000, 100), Verdict::Fine);
    }

    #[test]
    fn the_limit_is_a_quarter_of_memory_within_bounds() {
        assert_eq!(hard_limit(8 * GB), 3 * GB);
        assert_eq!(hard_limit(16 * GB), 4 * GB);
        assert_eq!(hard_limit(24 * GB), 6 * GB);
        assert_eq!(hard_limit(64 * GB), 8 * GB);
    }
}
