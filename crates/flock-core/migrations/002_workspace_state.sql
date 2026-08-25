CREATE TABLE IF NOT EXISTS workspace_state (
    workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    state_json   TEXT NOT NULL,
    updated_at   INTEGER NOT NULL
);
