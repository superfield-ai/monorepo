# Scout 510 — Sharp canonical-doc back-link mapping

Issue: #510 (dev-scout)
Target: resolve stale `docs/architecture.md` section references in `crates/sharp/`
Handoff comment posted on: #508

## Summary

All `docs/architecture.md` references in `crates/sharp/` use section names that
no longer exist. The document was heavily reorganised in PRs #511, #513, #514,
and #505. This file records the authoritative mapping from each stale ref to the
correct current heading so that the fix author (issue #508) can update the
back-links in one pass.

## Mapping table

| File                                                    | Line | Stale reference                           | Correct section heading in docs/architecture.md                                                                                                                           |
| ------------------------------------------------------- | ---- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crates/sharp/src/git_interop.rs`                       | 21   | `§7 Current Gaps #10`                     | `## Sharp — Tier-1 Rust Semantic Merge` (SHA-1 posture is within the git_interop module description under `### Components (\`crates/sharp\`)`)                            |
| `crates/sharp/src/git_interop.rs`                       | 25   | `§sharp schema`                           | `## Sharp — Tier-1 Rust Semantic Merge` → `### Components (\`crates/sharp\`)`                                                                                             |
| `crates/sharp/src/runtime_signal.rs`                    | 32   | `§Deploy and runtime-signal loop`         | `## Daemon Lifecycle` → `### Startup-notify handshake` (deploy/runtime signal ingestion lives under Daemon Lifecycle; no dedicated deploy-loop section exists post-reorg) |
| `crates/sharp/src/projections.rs`                       | 26   | `§sharp schema`                           | `## Sharp — Tier-1 Rust Semantic Merge` → `### Components (\`crates/sharp\`)`                                                                                             |
| `crates/sharp/src/refs.rs`                              | 16   | `§sharp schema`                           | `## Sharp — Tier-1 Rust Semantic Merge` → `### Components (\`crates/sharp\`)`                                                                                             |
| `crates/sharp/src/object.rs`                            | 7    | `§sharp schema`                           | `## Sharp — Tier-1 Rust Semantic Merge` → `### Components (\`crates/sharp\`)`                                                                                             |
| `crates/sharp/src/repo.rs`                              | 7    | `§sharp schema`                           | `## Sharp — Tier-1 Rust Semantic Merge` → `### Components (\`crates/sharp\`)`                                                                                             |
| `crates/sharp/src/commit.rs`                            | 8    | `§sharp schema`                           | `## Sharp — Tier-1 Rust Semantic Merge` → `### Components (\`crates/sharp\`)`                                                                                             |
| `crates/sharp/src/error.rs`                             | 3    | `§Sharp schema` and `§Sharp subsystem`    | `## Sharp — Tier-1 Rust Semantic Merge` (both stale names collapse to this top-level section)                                                                             |
| `crates/sharp/src/episode.rs`                           | 6    | `§Schema namespace assignment`            | `## Single-Instance Database Schema Layout` → `### Schema namespace assignment`                                                                                           |
| `crates/sharp/src/lib.rs`                               | 48   | `§Self-hosting gate`                      | `## Sharp — Tier-1 Rust Semantic Merge` → `### Self-hosting gate`                                                                                                         |
| `crates/sharp/src/lib.rs`                               | 50   | `§Single-Instance Database Schema Layout` | `## Single-Instance Database Schema Layout` (heading unchanged — anchor may need updating)                                                                                |
| `crates/sharp/migrations/0003_sharp_git_interop.sql`    | 4    | `§sharp schema`                           | `## Sharp — Tier-1 Rust Semantic Merge` → `### Components (\`crates/sharp\`)`                                                                                             |
| `crates/sharp/migrations/0004_sharp_runtime_signal.sql` | 12   | `§Deploy and runtime-signal loop`         | `## Daemon Lifecycle` → `### Startup-notify handshake`                                                                                                                    |
| `crates/sharp/migrations/0002_sharp_episode_schema.sql` | 5    | `§Schema namespace assignment`            | `## Single-Instance Database Schema Layout` → `### Schema namespace assignment`                                                                                           |
| `crates/sharp/migrations/0006_sharp_episode_model.sql`  | 18   | `§Sharp subsystem`                        | `## Sharp — Tier-1 Rust Semantic Merge`                                                                                                                                   |
| `crates/sharp/migrations/0007_sharp_projections.sql`    | 17   | `§sharp schema`                           | `## Sharp — Tier-1 Rust Semantic Merge` → `### Components (\`crates/sharp\`)`                                                                                             |
| `crates/sharp/migrations/0001_sharp_vcs_schema.sql`     | 4    | `§Schema namespace assignment`            | `## Single-Instance Database Schema Layout` → `### Schema namespace assignment`                                                                                           |
| `crates/sharp/migrations/0005_sharp_refs_model.sql`     | 8    | `§sharp schema`                           | `## Sharp — Tier-1 Rust Semantic Merge` → `### Components (\`crates/sharp\`)`                                                                                             |

## Current docs/architecture.md headings (as of PRs #511 #513 #514 #505)

```
## Superfield Blueprint
## Nexum — Company Knowledge Graph
### Page-revision schema and write contract
## Single-Instance Database Schema Layout
### Decision
### Schema namespace assignment
### Table naming convention
### Migration ownership
### Cross-component joins and RLS scoping
### AGE graph extension
## Governed Embedding Standard
### Standard
### Rationale
### Vector column inventory
### Adoption rule for new stores
## Sharp — Tier-1 Rust Semantic Merge
### Components (`crates/sharp`)
### Merge algorithm (Tier-1)
### rust-analyzer subprocess protocol
### Self-hosting gate
## Substrate Reliability
### Recovery Objectives
### Architecture
### Restore Procedure
### Seam: `SubstrateBackup`
## Daemon Lifecycle
### State directory
### Auto-spawn flow
### Startup-notify handshake
### Version handshake
### Shutdown
### No idle timeout
### Always-on logging
### Foreground / container mode
### Seam: PostgresProvisioner
### Seam: LoopHandle
## HTTP Routes
### Authentication model
### Route table
### Route module layout
### Notes
## CLI — Command Surface
### Subcommand reference
### Daemon auto-spawn
### Environment variables
### Known page names
## Nexum — Page Revision Schema
### DDL shape
### Write contract
### Idempotency (append-only, no update)
### Migration prerequisite
## Milestone 1 — Headless Gardening Appliance (completed)
```

## Notes for the fix author

- The stale `§sharp schema` refs (most common) all map to
  `## Sharp — Tier-1 Rust Semantic Merge` → `### Components (\`crates/sharp\`)`.
The correct anchor link format is:
`docs/architecture.md#components-cratessharp`

- The stale `§Deploy and runtime-signal loop` has **no direct replacement
  heading**. `runtime_signal.rs` records production errors linked to a
  deployment; the closest current sections are:
  - `## Daemon Lifecycle` for the runtime lifecycle context
  - `### Startup-notify handshake` for the deploy/startup signal path
    Recommend pointing to `## Daemon Lifecycle` and noting the subsection.

- The stale `§7 Current Gaps #10` in `git_interop.rs:21` referred to a
  numbered gap list that no longer exists. The SHA-1 DC posture lives in the
  prose of `### Components (\`crates/sharp\`)`(git_interop row). Reference`## Sharp — Tier-1 Rust Semantic Merge` for now; a dedicated "SHA-1 posture"
  subsection would be the clean long-term fix.

- `§Self-hosting gate` → `### Self-hosting gate` under
  `## Sharp — Tier-1 Rust Semantic Merge` — heading survived the reorg, only
  the section number changed.

- `§Single-Instance Database Schema Layout` → `## Single-Instance Database
Schema Layout` — heading survived intact; only the anchor needs a check.
