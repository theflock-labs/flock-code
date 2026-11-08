use serde::{Deserialize, Serialize};

/// Workspace projection sent to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceInfo {
    pub id: String,
    pub name: String,
    pub repo_path: String,
    pub branch: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaneInfo {
    pub id: String,
    pub workspace_id: String,
    pub kind: String,
    pub status: String,
    pub rows: u16,
    pub cols: u16,
    /// Whether the agent has taken the terminal over yet (see `boot.rs`). The
    /// boot card stays up until it has.
    #[serde(default)]
    pub started: bool,
}

// Live PTY output no longer rides the Tauri event bus — it streams over a
// per-terminal binary IPC channel (subscribe_pane_output) to avoid the
// JSON-number-array encoding an emitted Vec<u8> would incur. Only the
// low-frequency exit/status signals remain as events.

#[derive(Debug, Clone, Serialize)]
pub struct PtyExitEvent {
    pub pane_id: String,
    pub exit_code: i32,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentStatusEvent {
    pub pane_id: String,
    /// One of "idle" | "working" | "awaiting_input" | "blocked" | "done" | "failed"
    pub status: String,
}

/// One pane's agent has taken the terminal over from flock's boot plumbing
/// (see `boot.rs`). Fires once per pane, on the global `agent://started`.
#[derive(Debug, Clone, Serialize)]
pub struct AgentStartedEvent {
    pub pane_id: String,
}

/// Emit a status transition on both channels: the per-pane topic popped-out
/// windows listen to, and the one global topic the main window listens to.
///
/// The global topic is what lets the main window keep a single listener for
/// every pane instead of one per mounted terminal: v2 only mounts terminals for
/// the panes on screen, but the sidebar still has to see every agent's status.
pub fn emit_status(app: &tauri::AppHandle, pane_id: &str, status: &str) {
    use tauri::Emitter;
    let event = AgentStatusEvent { pane_id: pane_id.to_string(), status: status.to_string() };
    let _ = app.emit(&format!("agent://status/{pane_id}"), event.clone());
    let _ = app.emit("agent://status", event);
}

/// Emit the once-per-pane "agent started" signal.
pub fn emit_started(app: &tauri::AppHandle, pane_id: &str) {
    use tauri::Emitter;
    let _ = app.emit("agent://started", AgentStartedEvent { pane_id: pane_id.to_string() });
}
