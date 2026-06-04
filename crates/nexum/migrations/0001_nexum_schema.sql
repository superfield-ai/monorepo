-- Migration: 0001_nexum_schema.sql
-- Owner: nexum crate (Nexum knowledge-graph component)
-- Schema: nexum
--
-- Creates the `nexum` PostgreSQL schema and its core tables.
-- All statements are idempotent (CREATE ... IF NOT EXISTS throughout).
--
-- STUB — Phase: Substrate foundations (issue #426 scout)
-- This file defines the boundary interface so that:
--   - The unified migration runner (#428) can apply it at startup.
--   - workspace_id threading (#429) can add the column here.
--   - RLS policies (#430) can target nexum.* tables.
--   - The TypeScript nexum repo migration can be cross-referenced.
--
-- This schema mirrors the TypeScript `db/schema.sql` but places all tables
-- in the `nexum` schema rather than `public`.  The Rust crate's `query.rs`
-- and integration tests already use fully-qualified `nexum.<table>` references;
-- `ingest.rs` must be updated to match.
--
-- See docs/scouts/426-postgres-schema-map.md §Integration Points and Risks for
-- the gap analysis between TypeScript `public` tables and these `nexum.*` tables.
--
-- See docs/architecture.md §Schema namespace assignment and §Migration ownership.

-- 1. Schema ------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS nexum;

-- 2. Extensions --------------------------------------------------------------
-- The vector extension is required for embedding columns.
-- pgcrypto provides gen_random_uuid().
-- These must be installed on the shared Postgres instance before this migration runs.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";

-- 3. corpora -----------------------------------------------------------------

CREATE TABLE IF NOT EXISTS nexum.corpora (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT        NOT NULL,
    description TEXT,
    meta        JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. documents ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS nexum.documents (
    id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    corpus_id          UUID        REFERENCES nexum.corpora(id),
    title              TEXT        NOT NULL,
    source_path        TEXT,
    source_format      TEXT        CHECK (source_format IN ('pdf', 'docx', 'markdown')),
    current_version_id UUID,       -- FK set after first version inserted; see constraint below
    external_id        TEXT,
    meta               JSONB,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS documents_corpus_id_idx
    ON nexum.documents (corpus_id);
CREATE INDEX IF NOT EXISTS documents_corpus_id_external_id_idx
    ON nexum.documents (corpus_id, external_id);

-- 5. document_versions -------------------------------------------------------

CREATE TABLE IF NOT EXISTS nexum.document_versions (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    doc_id      UUID        NOT NULL REFERENCES nexum.documents(id),
    version_num INTEGER     NOT NULL,
    label       TEXT,
    status      TEXT        NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'parsed', 'embedded', 'done', 'error')),
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    meta        JSONB,
    UNIQUE (doc_id, version_num)
);

-- Deferred FK from documents.current_version_id → document_versions.id
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'fk_current_version_nexum'
          AND table_name = 'documents'
          AND table_schema = 'nexum'
    ) THEN
        ALTER TABLE nexum.documents
            ADD CONSTRAINT fk_current_version_nexum
            FOREIGN KEY (current_version_id) REFERENCES nexum.document_versions(id)
            DEFERRABLE INITIALLY DEFERRED;
    END IF;
END $$;

-- 6. blocks ------------------------------------------------------------------
-- Content-addressed; unchanged blocks are shared across versions.

CREATE TABLE IF NOT EXISTS nexum.blocks (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    doc_id          UUID        NOT NULL REFERENCES nexum.documents(id),
    content         TEXT        NOT NULL,
    content_hash    TEXT        NOT NULL,       -- SHA-256 of content; used for dedup on re-ingest
    block_type      TEXT        NOT NULL,       -- paragraph, heading, list_item, table
    level           INTEGER,                    -- heading depth; NULL for non-headings
    line_start      INTEGER,
    line_end        INTEGER,
    eid             TEXT,                       -- Akoma Ntoso eId if source is AKN
    parent_block_id UUID        REFERENCES nexum.blocks(id),
    -- 384-dim governed embedding (all-MiniLM-L6-v2).
    -- See issue #432 (embedding governance) and docs/scouts/426-postgres-schema-map.md.
    embedding       vector(384),
    tsv             TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
    meta            JSONB
);

CREATE INDEX IF NOT EXISTS blocks_doc_content_hash_idx
    ON nexum.blocks (doc_id, content_hash);
CREATE INDEX IF NOT EXISTS blocks_embedding_hnsw_idx
    ON nexum.blocks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS blocks_tsv_gin_idx
    ON nexum.blocks USING gin (tsv);
CREATE INDEX IF NOT EXISTS blocks_parent_block_id_idx
    ON nexum.blocks (parent_block_id);

-- 7. version_blocks ----------------------------------------------------------

CREATE TABLE IF NOT EXISTS nexum.version_blocks (
    version_id  UUID        NOT NULL REFERENCES nexum.document_versions(id),
    block_id    UUID        NOT NULL REFERENCES nexum.blocks(id),
    seq         INTEGER     NOT NULL,
    PRIMARY KEY (version_id, block_id)
);

CREATE INDEX IF NOT EXISTS version_blocks_block_id_idx
    ON nexum.version_blocks (block_id);
CREATE UNIQUE INDEX IF NOT EXISTS version_blocks_version_seq_idx
    ON nexum.version_blocks (version_id, seq);

-- 8. links -------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS nexum.links (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    src           UUID        NOT NULL REFERENCES nexum.blocks(id),
    dst           UUID        NOT NULL REFERENCES nexum.blocks(id),
    layer         TEXT        NOT NULL
                              CHECK (layer IN ('structural', 'semantic', 'ai')),
    rel_type      TEXT,
    weight        FLOAT       NOT NULL DEFAULT 1.0,
    confirmed     BOOLEAN,
    provenance    JSONB       NOT NULL,
    -- Stub: 384-dim edge embedding, populated by issue #75 / #431.
    -- NULL for all rows until the edge encoder is wired.
    edge_embedding vector(384),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS links_src_idx       ON nexum.links (src);
CREATE INDEX IF NOT EXISTS links_dst_idx       ON nexum.links (dst);
CREATE INDEX IF NOT EXISTS links_src_layer_idx ON nexum.links (src, layer);
CREATE INDEX IF NOT EXISTS links_dst_layer_idx ON nexum.links (dst, layer);
CREATE INDEX IF NOT EXISTS links_edge_embedding_hnsw_idx
    ON nexum.links USING hnsw (edge_embedding vector_cosine_ops);

-- 9. entities and relations --------------------------------------------------
-- Used by the causal-chain query (crates/nexum/src/causal_chain.rs).
-- These tables live in the nexum schema; causal_chain.rs currently uses
-- unqualified names — that code must be updated to use nexum.entities and
-- nexum.relations when this migration is applied.
-- See docs/scouts/426-postgres-schema-map.md §Integration Points and Risks.

CREATE TABLE IF NOT EXISTS nexum.entities (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    type        TEXT        NOT NULL,       -- error, session, user, requirement, code
    properties  JSONB       NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS nexum.relations (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id   UUID        NOT NULL REFERENCES nexum.entities(id),
    target_id   UUID        NOT NULL REFERENCES nexum.entities(id),
    type        TEXT        NOT NULL,       -- caused_in, initiated_by, fulfills, implemented_by
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS relations_source_id_idx ON nexum.relations (source_id);
CREATE INDEX IF NOT EXISTS relations_target_id_idx ON nexum.relations (target_id);

-- 10. corpus_access ----------------------------------------------------------

CREATE TABLE IF NOT EXISTS nexum.corpus_access (
    entity_id   UUID        NOT NULL REFERENCES nexum.entities(id),
    corpus_id   UUID        NOT NULL REFERENCES nexum.corpora(id),
    scopes      TEXT[]      NOT NULL DEFAULT '{}',
    PRIMARY KEY (entity_id, corpus_id)
);

-- 11. job_queue --------------------------------------------------------------

CREATE TABLE IF NOT EXISTS nexum.job_queue (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    job_type    TEXT        NOT NULL,
    payload     JSONB       NOT NULL,
    status      TEXT        NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'running', 'done', 'failed')),
    attempts    INTEGER     NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS job_queue_pending_idx
    ON nexum.job_queue (job_type, status, created_at)
    WHERE status = 'pending';
