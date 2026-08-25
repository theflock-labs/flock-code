-- Backend-authoritative record of which workspaces run in Secure mode (the
-- Docker jail). The frontend passes `secure` on every spawn, but a compromised
-- webview could omit it to downgrade a workspace the user chose to secure into
-- an unconfined, permission-bypassed host launch (or drop the flag on restore).
-- Once a workspace has launched securely we remember it here and refuse to
-- downgrade it on any later spawn, so Secure mode fails closed.
CREATE TABLE IF NOT EXISTS workspace_security (
    workspace_id TEXT PRIMARY KEY,
    secure       INTEGER NOT NULL DEFAULT 0
);
