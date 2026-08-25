CREATE TABLE IF NOT EXISTS prompt_queue_items (
    id           TEXT PRIMARY KEY,
    text         TEXT NOT NULL,
    image_paths  TEXT NOT NULL DEFAULT '[]', -- JSON array of filenames under queue_images_dir/{id}/
    status       TEXT NOT NULL DEFAULT 'queued', -- 'queued' | 'launched'
    workspace_id TEXT,      -- set at launch
    agent_id     TEXT,      -- pane id, set at launch
    target_label TEXT,      -- e.g. "clarence-code · claude", snapshotted at launch (pane_ids/names are ephemeral)
    created_at   INTEGER NOT NULL,
    launched_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_prompt_queue_created ON prompt_queue_items(created_at);
