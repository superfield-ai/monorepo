# Semantic Patches: The Post-v1 Fork Where the Store Becomes the Code Graph

Sharp v1 decides merges at semantic altitude over a **snapshot** store (whitepaper §1.1,
[`snapshots-vs-patches.md`](./snapshots-vs-patches.md)). This document analyzes the
distinct, larger decision Sharp does **not** take in v1: making the canonical stored unit
itself semantic — history recorded as first-class **symbol-level operations** over a code
graph, with snapshots demoted to an export projection.

It is the unoccupied lower-right cell of the
[`comparison-merge-theories.md`](./comparison-merge-theories.md) §4.5 matrix. The purpose
here is not to commit to it. It is to state it precisely enough that the decision can be
made on evidence: what it buys that v1 cannot, what single problem it stands or falls on,
why that problem is uniquely tractable for an agent-first system, and what would have to be
true before Sharp moved.

---

## 1. The two axes, and the cell no one occupies

Two independent axes govern a merge substrate (`comparison-merge-theories.md` §4.5):

- **Unit of history** — a _snapshot_ (store states, derive diffs: Git, `jj`) or a
  first-class _patch_ (store changes, derive states: Darcs, Pijul).
- **Merge altitude** — _lexical_ (lines: every system above) or _semantic_ (symbols,
  types: Sharp).

|                   | Snapshot / derived diff | Patch / first-class change |
| ----------------- | ----------------------- | -------------------------- |
| **Lexical atom**  | Git, Jujutsu            | Darcs, Pijul               |
| **Semantic atom** | **Sharp v1**            | **this document**          |

Sharp v1 already left the top row — that is the entire contribution of the snapshot
decision: a semantic merge altitude over a snapshot store. The move analyzed here is along
the _other_ axis: from snapshot to patch, while staying semantic. It is the only cell that
differs from Git, Jujutsu, **and** Pijul simultaneously, because it is the only cell that
is both not-snapshot (unlike Git/`jj`) and not-lexical (unlike Darcs/Pijul).

The reason to want it is not novelty. It is that the patch-vs-snapshot question becomes a
_different question_ once the atom is semantic, and the difference resolves the one
concession v1 has to make.

---

## 2. What a semantic patch is

A semantic patch is a change expressed as an operation over the code graph, not a hunk over
text. The operation vocabulary is small and language-defined:

- **Structural operations** — `rename(symbol, new_name)`, `change_signature(symbol, sig)`,
  `move(symbol, target_module)`, `add_definition(symbol)`, `remove_definition(symbol)`,
  `change_visibility(symbol, vis)`. These are exactly the refactors a language server
  already exposes (`textDocument/rename`, rust-analyzer's `move_item`, etc.), and each
  carries a precise, language-computed set of sites it affects.
- **Intra-symbol body edits** — a change confined to one definition's body that alters no
  signature or reference. This is the residue that has no clean structural name; it is
  represented as a text/AST patch _scoped to a single symbol_, so even the unstructured
  case is bounded by the graph rather than floating over a file's line space.

History is then a DAG of these operations rather than a DAG of trees. A tree is recoverable
at any point by replaying operations (Pijul-style state reconstruction, with the same
caching mitigation); the operations are primary.

The point of the vocabulary is not expressiveness — text is maximally expressive. It is
that each operation carries the one thing a line does not: **a declaration of what it reads
and what it writes in the symbol graph.**

---

## 3. Independence as conflict-serializability over the symbol graph

This is the technical core, and it is borrowed wholesale from database concurrency theory
rather than invented.

Model each change as a transaction `T` with two sets over the symbol graph:

- a **write set** `W(T)` — the symbols, signatures, and type contracts the change modifies;
- a **read set** `R(T)` — the symbols, signatures, and type contracts the change depends on
  for its correctness (the references it binds, the types it consumes).

Two changes `T₁` and `T₂` are **independent** — and therefore commute, applying in either
order to the identical program — exactly when their access sets do not conflict, i.e. when
all three of the following hold (the Bernstein conditions for conflict-serializability):

```
W(T₁) ∩ W(T₂) = ∅      no write–write conflict
W(T₁) ∩ R(T₂) = ∅      no write–read  conflict
R(T₁) ∩ W(T₂) = ∅      no read–write  conflict
```

When all three hold, the merge is a no-decision: order does not matter, and the two
operations compose into one program with no human, no heuristic, and no guess. When any
intersection is non-empty, there is a **genuine** semantic conflict, and the substrate can
name it precisely — _these symbols, this contract_ — as a structured dilemma (whitepaper
§6.5) rather than a text marker.

Two things make this the decisive frame:

1. **It is the formal statement of the root axiom.** Whitepaper §1.1 says independence is a
   semantic relation that line merges approximate by lexical adjacency. Conflict-
   serializability over symbol-level read/write sets _is_ that relation, written exactly.
   The rename-versus-signature-change pair that `snapshots-vs-patches.md` §4 concedes "does
   not commute" is simply the case `W(T₁) ∩ W(T₂) ≠ ∅` (both write the same symbol) — the
   model does not fail to commute it; the model _identifies_ it as dependent and refuses to
   guess. Correct non-commutation is a feature, not a gap.

2. **It is the information a line cannot carry.** Pijul must _prove_ commutation through the
   pushout structure of its line-graph because a line has no read or write set — it is an
   anonymous position in a file. The symbol graph supplies the access sets the line-graph
   structurally lacks. Sharp would not be giving a better proof of Pijul's theorem; it would
   be operating on the substrate that _has the inputs the theorem needs_, which Pijul never
   had.

Honest boundary: the access sets are only as sound as the language's static analysis.
Macros, reflection, dynamic dispatch, conditional compilation, and build-time codegen can
hide a true dependency from the analyzer. The discipline that keeps this _sound_ rather
than merely convenient is the same as everywhere else in Sharp: when the analysis cannot
prove disjointness, the operation is treated as **dependent** (conservative over-
approximation of the write set), trading some false dependencies — extra dilemmas — for the
guarantee that no genuine conflict is ever cleared by an incomplete read set. Soundness
first, exactly as in §1.1.

---

## 4. What the semantic-patch substrate buys

Everything below follows from §3; none of it is independently postulated.

- **The patch-theory laws return as near-theorems, not test obligations.**
  Order-independence and associativity — which `snapshots-vs-patches.md` §4 demotes to
  differential-corpus tests because Pijul proves them only for lines — hold for any set of
  pairwise-independent operations directly, by §3. The corpus suite stops being the
  _source_ of confidence and becomes a _regression net_ on the analyzer's soundness.
- **Continuous speculative merge stops being maintained and starts being implied.** v1's
  projection (whitepaper §6.7) is a derived ref the engine recomputes as a target advances.
  Over commuting operations, "feature rebased onto target" is just the union of two
  independent operation sets — there is nothing to recompute and nothing to rebase, because
  independence is a property of the operations, not of an order imposed on them.
- **Cherry-pick and partial adoption are free.** Lifting one operation onto another branch
  is sound whenever that operation is independent of the ones not carried — the Darcs
  "cherry-pick falls out of commutation" result, now decided semantically instead of
  structurally.
- **Conflicts are reported in the language's own terms.** A dilemma is "operation A writes
  `foo`'s signature; operation B reads it" — a decision problem an agent can act on
  directly — not a region of overlapping lines it must re-parse to understand.
- **A branch becomes a set of diffs, not a sequence of commits.** Because operations carry
  their dependency relation (§3), a branch is a dependency-ordered _set_ whose net effect is
  sequence-independent, collapse is non-destructive set union, and rebase/squash become
  read-only projections. This is the workflow-side payoff of the substrate, developed in
  [`branch-semantics.md`](./branch-semantics.md).
- **The harness query layer becomes the substrate, not an index.** `commit_paths` and
  `commit_metadata` (whitepaper §4) are today a lossy, derived projection of "what changed."
  A code-graph store answers "every caller of `X`", "every change that wrote `X`'s
  contract", "which operations are independent of this one" as primary queries, because the
  read/write sets are the stored form, not an analytic afterthought.

---

## 5. The load-bearing risk: canonical semantic diff

One problem decides whether any of §4 is reachable, and it must not be understated.

To record a change as an operation, the operation must be _obtained_. If the agent emits
text (the normal case for a model writing code), the system must reduce
`(old_tree, new_tree)` to a sequence of semantic operations. This is **semantic diff with
move and rename detection**, and it is hard in two distinct ways:

1. **It is computationally hard.** Minimal tree edit distance with moves is NP-hard in
   general; rename/move detection is a heuristic matching problem, the same family as Git's
   `-M`/`-C` detection but required to be _reliable_ rather than advisory.
2. **It is under-determined, which is worse.** Many different operation sequences produce
   the identical `new_tree`. "Rename `foo`→`bar` then edit the body" and "delete `foo`, add
   `bar` with the new body" yield the same snapshot but different operations, different
   read/write sets, and therefore different merge behavior against a third branch.

The second point is the real threat, because Sharp's adopted machinery depends on
**canonicality**, not just correctness. The `jj` conflict algebra and its memoized,
self-cancelling dilemma resolution ([`jj-adoption.md`](./jj-adoption.md) §4) are sound only because every node
computing the same merge derives the _byte-identical_ term. If two nodes diff the same
change into different operation sequences, the terms diverge, memoized resolutions stop
matching, and the determinism the whole content layer rests on is gone. So the requirement
is not "a good semantic diff" but a **canonical** one: a deterministic function from a pair
of trees to a unique operation sequence. That function is unsolved in general and would be
per-language. It is the crux. If it cannot be made canonical and cheap, the snapshot
substrate is not a compromise — it is the correct answer, and this fork should not be taken.

There is a second, temporal face of the same requirement, and it is a latent soundness bug
if ignored. The canonical operation — and therefore the conflict term — is computed from the
_semantic representation_, which is produced by versioned tooling: tree-sitter grammars,
rust-analyzer, `ts.LanguageService`. A grammar or analyzer upgrade can change the AST or the
resolved symbol set for _identical source bytes_ (`research.md` flags exactly this for the
representation cache). So "the same merge" computed at two times under two toolchain versions
can yield two different canonical terms — silently breaking memoized-resolution reuse and the
self-cancellation of projections ([`jj-adoption.md`](./jj-adoption.md) §4), both of which
assume term identity is stable over the repository's lifetime. Canonicality must therefore be
defined _relative to a pinned analyzer/grammar version_: the term carries its toolchain
version, memoized resolutions are keyed by it, and a version bump has defined semantics
(invalidate or migrate), never a silent re-key. Until that exists, "resolve once, apply
everywhere" is sound within a toolchain version and unproven across one.

---

## 6. The agent-first unlock: operations are observed, not reconstructed

The reason this fork is worth keeping open — rather than filing next to Pijul as elegant and
impractical — is that the §5 problem is _structurally different for an agent author than for
a human one_, and the difference runs in Sharp's favor.

A human edits text. The operation that produced the text is in the human's head and is gone;
a human-facing VCS has no choice but to reconstruct it from the diff. This is why Darcs and
Pijul must derive patches from line states: their author destroys the operation before the
VCS sees it.

An agent in a harness does not. The harness _issues_ the change: it calls the language
server's rename, applies a scoped edit to a named symbol, invokes a move refactor. The
operation is **observable at authoring time** — it is a tool call the harness already
brokers and already records as an episode artifact (whitepaper §5). In the agent-first
setting the operation log can be _captured_ rather than _recovered_, which sidesteps the
canonical-diff problem precisely where it is hardest: structural operations are declared, so
no detection heuristic runs on them at all.

This is where Sharp meets its real prior art, and the meeting is favorable. Operation-based
merge (Lippe & van Oosterom, 1992) and refactoring-aware merge (Dig et al., _MolhadoRef_, 2007) both established that recording operations beats diffing states — but both assumed a
_human_ author, from whom the operation had to be coaxed by a refactoring IDE or inferred
after the fact. The agent-first setting removes that assumption: the operation is already a
brokered tool call. Sharp's claim over this lineage is therefore narrow and specific —
capture instead of reconstruction, independence decided by serializability over the symbol
graph (§3), and the canonical-term determinism the memoized machinery needs (§5) — not the
operation-based idea itself (`comparison-merge-theories.md` §4.6).

This does not make §5 vanish; it bounds it. The realistic model is hybrid:

- **Declared structural operations** — renames, moves, signature and visibility changes —
  recorded directly from the harness's tool calls, with exact language-computed access sets
  and no diffing.
- **Residual body edits** — the free-form text a model writes inside a single definition —
  diffed only _within the boundary of one symbol_, where the under-determination of §5 is
  contained: the read/write sets are dominated by the enclosing symbol regardless of how the
  body edit is decomposed, so canonicality is needed only at a granularity where it is
  achievable.

The bet of this fork is that capturing structural operations at the harness boundary plus
symbol-scoped diffing of bodies covers enough of real change traffic to make the substrate
sound and canonical where v1's snapshot diffing is neither. Whether that bet holds is an
empirical question (§8), not a settled one.

---

## 7. Costs beyond the diff

Even granting a canonical semantic diff, the move is not free, and the v1 decision recorded
these costs correctly (`snapshots-vs-patches.md` §2):

- **The metadata spine relocates.** Episodes, semantic representations, and commit metadata
  key on snapshot hashes today (`snapshots-vs-patches.md` §2.1). If the canonical unit is an
  operation, every one of those addressing roots must be re-answered: what does an episode
  attach to, what does a representation key on. This is the single largest engineering
  consequence and the reason the fork is post-v1, not a v1 variant.
- **Git export becomes a projection, not a consequence.** v1 gets byte-canonical Git objects
  for free because the store is already snapshots (whitepaper §7, `snapshots-vs-patches.md`
  §5). An operation store must _materialize_ to snapshots at the export boundary and prove
  the materialization is byte-canonical. Recoverable, but it forfeits the "compatibility
  falls out for free" property and must re-earn it. This is also a strategic-coherence
  question the whitepaper must answer head-on: byte-isomorphism is sold as a v1 _adoption
  pillar_ (whitepaper §2.2, §4.0), so the end-state must say plainly whether it stays a
  permanent _property_ or becomes a boundary _courtesy_ re-earned at export. The honest
  answer is the latter — on the operation substrate byte-isomorphism is a property of the
  export projection, not of the store — and v1's pillar is not retracted by this, only
  relocated to the boundary.
- **The operation algebra is per-language.** The structural vocabulary (§2) and the
  read/write-set extraction (§3) are defined per language family. v1's snapshot core is
  language-agnostic — blob/tree/commit hold any bytes — and this fork trades that
  universality for the semantic atoms. New languages cost more here than in v1.
- **The language server moves onto the write path.** v1 can analyze lazily and cache; a
  declared-operation model needs access sets computed at authoring time, putting the
  analyzer in the latency budget of every change, not every merge.

None of these refute the fork. They price it. The fork is justified only if §4's gains
exceed this bill, and that comparison cannot be made until §5's crux is known to be
solvable.

---

## 8. Decision: deferred, with the experiments that would settle it

**v1 ships the snapshot substrate.** The semantic-patch substrate is deferred — not
rejected. The deferral is correct because v1's value (semantic merge altitude, episodes,
Git interop) is fully available without it, and because the fork rests on an unsolved
problem (§5) that v1 does not need to solve to be correct.

The fork should be reconsidered when, and only when, the following are known. Each is a
spike that can run against v1's corpus without committing to the substrate:

1. **Canonicality of declared operations.** Instrument the harness to capture structural
   tool calls as operations on a sample of real episodes. Measure: what fraction of change
   traffic is structural (declared, no diffing) versus residual body edits, and whether the
   captured operations replay to byte-identical trees. If structural coverage is high and
   replay is exact, §5's crux is mostly avoided rather than solved — the strongest possible
   evidence for the fork.
2. **Symbol-scoped diff canonicality.** For the residual body edits, test whether a
   symbol-bounded semantic diff is deterministic across nodes and across analyzer versions.
   A single non-canonical case here is a finding, because it breaks the determinism §5
   requires.
3. **Access-set soundness on the corpus.** Run the conflict-serializability check (§3)
   against known-good and known-bad historical merges. Measure false-independent rate (a
   merge cleared that should have conflicted — must be zero under the conservative rule) and
   false-dependent rate (extra dilemmas — the tolerable cost). The first number is the gate;
   the second is the price.

If spike 1 shows structural operations dominate and spikes 2–3 hold, the fork is live and
the §7 costs become the engineering question. If spike 1 shows body edits dominate and
spike 2 cannot make them canonical, the snapshot substrate is not a compromise but the
right substrate, and this document is the record of why.

---

## 9. Relationship to the v1 decision

This is a **promotion path, not a reversal.** The v1 snapshot decision
(`snapshots-vs-patches.md`) is correct for the row Sharp lives in today, and nothing here
retracts it. What carries forward if the fork is ever taken:

- The **root axiom** (whitepaper §1.1) is unchanged — the fork is a different _realization_
  of the same semantic-altitude commitment, not a different goal.
- The **`jj` conflict algebra** (`jj-adoption.md` §4) carries over directly; it was always
  granularity-agnostic, and over operations it gains canonical terms by construction rather
  than by careful diffing.
- **Episodes** (whitepaper §5) carry over as the provenance layer, and in fact supply the
  declared-operation capture of §6 — the fork is partly a matter of _promoting_ episode
  artifacts that already record tool calls into the primary history, rather than building a
  new record.

What relocates is the addressing root (§7), and that is exactly why the decision is large
enough to be its own fork rather than a setting. v1 earns the right to make it later by
keeping the merge altitude semantic now: Sharp is already in the bottom-left cell, so the
remaining move is along one axis, not two.
