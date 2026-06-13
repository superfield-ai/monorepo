-- Migration: 0002_project_graph.sql
-- Owner: nexum crate (Nexum knowledge-graph component)
-- Schema: nexum
--
-- Adds the project management graph layer to the Nexum schema.
-- All statements are idempotent (CREATE ... IF NOT EXISTS, DO $$ guards).
--
-- Phase: Project management graph (issue #493)
--
-- Design: project nodes are stored as typed extensions of nexum.blocks with a
-- node_type column. The graph edges use nexum.links with project: prefixed
-- rel_type values. This avoids duplicating the block storage model and allows
-- the existing recursive CTE traversal infrastructure to traverse project edges.
--
-- Node types: Issue, Feature, RequiredTest, AcceptanceCriterion, PullRequest
--
-- Edge types (rel_type values in nexum.links):
--   project:issue_has_feature
--   project:feature_has_required_test
--   project:feature_has_acceptance_criterion
--   project:pr_resolves_issue
--
-- See docs/architecture.md §Nexum — project management graph.
-- See docs/milestone-1.md §4.6.

-- 1. project_nodes table -----------------------------------------------------
-- Stores typed project-management nodes. Each row references a block in
-- nexum.blocks (for content addressability) and carries project-specific
-- metadata: node_type, state, and an optional external reference (e.g. GitHub
-- issue number or PR number).

CREATE TABLE IF NOT EXISTS nexum.project_nodes (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    -- The nexum.blocks row that holds this node's textual content.
    block_id        UUID        NOT NULL REFERENCES nexum.blocks(id),
    -- Discriminator: one of Issue, Feature, RequiredTest,
    -- AcceptanceCriterion, PullRequest.
    node_type       TEXT        NOT NULL
                                CHECK (node_type IN (
                                    'Issue',
                                    'Feature',
                                    'RequiredTest',
                                    'AcceptanceCriterion',
                                    'PullRequest'
                                )),
    -- Lifecycle state; updated by loop steps.
    -- open → in_progress → validated → closed
    state           TEXT        NOT NULL DEFAULT 'open'
                                CHECK (state IN (
                                    'open',
                                    'in_progress',
                                    'validated',
                                    'closed'
                                )),
    -- Optional external reference, e.g. GitHub issue number "493" or
    -- PR number "498". Free text — no foreign key to an external system.
    external_ref    TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS project_nodes_block_id_idx
    ON nexum.project_nodes (block_id);

CREATE INDEX IF NOT EXISTS project_nodes_node_type_idx
    ON nexum.project_nodes (node_type);

CREATE INDEX IF NOT EXISTS project_nodes_state_idx
    ON nexum.project_nodes (state);

-- 2. One-PR-per-issue constraint via unique partial index ---------------------
-- Enforces that each PullRequest node is linked to at most one Issue via
-- 'project:pr_resolves_issue'. The unique constraint is on (src, rel_type)
-- so a given PR block can only appear as src once for this edge type.
--
-- This index is partial: it only covers rows where rel_type starts with
-- 'project:pr_resolves_issue'. The enforcement is additionally applied in
-- the Rust link_pr_to_issue() function (which checks dst uniqueness for the
-- PR node).

CREATE UNIQUE INDEX IF NOT EXISTS links_pr_resolves_issue_unique_src_idx
    ON nexum.links (src)
    WHERE rel_type = 'project:pr_resolves_issue';

-- 3. General project-edge index ----------------------------------------------
-- Fast lookup of all project edges by rel_type prefix.

CREATE INDEX IF NOT EXISTS links_project_rel_type_idx
    ON nexum.links (rel_type)
    WHERE rel_type LIKE 'project:%';
