-- Sharp refs model — symbolic refs and compare-and-swap (CAS) updates.
--
-- Ports sharp/apps/server/src/refs.ts onto the existing `sharp.refs` table.
-- Refs become a discriminated union over a hash target (a commit/object SHA,
-- stored as hex text in `target_sha`) and a symbolic target (another ref's
-- name, e.g. HEAD → refs/heads/main, stored in `symbolic_target`).
--
-- See docs/rust-reorg-decisions.md §2 (Refs) and docs/architecture.md §Sharp — Tier-1 Rust Semantic Merge § Components (crates/sharp).
--
-- Idempotent: safe to re-run.

-- Add the discriminator and the symbolic target column.
ALTER TABLE sharp.refs
    ADD COLUMN IF NOT EXISTS target_kind     TEXT,
    ADD COLUMN IF NOT EXISTS symbolic_target TEXT;

-- Backfill existing rows: every pre-existing ref is a hash ref.
UPDATE sharp.refs SET target_kind = 'hash' WHERE target_kind IS NULL;

-- The discriminator is required and constrained going forward.
ALTER TABLE sharp.refs ALTER COLUMN target_kind SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'refs_target_kind_check'
    ) THEN
        ALTER TABLE sharp.refs
            ADD CONSTRAINT refs_target_kind_check
            CHECK (target_kind IN ('hash', 'symbolic'));
    END IF;
END $$;

-- A symbolic ref has no SHA, so target_sha must be nullable.
ALTER TABLE sharp.refs ALTER COLUMN target_sha DROP NOT NULL;

-- Drop the FK to sharp.objects: a hash ref may point at a commit SHA that is
-- imported lazily, and symbolic refs have no SHA at all. The FK name is
-- assigned by Postgres at table-creation time; discover and drop it.
DO $$
DECLARE
    fk_name TEXT;
BEGIN
    SELECT conname INTO fk_name
    FROM   pg_constraint
    WHERE  conrelid = 'sharp.refs'::regclass
      AND  contype  = 'f'
      AND  confrelid = 'sharp.objects'::regclass;
    IF fk_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE sharp.refs DROP CONSTRAINT %I', fk_name);
    END IF;
END $$;

-- XOR invariant: exactly one of (hash target, symbolic target) is set,
-- consistent with the discriminator.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'refs_target_xor_check'
    ) THEN
        ALTER TABLE sharp.refs
            ADD CONSTRAINT refs_target_xor_check
            CHECK (
                (target_kind = 'hash'     AND target_sha IS NOT NULL AND symbolic_target IS NULL)
             OR (target_kind = 'symbolic' AND symbolic_target IS NOT NULL AND target_sha IS NULL)
            );
    END IF;
END $$;
