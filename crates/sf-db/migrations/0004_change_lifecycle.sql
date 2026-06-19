-- Migration: 0004_change_lifecycle.sql
-- Owner: sf-db crate (substrate / Forge governance)
-- Schema: forge — the autonomous change loop and governance entities.
--
-- Creates the Change lifecycle state machine store required by PRD US13 and
-- Constraint §9 (the validation gate). Every change traverses
--   draft → validating → awaiting-approval → merged | rejected | abandoned
-- and cannot reach `merged` without a recorded passing validation run plus any
-- policy-required approval (PRD §6).
--
-- Tables:
--   forge.changes          — one row per proposed change, carrying its current
--                            lifecycle state.
--   forge.validation_runs  — validation runs recorded against a change
--                            (queued → running → passed | failed, PRD §6). A
--                            `passed` run is the merge precondition for the
--                            validation gate.
--
-- Design notes:
--   - CHECK constraints pin the legal state vocabulary at the database level so
--     an out-of-vocabulary state is rejected by Postgres as well as by the
--     application-layer transition table in `crates/sf-db/src/change.rs`.
--   - workspace_id is the tenant key (matches issue #429 threading) with an FK
--     to public.workspaces(id).
--   - Every object is created IF NOT EXISTS so the file is idempotent and safe
--     to re-run (matches the migration-runner contract in migrate.rs).
--
-- Issue: #707
-- Depends on: 0001_workspaces.sql (public.workspaces)
--
-- See docs/architecture.md §Change Lifecycle and Validation Gate.

CREATE SCHEMA IF NOT EXISTS forge;

-- ---------------------------------------------------------------------------
-- forge.changes — the Change lifecycle state machine.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS forge.changes (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES public.workspaces(id),
    -- Human-readable title / summary of the proposed change.
    title        TEXT NOT NULL,
    -- Current lifecycle state (PRD §6). The CHECK pins the legal vocabulary.
    state        TEXT NOT NULL DEFAULT 'draft'
                 CHECK (state IN (
                     'draft',
                     'validating',
                     'awaiting-approval',
                     'merged',
                     'rejected',
                     'abandoned'
                 )),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS changes_workspace_state_idx
    ON forge.changes (workspace_id, state);

-- ---------------------------------------------------------------------------
-- forge.validation_runs — validation runs recorded against a change.
--
-- A run progresses queued → running → passed | failed (PRD §6). A `passed`
-- run is the precondition the validation gate enforces before a change may
-- reach `merged`.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS forge.validation_runs (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    change_id    UUID NOT NULL REFERENCES forge.changes(id) ON DELETE CASCADE,
    workspace_id UUID NOT NULL REFERENCES public.workspaces(id),
    -- Validation-run lifecycle state (PRD §6).
    state        TEXT NOT NULL DEFAULT 'queued'
                 CHECK (state IN ('queued', 'running', 'passed', 'failed')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS validation_runs_change_state_idx
    ON forge.validation_runs (change_id, state);
