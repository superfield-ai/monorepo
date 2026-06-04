-- Migration: 0002_substrate_backups
-- Creates the substrate schema and the backups event table used by PgBackup.
--
-- The substrate schema is owned by the operations layer; component crates
-- should not write to it directly — use the SubstrateBackup seam instead.

CREATE SCHEMA IF NOT EXISTS substrate;

CREATE TABLE IF NOT EXISTS substrate.backups (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    completed_at TIMESTAMPTZ NOT NULL,
    location     TEXT NOT NULL,
    outcome      TEXT NOT NULL,
    start_lsn    TEXT
);
