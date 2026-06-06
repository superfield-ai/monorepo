-- Apache AGE migration shim — phase-1 dev-scout stub (issue #78).
--
-- Applied automatically by the `postgres-age` docker-compose service via the
-- /docker-entrypoint-initdb.d hook on first boot. It is also safe to run by
-- hand against any Postgres instance that has the AGE extension available:
--
--     psql "$AGE_DATABASE_URL" -f db/migrations/0001_age_shim.sql
--
-- WHAT THIS DOES (intentionally minimal):
--   1. CREATE EXTENSION IF NOT EXISTS age — guarded so that if AGE is not
--      installed (e.g. a pgvector-only image), the script no-ops with a
--      NOTICE rather than hard-failing the boot.
--   2. Loads the AGE library and creates a stub graph called `nexum_links`
--      so downstream issues can assume the graph exists.
--   3. Creates an empty placeholder vlabel `Block` and elabel `LINK` so that
--      benchmark code in #6 / #75 can MERGE without first defining schema.
--
-- EXPLICITLY OUT OF SCOPE FOR THIS SHIM:
--   - Shadow-writing real link data into AGE (lands in #75).
--   - Cypher traversal queries (lands in #75).
--   - H1.2 storage-fitness benchmark code (lands in #6).
--
-- Canonical references:
--   - docs/research.md (Area 1: Storage Architecture Fitness)
--   - docs/research/pg-extensions.md (Apache AGE section)
--   - docs/engineering.md (Phase-1 Scout Seams)

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'age') THEN
        CREATE EXTENSION IF NOT EXISTS age;
        LOAD 'age';
        PERFORM set_config('search_path', 'ag_catalog,"$user",public', false);

        IF NOT EXISTS (SELECT 1 FROM ag_catalog.ag_graph WHERE name = 'nexum_links') THEN
            PERFORM ag_catalog.create_graph('nexum_links');
        END IF;

        -- Vertex / edge label stubs so MERGE in downstream benchmarks does
        -- not need to bootstrap them. No data is written here.
        BEGIN
            PERFORM ag_catalog.create_vlabel('nexum_links', 'Block');
        EXCEPTION WHEN others THEN NULL;
        END;
        BEGIN
            PERFORM ag_catalog.create_elabel('nexum_links', 'LINK');
        EXCEPTION WHEN others THEN NULL;
        END;
    ELSE
        RAISE NOTICE 'age extension not available on this server — skipping AGE shim. This is expected for the pgvector-only postgres service.';
    END IF;
END $$;
