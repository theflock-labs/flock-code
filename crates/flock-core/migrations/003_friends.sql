-- Identity: persists a single user UUID + display handle.
-- Two rows: key='id' and key='handle'.
CREATE TABLE IF NOT EXISTS identity (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Friend relationships (local social graph).
-- presence + agent_count are runtime state updated by the presence WebSocket;
-- they're stored here so the last-known state survives a restart.
CREATE TABLE IF NOT EXISTS friends (
    id           TEXT PRIMARY KEY,
    handle       TEXT NOT NULL,
    friend_status TEXT NOT NULL DEFAULT 'pending_out',
    presence     TEXT NOT NULL DEFAULT 'offline',
    agent_count  INTEGER NOT NULL DEFAULT 0,
    last_seen    INTEGER,
    added_at     INTEGER NOT NULL
);
