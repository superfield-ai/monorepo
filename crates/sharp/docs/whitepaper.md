# Sharp: A Database-Native, Semantically-Aware Version Control System for Agentic Software Development

> **Document status — design + protocol specification.** This is a design and
> protocol specification describing the _target_ Sharp system, not a report on
> the current state of `crates/sharp`. Present-tense prose ("Sharp stores…",
> "Sharp calls…") describes intended design and is not a guarantee that every
> component is implemented today. The SQL schema blocks (§4, §5) and APIs are the
> _target_ shape of the protocol; the shipped migrations may differ and will
> converge on these. The post-v1 forks — the semantic-patch substrate
> ([`semantic-patches.md`](./semantic-patches.md)) and branch-as-set
> ([`branch-semantics.md`](./branch-semantics.md), [`storage-substrate.md`](./storage-substrate.md)) —
> are explicitly forward-looking and are not claimed to exist in v1. The bar this
> document holds itself to is internal consistency, not implementation parity.

## **Abstract**

**Sharp** is a version control system. It preserves a Git-isomorphic core for linear history (blob, tree, commit, ref), stores all repository state in PostgreSQL, augments source code with semantic representations, and treats agent episodes as a first-class metadata layer attached to commits.

Its foundational claim is narrow and load-bearing: many merge conflicts — the spurious ones a line substrate manufactures — are an artifact of comparing changes in a representation too weak to decide whether they are semantically independent, so an agent-first VCS must decide merges at the altitude of symbols and types rather than lines (§1.1). Every other choice in this document — the snapshot store, the borrowings from Jujutsu, the Git interop — is downstream of that one.

The substrate is recognizable — commits, branches, refs, and a single minimalist merge model — and linear history exports losslessly to standard Git remotes, with import and sync through a dedicated interop surface. On top of that substrate, Sharp captures the full lifecycle of automated change attempts — prompts, retrieved context, tool traces, intermediate patches, validation results, judge outcomes, and the promoted snapshot — as queryable, structured episodes.

Sharp is designed for the **transition** from human-authored software to lights-out, agent-authored software. Git, GitHub, and the broader VCS ecosystem are not going away on the timescale of that transition: humans will keep reviewing, auditing, and maintaining code alongside agents for years, and entire industries are wired to Git remotes, pull requests, CI hooks, and forge tooling. A system that demands those be abandoned to adopt it will not be adopted. Sharp's bet is that the right substrate for dark-factory development is _still a VCS, still Git-compatible at the linear-history layer_, but with the database, semantic, and agent-episode capabilities current VCS designs lack. Linear history exports cleanly to GitHub today; the agent-episode and semantic layers are ready when the harnesses are.

---

## **0. Non-Goals**

Sharp is explicitly **not** trying to be:

- a Git client or Git server
- a continuous bidirectional Git sync tool
- a CI/CD system
- a code review UI
- a cross-language semantic-merge engine in v1

Sharp's relationship to Git is bounded and one-shot in each direction: **import** an existing Git repository to continue work inside Sharp, and **export** a completed linear branch back to a Git remote (GitHub, GitLab, etc.) for backup or sharing. There is no ongoing sync, no Git wire-protocol implementation beyond what is needed for those two operations, and no attempt to host or serve Git itself.

Anything in this list is out of scope and will not be added under v1.

---

## **1. Introduction**

Sharp is a version control system designed for an era of agentic software development. Most existing VCS designs assume a human author at a working tree, negotiating branches and merges with other humans. Agent harnesses operate differently: they fan out many candidate changes, score them, and select outputs at machine speed, generating structured trace data that current systems either discard or shove into ad-hoc side stores. This shift will not happen overnight — human developers will continue to author, review, and audit code alongside agents for years — so Sharp is built for the long transition. It works as a real VCS for human teams _today_, ingests existing Git repositories so work can continue inside Sharp, and exports completed linear branches back to Git remotes for backup and sharing — while giving agent harnesses the database-native, semantically-aware, episode-rich substrate ad-hoc tools cannot. The Git-compatible core is not a compatibility shim; it is a load-bearing design choice for the transition era.

Sharp keeps the parts of Git that work — content-addressed objects, commits, refs, linear history, and remote interop — and changes the substrate. Repository state lives in PostgreSQL rather than on a filesystem; semantic representations of code are first-class queryable artifacts; and agent episodes are recorded as rich, structured metadata attached to the commits they produced. Humans and operators retain a Git-shaped CLI; agent harnesses get a library and HTTP API tuned to their workload.

### **1.1 The Root Axiom: Conflict Is Relative to Representation**

Every other decision in this document is downstream of one claim, so it is stated and defended first.

**A merge conflict is not a property of two changes. It is a property of two changes _and the representation in which the VCS compares them_.** The same pair of edits conflicts or does not depending on the altitude of the comparison — and the gap cuts both ways:

- **Manufactured conflicts.** Two edits to unrelated functions that happen to land on adjacent lines collide under a three-way line merge while interfering in no semantic sense. A symbol rename overlaps, as text, with any nearby edit to the symbol's declaration, though the rename is mechanical and unambiguous. The substrate reports a conflict the program does not contain.
- **Missed conflicts.** Two edits that are lexically far apart — one narrows a function's return type, another adds a caller that binds the old type — do not overlap as text and merge cleanly into a program that no longer compiles. The substrate certifies a merge the program _does_ conflict about.

Both failures have one cause: a line-based VCS answers the only question that decides a merge — _are these two changes independent?_ — with the wrong proxy. **Independence is a semantic relation** — do the changes touch the same symbol's meaning, the same type's contract, the same reference? — and a line merge approximates it by **lexical adjacency** — do the changes touch the same or neighboring lines? The approximation is at once _unsound_ (it clears merges that semantically conflict) and _incomplete_ (it raises conflicts that semantically do not exist). Git, Jujutsu, and Pijul are all sub-semantic on this axis by construction (`comparison-merge-theories.md` §4): they reason over sets, lines, graphs, and trees, never over symbols, types, or whether the result compiles. Every conflict they report is a lexical stand-in for a semantic question, and the space between stand-in and question is precisely where silent mis-merges live.

**The claim is bounded, and the bound matters.** This is a position within the software-merge literature, not outside it (`comparison-merge-theories.md` §4.6), and that literature has measured the limit. Moving the comparison from line to symbol dissolves the _spurious_ conflicts — the ones manufactured by lexical adjacency — but it does not dissolve _genuine_ semantic disagreement, where two changes truly cannot both stand. Empirical studies of structured and semistructured merge (Apel et al. 2012; Cavalcanti, Borba & Accioly 2017) find the spurious class is large but finite: structure reduces conflicts meaningfully, not to zero. So the precise thesis is that **spurious conflicts are a representation artifact and are dissolvable; genuine conflicts are not, and the share of each in real agent traffic is an open quantity Sharp must measure on its own corpus, not assume.** The semantic structure the comparison needs is, in any case, re-derived by the same language toolchain regardless of substrate — the gain is in _where_ and _how reliably_ the comparison is made, not in recovering information the text had irretrievably destroyed.

**Agents make this the defining constraint, not a refinement.** A human tolerates the proxy because a human reads every conflict the substrate raises and silently repairs the ones it misses — the human _is_ the semantic layer the VCS omits. Remove the human and both failure modes go unhandled: a manufactured conflict stalls an autonomous pipeline on a non-problem, and a missed conflict ships a broken merge with no reviewer downstream. Agent harnesses fan out and merge at machine speed in exactly the regime where no human is present to launder the substrate's lexical verdict into a semantic one. The substrate must compute the semantic relation itself. This is not an enhancement of a VCS built for humans; it is the property such a VCS was relying on a human to supply.

Sharp's two core mechanisms map onto the two failure modes directly: Tier 1 semantic merge (§6.1) dissolves the manufactured-conflict class by deciding independence at symbol altitude, and the intrinsic verification gate (§6.2) catches the missed-conflict class by refusing to store a merge that does not parse, resolve its references, and pass the language's own diagnostics. Where independence genuinely fails, the conflict is reported as the specific symbols in tension — a structured dilemma (§6.5) — never as text markers.

**What the merge actually guarantees — and what it does not.** Three guarantees must be kept distinct. (1) _Consistency_: the result is deterministic and order-independent when access sets are disjoint — proved, not asserted (`semantic-patches.md` §3, `branch-semantics.md` §1.1). (2) _Reference- and type-level correctness_: the merged program parses, resolves its references, and passes the language's diagnostics — enforced by the verification gate (§6.2). (3) _Behavioral correctness_: the program does what was intended. Sharp delivers (1) and (2); it does **not**, and cannot from the access-set model alone, deliver (3). Two changes with disjoint symbol-level read/write sets commute and compile yet can jointly violate a behavioral invariant the type system does not encode. The symbol graph captures _reference_ dependencies, not _semantic invariants_; serializability gives _consistency_, not _intent_. The "missed conflict" example above is caught precisely because a return-type narrowing is a _type-level_ dependency — a purely behavioral dependency would pass both the access-set check and the compile gate. Behavioral correctness remains the province of tests, review, and the Tier-2 oracle (§6.4); the automated ceiling is type-level, and the design should claim no more.

**What "semantically aware" commits to — and what it does not.** The axiom fixes the _altitude at which independence and merge are decided_: symbols, references, types, and the language's notion of a well-formed program — not lines. It is deliberately not, on its own, a claim about the _storage_ substrate. Sharp v1 realizes the semantic decision layer over a content-addressed _snapshot_ store, computing independence by handing materialized trees to each language's own toolchain (`ts.LanguageService`, rust-analyzer) and reading back renames, reference sets, and diagnostics (§2.3, §6.1). Whether the canonical stored unit should itself become a semantic code graph — with snapshots demoted to an export projection, and history recorded as semantic operations whose commutation the language _decides_ rather than a merge engine _approximates_ — is a larger decision held out of v1 and analyzed in [`semantic-patches.md`](./semantic-patches.md). The root axiom settles the altitude of the _decision_; it leaves the representation of the _store_ open.

**The order of commitments.** Because a VCS's correctness is the correctness of its conflict resolution, that correctness is governed by the independence relation, and the relation is semantic, Sharp's commitments are ordered by their distance from this axiom:

1. **Semantic independence is computed, not approximated** — the merge engine decides at symbol and type altitude (§6).
2. **A snapshot store realizes it for v1** (§2.2, [`snapshots-vs-patches.md`](./snapshots-vs-patches.md)) — chosen rather than assumed; the code-graph alternative is the open fork ([`semantic-patches.md`](./semantic-patches.md)).
3. **Jujutsu's mechanisms are adopted on top** — operation/view log, conflict algebra, change-IDs — each re-expressed over semantic atoms ([`jj-adoption.md`](./jj-adoption.md)).
4. **Git interop is preserved as a consequence** of the snapshot realization (§2.1, §7), not as a driver.

Read top to bottom, that list is the architecture. Everything past §1.1 is the realization of step 1 and the consequences of step 2.

---

## **2. Design Principles**

These principles are consequences of the root axiom (§1.1); they are numbered for reference, not in order of primacy. The semantic layer (§2.3) is the axiom's direct realization; the Git-compatible core (§2.1) and database-native store (§2.2) are the substrate chosen to carry it; the remainder follow from those two choices.

### **2.1 Git-Compatible Core**

Sharp's object model uses the same primitives as Git: blob, tree, commit, and ref, hashed with Git's content-addressing hash (§4.0). This compatibility is asymmetric and bounded by the two real interop operations:

- **Import** preserves the full Git object graph as ingested, including multi-parent merge commits, annotated tags, and signed-commit byte sequences. Sharp does not flatten history on the way in — that would discard information needed for blame, bisect, and audit.
- **Export** is linear-only. A completed linear Sharp branch projects to byte-identical Git objects (correct tree sort, modes, and commit headers) so that exported commits land on a Git remote with stable, recomputable SHAs. Branches with internal merges are not exported — they either flatten on the way out or are refused.

This compatibility protects adoption (existing repos come in; finished work goes out for backup or sharing) and ensures Sharp repositories are never trapped in a proprietary format. It is not a substrate for ongoing bidirectional sync, and it is not a Git server.

### **2.2 Database-Native Architecture**

All repository data is stored in PostgreSQL:

- Content-addressed objects (blobs, trees, commits)
- Refs and tags
- Semantic representations as queryable artifacts
- Commit metadata and agent episode records

This eliminates the split between filesystem repositories and application databases, and makes development history, semantic structure, and agent provenance queryable in the same store.

PostgreSQL is the single substrate Sharp ships and optimizes, but it is reached through a loosely-coupled storage boundary rather than welded throughout the system — it is one implementation, not the architecture. The object/ref plane behind that boundary is substrate-agnostic; corpus-scale retrieval over the provenance and DAG tables is why Postgres is a _scale floor_ rather than a swappable detail. The merge algebra itself — conflict terms, serializability, the merge tiers — runs in Rust above the substrate, not in SQL. Alternative substrates (other databases, flat files, Git metadata) are an admissible but deliberately unsupported extension direction, not a portability guarantee Sharp maintains. See [`storage-substrate.md`](./storage-substrate.md).

### **2.3 Semantic Representations as a First-Class Substrate**

This principle is the direct realization of the root axiom (§1.1): the semantic layer is not an enrichment hung on the substrate but the reason the substrate decides merges where it does. Sharp augments source code with semantic representations, but does not reimplement semantic analysis itself. Instead, Sharp delegates to each language's own production toolchain: `ts.LanguageService` (TypeScript Compiler API) for TypeScript, and rust-analyzer (via LSP subprocess) for Rust. Sharp calls these tools; it does not reimplement them.

These representations are both queryable artifacts in their own right (for retrieval, evaluation, audit) and the inputs to Sharp's merge model. See §6 for how they participate in deterministic semantic merge and the verification gate.

Call hierarchy analysis (TypeScript's `textDocument/callHierarchy`, rust-analyzer's equivalent) gives Sharp a cross-file understanding of what a change impacts — the blast radius of a rename or signature change — before the merge engine attempts resolution.

This delegation carries a recurring cost that should be stated plainly: the semantic layer is **per-language**. Every supported language needs its own toolchain integration, reference-set extraction, and language-specific merge resolution (§6) — which is why v1 scopes to TypeScript and Rust (§0) and cross-language refactors are research (`research.md`). Language-specificity is the known Achilles heel of structured-merge systems (Mens 2002): each new language is a substantial, recurring investment, not a plugin.

### **2.4 Agent Episodes as First-Class Metadata**

Sharp records agent episodes as structured, queryable metadata attached to the commits they produced. This is a primary feature of the system, not an afterthought. The spine of the data model remains the VCS substrate (commits, snapshots, refs); episodes provide rich provenance about how a given commit came to exist.

### **2.5 Separation of Immutable and Mutable Data**

Snapshots and commits are immutable. Episode metadata, tags, redactions for PII (see §5.5), eval re-labels, and downstream judge scores are mutable by design and can be added or revised after the fact without rewriting the underlying VCS facts.

### **2.6 Minimalist Merge**

Sharp ships a single merge model. There is no rebase and no fast-forward variant. This keeps the system small, makes history shapes predictable, and avoids the proliferation of workflow-specific commands that complicates Git for both humans and agents. On the semantic-operation substrate this is not a restriction but a consequence: when a branch is a set of diffs rather than a sequence of commits, there is no sequence to rebase and no fast-forward to special-case (see [`branch-semantics.md`](./branch-semantics.md)).

---

## **3. System Architecture**

### **3.1 Interfaces**

Sharp exposes two coordinated surfaces:

- A **library and HTTP API** consumed by agent harnesses. Harnesses open episodes, stream traces and intermediate artifacts, submit candidate snapshots, record judge outcomes, and promote outputs through this API.
- A **Git-shaped CLI** for humans and operators working inside Sharp: `sharp init`, `clone`, `add`, `commit`, `branch`, `merge`, `pull`, `push`. (`pull`/`push` here move data between a Sharp client and a Sharp server, not between Sharp and Git.) A dedicated `sharp git` namespace handles the two bounded Git interop operations: `sharp git import <url>` ingests an existing Git repository into Sharp, and `sharp git export <branch> <url>` pushes a completed linear Sharp branch out to a Git remote for backup or sharing.

### **3.2 Sharp Server**

The server provides:

- Content-addressed object storage
- Ref and branch management
- Merge execution
- Episode ingestion and querying
- Semantic representation storage and indexing
- Mutable metadata APIs
- Authentication and permissions
- Git import (one-shot ingest of an existing Git repository) and Git export (one-shot push of a completed linear branch to a Git remote)

CI/CD, code review, and other human-facing automation are external.

---

## **4. Data Model**

The core VCS objects are commits, trees, blobs, and refs. Episodes and other metadata attach to these objects; they do not replace them.

### **4.0 Content-Addressing Hash**

Sharp uses **Git's content-addressing hash**: SHA-1 by default, SHA-256 when the repository is initialized with `objectformat=sha256` (Git's own transition format). This is a deliberate choice for the transition-era thesis (§1): Sharp's object IDs _are_ Git's object IDs. A Sharp blob, tree, or commit hashes to the same value Git would compute over the same canonical bytes, byte-for-byte. This is what makes the §2.1 isomorphism claim load-bearing rather than a translation layer — round-trip with a Git remote does not depend on a side-table mapping, and downstream amendments on the Git side return to Sharp with stable identities.

The trade-off is accepted: SHA-1 is slower than BLAKE3 and weaker cryptographically. Sharp inherits Git's mitigations (SHA-1DC collision detection on object intake) and Git's migration path (per-repo `objectformat=sha256`). Sharp records the hash algorithm per object via an `algo` column (§4.1) so that mixed-algorithm repositories are supported during the SHA-1 → SHA-256 transition that Git itself is undergoing.

Choosing a Sharp-native hash (BLAKE3 or otherwise) was rejected: any non-Git hash forces an export-time recomputation, a Sharp-id ↔ Git-id mapping table, and an asymmetry on round-trip — none of which is acceptable for a system whose adoption story is "your existing GitHub remote keeps working."

#### Why SHA-1 is the Right Default in 2026

The choice of SHA-1 is calibrated to the actual state of the Git ecosystem, not the cryptographic ideal:

- **`git init` still defaults to SHA-1** (with SHA-1DC collision detection on object intake). SHA-256 has been available since Git 2.29 (October 2020) via `git init --object-format=sha256`, but it remains opt-in.
- **GitHub still defaults to SHA-1 repositories** for the overwhelming majority of new repos created in 2026. The blocker is not Git's SHA-256 implementation — that has been stable for years — but the **SHA-1 ↔ SHA-256 interop layer**, which would let a SHA-256 client push to a SHA-1 server and vice versa. Without that interop, a SHA-256 GitHub repository cannot be cloned by SHA-1-only tooling, which is a non-starter for a public forge.
- **SHA-256 repositories in the wild** are confined mostly to security-conscious internal setups; they are rare on GitHub and similar forges.

Sharp therefore defaults to SHA-1 (matching what new GitHub repos are using) and supports SHA-256 behind the `objectformat=sha256` flag (mirroring Git's own posture). When the ecosystem flips — when Git makes SHA-256 the `git init` default, or when GitHub does — Sharp follows. Until then, defaulting to SHA-256 would buy cryptographic strength at the cost of interop with the exact remotes Sharp exists to interoperate with, which is the wrong trade for the transition era.

This bullet is calibrated to the Git/GitHub state as of early 2026 and should be re-checked against `git --version` defaults and GitHub repository-creation docs as the SHA-256 transition progresses.

### **4.1 Core Objects**

```sql
objects (
  id bytea primary key,
  algo text not null default 'sha1' check (algo in ('sha1','sha256')),
  kind text,
  size bigint,
  data bytea,
  created_at timestamptz
);
```

### **4.2 References**

```sql
refs (
  repo_id uuid,
  name text,
  target bytea,
  primary key (repo_id, name)
);
```

### **4.3 Semantic Representations**

```sql
representations (
  object_id bytea,
  layer text,
  version text,
  data jsonb,
  primary key (object_id, layer, version)
);
```

### **4.4 Commit Metadata**

```sql
commit_metadata (
  repo_id uuid,
  commit_id bytea,
  namespace text,
  key text,
  value jsonb,
  updated_at timestamptz,
  primary key (repo_id, commit_id, namespace, key)
);
```

This enables structured, evolving annotations such as:

```json
{
  "review": { "status": "approved" },
  "analysis": { "type": "refactor" }
}
```

See §5.1 for the agent episode schema.

---

## **5. Agent Episodes**

Agent episodes are a first-class feature of Sharp, attached to the commits they produced. An episode captures the full lifecycle of an automated change attempt:

- prompts (system, developer, user)
- retrieved context
- tool interactions and traces
- intermediate patches
- candidate snapshots
- validation results (tests, type checks, linters)
- judge/selector outcomes
- the snapshot, if any, promoted as output

Episodes are append-only as facts. The spine of the data model remains the VCS substrate: episodes attach to commits, they do not replace them. An episode is anchored to a parent commit (the state it started from) and, on success, to a promoted commit (the state it produced).

### **5.1 Schema**

```sql
episodes (
  id uuid primary key,
  repo_id uuid not null,
  parent_commit bytea not null,
  promoted_commit bytea,
  agent_identity text not null,
  model_id text not null,
  harness_version text not null,
  tool_versions jsonb not null,
  decoding_params jsonb not null,
  status text not null check (status in ('started','completed','failed','abandoned')),
  started_at timestamptz not null,
  finished_at timestamptz
);
```

```sql
episode_artifacts (
  episode_id uuid not null references episodes(id),
  seq integer not null,
  kind text not null check (kind in (
    'prompt','context','tool_call','tool_result',
    'intermediate_patch','validation','judge'
  )),
  content_ref bytea,
  inline jsonb,
  created_at timestamptz not null,
  primary key (episode_id, seq),
  check ((content_ref is null) <> (inline is null))
);
```

```sql
episode_links (
  from_episode uuid not null references episodes(id),
  to_episode uuid not null references episodes(id),
  relation text not null check (relation in (
    'sibling','retry_of','replay_of','superseded_by'
  )),
  created_at timestamptz not null,
  primary key (from_episode, to_episode, relation)
);
```

`episodes` carries the run-level facts: which commit it started from, which commit (if any) it produced, and the full provenance tuple (model id, harness version, tool versions, decoding params) that defines reproducibility.

`episode_artifacts` is an ordered, typed log of everything observed during the run. Each row is either a `content_ref` pointing at a CAS object or a small `inline` jsonb payload — never both. `seq` preserves intra-episode ordering for replay.

`episode_links` records relationships across episodes. `sibling` connects fan-out attempts that ran from the same parent commit; `retry_of` records resumed or re-attempted work; `replay_of` records re-runs against a different model or harness; `superseded_by` lets a later episode mark an earlier one as no longer canonical.

### **5.2 Storage Strategy for Tool Traces**

A naive design that inlines every prompt, retrieved-context document, and tool output as jsonb on the episode row blows up storage by orders of magnitude under high-fan-out harnesses: the same retrieved document or system prompt is referenced across hundreds or thousands of episodes.

Sharp avoids this by treating large artifact payloads as content-addressed objects. `content_ref` points into the same CAS that stores blobs and trees (§4.1); identical retrieved-context blobs across many episodes deduplicate to one object. Only the pointer and per-episode positional metadata (`seq`, `kind`, `created_at`) live in the row. Small structured records — short tool-call argument dicts, judge scores, validation summaries — go in `inline` to avoid a CAS round trip on the hot path.

This is the same trick that makes Git-style storage cheap, applied to episode traces.

### **5.3 Failed Siblings**

Episodes that did not produce a promoted commit (`status` in `failed`/`abandoned`, or `promoted_commit is null`) remain first-class rows. They are queryable, retain their full artifact log, and are linked to their selected sibling via `episode_links` with `relation = 'sibling'` (or `superseded_by` once a winner is chosen).

This is the negative-example corpus. Training and evaluation pipelines that only see the winning commit lose the signal of what was tried and rejected; Sharp keeps that signal queryable by default rather than discarding it at the harness boundary.

### **5.4 Replay**

An episode's recorded prompts, retrieved context, and tool-call boundary are sufficient to re-run it. Replay holds the inputs constant and varies what the operator wants to evaluate: a different `model_id`, a newer `harness_version`, or a new `decoding_params` configuration.

Replays produce **new** episodes, not edits to old ones. The new episode records its own provenance tuple and is linked back to the original via `episode_links.relation = 'replay_of'`. Bulk replay against a corpus of historical episodes is the killer feature for evaluating model and harness upgrades against real production workloads — without it, every model swap is an unmeasured regression risk.

Replay is a valid controlled comparison only to the extent the input boundary is captured and nondeterminism is pinned: decoding parameters (temperature, seeds), tool-call nondeterminism, and any environment state the run depended on must be recorded or held fixed, or the replay measures noise alongside the change under test. Where an input cannot be captured, the replay is an approximation, not an A/B; §5.6 should mark which provenance fields are reproducibility-load-bearing.

### **5.5 PII and Secrets Handling**

Prompts and tool outputs may contain credentials, customer data, or other sensitive material. Sharp's posture is honest: this is a real risk and Sharp's job is to make handling it **possible and auditable**, not to guarantee perfectly clean data.

Episode artifacts live on the mutable metadata layer (§2.5). Sharp supports redaction policies that scrub original artifact content and replace it with a redacted version, while preserving the episode's structural facts (parent commit, promoted commit, status, timing, links, ordering). Redactions are themselves recorded as audited mutations: who redacted what, when, and under which policy.

Episodes can be flagged as containing secrets and excluded from training-corpus exports by policy (default is opt-in for export; see `docs/v1-plan.md` for the full security and privacy posture).

Defense in depth is recommended: input-side redaction inside the harness, secret-detection scanners at write time, and retention policies on raw traces. Sharp catches what those layers miss; it is not a substitute for them.

### **5.6 Provenance Fields**

To state plainly: model id, harness version, tool versions, decoding parameters, and sampling strategy live on `episodes`, not on commit metadata. The §4.4 `commit_metadata` table is for downstream annotations _about the commit as an artifact_ — review status, analysis tags, eval labels, deployment outcomes — which evolve independently of the run that produced the commit.

---

## **6. Semantic Diff and Merge**

Sharp's merge contract is the central reason an autonomous agent harness can adopt it. The underlying concern is real: in a lights-out harness there is no human to catch a bad merge, and a silent wrong-merge is a production incident. Sharp's answer is a three-tier merge model whose explicit guarantee is that **Sharp never silently picks between two semantically valid resolutions**.

### **6.1 Tier 1 — Deterministic Semantic Merge**

In v1, semantic representations (§2.3) are queryable artifacts _and_ the inputs to merge. Sharp calls `ts.LanguageService.findRenameLocations()` for TypeScript and rust-analyzer's `textDocument/references` for Rust to enumerate every reference that needs updating when a symbol is renamed (`textDocument/rename` is the apply/preparatory call, not the enumeration one). These are the same reference-finding APIs editors drive for F2-rename; Sharp gets correct-by-construction reference lists rather than approximating them. The vast majority of cases that text-merge classifies as conflicts (or, worse, silently mis-resolves) collapse to a single deterministic answer. This is the common path. The corpus expectation is that most scenarios land here.

**Semantic diff** — differences computed and surfaced at the symbol level, in addition to textual diffs — is the user-facing projection of the same machinery.

### **6.2 Intrinsic Verification**

Every candidate merge tree produced by Tier 1 must pass Sharp's **intrinsic structural verification** before being considered a successful merge. This layer uses the language's own diagnostic APIs rather than custom structural checks:

- The merged tree parses cleanly (Tree-sitter for parse-level checks; `ts.LanguageService.getSemanticDiagnostics()` and `getDeclarationDiagnostics()` for TypeScript; `cargo check --message-format=json` for Rust).
- Symbol references in the merged tree resolve against the merged symbol table.
- Function arities and import targets are consistent.
- Cross-file rename propagation, if performed, leaves no dangling references to renamed-away identifiers.

A candidate that fails intrinsic verification is dropped. If only one candidate exists and it fails, Sharp escalates directly to Tier 3 with the verification failures attached.

### **6.3 Hooks (Optional, User-Owned)**

Project-specific or language-toolchain-specific checks — `tsc --noEmit`, `cargo check`, linters, project tests — are **not** part of the merge engine. Coupling Sharp's intrinsic merge correctness to external compilers would tie the engine's contract to versions of toolchains it does not own.

Instead, Sharp supports a hooks system modeled on Git's hooks: per-repository or per-workspace executable scripts triggered by lifecycle events (`pre-merge`, `post-merge`, `pre-commit`, `pre-push`, server-side `pre-receive`). A `pre-merge` hook receives each Tier 1 candidate tree and can veto it (non-zero exit → drop the candidate). Stock hook examples — including the `tsc --noEmit` and `cargo check` integrations — ship under `examples/hooks/` for users who want them; nothing in Sharp's merge engine depends on them.

This separation keeps the merge contract **portable across languages and toolchains** while still making the operationally common practice ("don't merge anything that doesn't compile") trivial to opt into.

### **6.4 Tier 2 — Automatic Downstream Oracle**

When Tier 1 produces more than one candidate resolution, Sharp does not ask the user to choose. It consults the repository's other in-development branches as an oracle. The premise: code on other branches reachable from the same parent is implicit ground truth about how the codebase is actually evolving. A candidate resolution that 3-way-merges cleanly with that evolution is the correct one; a candidate that introduces new conflicts against it is not.

This consultation is automatic and requires no annotation. Operators do not flag oracle branches; agents do not configure scoring weights. Sharp simply uses the DAG it already has.

### **6.5 Tier 3 — Structured Dilemma**

If neither Tier 1+verification nor Tier 2 can pick a winner — or if every Tier-1 candidate fails intrinsic verification or is vetoed by an installed `pre-merge` hook — Sharp returns a **structured dilemma** to the calling agent: which AST nodes are in tension, what the candidate resolutions were, which intrinsic-verification or hook failures each candidate produced, what the oracle path concluded (if anything), and what additional information would resolve the disagreement. Sharp never silently picks one and never emits textual conflict markers in this case.

Tier 3 is expected to be rare in practice. If a category of scenarios reliably falls through to Tier 3, that is a signal that Sharp's semantic model needs strengthening at Tier 1 — not that the model needs scoring knobs or weighted axes. Sharp explicitly **does not** ship a merge-scoring DSL: scoring papers over a weak merge model with calibration; we want the model strong enough that calibration is unnecessary.

### **6.6 Why This Is Safe for Autonomous Use**

The three-tier contract plus intrinsic verification plus opt-in hooks is what makes algorithmic semantic merge tractable in a lights-out setting:

- Tier 1 produces a single answer or no answer — never a coin flip between two valid trees.
- Intrinsic verification ensures any candidate Sharp emits is structurally consistent (parses, symbols resolve) at the AST and symbol-table layer Sharp owns directly.
- Hooks let users layer on toolchain-specific or project-specific checks — typically a compile-or-typecheck step — without coupling Sharp's merge engine to those toolchains.
- Tier 2 uses real history, not heuristics, to break the rare ties that survive both intrinsic verification and any installed hooks.
- Tier 3 escalates to the caller with a precise description of the choice — including any intrinsic-verification or hook failures from rejected candidates — so the agent has enough information to decide rather than guess at conflict markers.

Cross-language algorithmic semantic merge — a single normalized engine spanning unrelated language families — remains out of scope for v1 (§0). Per-language semantic merge for the languages superfield uses internally (TypeScript and Rust; see `docs/test-plan.md`) is what v1 ships.

### **6.7 Continuous Speculative Merge: No Rebases**

A common Git workflow pain — and one Sharp's autonomous-agent target audience cannot afford — is the **rebase on main**. As `main` advances, a feature branch falls behind; eventually the developer must stop, rebase the feature on `main`'s tip, resolve any conflicts that surface, and force-push. The cost is high: history is rewritten (every commit gets a new SHA), signatures break, in-flight reviews are invalidated, parallel work blocks, and — worst for an agent harness — there is no human in the loop to drive the resolution.

Sharp eliminates the workflow entirely. **A feature branch never needs to be rebased on its target.** The mechanism is a primitive Sharp calls **continuous speculative merge**: for any `(feature, target)` pair, Sharp continuously maintains a derived ref `refs/sharp-merged/<feature>--<target>` whose value is the always-up-to-date result of asking the same question the merge engine asks — _are the feature's changes and the target's changes independent?_ — between the feature's tip and the target's tip. Answering it runs the full merge model — Tier 1, intrinsic verification, hooks, Tier 2, Tier 3 — over the two tips (`branch-semantics.md` §5, `semantic-patches.md` §4 frame this as "the independence question, recomputed"). Whenever either side advances, the projection becomes stale and the next read recomputes it as a whole-tree operation over both tips (`scale-limits.md`).

Properties:

- **Feature-branch history is never rewritten.** The feature branch's commits, SHAs, and signed-commit signatures are stable forever. The "rebased" view is a _projection_ of the merge engine's output, not a state of the feature branch.
- **Conflicts surface continuously, not at PR-merge time.** If `main` advances in a way that creates a Tier 3 dilemma against the feature, the dilemma fires on the speculative merge ref _the moment_ the next read happens — not at the moment a developer decides to merge. The agent or operator addresses the dilemma by **adding commits to the feature branch** (or coordinating with whoever moved `main`); never by editing history.
- **Merge time is a no-op promotion.** When the feature is ready to land, Sharp does not re-run merge logic. The speculative-merge ref _is_ the merged state. Promotion is a single CAS that advances `main` to the projection's commit. There is no "rebase, then fast-forward" two-step.
- **Linear projection for Git export.** When Sharp exports the feature to a Git remote (e.g., a GitHub PR), the speculative-merge projection is what gets pushed: a linear sequence of commits applied on top of the target's current tip. This satisfies the GitHub "merge a clean linear PR" workflow _without_ anyone having actually rebased.

The contrast with `git rebase`:

| Concern                                  | `git rebase`                         | Sharp speculative merge                  |
| ---------------------------------------- | ------------------------------------ | ---------------------------------------- |
| Feature-branch SHAs change?              | Yes; old SHAs unrecoverable          | No                                       |
| Signed-commit signatures preserved?      | No                                   | Yes                                      |
| Force-push required?                     | Yes                                  | No                                       |
| Conflict surface time                    | All at once when a developer rebases | Continuously, as `main` advances         |
| Conflict resolution mechanism            | Edit-then-amend, often destructive   | Forward commits to the feature           |
| Compatible with concurrent agent fan-out | No (each rebase blocks others)       | Yes (each branch has its own projection) |
| Audit trail of resolutions               | Lost (history rewritten)             | Preserved (commits + episodes)           |

Implementation outline (full mechanics in `docs/engineering-plan.md`):

- Projections are computed **lazily**. Cached against the (feature_tip, target_tip) tuple; invalidated when either advances; recomputed on next read.
- Multiple targets per feature are supported. A single feature branch can carry projections against `main`, `release/v3`, and any other long-lived branch simultaneously.
- Outstanding dilemmas are queryable via the SQL passthrough: `SELECT * FROM projections WHERE status = 'dilemma' AND branch_ref = 'refs/heads/feature/x'` makes "main moved and our feature is now in trouble" a queryable signal rather than a discovery made at PR-merge time.
- Project-side gates are easy: a `pre-receive` hook on the GitHub-equivalent path can require zero outstanding dilemmas on the speculative merge before a PR is opened.

**Sharp deliberately does not ship a `rebase` command.** Anything that historically required `rebase` — landing a feature against an advanced `main`, producing a clean linear PR, keeping a long-lived feature current — is handled by the projection. The feature branch's actual DAG is preserved. If a use case is found that genuinely requires history rewriting (squash-and-amend before sharing externally, for example), it is layered on as an export-time projection (§7), not as a destructive operation on the source-of-truth branch.

---

## **7. Git Interoperability**

Git interop in Sharp is bounded and one-shot in each direction. Sharp is not a Git client, not a Git server, and does not implement bidirectional sync. The two supported operations exist so that Sharp can adopt existing repositories without forcing a rewrite, and so that completed work in Sharp can be backed up or shared via standard Git remotes.

### **7.1 Import: `sharp git import <url>`**

Ingests an existing Git repository (typically by cloning it once with stock Git tooling and reading the resulting object database). Import preserves the full Git object graph as ingested:

- **Full DAG.** Multi-parent merge commits are preserved as multi-parent commits. Sharp does not flatten history on the way in; that would discard information needed for blame, bisect, and audit.
- **Canonical object bytes.** Blobs, trees, and commits are stored byte-for-byte as Git canonicalizes them, so their SHAs are stable on later export.
- **HEAD and refs.** The repository's HEAD (including its symbolic target) and all refs under `refs/heads/` and `refs/tags/` are imported. Other ref namespaces (notes, replace, forge-specific PR refs) are not in v1.
- **Annotated tags.** Annotated tag objects are first-class and preserved with their signatures.
- **Signed commits.** Signature bytes inside commit objects are preserved verbatim. An imported signed commit re-exports with its signature still valid.
- **Submodules and Git LFS.** Out of scope for v1. Submodule gitlinks (mode 160000) are preserved as tree entries but Sharp does not recursively ingest the submodule. LFS pointer files are ingested as ordinary blobs; the underlying large objects are not fetched. Both are explicit v1 punts (see `docs/v1-plan.md`).

Once imported, the repository lives in Sharp. Continued work — commits, branches, merges, agent episodes — happens against Sharp's substrate. There is no automatic re-pull from the source remote; if upstream advances, the operator runs another targeted import.

### **7.2 Export: `sharp git export <branch> <url>`**

Pushes a completed **linear** Sharp branch to a Git remote as a means of backup or sharing.

- **Linear-only.** A branch is exportable if and only if every commit on it has at most one parent reachable from the export tip. Branches with internal merges are either flattened by the operator first (an explicit `sharp ... --flatten` step that produces a new linear projection) or refused by export. This is the precondition that makes export deterministic and SHA-stable.
- **Byte-canonical Git objects.** Sharp emits exact Git object bytes — correct tree-entry sort, modes (`100644`/`100755`/`120000`/`160000`), commit headers, encoding, and trailing newlines — so the SHAs Sharp computes match the SHAs the remote computes.
- **New commits authored in Sharp are not signed.** Sharp does not hold the operator's GPG/SSH key. If an exported branch contains commits Sharp authored (rather than imported), those commits land on the remote unsigned. Imported commits that already carried signatures retain them.
- **Sharp-native data does not export.** Episode metadata, semantic representations, and mutable commit metadata are Sharp-native. They stay in Sharp; the Git remote sees only the commit graph and source trees.
- **One-shot, not subscription.** `sharp git export` is a one-time push of the named branch state. Sharp does not maintain a continuous mirror. Re-running the command after further work pushes the new state.

---

## **8. Benefits for Agentic Development**

Sharp enables:

- a real VCS substrate that agent harnesses can use directly, without bolting Git onto the side
- structured capture of agent runs as first-class data, attached to the commits they produced
- SQL-queryable development history across commits, episodes, and semantic layers
- semantic representations of code changes available for retrieval, evaluation, and review
- training and evaluation datasets drawn directly from production runs

Rather than treating code changes as text diffs glued to ad-hoc logs, Sharp represents them as structured commits with associated intent, traces, and outcomes.

---

## **9. Companion Documents**

This whitepaper specifies the Sharp protocol. The following companion documents cover the engineering and research surface that sits alongside it:

- **[`docs/v1-plan.md`](./v1-plan.md)** — concrete v1 implementation plan: scope, surface, validation thresholds, phased delivery, success criteria, engineering risks, and the security/privacy posture for the initial release.
- **[`docs/engineering-plan.md`](./engineering-plan.md)** — design-level breakdown of how the v1 plan gets built: storage layer, server HTTP API, client basics, Tree-sitter and merge engine, git compatibility, episode library, analytics, operator CLI, and per-component definitions of done.
- **[`docs/research.md`](./research.md)** — open research questions and post-v1 directions: cross-language semantic merge, control-flow graph analysis, multi-language normalization, episode-retention policy, replay-as-evaluation methodology, and the structured-dilemma format.
- **[`docs/snapshots-vs-patches.md`](./snapshots-vs-patches.md)** — the architectural decision behind §4 and §6: why Sharp keeps a snapshot substrate rather than a Darcs/Pijul patch substrate, how it gets first-class conflicts anyway (via `jj`-style algebraic terms), and why Git/GitHub compatibility is a consequence of that choice rather than its driver.
- **[`docs/test-plan.md`](./test-plan.md)** — the differential test harness driving Sharp's development: scenario fixtures, the Sharp-vs-git two-lane architecture, the three-tier merge contract from a test-correctness perspective, and the corpus that pins down "Sharp is better than git on real merges."
