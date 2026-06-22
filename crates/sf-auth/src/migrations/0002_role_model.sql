-- Migration: 0002_role_model.sql
-- Owner: sf-auth crate (Auth component)
-- Schema: auth
--
-- Widens the auth.sessions.role CHECK constraint to the full seven-role PRD §3
-- model (issue #711). Fresh installs already get the widened constraint from
-- 0001_auth_schema.sql; this migration brings databases that applied the
-- original three-role constraint up to date.
--
-- The two legacy names ('admin', 'member') remain accepted so sessions issued
-- before the full role model keep validating; sf_auth::session::parse_role
-- maps them onto 'owner'/'collaborator'.
--
-- All statements are idempotent.
--
-- See docs/prd.md §3 User Roles and docs/architecture.md
-- §Single-Instance Database Schema Layout.

ALTER TABLE auth.sessions
    DROP CONSTRAINT IF EXISTS sessions_role_check;

ALTER TABLE auth.sessions
    ADD CONSTRAINT sessions_role_check CHECK (role IN (
        'owner', 'requestor', 'steerer', 'collaborator',
        'agent', 'auditor', 'viewer',
        'admin', 'member'
    ));
