-- Sharp runtime signal workspace scoping — issue #708.
--
-- `sharp.runtime_signals` (0004) was created before the runtime-signal feeder
-- threaded production signals through to the brain. To let an agent join a
-- signal to its requirement and code WITHOUT leaking signals across tenants,
-- every signal must carry the workspace that produced it, and the nexum
-- projection (nexum.entities / nexum.relations) must inherit that same
-- workspace_id.
--
-- This migration adds `workspace_id UUID NOT NULL REFERENCES public.workspaces(id)`
-- to `sharp.runtime_signals` so a cross-workspace read cannot surface another
-- tenant's signals. It is idempotent (guarded ADD COLUMN / ADD CONSTRAINT).
--
-- Acceptance criterion (issue #708):
--   "Signals carry workspace_id so a cross-workspace read does not surface them."
--
-- See docs/architecture.md §Daemon Lifecycle and §Single-Instance Database
-- Schema Layout.

DO $$
BEGIN
    -- Add the column if absent. NOT NULL is safe on a clean dev/test database
    -- (matching the 0003_workspace_id_threading.sql convention: no backfill).
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'sharp'
          AND table_name   = 'runtime_signals'
          AND column_name  = 'workspace_id'
    ) THEN
        ALTER TABLE sharp.runtime_signals
            ADD COLUMN workspace_id UUID NOT NULL;
    END IF;

    -- Add FK constraint if absent.
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints
        WHERE constraint_type = 'FOREIGN KEY'
          AND table_schema    = 'sharp'
          AND table_name      = 'runtime_signals'
          AND constraint_name = 'fk_runtime_signals_workspace_id'
    ) THEN
        ALTER TABLE sharp.runtime_signals
            ADD CONSTRAINT fk_runtime_signals_workspace_id
            FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id);
    END IF;
END $$;

-- Index for per-workspace scans and RLS filtering.
CREATE INDEX IF NOT EXISTS runtime_signals_workspace_id_idx
    ON sharp.runtime_signals (workspace_id);
