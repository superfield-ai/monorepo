-- Sharp VCS core schema — objects, refs, commits, DAG.
--
-- All tables live in the `sharp` PostgreSQL schema.
-- See docs/architecture.md §Single-Instance Database Schema Layout § Schema namespace assignment.
--
-- Idempotent: safe to run on a database that already has this migration applied.

CREATE SCHEMA IF NOT EXISTS sharp;

-- ── repos ────────────────────────────────────────────────────────────────────
-- A repo is the root of a Sharp VCS namespace.
CREATE TABLE IF NOT EXISTS sharp.repos (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT repos_name_unique UNIQUE (name)
);

-- ── objects ──────────────────────────────────────────────────────────────────
-- Content-addressed storage; sha256 hex of the raw bytes.
-- object_type: 'blob' | 'tree' | 'commit'
CREATE TABLE IF NOT EXISTS sharp.objects (
    sha256      TEXT        PRIMARY KEY,   -- hex-encoded SHA-256 of content
    repo_id     UUID        NOT NULL REFERENCES sharp.repos(id) ON DELETE CASCADE,
    object_type TEXT        NOT NULL CHECK (object_type IN ('blob', 'tree', 'commit')),
    size_bytes  BIGINT      NOT NULL,
    data        BYTEA       NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS objects_repo_id_idx ON sharp.objects (repo_id);

-- ── refs ─────────────────────────────────────────────────────────────────────
-- Named pointers into the object graph (branches, tags, HEAD).
-- ref_name: e.g. 'refs/heads/main', 'refs/tags/v1.0', 'HEAD'
CREATE TABLE IF NOT EXISTS sharp.refs (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    repo_id     UUID        NOT NULL REFERENCES sharp.repos(id) ON DELETE CASCADE,
    ref_name    TEXT        NOT NULL,
    target_sha  TEXT        NOT NULL REFERENCES sharp.objects(sha256),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT refs_repo_name_unique UNIQUE (repo_id, ref_name)
);

CREATE INDEX IF NOT EXISTS refs_repo_id_idx ON sharp.refs (repo_id);

-- ── commit_metadata ──────────────────────────────────────────────────────────
-- Denormalised metadata extracted from commit objects for fast querying.
-- The authoritative data lives in objects.data; this table is derived.
CREATE TABLE IF NOT EXISTS sharp.commit_metadata (
    commit_sha  TEXT        PRIMARY KEY REFERENCES sharp.objects(sha256),
    repo_id     UUID        NOT NULL REFERENCES sharp.repos(id) ON DELETE CASCADE,
    parent_sha  TEXT        REFERENCES sharp.objects(sha256),  -- NULL for root commit
    message     TEXT        NOT NULL,
    author      TEXT        NOT NULL,
    authored_at TIMESTAMPTZ NOT NULL,
    committed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS commit_metadata_repo_id_idx ON sharp.commit_metadata (repo_id);
CREATE INDEX IF NOT EXISTS commit_metadata_parent_sha_idx ON sharp.commit_metadata (parent_sha);

-- ── commit_paths ─────────────────────────────────────────────────────────────
-- Maps each commit to the set of file paths it touches.
-- Used for cross-component joins with nexum.documents.
CREATE TABLE IF NOT EXISTS sharp.commit_paths (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    commit_sha  TEXT        NOT NULL REFERENCES sharp.objects(sha256),
    repo_id     UUID        NOT NULL REFERENCES sharp.repos(id) ON DELETE CASCADE,
    path        TEXT        NOT NULL,
    blob_sha    TEXT        REFERENCES sharp.objects(sha256)  -- NULL = deletion
);

CREATE INDEX IF NOT EXISTS commit_paths_commit_sha_idx ON sharp.commit_paths (commit_sha);
CREATE INDEX IF NOT EXISTS commit_paths_repo_id_idx ON sharp.commit_paths (repo_id);
CREATE INDEX IF NOT EXISTS commit_paths_path_idx ON sharp.commit_paths (path);
