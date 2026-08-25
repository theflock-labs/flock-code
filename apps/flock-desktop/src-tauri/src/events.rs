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
