-- Migration: 0004_acceptance_assertions.sql
-- Owner: nexum crate (Nexum knowledge-graph component)
-- Schema: nexum
--
-- Adds the executable-assertion definition layer to AcceptanceCriterion
-- nodes (docs/eval-design.md §"The missing primitive: executable acceptance
-- criteria"). Prior to this migration, nexum.project_nodes rows of
-- node_type = 'AcceptanceCriterion' carry only a title (via the backing
-- nexum.blocks row) — the criterion is not machine-readable and cannot gate
-- anything. This migration adds a typed, CHECK-constrained assertion_kind
-- column plus a JSONB assertion_params column so a criterion can carry a
-- kind ('http-probe', 'playwright', 'required-test' per
-- crates/sf-db/src/project_graph.rs's AssertionKind/AssertionSpec, dev-scout
-- issue #869) and its typed parameters.
--
-- Phase: Executable acceptance criteria (issue #860)
-- Depends on: 0002_project_graph.sql (nexum.project_nodes)
--
-- Idempotent: guarded ADD COLUMN / ADD CONSTRAINT (DO $$ blocks), matching
-- the convention established by crates/sf-db/migrations/0003_workspace_id_threading.sql
-- and crates/sharp/migrations/0008_sharp_runtime_signal_workspace.sql.
--
-- Out of scope (see issue #860 "Out of scope"): executing assertions,
-- CLI/Studio surfacing, sf-loop derivation writing assertion data, and any
-- eval-tier gating on results.
--
-- See docs/architecture.md §Nexum — project management graph.
-- See docs/eval-design.md §"The missing primitive: executable acceptance criteria".

-- 1. assertion_kind / assertion_params columns -------------------------------
--
-- Both columns are nullable: only AcceptanceCriterion nodes carry an
-- assertion, and even AcceptanceCriterion nodes may exist without one today
-- (assertion attachment is a distinct write from criterion creation per the
-- extended insert_acceptance_criterion write path). The pairing CHECK below
-- enforces that the two columns are set or unset together, so a row can
-- never carry a kind with no parameters or parameters with no kind.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'nexum'
          AND table_name   = 'project_nodes'
          AND column_name  = 'assertion_kind'
    ) THEN
        ALTER TABLE nexum.project_nodes
            ADD COLUMN assertion_kind TEXT;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'nexum'
          AND table_name   = 'project_nodes'
          AND column_name  = 'assertion_params'
    ) THEN
        ALTER TABLE nexum.project_nodes
            ADD COLUMN assertion_params JSONB;
    END IF;
END $$;

-- 2. Vocabulary CHECK on assertion_kind ---------------------------------------
--
-- Mirrors the AssertionKind enum's serde kebab-case wire values exactly
-- (crates/sf-db/src/project_graph.rs). NULL is allowed (no assertion
-- attached yet).

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints
        WHERE constraint_schema = 'nexum'
          AND table_name        = 'project_nodes'
          AND constraint_name   = 'project_nodes_assertion_kind_check'
    ) THEN
        ALTER TABLE nexum.project_nodes
            ADD CONSTRAINT project_nodes_assertion_kind_check
            CHECK (assertion_kind IS NULL OR assertion_kind IN (
                'http-probe',
                'playwright',
                'required-test'
            ));
    END IF;
END $$;

-- 3. Pairing CHECK: kind and params are set or unset together -----------------

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints
        WHERE constraint_schema = 'nexum'
          AND table_name        = 'project_nodes'
          AND constraint_name   = 'project_nodes_assertion_pairing_check'
    ) THEN
        ALTER TABLE nexum.project_nodes
            ADD CONSTRAINT project_nodes_assertion_pairing_check
            CHECK (
                (assertion_kind IS NULL AND assertion_params IS NULL)
                OR (assertion_kind IS NOT NULL AND assertion_params IS NOT NULL)
            );
    END IF;
END $$;

-- 4. Node-type CHECK: only AcceptanceCriterion nodes may carry an assertion ---
--
-- Keeps the assertion schema attached exactly where issue #860's "Behaviour"
-- section scopes it ("attached to Feature nodes via AcceptanceCriterion").

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints
        WHERE constraint_schema = 'nexum'
          AND table_name        = 'project_nodes'
          AND constraint_name   = 'project_nodes_assertion_node_type_check'
    ) THEN
        ALTER TABLE nexum.project_nodes
            ADD CONSTRAINT project_nodes_assertion_node_type_check
            CHECK (assertion_kind IS NULL OR node_type = 'AcceptanceCriterion');
    END IF;
END $$;

-- 5. Index for filtering criteria by assertion kind ---------------------------

CREATE INDEX IF NOT EXISTS project_nodes_assertion_kind_idx
    ON nexum.project_nodes (assertion_kind)
    WHERE assertion_kind IS NOT NULL;
