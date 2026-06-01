-- Migration: 0001_rls_workspace_isolation
--
-- Stub: Row-Level Security for workspace/tenant isolation on core tables.
--
-- This migration enables RLS on each component schema's workspace-keyed tables
-- and installs per-operation policies that restrict every query to the current
-- session's workspace.
--
-- The workspace is carried via the PostgreSQL session variable
-- `app.workspace_id`, which must be set at connection time before any
-- workspace-keyed table is accessed:
--
--   SET LOCAL app.workspace_id = '<workspace-uuid>';
--
-- A privileged application role (`superfield_admin`) is created with the
-- BYPASSRLS attribute so that background jobs and migration runners can access
-- all rows without a workspace context.  This is the correct mechanism for
-- admin bypass: a PERMISSIVE+RESTRICTIVE policy combination cannot replicate
-- this — RESTRICTIVE policies always AND with PERMISSIVE ones, so an admin
-- bypass PERMISSIVE policy is overridden by the workspace RESTRICTIVE policy.
-- BYPASSRLS at the role level is the only safe, correct mechanism.
--
-- IMPORTANT: This is a stub migration.  The `sharp`, `nexum`, `auth`, and
-- `episodes` schemas are defined in separate component repositories (see
-- docs/architecture.md §Single Postgres Instance).  When those schemas are
-- created their migration sequences must apply this file *after* the schema
-- and table DDL.  The `IF EXISTS` guards make the file safe to run even when
-- schemas are not yet present — it silently skips absent tables.
--
-- Idempotent: all statements use `IF NOT EXISTS` / `DO $$ … $$`.
--
-- References:
--   - docs/architecture.md §§ Cross-component joins and RLS scoping
--   - Issue #357 (workspaceId column on core tables)
--   - Issue #358 (this migration)
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Helper: set the default search_path so unqualified names resolve correctly.
-- ---------------------------------------------------------------------------
SET search_path TO public;

-- ---------------------------------------------------------------------------
-- Privileged role: migrations and background jobs bypass RLS.
-- BYPASSRLS is the correct mechanism — it is immune to FORCE ROW LEVEL
-- SECURITY and cannot be overridden by RESTRICTIVE policies.
-- Created only if it does not already exist so the migration is re-runnable.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'superfield_admin'
  ) THEN
    -- BYPASSRLS lets this role skip all RLS checks for all tables.
    -- NOLOGIN: this is not a connection role; grant it to a login role instead.
    CREATE ROLE superfield_admin BYPASSRLS NOLOGIN;
  ELSE
    -- Ensure BYPASSRLS is set even if the role was created without it.
    ALTER ROLE superfield_admin BYPASSRLS;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- sharp schema — workspace-keyed tables
--
-- Tables: repos, objects, refs, commit_paths, commit_metadata, api_keys,
--         projections
-- Tenant key column: workspace_id TEXT NOT NULL
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'sharp.repos',
    'sharp.objects',
    'sharp.refs',
    'sharp.commit_paths',
    'sharp.commit_metadata',
    'sharp.api_keys',
    'sharp.projections'
  ]
  LOOP
    -- Skip gracefully if the schema / table has not been created yet.
    IF to_regclass(tbl) IS NULL THEN
      RAISE NOTICE 'RLS stub: % does not exist yet, skipping.', tbl;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);

    -- App role SELECT: only rows matching the session workspace.
    -- PERMISSIVE: rows pass if workspace_id matches the session context.
    -- Rows with no matching context (NULL / empty) are hidden by default.
    EXECUTE format(
      $f$
        CREATE POLICY IF NOT EXISTS rls_workspace_select ON %s
          AS PERMISSIVE
          FOR SELECT
          USING (
            workspace_id = current_setting('app.workspace_id', true)
          )
      $f$, tbl
    );

    -- App role INSERT: stamp with the session workspace.
    EXECUTE format(
      $f$
        CREATE POLICY IF NOT EXISTS rls_workspace_insert ON %s
          AS PERMISSIVE
          FOR INSERT
          WITH CHECK (
            workspace_id = current_setting('app.workspace_id', true)
          )
      $f$, tbl
    );

    -- App role UPDATE: restrict to session workspace.
    EXECUTE format(
      $f$
        CREATE POLICY IF NOT EXISTS rls_workspace_update ON %s
          AS PERMISSIVE
          FOR UPDATE
          USING (
            workspace_id = current_setting('app.workspace_id', true)
          )
          WITH CHECK (
            workspace_id = current_setting('app.workspace_id', true)
          )
      $f$, tbl
    );

    -- App role DELETE: restrict to session workspace.
    EXECUTE format(
      $f$
        CREATE POLICY IF NOT EXISTS rls_workspace_delete ON %s
          AS PERMISSIVE
          FOR DELETE
          USING (
            workspace_id = current_setting('app.workspace_id', true)
          )
      $f$, tbl
    );

    RAISE NOTICE 'RLS stub: policies applied to %.', tbl;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- nexum schema — workspace-keyed tables
--
-- Tables: corpora, documents, document_versions, blocks, version_blocks,
--         links, entities, corpus_access, job_queue
-- Tenant key column: workspace_id TEXT NOT NULL
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'nexum.corpora',
    'nexum.documents',
    'nexum.document_versions',
    'nexum.blocks',
    'nexum.version_blocks',
    'nexum.links',
    'nexum.entities',
    'nexum.corpus_access',
    'nexum.job_queue'
  ]
  LOOP
    IF to_regclass(tbl) IS NULL THEN
      RAISE NOTICE 'RLS stub: % does not exist yet, skipping.', tbl;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);

    EXECUTE format(
      $f$
        CREATE POLICY IF NOT EXISTS rls_workspace_select ON %s
          AS PERMISSIVE FOR SELECT
          USING (workspace_id = current_setting('app.workspace_id', true))
      $f$, tbl
    );
    EXECUTE format(
      $f$
        CREATE POLICY IF NOT EXISTS rls_workspace_insert ON %s
          AS PERMISSIVE FOR INSERT
          WITH CHECK (workspace_id = current_setting('app.workspace_id', true))
      $f$, tbl
    );
    EXECUTE format(
      $f$
        CREATE POLICY IF NOT EXISTS rls_workspace_update ON %s
          AS PERMISSIVE FOR UPDATE
          USING (workspace_id = current_setting('app.workspace_id', true))
          WITH CHECK (workspace_id = current_setting('app.workspace_id', true))
      $f$, tbl
    );
    EXECUTE format(
      $f$
        CREATE POLICY IF NOT EXISTS rls_workspace_delete ON %s
          AS PERMISSIVE FOR DELETE
          USING (workspace_id = current_setting('app.workspace_id', true))
      $f$, tbl
    );

    RAISE NOTICE 'RLS stub: policies applied to %.', tbl;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- episodes schema — workspace-keyed tables  (to be defined; stubs only)
--
-- Tables: episodes, episode_events, episode_outcomes
-- Tenant key column: workspace_id TEXT NOT NULL
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'episodes.episodes',
    'episodes.episode_events',
    'episodes.episode_outcomes'
  ]
  LOOP
    IF to_regclass(tbl) IS NULL THEN
      RAISE NOTICE 'RLS stub: % does not exist yet, skipping.', tbl;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);

    EXECUTE format(
      $f$
        CREATE POLICY IF NOT EXISTS rls_workspace_select ON %s
          AS PERMISSIVE FOR SELECT
          USING (workspace_id = current_setting('app.workspace_id', true))
      $f$, tbl
    );
    EXECUTE format(
      $f$
        CREATE POLICY IF NOT EXISTS rls_workspace_insert ON %s
          AS PERMISSIVE FOR INSERT
          WITH CHECK (workspace_id = current_setting('app.workspace_id', true))
      $f$, tbl
    );
    EXECUTE format(
      $f$
        CREATE POLICY IF NOT EXISTS rls_workspace_update ON %s
          AS PERMISSIVE FOR UPDATE
          USING (workspace_id = current_setting('app.workspace_id', true))
          WITH CHECK (workspace_id = current_setting('app.workspace_id', true))
      $f$, tbl
    );
    EXECUTE format(
      $f$
        CREATE POLICY IF NOT EXISTS rls_workspace_delete ON %s
          AS PERMISSIVE FOR DELETE
          USING (workspace_id = current_setting('app.workspace_id', true))
      $f$, tbl
    );

    RAISE NOTICE 'RLS stub: policies applied to %.', tbl;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- auth schema — workspace-keyed tables  (to be defined; stubs only)
--
-- Tables: sessions, oauth_tokens, app_installations
-- Note: auth.sessions is the identity authority that RLS policies reference.
--       RLS for auth tables is deferred to the auth port — only RLS enable
--       is applied here as a stub.  Full policies are out of scope for #358.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'auth.sessions',
    'auth.oauth_tokens',
    'auth.app_installations'
  ]
  LOOP
    IF to_regclass(tbl) IS NULL THEN
      RAISE NOTICE 'RLS stub: % does not exist yet, skipping.', tbl;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);

    -- Full auth policies are deferred to the auth port.
    -- As a safe stub, deny all access except to superfield_admin (BYPASSRLS).
    RAISE NOTICE 'RLS stub: RLS enabled on % (policies deferred to auth port).', tbl;
  END LOOP;
END
$$;
