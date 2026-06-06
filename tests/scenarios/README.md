# Authoring a Scenario

Each scenario lives at `tests/scenarios/<category>/<language>/<name>/` and consists of:

```
meta.yaml             required
base/                 required: the common ancestor tree
branch_a/             required: tree after branch A's changes
branch_b/             required: tree after branch B's changes
expected/             optional: the canonical merged tree (for tree-compare)
validator.ts          optional: fixture-local validator (selected via meta.validator)
branch_c/, branch_d/, …  optional: Tier 2 oracle branches Sharp may consult
```

## Categories and languages

Categories (one of):

| Category            | The failure mode                                                |
| ------------------- | --------------------------------------------------------------- |
| `refactor`          | Rename / move / signature change with parallel call-site edits  |
| `reorder`           | Both branches add code in the same region                       |
| `format`            | One branch reformats; the other edits inside the reformat       |
| `move_edit`         | File moved on one branch, edited on the other                   |
| `delete_edit`       | File deleted on one branch, edited on the other                 |
| `import_merge`      | Both branches add imports / `use` lines                         |
| `cross_file_rename` | Symbol renamed on one branch; new use of old name on the other  |
| `whitespace_only`   | Whitespace-only change vs. semantic edit on the same lines      |

Languages: `ts` or `rust`. Every category needs at least one scenario per language before being considered complete.

## meta.yaml

```yaml
name: rename_function_with_callsite_edit       # snake_case, must match the directory name
category: refactor                              # must match <category>/ in the path
language: ts                                    # must match <language>/ in the path
summary: >
  One-paragraph description of the scenario, including why git fails.
expected_git_outcome: clean_wrong               # clean_ok | clean_wrong | conflict | error
expected_sharp_outcome: clean_ok                # clean_ok | clean_wrong | conflict | dilemma | error
validator: ts                                   # ts | rust | ./validator.ts | omitted
notes: |
  Optional rationale, especially useful for `dilemma` scenarios where the
  reasoning for why neither lane can pick is non-obvious.
```

`validator` selects how the merged tree is checked:

* `ts` → stock TypeScript validator (`tsc --noEmit`).
* `rust` → stock Rust validator (`cargo check`).
* `./validator.ts` (or any relative `.ts` path) → fixture-local script run with `bun`.
* omitted → no behavioral validation; rely on `expected/` tree comparison alone.

The harness runs validators with the same pinned environment that protects the git lane from leaking developer config.

## Designing the failure

Each scenario must produce its declared `expected_git_outcome`. The harness verifies this empirically — a fixture with a wrong claim fails fast in the git lane. Two recipes worth knowing:

* **`conflict`** — overlap the diffs textually. Both branches modifying the same lines in the same file is the simplest path. git emits `<<<<<<< / >>>>>>>` markers and exits non-zero.
* **`clean_wrong`** — the dangerous case. Make A's change touch one set of files and B's change touch *disjoint* files, but B's change references a symbol A renamed (or relies on a behavior A removed). Text merge succeeds with no markers; the validator catches the silent break.

A `dilemma` scenario is rare and deliberate: both candidate resolutions are semantically valid, and no oracle branch breaks the tie. Add `notes` explaining why.

## Tier 2 oracle branches

If your scenario explores how Sharp's downstream-oracle picks between candidates, add `branch_c/` (and optionally `branch_d/`, `branch_e/`, …). They are **not** merge inputs; the harness makes them available to Sharp's oracle path the way a real repository would. No `meta.yaml` declaration is needed — the loader discovers them by directory name.

## Running just your fixture

```bash
bun tests/harness/run.ts --filter <your-scenario-name>
bun tests/harness/run.ts --filter <your-scenario-name> --keep-failures
```

`--keep-failures` leaves the per-scenario tmpdir on disk if the run fails, so you can inspect the working tree git produced.

## Worked examples

Two reference scenarios demonstrate the canonical shapes:

* [`refactor/ts/rename_function_with_callsite_edit`](./refactor/ts/rename_function_with_callsite_edit/) — `clean_wrong`. Branch A renames `computeTotal → computeOrderTotal` across `lib.ts` and `main.ts`; branch B leaves those files alone but adds a fresh `report.ts` that imports the old name. text merge succeeds, `tsc` fails.
* [`reorder/ts/parallel_export_additions`](./reorder/ts/parallel_export_additions/) — `conflict`. Both branches add a new exported helper at the bottom of the same file; git can't choose an order.

## What does NOT belong in a fixture

* Network calls in validators or test code.
* `node_modules/`, `target/`, `dist/`, or other build outputs (the harness ignores these directories during tree compare, but they bloat the git history).
* Real secrets, customer data, or licensed code.
* `.git/` directories — the harness initializes its own.
