-- Nexum schema migration — 0001: create schema and tables in shared instance
--
-- This migration creates the `nexum` schema and all Nexum tables under the
-- single shared Postgres instance (architecture §6 — namespaced schemas).
--
-- Each table includes a `workspace_key` column for row-level security (RLS)
-- scoping. RLS policies will be added in a follow-up migration once the
-- shared auth schema is defined (§7 gap #3).
--
-- References:
--   docs/architecture.md §6 (Single Postgres instance, namespaced schemas)
--   docs/architecture.md §Single-Instance Database Schema Layout
--   issue #355 (schema boundary decision)
--   issue #368 (this migration)

-- Schema creation is the first step per architecture §6.
CREATE SCHEMA IF NOT EXISTS nexum;

-- Required extensions live at the database level (not per-schema).
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

-- schema_migrations: version tracking for the nexum schema.
-- Follows Sharp's pattern (sequential NNNN__name files in transactions).
CREATE TABLE IF NOT EXISTS nexum.schema_migrations (
    version     TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Corpora: optional grouping of documents (e.g. a legislative archive, a case file).
-- workspace_key scopes rows to a workspace for future RLS.
CREATE TABLE IF NOT EXISTS nexum.corpora (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_key  TEXT NOT NULL,
    name           TEXT NOT NULL,
    description    TEXT,
    meta           JSONB,
    created_at     TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS nexum_corpora_workspace_key_idx
    ON nexum.corpora (workspace_key);

-- Document registry: the logical identity of a document across all its versions.
CREATE TABLE IF NOT EXISTS nexum.documents (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_key      TEXT NOT NULL,
    corpus_id          UUID REFERENCES nexum.corpora(id),
    title              TEXT NOT NULL,
    source_path        TEXT,
    source_format      TEXT CHECK (source_format IN ('pdf', 'docx', 'markdown')),
    current_version_id UUID,
    external_id        TEXT,
    meta               JSONB,
    created_at         TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS nexum_documents_workspace_key_idx
    ON nexum.documents (workspace_key);
CREATE INDEX IF NOT EXISTS nexum_documents_corpus_id_idx
    ON nexum.documents (corpus_id);
CREATE INDEX IF NOT EXISTS nexum_documents_corpus_id_external_id_idx
    ON nexum.documents (corpus_id, external_id);

-- One row per ingested version of a document.
CREATE TABLE IF NOT EXISTS nexum.document_versions (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_key TEXT NOT NULL,
    doc_id        UUID NOT NULL REFERENCES nexum.documents(id),
    version_num   INTEGER NOT NULL,
    label         TEXT,
    status        TEXT DEFAULT 'pending'
                  CHECK (status IN ('pending', 'parsed', 'embedded', 'done', 'error')),
    ingested_at   TIMESTAMPTZ DEFAULT now(),
    meta          JSONB,
    UNIQUE (doc_id, version_num)
);

CREATE INDEX IF NOT EXISTS nexum_document_versions_workspace_key_idx
    ON nexum.document_versions (workspace_key);

-- Deferred FK from documents.current_version_id → document_versions.id.
-- Added after both tables exist to avoid circular dependency.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'nexum_fk_current_version'
          AND table_name = 'documents'
          AND table_schema = 'nexum'
    ) THEN
        ALTER TABLE nexum.documents
            ADD CONSTRAINT nexum_fk_current_version
            FOREIGN KEY (current_version_id) REFERENCES nexum.document_versions(id)
            DEFERRABLE INITIALLY DEFERRED;
    END IF;
END $$;

-- Blocks: immutable once created, content-addressed by hash.
-- Unchanged blocks are shared across versions via version_blocks.
-- Dimension 384 matches all-MiniLM-L6-v2 (governed by issue #360).
CREATE TABLE IF NOT EXISTS nexum.blocks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_key   TEXT NOT NULL,
    doc_id          UUID NOT NULL REFERENCES nexum.documents(id),
    content         TEXT NOT NULL,
    content_hash    TEXT NOT NULL,
    block_type      TEXT NOT NULL,
    level           INTEGER,
    line_start      INTEGER,
    line_end        INTEGER,
    eid             TEXT,
    parent_block_id UUID REFERENCES nexum.blocks(id),
    embedding       vector(384),
    tsv             TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
    meta            JSONB
);

CREATE INDEX IF NOT EXISTS nexum_blocks_workspace_key_idx
    ON nexum.blocks (workspace_key);
CREATE INDEX IF NOT EXISTS nexum_blocks_doc_content_hash_idx
    ON nexum.blocks (doc_id, content_hash);
-- HNSW index on block embeddings (cosine ops, dimension 384).
CREATE INDEX IF NOT EXISTS nexum_blocks_embedding_hnsw_idx
    ON nexum.blocks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS nexum_blocks_tsv_gin_idx
    ON nexum.blocks USING gin (tsv);
CREATE INDEX IF NOT EXISTS nexum_blocks_parent_block_id_idx
    ON nexum.blocks (parent_block_id);

-- Junction table: maps versions to their ordered set of blocks.
CREATE TABLE IF NOT EXISTS nexum.version_blocks (
    version_id    UUID NOT NULL REFERENCES nexum.document_versions(id),
    block_id      UUID NOT NULL REFERENCES nexum.blocks(id),
    seq           INTEGER NOT NULL,
    PRIMARY KEY (version_id, block_id)
);

CREATE INDEX IF NOT EXISTS nexum_version_blocks_block_id_idx
    ON nexum.version_blocks (block_id);
CREATE UNIQUE INDEX IF NOT EXISTS nexum_version_blocks_version_seq_idx
    ON nexum.version_blocks (version_id, seq);

-- Links: the graph edges between blocks.
-- Unchanged blocks share their UUID across versions; links are inherited.
CREATE TABLE IF NOT EXISTS nexum.links (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_key  TEXT NOT NULL,
    src            UUID NOT NULL REFERENCES nexum.blocks(id),
    dst            UUID NOT NULL REFERENCES nexum.blocks(id),
    layer          TEXT NOT NULL CHECK (layer IN ('structural', 'semantic', 'ai')),
    rel_type       TEXT,
    weight         FLOAT DEFAULT 1.0,
    confirmed      BOOLEAN,
    provenance     JSONB NOT NULL,
    -- Edge-embedding stub: populated by the Rust ingestion pipeline (issue #366/#75).
    -- Dimension 384 matches block embeddings (governed by issue #360).
    edge_embedding vector(384),
    created_at     TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS nexum_links_workspace_key_idx
    ON nexum.links (workspace_key);
CREATE INDEX IF NOT EXISTS nexum_links_src_idx ON nexum.links (src);
CREATE INDEX IF NOT EXISTS nexum_links_dst_idx ON nexum.links (dst);
CREATE INDEX IF NOT EXISTS nexum_links_src_layer_idx ON nexum.links (src, layer);
CREATE INDEX IF NOT EXISTS nexum_links_dst_layer_idx ON nexum.links (dst, layer);
CREATE INDEX IF NOT EXISTS nexum_links_edge_embedding_hnsw_idx
    ON nexum.links USING hnsw (edge_embedding vector_cosine_ops);

-- Entities: users and agents that can authenticate via API key.
CREATE TABLE IF NOT EXISTS nexum.entities (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_key  TEXT NOT NULL,
    type           TEXT NOT NULL CHECK (type IN ('user', 'agent')),
    name           TEXT NOT NULL,
    api_key_hash   TEXT,
    scopes         TEXT[] DEFAULT '{}',
    created_at     TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS nexum_entities_workspace_key_idx
    ON nexum.entities (workspace_key);

-- Corpus access: maps entities to corpora with specific scopes.
CREATE TABLE IF NOT EXISTS nexum.corpus_access (
    entity_id  UUID NOT NULL REFERENCES nexum.entities(id),
    corpus_id  UUID NOT NULL REFERENCES nexum.corpora(id),
    scopes     TEXT[] NOT NULL DEFAULT '{}',
    PRIMARY KEY (entity_id, corpus_id)
);

-- Job queue: async ingestion tasks.
CREATE TABLE IF NOT EXISTS nexum.job_queue (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_key  TEXT NOT NULL,
    job_type       TEXT NOT NULL,
    payload        JSONB NOT NULL,
    status         TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed')),
    attempts       INTEGER DEFAULT 0,
    created_at     TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS nexum_job_queue_workspace_key_idx
    ON nexum.job_queue (workspace_key);
CREATE INDEX IF NOT EXISTS nexum_job_queue_pending_idx
    ON nexum.job_queue (job_type, status, created_at)
    WHERE status = 'pending';
