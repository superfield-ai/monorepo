-- Per-object hash algorithm for `sharp.objects` (whitepaper §4.0 / §4.1).
--
-- Records which hash function produced an object's id so a single repository can
-- hold both SHA-1 and SHA-256 objects during Git's SHA-1 → SHA-256 transition.
-- The whitepaper default is `sha1`; the constraint allows `sha1` or `sha256`.
--
-- Additive migration — do NOT edit the deployed 0001_sharp_vcs_schema.sql. The
-- runner (crates/sf-db/src/migrate.rs) records applied files and only runs
-- pending ones, so editing 0001 would never re-apply on existing databases.
-- This mirrors how 0005_sharp_refs_model.sql ALTERs the 0001 `sharp.refs` table
-- in a separate file.
--
-- Idempotent: safe to re-run.

-- The column carries the whitepaper §4.1 default of 'sha1'.
ALTER TABLE sharp.objects
    ADD COLUMN IF NOT EXISTS algo TEXT NOT NULL DEFAULT 'sha1';

-- Backfill existing rows to 'sha256': every writer to date (object::store /
-- object::store_canonical) emits a SHA-256 id, so a plain DEFAULT 'sha1' would
-- mislabel every pre-existing row. The `algo` value must always match the hash
-- function that produced the id (scout #750, Note A).
UPDATE sharp.objects SET algo = 'sha256' WHERE algo = 'sha1';

-- Constrain to the two supported algorithms (§4.0). Guard against re-run.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'objects_algo_check'
    ) THEN
        ALTER TABLE sharp.objects
            ADD CONSTRAINT objects_algo_check CHECK (algo IN ('sha1', 'sha256'));
    END IF;
END $$;

-- Composite (algo, id) index so mixed SHA-1/SHA-256 repos still plan cleanly
-- (postgres-storage-plugin.md §objects). The deployed PK column is `sha256`.
CREATE INDEX IF NOT EXISTS objects_algo_sha256_idx ON sharp.objects (algo, sha256);
