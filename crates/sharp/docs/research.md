# Sharp Research Directions

This document collects the questions Sharp is **not** answering in v1, but that the design assumes will need to be answered as the system matures. Items here are deliberately out of [`v1-plan.md`](./v1-plan.md) scope. The protocol they extend is in [`whitepaper.md`](./whitepaper.md).

## 1. Cross-Language Semantic Merge

v1 ships per-language semantic merge for TypeScript and Rust. The merge model — Tier 1 deterministic, verification gate, oracle, dilemma — is structurally language-agnostic, but the _semantic representations_ it operates over are not. A single normalized engine spanning unrelated language families (e.g., Python and Go in the same repo, with cross-language refactors) is research, not v1.

Key questions:

- Is there a common-denominator semantic model that meaningfully covers more than Tree-sitter's syntactic level without collapsing to lowest-common-denominator IRs that lose useful structure?
- When a refactor crosses language boundaries (an FFI rename, a JSON-schema change reflected in both a TypeScript client and a Rust server), what is the merge unit? Is it per-language with explicit cross-language constraints, or a unified IR?
- Does the verification gate compose across languages, or do we need a project-level "all-checks-pass" gate?

## 2. Control-Flow Graph Analysis

The verification gate in whitepaper §6.2 catches structural breakage that Tree-sitter parse + compiler check can detect. CFG analysis catches a further class of failures: unreachable code introduced by partial application of a refactor, control flow that no longer terminates, exception paths that no longer reach their handlers, dataflow that bypasses a newly-required validation step.

Open questions:

- Per-language CFG construction is well understood; is the cost of running it on every merge candidate worth the additional class of failures it catches, or does the compiler check already cover the high-value cases?
- For TypeScript and Rust specifically, what's the marginal value over `tsc --noEmit` / `cargo check`?
- Does CFG-level diff produce a useful signal for Tier 2 oracle resolution, or only for verification?

## 3. AST Stability Across Tree-sitter Grammar Bumps

Sharp caches semantic representations keyed on object IDs. A Tree-sitter grammar update changes the AST shape for the same source bytes, invalidating the cache. The naive fix — version the cache and recompute on bump — is fine at small scale, but at repo scale (millions of parse trees) it becomes a real cost.

Open questions:

- Can Sharp version semantic representations against the grammar version that produced them, and lazily invalidate only when a query needs the new shape?
- Is there a stable "canonical AST" abstraction above the raw Tree-sitter parse that survives grammar bumps?
- What's the right migration UX when a grammar bump _changes_ a merge outcome on a previously-resolved scenario?

## 4. Multi-Language Semantic Normalization

Closely related to §1 but narrower: even within a single repo containing only TypeScript and Rust, the semantic representations are language-specific (different symbol tables, different reference resolution rules, different visibility models). A unified query layer would let operators ask "all callers of function X across languages" in one SQL query.

Open questions:

- What's the minimum viable cross-language symbol model that's useful without being misleading?
- How do FFI boundaries appear in the unified model?
- Does this layer subsume §1, or is it strictly weaker?

## 5. Episode Retention Under High-Fan-Out Harnesses

A harness running thousands of fan-out attempts per task generates massive episode volumes. v1 partially addresses storage overhead via CAS dedup of artifact payloads (whitepaper §5.2), but the retention policy itself is open: when (if ever) does Sharp let go of failed-sibling episodes?

Open questions:

- Is there a principled policy ("keep failed siblings for N days, or until M successful descendants exist") or is this purely operational?
- If episodes are pruned, what summary survives — enough for negative-example training, enough for debugging, both, neither?
- Does the value of replay (whitepaper §5.4) imply we should never prune, only tier-cold-storage?

## 6. Replay-as-Evaluation Methodology

Whitepaper §5.4 commits to replay as a primitive: re-run an archived episode against a different `model_id` or `harness_version` to measure regressions. The **mechanism** is in v1; the **methodology** is not.

Open questions:

- What's the right metric for "the replay succeeded"? Producing the same commit is too strict; producing a commit that passes the same validators is more useful but susceptible to flaky tests.
- How many episodes do you need to replay to make a model-upgrade decision with confidence? What's the statistical floor?
- When replay outcomes diverge across models, what do you report — pass-rate delta, judge-score delta, downstream-validator delta, all three?
- Does replay-as-eval need its own DSL, or does ad-hoc SQL plus a small reporting harness cover the cases that matter?

## 7. Tier 3 Dilemma Format

Whitepaper §6.4 commits to returning a structured dilemma when neither deterministic merge nor the oracle can pick a winner. The shape of that dilemma is unspecified.

Open questions:

- What's the smallest set of fields that lets a calling agent make a real decision? At minimum: the candidate trees, the AST nodes in tension, what the verification gate said about each candidate, what oracle branches were consulted and what each said.
- Is the dilemma a one-shot return value, or an interactive negotiation (the agent asks Sharp to elaborate on one candidate, run a different verifier, etc.)?
- How is a dilemma resolution recorded for future replay or training?

This blocks Phase 3 of v1 in the merge-implementation sense; the format itself can be refined past v1 once real dilemmas appear in the corpus.

## 8. Validating the Premises

The whitepaper makes several empirical claims that should be re-checked once Sharp has shipped and is in use:

- **The semantic-merge value claim.** "Most of the corpus lands at Tier 1." Is that actually true on real-world (not seeded) workloads?
- **The Tier 3 rarity claim.** "Tier 3 is expected to be rare." If it isn't, the model needs strengthening, not knobs — but we should know whether the rarity assumption holds before extrapolating.
- **The replay-utility claim.** Does replaying historical episodes against newer models actually produce useful regression signal, or does model drift make the comparison meaningless past a certain interval?
- **The Postgres-as-store claim.** The v1 thresholds (`v1-plan.md` §3) are the operational test. If Postgres is the wrong store at scale, what's the right one — and does Sharp's hash-and-schema design transfer?

These are not blockers for v1 — v1 ships and we measure — but they are the first set of questions to ask once Sharp is live somewhere real.

## 10. Language Server Integration — Known Gaps

Sharp's language-server-first architecture (§2.1 of the whitepaper, §6 of the engineering plan) delegates semantic analysis to production-grade toolchains rather than reimplementing it. The following gaps are known and must be closed as the implementation matures:

**Multi-file LanguageServiceHost.** The current TypeScript implementation in `apps/client/src/semantic/symbols.ts` uses a single-file host — it provides the TypeScript compiler with only the file being analyzed, not the full project. Correct cross-file rename propagation requires upgrading the host to pass the full materialized candidate tree as a virtual project, so that `findRenameLocations()` returns references in files other than the one being renamed. Without this, cross-file renames return incomplete edit sets.

**rust-analyzer LSP subprocess.** Spawning rust-analyzer introduces initialization latency (project discovery and initial indexing can take several seconds on a large crate graph), requires clean shutdown on cancel or timeout, and must handle the case where rust-analyzer is not installed. Sharp needs a retry/fallback strategy when the subprocess fails to initialize within a deadline, and must record the rust-analyzer version in the semantic representation's `version` column for cache invalidation.

**Call graph analysis.** Using `callHierarchy/incomingCalls` (TypeScript) or rust-analyzer's equivalent to assess a change's blast radius before attempting Tier 1 merge. The open questions: at what depth should the call graph be walked, how are indirect calls (higher-order functions, dynamic dispatch) represented, and when does the blast radius exceed what Tier 1 can safely handle (warranting an early Tier 3 escalation)?

**Languages without LSPs.** For languages that have no mature language server, Sharp falls back to Tree-sitter for parse-level checks and treats symbol extraction as best-effort. The graceful fallback strategy is: tree-sitter parse check passes → allow merge with a warning that semantic verification was skipped; tree-sitter parse fails → drop candidate and escalate to Tier 3 as a conflict. This boundary needs to be documented and enforced consistently.

**Cross-language LSP federation.** When a TypeScript client calls a Rust library (via Wasm, FFI, or generated bindings), neither the TypeScript language service nor rust-analyzer sees the full picture. A rename on the Rust side that changes the exported symbol name requires updates in the TypeScript caller that neither LSP will automatically surface. This is a structural gap in the language-server model for polyglot repos. The v1 answer is to surface this as a Tier 3 dilemma when cross-language references are detected; a deeper solution (a cross-language reference oracle) is post-v1 research.

## 9. Other Open Threads

- **Closed-loop learning from deployment outcomes.** Originally proposed and then cut for being out of scope (it crosses into MLOps territory). If episode replay matures into a real eval methodology, this might re-enter scope as the obvious extension.
- **Multi-tenant cryptographic isolation** (`v1-plan.md` §8.6) — probably v2 engineering, not research, but the threat model that motivates it is research-shaped: under what assumed adversary do current Postgres-level isolation guarantees fall short?
- **Real-world-conflict mining** — the test plan's Phase 4 calls for reducing OSS merge incidents into harness fixtures. The reduction methodology (dependency stripping, name anonymization, minimum-failing-subset selection) is itself a small research project.
