# Fixture corpus: `tier1/` (issue #871 scout, downstream #866)

> **Test fixture layout, not live-graded output.** Pinned by the dev-scout for
> the Tier-1 PR-grader phase (`docs/eval-design.md` sequencing item 3) so
> #866's per-grader fixture matrix, the `eval-tier1.yml` workflow, and this
> crate's `tests/tier1_graders.rs` all agree on where a recorded-artifact
> sample lives before the full feature is built.

## Layout convention

One subdirectory per grader spec'd in [`evals/graders/`](../../../../evals/graders/)
that has a deterministic no-model mode (see the enumeration below), each
holding at least:

- `passing.<ext>` — a recorded artifact the grader must verdict **PASS**.
- `regressed.<ext>` — a recorded artifact the grader must verdict **FAIL**
  (the regression the Tier-1 job exists to catch).

`<ext>` is whatever shape the grader's real input takes, not one canonical
format — `project-graph` grades rendered markdown, `compiling-candidate`
grades a JSON array of recorded `merge_result` payloads. This scout commits
only the two samples above per grader; #866 owns extending each pair into the
full matrix (including a `malformed.<ext>` sample proving "malformed artifact
→ FAIL without panic", per its acceptance criteria).

```
tests/fixtures/tier1/
  README.md                        ← you are here
  project-graph/
    passing.md                     ← mentions task/todo + all expected verbs
    regressed.md                   ← missing one expected verb
  compiling-candidate/
    passing.json                   ← one recorded merge_result payload
    regressed.json                 ← empty array (no merge_result recorded)
```

## Grader enumeration (no-model modes)

Per `evals/graders/*.md`, checked against `crates/sf-eval/src/graders.rs`:

| Grader                | Deterministic no-model mode?                                                                                       | Replay input this fixture corpus supplies                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `project-graph`       | Yes — structural fallback (`project_graph_pass`), keyword/verb match, parameterized by `expected_verbs`            | rendered project-graph markdown (`passing.md` / `regressed.md`)                        |
| `compiling-candidate` | Yes — count-based (`compiling_candidate_pass`), PASS iff ≥1 `merge_result` observed                                | recorded `merge_result` payload(s) as a JSON array (`passing.json` / `regressed.json`) |
| `browser-smoke`       | No — Playwright-driven, requires a live Studio session; also explicitly out of scope for Tier-1 (see #866's Scope) | not represented here                                                                   |

Both in-scope graders' verdict functions are pure (no DB/model/network) and
already live in `crates/sf-eval/src/graders.rs`; this fixture corpus proves
they run against artifact-shaped inputs, not the ad hoc strings/counts the
existing unit tests use.
