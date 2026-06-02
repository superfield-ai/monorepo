-- Sharp runtime signal schema — production errors and behavioral signals.
--
-- Production runtime errors and behavioral signals from deployed apps are
-- captured as `sharp.runtime_signals`, each linked to a Sharp episode and
-- optionally to the deployment that caused them.
--
-- This resolves gap #8 (scout doc 388): no runtime-error-to-episode ingestion
-- seam existed before this migration.
--
-- signal_kind: 'error' | 'crash' | 'health_failure' | 'behavior'
--
-- See docs/architecture.md §Deploy and runtime-signal loop and issue #381.

CREATE SCHEMA IF NOT EXISTS sharp;

-- ── runtime_signals ───────────────────────────────────────────────────────────
-- One row per runtime error or behavioral signal captured from a deployed app.
-- Always linked to a Sharp episode (the session that produced the deployment).
CREATE TABLE IF NOT EXISTS sharp.runtime_signals (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    episode_id      UUID        NOT NULL REFERENCES sharp.episodes(id) ON DELETE CASCADE,
    -- deployment_id is an opaque string (e.g. GitHub Deployment ID or a
    -- SHA-1 image tag) that identifies the deployed change that produced this
    -- signal.  NULL when the deployment is unknown.
    deployment_id   TEXT,
    signal_kind     TEXT        NOT NULL
                                CHECK (signal_kind IN ('error', 'crash', 'health_failure', 'behavior')),
    -- source identifies where the signal came from (e.g. "pod/api-server",
    -- "healthz", "github-actions/deploy-workflow").
    source          TEXT        NOT NULL,
    -- message is the raw error message, log line, or behavioral description.
    message         TEXT        NOT NULL,
    -- payload holds structured context (stack traces, labels, k8s metadata).
    payload         JSONB       NOT NULL DEFAULT '{}',
    recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS runtime_signals_episode_id_idx
    ON sharp.runtime_signals (episode_id);
CREATE INDEX IF NOT EXISTS runtime_signals_deployment_id_idx
    ON sharp.runtime_signals (deployment_id)
    WHERE deployment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS runtime_signals_kind_idx
    ON sharp.runtime_signals (signal_kind);
