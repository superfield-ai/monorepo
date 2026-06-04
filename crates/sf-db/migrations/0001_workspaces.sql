-- Migration: 0001_workspaces.sql
-- Owner: sf-db crate (shared substrate)
-- Schema: public (workspace identity is cross-component)
--
-- Creates the `workspaces` table — the tenant identity anchor.
-- All per-workspace tables will carry `workspace_id UUID NOT NULL REFERENCES workspaces(id)`.
--
-- STUB — Phase: Substrate foundations (issue #426 scout)
-- This file defines the boundary interface so that:
--   - Issue #429 (workspace_id threading) can add FKs to nexum.*, sharp.*, auth.*.
--   - Issue #430 (RLS policies) can reference workspaces in policy expressions.
--
-- Currently `auth.sessions` and `auth.app_installations` already carry
-- `workspace_id UUID NOT NULL` without a FK because this table did not yet
-- exist. Once this migration is applied, those columns should be back-filled
-- with FK constraints (tracked in issue #429).
--
-- See docs/scouts/426-postgres-schema-map.md §workspace_id Column Status
-- and docs/architecture.md §Single-Instance Database Schema Layout.

CREATE TABLE IF NOT EXISTS workspaces (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    slug        TEXT        NOT NULL UNIQUE,    -- human-readable identifier
    display_name TEXT       NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    suspended   BOOLEAN     NOT NULL DEFAULT FALSE
);
