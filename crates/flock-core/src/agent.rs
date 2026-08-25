use crate::{
    event::{AppEvent, EventBus},
    status::detector_for,
    types::{AgentId, AgentStatus, WorkspaceId},
    workspace::WorkspaceManager,
};
use anyhow::Result;
use bytes::Bytes;
use flock_pty::PtyHandle;
use std::{path::Path, sync::Arc};
use tokio::sync::RwLock;
use tokio::time::{Duration, Instant, interval};

pub struct AgentHandle {
    pub id: AgentId,
    pub workspace_id: WorkspaceId,
    pub kind: String,
    pty: PtyHandle,
    pub current_status: Arc<RwLock<AgentStatus>>,
}

impl AgentHandle {
    pub async fn spawn(
        workspace_id: WorkspaceId,
        kind: String,
        cmd: &str,
        args: &[&str],
        cwd: Option<&Path>,
        rows: u16,
        cols: u16,
        bus: EventBus,
        wm: Arc<WorkspaceManager>,
    ) -> Result<Self> {
        let agent_record = wm.register_agent(&workspace_id, &kind).await?;
        let agent_id = agent_record.id.clone();

        let (pty, output_rx) = flock_pty::spawn(
            cmd,
            args,
            rows,
            cols,
            cwd,
            &[
                ("FLOCK_PANE_ID", agent_id.0.as_str()),
                ("FLOCK_WORKSPACE_ID", workspace_id.0.as_str()),
                // DEPRECATED: hooks already written into users' own
                // ~/.claude/settings.json read the CLARENCE_* names, and those
                // files aren't ours to rewrite. Keep exporting both until the
                // rebrand is a few releases old, then drop these two.
                ("CLARENCE_PANE_ID", agent_id.0.as_str()),
                ("CLARENCE_WORKSPACE_ID", workspace_id.0.as_str()),
            ],
            // The TUI doesn't create worktrees, so there's nothing to set up.
            None,
        )?;
        let current_status = Arc::new(RwLock::new(AgentStatus::Idle));

        let bus_clone = bus.clone();
        let agent_id_clone = agent_id.clone();
        let wm_clone = wm.clone();
        let status_clone = current_status.clone();
        let pty_clone = pty.clone();
        let kind_clone = kind.clone();

        tokio::spawn(async move {
            drive_agent_io(
                pty_clone,
                output_rx,
                agent_id_clone,
                kind_clone,
                bus_clone,
                wm_clone,
                status_clone,
            )
            .await;
        });

        Ok(Self { id: agent_id, workspace_id, kind, pty, current_status })
    }

    pub fn send_input(&self, data: &[u8]) -> Result<()> {
        self.pty.send_input(data)
    }

    pub async fn status(&self) -> AgentStatus {
        *self.current_status.read().await
    }
}

/// How long after the last spinner char with no new spinner before we assume
/// the agent has finished and is awaiting input.
const SPINNER_TIMEOUT: Duration = Duration::from_secs(3);

/// How often we check whether the spinner has timed out.
const SPINNER_CHECK_INTERVAL: Duration = Duration::from_millis(500);

/// Cap on the line-detection buffer, matching the desktop bridge. Guards
/// against binary output and against full-screen agents that never emit a
/// newline at all.
const MAX_LINE_BYTES: usize = 4096;

async fn drive_agent_io(
    pty: PtyHandle,
    mut output_rx: tokio::sync::mpsc::Receiver<Bytes>,
    agent_id: AgentId,
    kind: String,
    bus: EventBus,
    wm: Arc<WorkspaceManager>,
    current_status: Arc<RwLock<AgentStatus>>,
) {
    let detector = detector_for(&kind);
    let mut line_buf = String::new();

    // Track the last time a spinner char was seen.
    // While Working and spinner_last is older than SPINNER_TIMEOUT → Idle.
    let mut spinner_last: Option<Instant> = None;
    let mut ticker = interval(SPINNER_CHECK_INTERVAL);

    // The loop yields the exit code so there is exactly one exit path.
    // Previously the channel-close arm broke out directly, skipping the
    // poll_exit() block below — and since the reader thread's EOF almost
    // always races ahead of the wait()-thread's oneshot, an agent that
    // died on its own stayed "live" in flock-cli forever.
    let exit_code = loop {
        tokio::select! {
            maybe_chunk = output_rx.recv() => {
                match maybe_chunk {
                    None => break wait_for_exit(&pty).await,
                    Some(chunk) => {
                        bus.publish(AppEvent::AgentOutput {
                            agent_id: agent_id.clone(),
                            data: chunk.clone(),
                        });

                        let text = String::from_utf8_lossy(&chunk);
                        for ch in text.chars() {
                            if ch == '\n' {
                                if let Some(detected) = detector.detect_line(&line_buf) {
                                    if matches!(detected, AgentStatus::Working) {
                                        spinner_last = Some(Instant::now());
                                    }
                                    set_status(&current_status, detected, &agent_id, &wm, &bus).await;
                                }
                                line_buf.clear();
                            } else if line_buf.len() < MAX_LINE_BYTES {
                                // Capped, as in pty_bridge: a full-screen TUI agent
                                // places every row with a cursor move and emits no
                                // newline for the length of a session, so an
                                // unbounded buffer here grew for as long as the
                                // agent lived.
                                line_buf.push(ch);
                            }
                        }

                        // Also check partial line (no trailing newline yet)
                        if let Some(detected) = detector.detect_line(&line_buf) {
                            if matches!(detected, AgentStatus::Working) {
                                spinner_last = Some(Instant::now());
                            }
                            set_status(&current_status, detected, &agent_id, &wm, &bus).await;
                        }

                        // Batch pass for the full-screen agents — Claude Code v2 and
                        // opencode both repaint in place, so their live status never
                        // reaches the line splitter above. Without this the TUI shows
                        // every agent as idle for its whole life, exactly as the
                        // desktop app did before pty_bridge grew the same call.
                        if let Some(detected) = detector.detect_batch(&text) {
                            if matches!(detected, AgentStatus::Working) {
                                spinner_last = Some(Instant::now());
                            }
                            set_status(&current_status, detected, &agent_id, &wm, &bus).await;
                        }

                        // NOTE: we deliberately do NOT auto-transition to Working on
                        // any output. Claude Code emits a welcome screen on startup
                        // that would trigger a false Working state. Only the spinner
                        // (braille, or v2's star cycle) should transition to Working.
                    }
                }
            }

            _ = ticker.tick() => {
                // If the agent has been in Working state but no spinner has been
                // seen for SPINNER_TIMEOUT, assume the turn finished: back to
                // Idle. Not AwaitingInput — silence means it stopped, not that
                // it is blocked on the user (see flock_core::status).
                if let Some(last) = spinner_last {
                    if last.elapsed() >= SPINNER_TIMEOUT {
                        let s = *current_status.read().await;
                        if matches!(s, AgentStatus::Working) {
                            set_status(
                                &current_status,
                                AgentStatus::Idle,
                                &agent_id,
                                &wm,
                                &bus,
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
        let mut s = current_status.write().await;
        *s = exit_status;
    }
    let _ = wm.update_agent_status(&agent_id, exit_status).await;
    bus.publish(AppEvent::AgentStatusChanged {
        agent_id: agent_id.clone(),
        status: exit_status,
    });
    bus.publish(AppEvent::AgentExited { agent_id, exit_code });
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

async fn set_status(
    current: &Arc<RwLock<AgentStatus>>,
    new: AgentStatus,
    agent_id: &AgentId,
    wm: &Arc<WorkspaceManager>,
    bus: &EventBus,
) {
    let mut s = current.write().await;
    if *s != new {
        *s = new;
        let _ = wm.update_agent_status(agent_id, new).await;
        bus.publish(AppEvent::AgentStatusChanged {
            agent_id: agent_id.clone(),
            status: new,
        });
    }
}
