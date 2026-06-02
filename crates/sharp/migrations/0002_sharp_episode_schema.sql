-- Sharp agent-episode schema — episodes, artifacts, links.
--
-- Episodes track the lifecycle of an agent's editing session against a Sharp
-- repo.  All tables live in the `sharp` schema alongside the VCS core tables.
-- See docs/architecture.md §Schema namespace assignment and agent-warning:
--   "Sharp's episode schema goes in the `sharp` schema on the shared instance."
--
-- episode_state: 'open' | 'finished' | 'abandoned'
-- artifact_kind: 'file_snapshot' | 'diff_patch' | 'note' | 'tool_call'
-- link_kind: 'precedes' | 'derives_from' | 'references'

CREATE SCHEMA IF NOT EXISTS sharp;

-- ── episodes ─────────────────────────────────────────────────────────────────
-- An episode represents one agent editing session against a Sharp repo.
CREATE TABLE IF NOT EXISTS sharp.episodes (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    repo_id     UUID        NOT NULL REFERENCES sharp.repos(id) ON DELETE CASCADE,
    title       TEXT        NOT NULL,
    state       TEXT        NOT NULL DEFAULT 'open'
                            CHECK (state IN ('open', 'finished', 'abandoned')),
    opened_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ,
    metadata    JSONB       NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS episodes_repo_id_idx ON sharp.episodes (repo_id);
CREATE INDEX IF NOT EXISTS episodes_state_idx   ON sharp.episodes (state);

-- ── episode_events ───────────────────────────────────────────────────────────
-- Append-only log of events within an episode (tool calls, snapshots, notes).
CREATE TABLE IF NOT EXISTS sharp.episode_events (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    episode_id  UUID        NOT NULL REFERENCES sharp.episodes(id) ON DELETE CASCADE,
    seq         BIGINT      NOT NULL,   -- monotonically increasing within episode
    event_type  TEXT        NOT NULL,
    payload     JSONB       NOT NULL DEFAULT '{}',
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT episode_events_seq_unique UNIQUE (episode_id, seq)
);

CREATE INDEX IF NOT EXISTS episode_events_episode_id_idx ON sharp.episode_events (episode_id);

-- ── episode_artifacts ────────────────────────────────────────────────────────
-- Durable artifacts produced during an episode (file snapshots, diff patches).
CREATE TABLE IF NOT EXISTS sharp.episode_artifacts (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    episode_id  UUID        NOT NULL REFERENCES sharp.episodes(id) ON DELETE CASCADE,
    kind        TEXT        NOT NULL
                            CHECK (kind IN ('file_snapshot', 'diff_patch', 'note', 'tool_call')),
    path        TEXT,                  -- file path if kind is file_snapshot or diff_patch
    blob_sha    TEXT,                  -- references sharp.objects(sha256) when applicable
    content     TEXT,                  -- inline content for notes / small payloads
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS episode_artifacts_episode_id_idx ON sharp.episode_artifacts (episode_id);

-- ── episode_links ────────────────────────────────────────────────────────────
-- Directed edges between episodes (provenance graph).
CREATE TABLE IF NOT EXISTS sharp.episode_links (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    src_id      UUID        NOT NULL REFERENCES sharp.episodes(id) ON DELETE CASCADE,
    dst_id      UUID        NOT NULL REFERENCES sharp.episodes(id) ON DELETE CASCADE,
    kind        TEXT        NOT NULL
                            CHECK (kind IN ('precedes', 'derives_from', 'references')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT episode_links_unique UNIQUE (src_id, dst_id, kind)
);

CREATE INDEX IF NOT EXISTS episode_links_src_idx ON sharp.episode_links (src_id);
CREATE INDEX IF NOT EXISTS episode_links_dst_idx ON sharp.episode_links (dst_id);
