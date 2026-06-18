# Merge as Mathematics: CRDTs, Patch Theory, and Jujutsu's Conflict Algebra

Three research lineages have tried to replace "merge is a heuristic over text, and when
it fails a human edits markers" with "merge is an algebraic operation with laws":
**CRDTs** (conflict-free replicated data types), **patch theory** (Darcs, made rigorous
by Pijul), and **Jujutsu's algebraic conflict representation**. They are frequently
conflated — `jj` in particular is often mislabeled as "Darcs-like patch theory" — but
they make three _different_ promises, and the differences decide what Sharp can borrow
from each.

The one-line placement: **CRDTs are conflict-free by construction, patch theory is
conflict-avoiding by commutation, and `jj` is conflict-preserving by representation.**
Sharp, whose core guarantee is _never silently pick between two semantically valid
resolutions_ (whitepaper §6), needs pieces of all three — and a semantic layer none of
them has.

The architectural decision this analysis drives — _why Sharp keeps a snapshot substrate
instead of a Darcs/Pijul patch substrate, yet still gets first-class conflicts_ — is
written up on its own in [`snapshots-vs-patches.md`](./snapshots-vs-patches.md).

---

## 1. CRDTs: define conflicts out of existence

A CRDT is a data type whose merge is mathematically guaranteed to converge without
coordination. State-based CRDTs require the merge to be a **join-semilattice**:
associative, commutative, and idempotent, with replica states only moving "up" the
lattice. Operation-based CRDTs require concurrent operations to commute. Either way, the
guarantee is total: any set of replicas, merging in any order, any number of times,
reaches the identical state. There is never a conflict to show anyone (Shapiro et al.,
2011).

The catalogue is rich: grow-only and add-remove sets, counters, last-writer-wins and
**multi-value registers** (keep _all_ concurrent values rather than picking a winner —
the Dynamo lineage), and sequence CRDTs for collaborative text — WOOT, Treedoc, Logoot,
RGA, and the production implementations Yjs and Automerge.

**The cost: convergence is not correctness.** A CRDT must decide, _in the data type
definition_, what every concurrent combination means. For text, that rule is structural —
concurrent insertions at the same position get deterministically interleaved or
juxtaposed. Both authors' characters survive; the _meaning_ is whatever falls out.
Convergence guarantees everyone sees the same result, not that the result is what anyone
intended — the well-known interleaving anomalies in sequence CRDTs are exactly this gap.
For prose in a live editor, a human watches the merge happen and repairs intent
immediately. For source code merged asynchronously, a deterministic-but-arbitrary
interleaving of two function edits is a silent wrong answer.

**Verdict for code:** the convergence guarantee is the wrong target. A code merge must be
allowed to say "these edits are in tension" — a possibility CRDTs exclude by definition.

## 2. Patch theory: Darcs and Pijul

Patch theory inverts the unit of history: not snapshots, but **patches** — first-class
changes with algebraic structure.

**Darcs** built its model on **commutation**: independent patches can be reordered
(`AB ↔ B′A′`), and merging is reordering the other repository's patches past yours. A
repository is a _set_ of patches, and any order consistent with their dependencies yields
the same tree — "cherry-picking is free" falls out, because a patch's identity does not
depend on the commits beneath it. Darcs's theory, however, was semi-formal, and its
handling of conflicting patches was its undoing: certain conflict-heavy merges triggered
exponential-time commutation searches (the infamous Darcs 1 "exponential merge"; Darcs 2
mitigated but did not eliminate the pathology).

**Pijul** is the rigorous reconstruction. Files are generalized into graphs of lines, and
a merge is a **pushout** in an appropriate category — a construction that _always exists_,
because the state space is enlarged to include conflicted states as legitimate values
(Mimram & Di Giusto's categorical theory of patches is the academic ancestor). Two
properties follow that Git lacks:

- **Commutativity**: independent changes apply in any order with identical results.
- **Associativity**: merging changes one at a time equals merging them all at once. Git's
  merge is not associative — the result can depend on merge order — and Pijul is right
  that this is a real source of silent mismerges.

Because conflicted states are values and merge is total, commutative, and associative,
Pijul's own authors describe its state as behaving like a CRDT — the formal bridge
between the two lineages. The cost of patch theory is the inverted storage model: state
must be reconstructed from patch history (Pijul mitigates with caching), tooling and
ecosystem diverge completely from Git, and the theory governs _structure_ (lines in
graphs), not language semantics.

**Verdict for code:** the _laws_ — order-independence, associativity, conflicts-as-values
— are exactly what a fleet of concurrent mergers wants. The patch-based storage model is
a poor fit for a system whose interop contract is byte-isomorphism with Git's object
model (whitepaper §2.1).

## 3. Jujutsu's algebraic conflict representation

`jj` is **snapshot-based, like Git — it is not patch theory**. Its innovation is narrower
and deliberately pragmatic: when a merge conflicts, the resulting _tree_ is stored as an
unevaluated algebraic term over trees:

```
A + (C − B)        "tree A, plus the diff from B to C"
A + (C − B) + (E − D)   (n-way; any odd number of trees)
```

The term is the conflict. It lives inside an ordinary commit; descendants build on it;
materialization to marker text happens lazily and only at the working-copy boundary. The
algebra behaves like formal sums in a free abelian group over tree states, which buys
**cancellation**:

- Rebase a conflicted commit from C to D: `D + ((C + (B − A)) − C)` simplifies to
  `D + (B − A)` — the conflict follows the commit without nesting recursively.
- Revert a conflicted commit: the terms cancel to a clean tree — the conflict vanishes.
- Resolve a conflict once: the resolution propagates through descendants carrying the
  same term.

What `jj` does _not_ promise: convergence (the term openly represents divergence, the
opposite of a CRDT's contract) or patch-theoretic completeness (the "same-change rule"
that auto-resolves agreeing sides is acknowledged as lossy in some rebase scenarios; the
algebra is a practical instrument, not a proven theory). What it _does_ promise is the
property the other two lineages under-serve: a **canonical, deterministic representation
of the divergence itself** — every observer computing the same merge derives the same
term, and simplification is a pure function of the algebra, not of who runs it.

One more `jj` layer genuinely _is_ CRDT-shaped, and it is not the conflict algebra: the
**operation log's view merge**. When concurrent operations move ref `main` to B and to C,
the merged view records "main is at B-or-C" — keep-both semantics, almost exactly a
multi-value register. `jj` is thus a hybrid: CRDT-like at the metadata layer, where
arbitrary-but-convergent is harmless, and conflict-preserving at the content layer, where
it is not.

## 4. The three promises, side by side

| Dimension                | CRDTs                                                                 | Patch theory (Darcs/Pijul)                                      | `jj`'s conflict algebra                                                      |
| ------------------------ | --------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Unit of history          | Replica states / commuting ops                                        | Patches (first-class changes)                                   | Snapshots (Git-style trees)                                                  |
| Merge guarantee          | Always converges, automatically                                       | Always _defined_ (pushout exists); conflicts are values         | Always _representable_; conflict stored as a term                            |
| Stance on conflict       | Impossible by construction                                            | A legitimate state, derived by the theory                       | Preserved, canonical, simplifiable                                           |
| Key algebraic laws       | Associative + commutative + idempotent join                           | Commutation of independent patches; associative merge           | Cancellation of formal sums; lazy evaluation                                 |
| What is deterministic    | The converged state                                                   | The merged state (order-independent)                            | The _description of the divergence_                                          |
| Where it breaks for code | Convergent ≠ correct; arbitrary interleaving is a silent wrong answer | Inverted storage model; structural not semantic; ecosystem cost | Lossy edge cases (same-change rule); no semantic layer; pragmatic not proven |
| Production embodiment    | Yjs, Automerge, Dynamo-style registers                                | Darcs, Pijul                                                    | Jujutsu                                                                      |
| Semantic awareness       | None (structural)                                                     | None (structural)                                               | None (structural)                                                            |

The last row is the quiet headline: **all three lineages are syntactic.** They reason
about sets, lines, graphs, and trees — never about symbols, types, or whether the merged
program compiles. The tempting reading of this row — _"whatever Sharp borrows, the
semantic tier is additive on top"_ — is exactly the framing the whitepaper's root axiom
(§1.1) rejects. The semantic layer is not an addition to a VCS; it is the property a
syntactic VCS was relying on a human to supply. The row does not name a feature these
systems happen to lack — it names the altitude at which they decline to decide
independence, and which an agent-first VCS, having no human to decide it instead, must
occupy. Read that way, the row is not a footnote to the table; it is the axis the table
was missing.

## 4.5 The two axes are orthogonal

The table's first row (unit of history) and its last row (semantic awareness) are two
_independent_ design axes, routinely collapsed into one. The unit of history can be a
snapshot or a first-class patch; the merge altitude can be lexical or semantic. Nothing
ties the choices together. Crossed, they give four cells:

|                   | **Snapshot / derived diff** | **Patch / first-class change** |
| ----------------- | --------------------------- | ------------------------------ |
| **Lexical atom**  | Git, Jujutsu                | Darcs, Pijul                   |
| **Semantic atom** | **Sharp v1**                | **— unoccupied —**             |

Sharp v1 is the lower-left cell: a snapshot substrate with a semantic merge altitude — a
combination no prior system ships, and the whole of the
[`snapshots-vs-patches.md`](./snapshots-vs-patches.md) decision. The lower-right cell —
history as first-class _semantic_ operations, whose commutation the language _decides_
rather than a line theory _approximates_ — is occupied by no shipping system. It is the
only cell that differentiates against Git, Jujutsu, and Pijul at once, and it is where
Pijul's hardest unsolved problem (sound commutation of line-patches) is dissolved rather
than inherited, because a semantic operation carries its dependency relation with it where
a line carries none. That cell is Sharp's named post-v1 fork, analyzed in
[`semantic-patches.md`](./semantic-patches.md). The rest of this document analyzes the row
Sharp lives in today; that document analyzes the column it could move along next.

## 4.6 The other neighbor: the software-merge literature

The three lineages above are merge _algebras_ — they reason about how changes combine in the
abstract. Sharp's _other_ prior art is the software-merge research line, which has studied
merging at exactly Sharp's altitude (syntactic and semantic structure) since the early
1990s. It is the neighbor the root axiom (whitepaper §1.1) actually argues within, and it
must be acknowledged honestly, because it both bounds Sharp's novelty and tempers its
thesis. (Mens, _A State-of-the-Art Survey on Software Merging_, IEEE TSE 2002, gives the
canonical taxonomy: textual / syntactic / semantic / operation-based merge.)

- **Operation-based merge** (Lippe & van Oosterom, 1992) records edit _operations_ rather
  than diffing states, and merges by replaying them. This is the direct ancestor of
  [`semantic-patches.md`](./semantic-patches.md)'s "history as declared operations." Sharp's
  contribution is not the operation-based model; it is capturing those operations from an
  agent harness — which a human-facing VCS cannot — and deciding their independence by
  serializability over the symbol graph.
- **Refactoring-aware merge** (Dig et al., _MolhadoRef_, 2007) treats renames and moves as
  first-class refactoring operations with language-computed effects — precisely Sharp's
  "declared structural operation with a reference set." Sharp owes, and gives, its delta:
  agent capture, the verification gate, and episodes.
- **Structured / semistructured merge** (Apel et al., _Structured Merge with Auto-Tuning_,
  JDime, ASE 2012; Cavalcanti, Borba & Accioly, OOPSLA 2017; Spork, 2021) merges over ASTs.
  Its _empirical_ findings are the cautionary part: structured merge reduces conflicts
  **meaningfully but partially**, is **expensive** (JDime auto-tunes specifically to fall
  back to cheap textual merge where it can), and the conflict-mining studies find a
  substantial fraction of real conflicts are **genuine** semantic disagreements that no
  structure dissolves.
- **Commercial language-aware merge** (SemanticMerge / Plastic SCM `gmaster`, c. 2013)
  shipped working language-aware merge for mainstream languages and saw **limited adoption** —
  a precedent a design betting on semantic merge must answer, not ignore.

The consequence for this document and for whitepaper §1.1: the table's lineages reason
_below_ symbols, and the software-merge literature has already shown that moving _up_ to
symbols dissolves the spurious conflict class at real-but-bounded benefit and non-trivial
cost. Sharp's wager is that the agent-first setting shifts the cost/benefit — operations are
captured, not reconstructed ([`semantic-patches.md`](./semantic-patches.md) §6), and there is
no human to absorb the spurious class for free — **not** that semantic merge is itself novel.
That distinction belongs wherever the thesis is stated.

## 5. What Sharp takes from each

Sharp's three-tier contract — dissolve deterministically, verify intrinsically, escalate
structurally — fixes the goal: _converge automatically only when language semantics prove
it safe; otherwise emit a canonical divergence object instead of a guess._ Each lineage
contributes to a different layer:

- **From CRDTs: the metadata layer.** Refs, visible heads, and view state should behave
  like multi-value registers — concurrent agent writes produce a kept-both divergence
  record, never a lost write and never a blocking lock. This is `jj`'s operation-log
  design (adopted in [`jj-adoption.md`](./jj-adoption.md) §1), and it is sound there
  precisely because ref divergence carries no semantic risk: nothing is guessed, both
  values are kept, and resolution is explicit.
- **From patch theory: the laws as test obligations.** Sharp keeps Git's snapshot model
  for interop, but Pijul's two theorems become differential-corpus properties for the
  merge engine and the speculative-merge projection (whitepaper §6.7):
  _order-independence_ (merging branch sets in any order yields the same projection) and
  _associativity_ (incremental projection recompute equals from-scratch recompute). Where
  Tier 1 cannot honor them, that is a finding, not a shrug.
- **From `jj`: the content layer's representation.** Conflict-preservation with a
  canonical algebraic term is the right contract for source code, and determinism — not
  convergence — is what makes the agent-side machinery sound: memoized dilemma
  resolutions can propagate ("resolve once, apply everywhere") only because the term they
  resolve is canonical, and dilemmas can cancel themselves during projection recompute
  only because simplification is observer-independent. This is adoption item §4 in
  [`jj-adoption.md`](./jj-adoption.md).
- **From none of them: the verification gate.** No lineage can say a merge is _wrong_ —
  CRDTs define wrongness away, patch theory and `jj` only promise well-formed structure.
  Sharp's Tier 2 intrinsic verification (parse, symbol resolution, language diagnostics;
  whitepaper §6.2) is the layer the mathematics cannot supply, because "compiles and
  means something" is a property of the language, not of the merge algebra.

A CRDT for source code would have to auto-converge — silently picking between, or
interleaving, two semantically valid edits — which is precisely the behavior Sharp's core
guarantee forbids. The synthesis is to be CRDT-like exactly where arbitrariness is
harmless (metadata), law-abiding where the laws are checkable (projection algebra), and
conflict-preserving with canonical terms everywhere meaning is at stake (content) — with
the language's own toolchain, not the algebra, as the final arbiter of correctness.
