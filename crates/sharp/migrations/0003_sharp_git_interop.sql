-- Sharp Git interop schema — git_objects and git_refs.
--
-- All tables live in the `sharp` PostgreSQL schema.
-- See docs/architecture.md §sharp schema, and whitepaper §7.
--
-- git_objects stores the canonical (inflated) bytes of every Git object
-- imported into Sharp, keyed by the Git SHA-1 hex.  The kind column is
-- one of blob|tree|commit|tag, matching Git's object types.
--
-- git_refs mirrors the Git ref namespace for an imported or in-progress
-- Sharp repo so that export can reconstruct a byte-identical bare repo.
--
-- Idempotent: safe to run on a database that already has this migration applied.

-- ── git_objects ──────────────────────────────────────────────────────────────
-- Stores the raw canonical payload bytes (inflated, without the Git object
-- header) for each Git object, keyed by its Git SHA-1.
-- Used by both import (ingest from disk) and export (write back to disk).
CREATE TABLE IF NOT EXISTS sharp.git_objects (
    sha1        TEXT        NOT NULL,
    repo_id     UUID        NOT NULL REFERENCES sharp.repos(id) ON DELETE CASCADE,
    kind        TEXT        NOT NULL CHECK (kind IN ('blob', 'tree', 'commit', 'tag')),
    data        BYTEA       NOT NULL,
    imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (repo_id, sha1)
);

CREATE INDEX IF NOT EXISTS git_objects_repo_id_idx ON sharp.git_objects (repo_id);

-- ── git_refs ─────────────────────────────────────────────────────────────────
-- Mirrors the Git ref namespace (branches, tags, HEAD) for a repo.
-- ref_name: e.g. 'refs/heads/main', 'refs/tags/v1.0'
-- sha1:     hex SHA-1 of the target commit/tag object.
-- For symbolic refs (HEAD → refs/heads/main) sha1 is NULL and symbolic_target
-- holds the destination ref name.
CREATE TABLE IF NOT EXISTS sharp.git_refs (
    repo_id         UUID        NOT NULL REFERENCES sharp.repos(id) ON DELETE CASCADE,
    ref_name        TEXT        NOT NULL,
    sha1            TEXT,                -- NULL for symbolic refs
    symbolic_target TEXT,               -- NULL for direct refs
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (repo_id, ref_name),
    CONSTRAINT git_refs_direct_or_symbolic
        CHECK ((sha1 IS NOT NULL) != (symbolic_target IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS git_refs_repo_id_idx ON sharp.git_refs (repo_id);
