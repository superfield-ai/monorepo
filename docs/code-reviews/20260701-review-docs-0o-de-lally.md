# Documentation Drift Review — Superfield monorepo

- **Review:** `review-docs`
- **Repository:** https://github.com/superfield-ai/monorepo
- **Branch / commit:** `main` @ `6d89f1a724ccd7ec8fe4b07c5dcd5ae47deed88b`
- **Reviewed at:** 2026-07-01 (read-only, worktree `adhoc/20260701-130004-review-docs-drift`)
- **Reviewer:** 0o-de-lally, coordinator synthesis of 6 concurrent doc-slice workers

## 1. Scope and pinned commit

- Documentation-drift review across canonical docs, accepted ADRs, GitHub Plan #199, implementation, and source back-links
- docs/ (prd, architecture, technical-requirements, milestone-1, ADRs, testing, testing-invariants, eval-design, runtime-agent-selection, control-template-integration, ux/studio-ux, scout/*, vision)
- crates/sharp/docs/* and crates/fastenv/docs/*
- coverage-truth.toml and .github/workflows/*
- README.md

No production code, canonical documents, issues, or external state were modified. This artifact and its JSON twin are the only outputs.

## 2. Headline verdict

Documentation is broadly aligned with the appliance architecture, but 34 drift findings remain: 8 high (retired-prototype README, unreconciled ADR/RLS status, Sharp merge-guarantee tests that never execute in CI, retired Node/Bun control doc, unrouted studio endpoints), 12 medium, 14 low.

## 3. Severity / classification summary

| Severity  | Count  |
| --------- | ------ |
| high      | 8      |
| medium    | 12     |
| low       | 14     |
| **total** | **34** |

Classifications: GAP_DOC (2), GAP_IMPL (1), INCONSISTENT (9), MISSING_COMMENT (1), STALE (15), STALE_COMMENT (2), STALE_HEADER (1), TEST_EXECUTION (2), UNRESOLVED_DECISION (1).

Remediation ownership: architecture (16), tests (8), code (4), product (3), operations (2), decision (1).

## 4. Methodology

Six concurrent read-only workers, each pinned to the same commit in a shared review worktree, each owning one documentation domain (product core + Plan #199; accepted ADRs; testing & CI invariants; Sharp crate docs; FastENV crate docs; Studio/UX/eval/scout/vision). Each built a bidirectional map (normative doc statement → code/tests, and implemented capability → canonical doc), compared PRD ↔ architecture/ADRs ↔ Plan/history ↔ implementation/tests ↔ public-symbol comments and back-links, used merged git history as discovery evidence only (verifying against current files), and ran the `review-tests` method for documented runtime claims. Every candidate finding was adversarially refuted against the cited `path:line` before being kept. The coordinator merged one duplicate (the CI-manifest ADR status, flagged by two workers), added one synthesized finding it verified directly (`coverage-truth.toml` fastenv row), deduplicated, and assigned stable IDs ordered by primary evidence path then line.

## 5. Findings

### review-docs-002 · HIGH · STALE · owner: product

**The front-door README still presents the retired TypeScript/Bun/GitHub-App/k3s prototype as 'the current release' Agent IDE, contradicting the standing 'GitHub is never required' constraint (technical-requirements.**

- **Requirement:** `README.md:11`
- **Evidence:** `README.md:3`, `README.md:9-30`, `README.md:36-38`, `README.md:88-107`, `README.md:122-134`, `docs/technical-requirements.md:5`, `docs/architecture.md:5`, `docs/prd.md:3`
- **Confidence:** high
- **Impact:** The front-door README still presents the retired TypeScript/Bun/GitHub-App/k3s prototype as 'the current release' Agent IDE, contradicting the standing 'GitHub is never required' constraint (technical-requirements.md:5) and the appliance direction (prd.md, architecture.md). Its Structure section lists only packages/* (TS) and omits every crates/* Rust crate that now IS the product; it points at docs/product.md, a file prd.md:3 says it supersedes. Plan #199 tracks README fixes only for crates/fastenv/README.md and evals/README.md — the root README drift is untracked.
- **Recommendation:** Rewrite README to describe the Rust appliance (single superfield binary, daemon + gardening loop, local Postgres, fastenv, crates/* layout); remove Bun/GitHub-App/k3s requirements or mark them retired; fix the dead docs/product.md link to docs/prd.md + docs/architecture.md.

### review-docs-007 · HIGH · STALE · owner: architecture

**postgres-storage-plugin.**

- **Requirement:** `crates/sharp/docs/postgres-storage-plugin.md:22`
- **Evidence:** `crates/sharp/docs/postgres-storage-plugin.md:22`, `crates/sharp/docs/postgres-storage-plugin.md:174`, `crates/sharp/migrations/0001_sharp_vcs_schema.sql:1`
- **Confidence:** high
- **Impact:** postgres-storage-plugin.md names 'the shipped migrations under apps/server/migrations/<seq>__<name>.sql' as 'the executable source of truth for exact column types.' No apps/ directory exists anywhere in the repo; the authoritative migrations live under crates/sharp/migrations/ with a different scheme (000N_sharp_<name>.sql). A reader following the doc lands nowhere.
- **Recommendation:** Repoint the schema source-of-truth reference to crates/sharp/migrations/ with the real 000N_sharp_<name>.sql naming.

### review-docs-011 · HIGH · TEST_EXECUTION · owner: tests

**The self-hosting gate (#447) and the no-non-compiling-merge guarantee are not proven by any CI-executing test.**

- **Requirement:** `crates/sharp/src/merge_flow.rs:5`
- **Evidence:** `crates/sharp/tests/integration.rs:1226`, `crates/sharp/tests/integration.rs:1278`, `crates/sharp/tests/integration.rs:1281`, `crates/sharp/tests/integration.rs:1523`, `crates/sharp/tests/integration.rs:1606`, `crates/sharp/tests/integration.rs:842`, `crates/sharp/tests/integration.rs:879`, `crates/sharp/tests/integration.rs:1317`
- **Related:** review-docs-009
- **Confidence:** high
- **Impact:** The self-hosting gate (#447) and the no-non-compiling-merge guarantee are not proven by any CI-executing test. The single non-#[ignore]d self-hosting test (self_hosting_gate_semantic_merge_on_sharp_source, integration.rs:1226) does NOT run the real pipeline: it hand-simulates rename propagation with theirs.replace('compute_value','calculate_result') (line 1278) and calls pure three_way_merge (1281) — never invoking semantic_merge_rust, rust-analyzer, cargo_check, or merge_flow. Every test that exercises the compile gate / production merge pipeline (1524, 1607, 1318, 843, 880) is #[ignore]d and excluded from the rust-test-seam filterset.
- **Recommendation:** Provision cargo (+ rust-analyzer) in a CI job and add merge_flow's compile-gate refusal tests to an executed --run-ignored filterset asserting >0 ran; the executed self-hosting test should call semantic_merge_rust / run_merge_flow instead of a hand-simulated string replace.

### review-docs-012 · HIGH · TEST_EXECUTION · owner: tests

**test-plan.**

- **Requirement:** `crates/sharp/docs/test-plan.md:11`
- **Evidence:** `crates/sharp/tests/scenarios.rs:412`, `crates/sharp/tests/scenarios.rs:413`, `crates/sharp/tests/scenarios.rs:426`, `crates/sharp/tests/scenarios.rs:437`, `crates/sharp/tests/scenarios.rs:438`, `crates/sharp/docs/test-plan.md:11`, `.github/workflows/rust.yml:343`
- **Confidence:** high
- **Impact:** test-plan.md declares the differential harness 'the source of truth for Sharp is better than git on real code-change scenarios', but 11 of the 12 Rust scenarios (every rename/format/import/reorder case that exercises the semantic path via rust-analyzer + cargo check) are #[ignore]d. The only un-ignored scenario (delete_edit_delete_then_edit) is pure path-classification and never invokes the semantic engine; the rust-test-seam filterset selects no scenario tests. The central 'Sharp beats git' claim has no executed-in-CI assertion and the #[ignore]d tests silently skip when rust-analyzer/cargo are absent (loud-skip + executed-assertion invariants violated).
- **Recommendation:** Add a CI job that provisions rust-analyzer + cargo and runs the scenario corpus with --run-ignored all --no-tests=fail asserting >0 semantic scenarios execute, or gate the tests so missing tooling fails loudly.

### review-docs-014 · HIGH · STALE_HEADER · owner: architecture

**The ADR is still marked Status: Proposed and frames its schema and GHA-adapter work as future 'separate work'/Follow-up, yet the whole decision shipped and merged (schema #821/#825, native executor #822/#826, GHA adapter #823/#827, taxonomy/coverage gate #824/#828).**

- **Requirement:** `docs/adr-ci-execution-manifest.md:4`
- **Evidence:** `docs/adr-ci-execution-manifest.md:4`, `docs/adr-ci-execution-manifest.md:126`, `docs/adr-ci-execution-manifest.md:128`, `crates/fastenv/src/manifest.rs:1`, `crates/fastenv/src/ci_executor.rs:462`, `crates/fastenv/src/ci_import.rs:1`, `crates/fastenv/src/ci_gate.rs:1`, `.github/workflows/manifest-lint.yml:73`, `crates/fastenv/docs/ci-job-manifest-schema.md:3`
- **Related:** review-docs-005
- **Confidence:** high
- **Impact:** The ADR is still marked Status: Proposed and frames its schema and GHA-adapter work as future 'separate work'/Follow-up, yet the whole decision shipped and merged (schema #821/#825, native executor #822/#826, GHA adapter #823/#827, taxonomy/coverage gate #824/#828). It is even cited by ci-job-manifest-schema.md:3 as the 'Canonical decision.' A 'Proposed' status invites re-litigation of a built, enforced design and reads the closed Follow-up as open.
- **Recommendation:** Flip Status to Accepted (record closing issues #821-#828) and rewrite the Follow-up/Negative bullets into past-tense Consequences pointing at crates/fastenv/src/{manifest,ci_executor,ci_import,ci_gate}.rs, manifest-lint.yml, and the committed example manifest.

### review-docs-017 · HIGH · STALE · owner: architecture

**The ADR's RLS section asserts 'Row-level security is not yet enabled on any schema', but workspace-isolation RLS is now implemented and enforced on both deployment tracks (ENABLE + FORCE ROW LEVEL SECURITY with CRUD policies across sharp/nexum/auth, a BYPASSRLS superfield_admin role, and a passing integration test).**

- **Requirement:** `docs/adr-schema-boundary.md:163`
- **Evidence:** `docs/adr-schema-boundary.md:163`, `packages/db/migrations/0001_rls_workspace_isolation.sql:5`, `crates/sharp/migrations/0009_rls_workspace_isolation.sql:1`, `crates/sf-db/tests/rls_workspace_isolation_integration.rs:1`, `docs/architecture.md:127`
- **Confidence:** high
- **Impact:** The ADR's RLS section asserts 'Row-level security is not yet enabled on any schema', but workspace-isolation RLS is now implemented and enforced on both deployment tracks (ENABLE + FORCE ROW LEVEL SECURITY with CRUD policies across sharp/nexum/auth, a BYPASSRLS superfield_admin role, and a passing integration test). architecture.md:127 already documents RLS as live, so the ADR directly contradicts the canonical architecture doc and understates the security posture.
- **Recommendation:** Update ADR RLS section to state RLS is enforced, cite the two migrations and the two-track mirroring already captured in architecture.md.

### review-docs-020 · HIGH · STALE · owner: architecture

**The entire doc specifies a Node/Bun @superfield/control studio server (src/config.**

- **Requirement:** `docs/control-template-integration.md:1`
- **Evidence:** `docs/control-template-integration.md:2`, `docs/control-template-integration.md:23`, `docs/control-template-integration.md:59`, `docs/control-template-integration.md:70`, `docs/control-template-integration.md:122`, `packages/cli/commands/control.ts:17`, `packages/cli/commands/control.ts:113`, `packages/cli/commands/control.ts:151`, `packages/control/package.json:2`, `packages/control-core/manifest-parser.ts:162`
- **Confidence:** high
- **Impact:** The entire doc specifies a Node/Bun @superfield/control studio server (src/config.ts, deploy.ts, agent.ts, claude-session.ts, design-mode-context.ts, helpers.ts) that no longer exists after the #452 cutover. packages/cli/commands/control.ts now builds the Vite UI and delegates ALL serving to the sf-serve Rust binary ('No Node/Bun backend process is started'). The --repo flag is now --path; controlCommand/_startControl is now _startSfServe; loadConfig()/discoverServicePort(...,'web') moved to control-core/manifest-parser.ts:162; the cli/packages/ path prefix predates the reorg. The §2 12-test plan targets a retired node:http/MSW surface.
- **Recommendation:** Rewrite or retire control-template-integration.md to describe the Rust sf-serve-served studio (crates/sf-serve) and superfield control --path -> sf-serve delegation, or mark it superseded by architecture.md; drop the cli/packages/ prefix and the Node-server test plan.

### review-docs-033 · HIGH · INCONSISTENT · owner: code

**studio-ux.**

- **Requirement:** `docs/ux/studio-ux.md:251`
- **Evidence:** `docs/ux/studio-ux.md:253`, `docs/ux/studio-ux.md:229`, `docs/ux/studio-ux.md:303`, `crates/sf-serve/src/routes/studio.rs:293`, `packages/control/apps/src/controllers/FeaturePaneController.ts:137`, `packages/control/apps/src/components/TurnTimeline.tsx:213`
- **Confidence:** high
- **Impact:** studio-ux.md documents UPDATE as PATCH /studio/issues/:n and the SESSION LOG source as GET /studio/turns/:sessionId, and the frontend matches (FeaturePaneController PATCH, TurnTimeline turns). But the Rust sf-serve studio router — authoritative after the #452 cutover — registers ONLY POST /studio/issues, GET /studio/issues, POST /studio/issues/update, POST /studio/steer (studio.rs:293-299). There is NO PATCH route and NO /studio/turns route anywhere in crates/. So the documented UPDATE (PATCH) and SESSION LOG (turns) surfaces have no backing route on the Rust backend the UI is served by.
- **Recommendation:** Reconcile the studio contract: add PATCH /studio/issues/:n and GET /studio/turns/:sessionId to sf-serve, or update studio-ux.md + frontend to POST /studio/issues/update and the actual turns source; confirm whether SESSION LOG is implemented server-side.

### review-docs-004 · MEDIUM · STALE · owner: tests

**coverage-truth.**

- **Requirement:** `coverage-truth.toml:89`
- **Evidence:** `coverage-truth.toml:89`, `coverage-truth.toml:90`, `.github/workflows/rust.yml:161`, `.github/workflows/rust.yml:166`, `crates/fastenv/src/ci_executor.rs:936`
- **Confidence:** high
- **Impact:** coverage-truth.toml records crates/fastenv tests_executed_in_ci=0 with the note 'rust.yml builds but never runs crate tests; no cargo-test job exists.' That note is factually stale: the required rust-test job runs `cargo nextest run --workspace --no-tests=fail` (rust.yml:166), which executes fastenv's ~300 non-#[ignore]d hermetic tests (319 test attrs, 17 ignored), including the native-execution end-to-end test ci_executor.rs:936. The manifest undercounts because check-coverage-truth.sh only credits `-p <crate>` lines and does not parse --workspace, so fastenv's real executed coverage is invisible and its note asserts a falsehood.
- **Recommendation:** Correct the crates/fastenv row: it IS executed (via the required --workspace nextest run); update the note and, if per-crate crediting is desired, teach check-coverage-truth.sh to attribute --workspace execution or add an explicit -p fastenv line.

### review-docs-005 · MEDIUM · STALE · owner: architecture

**The schema doc still frames the executor/adapter/gate as unbuilt 'compile-safe stubs' owned by future issues #822/#823/#824, but all three shipped: FastenvCiExecutor (ci_executor.**

- **Requirement:** `crates/fastenv/docs/ci-job-manifest-schema.md:14`
- **Evidence:** `crates/fastenv/docs/ci-job-manifest-schema.md:14`, `crates/fastenv/src/ci_executor.rs:8`, `crates/fastenv/src/ci_import.rs:9`, `crates/fastenv/src/ci_gate.rs:9`, `crates/fastenv/src/main.rs:196`
- **Related:** review-docs-014
- **Confidence:** high
- **Impact:** The schema doc still frames the executor/adapter/gate as unbuilt 'compile-safe stubs' owned by future issues #822/#823/#824, but all three shipped: FastenvCiExecutor (ci_executor.rs:8), DefaultGithubActionsAdapter (ci_import.rs:9), StaticManifestGate (ci_gate.rs:9), all CLI-exposed (main.rs run-manifest/import-workflow/emit-gha/lint-manifest) and unit-tested; Unimplemented* variants remain only as link stubs. A reader would think native execution / GHA round-trip / gate enforcement are not yet implemented.
- **Recommendation:** State the three seams are implemented; drop the 'ship as compile-safe stubs / land in parallel' framing.

### review-docs-008 · MEDIUM · INCONSISTENT · owner: architecture

**The plugin doc describes a schema the authoritative crate does not match: objects.**

- **Requirement:** `crates/sharp/docs/postgres-storage-plugin.md:33`
- **Evidence:** `crates/sharp/docs/postgres-storage-plugin.md:37`, `crates/sharp/docs/postgres-storage-plugin.md:67`, `crates/sharp/docs/postgres-storage-plugin.md:75`, `crates/sharp/docs/postgres-storage-plugin.md:178`, `crates/sharp/migrations/0001_sharp_vcs_schema.sql:23`, `crates/sharp/migrations/0001_sharp_vcs_schema.sql:50`, `crates/sharp/migrations/0005_sharp_refs_model.sql:13`
- **Confidence:** medium
- **Impact:** The plugin doc describes a schema the authoritative crate does not match: objects.id documented bytea but shipped sha256 TEXT PK (and the shipped repo_id column is omitted); refs.target documented bytea but shipped target_sha TEXT hex; commit_metadata documented as a generic namespace/key/value annotation store but shipped as denormalized commit fields (parent_sha/message/author/authored_at) — same name, different meaning; the representations table and annotation-style commit_metadata are not implemented in any migration; and it references a 'postgres package' where the crate uses sqlx. Reads as describing the old TS-prototype server.
- **Recommendation:** Reconcile with crates/sharp/migrations: fix id/target types to text-hex, mark representations/annotation-commit_metadata as not-yet-shipped, and replace 'postgres package' with sqlx.

### review-docs-009 · MEDIUM · STALE_COMMENT · owner: code

**merge_flow.**

- **Requirement:** `—`
- **Evidence:** `crates/sharp/src/merge_flow.rs:18`, `crates/sharp/src/merge_flow.rs:19`, `crates/sharp/src/merge_flow.rs:20`, `crates/sharp/tests/integration.rs:1523`
- **Related:** review-docs-011
- **Confidence:** high
- **Impact:** merge_flow.rs's 'Merge guarantee' doc-comment states the gate 'is exercised end-to-end on Superfield's own Rust source, proving the no-non-compiling-merge guarantee at production scale.' In practice the end-to-end tests are #[ignore]d and excluded from the CI seam filterset, so nothing exercises it in CI. The comment asserts a proof that does not run.
- **Recommendation:** Soften the comment to describe the guarantee as enforced-by-code with tests gated on cargo/rust-analyzer, or wire the end-to-end test into CI.

### review-docs-015 · MEDIUM · GAP_DOC · owner: architecture

**The ADR's authoritative schema-namespace-assignment table lists sf-db as owning only the substrate schema (backups).**

- **Requirement:** `docs/adr-schema-boundary.md:92`
- **Evidence:** `docs/adr-schema-boundary.md:86`, `docs/adr-schema-boundary.md:92`, `crates/sf-db/migrations/0004_change_lifecycle.sql:33`, `crates/sf-db/migrations/0005_policy_engine.sql:40`, `crates/sf-db/migrations/0001_workspaces.sql:1`, `docs/architecture.md:90`
- **Confidence:** high
- **Impact:** The ADR's authoritative schema-namespace-assignment table lists sf-db as owning only the substrate schema (backups). sf-db now also owns the entire forge schema (forge.changes, forge.validation_runs, forge.policies — the Change lifecycle and Policy engine behind PRD US4/US13) and the cross-component public.workspaces identity table. architecture.md:90 already records forge; the ADR namespace table is the stated ownership source of truth and is incomplete, so future components will miss two live schemas.
- **Recommendation:** Add forge (owner sf-db: changes, validation_runs, policies) and the public.workspaces identity table to the ADR namespace table, mirroring architecture.md:90.

### review-docs-018 · MEDIUM · INCONSISTENT · owner: architecture

**The ADR states RLS identity context is carried via current_setting('app.**

- **Requirement:** `docs/adr-schema-boundary.md:169`
- **Evidence:** `docs/adr-schema-boundary.md:169`, `crates/sharp/migrations/0009_rls_workspace_isolation.sql:146`, `crates/sharp/migrations/0009_rls_workspace_isolation.sql:30`, `crates/sf-db/src/lib.rs:15`, `docs/architecture.md:132`
- **Confidence:** high
- **Impact:** The ADR states RLS identity context is carried via current_setting('app.current_principal_id'), but the actual policies key on app.workspace_id; app.current_principal_id is now the LEGACY variable (acquire_with_workspace_id sets both, policies read workspace_id). Anyone implementing a new schema's RLS from the ADR would key on the wrong session variable and get fail-open or empty results.
- **Recommendation:** Change the ADR to specify app.workspace_id as the RLS session key (app.current_principal_id noted as legacy), matching migration 0009 and architecture.md:132.

### review-docs-019 · MEDIUM · STALE · owner: architecture

**The ADR Consequences state the migration runner applies in order 'auth -> nexum -> sharp -> orchestrator', but the real COMPONENT_DIRS order is sf-db -> sf-auth -> nexum -> sharp -> orchestrator.**

- **Requirement:** `docs/adr-schema-boundary.md:202`
- **Evidence:** `docs/adr-schema-boundary.md:202`, `crates/sf-db/src/migrate.rs:111`, `crates/sf-db/src/migrate.rs:112`, `docs/architecture.md:134`
- **Confidence:** high
- **Impact:** The ADR Consequences state the migration runner applies in order 'auth -> nexum -> sharp -> orchestrator', but the real COMPONENT_DIRS order is sf-db -> sf-auth -> nexum -> sharp -> orchestrator. The ADR omits sf-db entirely, yet sf-db runs FIRST and creates workspaces, threads workspace_id onto every component table, and creates the forge schema — prerequisites for later migrations. A reader relying on the ADR ordering would mis-sequence a new migration.
- **Recommendation:** Correct the ADR ordering to sf-db -> sf-auth -> nexum -> sharp -> orchestrator, citing migrate.rs:111 COMPONENT_DIRS (already correct in architecture.md:134).

### review-docs-023 · MEDIUM · STALE · owner: product

**Milestone-1 §4.**

- **Requirement:** `docs/milestone-1.md:47`
- **Evidence:** `docs/milestone-1.md:47`, `crates/sf-cli/src/garden.rs:103`, `crates/superfield/src/main.rs:84`, `docs/architecture.md:744`
- **Confidence:** high
- **Impact:** Milestone-1 §4.3 specifies a `superfield garden` surface with four subcommands (garden run/start/status/step <n>) and calls garden run 'the reference implementation for the loop step contract.' None exist: garden is a single ingest verb (garden <file...> -> garden_ingest). The lifecycle §4.3 attributes to these subcommands is driven by the daemon-supervised loop engine. This also contradicts the sibling canonical doc architecture.md:744, which documents garden <file...> as 'Ingest markdown files into the Nexum knowledge graph.'
- **Recommendation:** Rewrite milestone-1.md §4.3 to match the shipped surface (garden <file...> ingests; run/step lifecycle lives in the daemon loop engine and superfield daemon/status/logs) and reconcile with architecture.md:744.

### review-docs-024 · MEDIUM · STALE · owner: product

**Milestone-1 §4.**

- **Requirement:** `docs/milestone-1.md:96`
- **Evidence:** `docs/milestone-1.md:96`, `docs/milestone-1.md:98`, `docs/technical-requirements.md:5`, `docs/architecture.md:570`, `crates/sf-db/src/project_graph.rs:341`
- **Confidence:** medium
- **Impact:** Milestone-1 §4.6 point 1 says 'every GitHub issue ingested by the daemon is represented as an Issue node,' framing the project graph as a GitHub-issue mirror. The appliance daemon does not ingest GitHub issues; ProjectGraphDerive derives Feature/Issue nodes from plan/prd/strategy knowledge pages (architecture.md:570), and 'GitHub is never required' (technical-requirements.md:5). §4.6 point 2 also says each acceptance criterion is 'linked to its parent Issue node,' but the code links AcceptanceCriterion to a parent Feature (project:feature_has_acceptance_criterion, project_graph.rs:341).
- **Recommendation:** Update §4.6 point 1 to describe derivation from knowledge pages (not GitHub-issue ingestion) and correct point 2 so AcceptanceCriterion is a child of Feature, matching the code edges.

### review-docs-025 · MEDIUM · STALE · owner: architecture

**The 'Relationship to existing code' table cites symbols/lines that no longer resolve: filterAvailableBackends @ agent.**

- **Requirement:** `docs/runtime-agent-selection.md:322`
- **Evidence:** `docs/runtime-agent-selection.md:326`, `docs/runtime-agent-selection.md:327`, `docs/runtime-agent-selection.md:328`, `docs/runtime-agent-selection.md:329`, `packages/core/agent.ts:17`, `packages/core/agent.ts:153`, `packages/core/agent.ts:167`, `packages/core/agent.ts:271`, `packages/core/job-registry.ts:2`
- **Confidence:** high
- **Impact:** The 'Relationship to existing code' table cites symbols/lines that no longer resolve: filterAvailableBackends @ agent.ts:214 ('login check only; no retry window yet') does not exist (replaced by inline availabilityStore.isAvailable) and its note contradicts the doc's own line 334; callWithBackendPriority @ agent.ts:342 is renamed callWithCandidatePriority (agent.ts:167); MODEL_TIER_MAPPING @ agent.ts:26 now lives in models.ts; waitForAvailableBackend @ agent.ts:424 is actually line 271. The target behavior itself is correctly implemented.
- **Recommendation:** Refresh the reference table to callWithCandidatePriority (167), waitForAvailableBackend (271), models.ts for MODEL_TIER_MAPPING, and delete the stale filterAvailableBackends 'no retry window yet' row.

### review-docs-029 · MEDIUM · INCONSISTENT · owner: tests

**The invariant doc claims the coverage-delta gate makes 'touching a package's code require >0 of that package's tests to run.**

- **Requirement:** `docs/testing-invariants.md:36`
- **Evidence:** `docs/testing-invariants.md:36`, `scripts/check-coverage-delta.sh:122`, `scripts/check-coverage-delta.sh:131`, `scripts/check-coverage-delta.sh:159`, `.github/workflows/rust.yml:410`
- **Confidence:** high
- **Impact:** The invariant doc claims the coverage-delta gate makes 'touching a package's code require >0 of that package's tests to run.' The gate (check-coverage-delta.sh) is Rust-crates-only: owning_package() returns None for any path not under crates/ and the gate no-ops for TS packages (packages/_). coverage-truth.toml reserves 'package' for packages/_ and 'crate' for crates/*, so the doc's unqualified 'per package' reads as covering TS packages while no coverage-delta enforcement exists for them; a TS package can be modified with zero of its tests executing and no gate fires.
- **Recommendation:** Reword testing-invariants.md:36 to scope the gate to Rust crates (as the script does), or extend check-coverage-delta.sh + wiring to enforce a per-package floor for TS packages.

### review-docs-032 · MEDIUM · INCONSISTENT · owner: tests

**testing.**

- **Requirement:** `docs/testing.md:131`
- **Evidence:** `docs/testing.md:110`, `docs/testing.md:131`, `docs/testing-invariants.md:15`, `docs/testing-invariants.md:19`
- **Confidence:** medium
- **Impact:** testing.md Layer 3 documents and blesses liveDescribe/liveIt, which 'call describe.skip / it.skip when the env var is unset, so the suite is silent on PR runs' — precisely the silent-skip antipattern testing-invariants.md invariant 1 forbids. Neither canonical doc cross-references the other to scope the exception (live tests are intentionally NOT counted as coverage, so their silent skip is acceptable). A contributor can cite testing.md's sanctioned liveDescribe pattern to justify silently skipping a resource-gated test invariant 1 requires to fail loudly.
- **Recommendation:** Cross-reference both docs: testing.md Layer 3 should note live tests are a safety net explicitly NOT counted as coverage, and testing-invariants.md should carve out the Layer-3 live suite as the sole sanctioned silent-skip.

### review-docs-001 · LOW · STALE · owner: operations

**rust.**

- **Requirement:** `.github/workflows/rust.yml:18`
- **Evidence:** `.github/workflows/rust.yml:18`, `scripts/required-status-contexts.txt:31`
- **Confidence:** high
- **Impact:** rust.yml header comment says the canonical required set is '10 today'; required-status-contexts.txt actually lists 11 required contexts (Typecheck, Lint, Format, Unit, Integration, Container build, embedder coverage, Rust workspace tests, coverage-delta, Coverage truth, Manifest gate). Off-by-one in a CI-doc comment.
- **Recommendation:** Update the count to 11, or drop the hard-coded number and point at the file.

### review-docs-003 · LOW · INCONSISTENT · owner: tests

**coverage-truth.**

- **Requirement:** `coverage-truth.toml:52`
- **Evidence:** `coverage-truth.toml:52`, `coverage-truth.toml:131`, `coverage-truth.toml:156`, `coverage-truth.toml:173`, `.github/workflows/rust.yml:98`, `.github/workflows/rust.yml:220`, `.github/workflows/rust.yml:343`
- **Confidence:** high
- **Impact:** coverage-truth.toml's header and several crate-row notes attribute the DB-gated 'cargo nextest run -p sf-db -p sf-serve -p sharp -p superfield -p sf-loop --run-ignored all' execution to the rust-test job (issue #765). In reality rust-test is issue #764 (hermetic, no -p, no --run-ignored, rust.yml:98) and the DB-gated command lives in the separate rust-test-seam job (rust.yml:343, issue #765) which is explicitly NOT a required context (rust.yml:220). Enforcement is unaffected, but the manifest mis-identifies the executing job and hides that these counts come from a non-required job.
- **Recommendation:** Correct the header (line 52) and the sf-db/sf-serve/sharp/superfield/sf-loop row notes to name rust-test-seam as the DB-gated executor.

### review-docs-006 · LOW · STALE · owner: architecture

**Every Phase 1-6 checklist item in the Project-VM implementation plan is an unchecked [ ], while the migration note ('the Rust implementation is now the canonical code path; the Go prototype is deprecated'), the parity harness, the shipped boundary/security-regression modules, and the removed Go tree show most of the cutover has landed.**

- **Requirement:** `crates/fastenv/docs/implementation-plan.md:61`
- **Evidence:** `crates/fastenv/docs/implementation-plan.md:61`, `crates/fastenv/docs/migration-note.md:1`, `crates/fastenv/docs/migration-note.md:86`, `crates/fastenv/src/boundary.rs:1`, `crates/fastenv/src/security_regression.rs:1`, `crates/fastenv/docs/architecture.md:416`
- **Confidence:** high
- **Impact:** Every Phase 1-6 checklist item in the Project-VM implementation plan is an unchecked [ ], while the migration note ('the Rust implementation is now the canonical code path; the Go prototype is deprecated'), the parity harness, the shipped boundary/security-regression modules, and the removed Go tree show most of the cutover has landed. Readers cannot tell remaining work from completed work.
- **Recommendation:** Check off the delivered Phase 1/4/5/6 items or add a status banner pointing at migration-note.md as the current-state source of truth.

### review-docs-010 · LOW · MISSING_COMMENT · owner: code

**Back-link asymmetry across Sharp modules: several crates/sharp/docs files point at their implementing module, but the modules' header doc-comments cite only docs/architecture.**

- **Requirement:** `—`
- **Evidence:** `crates/sharp/src/projections.rs:1`, `crates/sharp/src/hooks.rs:14`, `crates/sharp/src/git_interop.rs:1`, `crates/sharp/src/episode.rs:6`, `crates/sharp/docs/projections.md:3`, `crates/sharp/docs/hooks-guide.md:9`
- **Confidence:** high
- **Impact:** Back-link asymmetry across Sharp modules: several crates/sharp/docs files point at their implementing module, but the modules' header doc-comments cite only docs/architecture.md/whitepaper/engineering-plan, not their dedicated canonical doc (projections.rs<->projections.md, hooks.rs<->hooks.md/hooks-guide.md, git_interop.rs<->git-interop.md, episode.rs<->episodes.md). A maintainer editing the module is not routed to the descriptive doc that must stay in sync.
- **Recommendation:** Add a one-line back-reference in each module header to its canonical crates/sharp/docs doc so the link is bidirectional. Cluster: projections/hooks/git_interop/episode modules.

### review-docs-013 · LOW · STALE_COMMENT · owner: code

**The `superfield page <name>` CLI usage/help text lists 'prd | architecture | plan | strategy | project' and omits `technical`, but `technical` is a real known page (KNOWN_PAGES, page_query.**

- **Requirement:** `—`
- **Evidence:** `crates/superfield/src/main.rs:84`, `crates/sf-db/src/page_query.rs:54`, `crates/sf-db/src/page_query.rs:59`, `docs/architecture.md:787`
- **Confidence:** high
- **Impact:** The `superfield page <name>` CLI usage/help text lists 'prd | architecture | plan | strategy | project' and omits `technical`, but `technical` is a real known page (KNOWN_PAGES, page_query.rs:59) and architecture.md:787 lists it in the page registry. A user reading --help won't learn the technical page is fetchable.
- **Recommendation:** Add `technical` to the `page <name>` help text in crates/superfield/src/main.rs so CLI help matches KNOWN_PAGES and architecture.md.

### review-docs-016 · LOW · INCONSISTENT · owner: architecture

**The ADR's migration-naming rules require <NNNN>_<schema>_<description>.**

- **Requirement:** `docs/adr-schema-boundary.md:123`
- **Evidence:** `docs/adr-schema-boundary.md:99`, `docs/adr-schema-boundary.md:123`, `crates/sf-db/migrations/0001_workspaces.sql:1`, `crates/sf-db/migrations/0002_substrate_backups.sql:1`
- **Confidence:** medium
- **Impact:** The ADR's migration-naming rules require <NNNN>_<schema>_<description>.sql and that every component's 0001_* migration begin with CREATE SCHEMA IF NOT EXISTS <component>. sf-db's 0001_workspaces.sql instead creates the workspaces table in the shared public schema (no CREATE SCHEMA, no schema token in the filename), and the substrate schema is first created in 0002. This is a real, undocumented exception (workspace identity is deliberately cross-component/public) the ADR's rules do not carve out.
- **Recommendation:** Note the explicit public/workspaces exception in the ADR, or reconcile the sf-db migration filenames with the documented convention.

### review-docs-021 · LOW · UNRESOLVED_DECISION · owner: decision

**The doc records 'Decision: Option A' — make Service lookup configurable via process.**

- **Requirement:** `docs/control-template-integration.md:39`
- **Evidence:** `docs/control-template-integration.md:50`, `docs/control-template-integration.md:62`, `packages/control-core/manifest-parser.ts:162`
- **Confidence:** high
- **Impact:** The doc records 'Decision: Option A' — make Service lookup configurable via process.env.CONTROL_WEB_SERVICE_NAME ?? 'web' in config.ts, and to mention it in §1.1 once implemented. CONTROL_WEB_SERVICE_NAME appears ONLY in this doc (grep across .ts/.rs/.md) and config.ts is retired, so the decision was never implemented and is now orphaned.
- **Recommendation:** Drop the decision, or re-anchor it against the current manifest-parser.ts discovery path if configurable Service naming is still wanted.

### review-docs-022 · LOW · INCONSISTENT · owner: architecture

**eval-design.**

- **Requirement:** `docs/eval-design.md:77`
- **Evidence:** `docs/eval-design.md:77`, `crates/sf-loop/src/lib.rs:9`, `crates/sf-loop/src/lib.rs:11`, `crates/sf-eval/tests/live_runner.rs:14`
- **Confidence:** high
- **Impact:** eval-design.md Tier-0 says 'stage ordering across the seven gardening steps'. The loop actually runs NINE GardeningStep variants (lib.rs:9 'runs nine GardeningStep variants', enumerated 1-9; live_runner.rs:14 'one full nine-step pass'). IntentSpecInference, HolisticReconcile, ProjectGraphDerive, and CodeChangeProposal were added.
- **Recommendation:** Change 'seven gardening steps' to 'nine gardening steps' in eval-design.md:77.

### review-docs-026 · LOW · STALE · owner: architecture

**Dev-scout artifact for #760/#761/#762.**

- **Requirement:** `docs/scout/embedding-coverage-offline-weights-and-pgvector-seams.md:276`
- **Evidence:** `docs/scout/embedding-coverage-offline-weights-and-pgvector-seams.md:281`, `docs/scout/embedding-coverage-offline-weights-and-pgvector-seams.md:283`, `.github/workflows/embedder-coverage.yml:163`, `.github/workflows/embedder-coverage.yml:180`, `.github/workflows/eval-todo-app.yml:132`, `crates/nexum/tests/integration.rs:47`
- **Confidence:** high
- **Impact:** Dev-scout artifact for #760/#761/#762. Its §5 table calls embedder-coverage.yml 'workflow_dispatch only; not a gate', the governed-embed-weights action 'not referenced by any workflow', and describes the maybe_pool() silent-skip as still present. All three landed: embedder-coverage.yml is now a gated job (push+PR+nightly, NEXUM_REQUIRE_DB=1) executing the #[ignore]d tests via --include-ignored; the action IS referenced by eval-todo-app.yml:132; integration.rs now has the loud NEXUM_REQUIRE_DB guard. Informational — point-in-time scout record now superseded.
- **Recommendation:** Optionally annotate the scout note 'implemented in #760/#761/#762'; no CI-honesty gap (embedder tests are actually executed under --include-ignored with governed weights).

### review-docs-027 · LOW · STALE · owner: architecture

**Dev-scout artifact for #725.**

- **Requirement:** `docs/scout/sharp-object-algo-column-seams.md:37`
- **Evidence:** `docs/scout/sharp-object-algo-column-seams.md:41`, `docs/scout/sharp-object-algo-column-seams.md:81`, `crates/sharp/migrations/0010_sharp_objects_algo.sql:17`, `crates/sharp/migrations/0010_sharp_objects_algo.sql:23`, `crates/sharp/src/object.rs:71`, `crates/sharp/src/object.rs:123`
- **Confidence:** high
- **Impact:** Dev-scout artifact for #725. Its §2 'current schema (as deployed)' shows sharp.objects with NO algo column and §3a says the INSERTs 'omit algo; must add it.' #725 has landed: migration 0010_sharp_objects_algo.sql adds algo (with the recommended sha256 backfill) and object.rs store/store_canonical INSERTs now include algo (object.rs:71, :123). Cited object.rs lines also drifted (~+9). Informational — implemented as the scout designed.
- **Recommendation:** Optionally mark the scout note 'implemented in #725 (migration 0010)'; dev-scout artifacts are point-in-time records.

### review-docs-028 · LOW · INCONSISTENT · owner: tests

**Invariant 2 prescribes the JS/TS runner convention `vitest --passWithNoTests=false` to make 'no tests collected' red.**

- **Requirement:** `docs/testing-invariants.md:31`
- **Evidence:** `docs/testing-invariants.md:31`, `.github/workflows/test-unit.yml:39`, `.github/workflows/test-integration.yml:38`
- **Confidence:** high
- **Impact:** Invariant 2 prescribes the JS/TS runner convention `vitest --passWithNoTests=false` to make 'no tests collected' red. The actual TS jobs invoke `bun --bun vitest run packages/*/tests/unit` (test-unit.yml:39) and .../tests/integration (test-integration.yml:38) WITHOUT --passWithNoTests=false. Behavior likely holds via the vitest default, but the explicit convention the doc presents is not applied — unlike the Rust side, which passes --no-tests=fail explicitly so enforcement survives a default change.
- **Recommendation:** Add --passWithNoTests=false to the two vitest invocations (matching the doc and the Rust rationale), or note in testing-invariants.md that the TS side relies on the vitest default.

### review-docs-030 · LOW · GAP_DOC · owner: tests

**testing.**

- **Requirement:** `docs/testing.md:240`
- **Evidence:** `docs/testing.md:1`, `docs/testing.md:240`, `docs/testing-invariants.md:1`, `scripts/check-doc-conformance.sh:171`
- **Confidence:** medium
- **Impact:** testing.md is titled 'Testing Framework' and presents itself as how the codebase is tested, but covers only the TypeScript agent-CLI three-layer strategy. It never mentions the Rust nextest suite, embedder-coverage, coverage-truth, the coverage-delta gate, or the four executed-coverage invariants — now the majority of required CI checks (7 of 11 required contexts are Rust/coverage jobs). Its 'Running the suites' section lists only bun run test:unit/test:integration, no cargo nextest. testing.md does not link testing-invariants.md, and check-doc-conformance.sh guards testing-invariants.md but never references testing.md, so testing.md can drift unchecked.
- **Recommendation:** Add a Rust section (or a prominent cross-link to testing-invariants.md + coverage-truth.toml) to testing.md, include cargo nextest run --workspace in 'Running the suites', and consider a doc-conformance grep for testing.md.

### review-docs-031 · LOW · GAP_IMPL · owner: operations

**testing.**

- **Requirement:** `docs/testing.md:111`
- **Evidence:** `docs/testing.md:110`, `docs/testing.md:247`, `.github/workflows/embedder-coverage.yml:35`
- **Confidence:** medium
- **Impact:** testing.md states Layer 3 live smoke tests 'run nightly or manually before a release'. No workflow references SUPERFIELD_LIVE_AGENTS or packages/*/tests/live; the only scheduled workflows are manifest-lint, actionlint, and embedder-coverage (which runs the embedder, not the agent live suite). The documented 'nightly' cadence for the live vendor-CLI smoke suite is not backed by any scheduled CI job. The doc hedges 'or manually' and Layer 3 is by design outside PR CI, so this is a minor promise-vs-reality gap, not a coverage-honesty violation.
- **Recommendation:** Add a nightly scheduled workflow that runs the live suite (with credentials), or soften testing.md to say the live suite runs manually before a release only.

### review-docs-034 · LOW · STALE · owner: architecture

**studio-ux.**

- **Requirement:** `docs/ux/studio-ux.md:310`
- **Evidence:** `docs/ux/studio-ux.md:310`, `crates/sf-serve/src/routes/studio.rs:107`, `crates/sf-serve/src/routes/studio.rs:293`
- **Confidence:** high
- **Impact:** studio-ux.md states 'The embedded DB (packages/db) is the sole source of truth for title and body.' The Rust studio backend backs Issues/Features with nexum project-graph nodes (create_issue: 'create an Issue node and optional child Features'), not packages/db, after the cutover.
- **Recommendation:** Update the Data Sources section to name the nexum project-graph nodes as the source of truth for studio issue/feature title+body.

## 6. Clean / adequately-covered areas

- architecture.md HTTP route table, Gardening Loop 9-step order, Single-Instance Schema Layout, Governed Embedding Standard (384-dim MiniLM), and Daemon Lifecycle map cleanly to sf-serve/sf-loop/sf-db.
- adr-embedding-model.md governance constants are in force and identical across crates/nexum/src/embed.rs, models/embedding.lock, and packages/db/index.ts; the runtime claim is genuinely executed in CI by embedder-coverage.yml (pgvector + governed offline weights, --include-ignored, loud >0 guard).
- adr-ci-execution-manifest.md native-execution claim IS executed in CI: crates/fastenv/src/ci_executor.rs end-to-end tests are non-#[ignore]d and run under the required cargo nextest run --workspace; manifest-lint.yml is a real required gate on the committed example manifest.
- ci-job-manifest-schema.md field/enum contract matches crates/fastenv/src/manifest.rs exactly (deny_unknown_fields confirmed); the golden example round-trips.
- check-coverage-truth.sh, check-test-job-presence.sh, and testing-invariants.md content-guards are genuinely wired as required jobs; rust-test enforces --no-tests=fail with an AC2 self-check.
- Sharp tsserver bridge (#444), hooks system, and git_interop are implemented and consistent with their docs; client-architecture.md and whitepaper.md correctly hedge planned-vs-shipped.
- AGE fold sub-decision holds (Apache AGE removed, recursive-CTE traversal in packages/db/nexum-graph.ts).
- Studio browser-smoke follow-up (#815/#830/#832) landed as pinned: eval-todo-app.yml drives headless chromium against a real 200 and asserts a non-empty PNG (executed, not stubbed).
- runtime-agent-selection.md and eval-design.md target behaviors are correctly implemented (only reference tables/counts drifted).

## 7. Recommended actions (priority order)

1. **Retire/rewrite the front-door and control docs that describe the deleted TS prototype** — `review-docs-002` (root README), `review-docs-020` (control-template-integration.md). These mislead any new operator or agent about what the product is.
2. **Reconcile the ADRs with shipped reality** — flip `adr-ci-execution-manifest.md` to Accepted (`review-docs-014`, `-005`); fix the schema-boundary ADR's RLS status, session variable, namespace table, and migration order (`review-docs-017`, `-018`, `-015`, `-019`, `-016`).
3. **Close the Sharp merge-guarantee CI-execution gap** — `review-docs-011`, `-012`, `-009`. The 'Sharp beats git' / no-non-compiling-merge claims currently have no executing CI assertion; the running self-hosting test simulates the pipeline. Either provision cargo/rust-analyzer and run the #[ignore]d corpus with `--run-ignored all --no-tests=fail`, or soften the doc/comment claims.
4. **Fix the studio contract mismatch** — `review-docs-033` (PATCH/turns routes absent on sf-serve), `review-docs-034` (source-of-truth). Product/architecture decision required (see §9).
5. **Correct the testing/coverage manifests** — `review-docs-004` (fastenv row falsely says 0 executed), `review-docs-003` (wrong job attribution), `review-docs-029`/`-028` (coverage-delta/vitest scope), `review-docs-030`/`-032` (testing.md omissions + silent-skip cross-reference).
6. **Mechanical refreshes** — stale counts and reference tables: `review-docs-001`, `-013`, `-022`, `-023`, `-024`, `-025`, `-010` (module back-links). Annotate superseded scout artifacts `review-docs-026`, `-027` as implemented.

## 8. Documentation changes

All findings are documentation-or-comment drift except `review-docs-011`/`-012` (test-execution gaps, owner `tests`) and `review-docs-033` (a code-or-doc contract decision). No canonical document was edited by this review; the recommendations above name the exact section and owner for each change.

## 9. Unresolved decisions

- review-docs-033: whether the studio SESSION LOG / issue-UPDATE contract should be fixed in the Rust sf-serve backend (add PATCH/turns routes) or in the doc+frontend (POST /studio/issues/update) is a product/architecture decision, not resolvable from code alone.
- review-docs-021: the `CONTROL_WEB_SERVICE_NAME` 'Option A' decision was recorded but never implemented and is now moot after the control-server retirement — drop it or re-anchor against the current discovery path.

## 10. Limitations and unreviewed surfaces

**Limitations:**

- Read-only static review at commit 6d89f1a7 in worktree adhoc/20260701-130004-review-docs-drift; no builds, tests, or workflows were executed. 'Executed-in-CI' verdicts are inferred from workflow YAML + #[ignore] attributes + seam filtersets, not observed runs.
- GitHub branch-protection required_status_checks could not be read; invariant-4 coverage was verified only against the in-repo mirror scripts/required-status-contexts.txt.
- Plan #199 (~198k chars) was grep-sampled for the reviewed topics, not read in full.
- Sharp conceptual/algebra docs (merge-conflict-taxonomy, semantic-patches, branch-semantics) and pure comparison essays were deprioritized and not line-mapped to code.

**Unreviewed surfaces:**

- packages/* TypeScript internals beyond the doc-cited symbols (control apps component-level fidelity, api-server.ts /studio/run+/studio/reset, packages/git, packages/firecracker microVM boot honesty).
- FastENV design/aspirational docs (ocap-access-control-design, alternative-isolation-for-agents, cloud-kvm-nesting, quota-prerequisites) and scout/benchmark artifacts.
- crates/sharp server-config.md / server-operations.md (describe an HTTP server the crate does not contain as a library).
- crates/sf-auth RLS wiring, orchestrator/migrations content, and sf-deploy/sf-notify/sf-connector internal contracts beyond lib.rs headers.
- docs/vision/unified-memory-layer.md and docs/studio-sessions/main/changes.md (aspirational/log prose with no falsifiable code claims).
