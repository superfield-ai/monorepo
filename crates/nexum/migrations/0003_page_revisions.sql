-- Migration: 0003_page_revisions.sql
-- Owner: nexum crate (Nexum knowledge-graph component)
-- Schema: nexum
--
-- Creates the `nexum.page_revisions` table used by:
--   - Issue #490 (seed document ingestion): writes a page revision after
--     each successful ingestion of a named page document.
--   - Issue #491 (gardening loop engine): persists computed page revisions
--     on each gardening cycle.
--
-- All statements are idempotent (CREATE ... IF NOT EXISTS, DO $$ guards).
--
-- # Table design
--
-- A page_revision row represents a point-in-time snapshot of a named page's
-- rendered content.  The gardening loop re-inserts a new row on each cycle;
-- callers read the latest row by (page_name, ingested_at DESC).
--
-- # Idempotency
--
-- The write path uses INSERT without ON CONFLICT because the loop engine
-- intends to append new revisions on each pass.  De-duplication at the
-- page-query layer is done by selecting the latest revision.
--
-- # Workspace scoping
--
-- Every row carries workspace_id so that per-workspace RLS policies and
-- application-layer filters work correctly.  workspace_id must be a non-nil
-- UUID that exists in public.workspaces(id).
--
-- Phase: Headless gardening appliance (issues #490, #491)
-- Depends on: crates/sf-db/migrations/0001_workspaces.sql (public.workspaces)
--             crates/nexum/migrations/0001_nexum_schema.sql (nexum schema)
--
-- See docs/architecture.md §Nexum — page-revision schema.

-- 1. page_revisions table ----------------------------------------------------

CREATE TABLE IF NOT EXISTS nexum.page_revisions (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID        NOT NULL REFERENCES public.workspaces(id),
    page_name    TEXT        NOT NULL,
    content      TEXT        NOT NULL,
    provenance   TEXT        NOT NULL DEFAULT '',
    ingested_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for reading latest revision by (workspace_id, page_name).
CREATE INDEX IF NOT EXISTS page_revisions_workspace_page_idx
    ON nexum.page_revisions (workspace_id, page_name, ingested_at DESC);
