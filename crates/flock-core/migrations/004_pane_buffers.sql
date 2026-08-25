-- Persisted terminal scrollback per pane, so an agent's on-screen history
-- survives an app restart. Keyed by the pane's UUID; workspace_id lets us
-- prune a workspace's buffers when it's deleted. `data` is the raw PTY byte
-- tail (same bytes the in-memory OutputRing holds), replayed into a fresh
-- xterm on restore.
CREATE TABLE IF NOT EXISTS pane_buffers (
    pane_id      TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    data         BLOB NOT NULL,
    updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pane_buffers_workspace ON pane_buffers(workspace_id);
