-- Migration: 0009_rls_workspace_isolation
-- Owner: cross-cutting substrate concern, mirrored into the last component
--        directory (sharp) so the appliance boot migration runner applies it.
--
-- WHY THIS LIVES IN crates/sharp/migrations:
--   The appliance daemon's in-process migration runner
--   (`crates/sf-db/src/migrate.rs`) walks COMPONENT_DIRS in dependency order:
--       sf-db -> sf-auth -> nexum -> sharp
--   and `packages/db/migrations/` is NOT on that path — it is applied only by
--   the standalone k3s/TS migrator (`packages/db/migrator.ts`). Before this
--   file existed, the RLS workspace-isolation policies in
--   `packages/db/migrations/0001_rls_workspace_isolation.sql` were therefore
--   enforced on the k3s track ONLY; on a self-provisioned appliance the
--   handlers set the workspace session variable but no policy read it
--   (architecture.md §Cross-component joins and RLS scoping, issue #710).
--
--   Placing the policies in the LAST component directory (sharp) AND as its
--   highest-numbered file guarantees they run after every component schema
--   (sf-db, auth, nexum, sharp) has been created — including later sharp
--   migrations such as 0008_sharp_runtime_signal_workspace.sql — mirroring the
--   TS migrator's "RLS applied last" ordering. The runner sorts files within a
--   component by ascending filename, so this file MUST keep the highest 00NN
--   prefix in crates/sharp/migrations. The recorded migration id is
--   `sharp/0009_rls_workspace_isolation`.
--
-- SESSION CONTRACT:
--   Policies are keyed on the PostgreSQL session variable `app.workspace_id`,
--   set per-transaction via `SET LOCAL app.workspace_id = '<uuid>'`. The Rust
--   `sf_db::acquire_with_workspace_id` helper sets both `app.workspace_id` and
--   the legacy `app.current_principal_id`. `current_setting('app.workspace_id',
--   true)` returns NULL when no context is set, so an unscoped connection sees
--   no workspace-keyed rows (fail-closed).
--
-- ADMIN BYPASS:
--   A `superfield_admin` role with the BYPASSRLS attribute is (idempotently)
--   created so migrations and background jobs can touch every row regardless of
--   workspace. BYPASSRLS is the only mechanism immune to FORCE ROW LEVEL
--   SECURITY; a PERMISSIVE bypass policy cannot replicate it.
--
-- SELF-SUFFICIENCY:
--   On the appliance runner, sf-db's 0003 workspace_id threading runs BEFORE
--   the component tables exist (sf-db precedes sharp/nexum in COMPONENT_DIRS),
--   so it silently skips them. To make RLS correct on the appliance path
--   regardless, this migration ENSURES the `workspace_id UUID` column exists on
--   each target table before enabling RLS. The column is compared as text
--   (`workspace_id::text = current_setting('app.workspace_id', true)`) because
--   the session variable is always text.
--
-- IDEMPOTENCY:
--   PostgreSQL has no `CREATE POLICY IF NOT EXISTS`. Each policy is therefore
--   dropped (`DROP POLICY IF EXISTS`) and recreated, so re-running the file
--   re-converges without error. Column/role creation is guarded by existence
--   checks. The migration runner additionally records the id in
--   `schema_migrations` so it is applied at most once per database anyway.
--
-- References:
--   - docs/architecture.md §Cross-component joins and RLS scoping
--   - packages/db/migrations/0001_rls_workspace_isolation.sql (k3s/TS mirror)
--   - packages/db/tests/integration/rls-workspace-isolation.test.ts
--   - Issue #710 (apply on the appliance boot path)
-- ---------------------------------------------------------------------------

SET search_path TO public;

-- ---------------------------------------------------------------------------
-- Privileged BYPASSRLS role for migrations / background jobs.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'superfield_admin') THEN
    CREATE ROLE superfield_admin BYPASSRLS NOLOGIN;
  ELSE
    ALTER ROLE superfield_admin BYPASSRLS;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Apply per-workspace RLS to every existing workspace-keyed table.
--
-- For each table that exists:
--   1. ensure a `workspace_id UUID` column is present,
--   2. ENABLE + FORCE row level security,
--   3. (re)create the four CRUD policies keyed on app.workspace_id.
--
-- Tables that do not exist yet are skipped with a NOTICE so the file is safe
-- on a partial/substrate-only database.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  tbl  TEXT;
  schemaname TEXT;
  tablename  TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    -- sharp schema
    'sharp.repos',
    'sharp.runtime_signals',
    -- forge schema (autonomous change loop, sf-db/0004_change_lifecycle)
    'forge.changes',
    'forge.validation_runs',
    -- nexum schema
    'nexum.corpora',
    'nexum.documents',
    'nexum.document_versions',
    'nexum.blocks',
    'nexum.links',
    'nexum.entities',
    'nexum.job_queue',
    -- auth schema
    'auth.sessions',
    'auth.app_installations'
  ]
  LOOP
    IF to_regclass(tbl) IS NULL THEN
      RAISE NOTICE 'rls_workspace_isolation: % does not exist yet, skipping.', tbl;
      CONTINUE;
    END IF;

    schemaname := split_part(tbl, '.', 1);
    tablename  := split_part(tbl, '.', 2);

    -- (1) Ensure the tenant key column exists (self-sufficient on the appliance
    --     path where sf-db/0003 threading ran before these tables existed).
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = schemaname
        AND table_name   = tablename
        AND column_name  = 'workspace_id'
    ) THEN
      EXECUTE format('ALTER TABLE %s ADD COLUMN workspace_id UUID', tbl);
      RAISE NOTICE 'rls_workspace_isolation: added workspace_id column to %.', tbl;
    END IF;

    -- (2) Enable + force RLS.
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);

    -- (3) (Re)create the four CRUD policies. DROP-then-CREATE because Postgres
    --     has no CREATE POLICY IF NOT EXISTS.
    EXECUTE format('DROP POLICY IF EXISTS rls_workspace_select ON %s', tbl);
    EXECUTE format(
      $f$
        CREATE POLICY rls_workspace_select ON %s
          AS PERMISSIVE FOR SELECT
          USING (workspace_id::text = current_setting('app.workspace_id', true))
      $f$, tbl);

    EXECUTE format('DROP POLICY IF EXISTS rls_workspace_insert ON %s', tbl);
    EXECUTE format(
      $f$
        CREATE POLICY rls_workspace_insert ON %s
          AS PERMISSIVE FOR INSERT
          WITH CHECK (workspace_id::text = current_setting('app.workspace_id', true))
      $f$, tbl);

    EXECUTE format('DROP POLICY IF EXISTS rls_workspace_update ON %s', tbl);
    EXECUTE format(
      $f$
        CREATE POLICY rls_workspace_update ON %s
          AS PERMISSIVE FOR UPDATE
          USING (workspace_id::text = current_setting('app.workspace_id', true))
          WITH CHECK (workspace_id::text = current_setting('app.workspace_id', true))
      $f$, tbl);

    EXECUTE format('DROP POLICY IF EXISTS rls_workspace_delete ON %s', tbl);
    EXECUTE format(
      $f$
        CREATE POLICY rls_workspace_delete ON %s
          AS PERMISSIVE FOR DELETE
          USING (workspace_id::text = current_setting('app.workspace_id', true))
      $f$, tbl);

    RAISE NOTICE 'rls_workspace_isolation: policies applied to %.', tbl;
  END LOOP;
END
$$;
