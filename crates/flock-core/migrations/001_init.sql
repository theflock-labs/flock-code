CREATE TABLE IF NOT EXISTS workspaces (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    repo_path   TEXT NOT NULL,
    branch      TEXT NOT NULL,
    created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
    id              TEXT PRIMARY KEY,
    workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    parent_agent_id TEXT REFERENCES agents(id),
    kind            TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'idle',
    last_status_at  INTEGER NOT NULL
);
