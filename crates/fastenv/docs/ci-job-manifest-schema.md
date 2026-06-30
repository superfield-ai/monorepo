# CI Job Manifest Schema (v1)

Canonical decision: [`docs/adr-ci-execution-manifest.md`](../../../docs/adr-ci-execution-manifest.md).
Invariants: [`docs/testing-invariants.md`](../../../docs/testing-invariants.md).
Types: [`crates/fastenv/src/manifest.rs`](../src/manifest.rs).

The manifest is the **spec** half of a CI workflow: the job graph, its
ordering, its gates, and an unambiguous, typed definition of what "tested"
means. FastENV executes it natively (the **substrate**); a gate validates it
(the **enforcement boundary**); GitHub Actions YAML, if needed, is a generated
**downstream emitter**. The schema therefore contains **no** GitHub-substrate
concepts — no `runs-on`, marketplace actions, `permissions:`, or contexts.

This module (issue #821) defines only the schema. Three decoupling seams ship
as compile-safe stubs so the downstream features can land in parallel against a
stable contract, each owning a **disjoint** file:

| Seam            | File                 | Owner | Role                                            |
| --------------- | -------------------- | ----- | ----------------------------------------------- |
| Executor        | `src/ci_executor.rs` | #822  | run the job graph on FastENV                    |
| GHA adapter     | `src/ci_import.rs`   | #823  | round-trip `.github/workflows/*.yml` ↔ manifest |
| Validation gate | `src/ci_gate.rs`     | #824  | enforce the four invariants + ci-taxonomy       |

## Top level — `CiManifest`

| Field              | Type    | Required           | Meaning                                     |
| ------------------ | ------- | ------------------ | ------------------------------------------- |
| `manifest_version` | `"v1"`  | yes                | schema version; unknown values are rejected |
| `name`             | string  | yes                | human-readable name of the job graph        |
| `jobs`             | `[Job]` | yes (may be empty) | the graph's nodes                           |

`CiManifest` uses `deny_unknown_fields`, so a leaked substrate key (e.g.
`runs-on`) fails to parse.

## `Job`

| Field           | Type           | Required | Meaning                                           |
| --------------- | -------------- | -------- | ------------------------------------------------- |
| `id`            | string         | yes      | unique id, referenced by other jobs' `needs`      |
| `description`   | string         | no       | human-readable description                        |
| `needs`         | `[string]`     | no       | dependency edges (a DAG) — the ordering primitive |
| `commands`      | `[Command]`    | no       | substrate-agnostic argv + env to run              |
| `test_contract` | `TestContract` | yes      | the typed "tested" contract                       |
| `gate`          | `Gate`         | no       | present iff the job's verdict gates the graph     |

## `Command`

`program` (string, required), `args` (`[string]`), `env` (string→string map,
deterministically ordered). No `uses:` marketplace action; no context injection.

## `TestContract` — the four invariants, as typed fields

The schema **represents** every invariant — including its forbidden state — so
that a non-compliant manifest can be described and then **rejected by the gate**
(#824). The schema does not itself enforce.

| Field                                                | Invariant                                         | Meaning                                                                                    |
| ---------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `min_executed_tests` (u32)                           | 2 — exit-0 ≠ tested                               | minimum tests that must be observed executed; gate rejects `0` for a job claiming coverage |
| `zero_tests_is_failure` (bool)                       | 2                                                 | whether collecting zero tests is hard-red (`--no-tests=fail`)                              |
| `on_missing_resource` (`fail_loud` \| `silent_skip`) | 1 — loud-skip never silent-skip                   | gate rejects `silent_skip`                                                                 |
| `required_resources` (`[ResourceRequirement]`)       | 1 & 3                                             | external resources (DB, model weights, network, API key)                                   |
| `asserts_runtime_behavior` (bool)                    | 3 — runtime behaviour needs an executed assertion | whether the job executes behaviour and asserts, vs. only compile/lint/doc-grep             |
| `languages` (`[Language]`)                           | 4 — required checks cover the languages present   | languages whose tests this job executes                                                    |

`ResourceKind`: `database`, `model_weights`, `network`, `api_key`, `other`.
`Language`: `rust`, `typescript`, `javascript`, `python`, `go`.
`MissingResourcePolicy`: `fail_loud`, `silent_skip`.

## `Gate`

`class` (`JobClass`) + `blocking` (bool, required ⇒ a required context vs.
advisory). `JobClass` mirrors the canonical CI taxonomy: `doc-correctness`,
`code-hygiene`, `feature-correctness`, `system-correctness`, `sanity-meta`,
`heavy`, `ignore`.

## Examples

[`examples/monorepo-ci.manifest.json`](examples/monorepo-ci.manifest.json) is a
golden example parsed by the fastenv unit-test job (`manifest::tests::golden_example_parses`),
so a malformed example fails CI.
