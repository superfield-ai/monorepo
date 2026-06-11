# Sharp Test Plan: Differential Testing Against Git

## 1. Purpose

Drive Sharp's client and server development with a **differential test harness** that runs the same code-change scenarios through both `git` and Sharp, and compares the outcomes. The harness has three jobs:

1. Build a corpus of merge scenarios that **`git` cannot resolve correctly without human intervention** — either it stops with a conflict, or it produces a clean-but-semantically-wrong merge.
2. Provide a **TDD substrate**: every scenario in the corpus is a failing test for Sharp until Sharp resolves it correctly, at which point the test flips green.
3. Quantify the gap between `git` and Sharp over time, so the value of Sharp's semantic layer is measurable rather than asserted.

The harness is the source of truth for "Sharp is better than git on real code-change scenarios." If a scenario isn't in the corpus, the claim doesn't apply to it.

## 2. Non-Goals

- Not a Sharp unit-test suite. Unit tests live next to the code they exercise. This harness is end-to-end, scenario-driven.
- Not a `git` correctness suite. We are not testing `git`; we are using `git` as the baseline against which Sharp is compared.
- Not a benchmark suite. Performance thresholds (commit creation, episode ingest, etc.) live in §11.3 of the README and are exercised separately.
- Not a network test. The harness does not depend on GitHub, GitLab, or any remote service.

## 3. Hypothesis Under Test

> For a meaningful and growing set of code-change scenarios — semantic refactors, parallel edits, rename-and-edit, format-vs-edit, structural reordering — Sharp's merge produces a correct result either fully automatically, or with a smaller residual conflict than `git`, while `git` either produces a textual conflict that requires human intervention or a clean merge that is silently wrong.

The harness measures this hypothesis directly. A scenario is one data point. The corpus is the body of evidence.

## 4. Architecture

```
                  +-------------------------------+
                  |   Scenario Fixture (on-disk)  |
                  |   base/  branch_a/  branch_b/ |
                  |   expected/  validator.sh     |
                  |   meta.yaml                   |
                  +---------------+---------------+
                                  |
                +-----------------+------------------+
                |                                    |
        +-------v-------+                    +-------v-------+
        |   Git Lane    |                    |  Sharp Lane   |
        |               |                    |               |
        |  ephemeral    |                    |  ephemeral    |
        |  git repo in  |                    |  Sharp repo   |
        |  tmpdir       |                    |  in tmpdir    |
        |  + bare       |                    |  + ephemeral  |
        |  "remote"     |                    |  Sharp server |
        |  (also local) |                    |  (localhost)  |
        +-------+-------+                    +-------+-------+
                |                                    |
                |   merge attempt + validator        |
                v                                    v
        +-------+-------+                    +-------+-------+
        |  Outcome      |                    |  Outcome      |
        |  {clean_ok,   |                    |  {clean_ok,   |
        |   clean_wrong,|                    |   clean_wrong,|
        |   conflict,   |                    |   conflict,   |
        |   error}      |                    |   error}      |
        +-------+-------+                    +-------+-------+
                \                                    /
                 \                                  /
                  +---------------+----------------+
                                  |
                          +-------v--------+
                          |  Differential  |
                          |  Report        |
                          |  (table + per- |
                          |  scenario log) |
                          +----------------+
```

### Two lanes, identical inputs

Each scenario runs through two independent lanes:

- **Git lane** — uses the system `git` binary against an ephemeral local-disk repository. A second bare repo on local disk acts as the "remote" for any push/pull semantics that matter (we never touch the network).
- **Sharp lane** — uses `sharp` (client) against an ephemeral Sharp server bound to `127.0.0.1:<random-port>` with a fresh Postgres schema. Sharp's own data path is the only thing exercised; no Git remote is involved.

Both lanes consume the same fixture and run the same merge primitive. The harness records which outcome class each lane produced and writes a scenario-level diff between expected and actual trees.

## 5. Fixture Format

Each scenario is a directory under `tests/scenarios/<category>/<name>/` with this layout:

```
tests/scenarios/refactor/ts/rename_function_with_callsite_edit/
├── meta.yaml
├── base/                      # the common ancestor tree
│   ├── src/main.ts
│   └── ...
├── branch_a/                  # tree after branch A's changes
│   ├── src/main.ts
│   └── ...
├── branch_b/                  # tree after branch B's changes
│   ├── src/main.ts
│   └── ...
├── expected/                  # the correct merged tree (optional)
│   └── src/main.ts
└── validator.ts               # optional fixture-local validator (run with bun)
```

`meta.yaml` schema:

```yaml
name: rename_function_with_callsite_edit
category: refactor
language: ts
summary: >
  Branch A renames foo() to computeTotal(). Branch B edits a call site that
  was foo(). git merges textually and produces a tree where the rename
  partially applies; the edited call site still says foo() and the program
  fails to type-check at runtime.
expected_git_outcome: clean_wrong # or: conflict | clean_ok | error
expected_sharp_outcome: clean_ok # the goal Sharp is being driven toward
validator: ts # 'ts' | 'rust' | './validator.ts' | omitted
notes: |
  This is the canonical "semantic merge" test. Pure-text three-way merge has
  no way to know that the call site needs to be rewritten alongside the
  declaration.
```

The `validator` field selects how the merged tree is checked:

- `ts` — runs the stock TypeScript validator (`tsc --noEmit` against the merged tree).
- `rust` — runs the stock Rust validator (`cargo check`).
- a relative path like `./validator.ts` — runs the fixture's own validator script with `bun`.
- omitted — no behavioral validation; rely on `expected/` tree comparison alone.

Validators are TypeScript files. The harness runs them as subprocesses with `bun`, with the same pinned environment that protects the git lane from leaking developer config.

### Fixture authoring rules

- Trees are stored as **plain files**, not patches. The harness derives diffs at runtime. This keeps fixtures readable and reviewable.
- `expected/` is the source of truth when present. When the correct merge is ambiguous (e.g., reorder-vs-reorder), omit `expected/` and rely solely on `validator.ts` to encode "any acceptable resolution."
- The validator script runs in the merged tree's working directory with a 60-second timeout. Exit 0 = correct. Any other exit = wrong.
- Scenarios must be deterministic. No timestamps, no random seeds, no network calls inside validators.

## 6. Outcome Classification

Each lane produces one of four outcomes per scenario:

| Outcome       | Definition                                                                                                                                                                                                                                            |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clean_ok`    | Merge completed without conflict markers, and the resulting tree matches `expected/` and/or passes `validator.ts`.                                                                                                                                    |
| `clean_wrong` | Merge completed without conflict markers, but the resulting tree fails `validator.ts` or differs from `expected/`. **The dangerous case.**                                                                                                            |
| `conflict`    | The tool emitted conflict markers or refused to complete the merge automatically.                                                                                                                                                                     |
| `dilemma`     | Sharp-only. Sharp deterministically refused to pick between two semantically valid resolutions and returned a structured description of the disagreement to the caller. See §6.1 Tier 3. The git lane has no equivalent and emits `conflict` instead. |
| `error`       | The tool crashed, hung, or otherwise failed to produce a defined outcome.                                                                                                                                                                             |

The corpus is built around two failure modes for `git`: `conflict` (visible failure, requires a human) and `clean_wrong` (silent failure, often shipped to production). Sharp's job is to convert as many of these as possible into `clean_ok`.

### 6.1 Ambiguous Merges Are a Bug, Not a Feature

A core design assumption of Sharp's merge model is that **two-defensibly-correct-outcomes scenarios should be vanishingly rare**. Most apparent ambiguity in textual three-way merge — competing import orderings, "which side's variable name wins," reordering of unrelated additions — is an artifact of treating code as lines rather than as a structured graph. With AST-level matching, symbol-aware rename tracking, and structural diff, the vast majority of those cases collapse to a single deterministic answer. If the corpus accumulates many "either resolution is fine" scenarios, that is evidence Sharp's semantic model is too coarse, not evidence we need a richer scoring DSL.

So we explicitly **do not** introduce a scoring system, weighted axes, or per-fixture rank tuning. Those mechanisms paper over a weak merge model with calibration knobs. We want the merge model strong enough that calibration is unnecessary.

For the residual cases that do occur, the resolution is automatic and tiered:

#### Tier 1 — Deterministic semantic merge (the common case)

Sharp's semantic merge produces a single result. `expected/` matches; `validator.ts` passes; outcome is `clean_ok`. Most of the corpus lands here.

#### Verification gate — every candidate must compile

Every candidate tree produced by Tier 1 (or surviving to Tier 2) is run through a language-aware verification gate before Sharp accepts it: Tree-sitter parse + symbol resolution, plus a compiler check shelled out to the language's own toolchain (`tsc --noEmit` for TypeScript, `cargo check` for Rust). Candidates that fail the gate are dropped; if all candidates fail, Sharp escalates to Tier 3 with the verification failures attached.

The practical consequence for the harness: **Sharp's `clean_ok` output compiles by construction**. The dangerous `clean_wrong` outcome class — a syntactically valid but semantically broken merge — should be a near-empty cell in the differential table for TypeScript and Rust scenarios. If it isn't, either the verification gate has a hole or the validator is testing something the compiler can't see (legitimately interesting), and the per-scenario log should make that distinction obvious.

#### Tier 2 — Automatic downstream-oracle resolution

When Sharp's semantic merge genuinely cannot pick between two candidate resolutions, it consults the repository's other in-development branches as a downstream oracle. This is **automatic**, not a fixture-author opt-in: if the repository has additional branches reachable from the same parent, Sharp uses them. The principle: code on other branches is implicit ground truth about how the codebase is actually evolving; a candidate merge that composes cleanly with that evolution is the right one.

For the test harness, fixtures may optionally provide additional branches as `branch_c/`, `branch_d/`, … in the scenario directory. They are **not** merge inputs and **not** declared in `meta.yaml` as oracles per scenario — the harness simply makes any such branch available to Sharp's oracle path the way a real repository would. Sharp picks the candidate whose post-merge tree introduces zero new conflicts when 3-way-merged against the oracle branches.

If no extra branches are provided, Tier 2 is skipped and Sharp falls through to Tier 3.

#### Tier 3 — Structured dilemma returned to the agent

If neither deterministic semantic merge nor the oracle path can pick a winner, Sharp does **not** silently pick one and does **not** emit textual conflict markers. It produces a structured `dilemma` describing the disagreement: which AST nodes are in tension, what the candidate resolutions are, what the oracle branches said (if anything), and what the agent would need to know to decide. This is returned to the calling agent harness as a first-class outcome.

The expectation is that Tier 3 fires rarely in practice. When it does, the agent has enough information to make a real decision rather than guess at conflict markers. If Tier 3 fires often on a category of scenarios, that is a signal to strengthen the semantic model upstream — not to add ranking knobs downstream.

#### Fixture implications

- `meta.yaml` gets no scoring fields. The full schema stays as in §5.
- `expected/` is the primary source of truth for a single-canonical-answer scenario.
- `validator.ts` remains the escape hatch for scenarios where multiple trees are acceptable but the harness can verify correctness behaviourally.
- `expected_sharp_outcome: dilemma` is a legitimate target for scenarios specifically designed to exercise Tier 3. They should be rare in the corpus and each one should carry a `notes:` paragraph explaining why no oracle could resolve it.

## 7. Test Runner Mechanics

### Isolation

Every scenario runs in a fresh temporary directory created via `mktemp -d` (or `tempfile.TemporaryDirectory` in Python). The directory is deleted after the run. Specifically:

- `$TMPDIR/git-<scenario-id>/` holds the ephemeral git working tree, its bare-remote sibling, and the per-scenario `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM` overrides so the user's git config can never leak in.
- `$TMPDIR/sharp-<scenario-id>/` holds the Sharp client workspace.
- The Sharp server runs as a child process of the harness, bound to a port chosen at runtime, with `--data-dir $TMPDIR/sharp-server-<scenario-id>` and a Postgres schema named `sharp_test_<scenario-id>` that is `DROP SCHEMA … CASCADE`'d on teardown.

Determinism levers applied to both lanes:

- `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_AUTHOR_DATE`, `GIT_COMMITTER_*` pinned to fixed values so commit SHAs are reproducible across runs.
- `LANG=C`, `LC_ALL=C`, `TZ=UTC` to neutralize locale-dependent diffs and timestamps.
- `core.autocrlf=false`, `core.symlinks=true`, `core.ignorecase=false` — explicit overrides of common foot-gun defaults.

### No remote dependency

The harness never reaches the network. Where a git operation conceptually needs a remote (e.g., reproducing a "PR merge" workflow), the remote is a **local bare repository** at `$TMPDIR/git-<id>/remote.git`. Push and fetch go file-to-file over the local filesystem.

The Sharp lane has no remote in the GitHub sense at all; the ephemeral Sharp server _is_ the only data path.

### Tooling

- **Git binary**: the user's installed `git`. The harness records `git --version` in the report so results are reproducible against a stated baseline.
- **Sharp binary**: built from the current working tree at the start of each harness run.
- **Postgres**: required for the Sharp lane. We adopt the **container-based pattern already in use across superfield repos** (see `superfield/template/docker-compose.yml` and `superfield/template/.github/workflows/meta-pg-container-harness.yml`):
  1. **Local development** — `postgres:16-alpine` via `docker compose`, with a healthcheck and a per-scenario schema created/dropped by the harness against the long-running container.
  2. **CI** — same `postgres:16-alpine` image, on the self-hosted `ci-runner` runner pattern. A meta sanity-check workflow (mirroring `meta-pg-container-harness`) validates the PG deployment path before the differential suite runs, so a broken PG harness fails fast and visibly rather than corrupting suite results.
  3. **Connection string** — `SHARP_TEST_PG_DSN` is honored if set (developer override); otherwise the harness brings up the default container itself.

  No `pg_tmp`, no two-mode complexity. The superfield-wide pattern is the path of least resistance and the team already knows how to debug it.

### Per-scenario sequence

For each scenario, the harness performs the same logical steps in both lanes:

1. Materialize `base/` into a working tree, commit it as the root.
2. Branch off `branch_a`, replace the working tree with `branch_a/`, commit.
3. Return to root, branch off `branch_b`, replace the working tree with `branch_b/`, commit.
4. Attempt to merge `branch_b` into `branch_a` (or the lane's equivalent operation).
5. Classify the outcome. If a merged tree was produced, compare against `expected/` and run `validator.ts` if present.
6. Tear down the lane.

The scenario passes overall if Sharp's outcome matches the scenario's `expected_sharp_outcome`. The git lane's outcome is recorded for the differential report but does not gate the test.

## 8. Initial Corpus Categories

The first wave of scenarios targets the well-known weak spots of three-way text merge. Each category gets at least 5 scenarios at corpus seed, growing from there.

**Languages.** The seed corpus covers **TypeScript** and **Rust**, the two languages superfield uses internally. Every category below has at least one TypeScript scenario and one Rust scenario before the corpus is considered complete for that category. Other languages (Python, Go) can be added later but are not in the seed.

The two-language requirement is deliberate: it keeps the semantic layer honest (no accidental Python-shaped or single-language assumptions) and matches the stack we will ship Sharp into. TypeScript exercises module/import structure, type narrowing, structural-typing renames, and the JSX/TSX tree quirks Tree-sitter handles. Rust exercises ownership-affecting refactors, trait-impl reorganization, `use` rewrites, and macro boundaries.

| Category            | Description                                                                                  | Why git fails                                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `refactor`          | Rename / move / signature change on one branch, edits to call sites or imports on the other. | Text merge applies the rename to declarations but not to the parallel edits' references. `clean_wrong`.         |
| `reorder`           | Both branches add functions, imports, or list entries in the same region.                    | Text merge produces overlapping hunks → `conflict`.                                                             |
| `format`            | One branch reformats a region (formatter run); the other edits inside it.                    | Whitespace and line breaks differ in every line → `conflict`.                                                   |
| `move_edit`         | File moved in one branch, edited in the other.                                               | git's rename detection is heuristic and fails on near-rewrites → silent loss of edits or `conflict`.            |
| `delete_edit`       | File deleted in one branch, edited in the other.                                             | git surfaces this as `conflict`; the correct outcome usually requires human judgment. Sharp must encode policy. |
| `import_merge`      | Both branches add imports / `use` / `require` lines.                                         | Different positions or alphabetization rules → `conflict` or duplicates.                                        |
| `cross_file_rename` | Symbol renamed in branch A across many files; branch B introduces a new use of the old name. | git rename-detects file moves, not symbol renames. Silent runtime break.                                        |
| `whitespace_only`   | One branch's only change is whitespace; the other edits the same lines.                      | git often surfaces these as conflicts despite the absence of semantic disagreement.                             |

Scenarios live under `tests/scenarios/<category>/<name>/` so the categorization is also the on-disk layout.

## 9. Reporting

After a run, the harness emits:

- **Console summary** — one line per scenario: `category/name git=<outcome> sharp=<outcome> [PASS|FAIL]`.
- **Differential table** — a 4×4 contingency of `git_outcome × sharp_outcome` aggregated across the corpus. The interesting cells are `(git=conflict, sharp=clean_ok)` and `(git=clean_wrong, sharp=clean_ok)`; those are where Sharp earns its keep.
- **Per-scenario artifacts** — for any scenario where Sharp's outcome did not match `expected_sharp_outcome`, the harness writes the merged tree, the expected tree, and the diff between them to `tests/_failures/<scenario-id>/` for inspection.
- **JSON report** — machine-readable run result, for CI dashboards and historical tracking.

A scenario's status flips green the moment Sharp produces the expected outcome. Adding a new failing scenario is a normal contribution: it documents a case Sharp doesn't yet handle and turns into a green test once it does.

## 10. TDD Workflow

The harness is intended to be the primary loop for Sharp development on merge correctness:

1. **Identify a failure mode.** Often via reading bug reports, examining real merge conflicts in OSS history, or watching agent harnesses fail.
2. **Author a fixture.** Reduce the failure to a minimal `base/` + `branch_a/` + `branch_b/` triple under `tests/scenarios/<category>/<name>/`. Set `expected_sharp_outcome: clean_ok` (or whatever is appropriate). Author `validator.ts` if the merge has multiple acceptable forms.
3. **Run the harness.** Confirm `git` produces the documented failure. Confirm Sharp also fails (initially). The new test is now red.
4. **Implement.** Drive Sharp's client/server/semantic-layer code until the test goes green. The harness's fast feedback loop on a single scenario (`./run-tests.sh --filter refactor/rename_function_with_callsite_edit`) is the inner-loop interface.
5. **Don't regress.** The full corpus must pass on every Sharp PR.

## 11. Phased Delivery

The harness is built before Sharp can resolve any merges, so it must be useful immediately on `git` alone.

1. **Phase 1 — Git baseline only.** Harness, fixture format, isolation primitives, outcome classification, and reporting. The Sharp lane is stubbed (always emits `error`). Goal: assemble the seed corpus (≥40 scenarios across the §8 categories) and confirm the documented `expected_git_outcome` for each. This is a useful artifact in itself: a curated catalogue of what `git` cannot do.
2. **Phase 2 — Sharp lane scaffolding.** Ephemeral Sharp-server-in-tmpdir, Postgres schema lifecycle, the four primitive operations the lane needs (snapshot, branch, commit, merge). Sharp's merge in Phase 2 is allowed to be a thin wrapper around `git merge` — this proves the lane plumbing works without claiming any semantic improvement.
3. **Phase 3 — Semantic merge under TDD.** Drive Sharp's semantic layer (Tree-sitter ASTs, symbol-aware diff, rename-aware merge) using the corpus as the pacing mechanism. Each scenario that flips green is a release note.
4. **Phase 4 — Corpus growth.** Mine real-world merge conflicts from OSS history (post-merge revert commits, "bad merge" follow-up commits) and reduce them to fixtures. Aim for hundreds of scenarios, not dozens.

## 12. Repository Layout

```
sharp/
├── docs/
│   └── test-plan.md                       # this file
├── tests/
│   ├── harness/                           # the runner itself
│   │   ├── run.py                         # entry point
│   │   ├── git_lane.py
│   │   ├── sharp_lane.py
│   │   ├── classify.py
│   │   └── report.py
│   ├── scenarios/
│   │   ├── refactor/
│   │   ├── reorder/
│   │   ├── format/
│   │   ├── move_edit/
│   │   ├── delete_edit/
│   │   ├── import_merge/
│   │   ├── cross_file_rename/
│   │   └── whitespace_only/
│   └── _failures/                         # gitignored; written on red runs
└── run-tests.sh                           # convenience wrapper
```

Implementation language for the harness is open — Python is the path-of-least-resistance choice (subprocess, tempfile, yaml are all stdlib) and is recommended unless there's a strong reason otherwise.

## 13. Open Questions

- **Validator wrappers per language.** TypeScript scenarios will commonly want `bun test` or `vitest run`; Rust scenarios will want `cargo test` or `cargo build`. The harness should ship stock wrapper scripts (`validators/ts.sh`, `validators/rust.sh`) so each fixture doesn't reinvent them, while `validator.ts` remains the escape hatch for unusual cases.
- **Dilemma format.** The exact shape of the structured `dilemma` payload Sharp returns to a caller (involved AST nodes, candidate resolutions, oracle results consulted) needs a concrete schema. This blocks Phase 3 work but not Phase 1 / 2.
- **Mining real-world conflicts (Phase 4) without polluting the corpus with project-specific noise.** Need a reduction methodology — likely some combination of dependency stripping, name anonymization, and minimum-failing-subset selection — before scale-up. Real-world history naturally provides downstream branches (the post-merge fix-up commits) that can be projected as `branch_c/` etc. for Tier 2 oracle exercise.

### Resolved (recorded for posterity)

- **Postgres provisioning** — adopt the superfield-wide `postgres:16-alpine` + docker compose pattern (§7), with the meta sanity-check workflow used in `template`. No `pg_tmp`, no two-mode fork.
- **Seed-corpus languages** — TypeScript and Rust, matching the superfield internal stack (§8).
- **Ambiguous-merge handling** — no scoring system. Three tiers (§6.1): deterministic semantic merge, automatic downstream-oracle when the repo has other branches, structured `dilemma` returned to the calling agent if both fail. Tier 3 is expected to be rare; if it isn't, that's a signal to strengthen the semantic model upstream rather than add ranking knobs.
