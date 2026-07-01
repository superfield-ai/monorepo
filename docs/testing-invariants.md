# Executed-Coverage Testing Invariants

A green CI signal means "nobody objected," not "the code ran." A governed
subsystem (an in-process embedding model, fixed by an Accepted ADR) once merged
**green** with **zero executed CI coverage** — it only broke when the first job
to actually _use_ it failed at runtime. Every gate trusted the green signal as
proof of "tested," but nothing verified the code had ever executed, and the
tests were written to **skip silently (green)** when their dependencies (a DB,
model weights) were absent instead of **failing loudly (red)**. The four
invariants below exist so that incident cannot recur. They are the canonical
policy recorded in `_shared/test-coverage-policy.md` and enforced across the
loop's gates; this document and `.agents/agent-warnings.md` make them permanent
in-repo, guarded by the `Doc conformance` job.

## 1. Loud-skip, never silent-skip

A test that needs an external resource (a DB, model weights, network, an API
key) must **fail in CI when the resource is absent**, not skip. A test that
self-disables — `#[ignore]`, `t.Skip()`, `@Disabled`, `skipif(not os.getenv(...))`,
or an early `return`/`None`/`nil` from a fixture when the resource is missing —
produces a false green: it is counted as coverage but never runs.

> **Sanctioned exception.** The Layer-3 live smoke suite described in
> [testing.md](testing.md) (`liveDescribe`/`liveIt`, gated on
> `SUPERFIELD_LIVE_AGENTS`) intentionally `describe.skip`s when the env var is
> unset. This is permitted because that suite is a manual/pre-release safety
> net that is **explicitly not counted as coverage** — the behaviours it
> touches are already covered by Layers 1 and 2, which run for real on every
> PR. It is the sole sanctioned skip; every other test must loud-skip.

## 2. Exit 0 ≠ tested

A command that passes when **zero tests ran**, or when every test
skipped/ignored, proves nothing was exercised. Require evidence the diff was
_executed_ — **>0 tests collected and run**. Pair this with a runner convention
that makes "no tests collected" red:

- Rust: `cargo nextest run --no-tests=fail` (or assert a nonzero test count)
- JS/TS: `vitest --passWithNoTests=false`, `jest --passWithNoTests=false`
- Python: `pytest --strict-markers` and fail on `collected 0 items`
- Go: `go test ./...` over packages that actually contain `_test.go`

> **Current state (TS):** the vitest jobs
> (`.github/workflows/test-unit.yml`, `test-integration.yml`) do **not** pass
> `--passWithNoTests=false` explicitly; they rely on vitest's default, which
> already fails a run that collects zero test files. The flag above documents
> the intended guarantee, not a currently-passed argument.

The coverage-delta gate (`scripts/check-coverage-delta.sh`) enforces this for
each **Rust crate**: touching a `crates/<dir>` path requires >0 of that crate's
tests to run. It maps only `crates/*` paths to Cargo packages; TS `packages/*`,
docs, and workflow changes are not gated by this script.

## 3. Runtime behaviour needs an executed-in-CI assertion

Doc-grep, lint, type-check, format, and compile are **not** coverage for runtime
behaviour (a model, an endpoint, a migration, a background job). At least one
check must _execute the behaviour and assert on it_, in a CI job that actually
runs on the PR.

## 4. Required checks must cover the languages present

If a repo has Rust (or Go, or any compiled/tested language), a
**test-executing** job for that language must be in the required
branch-protection contexts — not just a build/compile job. "Compiles but never
runs tests" is a coverage hole. The subsystem-test-job-presence guardrail
(`scripts/check-test-job-presence.sh`, issue #767) enforces this seam, using
`coverage-truth.toml` and `scripts/check-coverage-truth.sh` as the
unit-to-test-job mapping source.

## The decisive question

For any test claimed as coverage, ask:

> **Would this test still execute and assert in a clean CI runner that has no
> DB, no model weights, no network, and no cached credentials?**

If the honest answer is "no — it would skip or no-op," it is not coverage. It is
a silent skip, and it must be made to fail loudly or have its resource wired
into CI.
