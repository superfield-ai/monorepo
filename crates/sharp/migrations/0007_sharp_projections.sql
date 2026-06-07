-- Sharp projections — continuous speculative merge state.
--
-- Ports sharp/apps/server/src/projections.ts onto the existing `sharp` schema.
--
-- A projection for (repo_id, branch_ref, target_ref) holds the always-up-to-date
-- result of running the Tier-1 (text) merge over those two branches. It is
-- computed LAZILY: on first access or when marked stale. The `mark_projections_stale`
-- trigger on `sharp.refs` marks any matching projection stale whenever either
-- input ref advances.
--
-- Hash columns (branch_tip, target_tip, projection_commit) are stored as hex TEXT,
-- matching the rest of the crate (see docs/rust-reorg-decisions.md §2), rather than
-- bytea as in the TS prototype. Projection commits use the existing single-parent
-- JSON commit model (sharp.commit_metadata / sharp.commit_paths) rather than the
-- TS two-parent git-canonical model.
--
-- See docs/architecture.md §sharp schema and whitepaper §6.7.
--
-- Idempotent: safe to re-run.

-- ── projections ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sharp.projections (
    repo_id           UUID        NOT NULL REFERENCES sharp.repos(id) ON DELETE CASCADE,
    branch_ref        TEXT        NOT NULL,
    target_ref        TEXT        NOT NULL,
    branch_tip        TEXT,                  -- hex SHA of the branch tip at compute time
    target_tip        TEXT,                  -- hex SHA of the target tip at compute time
    projection_commit TEXT        REFERENCES sharp.objects(sha256),  -- merged commit, when clean
    status            TEXT        NOT NULL DEFAULT 'stale'
                                  CHECK (status IN ('clean', 'dilemma', 'stale', 'error')),
    dilemma           JSONB,                 -- set when status = 'dilemma' or 'error'
    computed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT projections_pkey PRIMARY KEY (repo_id, branch_ref, target_ref)
);

CREATE INDEX IF NOT EXISTS projections_repo_id_idx ON sharp.projections (repo_id);
CREATE INDEX IF NOT EXISTS projections_status_idx  ON sharp.projections (repo_id, status);

-- ── mark_projections_stale trigger ──────────────────────────────────────────────
-- Whenever a ref is inserted or its target advances, mark every projection that
-- uses that ref (as branch_ref or target_ref) stale, so the next access recomputes.
CREATE OR REPLACE FUNCTION sharp.mark_projections_stale() RETURNS trigger AS $$
BEGIN
    UPDATE sharp.projections
       SET status = 'stale'
     WHERE repo_id = NEW.repo_id
       AND (branch_ref = NEW.ref_name OR target_ref = NEW.ref_name)
       AND status <> 'stale';
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS refs_mark_projections_stale ON sharp.refs;
CREATE TRIGGER refs_mark_projections_stale
    AFTER INSERT OR UPDATE ON sharp.refs
    FOR EACH ROW
    EXECUTE FUNCTION sharp.mark_projections_stale();
