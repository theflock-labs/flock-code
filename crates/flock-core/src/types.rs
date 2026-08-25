use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct WorkspaceId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct AgentId(pub String);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AgentStatus {
    Idle,
    Working,
    AwaitingInput,
    Blocked,
    Done,
    Failed,
}

impl AgentStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Working => "working",
            Self::AwaitingInput => "awaiting_input",
            Self::Blocked => "blocked",
            Self::Done => "done",
            Self::Failed => "failed",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "working" => Self::Working,
            "awaiting_input" => Self::AwaitingInput,
            "blocked" => Self::Blocked,
            "done" => Self::Done,
            "failed" => Self::Failed,
            _ => Self::Idle,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workspace {
    pub id: WorkspaceId,
    pub name: String,
    pub repo_path: String,
    pub branch: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IdentityInfo {
    pub id: String,
    pub handle: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FriendRecord {
    pub id: String,
    pub handle: String,
    pub friend_status: String,
    pub presence: String,
    pub agent_count: i64,
    pub last_seen: Option<i64>,
    pub added_at: i64,
}

/// One row of the personal prompt queue: a captured prompt (+ optional staged
/// screenshots) that is either still `queued` or has been `launched` into a
/// pane. Mirrors the `prompt_queue_items` table 1:1. Not FK'd to a workspace —
/// launched history must outlive the pane/workspace it fired into, so
/// `target_label` snapshots a human-readable target at launch time.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueueItemRow {
    pub id: String,
    pub text: String,
    /// JSON array of filenames staged under `queue_images_dir/{id}/`.
    pub image_paths: String,
    /// `queued` | `launched`.
    pub status: String,
    pub workspace_id: Option<String>,
    pub agent_id: Option<String>,
    pub target_label: Option<String>,
    pub created_at: i64,
    pub launched_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Agent {
    pub id: AgentId,
    pub workspace_id: WorkspaceId,
    pub parent_agent_id: Option<AgentId>,
    pub kind: String,
    pub status: AgentStatus,
    pub last_status_at: i64,
}
