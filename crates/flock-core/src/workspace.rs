use crate::types::{
    Agent, AgentId, AgentStatus, FriendRecord, IdentityInfo, QueueItemRow, Workspace, WorkspaceId,
};
use anyhow::Result;
use sqlx::SqlitePool;
use uuid::Uuid;

pub struct WorkspaceManager {
    /// Crate-visible so sibling modules can hang their own query sets off this
    /// one manager (see `provenance`) instead of opening a second pool against
    /// the same file — two pools would each hold their own WAL reader and
    /// serialize on writes for no benefit.
    pub(crate) pool: SqlitePool,
}

impl WorkspaceManager {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn create(&self, name: &str, repo_path: &str, branch: &str) -> Result<Workspace> {
        let id = Uuid::new_v4().to_string();
        let now = chrono::Utc::now().timestamp();
        // New workspaces always land at the end of the sidebar, regardless of
        // any manual reordering already applied to existing rows.
        let position: i64 =
            sqlx::query_scalar("SELECT COALESCE(MAX(position), -1) + 1 FROM workspaces")
                .fetch_one(&self.pool)
                .await?;

        sqlx::query(
            "INSERT INTO workspaces (id, name, repo_path, branch, created_at, position) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(name)
        .bind(repo_path)
        .bind(branch)
        .bind(now)
        .bind(position)
        .execute(&self.pool)
        .await?;

        Ok(Workspace {
            id: WorkspaceId(id),
            name: name.to_string(),
            repo_path: repo_path.to_string(),
            branch: branch.to_string(),
            created_at: now,
        })
    }

    pub async fn list(&self) -> Result<Vec<Workspace>> {
        let rows = sqlx::query_as::<_, (String, String, String, String, i64)>(
            "SELECT id, name, repo_path, branch, created_at FROM workspaces ORDER BY position, created_at",
        )
        .fetch_all(&self.pool)
        .await?;

        Ok(rows
            .into_iter()
            .map(|(id, name, repo_path, branch, created_at)| Workspace {
                id: WorkspaceId(id),
                name,
                repo_path,
                branch,
                created_at,
            })
            .collect())
    }

    /// Persist a drag-and-drop reorder: `ids` is the full sidebar order the
    /// user landed on, front to back.
    pub async fn reorder(&self, ids: &[String]) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        for (i, id) in ids.iter().enumerate() {
            sqlx::query("UPDATE workspaces SET position = ? WHERE id = ?")
                .bind(i as i64)
                .bind(id)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn register_agent(
        &self,
        workspace_id: &WorkspaceId,
        kind: &str,
    ) -> Result<Agent> {
        let id = Uuid::new_v4().to_string();
        let now = chrono::Utc::now().timestamp();

        sqlx::query(
            "INSERT INTO agents (id, workspace_id, kind, status, last_status_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(&workspace_id.0)
        .bind(kind)
        .bind(AgentStatus::Idle.as_str())
        .bind(now)
        .execute(&self.pool)
        .await?;

        Ok(Agent {
            id: AgentId(id),
            workspace_id: workspace_id.clone(),
            parent_agent_id: None,
            kind: kind.to_string(),
            status: AgentStatus::Idle,
            last_status_at: now,
        })
    }

    pub async fn update_agent_status(
        &self,
        agent_id: &AgentId,
        status: AgentStatus,
    ) -> Result<()> {
        let now = chrono::Utc::now().timestamp();
        sqlx::query(
            "UPDATE agents SET status = ?, last_status_at = ? WHERE id = ?",
        )
        .bind(status.as_str())
        .bind(now)
        .bind(&agent_id.0)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn list_agents(&self, workspace_id: &WorkspaceId) -> Result<Vec<Agent>> {
        let rows = sqlx::query_as::<_, (String, String, Option<String>, String, String, i64)>(
            "SELECT id, workspace_id, parent_agent_id, kind, status, last_status_at FROM agents WHERE workspace_id = ?",
        )
        .bind(&workspace_id.0)
        .fetch_all(&self.pool)
        .await?;

        Ok(rows
            .into_iter()
            .map(
                |(id, ws_id, parent_id, kind, status, last_status_at)| Agent {
                    id: AgentId(id),
                    workspace_id: WorkspaceId(ws_id),
                    parent_agent_id: parent_id.map(AgentId),
                    kind,
                    status: AgentStatus::from_str(&status),
                    last_status_at,
                },
            )
            .collect())
    }

    pub async fn delete_agents(&self, workspace_id: &WorkspaceId) -> Result<()> {
        sqlx::query("DELETE FROM agents WHERE workspace_id = ?")
            .bind(&workspace_id.0)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn delete(&self, workspace_id: &WorkspaceId) -> Result<()> {
        // pane_buffers isn't FK'd to workspaces, so clear its rows explicitly
        // (agents + workspace_state cascade via their own foreign keys).
        sqlx::query("DELETE FROM pane_buffers WHERE workspace_id = ?")
            .bind(&workspace_id.0)
            .execute(&self.pool)
            .await?;
        sqlx::query("DELETE FROM workspaces WHERE id = ?")
            .bind(&workspace_id.0)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn rename(&self, workspace_id: &WorkspaceId, name: &str) -> Result<()> {
        sqlx::query("UPDATE workspaces SET name = ? WHERE id = ?")
            .bind(name)
            .bind(&workspace_id.0)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn save_state(&self, workspace_id: &WorkspaceId, state_json: &str) -> Result<()> {
        let now = chrono::Utc::now().timestamp();
        sqlx::query(
            "INSERT INTO workspace_state (workspace_id, state_json, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(workspace_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at",
        )
        .bind(&workspace_id.0)
        .bind(state_json)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn load_state(&self, workspace_id: &WorkspaceId) -> Result<Option<String>> {
        let row = sqlx::query_as::<_, (String,)>(
            "SELECT state_json FROM workspace_state WHERE workspace_id = ?",
        )
        .bind(&workspace_id.0)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|(s,)| s))
    }

    // ─── Secure mode (authoritative) ──────────────────────────────────────────

    /// Remember that a workspace has launched in Secure mode (the Docker jail),
    /// so a later spawn can't silently downgrade it. See [`is_workspace_secure`].
    pub async fn mark_workspace_secure(&self, workspace_id: &str) -> Result<()> {
        sqlx::query(
            "INSERT INTO workspace_security (workspace_id, secure) VALUES (?, 1)
             ON CONFLICT(workspace_id) DO UPDATE SET secure = 1",
        )
        .bind(workspace_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Whether a workspace has ever launched in Secure mode. Spawns OR this with
    /// the caller-supplied flag so Secure mode fails closed: it can be turned on
    /// per spawn but never turned off for a workspace the user already secured.
    pub async fn is_workspace_secure(&self, workspace_id: &str) -> Result<bool> {
        let row = sqlx::query_as::<_, (i64,)>(
            "SELECT secure FROM workspace_security WHERE workspace_id = ?",
        )
        .bind(workspace_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|(s,)| s != 0).unwrap_or(false))
    }

    // ─── Pane scrollback ──────────────────────────────────────────────────────

    /// Persist a pane's terminal scrollback so it can be replayed after a
    /// restart. Upserts by pane_id.
    pub async fn save_pane_buffer(
        &self,
        pane_id: &str,
        workspace_id: &str,
        data: &[u8],
    ) -> Result<()> {
        let now = chrono::Utc::now().timestamp();
        sqlx::query(
            "INSERT INTO pane_buffers (pane_id, workspace_id, data, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(pane_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, workspace_id = excluded.workspace_id",
        )
        .bind(pane_id)
        .bind(workspace_id)
        .bind(data)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Read back a pane's persisted scrollback (empty/None if never saved).
    pub async fn load_pane_buffer(&self, pane_id: &str) -> Result<Option<Vec<u8>>> {
        let row = sqlx::query_as::<_, (Vec<u8>,)>(
            "SELECT data FROM pane_buffers WHERE pane_id = ?",
        )
        .bind(pane_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|(d,)| d))
    }

    /// Age out persisted buffers not touched in `max_age_secs`. Deliberately
    /// *not* "delete everything not currently live": workspaces restore
    /// lazily, so a not-yet-opened workspace's buffers must survive until the
    /// user switches to it. Live panes re-save (bumping updated_at) every
    /// persist pass, so only truly stale entries age out.
    pub async fn prune_stale_pane_buffers(&self, max_age_secs: i64) -> Result<()> {
        let cutoff = chrono::Utc::now().timestamp() - max_age_secs;
        sqlx::query("DELETE FROM pane_buffers WHERE updated_at < ?")
            .bind(cutoff)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Forget a single pane's buffer (e.g. when the user closes that pane).
    pub async fn delete_pane_buffer(&self, pane_id: &str) -> Result<()> {
        sqlx::query("DELETE FROM pane_buffers WHERE pane_id = ?")
            .bind(pane_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    // ─── Prompt queue ─────────────────────────────────────────────────────────

    /// Insert a freshly-captured prompt (status defaults to `queued`).
    pub async fn queue_add(
        &self,
        id: &str,
        text: &str,
        image_paths: &str,
        now: i64,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO prompt_queue_items (id, text, image_paths, status, created_at)
             VALUES (?, ?, ?, 'queued', ?)",
        )
        .bind(id)
        .bind(text)
        .bind(image_paths)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn queue_get(&self, id: &str) -> Result<Option<QueueItemRow>> {
        let row = sqlx::query_as::<_, QueueTuple>(
            "SELECT id, text, image_paths, status, workspace_id, agent_id, target_label, created_at, launched_at
             FROM prompt_queue_items WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(queue_row_from_tuple))
    }

    /// All queue rows, oldest first (the frontend groups + reverse-chrons them).
    pub async fn queue_list(&self) -> Result<Vec<QueueItemRow>> {
        let rows = sqlx::query_as::<_, QueueTuple>(
            "SELECT id, text, image_paths, status, workspace_id, agent_id, target_label, created_at, launched_at
             FROM prompt_queue_items ORDER BY created_at ASC",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(queue_row_from_tuple).collect())
    }

    /// Edit a queued prompt's text. The `status='queued'` guard is defense in
    /// depth — launched history is immutable, not just by UI convention.
    pub async fn queue_update_text(&self, id: &str, text: &str) -> Result<()> {
        sqlx::query("UPDATE prompt_queue_items SET text = ? WHERE id = ? AND status = 'queued'")
            .bind(text)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn queue_delete(&self, id: &str) -> Result<()> {
        sqlx::query("DELETE FROM prompt_queue_items WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Flip a queued row to `launched`, snapshotting where it fired.
    pub async fn queue_mark_launched(
        &self,
        id: &str,
        workspace_id: &str,
        agent_id: &str,
        target_label: &str,
        launched_at: i64,
    ) -> Result<()> {
        sqlx::query(
            "UPDATE prompt_queue_items
             SET status = 'launched', workspace_id = ?, agent_id = ?, target_label = ?, launched_at = ?
             WHERE id = ? AND status = 'queued'",
        )
        .bind(workspace_id)
        .bind(agent_id)
        .bind(target_label)
        .bind(launched_at)
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    // ─── Identity ─────────────────────────────────────────────────────────────

    pub async fn get_or_create_identity(&self) -> Result<IdentityInfo> {
        let id_row = sqlx::query_as::<_, (String,)>(
            "SELECT value FROM identity WHERE key = 'id'",
        )
        .fetch_optional(&self.pool)
        .await?;

        if let Some((id,)) = id_row {
            let handle_row = sqlx::query_as::<_, (String,)>(
                "SELECT value FROM identity WHERE key = 'handle'",
            )
            .fetch_optional(&self.pool)
            .await?;
            return Ok(IdentityInfo {
                id,
                handle: handle_row.map(|(h,)| h).unwrap_or_default(),
            });
        }

        // First run — generate a UUID identity
        let id = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO identity (key, value) VALUES ('id', ?)")
            .bind(&id)
            .execute(&self.pool)
            .await?;
        sqlx::query("INSERT INTO identity (key, value) VALUES ('handle', '')")
            .execute(&self.pool)
            .await?;
        Ok(IdentityInfo { id, handle: String::new() })
    }

    pub async fn set_handle(&self, handle: &str) -> Result<()> {
        sqlx::query(
            "INSERT INTO identity (key, value) VALUES ('handle', ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .bind(handle)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    // ─── Friends ──────────────────────────────────────────────────────────────

    pub async fn list_friends(&self) -> Result<Vec<FriendRecord>> {
        let rows = sqlx::query_as::<_, (String, String, String, String, i64, Option<i64>, i64)>(
            "SELECT id, handle, friend_status, presence, agent_count, last_seen, added_at
             FROM friends ORDER BY added_at",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|(id, handle, friend_status, presence, agent_count, last_seen, added_at)| {
                FriendRecord { id, handle, friend_status, presence, agent_count, last_seen, added_at }
            })
            .collect())
    }

    pub async fn add_friend(&self, handle: &str) -> Result<FriendRecord> {
        let id = Uuid::new_v4().to_string();
        let now = chrono::Utc::now().timestamp();
        sqlx::query(
            "INSERT INTO friends (id, handle, friend_status, presence, agent_count, added_at)
             VALUES (?, ?, 'pending_out', 'offline', 0, ?)",
        )
        .bind(&id)
        .bind(handle)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(FriendRecord {
            id,
            handle: handle.to_string(),
            friend_status: "pending_out".into(),
            presence: "offline".into(),
            agent_count: 0,
            last_seen: None,
            added_at: now,
        })
    }

    pub async fn remove_friend(&self, id: &str) -> Result<()> {
        sqlx::query("DELETE FROM friends WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn update_friend_presence(
        &self,
        id: &str,
        presence: &str,
        agent_count: i64,
        last_seen: Option<i64>,
    ) -> Result<()> {
        sqlx::query(
            "UPDATE friends SET presence = ?, agent_count = ?, last_seen = ? WHERE id = ?",
        )
        .bind(presence)
        .bind(agent_count)
        .bind(last_seen)
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn update_friend_status(&self, id: &str, status: &str) -> Result<()> {
        sqlx::query("UPDATE friends SET friend_status = ? WHERE id = ?")
            .bind(status)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }
}

/// Column tuple for `prompt_queue_items`, matching the codebase's tuple-mapping
/// convention (structs aren't `FromRow`-derived here).
type QueueTuple = (
    String,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    i64,
    Option<i64>,
);

fn queue_row_from_tuple(t: QueueTuple) -> QueueItemRow {
    let (id, text, image_paths, status, workspace_id, agent_id, target_label, created_at, launched_at) =
        t;
    QueueItemRow {
        id,
        text,
        image_paths,
        status,
        workspace_id,
        agent_id,
        target_label,
        created_at,
        launched_at,
    }
}
