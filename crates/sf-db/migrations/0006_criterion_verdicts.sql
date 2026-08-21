-- Migration: 0006_criterion_verdicts.sql
-- Owner: sf-db crate (substrate / Forge governance)
-- Schema: forge — the autonomous change loop and governance entities.
--
-- Adds the additive per-criterion verdict-row seam pinned (documentation +
-- compile-time key only) by dev-scout issue #869 in
-- `crates/sf-db/src/change.rs`'s "Per-criterion verdict-row seam" module doc
-- comment, and implemented for real by issue #861 (executable acceptance
-- criteria — docs/eval-design.md sequencing item 1).
--
-- forge.validation_runs gains a nullable `criterion_node_id` column:
--   - NULL (every row inserted before this migration, and every row a caller
--     that does not know about criteria ever inserts) means "change-level
--     aggregate run" — unchanged pre-#861 semantics.
--   - Non-NULL means "this row is the verdict for one AcceptanceCriterion
--     node (nexum.project_nodes.id) belonging to the change", one row per
--     criterion per execution (see [`crate::change::record_criterion_validation_run`]).
--
-- Design notes:
--   - NO FOREIGN KEY to nexum.project_nodes(id) is added, despite the #869
--     stub's doc comment describing one. The in-process migration runner
--     (`crates/sf-db/src/migrate.rs`) applies component directories in a
--     fixed dependency order: sf-db -> sf-auth -> nexum -> sharp ->
--     orchestrator. This migration lives in the sf-db component, which is
--     applied BEFORE the nexum component — so on a fresh database,
--     `nexum.project_nodes` does not exist yet when this file runs, and a
--     forward FK would fail migration on first boot. Referential integrity
--     for `criterion_node_id` is therefore enforced at the application layer
--     (the sf-loop criterion executor always resolves the id from an
--     existing AcceptanceCriterion node before recording a verdict), not by
--     a database constraint. This is a deliberate #861 scoping decision —
--     see the corresponding note in `crates/sf-db/src/change.rs`.
--   - Every object is created IF NOT EXISTS / via a guarded ALTER so the file
--     is idempotent and safe to re-run (matches the migration-runner
--     contract in migrate.rs).
--
-- Issue: #861
-- Depends on: 0004_change_lifecycle.sql (forge.validation_runs).
--
-- See docs/eval-design.md §"The missing primitive: executable acceptance
-- criteria" and docs/architecture.md §Change Lifecycle and Validation Gate.

ALTER TABLE forge.validation_runs
    ADD COLUMN IF NOT EXISTS criterion_node_id UUID;

-- Distinct-criterion / latest-row lookups (has_passing_validation's
-- AND-aggregation, and #862's future latest-verdict read path) both filter on
-- (change_id, criterion_node_id) and order by created_at, so index that shape.
CREATE INDEX IF NOT EXISTS validation_runs_criterion_idx
    ON forge.validation_runs (change_id, criterion_node_id)
    WHERE criterion_node_id IS NOT NULL;
