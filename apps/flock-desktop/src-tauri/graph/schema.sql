-- flock Graph schema (v2, knowledge-first). Runs once on first container
-- start via /docker-entrypoint-initdb.d. Must stay in sync with the queries
-- and the runtime `ensure_event_schema` in crates/flock-kg/src/lib.rs.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Every node is knowledge (Decision / Attempt / Note / Interface) or a File
-- anchor knowledge attaches to. Provenance — author, workspace, tenancy —
-- is metadata on the node, not graph structure.
CREATE TABLE IF NOT EXISTS kg_node (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind             TEXT NOT NULL,          -- Decision | Attempt | Note | Interface | File
    label            TEXT NOT NULL,          -- the title; titles are identity (same title = same note)
    body             TEXT,                   -- full knowledge; [[wikilinks]] auto-resolve to RELATES_TO
    workspace_id     TEXT,                   -- scope; 'global' = every workspace
    created_by_agent TEXT,                   -- provenance metadata, not a node
    -- Stable dedupe key for hub anchors (Person, Repo): the person_id or repo
    -- key, distinct from the human-readable `label`, so a hub survives a
    -- display-name change. Omitted here until 2026-08-09 while
    -- `ensure_event_schema` added it, which meant a graph brought up by hand
    -- with `docker compose up` had no such column: `upsert_anchor` failed, and
    -- because the provenance spine is best-effort it failed *silently* — no
    -- Person node, no Repo node, no AUTHORED_BY or IN_REPO edge, on a graph
    -- that otherwise looked healthy.
    anchor_key       TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),  -- bumped by title-upserts
    archived_at      TIMESTAMPTZ,            -- set by kg.forget; hidden from every read
    outcome          TEXT,                   -- Attempt only: success | failure | partial
    shipped_in       TEXT,                   -- Decision only: merged-PR stamp (title · url)
    -- Tenant tag on knowledge (flock Enterprise phase 4). Nullable, so
    -- single-tenant and pre-org nodes are unaffected. RLS builds on this.
    org_id           TEXT,
    team_id          TEXT,
    -- Semantic half of hybrid search: local bge-small-en-v1.5 embeddings
    -- (384-d) over label + body, written best-effort on every node write and
    -- backfilled in the background. NULL until the embedder has run; reads
    -- treat NULL as "FTS only".
    embedding        vector(384),
    -- Compaction. 0 for everything ever written; moved only by kg.compact and
    -- kg.restore, so it reads as "how many times has this been summarized away
    -- from what was actually said".
    compaction_level INT NOT NULL DEFAULT 0,
    compacted_at     TIMESTAMPTZ,
    original_bytes   INT                     -- body length before the first compaction
);

-- The text a compaction replaced, one row per level. This is what makes
-- compaction reversible: a summary that dropped the load-bearing sentence can
-- be undone rather than being a permanent edit to the record. Deliberately not
-- searchable — a snapshot is history, and indexing both it and its summary
-- would double every hit.
CREATE TABLE IF NOT EXISTS kg_node_snapshot (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    node_id          UUID NOT NULL REFERENCES kg_node(id) ON DELETE CASCADE,
    compaction_level INT NOT NULL,           -- the level this snapshot restores TO
    label            TEXT NOT NULL,
    body             TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kg_node_snapshot_node ON kg_node_snapshot (node_id, compaction_level DESC);
CREATE INDEX IF NOT EXISTS kg_node_org ON kg_node (org_id);

-- One File node per path; other kinds may repeat labels across scopes (the
-- title-upsert in the write path keeps knowledge kinds one-per-title anyway).
CREATE UNIQUE INDEX IF NOT EXISTS kg_node_file_path
    ON kg_node (label) WHERE kind = 'File';

-- One hub node per (kind, anchor_key): one Person per person_id, one Repo per
-- repo key, so every write links the same shared hub rather than minting a new
-- one. The ON CONFLICT in `upsert_anchor` names this index.
CREATE UNIQUE INDEX IF NOT EXISTS kg_node_anchor_key
    ON kg_node (kind, anchor_key) WHERE anchor_key IS NOT NULL;

-- Full-text search over label + body — the lexical half of hybrid search.
CREATE INDEX IF NOT EXISTS kg_node_fts
    ON kg_node USING GIN (to_tsvector('english', coalesce(label,'') || ' ' || coalesce(body,'')));

-- Cosine ANN over the embeddings — the semantic half. HNSW (not IVFFlat)
-- because it works on an empty table; NULL embeddings are simply absent.
CREATE INDEX IF NOT EXISTS kg_node_embedding
    ON kg_node USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS kg_node_kind ON kg_node (kind);
CREATE INDEX IF NOT EXISTS kg_node_workspace ON kg_node (workspace_id);

-- Edge vocabulary (see EDGE_VOCABULARY in flock-kg) — three edges, all
-- drawn automatically by the write tools:
--   ABOUT      knowledge → File       the code it concerns (`files` param)
--   RELATES_TO knowledge ↔ knowledge  associations (`relates_to` + [[wikilinks]])
--   SUPERSEDES knowledge → knowledge  newer replaces older (hides the old one)
CREATE TABLE IF NOT EXISTS kg_edge (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    from_node_id UUID NOT NULL REFERENCES kg_node(id) ON DELETE CASCADE,
    to_node_id   UUID NOT NULL REFERENCES kg_node(id) ON DELETE CASCADE,
    edge_type    TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (from_node_id, to_node_id, edge_type)
);

CREATE INDEX IF NOT EXISTS kg_edge_from ON kg_edge (from_node_id);
CREATE INDEX IF NOT EXISTS kg_edge_to   ON kg_edge (to_node_id);

-- Schema version marker; the one-time v1→v2 renovation in flock-kg keys
-- off it. Fresh installs are born at v2.
CREATE TABLE IF NOT EXISTS kg_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
INSERT INTO kg_meta (key, value) VALUES ('schema_version', '2')
    ON CONFLICT (key) DO NOTHING;

-- Append-only telemetry of every graph read and write (flock Enterprise
-- phase 1). One row per MCP tool call, per grounding pass, and per turn end.
-- This is the substrate the graph metrics are computed from — from fact_ids,
-- not from grounding_hits: summed over a lifetime that count only ever rose,
-- including through the releases in which the graph had stopped recording
-- anything. The org/team/person and token columns are nullable now so
-- multi-tenancy and usage sampling can land later without a schema migration.
CREATE TABLE IF NOT EXISTS kg_event (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ts             TIMESTAMPTZ NOT NULL DEFAULT now(),
    operation      TEXT NOT NULL,          -- tool name: query, write_decision, ground, ...
    kind           TEXT NOT NULL,          -- 'read' | 'write' | 'ground' | 'turn'
    workspace_id   TEXT,
    agent_id       TEXT,                   -- FLOCK_AGENT_NAME / FLOCK_PANE_ID
    org_id         TEXT,                   -- identity spine (phase 4); nullable today
    team_id        TEXT,
    person_id      TEXT,
    node_count     INT,                    -- rows returned (read) or nodes touched (write)
    grounding_hits INT,                    -- cardinality(fact_ids); kept for old rows, reported nowhere
    -- Which nodes those hits were, in the order the agent read them. Ground
    -- events only (empty array = a pass that found nothing); NULL on every
    -- other kind, and on ground rows written before this column existed.
    fact_ids       UUID[],
    latency_ms     INT,
    ok             BOOLEAN NOT NULL DEFAULT true,
    tokens_in      INT,                    -- usage sampling (phase 1 follow-on); nullable today
    tokens_out     INT,
    prompt_sha     TEXT,                   -- de-dupes repeated grounds without storing prompt text
    error          TEXT                    -- failure reason when ok = false
);

CREATE INDEX IF NOT EXISTS kg_event_ts        ON kg_event (ts);
CREATE INDEX IF NOT EXISTS kg_event_workspace ON kg_event (workspace_id);
CREATE INDEX IF NOT EXISTS kg_event_operation ON kg_event (operation);

-- Periodic account-spend samples (sampled token/cost source, flock
-- Enterprise phase 1). De-duped on write; joined to activity for cost-per-
-- outcome in the phase-3 analytics.
CREATE TABLE IF NOT EXISTS kg_usage_snapshot (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
    source      TEXT NOT NULL,          -- 'claude' | 'codex'
    used_minor  BIGINT NOT NULL,        -- account spend so far, minor units
    limit_minor BIGINT,
    currency    TEXT NOT NULL,
    exponent    INT NOT NULL DEFAULT 2,
    org_id      TEXT,
    person_id   TEXT
);

CREATE INDEX IF NOT EXISTS kg_usage_snapshot_ts     ON kg_usage_snapshot (ts);
CREATE INDEX IF NOT EXISTS kg_usage_snapshot_source ON kg_usage_snapshot (source);

-- Outcomes a team ships (merged PRs, closed tasks), flock Enterprise
-- phase 2. The unique key makes recording idempotent so the same merge
-- observed on repeated polls lands once. First observation also stamps
-- `shipped_in` on the decisions recorded about the changed files.
CREATE TABLE IF NOT EXISTS kg_outcome (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ts           TIMESTAMPTZ NOT NULL DEFAULT now(),
    workspace_id TEXT,
    kind         TEXT NOT NULL,          -- 'merged_pr' | 'closed_task'
    ref_id       TEXT NOT NULL,          -- PR url/number or task id
    title        TEXT,
    org_id       TEXT,
    person_id    TEXT,
    UNIQUE (kind, ref_id)
);

CREATE INDEX IF NOT EXISTS kg_outcome_ts        ON kg_outcome (ts);
CREATE INDEX IF NOT EXISTS kg_outcome_workspace ON kg_outcome (workspace_id);

-- Tenancy (flock Enterprise phase 4). An org has many teams; a person's
-- membership carries a role. `source` records how the org formed: an explicit
-- create-org/invite flow, or one derived from the referral graph.
CREATE TABLE IF NOT EXISTS kg_org (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       TEXT NOT NULL,
    source     TEXT NOT NULL DEFAULT 'explicit',   -- 'explicit' | 'referral'
    created_by TEXT,                                -- person_id
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS kg_team (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id     UUID NOT NULL REFERENCES kg_org(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS kg_membership (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    person_id  TEXT NOT NULL,
    org_id     UUID NOT NULL REFERENCES kg_org(id) ON DELETE CASCADE,
    team_id    UUID REFERENCES kg_team(id) ON DELETE SET NULL,
    role       TEXT NOT NULL DEFAULT 'member',      -- 'owner' | 'admin' | 'member'
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (person_id, org_id)
);

CREATE INDEX IF NOT EXISTS kg_event_org         ON kg_event (org_id);
CREATE INDEX IF NOT EXISTS kg_team_org          ON kg_team (org_id);
CREATE INDEX IF NOT EXISTS kg_membership_person ON kg_membership (person_id);
CREATE INDEX IF NOT EXISTS kg_membership_org    ON kg_membership (org_id);
