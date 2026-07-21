# Sharp: the VCS protocol for AI-native development

> **Scope note.** This document mixes two epistemic levels and labels them
> throughout. **[v1]** marks behavior implemented today in `crates/sharp` and
> cited to source; every [v1] claim is checkable by reading the named module.
> **[design target]** marks the protocol this document specifies: internally
> consistent, deliberately bounded, and not claimed to exist. The line between
> the two is the credibility of everything else here, so it is never blurred.
> Companion deep-dives: the formal model of operations and independence is
> `semantic-patches.md`; branches, phases, and the plan loop are
> `branch-semantics.md`.

## Abstract

Sharp is a version control protocol for development done primarily by agents,
with humans reviewing, steering, and owning policy. Its foundational claim is
narrow: a merge conflict is not a property of two changes, but of two changes
*and the representation in which the VCS compares them*. Line-based comparison
uses lexical adjacency as a proxy for independence — a proxy that manufactures
conflicts between unrelated adjacent edits and misses conflicts between
distant, semantically interfering ones. The correct representation is
symbol-level access sets: each change carries a **footprint** — read and write
sets over symbols, signatures, and type contracts — and two changes commute
exactly when the Bernstein conditions hold. When they do not, the conflict is
a *nameable* fact ("op A writes `foo`'s signature; op B reads it"), never a
pair of text markers.

Two conditions that did not hold in 2005 make this buildable now: the caller
is an agent, so footprints can be **captured at operation time rather than
reconstructed from text**; and language servers — funded by the IDE market —
already answer the reference-level questions the comparison needs. Sharp is
deliberately small where it must be trusted: a kernel of six verbs holds all
authority; a per-language oracle holds all semantic complexity and is trusted
only in the safe direction; an advisory layer holds all intelligence and never
acts. What ships today [v1] is a snapshot-based store with a three-tier merge,
a compile-refusal gate enforced in CI, continuous speculative merge
projections, agent episodes, and bounded Git interop. What the protocol
specifies beyond that [design target] — branch fission, dynamic phases, a
closed-loop plan — is a capability ladder whose every rung composes from the
same six verbs. The boundaries section states plainly what none of this
guarantees.

---

## 1. The root axiom

**A merge conflict is not a property of two changes. It is a property of two
changes and the representation in which the VCS compares them.** The same pair
of edits conflicts or does not depending on the altitude of the comparison,
and line-based comparison fails in both directions at once:

- **Manufactured conflicts.** Two edits to unrelated functions on adjacent
  lines collide under three-way text merge while interfering in no semantic
  sense. The substrate reports a conflict the program does not contain.
- **Missed conflicts.** One change narrows a function's return type; another
  adds a caller binding the old type. Zero textual overlap; the merge is
  "clean" and does not compile. The substrate certifies a merge the program
  *does* conflict about.

Both failures have one cause: the only question that decides a merge — *are
these two changes independent?* — is answered with the wrong proxy. Line merge
approximates a semantic relation (do the changes touch the same symbol's
meaning, the same type's contract, the same reference?) by lexical adjacency
(do they touch the same or neighboring lines?). The proxy is simultaneously
unsound and incomplete, and the gap between proxy and question is exactly
where silently broken merges live.

A human tolerates the proxy because a human reads every conflict the substrate
raises and silently repairs the ones it misses — the human *is* the semantic
layer the VCS omits. Remove the human, as agent harnesses do at machine speed,
and both failure modes go unhandled. The substrate must compute the relation
itself.

### 1.1 The correct representation

The representation that answers the independence question is the symbol-level
access set. Each change T carries a **footprint**: a read set R(T) and a write
set W(T) over symbols, signatures, and type contracts. Two changes are
independent — they **commute** — exactly when the Bernstein conditions hold:

> W(T₁) ∩ W(T₂) = ∅  and  W(T₁) ∩ R(T₂) = ∅  and  R(T₁) ∩ W(T₂) = ∅.

This is conflict-serializability from database concurrency control, applied
to the symbol graph. It explains both failure modes at once: adjacent lines
with disjoint footprints commute (the manufactured conflict dissolves), and a
return-type narrowing writes a signature some distant caller reads (the missed
conflict is caught, because the intersection is non-empty). A non-empty
intersection is a genuine, *nameable* semantic conflict, reported as the
symbols in tension. The full formal treatment — operations, footprint algebra,
and the serializability argument — is `semantic-patches.md`, "Operations and
footprints" and "Independence as conflict-serializability".

The claim stays bounded. Moving the comparison from line to symbol dissolves
the *spurious* conflict class — the one lexical adjacency manufactures. It
does not dissolve *genuine* semantic disagreement, where two changes truly
cannot both stand; those become precisely named dilemmas instead of text
markers. The empirical split between spurious and genuine in real agent
traffic is an open quantity Sharp commits to measuring, not assuming
(`semantic-patches.md`, "Validation: the base-rate experiment"; §6.3 below).

### 1.2 Soundness: the tri-state certificate

Static analysis has blind spots — macros, code generation, reflection,
cross-language seams — and analyzers do *not* reliably flag their own blind
spots: an empty references answer is indistinguishable from an incomplete one.
A system that treated "the analyzer found nothing" as "nothing is there" would
be unsound exactly where codebases are trickiest.

Sharp's discipline [design target] is therefore that independence certificates
are **tri-state**: *proven-independent*, *proven-conflicting*, or *unknown* —
with known blind-spot categories forced to *unknown by construction*, and
*unknown* treated as dependent. The analyzer is trusted only in the safe
direction: references it finds create dependencies; references it fails to
find prove nothing. A macro-heavy change does not get a clean certificate; it
gets an honest *unknown* and serializes conservatively. The trust rule and
its consequences are specified in `semantic-patches.md`, "Soundness and the
tri-state certificate".

---

## 2. Why now

Semantic merge is not a new idea; the structured-merge literature studied it
for three decades and the commercial attempts stalled. Two conditions have
changed since git was designed in 2005, and Sharp's viability rests on both.

### 2.1 The caller is an agent: capture, not reconstruct

Recovering a canonical semantic diff from two arbitrary text states is the
hard direction — in general intractable, and in practice the reason
structured-merge engines are expensive and partial. But when the author is an
agent issuing tool calls, the operations do not need to be reconstructed; they
can be **captured** at issue time. A rename issued through a footprint-aware
`rename` tool call carries its footprint by construction: the tool consulted
the language server, so the reference set is a byproduct of doing the work,
not a forensic recovery afterward.

Two honesty requirements bound this claim. First, capture happens by
**voluntary adoption**: Sharp offers footprint-aware tooling that makes agents
land faster, not a coerced operation vocabulary — an agent that edits raw text
is still served, just with weaker certificates. Second, free-form body edits
still require partial reconstruction, and their footprints may be
*unknown*-heavy; the capture story is strongest for structural operations and
degrades honestly from there. See `semantic-patches.md`, "Capture, not
reconstruction".

### 2.2 The oracle exists: the second client of the LSP investment

The semantic questions a footprint needs answered — what references this
symbol, what is this signature, what breaks if it changes — are exactly the
questions language servers answer for IDEs, and the IDE market funds their
maintenance per language. rust-analyzer and `tsserver` exist, are production
grade, and track their languages because millions of editor sessions depend on
them. Sharp is the **second client of the LSP investment**: it borrows a
semantic engine per language rather than building one, which is the difference
between a per-language integration cost and a per-language compiler-team cost.
This dependency is real and it sits in the merge path; its operational
consequences are stated in §6.4, not hidden.

---

## 3. The protocol

Sharp assigns complexity by principle, in three layers.

### 3.1 The trichotomy

- **Kernel** — dead simple, authoritative, deterministic. It owns objects,
  refs, and merge admission. It is the only component whose failure corrupts
  state, so it is the component kept small enough to trust.
- **Language-server oracle** — the complexity sink. All "what does this change
  touch" semantics live here. It is complex, external, per-language, and
  *allowed to be incomplete*, because the kernel wraps it in the tri-state
  discipline of §1.2: oracle findings create dependencies; oracle silence
  proves nothing.
- **MCP advisory layer** — the intelligence. It suggests, explains, and
  forecasts ("this edit conflicts with two in-flight branches; an additive
  alternative lands today"). It **never acts**. The developing agent decides.
  A bad tip costs efficiency, never correctness.

Three principles govern the assignment. *Failure severity must be inversely
proportional to component complexity*: the components allowed to be complex
are exactly the ones allowed to be wrong. *Layers are separated by rate of
change*: the kernel protocol should evolve on the timescale of decades,
language semantics with their languages, intelligence monthly. And the
**kernel admission rule**: an operation enters the kernel only if it needs
*authority* over objects and refs; if it needs only *intelligence*, it is an
advisory-layer composition of kernel verbs.

### 3.2 The six verbs

The kernel's surface [design target; v1 realizations in §4]:

1. **put/get object** — content-addressed storage and retrieval.
2. **commit(tree, parents)** — record a snapshot with provenance.
3. **ref CAS update** — the only mutable state, advanced by compare-and-swap.
4. **merge(base, ours, theirs)** → `CleanOk | Dilemma | Refused` — the
   admission test. `Dilemma` is a structured, named conflict report;
   `Refused` means the result failed verification and was never stored.
5. **projection query** — read the continuously maintained speculative merge
   for a (feature, target) pair, including its outstanding dilemmas.
6. **episode append** — append to the immutable record of an agent run.

Compare git's roughly 150 porcelain commands. The difference is not ambition
but caller: git encoded workflows in porcelain because its caller was a human
at a terminal who needed `rebase`, `cherry-pick`, and `stash` as named
recipes. Sharp's caller is an agent with ambient intelligence; workflows are
synthesized client-side from primitives, and the advisory layer is where the
recipes live. Notably, the capability ladder of §5 — including branch fission
— adds **no seventh verb**: every rung is a composition of these six.

---

## 4. Sharp v1: what exists today

Everything in this section is [v1] — implemented in `crates/sharp`, checkable
by reading the cited module. It is also honestly partial: **v1 does not
compute footprints or Bernstein certificates.** v1 is a snapshot-based store
whose merge decides independence by three-way classification, rust-analyzer-
informed rename semantics, tree-sitter AST equivalence, and a compile-refusal
gate. It is the kernel's first realization, not the protocol's full extent.

### 4.1 The three-tier merge

The unified Tier-1 driver (`src/tier1.rs`) runs, in order: three-way per-path
classification of (base, A, B); file-level rename redirection (Jaccard
similarity, `src/file_rename.rs`), so a delete-plus-edit that is really a
move routes content to the new path instead of escalating; symbol-rename
propagation; whitespace-equivalence via tree-sitter token streams
(`src/ast_equivalence.rs`), so a pure reformat yields to the semantic side
without falsely equating changed string literals; and concat-additions when
both sides only added lines. Its outcome is `CleanOk`, `Dilemma`, or
`Unhandled` — never a silent pick and never text conflict markers.

Two precision notes, because they mark the v1/design-target line. Rename
*detection* is semantic: the Rust path (`src/semantic_merge.rs`) asks
rust-analyzer for the rename-location set of each touched symbol, and the
TypeScript path (`src/semantic_merge_ts.rs`) drives the tsserver bridge. Rename
*application* in the unified driver is a whole-word text rewrite of the
detected name — informed by the language server, executed at text level. And
the Tier-1 baseline under the rename pass is a standard three-way text merge.
v1 is a semantic *decision* layer over a textual *mechanism*; the operation-
native mechanism is the design target of `semantic-patches.md`.

**The verification gate.** For Rust, every candidate merge runs
`cargo check --message-format=json` (`src/cargo_check.rs`) before storage; a
non-zero result refuses the merge with the diagnostics attached
(`SharpError::MergeRefused`, `src/semantic_merge.rs`). This is the
no-non-compiling-merge guarantee, and it is CI-enforced, not asserted: the
`sharp-merge-guarantee` job in `.github/workflows/rust.yml` — a required
branch-protection context — provisions rust-analyzer and cargo and executes
the refusal proofs in `crates/sharp/tests/integration.rs` plus the scenario
corpus, with a non-zero executed-test count required. A green check means the
refusal path actually ran. Project-specific checks beyond the intrinsic gate
are user-owned pre-merge hooks (`src/hooks.rs`); a hook veto converts a clean
candidate into a dilemma rather than silently passing it.

**Tier 2 — oracle scoring** (`src/oracle.rs`). When Tier 1 yields more than
one verified candidate, Sharp scores each against the repository's other
in-development branches — implicit ground truth about how the codebase is
actually evolving — by counting hard-conflict classifications
(`both_different`, `a_added_b_added_diff`) between (base, candidate, oracle).
Lowest score wins; a tie is a dilemma. No annotation, no scoring weights, no
merge-scoring DSL: if a scenario class reliably reaches Tier 3, the fix is a
stronger Tier 1, not calibration knobs.

**Tier 3 — structured dilemma** (`src/tier1.rs`, `DilemmaPayload`). When no
tier can pick a winner, the caller receives the reason, the candidate
resolutions with stable identifiers, and the involved paths — enough to
decide, rather than a pair of `<<<<<<<` markers to parse. The v1 payload is
path-and-candidate granular; symbol-granular dilemmas ("op A writes `foo`'s
signature; op B reads it") arrive with footprints [design target].

The production entry point is `src/merge_flow.rs`: repo registration, the
semantic merge with the compile gate, and episode recording in one pipeline.
It is the self-hosting gate — Sharp merges its own crate's source through it.

### 4.2 Projections: continuous speculative merge

For any (feature, target) pair, Sharp maintains the merge result as a lazy,
continuously refreshed **projection** (`src/projections.rs`): a row keyed by
(repo, branch ref, target ref) whose status is `clean` (with the merged
commit), `dilemma` (with the payload), `stale`, or `error`. A database trigger
marks projections stale when either input ref advances; the next read
recomputes. Consequences, the first two real today at v1's text-tier fidelity:

- **Feature branches never rebase.** History is never rewritten; the
  "current against target" view is a derived projection, not a mutation.
- **Conflicts surface at authoring time**, not at land time: outstanding
  dilemmas are a queryable signal a pipeline polls, not a discovery made when
  someone finally clicks merge.
- **Landing is promotion** [design target]: the projection *is* the merged
  state, so landing is a ref CAS advancing the target to the projection
  commit, not a re-run of merge logic. v1 stores the merged commit in the
  projection row but does not yet implement the promotion CAS
  (`projections.md`).

v1 bounds worth stating: the Rust port's per-path combine is the text-level
three-way merge, and it approximates the merge base with the target ref — a
real lowest-common-ancestor walk is a tracked follow-up (`src/projections.rs`
port notes). Recompute is whole-tree; incrementalization is an open cost
question, and keeping language servers warm per (feature, target) is the
intended amortization (§6.4). Full treatment: `projections.md`, and
`branch-semantics.md`, "The generalized merge queue".

### 4.3 Episodes

Sharp records agent runs as first-class, queryable data (`src/episode.rs`;
schema in `crates/sharp/migrations/`, canonical doc `episodes.md`). An episode
anchors to the commit an agent started from and, on success, the commit it
produced; an append-only event log captures prompts, tool traces, intermediate
patches, validation results, and judge outcomes, with large payloads
deduplicated into the same content-addressed store as blobs. Failed siblings —
fan-out attempts that lost — remain queryable with full traces: the negative-
example corpus harnesses otherwise discard. Episode links relate siblings,
retries, and replays.

Replay — re-running a recorded episode against a new model or harness — is a
valid controlled comparison only to the extent the input boundary was captured
and nondeterminism pinned (decoding parameters, tool nondeterminism,
environment state); where an input was not captured, replay is an
approximation, not an A/B. Prompts and traces can contain secrets; redaction
is a first-class, audited mutation on the mutable metadata layer, and Sharp is
a backstop for harness-side scrubbing, not a substitute for it.

### 4.4 Git interop

Sharp is built for a long transition in which GitHub, review, and CI remain
the ecosystem. Interop is bounded and one-shot in each direction
(`src/git_interop.rs`, `src/git_canonical.rs`; canonical doc
`git-interop.md`):

- **Import** reads the Git object store directly (loose and packed objects,
  no `git` subprocess), verifies each payload against its SHA-1, and preserves
  the full DAG — multi-parent merges, annotated tags, signed-commit bytes —
  so blame, bisect, and audit survive ingestion.
- **Export** is linear-only: it walks the parent chain, refuses any
  multi-parent commit, and emits byte-canonical loose objects — the resulting
  repo passes `git fsck`, and SHAs match what Git would compute, so exported
  work lands on a standard remote with stable identity.

Sharp's object IDs *are* Git's object IDs (SHA-1 by default, matching Git's
own default posture; SHA-256 per Git's transition format). One correction to
earlier drafts: v1 uses the standard `sha1` crate and **defers the SHA-1DC
collision-detection posture**; hardened intake is a tracked decision, not a
shipped property. Submodule recursion and LFS object fetch are explicit v1
punts. There is no bidirectional sync and no Git server; those are non-goals.

---

## 5. What the protocol unlocks

Everything in this section composes from the six verbs of §3.2. The first
rung is [v1]; every rung after it is [design target] with its deep-dive in a
companion document. The ladder is ordered so that each rung is useful alone
and none requires the ones above it.

**No-non-compiling-merge** [v1]. The intrinsic verification gate: for Rust, a
merge that fails `cargo check` is refused before storage, CI-enforced (§4.1).
This rung already changes agent economics — a harness cannot ship a textually
clean, semantically broken merge.

**Continuous speculative merge** [v1 at text-tier fidelity]. Projections keep
every (feature, target) merge current and make dilemmas a polled signal
(§4.2). Feature branches never rebase.

**The generalized merge queue** [design target]. A classic merge queue is the
degenerate case of Sharp's admission test: the check runs once (at land time),
the granularity is the whole PR, the certificate is a CI bit, the order is
FIFO. Sharp relaxes all four — continuous instead of once, symbol-granular
instead of PR-granular, named structural certificates instead of a green bit,
any linearization of the dependency poset instead of FIFO. A thin final CI
gate survives, deliberately (§6.1). Deep-dive: `branch-semantics.md`, "The
generalized merge queue".

**Branch fission** [design target]. A branch is a set of operations with an
internal dependency poset (`branch-semantics.md`, "Branches as sets"). Given
the conflict set C named by projections, the **landable prefix** is
L = O ∖ ↑C — everything except the conflicting operations and their forward
slice. Land L now; defer ↑C as a new branch with a machine-named blocker.
This is program slicing applied to merge scheduling, and it needs no new
kernel verb: fission is a partition plus two merges, and the existing gate
refuses any cut whose landed half does not stand alone. Agents self-shape
branches to the frontier; greedy local landing decongests globally, the way
fine-grained locking outperforms coarse locks. Deep-dive:
`branch-semantics.md`, "The landable prefix and fission".

**Additive-first design pressure** [design target]. Purely additive
operations — new definitions, unreferenced symbols — are always in L; what
defers is the wiring: edits to shared call sites and hot signatures. An agent
optimizing landable-prefix size is therefore pushed toward
branch-by-abstraction — the discipline trunk-based development preaches, now
with a machine-checkable criterion and a realtime incentive gradient. The
advisory layer makes the gradient legible: "your edit rewrites `foo::bar`'s
signature, which is in 3 live write-sets; an additive alternative lands
today, switchover deferred." The same signal works pre-code (the frontier is
queryable at design time) and for human developers (as PR annotations). The
gaming risk this creates is a stated boundary (§6.6).

**Dynamic phases** [design target]. A phase stops being an upfront
bin-packing guess and becomes an **online admission controller against the
live frontier** — the union of footprints of all in-flight branches. Admitting
an emergent
feature is an intersection test: disjoint means admit; overlap means a named
dilemma and a defer/demote with a machine-named reason. Formally, a **dynamic
phase** is a maximal antichain of the dependency poset that is also an
independent set of the interference graph. Deep-dive: `branch-semantics.md`,
"Dynamic phases".

**The bidirectional plan↔code loop** [design target]. The plan is a
*hypothesis about footprints*; brokered operations are the *measurement*;
reconciliation is the posterior. The update rule is asymmetric: a realized
footprint that exceeds its declaration tightens the plan immediately
(re-check independence, add the edge or demote); a realized footprint smaller
than declared loosens only at declared-complete, because mid-flight footprints
are lower bounds. When fission splits a branch, the tracking issue co-splits —
"substrate of X" closes on landing L; "wire X" is born with a machine-named
blocker. Sovereignty is two-layer: the **necessity structure** (dependencies
and interference) is code-derivable and machine-updated; the **policy order**
(land the refactor first, hold for review, release trains) is
human-sovereign — it may extend the semantic poset, never contradict it, and
machines may inform it but never overwrite it. Deep-dive:
`branch-semantics.md`, "The plan loop" and "Policy order".

---

## 6. Boundaries

Each boundary below is a limit Sharp designs around, not a caveat appended
after the fact. Restating them plainly is the persuasion strategy.

### 6.1 The type-level ceiling

Sharp guarantees (1) *consistency* — the merge result is deterministic and
order-independent when access sets are disjoint — and (2) *reference- and
type-level correctness* — the result parses, resolves its references, and
passes the language's diagnostics. It does **not** guarantee (3) *behavioral
correctness*, and cannot from the access-set model alone: two changes with
disjoint symbol footprints can commute, compile, and still jointly violate a
runtime invariant the type system does not encode — a DB schema assumption, a
wire-protocol contract, a config coupling, an ordering or resource budget.
The §1 missed-conflict example is caught *because* a return-type narrowing is
a type-level dependency; a purely behavioral dependency would pass both the
footprint check and the compile gate. Behavioral verification stays in CI:
executed-in-CI assertions are the *complement* of the independence
certificate, never replaced by it. This is why the generalized merge queue
keeps a thin final CI gate.

### 6.2 Cross-language and resource seams

Symbol graphs are per-language, and the costliest conflicts in real systems
live at seams no language server owns: two services migrating the same
database table, two branches editing the same config key, an API producer and
consumer in different languages. The design direction is to extend footprints
with **declared named resources** — `writes: table users`, `reads: config
RATE_LIMIT`, `touches: endpoint /v1/x` — cheap for an agent to declare and
aimed precisely at the conflicts that matter most. Declared resources are
only as sound as the declarations; they widen coverage, they do not close it.
See `semantic-patches.md`, "Resource-extended footprints".

### 6.3 Read-set explosion

Honest read sets can be large — a change that reads a hot type touches, by
the Bernstein conditions, everything that writes it — and a saturated
frontier serializes all work; trimmed read sets restore concurrency by
breaking soundness. Whether real concurrent development is mostly
Bernstein-independent is an *empirical* question, and Sharp commits to
measuring it before claiming it: mine git history for temporally overlapping
merged PRs, compute retroactive footprints, and measure the independence base
rate. That experiment is the committed validation plan of
`semantic-patches.md`, "Validation: the base-rate experiment"; until it
reports, the concurrency win is a hypothesis with a stated test, not a
result.

### 6.4 An oracle in the merge path

With footprints computed by language servers, a merge is no longer a pure
computation over stored objects: a live analyzer with a loaded workspace sits
in the path, bringing latency, warm-up, and flakiness. Projections amortize
this by keeping servers warm per (feature, target), but two disciplines are
required regardless. **Replayability requires pinning**: the merge record
carries (oracle, version), because a merge that is `CleanOk` under
rust-analyzer 2026.1 may be `Dilemma` under 2026.2 — an unpinned certificate
is not reproducible. And there is an explicit **degradation ladder**: a
language without a capable LSP falls back to text three-way merge with every
footprint entry marked *unknown* — degrade honestly, never silently. See
`semantic-patches.md`, "Oracle discipline".

### 6.5 Complexity is relocated, not eliminated

Sharp does not make merge complexity disappear. It relocates it to where it
is cheapest to maintain — the language-server oracle, funded by the IDE
market — and where it is safest to get wrong — the advisory layer, whose
errors cost efficiency, never correctness. The kernel stays small because the
other two layers absorb what it refuses to contain.

### 6.6 Wiring debt

If landing is the reward, agents will land trivial additive substrate and let
switchovers rot — the additive-first gradient of §5 has a gaming mode. The
deferred wiring issue is therefore the visible debt instrument: it is aged,
it is alarmed on, and the metric that counts is wiring issues *closed*, not
substrate segments landed. Dormant substrate must not fake test coverage:
behavioral acceptance tests attach to the wiring issue, so it cannot close on
a green run that never executed the feature. See `branch-semantics.md`,
"Failure modes".

### 6.7 Adoption path: advisory before authoritative

No stage of Sharp's rollout asks for trust ahead of evidence. The order is:
(1) run the history experiment of §6.3; (2) ship footprint-overlap prediction
as advisory PR annotations and measure precision and recall against actual
conflicts and post-merge breakage; (3) only then let footprints gate
admission; (4) only then derive plan structure from them. Each step is
falsifiable and independently useful; a failure at any step stops the ladder
without stranding the steps below it.

### 6.8 Control-loop damping

A plan that reacts in realtime to fluctuating footprints thrashes. Three
dampers: footprints ratchet outward until explicit checkpoints rather than
oscillating; demotion requires a dilemma that persists across N projection
refreshes, not a transient; and fission deliberately moves fast dynamics into
the agent (local response) instead of the planner (global reshuffle). A
machine-derived plan ships with a derivation explainer, or humans will route
around it. See `branch-semantics.md`, "The plan loop" and "Failure modes".

---

## 7. Positioning

The honest baseline is not vanilla git. It is the **merge queue** — bors,
GitHub's merge queue — which already provides CI-gated, behaviorally covered
integration of concurrent work. Against that baseline, Sharp's differential
is specific: **earlier signal** (authoring-time, continuously, instead of
land-time, once), **named reasons** (a dilemma that says which symbols are in
tension, instead of a red CI bit), **no-rebase development** (projections
instead of history rewriting), and **sub-PR granularity** (fission lands the
independent prefix instead of blocking the whole PR).

> **Sharp is a merge queue whose admission test runs continuously at symbol
> granularity during development — so plans no longer encode conflict
> avoidance, only intent.**

The reframe that follows: Sharp is not a better merge tool. It is **the
concurrency runtime for a development plan, with semantic independence as its
soundness invariant** — and the closed-loop observer that keeps the plan
true. What ships today [v1] is the kernel of that runtime: the refusal gate,
the projections, the episode record. What the rest of this document specifies
[design target] is the runtime's full contract, bounded exactly as stated in
§6.

---

## 8. Companion documents

- **[`semantic-patches.md`](./semantic-patches.md)** — the formal model:
  "Operations and footprints", "Independence as conflict-serializability",
  "Soundness and the tri-state certificate", "Capture, not reconstruction",
  "Resource-extended footprints", "Oracle discipline", "Validation: the
  base-rate experiment".
- **[`branch-semantics.md`](./branch-semantics.md)** — branches, phases, and
  the plan: "Branches as sets", "The landable prefix and fission", "The
  generalized merge queue", "Dynamic phases", "The plan loop", "Policy
  order", "Failure modes".
- **[`projections.md`](./projections.md)** — the v1 projection mechanics.
- **[`episodes.md`](./episodes.md)** — the episode data model and lifecycle.
- **[`git-interop.md`](./git-interop.md)** — import/export mechanics and the
  byte-canonical object contract.
- **[`postgres-storage-plugin.md`](./postgres-storage-plugin.md)** — the v1
  storage schema, presented as one swappable substrate's implementation.
- **[`v1-plan.md`](./v1-plan.md)**, **[`engineering-plan.md`](./engineering-plan.md)**,
  **[`test-plan.md`](./test-plan.md)** — scope, build order, and the
  differential test corpus for v1.
- **[`research.md`](./research.md)** — open questions beyond this document's
  design targets.
