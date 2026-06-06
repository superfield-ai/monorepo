# Sharp

A database-native, semantically-aware version control system designed for the transition from human-authored software to lights-out, agent-authored software.

Sharp is a real VCS today — Git-compatible at the linear-history layer, exportable to GitHub remotes for backup and sharing — and a database-native, episode-aware substrate for autonomous coding agents tomorrow. Repository state lives in PostgreSQL. Code is augmented with structured semantic representations (Tree-sitter ASTs, symbol tables). Agent runs are recorded as first-class **episodes**: prompts, retrieved context, tool traces, intermediate patches, validation outcomes, judge results, and the snapshot promoted as output. The merge model is a three-tier contract — deterministic semantic merge, language-aware verification gate, automatic downstream-oracle tie-break, structured dilemma escalation — designed so that Sharp never silently picks between two semantically valid resolutions and never emits a wrong merge that would not compile.

## Status

Sharp is implemented and working. The v1 core is in place — the VCS core, the agent-episode schema, and per-language semantic merge for **TypeScript** and **Rust** (the languages superfield uses internally) — and the merge engine passes its full differential corpus (23/23 scenarios) against git, with performance benchmarks recorded. Active work continues on broadening language coverage and hardening the merge tiers.

## Documents

- **[Whitepaper — `docs/whitepaper.md`](./docs/whitepaper.md)** — the protocol specification: design principles, system architecture, data model, agent-episode schema, three-tier merge contract, Git interoperability.
- **[v1 Implementation Plan — `docs/v1-plan.md`](./docs/v1-plan.md)** — concrete engineering plan: scope, surface, validation thresholds, phased delivery, success criteria, engineering risks, security and privacy posture.
- **[Engineering Plan — `docs/engineering-plan.md`](./docs/engineering-plan.md)** — design-level breakdown of how the v1 plan gets built: storage layer, server HTTP API, client basics, Tree-sitter and merge engine, git compatibility, episode library, analytics. Pairs with v1-plan.
- **[Research Directions — `docs/research.md`](./docs/research.md)** — open questions and post-v1 work: cross-language semantic merge, control-flow graph analysis, AST stability, episode-retention policy, replay-as-evaluation methodology, the Tier 3 dilemma format.
- **[Test Plan — `docs/test-plan.md`](./docs/test-plan.md)** — differential test harness driving development: scenario fixtures, the Sharp-vs-git two-lane architecture, the corpus that pins down "Sharp is better than git on real merges."
- **[Server Configuration — `docs/server-config.md`](./docs/server-config.md)** — all environment variables, deployment recipes (Docker Compose and direct), migration operations, and token issuance.
- **[Hooks — `docs/hooks.md`](./docs/hooks.md)** — reference for the hooks system: events, payload format, exit codes, stock hook examples, and security notes.
- **[Episodes — `docs/episodes.md`](./docs/episodes.md)** — walkthrough for `@sharp/episodes`: API reference, inline vs CAS auto-routing, and the three hot analytics queries.
- **[Git Interop — `docs/git-interop.md`](./docs/git-interop.md)** — import/export reference: what is preserved, the linear-only export constraint, the playback guarantee, and the SHA-1DC gap.

## Quick Start

```bash
# Start the server (requires Postgres)
SHARP_DSN=postgres://... SHARP_ALLOW_RAW_SHA1=1 bun apps/server/src/index.ts

# Issue an operator token
SHARP_URL=http://localhost:5174 SHARP_TOKEN=<token> bun apps/client/src/cli.ts admin issue-token --principal me --scope operator

# Create a repo and start working
sharp admin create-repo my-project
sharp init --server http://localhost:5174 --repo my-project
sharp add src/
sharp commit -m "initial commit"
```
