-- Migration: orchestrator/0001_gardening_cursor
-- Owner: orchestrator (gardening loop engine — issue #491)
-- Phase: Headless gardening appliance
--
-- Creates the orchestrator schema and the gardening_cursor table used by the
-- gardening loop engine to record its resumable position in the knowledge-base
-- improvement pipeline.
--
-- STUB — Phase: Headless gardening appliance (issue #494 scout)
-- This file stubs the schema boundary so that:
--   - Issue #491 (gardening loop engine) can write cursor rows from day one.
--   - The migration smoke check (SELECT 1 FROM orchestrator.gardening_cursor
--     LIMIT 0) passes in CI without requiring the loop engine to be running.
--
-- # Schema design rationale
--
-- The orchestrator schema is separate from the component schemas (nexum, sharp,
-- auth, substrate) because the gardening loop engine is a cross-cutting concern:
-- it reads from nexum.*, writes page revisions via sf-db, and updates its own
-- cursor. Isolation prevents schema-level permission collisions.
--
-- # gardening_cursor table
--
-- One row per workspace (keyed on workspace_id). The loop engine updates the
-- row after each successful gardening step. Fields:
--
--   workspace_id UUID NOT NULL  — tenant scoping (FK to public.workspaces)
--   step_name    TEXT NOT NULL  — name of the last completed step, e.g.
--                                 "research", "reconcile", "write"
--   cursor_token TEXT           — opaque continuation token (e.g. Nexum block
--                                 ID or ISO-8601 timestamp); NULL means start
--                                 from the beginning
--   updated_at   TIMESTAMPTZ    — when this row was last written
--
-- # Idempotency
--
-- All DDL statements use IF NOT EXISTS so the file is safe to re-run and
-- compatible with both fresh databases and incremental migration runners.
--
-- # Relationship to other migrations
--
-- Depends on: crates/sf-db/migrations/0001_workspaces.sql (public.workspaces)
-- Referenced by: issue #491 (loop engine writes cursor rows)
-- Related: issue #490 (seed ingest may reset the cursor on first run)
--
-- See docs/architecture.md §Daemon Lifecycle and §Single-Instance Database
-- Schema Layout for the canonical schema map.

-- ---------------------------------------------------------------------------
-- orchestrator schema
-- ---------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS orchestrator;

-- ---------------------------------------------------------------------------
-- gardening_cursor table
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS orchestrator.gardening_cursor (
    -- Tenant identity — one cursor row per workspace.
    workspace_id  UUID        NOT NULL,

    -- The last gardening step that completed successfully for this workspace.
    -- Populated values (defined by issue #491): 'research' | 'reconcile' |
    -- 'write' | 'link' | 'summarise'.  NULL means no step has completed yet.
    step_name     TEXT,

    -- Opaque continuation token that the loop engine passes to the next step
    -- so it can resume from where it left off (e.g. a Nexum document_version
    -- UUID or an ISO-8601 timestamp string).  NULL means start from scratch.
    cursor_token  TEXT,

    -- Wall-clock timestamp of the last successful update.  Set by the loop
    -- engine via `DEFAULT now()` on INSERT and explicit UPDATE on subsequent
    -- writes.
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Primary key: one cursor row per workspace.
    CONSTRAINT pk_gardening_cursor PRIMARY KEY (workspace_id)
);

-- Index supporting per-workspace cursor lookups (also the PK, but explicit
-- for clarity with future partial indexes on step_name).
CREATE INDEX IF NOT EXISTS gardening_cursor_workspace_id_idx
    ON orchestrator.gardening_cursor (workspace_id);
