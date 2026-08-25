use crate::events::{AgentStatusEvent, PtyExitEvent};
use crate::state::PaneOutput;
use bytes::{Bytes, BytesMut};
use flock_core::{status::detector_for, AgentStatus};
use flock_pty::PtyHandle;
use std::sync::Arc;
use std::time::Duration;
use tauri::{ipc::InvokeResponseBody, AppHandle, Emitter};
use tokio::sync::{mpsc::Receiver, RwLock};
use tokio::time::{interval, Instant};

/// Upper bound on a single coalesced output batch. Draining the PTY backlog
/// into one broadcast keeps the webview's IPC message rate sane under heavy
/// output; this caps how much a single message can carry so a runaway producer
/// can't build an unbounded batch in memory.
const MAX_BATCH_BYTES: usize = 64 * 1024;

/// A batch that is already this big was cut short by the reader's buffer, not
/// by the agent running out of things to say — `flock-pty` reads the pty in
/// 4 KB bites, so a full one means the rest of the burst is still in the pipe
/// and will arrive within microseconds. Below it, the agent has finished its
/// sentence and the batch goes out now.
const BURST_BYTES: usize = 4 * 1024;

/// How long to keep draining once a burst is recognised.
///
/// Why this is worth any latency at all: a channel message is not cheap on the
/// far side. Tauri delivers one by *evaluating a JavaScript string* in the
/// webview — under 1 KB the bytes are spelled out as a JSON number array in
/// the source, and at or above it the eval'd snippet calls back into an
/// `invoke` to fetch them. Either way the cost is per *message* (a script to
/// lex, parse and run, plus for the large case a full IPC round trip), and
/// barely varies with how many bytes it carries. Three 4 KB messages
/// therefore cost about three times what one 12 KB message costs, for the
/// same output.
///
/// Only bursts pay it, and 8 ms is half a display frame — less than the wait
/// for the next repaint that this output is going to be drawn in anyway.
const COALESCE_WINDOW: Duration = Duration::from_millis(8);

/// Spawn a background task that pumps PTY output to Tauri events and runs
/// agent-status detection. Mirrors the logic in flock_core::agent::drive_agent_io,
/// but emits to a Tauri webview instead of an internal EventBus.
pub fn spawn_output_loop(
    app: AppHandle,
    state_panes: Arc<tokio::sync::RwLock<std::collections::HashMap<String, crate::state::PaneEntry>>>,
    pane_id: String,
    kind: String,
    pty: PtyHandle,
    mut output_rx: Receiver<Bytes>,
    status: Arc<RwLock<AgentStatus>>,
    output: Arc<std::sync::Mutex<PaneOutput>>,
    // This pane's provenance record, if one was opened. Carried here rather
    // than looked up per event: the loop outlives the PaneEntry (it is what
    // removes it), so it has to hold the handle it needs to close the row.
    provenance: Option<crate::provenance::Recorder>,
) {
    tokio::spawn(async move {
        let detector = detector_for(&kind);
        let mut line_buf = String::new();
        let mut spinner_last: Option<Instant> = None;
        let mut ticker = interval(Duration::from_millis(500));
        // Discard first immediate tick
        ticker.tick().await;

        // The loop yields the exit code so there is exactly one exit path.
        // Previously the channel-close arm broke out directly, skipping the
        // poll_exit() block below — and since the reader thread's EOF almost
        // always races ahead of the wait()-thread's oneshot, a pane whose
        // process died on its own usually got no pty://exit event and its
        // PaneEntry (plus the PTY master fd) leaked in state.panes forever.
        let exit_code = loop {
            tokio::select! {
                maybe_chunk = output_rx.recv() => {
                    match maybe_chunk {
                        None => break wait_for_exit(&pty).await,
                        Some(first) => {
                            let mut batch = BytesMut::from(first.as_ref());
                            let mut closed = false;
                            while batch.len() < MAX_BATCH_BYTES {
                                match output_rx.try_recv() {
                                    Ok(more) => batch.extend_from_slice(&more),
                                    Err(_) => break,
                                }
                            }
                            // Mid-burst: hold the batch open a few milliseconds
                            // for the rest of it rather than paying a whole
                            // channel message per 4 KB bite (see the constants
                            // above). A batch that is *not* a burst — the echo
                            // of a keystroke, an agent's one-line answer — is
                            // already past this and goes out with no delay.
                            if batch.len() >= BURST_BYTES {
                                let deadline = Instant::now() + COALESCE_WINDOW;
                                while batch.len() < MAX_BATCH_BYTES {
                                    match tokio::time::timeout_at(deadline, output_rx.recv()).await {
                                        Ok(Some(more)) => batch.extend_from_slice(&more),
                                        // The pty closed mid-burst. Deliver what
                                        // we have, then take the ordinary exit
                                        // path — dropping out here would skip
                                        // this batch entirely.
                                        Ok(None) => { closed = true; break }
                                        Err(_) => break,
                                    }
                                }
                            }
                            let batch = batch.freeze();

                            let text = String::from_utf8_lossy(&batch);
                            for ch in text.chars() {
                                if ch == '\n' {
                                    if let Some(s) = detector.detect_line(&line_buf) {
                                        apply_status(s, &status, &pane_id, &app, &mut spinner_last, &provenance).await;
                                    }
                                    line_buf.clear();
                                } else if line_buf.len() < 4096 {
                                    // Cap guards against binary/no-newline output
                                    // that would otherwise grow line_buf unbounded.
                                    line_buf.push(ch);
                                }
                            }
                            if let Some(s) = detector.detect_line(&line_buf) {
                                apply_status(s, &status, &pane_id, &app, &mut spinner_last, &provenance).await;
                            }

                            // Batch-level pass for full-screen TUI agents
                            // (opencode) whose frames have no newlines, so the
                            // status footer never survives the per-line splitter
                            // and cap above. No-op for line-oriented detectors.
                            if let Some(s) = detector.detect_batch(&text) {
                                apply_status(s, &status, &pane_id, &app, &mut spinner_last, &provenance).await;
                            }

                            // 2. Record into the replay ring and broadcast to every
                            // live subscriber under one lock, so a terminal
                            // subscribing concurrently either sees this batch in its
                            // snapshot or receives it live — never both, never
                            // neither (see PaneOutput). Dead channels (webview gone)
                            // are pruned on send failure. Raw bytes ride the binary
                            // IPC path — no JSON number-array blowup.
                            {
                                let mut out = output.lock().unwrap();
                                out.ring.push(&batch);
                                if !out.subscribers.is_empty() {
                                    out.subscribers.retain(|ch| {
                                        ch.send(InvokeResponseBody::Raw(batch.to_vec())).is_ok()
                                    });
                                }
                            }

                            if closed {
                                break wait_for_exit(&pty).await;
                            }
                        }
                    }
                }

                _ = ticker.tick() => {
                    // Spinner timeout: if Working for 3+ seconds with no new
                    // spinner, the turn is over. That lands the pane at Idle,
                    // not AwaitingInput — a silent agent has stopped, it has
                    // not asked us anything, and only a real question may light
                    if let Some(last) = spinner_last {
                        if last.elapsed() >= Duration::from_secs(3) {
                            let s = *status.read().await;
                            if matches!(s, AgentStatus::Working) {
                                apply_status(
                                    AgentStatus::Idle,
                                    &status,
                                    &pane_id,
                                    &app,
                                    &mut spinner_last,
                                    &provenance,
                                )
                                .await;
                            }
                            spinner_last = None;
                        }
                    }
                }
            }

            if let Some(code) = pty.poll_exit() {
                break code;
            }
        };

        let exit_status = detector.detect_exit(exit_code);
        {
            let mut s = status.write().await;
            *s = exit_status;
        }
        let _ = app.emit(
            &format!("agent://status/{}", pane_id),
            AgentStatusEvent {
                pane_id: pane_id.clone(),
                status: exit_status.as_str().to_string(),
            },
        );
        let _ = app.emit(
            &format!("pty://exit/{}", pane_id),
            PtyExitEvent {
                pane_id: pane_id.clone(),
                exit_code,
            },
        );
        // Remove the pane from state so a new agent can take its slot.
        // No-op when close_pane already removed it explicitly.
        state_panes.write().await.remove(&pane_id);
        // Close the activity record. The last thing done, and done after the
        // pane is out of state, because it reads the session's transcript to
        // bank its final token count — a file read that must not sit in front
        // of the events the UI is waiting for. `exited`, not `closed`: the
        // process ended. When the user closed the pane, `close_pane` has
        // usually already recorded that, and the store keeps the first ending.
        if let Some(rec) = &provenance {
            rec.finish("exited", exit_status.as_str()).await;
        }
    });
}

/// Bounded wait for the child's exit code once the output channel closes.
/// EOF on the reader and the exit oneshot fire within moments of each other,
/// but in either order — so give the code up to ~2s to arrive rather than
/// assuming it's already there. Falls back to 1 (generic failure) if the
/// reader died while the process somehow lives on.
async fn wait_for_exit(pty: &PtyHandle) -> i32 {
    for _ in 0..40 {
        if let Some(code) = pty.poll_exit() {
            return code;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    1
}

async fn apply_status(
    new: AgentStatus,
    current: &Arc<RwLock<AgentStatus>>,
    pane_id: &str,
    app: &AppHandle,
    spinner_last: &mut Option<Instant>,
    provenance: &Option<crate::provenance::Recorder>,
) {
    if matches!(new, AgentStatus::Working) {
        *spinner_last = Some(Instant::now());
    }
    // The write guard is held across the record and the emit on purpose: the
    // pty detector and the hook watcher both come through here concurrently,
    // and an emit outside the guard can land in the opposite order of the
    // writes — leaving the frontend pill showing a status that disagrees with
    // what `PaneEntry.status` (and the provenance row) says until the next
    // transition. Transitions are rare, so the guard is cheap to hold.
    let mut s = current.write().await;
    if *s != new {
        *s = new;
        // Only real transitions are recorded, so the stored history is a
        // timeline and not a log of every poll that agreed with the last one.
        if let Some(rec) = provenance {
            rec.status(new.as_str()).await;
        }
        let _ = app.emit(
            &format!("agent://status/{}", pane_id),
            AgentStatusEvent {
                pane_id: pane_id.to_string(),
                status: new.as_str().to_string(),
            },
        );
    }
}
