# Sharp Differential Test Harness

This is the test harness that drives Sharp's development. It runs the same code-change scenarios through both `git` and Sharp, classifies the outcomes (`clean_ok` / `clean_wrong` / `conflict` / `dilemma` / `error`), and produces a (git × sharp) contingency table. Sharp wins are scenarios where git produced `conflict` or `clean_wrong` and Sharp produced `clean_ok`.

The full design is in [`../docs/test-plan.md`](../docs/test-plan.md). This README is operational.

## Running

```bash
# Full corpus, both lanes (Sharp lane is currently a stub returning `error`).
bun run test:differential

# Only the git lane (no docker required, no Sharp lane).
bun tests/harness/run.ts --only-git

# Filter by id substring.
bun tests/harness/run.ts --filter refactor

# Write a machine-readable JSON report.
bun tests/harness/run.ts --json /tmp/report.json

# Keep tmpdirs on failure so you can inspect the merged trees.
bun tests/harness/run.ts --keep-failures
```

The runner starts an ephemeral `postgres:16` container if docker is available and the Sharp lane is active. Override with `SHARP_TEST_PG_DSN` to point at an externally-managed Postgres instead. Set `SHARP_TEST_SKIP_PG=1` to skip the Postgres canary entirely (useful for the harness's own unit tests).

## Layout

```
tests/
├── harness/                        Runner internals
│   ├── run.ts                      CLI entrypoint
│   ├── types.ts                    Outcome, LaneResult, Scenario
│   ├── pg-container.ts             DIY Testcontainers for postgres:16
│   ├── postgres.ts                 Connection + scratch schema lifecycle
│   ├── postgres.test.ts            Postgres canary (auto-skips w/o docker)
│   ├── fixture/
│   │   ├── schema.ts               Zod schema for meta.yaml
│   │   ├── loader.ts               Walks tests/scenarios/, returns Scenario[]
│   │   └── loader.test.ts
│   ├── isolation/
│   │   ├── tmpdir.ts               Per-scenario tmpdir lifecycle
│   │   ├── env.ts                  Pinned env (no developer config bleed)
│   │   └── proc.ts                 Subprocess helper with timeout
│   ├── lanes/
│   │   ├── git/index.ts            Git lane
│   │   └── sharp/index.ts          Sharp lane (STUB until v1)
│   ├── classify/
│   │   ├── treeCompare.ts          Recursive tree compare
│   │   ├── conflictMarkers.ts      <<<<<<<-marker scanner
│   │   └── index.ts                Final classifier
│   ├── validators/
│   │   └── runner.ts               Runs validator scripts in the merged tree
│   └── report/
│       └── index.ts                Console + contingency + JSON + failure dumps
├── validators/
│   ├── ts.ts                       Stock TypeScript validator (tsc --noEmit)
│   └── rust.ts                     Stock Rust validator (cargo check)
└── scenarios/
    └── <category>/<language>/<name>/
        ├── meta.yaml
        ├── base/
        ├── branch_a/
        ├── branch_b/
        ├── expected/               (optional)
        ├── validator.ts            (optional fixture-local validator)
        └── branch_c/, branch_d/, … (optional Tier 2 oracle branches)
```

## Failure artifacts

When a scenario fails, the harness dumps the merged trees, expected tree (if any), and stdout/stderr to `$TMPDIR/sharp-failures-<random>/<scenario-id>/`. The path is printed at the end of the run. **Nothing is ever written into the source tree.**

## CI

Three workflows in `.github/workflows/`:

- **quality-gate.yml** — lint, format check, typecheck, harness unit tests. No Postgres. Fast.
- **meta-pg-container-harness.yml** — runs only the Postgres canary. If this fails, the differential lane is broken.
- **test-differential.yml** — full corpus, both lanes. Currently RED by construction (Sharp lane is a stub). The artifact-upload step archives the JSON report for trend analysis.

All three use the standard superfield CI skeleton (self-hosted X64 runner + `ghcr.io/superfield-ai/ci-runner:latest` container).

## Authoring a scenario

See [`scenarios/README.md`](./scenarios/README.md).
