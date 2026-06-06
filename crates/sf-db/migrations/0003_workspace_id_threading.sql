-- Migration: 0003_workspace_id_threading.sql
-- Owner: sf-db crate (shared substrate)
-- Schema: public workspaces table must exist (0001_workspaces.sql); all
--         component schemas must have been created before this migration runs.
--
-- Adds `workspace_id UUID NOT NULL REFERENCES workspaces(id)` to every core
-- table across all component schemas (nexum.*, sharp.*, auth.*).
--
-- Also back-fills FK constraints on auth.sessions and auth.app_installations,
-- which already carry workspace_id UUID NOT NULL without a FK because the
-- workspaces table did not yet exist when those tables were created.
--
-- Per the issue-429 acceptance criteria:
--   - All core tables have workspace_id UUID NOT NULL with FK.
--   - migrate up succeeds on a clean database.
--
-- Design notes:
--   - The migration assumes a clean (dev/test) database — no existing rows
--     need to be backfilled (per scope: "dev/test environments are reset").
--   - Every ADD COLUMN / ADD CONSTRAINT block is guarded by an IF NOT EXISTS
--     check in a DO $$ ... $$ block so the file is safe to re-run.
--   - The workspaces table must be populated with at least one row before data
--     can be inserted into any workspace-keyed table.
--
-- Issue: #429
-- Depends on: 0001_workspaces.sql (public.workspaces)
-- RLS policies: separate migration (issue #430)
--
-- See docs/architecture.md §Single-Instance Database Schema Layout.
-- See docs/scouts/426-postgres-schema-map.md §workspace_id Column Status.

-- ---------------------------------------------------------------------------
-- Helper: idempotent ADD COLUMN + FK for workspace_id on a given table.
-- Usage: CALL add_workspace_id('schema_name', 'table_name');
-- ---------------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE add_workspace_id(p_schema TEXT, p_table TEXT)
LANGUAGE plpgsql AS $$
DECLARE
  v_fk_name TEXT;
BEGIN
  -- Add the column if absent.
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = p_schema
      AND table_name   = p_table
      AND column_name  = 'workspace_id'
  ) THEN
    EXECUTE format(
      'ALTER TABLE %I.%I ADD COLUMN workspace_id UUID NOT NULL',
      p_schema, p_table
    );
    RAISE NOTICE 'workspace_id_threading: added workspace_id column to %.%', p_schema, p_table;
  ELSE
    RAISE NOTICE 'workspace_id_threading: workspace_id column already present on %.%, skipping ADD COLUMN', p_schema, p_table;
  END IF;

  -- Add FK constraint if absent.  Constraint name follows the pattern
  -- fk_<table>_workspace_id to be predictable and queryable.
  v_fk_name := format('fk_%s_workspace_id', p_table);
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage  kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema   = kcu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema    = p_schema
      AND tc.table_name      = p_table
      AND tc.constraint_name = v_fk_name
  ) THEN
    EXECUTE format(
      'ALTER TABLE %I.%I ADD CONSTRAINT %I
         FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id)',
      p_schema, p_table, v_fk_name
    );
    RAISE NOTICE 'workspace_id_threading: added FK constraint % on %.%', v_fk_name, p_schema, p_table;
  ELSE
    RAISE NOTICE 'workspace_id_threading: FK constraint % already exists on %.%, skipping', v_fk_name, p_schema, p_table;
  END IF;

  -- Add a supporting index on workspace_id for efficient per-workspace scans
  -- and future RLS filtering.
  -- NOTE: CREATE INDEX IF NOT EXISTS avoids the nested DO $$ ... $$ block that
  -- would conflict with the outer procedure delimiter.
  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS %I ON %I.%I (workspace_id)',
    format('%s_%s_workspace_id_idx', p_schema, p_table),
    p_schema, p_table
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- nexum schema — core tables
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF to_regclass('nexum.corpora') IS NOT NULL THEN
    CALL add_workspace_id('nexum', 'corpora');
  ELSE
    RAISE NOTICE 'workspace_id_threading: nexum.corpora does not exist yet, skipping';
  END IF;

  IF to_regclass('nexum.documents') IS NOT NULL THEN
    CALL add_workspace_id('nexum', 'documents');
  ELSE
    RAISE NOTICE 'workspace_id_threading: nexum.documents does not exist yet, skipping';
  END IF;

  IF to_regclass('nexum.document_versions') IS NOT NULL THEN
    CALL add_workspace_id('nexum', 'document_versions');
  ELSE
    RAISE NOTICE 'workspace_id_threading: nexum.document_versions does not exist yet, skipping';
  END IF;

  IF to_regclass('nexum.blocks') IS NOT NULL THEN
    CALL add_workspace_id('nexum', 'blocks');
  ELSE
    RAISE NOTICE 'workspace_id_threading: nexum.blocks does not exist yet, skipping';
  END IF;

  IF to_regclass('nexum.links') IS NOT NULL THEN
    CALL add_workspace_id('nexum', 'links');
  ELSE
    RAISE NOTICE 'workspace_id_threading: nexum.links does not exist yet, skipping';
  END IF;

  IF to_regclass('nexum.entities') IS NOT NULL THEN
    CALL add_workspace_id('nexum', 'entities');
  ELSE
    RAISE NOTICE 'workspace_id_threading: nexum.entities does not exist yet, skipping';
  END IF;

  IF to_regclass('nexum.relations') IS NOT NULL THEN
    CALL add_workspace_id('nexum', 'relations');
  ELSE
    RAISE NOTICE 'workspace_id_threading: nexum.relations does not exist yet, skipping';
  END IF;

  IF to_regclass('nexum.job_queue') IS NOT NULL THEN
    CALL add_workspace_id('nexum', 'job_queue');
  ELSE
    RAISE NOTICE 'workspace_id_threading: nexum.job_queue does not exist yet, skipping';
  END IF;

  -- corpus_access and version_blocks are junction tables that inherit workspace
  -- scoping via their parent FK (corpus_id, entity_id, version_id); workspace_id
  -- is not added here because it would be redundant and cause circular FK issues
  -- during test resets.  RLS on these tables uses joins.
END;
$$;

-- ---------------------------------------------------------------------------
-- sharp schema — core tables
-- Only the root entity per workspace needs workspace_id; child tables
-- (episodes, episode_events, etc.) are scoped via repo_id / episode_id FKs.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF to_regclass('sharp.repos') IS NOT NULL THEN
    CALL add_workspace_id('sharp', 'repos');
  ELSE
    RAISE NOTICE 'workspace_id_threading: sharp.repos does not exist yet, skipping';
  END IF;

  IF to_regclass('sharp.episodes') IS NOT NULL THEN
    CALL add_workspace_id('sharp', 'episodes');
  ELSE
    RAISE NOTICE 'workspace_id_threading: sharp.episodes does not exist yet, skipping';
  END IF;

  -- api_keys and projections (referenced in RLS stub) are not yet created as
  -- tables in the current migration set; skip them with a notice.
  IF to_regclass('sharp.api_keys') IS NOT NULL THEN
    CALL add_workspace_id('sharp', 'api_keys');
  END IF;

  IF to_regclass('sharp.projections') IS NOT NULL THEN
    CALL add_workspace_id('sharp', 'projections');
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- auth schema — sessions and app_installations already carry
-- workspace_id UUID NOT NULL; this block adds the FK constraint only.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF to_regclass('auth.sessions') IS NOT NULL THEN
    -- Add FK if missing (column exists, FK does not).
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints tc
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema    = 'auth'
        AND tc.table_name      = 'sessions'
        AND tc.constraint_name = 'fk_sessions_workspace_id'
    ) THEN
      ALTER TABLE auth.sessions
        ADD CONSTRAINT fk_sessions_workspace_id
          FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id);
      RAISE NOTICE 'workspace_id_threading: added FK fk_sessions_workspace_id on auth.sessions';
    ELSE
      RAISE NOTICE 'workspace_id_threading: FK fk_sessions_workspace_id already exists on auth.sessions, skipping';
    END IF;
  ELSE
    RAISE NOTICE 'workspace_id_threading: auth.sessions does not exist yet, skipping';
  END IF;

  IF to_regclass('auth.app_installations') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints tc
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema    = 'auth'
        AND tc.table_name      = 'app_installations'
        AND tc.constraint_name = 'fk_app_installations_workspace_id'
    ) THEN
      ALTER TABLE auth.app_installations
        ADD CONSTRAINT fk_app_installations_workspace_id
          FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id);
      RAISE NOTICE 'workspace_id_threading: added FK fk_app_installations_workspace_id on auth.app_installations';
    ELSE
      RAISE NOTICE 'workspace_id_threading: FK already exists on auth.app_installations, skipping';
    END IF;
  ELSE
    RAISE NOTICE 'workspace_id_threading: auth.app_installations does not exist yet, skipping';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Clean up the helper procedure (idempotent tear-down).
-- ---------------------------------------------------------------------------
DROP PROCEDURE IF EXISTS add_workspace_id(TEXT, TEXT);
