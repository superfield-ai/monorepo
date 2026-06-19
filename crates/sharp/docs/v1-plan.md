# Sharp v1 Implementation Plan

This document is the engineering plan for Sharp v1. It pairs with the protocol specification in [`whitepaper.md`](./whitepaper.md) and the differential test harness in [`test-plan.md`](./test-plan.md). Forward-looking research questions are in [`research.md`](./research.md); they are deliberately not on the v1 roadmap.

## 1. Scope of v1

v1 ships:

- A working VCS — `objects`, `refs`, `commits`, full DAG support, and the minimalist merge model of whitepaper §2.6 — on a Postgres-only backend using Git's content-addressing hash (SHA-1, with SHA-256 supported per whitepaper §4.0).
- The two bounded Git interop operations of whitepaper §7: `sharp git import` and `sharp git export`. No Git server, no wire-protocol implementation beyond what those two operations need, no continuous sync.
- The agent-episode schema from whitepaper §5.1 (`episodes`, `episode_artifacts`, `episode_links`) with a working harness-side library that brackets a run.
- The minimal semantic layer enumerated in §2 below, sufficient to run the Tier 1 merge model and the verification gate from whitepaper §6 for **TypeScript** and **Rust**.

v1 explicitly defers cross-language semantic merge, control-flow graphs, multi-language semantic schemas, any form of Git server or wire-protocol implementation, bidirectional Git sync, submodule recursion, Git LFS object fetch, large-file policies, replication, forge integration APIs, and eval-loop tooling. Items deferred to research are tracked in `research.md`.

## 2. v1 Surface

### Server

The v1 storage substrate is the PostgreSQL plugin ([`postgres-storage-plugin.md`](./postgres-storage-plugin.md)), covering `objects` (with the `algo` column from whitepaper §4.0), `refs`, `commits`, `representations`, `commit_metadata`, `episodes`, `episode_artifacts`, and `episode_links`. Provisioning follows the superfield-wide `postgres:16-alpine` + docker-compose pattern (see `superfield/template`).

### HTTP / library API

Endpoints for object put/get, ref read/update, commit create, episode open / append-artifact / finish, episode query, semantic-representation upsert/query, and the two Git interop operations (import, export).

### CLI

- **Git-shaped subset for working inside Sharp.** `sharp init`, `clone`, `add`, `commit`, `branch`, `merge`, `pull`, `push`. (`pull`/`push` move data between a Sharp client and a Sharp server, not between Sharp and Git.)
- **Git interop namespace.** `sharp git import <url>` and `sharp git export <branch> <url>`.
- **Operator commands.** `sharp episode list`, `sharp episode show`, `sharp episode redact`, and `sharp query <sql>` for ad-hoc reads against the unified store.

### Semantic layer

Semantic analysis via language-native tooling:

- **TypeScript**: `ts.LanguageService` (TypeScript Compiler API). Sharp calls `findRenameLocations()` to enumerate rename locations and `getSemanticDiagnostics()` / `getDeclarationDiagnostics()` for structural verification.
- **Rust**: `rust-analyzer` LSP subprocess. Sharp issues `textDocument/rename` to enumerate rename locations and `cargo check --message-format=json` for structural verification.
- **Other languages**: Tree-sitter is retained as a lightweight parse check and for languages without a mature LSP.

These representations are consumed by the Tier 1 merge model (whitepaper §6.1) and by Sharp's intrinsic structural verification (whitepaper §6.2). Additional project-specific checks are exposed through the hooks system (whitepaper §6.3); stock examples ship under `examples/hooks/`. Control-flow graphs and cross-language normalization are post-v1 (`research.md`).

## 3. What Gets Validated

- **Postgres-as-store cutoff.** v1 acceptance thresholds: commit creation under 50ms p99, checkout of a 10k-file tree under 2s, episode ingest at >100 episodes/sec on a single node. If these are not met, the architecture rethinks the storage layer — most likely moving blobs to a dedicated CAS while keeping metadata in Postgres.
- **Git import fidelity.** Import 10 representative open-source repositories via `sharp git import`. For each, the imported object set must include every reachable blob/tree/commit/tag with byte-identical content (same SHAs as the source). Multi-parent commits, annotated tags, and signed-commit signatures must survive import.
- **Git export round-trip.** For the linear `main` (or equivalent) branch of each of those 10 repos, run `sharp git export` to a fresh remote and bit-compare commit object SHAs against the source. Linear-branch export must produce byte-identical Git objects.
- **Episode replay.** Take an archived episode, replay it against a different `model_id`, and produce a valid linked replay episode (`episode_links.relation = 'replay_of'`).
- **Storage amplification.** Measure the ratio of episode-artifact storage to source-tree storage on a representative agent-driven workload. Flag if the ratio exceeds 50× and require a dedup analysis before declaring v1 complete.
- **Differential test harness.** The corpus described in `test-plan.md` runs in CI on every change. Categories Sharp claims to handle (refactor, reorder, format, move-edit, delete-edit, import-merge, cross-file-rename, whitespace-only) must be green for both TypeScript and Rust scenarios.

## 4. Phased Delivery

1. **Phase 1 (Weeks 1–4).** Postgres schema, Git-hash CAS (SHA-1 with SHA-1DC collision detection on intake), object/ref/commit API, and the CLI subset (`init`, `add`, `commit`, `branch`, `merge`, `pull`, `push`) operating against a Sharp server. No episodes, no Git interop, no semantic layer yet.
2. **Phase 2 (Weeks 5–8).** Episode tables and APIs, harness library, redaction APIs, replay primitive, and the operator CLI for episode introspection (`episode list/show/redact`).
3. **Phase 3 (Weeks 9–12).** `sharp git import` and `sharp git export`, Tree-sitter semantic representations, semantic diff, the Tier 1 merge model, and the verification gate. Import-fidelity and linear-export round-trip validation against the 10-repo corpus from §3. Differential harness wired up to drive merge correctness against the test-plan corpus.

## 5. Out of Scope (Recap)

- Acting as a Git client or Git server, or implementing the Git wire protocol beyond what `import` and `export` need (whitepaper §0, §7).
- Continuous bidirectional Git sync, automatic upstream re-pull, and forge integration APIs (whitepaper §0, §7).
- Recursive submodule ingest and Git LFS object fetch (whitepaper §7.1).
- Cross-language algorithmic semantic merge and control-flow graphs (whitepaper §6, §0; tracked in `research.md`).
- Large-file storage policies and customer-held-key encryption at rest (§8.6 below).
- Eval-loop tooling and training-pipeline orchestration on top of episodes.

## 6. Success Criteria

- Import preserves the full Git object graph (including multi-parent commits, annotated tags, and signed-commit signatures) for the 10-repo corpus, and linear-branch export produces byte-identical Git objects on a fresh remote.
- Postgres-store benchmarks meet the §3 thresholds, **or** the design pivots blob storage to an external CAS with a documented migration path.
- A reference agent harness can open, append to, and replay episodes via the library API.
- SQL queries over the unified store produce useful answers. Sample queries that must work end-to-end: _"all episodes that touched file X"_, _"all failed siblings of commit Y"_, _"all episodes using model Z, with success rate broken down by harness version"_.
- Semantic diff is demonstrably useful on real changes — refactors, renames, and signature changes register as structural rather than purely textual deltas.
- The differential harness (`test-plan.md`) shows Sharp converting `git`'s `conflict` and `clean_wrong` outcomes into `clean_ok` for the seed corpus across both TypeScript and Rust.

## 7. Engineering Risks

These are tractable engineering items — not open research questions — that v1 must keep an eye on as it ships:

- **Toolchain version pinning** for the verification gate. `tsc` and `cargo check` versions affect outcomes; v1 must record the exact toolchain used per merge so reproducibility holds across machines.
- **Storage overhead for derived representations and full episode traces.** v1 partially addresses this via the artifact-as-CAS-pointer dedup strategy in whitepaper §5.2.
- **Maintaining byte-canonical Git object emission on export** (tree-entry sort, modes, commit headers) as Sharp's internal model evolves. The 10-repo round-trip suite from §3 is the regression net.
- **Honest handling of submodules and Git LFS on import** — preserved as tree entries / pointer blobs but not recursively fetched in v1. The CLI must surface this to the operator at import time so they aren't surprised later.
- **SHA-1 collision detection on intake** (SHA-1DC) is a hard requirement; v1 must not weaken it for performance.
- **Ref-update concurrency** in the Postgres schema. The (`repo_id`, `name`) primary key on `refs` gives row-level locking; v1 needs explicit CAS-style ref updates so concurrent operations don't lose writes.

## 8. Security and Privacy Considerations

### 8.1 Data Sensitivity

Episodes record prompts, retrieved context, and tool I/O. This material is structurally more sensitive than typical VCS history: prompts may include customer queries, retrieved context may include private internal documents, and tool outputs may include API responses carrying credentials or PII. Sharp's threat model assumes episode content can contain anything the harness was exposed to.

### 8.2 Redaction

Sharp supports auditable redaction on the mutable episode metadata layer; see whitepaper §5.5 for the mechanism. Original artifact content can be scrubbed and replaced with a redacted version while structural facts (parent commit, status, timing, links) are preserved. Redactions are audited as first-class mutations.

### 8.3 Access Control

Authentication and per-repo permissions are a server responsibility (whitepaper §3.2). For v1, episode-level read scopes are required: it must be possible to grant a principal access to commits and refs without granting access to the underlying episode trace. Code review, audit, and CI use cases need the commit graph; they do not need raw prompts and tool outputs.

### 8.4 Training-Corpus Export

Bulk export of episodes for training or evaluation must filter on sensitivity flags. Default policy is **opt-in** for export, not opt-out: an episode is excluded from corpora unless it has been explicitly cleared. Redacted episodes carry their redaction provenance into the export.

### 8.5 Supply Chain and Forensics

Recording `tool_versions`, `harness_version`, `model_id`, and `decoding_params` on every episode means Sharp doubles as a forensic record of _what the harness was running when this commit landed_. This is a security feature — incident response on an agent-authored regression can pin the exact tool and model versions involved — not just a provenance nicety.

### 8.6 Out of Scope for v1

The following are known gaps in v1, called out explicitly rather than implied:

- end-to-end encryption of episode content at rest with customer-held keys
- multi-tenant cryptographic isolation between repos on a shared server
- data-residency controls (region pinning, geo-fenced storage)

These are reasonable v2 work items; they are not promised in v1.
