-- Phase-4 synthesis write-back — AGE graph mirror additions (issue #109).
--
-- Applied automatically by the `postgres-age` docker-compose service and by
-- `migrate.ts` (via `migrateAge()`) against any Postgres-AGE deployment.
-- Safe to run by hand:
--
--     psql "$AGE_DATABASE_URL" -f db/migrations/0002_synthesized_block_status.sql
--
-- WHAT THIS DOES:
--   1. Creates the `SOURCED_FROM` elabel in the `nexum_links` AGE graph so
--      phase-4 write-back (issue #110) can MERGE sourced-from edges without
--      first defining the label. Idempotent — wrapped in an exception handler.
--   2. The `origin` and `synth_status` columns on the `blocks` Postgres table
--      are mirrored into AGE Block vertex properties at write time by the
--      ingest and synthesis paths; no DDL changes are required on the AGE side
--      because AGE vertex properties are schema-free.
--
-- EXPLICITLY OUT OF SCOPE:
--   - Writing any data into AGE (handled at runtime by issues #110 and #112).
--   - Altering the `nexum_links` graph itself (already exists from 0001).
--   - Stale propagation logic (issue #112).

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'age')
       AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'age') THEN

        LOAD 'age';
        PERFORM set_config('search_path', 'ag_catalog,"$user",public', false);

        -- Create the SOURCED_FROM elabel so issue #110 can MERGE edges without
        -- a prior CREATE elabel call. Swallow the error if it already exists.
        BEGIN
            PERFORM ag_catalog.create_elabel('nexum_links', 'SOURCED_FROM');
        EXCEPTION WHEN others THEN NULL;
        END;

    ELSE
        RAISE NOTICE '0002_synthesized_block_status: AGE extension not loaded — skipping AGE label creation. This is expected for the pgvector-only postgres service.';
    END IF;
END $$;
