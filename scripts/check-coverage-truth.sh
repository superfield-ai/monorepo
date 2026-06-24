#!/usr/bin/env bash
# check-coverage-truth.sh — executed-coverage truth-table validator (issue #759).
#
# PURPOSE
#   Validate coverage-truth.toml against reality so a green CI check can never
#   masquerade as "tested". A green check only proves a unit *compiled*; this
#   validator asserts the manifest's recorded compiled / migrated / EXECUTED
#   inventory matches what CI actually does, and that the nexum embedder
#   integration suite is recorded as tests_executed_in_ci > 0 — the
#   embedder-coverage.yml job (issue #760) now runs it for real, closing the
#   zero-executed gap; this assertion guards against regressing back to 0.
#
# WHAT IT ENFORCES (exit non-zero on any divergence)
#   1. Manifest parses as valid TOML and has [meta] with schema_version (int)
#      and generated_by (string).
#   2. Exactly one [[unit]] row per directory under crates/* and packages/* —
#      no missing rows, no stale rows for paths that no longer exist.
#   3. Every row has required fields with correct types; path is unique and on
#      disk; kind matches path[0] ("crate" | "package").
#   4. Reality cross-checks (derived from the workflows + filesystem, not the
#      manifest itself):
#        - compiled_in_ci: every crate true (rust.yml builds the workspace);
#          every package true (build.yml typechecks the workspace).
#        - migrated_in_ci: true iff the unit owns migrations ci-migrate.yml
#          applies (parsed from .github/workflows/ci-migrate.yml paths).
#        - tests_executed_in_ci truthiness: 0 iff no CI job executes a suite for
#          this unit, >0 iff one does. A crate is >0 iff embedder-coverage.yml
#          runs it (`cargo test -p <crate>`, parsed from the workflow); every
#          other crate has no cargo-test job -> 0. Packages are >0 iff they have
#          *.test.ts under tests/unit or tests/integration (the test-unit /
#          test-integration globs).
#   5. crates/nexum is recorded tests_executed_in_ci > 0 AND embedder-coverage
#      .yml actually executes it (explicit assertion — the gap is now closed).
#
# CANONICAL DOCS
#   docs/prd.md, docs/adr-embedding-model.md
#   Schema: header comment of coverage-truth.toml (repo root).
#
# CI WIRING
#   Run as a workflow step on pull_request -> main in the lightweight
#   coverage-truth job of .github/workflows/build.yml (no Postgres/weights).
#   Per #759 scope it is NOT a required branch-protection context.
#
# USAGE
#   scripts/check-coverage-truth.sh [path/to/coverage-truth.toml]
#   Exits 0 when the manifest conforms to reality; non-zero otherwise.
#   The optional argument lets the self-test point the check at a tampered copy.

set -euo pipefail

# Resolve repo root regardless of where the script is invoked from.
if ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" && [ -n "$ROOT" ]; then
  :
else
  ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fi
cd "$ROOT"

MANIFEST="${1:-coverage-truth.toml}"

if [ ! -f "$MANIFEST" ]; then
  echo "FAIL  manifest not found: $MANIFEST" >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "FAIL  python3 is required to validate $MANIFEST" >&2
  exit 1
fi

# All real validation happens in Python (TOML parse + reality cross-checks).
# tomllib is stdlib on Python >= 3.11; tomli is the importable backport for
# older Pythons. The validator hard-fails if neither is importable — a missing
# parser must NOT silently pass (that would defeat the whole point).
ROOT="$ROOT" MANIFEST="$MANIFEST" python3 - <<'PY'
import os
import re
import sys

ROOT = os.environ["ROOT"]
MANIFEST = os.environ["MANIFEST"]

try:
    import tomllib as toml_mod  # Python >= 3.11
except ModuleNotFoundError:
    try:
        import tomli as toml_mod  # backport for Python < 3.11
    except ModuleNotFoundError:
        sys.stderr.write(
            "FAIL  no TOML parser available (need stdlib tomllib on Python>=3.11 "
            "or the `tomli` backport). Cannot validate the manifest.\n"
        )
        sys.exit(2)

errors = []


def err(msg):
    errors.append(msg)


# ── Parse the manifest ────────────────────────────────────────────────────────
try:
    with open(MANIFEST, "rb") as fh:
        data = toml_mod.load(fh)
except Exception as exc:  # noqa: BLE001
    sys.stderr.write(f"FAIL  {MANIFEST} is not valid TOML: {exc}\n")
    sys.exit(2)

# ── [meta] table ──────────────────────────────────────────────────────────────
meta = data.get("meta")
if not isinstance(meta, dict):
    err("[meta] table is missing")
else:
    if not isinstance(meta.get("schema_version"), int) or isinstance(
        meta.get("schema_version"), bool
    ):
        err("[meta].schema_version must be an integer")
    if not isinstance(meta.get("generated_by"), str):
        err("[meta].generated_by must be a string")

units = data.get("unit")
if not isinstance(units, list) or not units:
    sys.stderr.write("FAIL  no [[unit]] rows found in manifest\n")
    sys.exit(2)


# ── Derive reality from the repo (filesystem + workflows) ─────────────────────
def list_dirs(parent):
    base = os.path.join(ROOT, parent)
    if not os.path.isdir(base):
        return []
    return sorted(
        f"{parent}/{name}"
        for name in os.listdir(base)
        if os.path.isdir(os.path.join(base, name))
    )


disk_crates = list_dirs("crates")
disk_packages = list_dirs("packages")
disk_units = set(disk_crates) | set(disk_packages)

# migrated_in_ci reality: paths ci-migrate.yml lists under its migration globs.
migrate_yml = os.path.join(ROOT, ".github/workflows/ci-migrate.yml")
migrated_paths = set()
if os.path.isfile(migrate_yml):
    with open(migrate_yml, "r", encoding="utf-8") as fh:
        migrate_text = fh.read()
    # Match quoted path globs like "crates/nexum/migrations/**" or
    # "crates/sf-auth/src/migrations/**" or "packages/db/migrations/**" and map
    # them back to their owning crates/* or packages/* unit directory.
    for m in re.finditer(
        r'"((?:crates|packages)/[^"/]+)/[^"]*migrations?/', migrate_text
    ):
        migrated_paths.add(m.group(1))
else:
    err(".github/workflows/ci-migrate.yml not found; cannot derive migrated_in_ci")

# crate-execution reality: the embedder-coverage job (issue #760) is the one
# workflow that actually RUNS a crate's tests (the real-embedder proof). Derive
# which crates it executes by scanning its `cargo test -p <crate>` invocations,
# so the manifest's tests_executed_in_ci for crates is checked against the
# workflow, not a hardcoded "every crate is 0". Any crate NOT named here still
# has no executing job -> reality 0 (the regression guard for the rest).
embedder_yml = os.path.join(ROOT, ".github/workflows/embedder-coverage.yml")
crate_executes_paths = set()
if os.path.isfile(embedder_yml):
    with open(embedder_yml, "r", encoding="utf-8") as fh:
        embedder_text = fh.read()
    # Match `cargo test -p <crate>` (the crate package name maps 1:1 to its
    # crates/<crate> directory for the workspace crates this job runs).
    for m in re.finditer(r"cargo test\s+-p\s+([A-Za-z0-9_-]+)", embedder_text):
        crate = m.group(1)
        candidate = f"crates/{crate}"
        if os.path.isdir(os.path.join(ROOT, candidate)):
            crate_executes_paths.add(candidate)


def package_executes(path):
    """True iff a package has a suite the test-unit/test-integration globs run.

    Globs: packages/*/tests/unit and packages/*/tests/integration. A package
    qualifies iff at least one *.test.ts exists directly under either dir.
    """
    for sub in ("tests/unit", "tests/integration"):
        d = os.path.join(ROOT, path, sub)
        if os.path.isdir(d):
            for name in os.listdir(d):
                if name.endswith(".test.ts"):
                    return True
    return False


# ── Per-row structural + reality validation ──────────────────────────────────
REQUIRED = {
    "path": str,
    "kind": str,
    "compiled_in_ci": bool,
    "migrated_in_ci": bool,
    "tests_executed_in_ci": int,
}

seen_paths = set()
manifest_paths = set()

for idx, row in enumerate(units):
    tag = f"[[unit]] #{idx}"
    if not isinstance(row, dict):
        err(f"{tag}: not a table")
        continue

    # Required fields + types (bool is a subclass of int — guard explicitly).
    ok = True
    for field, typ in REQUIRED.items():
        val = row.get(field)
        if field == "tests_executed_in_ci":
            if not isinstance(val, int) or isinstance(val, bool):
                err(f"{tag}: {field} must be an integer")
                ok = False
        elif field in ("compiled_in_ci", "migrated_in_ci"):
            if not isinstance(val, bool):
                err(f"{tag}: {field} must be a bool")
                ok = False
        else:
            if not isinstance(val, typ) or val == "":
                err(f"{tag}: {field} must be a non-empty {typ.__name__}")
                ok = False
    if not ok:
        continue

    path = row["path"]
    tag = f"[[unit]] {path}"
    manifest_paths.add(path)

    if path in seen_paths:
        err(f"{tag}: duplicate path (primary key must be unique)")
        continue
    seen_paths.add(path)

    top = path.split("/", 1)[0]
    expected_kind = {"crates": "crate", "packages": "package"}.get(top)
    if expected_kind is None:
        err(f"{tag}: path must be under crates/ or packages/")
        continue
    if row["kind"] != expected_kind:
        err(f"{tag}: kind={row['kind']!r} but path implies {expected_kind!r}")

    if path not in disk_units:
        err(f"{tag}: path does not exist on disk (stale row?)")
        continue

    teic = row["tests_executed_in_ci"]
    if teic < 0:
        err(f"{tag}: tests_executed_in_ci must be >= 0")

    # compiled_in_ci reality: every crate and every package is compiled in CI.
    if row["compiled_in_ci"] is not True:
        detail = (
            "rust.yml builds the workspace"
            if top == "crates"
            else "build.yml typechecks the workspace"
        )
        err(
            f"{tag}: compiled_in_ci={row['compiled_in_ci']} but reality is True "
            f"({detail})"
        )

    # migrated_in_ci reality.
    real_migrated = path in migrated_paths
    if row["migrated_in_ci"] != real_migrated:
        err(
            f"{tag}: migrated_in_ci={row['migrated_in_ci']} but ci-migrate.yml "
            f"reality is {real_migrated}"
        )

    # tests_executed_in_ci truthiness reality.
    if top == "crates":
        # A crate executes iff a CI workflow runs its tests. The only such
        # workflow is embedder-coverage.yml (issue #760), whose `cargo test -p
        # <crate>` invocations are parsed above. Every other crate has no
        # executing job -> 0 (the regression guard for the rest).
        real_executes = path in crate_executes_paths
    else:
        real_executes = package_executes(path)

    if real_executes and teic == 0:
        err(
            f"{tag}: tests_executed_in_ci=0 but CI DOES execute a suite for this "
            f"unit (under-claim — the floor must be >0)"
        )
    if (not real_executes) and teic > 0:
        where = (
            "no cargo-test job runs this crate's tests"
            if top == "crates"
            else "no *.test.ts under tests/unit or tests/integration is executed"
        )
        err(
            f"{tag}: tests_executed_in_ci={teic} but CI executes NOTHING for this "
            f"unit ({where} — over-claim)"
        )

# ── Completeness: one row per disk unit, no missing, no stale ────────────────
missing = sorted(disk_units - manifest_paths)
for p in missing:
    err(f"missing manifest row for on-disk unit: {p}")

stale = sorted(manifest_paths - disk_units)
for p in stale:
    err(f"manifest row for non-existent path (stale): {p}")

# ── Explicit embedder assertion (issue #760: the gap is now CLOSED) ──────────
# The embedder-coverage job (#760) runs the nexum embedder for real (pgvector +
# governed weights + `cargo test -p nexum ... --include-ignored`). The manifest
# MUST now record crates/nexum as tests_executed_in_ci > 0 AND embedder-coverage
# .yml must actually execute it — this assertion fails LOUDLY if either the
# manifest under-claims (back to the 0 gap) or the job stops running nexum.
nexum = next(
    (r for r in units if isinstance(r, dict) and r.get("path") == "crates/nexum"),
    None,
)
if nexum is None:
    err("required row crates/nexum is missing (embedder coverage guard)")
else:
    teic_nexum = nexum.get("tests_executed_in_ci")
    if not isinstance(teic_nexum, int) or isinstance(teic_nexum, bool) or teic_nexum <= 0:
        err(
            "crates/nexum must record tests_executed_in_ci>0 — the embedder is "
            "now run for real by embedder-coverage.yml (issue #760) — but found "
            f"{teic_nexum!r}"
        )
    if "crates/nexum" not in crate_executes_paths:
        err(
            "embedder-coverage.yml must execute the nexum embedder "
            "(`cargo test -p nexum ...`) — the manifest claims crates/nexum is "
            "executed but no such invocation was found in the workflow"
        )

# ── Report ───────────────────────────────────────────────────────────────────
if errors:
    sys.stderr.write(f"FAIL  {len(errors)} coverage-truth violation(s):\n")
    for e in errors:
        sys.stderr.write(f"  - {e}\n")
    sys.exit(1)

n_crates = sum(1 for r in units if r.get("kind") == "crate")
n_packages = sum(1 for r in units if r.get("kind") == "package")
print(
    f"PASS  {MANIFEST}: {len(units)} units validated against reality "
    f"({n_crates} crates, {n_packages} packages); "
    f"crates/nexum tests_executed_in_ci>0 (embedder run for real by "
    f"embedder-coverage.yml) guard intact."
)
PY
