#!/usr/bin/env python3
"""skipped-required-contexts.py — list the required status contexts whose
producing workflow will NOT run for a given set of changed files (issue #788).

WHY THIS EXISTS
  `main` requires N strict status contexts (scripts/required-status-contexts.txt
  mirrors the live set). EVERY producing workflow path-ignores non-code changes
  (`paths-ignore: ["**/*.md", "docs/**", ...]` for the build family; `["**.md",
  "**.txt"]` for the Rust/embedder family). A pure docs-only PR therefore
  triggers NONE of those workflows, so none of the required contexts ever report
  and strict branch protection leaves the PR permanently BLOCKED with no admin
  override available to the autonomous loop (blocker #753).

  The fix is an always-on reporter workflow (no paths filter) that, for every PR,
  posts a skipped-SUCCESS commit status for each required context whose real job
  is NOT going to run for the PR's changed files. This script is the pure,
  self-testable decision core: given the changed files, it prints exactly those
  context names. The workflow turns each printed name into a `success` commit
  status on the PR head SHA.

WHY IT IS SAFE (no silent no-op / no masking)
  A context is printed ONLY when its producing workflow is SKIPPED for the
  changed files — i.e. the real job is NOT running, so there is nothing to mask.
  The skip decision is derived DIRECTLY from each workflow's own
  `on.pull_request.paths` / `paths-ignore` (read from the workflow file), so it
  stays correct for every diff shape:
    * docs-only   -> every required workflow path-ignores docs   -> all printed.
    * workflow-only-> only the build family also ignores `.github/workflows/**`,
                      so the Rust/embedder workflows still run and are NOT printed
                      (they report for real); the build-family contexts ARE
                      printed.
    * any code file-> the relevant workflows run and are NOT printed.
  On a PR that touches a real code file, every relevant workflow runs and this
  script prints nothing for it, so the real required jobs gate the PR.

WHY IT IS LIST-DRIVEN / TRIVIALLY EXTENSIBLE (issue #790)
  The required set is read from scripts/required-status-contexts.txt. Each
  context name is matched to the workflow job whose `name:` equals it (scanned
  from .github/workflows/*.yml), and that workflow's own trigger filter decides
  skip/run. Adding a future required context (e.g. #790's "Coverage truth") is a
  ONE-LINE append to required-status-contexts.txt — no plumbing here changes, and
  the new context automatically becomes docs/workflow-only satisfiable iff its
  producing workflow path-ignores those shapes (the "Coverage truth" job lives in
  build.yml, which ignores both docs and `.github/workflows/**`).

USAGE
  CHANGED_FILES="$(printf '%s\n' a.md b.md)" \
    python3 scripts/skipped-required-contexts.py
      Reads the newline-separated changed-file list from $CHANGED_FILES (or stdin
      if unset/empty) and prints, one per line, the required contexts to mark
      success.

  python3 scripts/skipped-required-contexts.py --validate
      Asserts every required context maps to exactly one workflow job with a
      pull_request trigger (loud, non-zero on drift); prints nothing on success.

Exit status: 0 on success; non-zero on a hard error (missing files, unparseable
workflow, or a --validate failure).
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path

try:
    import yaml
except ModuleNotFoundError:  # pragma: no cover - environment guard
    sys.stderr.write(
        "FAIL  PyYAML is required to run skipped-required-contexts.py "
        "(install pyyaml).\n"
    )
    sys.exit(2)


def repo_root() -> Path:
    env = os.environ.get("REPO_ROOT")
    if env:
        return Path(env)
    # Walk up until a .git is found; fall back to two levels up from this file.
    here = Path(__file__).resolve()
    for parent in [here.parent] + list(here.parents):
        if (parent / ".git").exists():
            return parent
    return here.parent.parent


def read_required_contexts(root: Path) -> list[str]:
    path = root / "scripts" / "required-status-contexts.txt"
    if not path.is_file():
        sys.stderr.write(f"FAIL  required-contexts file not found: {path}\n")
        sys.exit(2)
    contexts: list[str] = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        contexts.append(line)
    if not contexts:
        sys.stderr.write(f"FAIL  no contexts listed in {path}\n")
        sys.exit(2)
    return contexts


def pattern_to_regex(pat: str) -> re.Pattern[str]:
    """Convert a GitHub Actions filter pattern to an anchored regex.

    GitHub filter-pattern semantics (docs: "Workflow syntax / filter patterns"):
      *  matches zero+ characters but NOT the / separator
      ** matches zero+ characters INCLUDING /
      ?  matches a single character except /
    A leading "**/" is treated as "zero or more leading path segments", so
    "**/*.md" matches both "README.md" and "docs/a.md". This is intentionally at
    least as permissive as GitHub's engine for docs/text patterns, which keeps
    the skip decision conservative in the safe direction (a context is only ever
    printed when its workflow truly does not run).
    """
    out = ["^"]
    i = 0
    n = len(pat)
    while i < n:
        c = pat[i]
        if c == "*":
            if i + 1 < n and pat[i + 1] == "*":
                out.append(".*")
                i += 2
                # Absorb an optional following "/" so "**/" can match zero
                # segments (the ".*" already spans the slash).
                if i < n and pat[i] == "/":
                    i += 1
            else:
                out.append("[^/]*")
                i += 1
        elif c == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(c))
            i += 1
    out.append("$")
    return re.compile("".join(out))


def _pr_trigger(on_block) -> dict | None:
    """Return the pull_request trigger mapping, or None if absent/un-keyed."""
    if not isinstance(on_block, dict):
        return None
    pr = on_block.get("pull_request")
    if pr is None:
        return None
    if not isinstance(pr, dict):
        # `pull_request:` with no body == default (runs on all PRs, no filter).
        return {}
    return pr


def build_context_map(root: Path) -> dict[str, dict]:
    """Map each job `name:` to its workflow's pull_request trigger config.

    Returns { context_name: {"workflow": str, "paths": [...]|None,
    "paths_ignore": [...]|None} }. A context name that appears in more than one
    workflow job is flagged by storing the sentinel value "AMBIGUOUS".
    """
    wf_dir = root / ".github" / "workflows"
    mapping: dict[str, dict] = {}
    for wf in sorted(wf_dir.glob("*.yml")) + sorted(wf_dir.glob("*.yaml")):
        try:
            doc = yaml.safe_load(wf.read_text())
        except yaml.YAMLError as exc:  # pragma: no cover - loud parse failure
            sys.stderr.write(f"FAIL  cannot parse {wf}: {exc}\n")
            sys.exit(2)
        if not isinstance(doc, dict):
            continue
        # YAML parses the bare key `on` as the boolean True.
        on_block = doc.get("on", doc.get(True))
        pr = _pr_trigger(on_block)
        jobs = doc.get("jobs")
        if not isinstance(jobs, dict):
            continue
        for job_id, job in jobs.items():
            if not isinstance(job, dict):
                continue
            name = job.get("name", job_id)
            if not isinstance(name, str):
                continue
            entry = {
                "workflow": wf.name,
                "paths": (pr or {}).get("paths") if pr is not None else None,
                "paths_ignore": (pr or {}).get("paths-ignore")
                if pr is not None
                else None,
                "has_pr_trigger": pr is not None,
            }
            if name in mapping and mapping[name].get("workflow") != wf.name:
                mapping[name] = {"ambiguous": True}
            elif name not in mapping:
                mapping[name] = entry
    return mapping


def workflow_skipped(entry: dict, changed: list[str]) -> bool:
    """True iff the workflow's pull_request trigger does NOT fire for `changed`.

    - No pull_request trigger at all -> never fires on PRs -> treated as skipped
      only when there are no other ways to satisfy it; here we report it (a
      required context whose workflow has no PR trigger could never report on its
      own, so the bypass must cover it).
    - `paths` allowlist present  -> fires iff some changed file matches; skipped
      iff none match.
    - `paths-ignore` present      -> skipped iff every changed file matches an
      ignore pattern (and there is at least one changed file).
    - Neither filter              -> always fires -> never skipped.
    """
    if not changed:
        # No changed files detected. This should be impossible for a real PR, so
        # treat it as "we have no information" and DO NOT report — posting
        # all-success on a failed file-detection would mask every real job. The
        # caller (the workflow) hard-fails the collect step instead.
        return False
    if not entry.get("has_pr_trigger"):
        return True
    paths = entry.get("paths")
    if paths:
        regexes = [pattern_to_regex(p) for p in paths]
        # Skipped iff NO changed file matches the allowlist.
        return not any(any(r.match(f) for r in regexes) for f in changed)
    paths_ignore = entry.get("paths_ignore")
    if paths_ignore:
        regexes = [pattern_to_regex(p) for p in paths_ignore]
        # Skipped iff EVERY changed file matches an ignore pattern.
        return all(any(r.match(f) for r in regexes) for f in changed)
    # No path filter -> the workflow runs on every PR.
    return False


def read_changed_files() -> list[str]:
    raw = os.environ.get("CHANGED_FILES")
    if raw is None:
        # Env var unset -> read the list from stdin. An env var that is SET but
        # empty means "an empty changed-file set" (handled as no-report), NOT a
        # stdin fallback.
        raw = sys.stdin.read()
    files = [line.strip() for line in raw.splitlines()]
    return [f for f in files if f]


def cmd_validate(root: Path) -> int:
    contexts = read_required_contexts(root)
    mapping = build_context_map(root)
    problems: list[str] = []
    for ctx in contexts:
        entry = mapping.get(ctx)
        if entry is None:
            problems.append(
                f"  required context '{ctx}' maps to no workflow job `name:`"
            )
        elif entry.get("ambiguous"):
            problems.append(
                f"  required context '{ctx}' maps to >1 workflow (ambiguous)"
            )
        elif not entry.get("has_pr_trigger"):
            problems.append(
                f"  required context '{ctx}' (workflow {entry['workflow']}) "
                "has no pull_request trigger"
            )
    if problems:
        sys.stderr.write(
            "FAIL  required-status-contexts.txt is out of lockstep with the "
            "workflows:\n" + "\n".join(problems) + "\n"
        )
        return 1
    return 0


def cmd_list(root: Path) -> int:
    contexts = read_required_contexts(root)
    mapping = build_context_map(root)
    changed = read_changed_files()
    for ctx in contexts:
        entry = mapping.get(ctx)
        if entry is None or entry.get("ambiguous"):
            # Unknown / ambiguous mapping: do NOT post (never mask). Surface it
            # loudly on stderr so drift is visible; `--validate` makes it red.
            sys.stderr.write(
                f"WARN  required context '{ctx}' has no unambiguous producing "
                "workflow; not reporting a bypass status for it.\n"
            )
            continue
        if workflow_skipped(entry, changed):
            print(ctx)
    return 0


def main(argv: list[str]) -> int:
    root = repo_root()
    if "--validate" in argv:
        return cmd_validate(root)
    return cmd_list(root)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
