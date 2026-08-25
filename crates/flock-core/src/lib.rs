pub mod agent;
pub mod db;
pub mod event;
pub mod paths;
pub mod provenance;
pub mod status;
pub mod types;
pub mod workspace;

pub use agent::AgentHandle;
pub use event::{AppEvent, EventBus};
pub use provenance::{AgentSession, SessionTokens, StatusChange, Totals};
pub use types::{
    Agent, AgentId, AgentStatus, FriendRecord, IdentityInfo, QueueItemRow, Workspace, WorkspaceId,
};
pub use workspace::WorkspaceManager;

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[tokio::test]
    async fn workspace_crud_roundtrip() {
        let db_path = Path::new("/tmp/flock_test.db");
        let _ = std::fs::remove_file(db_path);

        let pool = db::init_pool(db_path).await.unwrap();
        let wm = WorkspaceManager::new(pool);

        // Create
        let ws = wm.create("test-ws", "/tmp/repo", "main").await.unwrap();
        assert_eq!(ws.name, "test-ws");
        assert_eq!(ws.branch, "main");

        // List
        let list = wm.list().await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "test-ws");

        // Register agent + status update
        let agent = wm.register_agent(&ws.id, "claude").await.unwrap();
        assert!(matches!(agent.status, AgentStatus::Idle));

        wm.update_agent_status(&agent.id, AgentStatus::Working).await.unwrap();
        let agents = wm.list_agents(&ws.id).await.unwrap();
        assert_eq!(agents.len(), 1);
        assert!(matches!(agents[0].status, AgentStatus::Working));

        let _ = std::fs::remove_file(db_path);
    }

    #[tokio::test]
    async fn prompt_queue_roundtrip() {
        let db_path = Path::new("/tmp/flock_queue_test.db");
        let _ = std::fs::remove_file(db_path);

        let pool = db::init_pool(db_path).await.unwrap();
        let wm = WorkspaceManager::new(pool);

        // Add
        wm.queue_add("q1", "fix the parser", "[\"img-1.png\"]", 100).await.unwrap();
        let got = wm.queue_get("q1").await.unwrap().unwrap();
        assert_eq!(got.text, "fix the parser");
        assert_eq!(got.status, "queued");
        assert_eq!(got.image_paths, "[\"img-1.png\"]");
        assert_eq!(got.created_at, 100);
        assert!(got.launched_at.is_none());

        // List
        wm.queue_add("q2", "second", "[]", 200).await.unwrap();
        let list = wm.queue_list().await.unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, "q1"); // created_at ASC

        // Update text (allowed while queued)
        wm.queue_update_text("q1", "fix the parser properly").await.unwrap();
        assert_eq!(wm.queue_get("q1").await.unwrap().unwrap().text, "fix the parser properly");

        // Mark launched, then confirm text edits are refused
        wm.queue_mark_launched("q1", "ws-1", "pane-1", "flock · claude", 300)
            .await
            .unwrap();
        let launched = wm.queue_get("q1").await.unwrap().unwrap();
        assert_eq!(launched.status, "launched");
        assert_eq!(launched.workspace_id.as_deref(), Some("ws-1"));
        assert_eq!(launched.agent_id.as_deref(), Some("pane-1"));
        assert_eq!(launched.target_label.as_deref(), Some("flock · claude"));
        assert_eq!(launched.launched_at, Some(300));

        wm.queue_update_text("q1", "should be ignored").await.unwrap();
        assert_eq!(wm.queue_get("q1").await.unwrap().unwrap().text, "fix the parser properly");

        // Delete
        wm.queue_delete("q2").await.unwrap();
        assert_eq!(wm.queue_list().await.unwrap().len(), 1);

        let _ = std::fs::remove_file(db_path);
    }
}
