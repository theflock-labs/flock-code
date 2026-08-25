-- Provenance: one durable row per agent session, so "what did the fleet do,
-- who ran it, and what did it cost" survives the app closing. Everything that
-- answered that question before lived only in live UI state — the pane grid,
-- the notification feed, a transcript scan — and was gone on quit.
--
-- WHAT IS RECORDED: who (person id/handle, agent display name), where
-- (workspace, repo, branch, working directory, whether it was an isolated
-- worktree, whether it ran in the container jail), when (start, end, every
-- status transition), how much (prompts submitted, tokens, estimated cost).
--
-- WHAT IS DELIBERATELY NOT RECORDED: prompt text, agent output, file contents,
-- diffs. `prompts` is a count and nothing else. An export of this table is
-- meant to be handed to a security reviewer or a finance team, and neither
-- needs the contents of anyone's conversation to do their job. There is no
-- flag that turns prompt text on, because the safest place to keep a secret
-- someone pasted into an agent is nowhere.
--
-- No foreign key to `workspaces`, on purpose. Every other per-workspace table
-- CASCADE-deletes with it, which is right for state and catastrophic for an
-- audit record: deleting a workspace would erase the evidence that its agents
-- ever ran. `workspace_name` is snapshotted for the same reason — the row has
-- to stay legible after the workspace it names is gone.
CREATE TABLE IF NOT EXISTS agent_sessions (
    id                 TEXT PRIMARY KEY,
    -- The pane this session ran in. Not unique over time: restore respawns
    -- every pane with a fresh uuid, so one pane id belongs to one session.
    pane_id            TEXT NOT NULL,
    workspace_id       TEXT NOT NULL,
    workspace_name     TEXT NOT NULL DEFAULT '',
    agent_name         TEXT NOT NULL DEFAULT '',
    -- claude | opencode | codex | pi
    agent_kind         TEXT NOT NULL DEFAULT '',
    person_id          TEXT NOT NULL DEFAULT '',
    person_name        TEXT NOT NULL DEFAULT '',
    -- Origin remote URL where there is one, else `path:<toplevel>`; see
    -- git::repo_identity. Stable across clones and worktrees of one project.
    repo_id            TEXT NOT NULL DEFAULT '',
    repo_name          TEXT NOT NULL DEFAULT '',
    cwd                TEXT NOT NULL DEFAULT '',
    branch             TEXT NOT NULL DEFAULT '',
    worktree           INTEGER NOT NULL DEFAULT 0,
    secure             INTEGER NOT NULL DEFAULT 0,
    -- Claude Code's --session-id, when flock imposed one. The only handle that
    -- ties this row back to a transcript, and therefore the only way tokens and
    -- cost can be attributed to *this* agent rather than to the machine.
    transcript_ref     TEXT NOT NULL DEFAULT '',
    started_at         INTEGER NOT NULL,
    ended_at           INTEGER,
    -- Last time anything was written for this session. A force-quit leaves
    -- ended_at NULL, and this is what the next launch closes the row out at —
    -- otherwise an interrupted session reads as one that ran until you noticed.
    updated_at         INTEGER NOT NULL,
    -- running | closed (user closed the pane) | exited (the process ended) |
    -- interrupted (flock was not running when it ended)
    outcome            TEXT NOT NULL DEFAULT 'running',
    prompts            INTEGER NOT NULL DEFAULT 0,
    last_status        TEXT NOT NULL DEFAULT 'idle',
    tokens_input       INTEGER NOT NULL DEFAULT 0,
    tokens_output      INTEGER NOT NULL DEFAULT 0,
    tokens_cache_read  INTEGER NOT NULL DEFAULT 0,
    tokens_cache_write INTEGER NOT NULL DEFAULT 0,
    -- Micros, not a float: SQLite would store REAL and an exported total would
    -- drift by a cent over a few thousand rows. Estimated — transcripts record
    -- tokens, and the dollars come from flock's own price table.
    cost_usd_micros    INTEGER NOT NULL DEFAULT 0
);

-- Range queries are the only read path (the export takes a from/to), and both
-- ends of a session matter because a session that spans the window has to
-- appear in it.
CREATE INDEX IF NOT EXISTS idx_agent_sessions_started ON agent_sessions(started_at);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_ended ON agent_sessions(ended_at);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_pane ON agent_sessions(pane_id);

-- Every status transition, append-only. Separate from the session row because
-- "the agent was blocked on a permission prompt for 40 minutes" is the sort of
-- thing a reviewer asks about, and a single last_status column cannot answer
-- it. CASCADEs with its session (and only with its session).
CREATE TABLE IF NOT EXISTS agent_session_status (
    session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    at         INTEGER NOT NULL,
    status     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_session_status_session
    ON agent_session_status(session_id, at);
