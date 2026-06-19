-- Migration: 0005_policy_engine.sql
-- Owner: sf-db crate (substrate / Forge governance)
-- Schema: forge — the autonomous change loop and governance entities.
--
-- Creates the Policy store required by PRD US4 and §6. An Owner defines policies
-- that govern which changes ship autonomously and which require human approval
-- (PRD §3 — "Sets policy: what risk level may ship without human review, and what
-- requires sign-off"). Every policy traverses the PRD §6 lifecycle
--   drafted → active → revised → retired
-- and carries a risk threshold the change-merge path consults before merging
-- (PRD Constraint §9 — "no change above the policy-defined risk threshold may
-- ship without human approval").
--
-- Tables:
--   forge.policies — one row per policy version, carrying its current lifecycle
--                    state, its risk threshold (0..=100), and whether changes at
--                    or below the threshold ship autonomously. At most one policy
--                    per workspace may be `active` at a time (partial unique
--                    index), so the merge gate has a single policy to consult.
--
-- Design notes:
--   - CHECK constraints pin the legal state vocabulary and the threshold range at
--     the database level so out-of-vocabulary values are rejected by Postgres as
--     well as by the application-layer transition table in
--     `crates/sf-db/src/policy.rs`.
--   - workspace_id is the tenant key (matches issue #429 threading) with an FK to
--     public.workspaces(id).
--   - The partial unique index `policies_one_active_per_workspace_idx` enforces
--     the single-active-policy invariant the merge gate relies on.
--   - Every object is created IF NOT EXISTS so the file is idempotent and safe to
--     re-run (matches the migration-runner contract in migrate.rs).
--
-- Issue: #716
-- Depends on: 0001_workspaces.sql (public.workspaces), 0004_change_lifecycle.sql
--             (forge schema).
--
-- See docs/architecture.md §Change Lifecycle and Validation Gate (the policy risk
-- evaluation noted there as "tracked separately").

CREATE SCHEMA IF NOT EXISTS forge;

-- ---------------------------------------------------------------------------
-- forge.policies — the Policy lifecycle and risk-threshold store.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS forge.policies (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    UUID NOT NULL REFERENCES public.workspaces(id),
    -- Human-readable name / summary of the policy.
    name            TEXT NOT NULL,
    -- Current lifecycle state (PRD §6). The CHECK pins the legal vocabulary.
    state           TEXT NOT NULL DEFAULT 'drafted'
                    CHECK (state IN (
                        'drafted',
                        'active',
                        'revised',
                        'retired'
                    )),
    -- The risk threshold (0..=100). A change whose risk is at or below this
    -- value may ship autonomously when `autonomous` is true; anything above the
    -- threshold is always held for human approval (PRD Constraint §9).
    risk_threshold  INTEGER NOT NULL
                    CHECK (risk_threshold >= 0 AND risk_threshold <= 100),
    -- Whether changes at or below the threshold ship autonomously (true) or are
    -- always held for approval (false — an approval-only policy).
    autonomous      BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- At most one `active` policy per workspace, so the merge gate consults a single
-- authoritative policy. Non-active rows are unconstrained (historic versions).
CREATE UNIQUE INDEX IF NOT EXISTS policies_one_active_per_workspace_idx
    ON forge.policies (workspace_id)
    WHERE state = 'active';

CREATE INDEX IF NOT EXISTS policies_workspace_state_idx
    ON forge.policies (workspace_id, state);
