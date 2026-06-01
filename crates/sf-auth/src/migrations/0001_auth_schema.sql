-- Migration: 0001_auth_schema.sql
-- Owner: sf-auth crate (Auth component)
-- Schema: auth
--
-- Creates the `auth` PostgreSQL schema and its core tables.
-- All statements are idempotent.
--
-- See docs/architecture.md §Single-Instance Database Schema Layout.

-- 1. Schema ------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS auth;

-- 2. sessions ----------------------------------------------------------------
-- Stores issued session tokens.  Validated on each request; the row carries
-- the workspace + user + role context applied to the connection via
-- SET LOCAL app.current_principal_id so that per-schema RLS policies fire.

CREATE TABLE IF NOT EXISTS auth.sessions (
    token        UUID        PRIMARY KEY,
    workspace_id UUID        NOT NULL,
    user_id      UUID        NOT NULL,
    role         TEXT        NOT NULL CHECK (role IN ('admin', 'member', 'viewer')),
    issued_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at   TIMESTAMPTZ NOT NULL,
    revoked      BOOLEAN     NOT NULL DEFAULT FALSE
);

-- Index: look up sessions by (workspace_id, user_id) for auditing and
-- forced-logout of all sessions for a given user.
CREATE INDEX IF NOT EXISTS auth_sessions_workspace_user
    ON auth.sessions (workspace_id, user_id);

-- Index: prune expired sessions efficiently.
CREATE INDEX IF NOT EXISTS auth_sessions_expires_at
    ON auth.sessions (expires_at)
    WHERE NOT revoked;

-- 3. oauth_tokens ------------------------------------------------------------
-- Stores OAuth tokens issued during the GitHub device flow or IdP federation.
-- Stub table — columns will be extended during the auth port.

CREATE TABLE IF NOT EXISTS auth.oauth_tokens (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID        NOT NULL,
    provider     TEXT        NOT NULL,
    access_token TEXT        NOT NULL,
    refresh_token TEXT,
    expires_at   TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. app_installations -------------------------------------------------------
-- Records GitHub App installations for workspace → repo mapping.
-- Stub table — extended during the auth port.

CREATE TABLE IF NOT EXISTS auth.app_installations (
    id              UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    UUID    NOT NULL,
    installation_id BIGINT  NOT NULL UNIQUE,
    account_login   TEXT    NOT NULL,
    account_type    TEXT    NOT NULL CHECK (account_type IN ('User', 'Organization')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
