-- Manual drag-and-drop ordering for the workspace sidebar. Existing rows all
-- default to 0, so `ORDER BY position, created_at` falls back to the
-- previous creation-order behavior until a user actually reorders something.
ALTER TABLE workspaces ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
