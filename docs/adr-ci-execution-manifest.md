# ADR: Substrate-Agnostic CI Job Manifest, Not an Embedded GitHub Actions Parser

**Date:** 2026-06-27
**Status:** Proposed
**Related:** `crates/fastenv`, `.github/workflows/`, `docs/testing-invariants.md`, `coverage-truth.toml`, the `ci-taxonomy-audit` gate, the `_shared/test-coverage-policy.md` invariants

---

## Context

The appliance has to run a project's test/build/gate graph reproducibly in two
places: a developer's machine and the appliance's own CI. The obvious shortcut
is to treat GitHub Actions YAML as the source of truth and run it locally with
an ACT-style emulator (`nektos/act`, Gitea-ACT). That shortcut conflates two
concerns that GitHub Actions YAML bundles together:

1. **A specification** — the job graph: what runs, in what order, with what
   gates, and what "tested" actually means.
2. **An execution substrate** — hosted-runner emulation: the container model,
   `runs-on` labels, `permissions:`, marketplace actions, and GitHub contexts.

ACT re-emulates the substrate locally in order to run the spec. The recurring,
documented pain in this repo is **entirely substrate-emulation leakage**, not
spec problems:

- the self-hosted runner's disk fills from accumulated worktree `target/` dirs;
- the private ghcr container 403s without `packages:read`;
- the `self-hosted → ci-runner` mapping has to be hand-maintained in `.actrc`;
- the ci-runner image has no `node`, so ACT stops at the first JS action
  (`actions/cache`, `upload-artifact`) — tracked in #810;
- the eval workflow stalls on a HuggingFace model download.

Every one of these is "ACT pretends to be GitHub and the pretense is
imperfect." Meanwhile `crates/fastenv` already provides project-isolated,
reproducible dev/CI environments. Re-emulating GitHub's runner on top of that is
redundant complexity whose main output is a new bug class.

This is also design input for the **appliance**, not just internal tooling: the
same ACT difficulties are exactly what appliance customers would inherit.

---

## Decision

The appliance does **not** embed a GitHub Actions YAML parser or an ACT-style
runner emulator.

Instead it defines a **minimal, substrate-agnostic declarative job manifest**
that FastENV executes natively. The agent authors and maintains the manifest; a
gate validates it (`ci-taxonomy-audit` plus the four `test-coverage-policy`
invariants recorded in `docs/testing-invariants.md`). Any GitHub Actions YAML
becomes a **generated adapter at the GitHub boundary** — an output, not the
source of truth.

In short: the manifest is the spec, FastENV is the substrate, the gate is the
enforcement boundary, and GHA YAML is a downstream emitter.

---

## Rationale — the synthesis

Exploit what AI is good at — generating structured artifacts that conform to a
schema — and refuse to use it for what it is bad at — deterministic execution.
The agent authors the manifest (flexibility at authoring time); FastENV and the
gate enforce it (determinism at execution time). The source of truth moves one
layer **down** from GitHub's substrate to a manifest FastENV already knows how
to run, so dev/CI parity becomes **structural** rather than **emulated**.

---

## Rejected alternatives

**1. Embed an ACT / GitHub Actions YAML parser in the appliance.**
Rejected. It couples the spec to GitHub's substrate emulation and imports the
documented pain (disk leakage, `packages:read` 403s, `.actrc` mapping, missing
`node`, model-download stalls) into an appliance that already has FastENV. GHA
also carries GitHub-specific surface — marketplace actions, contexts,
`permissions:` — that does not map onto an on-prem appliance.

**2. Per-run agent-authored shell scripts (no persisted artifact).**
Rejected. It loses the three things the gate depends on:

- **Determinism / assertiveness** — a gate must return the same verdict for the
  same inputs. An agent improvising bash each run cannot _be_ the enforcement
  boundary; "green = nobody objected, not the code ran" only gets worse.
- **Auditability** — the four test-coverage invariants are static checks against
  a _persisted_ artifact. You cannot grade a script that evaporated after it ran.
- **Local/CI parity** — nothing guarantees two improvised runs match.

**3. GHA YAML as source of truth + ACT for local runs.**
Rejected for the reasons in alternative 1: parity is purchased only through
substrate emulation, and the emulation is the bug source.

**Chosen:** declarative manifest + FastENV executor + validation gate, with GHA
YAML emitted as a generated adapter only if the project keeps pushing to GitHub.

---

## Consequences

**Positive**

- One source of truth runs identically in dev and appliance CI — parity is
  structural, not emulated.
- The GitHub-runner emulation bug class disappears for native runs.
- The manifest is auditable: `ci-taxonomy-audit` and the four
  `test-coverage-policy` invariants apply directly to a persisted artifact —
  loud-skip never silent-skip; exit-0 ≠ tested; runtime behaviour needs an
  executed-in-CI assertion; required checks cover the languages present.

**Tension to acknowledge explicitly**

This revises the current operating principle "run CI YAML unmodified via ACT,
never a parallel local script." That principle is **correct while GitHub is the
source of truth** — emulation is the only way to get parity _there_. This ADR
moves the source of truth one layer down (manifest + FastENV) so parity becomes
structural. The "no duplicate scripts" instinct is preserved: there is still one
artifact, the manifest — not ACT reproducing GitHub alongside a hand-written
local script.

**Negative / cost**

- The manifest schema and the FastENV executor must be designed and maintained.
- A GHA-adapter generator must be built if the project keeps pushing to GitHub.

**Follow-up**

- Design the minimal manifest schema against the existing
  `.github/workflows/*.yml` and the FastENV interface (separate work).
