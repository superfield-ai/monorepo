-- Sharp complete episode model — typed artifacts, provenance, links, redactions.
--
-- ADDITIVE migration (rust-reorg decision #4): the generic episode model from
-- 0002 (sharp.episodes + sharp.episode_events + sharp.episode_artifacts +
-- sharp.episode_links) is preserved unchanged because sf-cli and superfield
-- depend on it.  This migration adds the *complete* episode model from the
-- TypeScript prototype (sharp/apps/server/src/episodes.ts) ALONGSIDE it:
--
--   * provenance columns on sharp.episodes (parent_commit, model_id,
--     agent_identity, harness_version, tool_versions, decoding_params,
--     promoted_commit, status),
--   * typed artifacts in a new sharp.episode_typed_artifacts table with a CAS
--     content_ref into sharp.objects(sha256) and an inline jsonb alternative,
--   * a relation-typed sharp.episode_relations table (sibling / retry_of /
--     replay_of / superseded_by), distinct from 0002's sharp.episode_links,
--   * sharp.episode_redactions, tracking destructive artifact redactions.
--
-- See docs/architecture.md §Sharp subsystem and docs/rust-reorg-decisions.md #4.
--
-- Idempotent: safe to re-run.

CREATE SCHEMA IF NOT EXISTS sharp;

-- ── episodes: provenance columns ─────────────────────────────────────────────
-- Added alongside the existing generic columns (title/state/opened_at/...).
-- All are nullable so existing generic episodes (opened via episode::open) keep
-- working without provenance, while complete-model episodes carry full lineage.
ALTER TABLE sharp.episodes
    ADD COLUMN IF NOT EXISTS parent_commit   TEXT,            -- hex sha of parent commit
    ADD COLUMN IF NOT EXISTS promoted_commit TEXT,            -- hex sha of promoted commit (NULL until promoted)
    ADD COLUMN IF NOT EXISTS agent_identity  TEXT,
    ADD COLUMN IF NOT EXISTS model_id        TEXT,
    ADD COLUMN IF NOT EXISTS harness_version TEXT,
    ADD COLUMN IF NOT EXISTS tool_versions   JSONB NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS decoding_params JSONB NOT NULL DEFAULT '{}',
    -- 'status' mirrors the TS lifecycle ('started'|'completed'|'failed'|'abandoned').
    -- Distinct from the generic 'state' column ('open'|'finished'|'abandoned'),
    -- which callers like sf-cli still use.  NULL for generic episodes.
    ADD COLUMN IF NOT EXISTS status          TEXT
                            CHECK (status IS NULL OR status IN
                                   ('started', 'completed', 'failed', 'abandoned'));

CREATE INDEX IF NOT EXISTS episodes_model_id_idx       ON sharp.episodes (model_id);
CREATE INDEX IF NOT EXISTS episodes_parent_commit_idx  ON sharp.episodes (parent_commit);
CREATE INDEX IF NOT EXISTS episodes_status_idx         ON sharp.episodes (status);

-- ── episode_typed_artifacts ──────────────────────────────────────────────────
-- Typed artifacts produced during a complete-model episode.  Each artifact
-- carries exactly one of:
--   * content_ref — a CAS pointer (hex sha256) into sharp.objects, for payloads
--     materialized in the content-addressed store, or
--   * inline      — a small jsonb payload stored directly.
-- Distinct from 0002's sharp.episode_artifacts, whose schema (path/blob_sha/
-- content) serves the generic model.
CREATE TABLE IF NOT EXISTS sharp.episode_typed_artifacts (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    episode_id  UUID        NOT NULL REFERENCES sharp.episodes(id) ON DELETE CASCADE,
    seq         BIGINT      NOT NULL,   -- monotonically increasing within episode
    kind        TEXT        NOT NULL
                            CHECK (kind IN ('prompt', 'context', 'tool_call',
                                            'tool_result', 'intermediate_patch',
                                            'validation', 'judge')),
    content_ref TEXT        REFERENCES sharp.objects(sha256),  -- CAS pointer (XOR inline)
    inline      JSONB,                                         -- inline payload (XOR content_ref)
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Exactly one of content_ref / inline must be set, unless the artifact has
    -- been redacted (both cleared by redact then inline rewritten).  We allow
    -- the inline-set / ref-set XOR; redaction always rewrites inline, so the
    -- XOR still holds (inline set, content_ref null).
    CONSTRAINT episode_typed_artifacts_payload_xor
        CHECK ((content_ref IS NULL) <> (inline IS NULL)),
    CONSTRAINT episode_typed_artifacts_seq_unique UNIQUE (episode_id, seq)
);

CREATE INDEX IF NOT EXISTS episode_typed_artifacts_episode_id_idx
    ON sharp.episode_typed_artifacts (episode_id);
CREATE INDEX IF NOT EXISTS episode_typed_artifacts_kind_idx
    ON sharp.episode_typed_artifacts (kind);

-- ── episode_relations ────────────────────────────────────────────────────────
-- Relation-typed directed edges between complete-model episodes.  Distinct from
-- 0002's sharp.episode_links (precedes/derives_from/references); these carry the
-- harness lineage relations (sibling/retry_of/replay_of/superseded_by).
CREATE TABLE IF NOT EXISTS sharp.episode_relations (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    from_episode UUID        NOT NULL REFERENCES sharp.episodes(id) ON DELETE CASCADE,
    to_episode   UUID        NOT NULL REFERENCES sharp.episodes(id) ON DELETE CASCADE,
    relation     TEXT        NOT NULL
                             CHECK (relation IN ('sibling', 'retry_of',
                                                 'replay_of', 'superseded_by')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT episode_relations_unique UNIQUE (from_episode, to_episode, relation)
);

CREATE INDEX IF NOT EXISTS episode_relations_from_idx ON sharp.episode_relations (from_episode);
CREATE INDEX IF NOT EXISTS episode_relations_to_idx   ON sharp.episode_relations (to_episode);

-- ── episode_redactions ───────────────────────────────────────────────────────
-- Audit log of destructive artifact redactions.  Redacting an artifact clears
-- its content_ref, rewrites inline with a replacement payload, and records a row
-- here (policy + actor) for provenance.
CREATE TABLE IF NOT EXISTS sharp.episode_redactions (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    episode_id  UUID        NOT NULL REFERENCES sharp.episodes(id) ON DELETE CASCADE,
    seq         BIGINT      NOT NULL,   -- targeted episode_typed_artifacts.seq
    policy      TEXT        NOT NULL,
    actor       TEXT        NOT NULL,
    redacted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS episode_redactions_episode_id_idx
    ON sharp.episode_redactions (episode_id);
