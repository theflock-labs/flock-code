// Push-to-talk voice-to-text (MVP: in-app only — see plan). Local Whisper
// inference via whisper-rs, mic capture via cpal. Transcribed text is typed
// into the focused pane's PTY by the frontend, same path as normal input.

use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc as std_mpsc, Arc, Mutex as StdMutex,
    },
    thread::JoinHandle,
    time::Instant,
};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex as AsyncMutex;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

const WHISPER_SAMPLE_RATE: u32 = 16_000;
const DEFAULT_MODEL_ID: &str = "base.en";

/// A whisper segment must have ended at least this long before the current
/// window's tail to be "committed" (finalized). Whisper breaks segments at
/// natural pauses, so once a segment is this far in the past it's stable and
/// safe to cut the audio there — cutting at silence is the one place chunked
/// decoding doesn't hurt accuracy. This lag is the core latency lever: on
/// release only the *uncommitted* tail (≤ ~this many seconds of audio) is
/// decoded, instead of the whole clip from scratch.
const COMMIT_LAG_SECS: f64 = 1.0;

/// Safety valve for speech with no pauses: if the uncommitted window grows past
/// this, force-commit down to the last 0.5s so per-pass (and final) decode work
/// stays bounded even during a long unbroken monologue.
const MAX_WINDOW_SECS: f64 = 20.0;

/// Hard ceiling on a single recording. Capture appends to a `Vec<f32>` at
/// `sample_rate × channels × 4` bytes/sec — ~384 KB/s at a typical 48 kHz
/// stereo mic, i.e. ~1.4 GB/hour — and the hands-free lock (tap to start, tap
/// again to stop) makes it easy to leave one running unattended. That is how a
/// long-lived app reached 10 GB resident. Streaming mode also drops committed
/// audio as it goes (see `stream_loop`), which keeps a normal dictation near
/// `MAX_WINDOW_SECS` of samples; this ceiling is the backstop for the
/// non-streaming path, where nothing is ever committed and the whole clip is
/// decoded in one pass on release.
const MAX_RECORDING_SECS: usize = 300;

/// Capture buffer pre-allocation. Growing a multi-megabyte `Vec` by doubling
/// means repeatedly reallocating and memcpying the whole clip, which is both
/// wasted work in the audio path and the main source of large-allocation churn
/// this process showed in `vmmap`. Reserve a normal utterance up front.
const CAPTURE_PREALLOC_SECS: usize = 30;

/// Voice models and preferences live in the shared `~/.flock`, not the
/// instance-scoped data dir: a 150 MB model download is machine-level, and a
/// dev build re-downloading it to isolate itself would be absurd. flock-core
/// owns the path so the `~/.clarence` migration happens exactly once.
fn data_dir() -> PathBuf {
    flock_core::paths::shared_data_dir()
}

fn model_dir() -> PathBuf {
    data_dir().join("whisper-models")
}

fn enabled_pref_path() -> PathBuf {
    data_dir().join("voice_enabled")
}

fn model_pref_path() -> PathBuf {
    data_dir().join("voice_model")
}

// ─── Model selection ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct VoiceModelOption {
    pub id: String,
    pub label: String,
    pub size_mb: u32,
}

/// ggml model tiers from the whisper.cpp HF mirror, English-only variants
/// (smaller + faster than multilingual for dictation use).
pub fn available_models() -> Vec<VoiceModelOption> {
    vec![
        VoiceModelOption { id: "tiny.en".into(), label: "Tiny — fastest".into(), size_mb: 75 },
        VoiceModelOption { id: "base.en".into(), label: "Base — recommended".into(), size_mb: 148 },
        VoiceModelOption { id: "small.en".into(), label: "Small — most accurate".into(), size_mb: 488 },
        VoiceModelOption { id: "large-v3-turbo-q5_0".into(), label: "Turbo — multilingual".into(), size_mb: 574 },
    ]
}

pub fn get_model() -> String {
    std::fs::read_to_string(model_pref_path())
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_MODEL_ID.to_string())
}

pub fn set_model(id: String) -> Result<(), String> {
    let allowed: &[&str] = &["tiny.en", "base.en", "small.en", "large-v3-turbo-q5_0"];
    let id = id.trim().to_string();
    if !allowed.contains(&id.as_str()) {
        return Err(format!(
            "invalid model id '{}'; allowed: {}",
            id,
            allowed.join(", ")
        ));
    }
    let dir = data_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(model_pref_path(), &id).map_err(|e| e.to_string())
}

/// Whether live streaming preview pays off for this model. The `stream_loop`
/// design assumes a decode pass finishes inside its ~400ms cadence so segments
/// commit as you speak and the release pass only touches the tail. That holds
/// for the small English encoders; the larger ones (`small.en`, the multilingual
/// `large-v3-turbo`) take *seconds* per pass — Whisper's encoder runs over a
/// fixed 30s window, so cost tracks model size, not utterance length. The loop
/// then can't keep up, pins every core, and (worse) leaves an in-flight pass
/// running when you release, doubling the final pass's latency. For those we
/// skip streaming entirely and decode the whole clip once on release.
fn model_supports_streaming(id: &str) -> bool {
    matches!(id, "tiny.en" | "base.en")
}

fn model_file_name(id: &str) -> String {
    format!("ggml-{id}.bin")
}

fn model_url(id: &str) -> String {
    format!(
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/{}",
        model_file_name(id)
    )
}

fn model_path_for(id: &str) -> PathBuf {
    model_dir().join(model_file_name(id))
}

fn model_path() -> PathBuf {
    model_path_for(&get_model())
}

fn stats_path() -> PathBuf {
    data_dir().join("voice_stats.json")
}

fn input_device_pref_path() -> PathBuf {
    data_dir().join("voice_input_device")
}

// ─── Input device (microphone) selection ───────────────────────────────────

/// Names of available microphone input devices, via cpal. First entry is
/// always the currently-selected one's marker via `get_input_device()`
/// matching by name — device *names* aren't stable identifiers across
/// reboots/reconnects on every platform, but it's what cpal exposes and is
/// good enough for a user-facing picker (falls back to the system default
/// automatically if the named device disappears).
pub fn list_input_devices() -> Vec<String> {
    use cpal::traits::{DeviceTrait, HostTrait};
    let host = cpal::default_host();
    match host.input_devices() {
        Ok(devices) => devices.filter_map(|d| d.name().ok()).collect(),
        Err(e) => {
            tracing::warn!("voice: failed to list input devices: {e}");
            Vec::new()
        }
    }
}

/// `None` means "use the system default input device".
pub fn get_input_device() -> Option<String> {
    std::fs::read_to_string(input_device_pref_path())
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

pub fn set_input_device(name: Option<String>) -> Result<(), String> {
    let dir = data_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    match name {
        Some(n) if !n.trim().is_empty() => {
            std::fs::write(input_device_pref_path(), n.trim()).map_err(|e| e.to_string())
        }
        _ => {
            let p = input_device_pref_path();
            if p.exists() {
                std::fs::remove_file(p).map_err(|e| e.to_string())
            } else {
                Ok(())
            }
        }
    }
}

// ─── Language / vocabulary / transcript cleanup ─────────────────────────────

fn language_pref_path() -> PathBuf {
    data_dir().join("voice_language")
}

fn vocab_pref_path() -> PathBuf {
    data_dir().join("voice_vocab")
}

fn cleanup_pref_path() -> PathBuf {
    data_dir().join("voice_cleanup")
}

/// "auto" (detect per dictation) or an ISO 639-1 code. English-only models
/// (`*.en`) ignore this and always transcribe English.
pub fn get_language() -> String {
    std::fs::read_to_string(language_pref_path())
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "auto".to_string())
}

pub fn set_language(lang: String) -> Result<(), String> {
    let lang = lang.trim().to_lowercase();
    let ok = lang == "auto" || (lang.len() == 2 && lang.chars().all(|c| c.is_ascii_lowercase()));
    if !ok {
        return Err(format!("invalid language '{lang}': use 'auto' or a two-letter code"));
    }
    let dir = data_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(language_pref_path(), &lang).map_err(|e| e.to_string())
}

/// `None` = let Whisper auto-detect. English-only models always force "en".
fn effective_language() -> Option<String> {
    if get_model().ends_with(".en") {
        return Some("en".to_string());
    }
    match get_language().as_str() {
        "auto" => None,
        code => Some(code.to_string()),
    }
}

/// User-supplied vocabulary, newline- or comma-separated, raw as saved.
pub fn get_vocab() -> String {
    std::fs::read_to_string(vocab_pref_path()).unwrap_or_default()
}

pub fn set_vocab(text: String) -> Result<(), String> {
    let dir = data_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut text = text;
    text.truncate(4000);
    std::fs::write(vocab_pref_path(), text).map_err(|e| e.to_string())
}

pub fn get_cleanup() -> bool {
    std::fs::read_to_string(cleanup_pref_path())
        .map(|s| s.trim() != "0")
        .unwrap_or(true)
}

pub fn set_cleanup(enabled: bool) -> Result<(), String> {
    let dir = data_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(cleanup_pref_path(), if enabled { "1" } else { "0" })
        .map_err(|e| e.to_string())
}

/// Terms every coding dictation benefits from, merged with the user's own.
/// Whisper's initial prompt biases decoding toward this vocabulary — it's
/// what keeps "opencode" from arriving as "open code" and "PTY" as "pity".
const BUILTIN_GLOSSARY: &[&str] = &[
    "flock", "Claude Code", "opencode", "Codex", "Tauri", "xterm", "PTY",
    "tmux", "repo", "rebase", "worktree", "PR", "CI", "npm", "cargo", "regex",
    "SQLite", "Postgres", "TypeScript", "Rust", "async", "refactor", "linter",
    "changelog", "frontend", "backend", "endpoint", "middleware", "webhook",
];

/// User terms come first so they win the budget; the cap keeps the prompt
/// inside Whisper's ~224-token context window.
fn build_glossary_prompt() -> Option<String> {
    let user_raw = get_vocab();
    let user_terms: Vec<&str> = user_raw
        .split(|c: char| c == '\n' || c == ',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    let mut terms: Vec<&str> = Vec::new();
    let mut total = 0usize;
    for t in user_terms.iter().chain(BUILTIN_GLOSSARY.iter()) {
        if terms.iter().any(|e| e.eq_ignore_ascii_case(t)) {
            continue;
        }
        total += t.len() + 2;
        if total > 700 {
            break;
        }
        terms.push(t);
    }
    if terms.is_empty() {
        None
    } else {
        Some(format!("Glossary: {}.", terms.join(", ")))
    }
}

/// Strip spoken filler words. If the filler opened the sentence, re-capitalize
/// the word that now leads so the transcript still reads as written prose.
fn remove_fillers(text: &str) -> String {
    const FILLERS: &[&str] = &["um", "umm", "uh", "uhh", "uhm", "erm", "hmm", "mhm"];
    let mut out: Vec<&str> = Vec::new();
    let mut dropped_leading = false;
    for (i, tok) in text.split_whitespace().enumerate() {
        let bare = tok.trim_matches(|c: char| ",.!?;:".contains(c));
        if FILLERS.iter().any(|f| bare.eq_ignore_ascii_case(f)) {
            if i == 0 {
                dropped_leading = true;
            }
            continue;
        }
        out.push(tok);
    }
    let joined = out.join(" ");
    if dropped_leading {
        let mut chars = joined.chars();
        match chars.next() {
            Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
            None => joined,
        }
    } else {
        joined
    }
}

// ─── Enabled preference ─────────────────────────────────────────────────────

pub fn get_enabled() -> bool {
    std::fs::read_to_string(enabled_pref_path())
        .map(|s| s.trim() == "1")
        .unwrap_or(false)
}

pub fn set_enabled(enabled: bool) -> Result<(), String> {
    let dir = data_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(enabled_pref_path(), if enabled { "1" } else { "0" }).map_err(|e| e.to_string())
}

// ─── Model status / download ────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct ModelStatus {
    pub downloaded: bool,
}

pub fn model_status() -> ModelStatus {
    ModelStatus {
        downloaded: model_path().is_file(),
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct DownloadProgress {
    pub downloaded: u64,
    pub total: u64,
}

pub async fn download_model(app: AppHandle) -> Result<(), String> {
    let id = get_model();
    std::fs::create_dir_all(model_dir()).map_err(|e| e.to_string())?;
    let tmp_path = model_dir().join(format!("{}.part", model_file_name(&id)));

    let resp = reqwest::get(model_url(&id)).await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("model download failed: HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);

    use futures::StreamExt;
    use tokio::io::AsyncWriteExt;

    let mut file = tokio::fs::File::create(&tmp_path)
        .await
        .map_err(|e| e.to_string())?;
    let mut stream = resp.bytes_stream();
    let mut downloaded: u64 = 0;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;
        let _ = app.emit(
            "voice://download-progress",
            DownloadProgress { downloaded, total },
        );
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);

    std::fs::rename(&tmp_path, model_path_for(&id)).map_err(|e| e.to_string())?;
    Ok(())
}

// ─── Usage stats ─────────────────────────────────────────────────────────────

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct VoiceStats {
    pub total_words: u64,
    pub total_dictations: u64,
    pub total_duration_secs: f64,
}

pub fn get_stats() -> VoiceStats {
    std::fs::read_to_string(stats_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn record_stats(words: u64, duration_secs: f64) {
    let mut stats = get_stats();
    stats.total_words += words;
    stats.total_dictations += 1;
    stats.total_duration_secs += duration_secs;
    let dir = data_dir();
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    if let Ok(json) = serde_json::to_string_pretty(&stats) {
        let _ = std::fs::write(stats_path(), json);
    }
}

// ─── Recording + transcription state ───────────────────────────────────────

/// Rolling transcription state, shared between the streaming preview loop (which
/// advances it as segments finalize) and `stop_recording` (which reads it to
/// decode only the leftover tail). `committed_src` is an offset into the raw
/// interleaved capture `buffer`; everything before it is already in
/// `committed_text` and must never be re-decoded.
#[derive(Default)]
struct StreamState {
    committed_text: String,
    /// Absolute offset, counted from the first sample ever captured — NOT an
    /// index into `buffer`, which has its committed prefix removed as it goes.
    /// Index with `committed_src - dropped`; see `dropped`.
    committed_src: usize,
    /// How many samples have been physically removed from the front of
    /// `buffer`. Committed audio is provably dead (every reader slices from
    /// `committed_src` onward), so holding it only costs memory — dropping it
    /// is what keeps a long dictation flat instead of linear in its duration.
    dropped: usize,
}

struct RecordingHandle {
    stop_tx: std_mpsc::Sender<()>,
    buffer: Arc<StdMutex<Vec<f32>>>,
    join: JoinHandle<()>,
    sample_rate: u32,
    channels: u16,
    started_at: Instant,
    /// Signals the live-preview loop to wind down before the final pass.
    stop_flag: Arc<AtomicBool>,
    /// Rolling commit state; the final pass reads this to decode only the tail.
    stream: Arc<StdMutex<StreamState>>,
    /// The live-preview transcription task (None when the model isn't loaded).
    preview: Option<tokio::task::JoinHandle<()>>,
}

#[derive(Default)]
pub struct VoiceState {
    /// Cached alongside the path it was loaded from, so switching the
    /// selected model (Settings → flock Voice) triggers a reload instead
    /// of silently continuing to transcribe with the old one.
    whisper_ctx: AsyncMutex<Option<(PathBuf, Arc<WhisperContext>)>>,
    recording: AsyncMutex<Option<RecordingHandle>>,
}

pub async fn start_recording(state: &VoiceState, app: AppHandle) -> Result<(), String> {
    let mut guard = state.recording.lock().await;
    if guard.is_some() {
        return Ok(()); // already recording — treat as idempotent
    }

    let (stop_tx, stop_rx) = std_mpsc::channel::<()>();
    let (ready_tx, ready_rx) = std_mpsc::channel::<Result<(u32, u16), String>>();
    let buffer: Arc<StdMutex<Vec<f32>>> = Arc::new(StdMutex::new(Vec::new()));
    let buffer_thread = Arc::clone(&buffer);

    // cpal's Stream is !Send on macOS (CoreAudio), so it must be built,
    // played, and dropped entirely on one dedicated thread — never handed
    // across an await point or into shared state.
    let app_capture = app.clone();
    let join = std::thread::spawn(move || {
        run_capture_thread(app_capture, buffer_thread, stop_rx, ready_tx);
    });

    let (sample_rate, channels) = tokio::task::spawn_blocking(move || ready_rx.recv())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|_| "recording thread exited before starting".to_string())??;

    // Streaming preview: while the key is held, keep transcribing only the
    // *uncommitted tail* of the buffer, finalizing (committing) segments as
    // they settle. This both drives the HUD's live text and — crucially —
    // leaves `stream` holding a nearly-complete transcript by release time, so
    // the final pass only has to decode the last second or two. Skipped when
    // the model isn't downloaded/loadable; dictation then falls back to a
    // single whole-clip pass on release (committed_src stays 0).
    let stop_flag = Arc::new(AtomicBool::new(false));
    let stream: Arc<StdMutex<StreamState>> = Arc::new(StdMutex::new(StreamState::default()));
    let preview = if model_supports_streaming(&get_model()) {
        match ensure_model_loaded(state).await {
            Ok(ctx) => {
                let app_preview = app.clone();
                let buf = Arc::clone(&buffer);
                let flag = Arc::clone(&stop_flag);
                let st = Arc::clone(&stream);
                Some(tokio::spawn(stream_loop(
                    app_preview, ctx, buf, st, flag, sample_rate, channels,
                )))
            }
            Err(_) => None,
        }
    } else {
        // Heavy model: no live preview (a pass can't keep up with the cadence),
        // so the final pass decodes the whole clip. Still load the model now so
        // that release-time pass doesn't also eat the multi-second load cost.
        let _ = ensure_model_loaded(state).await;
        None
    };

    *guard = Some(RecordingHandle {
        stop_tx,
        buffer,
        join,
        sample_rate,
        channels,
        started_at: Instant::now(),
        stop_flag,
        stream,
        preview,
    });
    Ok(())
}

/// Streaming transcriber: every ~0.4s, decode only the audio *after* the last
/// committed point, finalize any segments that have settled (ended more than
/// `COMMIT_LAG_SECS` before the window's tail), and advance the commit offset
/// past them. Emits the running transcript (committed + still-fluid tail) to
/// `voice://partial` for the HUD.
///
/// This is the whole game for latency: because each pass only touches the
/// uncommitted tail, per-pass cost stays flat no matter how long the dictation
/// runs, and by release time `stream` already holds everything but the last
/// second or two — so the final pass in `stop_recording` is cheap. The loop is
/// sequential, so a slow pass just stretches its own tick instead of piling up.
async fn stream_loop(
    app: AppHandle,
    ctx: Arc<WhisperContext>,
    buffer: Arc<StdMutex<Vec<f32>>>,
    stream: Arc<StdMutex<StreamState>>,
    stop: Arc<AtomicBool>,
    sample_rate: u32,
    channels: u16,
) {
    let language = effective_language();
    let glossary = build_glossary_prompt();
    let cleanup = get_cleanup();
    let ch = channels.max(1) as usize;
    loop {
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        if stop.load(Ordering::Relaxed) {
            return;
        }

        // Snapshot the commit point and copy just the uncommitted tail.
        // `committed_src` is absolute; the buffer's committed prefix has been
        // dropped, so index by the difference.
        let (committed_src, dropped, committed_text) = {
            let s = stream.lock().unwrap();
            (s.committed_src, s.dropped, s.committed_text.clone())
        };
        let window_src: Vec<f32> = {
            let buf = buffer.lock().unwrap();
            let start = committed_src.saturating_sub(dropped).min(buf.len());
            if buf.len() <= start {
                continue; // nothing new since the last commit
            }
            buf[start..].to_vec()
        };

        let mono = downmix_to_mono(&window_src, channels);
        let resampled = resample_linear(&mono, sample_rate, WHISPER_SAMPLE_RATE);
        let window_secs = resampled.len() as f64 / WHISPER_SAMPLE_RATE as f64;
        if window_secs < 0.4 {
            continue; // under ~0.4s of fresh audio — too early to guess
        }
        let peak = resampled.iter().fold(0.0f32, |m, s| m.max(s.abs()));
        if peak < 0.001 {
            continue;
        }

        // Feed the tail of the committed transcript as context so Whisper keeps
        // capitalization/word choice consistent across the cut.
        let prompt = stream_prompt(glossary.as_deref(), &committed_text);
        let ctx2 = Arc::clone(&ctx);
        let lang2 = language.clone();
        let abort = Arc::clone(&stop);
        let segs = tokio::task::spawn_blocking(move || {
            run_whisper_segments(&ctx2, &resampled, lang2.as_deref(), prompt.as_deref(), Some(abort))
        })
        .await;
        if stop.load(Ordering::Relaxed) {
            return;
        }
        let Ok(Ok(segs)) = segs else { continue };

        // A segment is committed once it ends far enough behind the tail. If
        // the window has grown too long with no such pause, force the cut in so
        // work stays bounded.
        let cutoff = if window_secs > MAX_WINDOW_SECS {
            window_secs - 0.5
        } else {
            window_secs - COMMIT_LAG_SECS
        };
        let mut newly = String::new();
        let mut tail = String::new();
        let mut commit_end_secs = 0.0f64;
        let mut committing = true;
        for seg in &segs {
            let end = seg.t1_cs as f64 / 100.0;
            if committing && end <= cutoff {
                newly.push_str(&seg.text);
                commit_end_secs = end;
            } else {
                committing = false;
                tail.push_str(&seg.text);
            }
        }

        if !newly.is_empty() {
            let advance = (commit_end_secs * sample_rate as f64 * ch as f64) as usize;
            let mut s = stream.lock().unwrap();
            // stop_recording may have set the flag and read the state while this
            // pass ran; don't clobber it if so.
            if !stop.load(Ordering::Relaxed) {
                s.committed_text.push_str(&newly);
                s.committed_src = committed_src + advance;
                // Release the audio we just finalized. Nothing reads below
                // `committed_src` ever again — this loop slices from it, and so
                // does the release pass — so keeping it only grew the process
                // by ~384 KB per second of dictation. Dropping it holds memory
                // at roughly the uncommitted window (≤ MAX_WINDOW_SECS)
                // regardless of how long the user talks.
                //
                // Lock order is stream → buffer here and nowhere is it taken
                // the other way round while held (stop_recording's `mem::take`
                // releases the buffer guard within its own statement), so this
                // cannot deadlock.
                let mut buf = buffer.lock().unwrap();
                release_committed(&mut buf, s.committed_src, &mut s.dropped);
            }
        }

        let mut display = committed_text;
        display.push_str(&newly);
        display.push_str(&tail);
        let display = display.trim().to_string();
        if !display.is_empty() {
            let display = if cleanup { remove_fillers(&display) } else { display };
            let _ = app.emit("voice://partial", display);
        }
    }
}

/// Drop the already-transcribed prefix of the capture buffer.
///
/// `committed_src` is absolute (counted from the first sample of the
/// recording); `dropped` tracks how much of that has already been physically
/// removed, so `committed_src - dropped` is where the committed audio ends
/// *within the buffer as it stands now*. Advances `dropped` by whatever was
/// released and returns that count.
///
/// The clamps are load-bearing: a streaming pass computes `committed_src` from
/// segment timestamps, which can round past what has actually been captured,
/// and `stop_recording` can empty the buffer while a pass is still in flight.
/// Both must leave the offsets consistent rather than panic on a bad range.
fn release_committed(buf: &mut Vec<f32>, committed_src: usize, dropped: &mut usize) -> usize {
    let drop_n = committed_src.saturating_sub(*dropped).min(buf.len());
    if drop_n > 0 {
        buf.drain(..drop_n);
        *dropped += drop_n;
    }
    drop_n
}

/// Build the initial-prompt for a streaming pass: the glossary plus the tail of
/// what's already been committed, so Whisper continues in-context across the
/// chunk boundary. Kept within Whisper's ~224-token prompt budget.
fn stream_prompt(glossary: Option<&str>, committed: &str) -> Option<String> {
    let tail: String = {
        let trimmed = committed.trim_end();
        let start = trimmed.len().saturating_sub(200);
        // Don't slice mid-UTF-8; walk forward to a char boundary.
        let mut start = start;
        while start < trimmed.len() && !trimmed.is_char_boundary(start) {
            start += 1;
        }
        trimmed[start..].to_string()
    };
    match (glossary, tail.is_empty()) {
        (Some(g), true) => Some(g.to_string()),
        (Some(g), false) => Some(format!("{g} {tail}")),
        (None, true) => None,
        (None, false) => Some(tail),
    }
}

/// Emits a throttled (~30fps) 0–1 audio level for the HUD's soundwave, akin
/// to the original app's `AudioRecorder` RMS callback -> `state.audioLevel`.
fn maybe_emit_level(app: &AppHandle, samples: &[f32], last_emit: &StdMutex<Instant>) {
    let mut last = last_emit.lock().unwrap();
    if last.elapsed().as_millis() < 33 {
        return;
    }
    *last = Instant::now();
    let rms = (samples.iter().map(|s| s * s).sum::<f32>() / samples.len().max(1) as f32).sqrt();
    let level = (rms * 8.0).min(1.0);
    let _ = app.emit("voice://level", level);
}

/// Same meter, straight off the i16 capture. Exists so the i16 path doesn't
/// have to materialize a converted `Vec<f32>` per callback just to measure it.
fn maybe_emit_level_i16(app: &AppHandle, samples: &[i16], last_emit: &StdMutex<Instant>) {
    let mut last = last_emit.lock().unwrap();
    if last.elapsed().as_millis() < 33 {
        return;
    }
    *last = Instant::now();
    let scale = f32::from(i16::MAX);
    let sum: f32 = samples
        .iter()
        .map(|s| {
            let v = f32::from(*s) / scale;
            v * v
        })
        .sum();
    let rms = (sum / samples.len().max(1) as f32).sqrt();
    let _ = app.emit("voice://level", (rms * 8.0).min(1.0));
}

fn run_capture_thread(
    app: AppHandle,
    buffer: Arc<StdMutex<Vec<f32>>>,
    stop_rx: std_mpsc::Receiver<()>,
    ready_tx: std_mpsc::Sender<Result<(u32, u16), String>>,
) {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

    let host = cpal::default_host();
    let wanted_name = get_input_device();
    let device = match &wanted_name {
        Some(name) => {
            let found = host.input_devices().ok().and_then(|mut devices| {
                devices.find(|d| d.name().map(|n| &n == name).unwrap_or(false))
            });
            match found {
                Some(d) => d,
                None => {
                    tracing::warn!(
                        "voice: selected input device '{name}' not found, falling back to system default"
                    );
                    match host.default_input_device() {
                        Some(d) => d,
                        None => {
                            let _ = ready_tx.send(Err("no microphone input device found".into()));
                            return;
                        }
                    }
                }
            }
        }
        None => match host.default_input_device() {
            Some(d) => d,
            None => {
                let _ = ready_tx.send(Err("no microphone input device found".into()));
                return;
            }
        },
    };
    let config = match device.default_input_config() {
        Ok(c) => c,
        Err(e) => {
            let _ = ready_tx.send(Err(e.to_string()));
            return;
        }
    };
    let sample_rate = config.sample_rate().0;
    let channels = config.channels();
    let sample_format = config.sample_format();
    let err_fn = |err| tracing::error!("voice: cpal stream error: {err}");
    let last_emit = Arc::new(StdMutex::new(Instant::now()));

    // Per-second sample count, used for both the pre-allocation and the cap.
    let per_sec = sample_rate as usize * channels.max(1) as usize;
    let max_samples = per_sec * MAX_RECORDING_SECS;
    buffer
        .lock()
        .unwrap()
        .reserve(per_sec * CAPTURE_PREALLOC_SECS);

    /// Append a block of capture, refusing to grow past the ceiling.
    ///
    /// Runs on the realtime audio thread, so it must not allocate beyond the
    /// append itself: no logging, no formatting, no per-callback temporaries.
    /// Returns true the one time the cap is first reached, so the caller can
    /// report it exactly once from outside the hot path.
    fn append_capped(buf: &StdMutex<Vec<f32>>, block: &[f32], max: usize) -> bool {
        let mut b = buf.lock().unwrap();
        if b.len() >= max {
            return false;
        }
        let room = max - b.len();
        if block.len() <= room {
            b.extend_from_slice(block);
            false
        } else {
            b.extend_from_slice(&block[..room]);
            true // just hit the ceiling
        }
    }

    let stream_result = match sample_format {
        cpal::SampleFormat::F32 => {
            let buf = Arc::clone(&buffer);
            let app_cb = app.clone();
            let last_emit_cb = Arc::clone(&last_emit);
            device.build_input_stream(
                &config.into(),
                move |data: &[f32], _: &_| {
                    if append_capped(&buf, data, max_samples) {
                        tracing::warn!(
                            "voice: recording hit the {MAX_RECORDING_SECS}s ceiling — \
                             further audio is discarded until you stop"
                        );
                    }
                    maybe_emit_level(&app_cb, data, &last_emit_cb);
                },
                err_fn,
                None,
            )
        }
        cpal::SampleFormat::I16 => {
            let buf = Arc::clone(&buffer);
            let app_cb = app.clone();
            let last_emit_cb = Arc::clone(&last_emit);
            device.build_input_stream(
                &config.into(),
                move |data: &[i16], _: &_| {
                    // Convert straight into the buffer. The old code built a
                    // throwaway `Vec<f32>` on every callback — a heap
                    // allocation hundreds of times a second on the realtime
                    // audio thread, which is both churn and a latency hazard.
                    let hit_cap = {
                        let mut b = buf.lock().unwrap();
                        let room = max_samples.saturating_sub(b.len());
                        let take = room.min(data.len());
                        b.extend(data[..take].iter().map(|s| *s as f32 / i16::MAX as f32));
                        // Only the crossing, not every callback thereafter.
                        room > 0 && take < data.len()
                    };
                    if hit_cap {
                        tracing::warn!(
                            "voice: recording hit the {MAX_RECORDING_SECS}s ceiling — \
                             further audio is discarded until you stop"
                        );
                    }
                    maybe_emit_level_i16(&app_cb, data, &last_emit_cb);
                },
                err_fn,
                None,
            )
        }
        other => {
            let _ = ready_tx.send(Err(format!("unsupported input sample format: {other:?}")));
            return;
        }
    };

    let stream = match stream_result {
        Ok(s) => s,
        Err(e) => {
            let _ = ready_tx.send(Err(e.to_string()));
            return;
        }
    };

    if let Err(e) = stream.play() {
        let _ = ready_tx.send(Err(e.to_string()));
        return;
    }

    let _ = ready_tx.send(Ok((sample_rate, channels)));

    // Park this thread until told to stop. The stream (and its capture
    // callback) stays alive exactly as long as `stream` isn't dropped.
    let _ = stop_rx.recv();
    drop(stream);
}

pub async fn stop_recording(state: &VoiceState, app: &AppHandle) -> Result<String, String> {
    let handle = {
        let mut guard = state.recording.lock().await;
        guard.take()
    };
    let Some(RecordingHandle {
        stop_tx,
        buffer,
        join,
        sample_rate,
        channels,
        started_at,
        stop_flag,
        stream,
        preview,
    }) = handle
    else {
        // Not recording — idempotent no-op rather than an error. A quick
        // tap can land a stop before/after the matching start in a way that
        // leaves nothing to stop; treating that as an empty result keeps the
        // frontend simple and avoids spurious "not recording" error noise.
        return Ok(String::new());
    };

    let _ = stop_tx.send(());
    // Retire the streaming loop before the final pass. Setting the flag first
    // means that if a pass is mid-flight, its blocking Whisper run finishes and
    // is discarded (it won't commit or emit), so we read a coherent snapshot of
    // the rolling state below.
    stop_flag.store(true, Ordering::Relaxed);
    if let Some(p) = preview {
        p.abort();
    }
    tokio::task::spawn_blocking(move || join.join())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|_| "recording thread panicked".to_string())?;

    let elapsed_secs = started_at.elapsed().as_secs_f64();
    // Take the audio and read the commit point under ONE `stream` lock. They
    // used to be read separately, which was fine when the buffer was
    // append-only; now that the streaming loop drops the committed prefix, a
    // pass landing between the two reads would leave `dropped` describing a
    // buffer we'd already taken, and the tail would be sliced at the wrong
    // place. Same stream → buffer order as `stream_loop`.
    let (samples, committed_text, tail_start, dropped) = {
        let s = stream.lock().unwrap();
        let samples = std::mem::take(&mut *buffer.lock().unwrap());
        let tail_start = s.committed_src.saturating_sub(s.dropped).min(samples.len());
        (samples, s.committed_text.clone(), tail_start, s.dropped)
    };

    // Both guards below have to reason about the WHOLE utterance, not just
    // what's left in the buffer: streaming drops committed audio as it goes, so
    // a five-minute dictation can arrive here with a fraction of a second of
    // tail. Judging that tail alone would throw away everything already
    // transcribed.
    let captured = dropped + samples.len();
    let total_frames = captured / channels.max(1) as usize;
    // Under ~0.1s of audio isn't a real utterance (e.g. an accidental tap).
    if total_frames < (sample_rate as usize) / 10 {
        return Ok(String::new());
    }

    // A capture that "worked" but delivered only zeros means macOS denied
    // the microphone without an error — hardened-runtime builds missing the
    // audio-input entitlement, or a TCC denial, both look exactly like this.
    // Whisper hallucinates real words ("you") or "[BLANK_AUDIO]" from silent
    // input, which would get typed into the pane; gate it out and tell the
    // frontend so the user learns the mic is blocked instead of seeing junk.
    //
    // Only meaningful when nothing was committed: committed text is proof the
    // mic delivered real audio, and a dictation that simply ends in a pause has
    // a silent tail without anything being wrong.
    if committed_text.trim().is_empty() {
        let peak = samples.iter().fold(0.0f32, |m, s| m.max(s.abs()));
        if peak < 0.001 {
            tracing::warn!(
                "voice: captured {} samples but audio is silent (peak={peak:.6}) — \
                 microphone access is likely denied",
                samples.len()
            );
            let _ = app.emit("voice://no-audio", ());
            return Ok(String::new());
        }
    }

    // Decode only the leftover tail — the audio past the commit point, read
    // above. When streaming was off (model unloaded), nothing was ever
    // committed or dropped, `tail_start` is 0, and this is a single whole-clip
    // pass, as before.
    let tail_src = &samples[tail_start..];
    let tail_mono = downmix_to_mono(tail_src, channels);
    let tail_resampled = resample_linear(&tail_mono, sample_rate, WHISPER_SAMPLE_RATE);

    let tail_secs = tail_resampled.len() as f64 / WHISPER_SAMPLE_RATE as f64;
    let pass_started = Instant::now();
    let tail_text = if tail_resampled.len() >= WHISPER_SAMPLE_RATE as usize / 20 {
        let prompt = stream_prompt(build_glossary_prompt().as_deref(), &committed_text);
        transcribe(state, tail_resampled, prompt).await?
    } else {
        String::new()
    };
    tracing::info!(
        "voice: release pass over {tail_secs:.1}s of tail audio ({} model) took {:.0}ms",
        get_model(),
        pass_started.elapsed().as_millis()
    );

    let mut text = committed_text;
    text.push_str(&tail_text);
    let text = text.trim().to_string();
    let text = if get_cleanup() { remove_fillers(&text) } else { text };
    if !text.is_empty() {
        let words = text.split_whitespace().count() as u64;
        record_stats(words, elapsed_secs);
    }
    Ok(text)
}

/// Load the Whisper model into the cached context ahead of time, so the
/// first real dictation doesn't pay the (multi-hundred-ms to multi-second)
/// model-load cost inside its "Transcribing…" window. Best-effort — a
/// missing model or load failure just leaves it to load lazily on first use.
pub async fn prewarm(state: &VoiceState) {
    match ensure_model_loaded(state).await {
        Ok(_) => tracing::info!("voice: model prewarmed"),
        Err(e) => tracing::info!("voice: model prewarm skipped ({e})"),
    }
}

async fn ensure_model_loaded(state: &VoiceState) -> Result<Arc<WhisperContext>, String> {
    let mut guard = state.whisper_ctx.lock().await;
    let path = model_path();
    if let Some((loaded_path, ctx)) = guard.as_ref() {
        if *loaded_path == path {
            return Ok(Arc::clone(ctx));
        }
        tracing::info!("voice: selected model changed, reloading");
    }
    if !path.is_file() {
        return Err("Whisper model not downloaded yet".to_string());
    }
    let load_path = path.clone();
    let ctx = tokio::task::spawn_blocking(move || {
        WhisperContext::new_with_params(
            load_path.to_string_lossy().as_ref(),
            WhisperContextParameters::default(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    let ctx = Arc::new(ctx);
    *guard = Some((path, Arc::clone(&ctx)));
    Ok(ctx)
}

async fn transcribe(
    state: &VoiceState,
    samples: Vec<f32>,
    prompt: Option<String>,
) -> Result<String, String> {
    let ctx = ensure_model_loaded(state).await?;
    let language = effective_language();
    tokio::task::spawn_blocking(move || {
        run_whisper_segments(&ctx, &samples, language.as_deref(), prompt.as_deref(), None)
            .map(|segs| concat_segments(&segs))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// One finalized Whisper segment: its text and its end time (centiseconds from
/// the start of the decoded window). The end time is what lets the streaming
/// loop decide when a segment has settled enough to commit.
struct Seg {
    text: String,
    t1_cs: i64,
}

fn concat_segments(segs: &[Seg]) -> String {
    let mut text = String::new();
    for s in segs {
        text.push_str(&s.text);
    }
    text.trim().to_string()
}

/// One blocking Whisper pass over `samples`, returning speech segments with
/// their end timestamps. Shared by the final transcription and the streaming
/// loop — each call gets its own state, so concurrent passes over the same
/// (read-only) context are safe.
///
/// `abort` lets a caller cut a pass short mid-flight: streaming passes get the
/// recording's stop flag, so when the key is released `stop_recording` can flip
/// it and any in-flight streaming decode bails immediately, handing every core
/// back to the final release pass instead of running to completion in the
/// background and contending with it. The final pass itself passes `None`.
fn run_whisper_segments(
    ctx: &WhisperContext,
    samples: &[f32],
    language: Option<&str>,
    initial_prompt: Option<&str>,
    abort: Option<Arc<AtomicBool>>,
) -> Result<Vec<Seg>, String> {
    // Use all available cores — Whisper is CPU-bound (Metal offloads the
    // encoder) and this is the biggest lever on how fast a pass resolves.
    let n_threads = std::thread::available_parallelism()
        .map(|n| n.get() as i32)
        .unwrap_or(4);
    let mut whisper_state = ctx.create_state().map_err(|e| e.to_string())?;
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(language); // None => auto-detect (multilingual models)
    params.set_n_threads(n_threads);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    // Disable Whisper's temperature-fallback ladder: on a low-confidence decode
    // it otherwise re-runs the whole pass at successively higher temperatures
    // (up to ~6 extra passes), which is a huge, invisible latency spike on
    // exactly the noisy/short clips dictation produces. One greedy pass is the
    // right trade for real-time typing.
    params.set_temperature(0.0);
    params.set_temperature_inc(0.0);
    // Bias decoding toward the built-in + user glossary (coding jargon,
    // project names) — Whisper's equivalent of a personal dictionary.
    if let Some(p) = initial_prompt {
        params.set_initial_prompt(p);
    }
    // NOT set_single_segment(true): that caps output to the first segment,
    // silently dropping everything after the first natural pause in a
    // longer dictation. We keep every segment.
    params.set_no_context(true);
    params.set_suppress_blank(true);
    // When given, poll this flag between compute steps and abort as soon as it
    // flips — see the doc comment. whisper-rs leaks the boxed closure per pass;
    // it's a few bytes and only the streaming loop sets it, so it stays tiny.
    if let Some(flag) = abort {
        params.set_abort_callback_safe(move || flag.load(Ordering::Relaxed));
    }

    whisper_state.full(params, samples).map_err(|e| e.to_string())?;

    let n = whisper_state.full_n_segments().map_err(|e| e.to_string())?;
    let mut segs = Vec::new();
    for i in 0..n {
        let Ok(seg) = whisper_state.full_get_segment_text(i) else {
            continue;
        };
        // Whisper annotates non-speech as bracketed/parenthesized tags —
        // "[BLANK_AUDIO]", "(keyboard clicking)" — which must never be typed
        // into a pane as if dictated.
        let t = seg.trim();
        if (t.starts_with('[') && t.ends_with(']')) || (t.starts_with('(') && t.ends_with(')')) {
            continue;
        }
        let t1_cs = whisper_state.full_get_segment_t1(i).unwrap_or(0);
        segs.push(Seg { text: seg, t1_cs });
    }
    Ok(segs)
}

// ─── Audio helpers ───────────────────────────────────────────────────────────

fn downmix_to_mono(interleaved: &[f32], channels: u16) -> Vec<f32> {
    if channels <= 1 {
        return interleaved.to_vec();
    }
    let ch = channels as usize;
    interleaved
        .chunks(ch)
        .map(|frame| frame.iter().sum::<f32>() / ch as f32)
        .collect()
}

fn resample_linear(input: &[f32], from_rate: u32, to_rate: u32) -> Vec<f32> {
    if from_rate == to_rate || input.is_empty() {
        return input.to_vec();
    }
    let ratio = from_rate as f64 / to_rate as f64;
    let out_len = (input.len() as f64 / ratio).floor() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src_pos = i as f64 * ratio;
        let idx = src_pos.floor() as usize;
        let frac = (src_pos - idx as f64) as f32;
        let a = input.get(idx).copied().unwrap_or(0.0);
        let b = input.get(idx + 1).copied().unwrap_or(a);
        out.push(a + (b - a) * frac);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Walks a whole dictation the way `stream_loop` does — append, commit,
    /// release — and checks that the uncommitted tail read back through
    /// `committed_src - dropped` is byte-for-byte what an append-only buffer
    /// would have yielded. This is the invariant that keeps a transcript
    /// correct now that the committed prefix is thrown away.
    #[test]
    fn releasing_committed_audio_preserves_the_tail() {
        let mut buf: Vec<f32> = Vec::new();
        let mut dropped = 0usize;
        let mut committed_src = 0usize;
        // The append-only buffer the old code kept, for comparison.
        let mut reference: Vec<f32> = Vec::new();

        let mut next = 0.0f32;
        for round in 0..50 {
            // Capture 1000 fresh samples.
            for _ in 0..1000 {
                buf.push(next);
                reference.push(next);
                next += 1.0;
            }
            // Commit all but the last 300 — the "uncommitted window".
            committed_src = reference.len() - 300;
            let released = release_committed(&mut buf, committed_src, &mut dropped);
            assert!(released > 0 || round == 0);

            // The live tail must equal the reference tail.
            let start = committed_src.saturating_sub(dropped);
            assert_eq!(&buf[start..], &reference[committed_src..], "round {round}");
            // And memory stays flat instead of tracking the dictation length.
            assert_eq!(buf.len(), 300);
        }
        assert_eq!(dropped + buf.len(), reference.len());
    }

    #[test]
    fn release_is_clamped_against_impossible_offsets() {
        // A commit point past what was captured (timestamp rounding) releases
        // only what exists and leaves the offsets consistent.
        let mut buf: Vec<f32> = vec![1.0, 2.0, 3.0];
        let mut dropped = 0usize;
        assert_eq!(release_committed(&mut buf, 99, &mut dropped), 3);
        assert_eq!(dropped, 3);
        assert!(buf.is_empty());

        // An emptied buffer (stop_recording took it mid-pass) is a no-op.
        assert_eq!(release_committed(&mut buf, 120, &mut dropped), 0);
        assert_eq!(dropped, 3);

        // A commit point behind what's already dropped never rewinds.
        let mut buf2: Vec<f32> = vec![7.0, 8.0];
        let mut dropped2 = 500usize;
        assert_eq!(release_committed(&mut buf2, 100, &mut dropped2), 0);
        assert_eq!(dropped2, 500);
        assert_eq!(buf2.len(), 2);
    }
}
