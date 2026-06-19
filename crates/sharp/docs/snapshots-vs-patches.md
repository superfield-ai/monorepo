# Why Snapshots, Not Patches — and First-Class Conflicts Without a Patch Data Model

Sharp stores everything in PostgreSQL and reaches Git only through a one-shot
export/checkpoint (whitepaper §7). That raises a fair question: if Git is just a
checkpoint target, why carry Git's _snapshot_ object model internally at all? Why not adopt
a patch substrate like Darcs or Pijul — files as graphs of lines, history as a set of
first-class patches — and inherit its merge laws (commutativity, associativity,
conflicts-as-values) for free?

This document defends three claims:

1. **Snapshots are the right substrate** because Sharp's canonical unit is the
   _semantically-analyzed snapshot_ — a choice forced by Sharp's metadata spine and its
   merge altitude, not by Git compatibility.
2. **First-class conflicts do not require a patch data model.** Jujutsu already
   demonstrated you can have conflict-as-value on top of snapshots; Sharp inherits the
   technique and points it at the AST.
3. **Git/GitHub compatibility is preserved** as a _consequence_ of the snapshot choice,
   not as the constraint that drives it — which is why relaxing the interop requirement
   doesn't change the answer.

The full algebraic comparison of CRDTs, patch theory, and `jj`'s conflict representation
lives in [`comparison-merge-theories.md`](./comparison-merge-theories.md); this doc is the
focused architectural decision that falls out of it.

**Scope.** This decision is scoped to v1's substrate. It chooses snapshots over a
_line-graph_ patch substrate (Darcs/Pijul) — the choice between the two cells of the
table's _lexical_ row, lifted to a semantic merge altitude. It does not settle the
distinct, larger question of whether the canonical store should become a _semantic_ patch
substrate (history as first-class symbol-level operations rather than snapshots). That is
the unoccupied lower-right cell of the
[`comparison-merge-theories.md`](./comparison-merge-theories.md) §4.5 matrix, and it is
analyzed as Sharp's post-v1 fork in [`semantic-patches.md`](./semantic-patches.md). Where
this document says "snapshots win," read "for v1's substrate, against a line-graph patch
model" — not "against a semantic patch model," which is a separate decision held open.

---

## 1. The temptation is real

Patch theory, made rigorous by Pijul, is genuinely attractive for a system whose normal
workload is a fleet of agents merging concurrently. Files are generalized into graphs of
lines, a merge is a categorical **pushout** that _always exists_ (because conflicted states
are legitimate values), and two laws fall out that Git lacks:

- **Commutativity** — independent changes apply in any order with identical results.
- **Associativity** — merging changes one at a time equals merging them all at once.

Pijul's authors note the resulting state behaves like a CRDT. For Sharp's continuous
speculative merge (whitepaper §6.7) — "a feature branch never needs to rebase on its
target" — this is more than aesthetic: order-independence is _exactly_ the property that
makes a rebase-free world sound. The pull toward a patch substrate is not naïve.

It is also not new to Sharp's earlier objection. The first reason we gave for rejecting
Pijul was that a line-graph store breaks byte-isomorphism with Git (whitepaper §4.0). That
objection is **secondary and we set it aside here on purpose**: assume Git is a
checkpoint-only target and a Sharp-id ↔ Git-id mapping table is acceptable. Even then,
snapshots win. The reasons below have nothing to do with Git.

---

## 2. Why snapshots win — three Git-independent reasons

### 2.1 The metadata spine is snapshot-addressed, top to bottom

Sharp's data model is "a snapshot, with structured artifacts hanging off it":

- Episodes attach to commits via `parent_commit` and `promoted_commit` (whitepaper §5.1).
- Semantic representations key on `object_id` — a blob or tree hash (§4.3).
- `commit_metadata` keys on `commit_id` (§4.4).

The addressing root of the entire system is a content-addressed snapshot. If the canonical
unit becomes a patch, every one of these has to answer a new question: what does an episode
attach to? What does a semantic representation key on? A patch substrate doesn't just swap
the merge engine — it relocates the addressing root, and the episode/semantic/metadata
spine (Sharp's _primary_ feature, not its merge engine) is rebuilt around it. Pijul's
conflict model is inseparable from its data model, and its data model is inseparable from
_being the thing everything else addresses_. Sharp already gave that role to snapshots for
reasons that predate any Git concern.

### 2.2 The merge decision is made at an altitude patches don't live at

Sharp does not decide merges on its storage substrate. It decides them by handing
_materialized file snapshots_ to the language's own toolchain — `ts.LanguageService` for
TypeScript, rust-analyzer for Rust — and reading back symbol-level renames and diagnostics
(whitepaper §6.1–6.2). Those toolchains consume snapshots and speak **symbols**. A
line-graph is a sub-file structure they do not accept.

So even with content stored as line-graphs, every merge would still materialize snapshots
to run Tier 1 and Tier 2. The patch substrate buys nothing at the layer where Sharp
actually makes its call — and it adds a decompose-on-write / materialize-on-read tax at
every step. The substrate that matches the decider's input is the snapshot.

### 2.3 Line-graph conflicts are the altitude Sharp exists to reject

Pijul's conflicts _are_ line-graph conflicts. Sharp's whole thesis is that the line is the
**wrong altitude** — that text-level merge is what silently mis-resolves, and the fix is to
move up to symbols and ASTs (whitepaper §6). Adopting Pijul's conflict representation means
encoding conflicts at exactly the granularity Sharp argues against, then having the
semantic tier re-decide them at a different one. Two impedance mismatches stacked: store at
line granularity, analyze at symbol granularity, reconcile the gap on every operation.

---

## 3. First-class conflicts without a patch substrate

The one property worth wanting from Pijul is **conflict-as-first-class-value** — an
unresolved merge that is a legitimate stored state rather than text markers or an error.
The mistake is assuming that property is bundled with the patch substrate. It is not.

Jujutsu proved the decoupling. `jj` is **snapshot-based, like Git** — not patch theory —
and yet it stores an unresolved conflict as a first-class value: an algebraic term over
trees, `A + (C − B)` ("tree A, plus the diff from B to C"), living inside an ordinary
commit. The term _is_ the conflict; descendants build on it; materialization to markers is
lazy. The algebra buys cancellation — rebase a conflicted commit and the term simplifies
rather than nesting; revert it and the term cancels to a clean tree; resolve it once and
the resolution propagates to descendants carrying the same term.

This is the technique Sharp adopts ([`jj-adoption.md`](./jj-adoption.md) §4): the Tier 3
**structured dilemma** (whitepaper §6.5) becomes a _live algebraic term_ over tree/AST
states, re-simplified every time the speculative-merge projection recomputes. Two things
follow:

- **Conflict-as-value, on snapshots.** Sharp gets Pijul's one wanted property without
  Pijul's substrate, addressing root, or line-graph granularity.
- **Granularity is Sharp's to choose.** Pijul hands you conflict-as-value _only_ at line
  granularity. The term algebra is granularity-agnostic — Sharp points it at the AST node,
  the altitude its semantic tiers already operate at.

The decisive distinction is **determinism, not convergence**. A CRDT auto-converges
(silently picking or interleaving — forbidden by Sharp's core guarantee). The term algebra
instead guarantees that every observer computing the same merge derives the _byte-identical
term_. That determinism — not auto-resolution — is what makes Sharp's memoized dilemma
resolutions safe to propagate and its self-cancelling projections sound. Snapshots plus a
deterministic conflict term deliver this; a patch substrate is not required for any of it.

---

## 4. The patch-theory laws survive — as obligations, not inherited axioms

Conceding §6.7 honestly: continuous speculative merge _is_ morally patch-theoretic, and
patch theory would hand you order-independence as a theorem instead of a projection you
maintain. So why not take the theorem?

Because of _what the theorem is about_. Pijul proves commutativity and associativity for
**line-graphs**. Sharp needs them at the **semantic** layer — and symbol-level merges are
not commutative in general: a rename and a signature change do not commute at the symbol
level in any way a line-graph models faithfully. Pijul's proof covers a layer Sharp does
not decide at, and Sharp would still have to establish the property at the layer it does.

That is exactly why [`comparison-merge-theories.md`](./comparison-merge-theories.md) §5
turns Pijul's two theorems into **differential-corpus test obligations** for the merge
engine and the speculative-merge projection — _order-independence_ (merging branch sets in
any order yields the same projection) and _associativity_ (incremental recompute equals
from-scratch recompute) — rather than inheriting them as axioms. Where Tier 1 cannot honor
them, that is a finding, not a shrug. You don't get to inherit a proof for a layer you are
not operating on; you earn the property by testing the engine you actually ship.

This is the honest answer _for a snapshot substrate_, and it is the right answer for v1.
It is not the only possible answer. If history were recorded as first-class _semantic_
operations rather than snapshots, order-independence would not be a corpus obligation but a
consequence of the language-defined dependency relation between operations: two operations
with disjoint symbol-level read/write sets commute by construction, and the rename-versus-
signature-change pair that does _not_ commute is _identified_ as dependent rather than
approximated as adjacent. The patch-theory laws return as near-theorems at the semantic
layer, where Pijul could only prove them at the line layer — because the symbol graph
supplies the read/write sets a line-graph structurally lacks. That is a different
substrate, not a different merge engine, and it is deferred out of v1 and analyzed in
[`semantic-patches.md`](./semantic-patches.md). Within the snapshot substrate this section
commits to, the laws remain test obligations.

---

## 5. Git/GitHub compatibility: a consequence, not the driver

Because the substrate is snapshots, Git export is cheap by construction: a completed linear
branch projects to byte-canonical Git objects with stable SHAs (whitepaper §7.2). Note the
direction of causation. Sharp does **not** choose snapshots _in order to_ stay
Git-compatible — it chooses snapshots for the metadata-spine and merge-altitude reasons in
§2, and Git compatibility falls out as a free consequence. That ordering is why the answer
is robust to relaxing the interop requirement: drop the demand for continuous byte
isomorphism entirely, and snapshots are _still_ the right substrate.

It is worth noting the one thing a checkpoint-only model _would_ technically permit — and
why Sharp still doesn't take it. Relaxing isomorphism would let Sharp hash objects
internally with a non-Git function (e.g. BLAKE3) and recompute Git's bytes only at
checkpoint, via a Sharp-id ↔ Git-id mapping table. But permission is not a reason, and
there is no payoff here for Sharp's workload:

- **Speed is not the bottleneck.** A faster hash saves nothing meaningful: object hashing is
  rounding error next to Postgres I/O and the language-server analysis that Tier 1/Tier 2
  run on every merge candidate. Sharp is not hash-bound.
- **Strength points to SHA-256, not BLAKE3.** If Sharp ever wants better than SHA-1, the
  answer is SHA-256 — which is _Git-native_ (whitepaper §4.0, behind `objectformat=sha256`)
  and needs **no** mapping table because Git computes the same bytes. A non-Git hash is the
  only option that _forces_ the mapping table, the export-time recomputation, and the
  round-trip asymmetry §4.0 rejects. It buys interop friction to reach a place SHA-256
  reaches for free.

This matches the implementation: `git-canonical` defines `HashAlgo = 'sha1' | 'sha256'` and
defaults to `'sha1'`, with `'sha256'` asserted byte-identical to stock
`git hash-object --object-format=sha256`. No third hash exists in the code, by design. So
the checkpoint model does not even hand Sharp a hash win — Git-native hashing stays right
for the same "compatibility falls out for free" reason as the substrate itself.

---

## Summary

| Question                                 | Answer                          | Because                                                                                                                                                                                         |
| ---------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Snapshots or patch/line-graph substrate? | **Snapshots**                   | Metadata spine is snapshot-addressed; merge decisions are made at symbol altitude on materialized snapshots; line-graph conflicts are the altitude Sharp rejects.                               |
| First-class conflicts?                   | **Yes, on snapshots**           | `jj`'s term algebra (`A + (C − B)`) gives conflict-as-value without a patch substrate, at AST granularity Sharp chooses. Determinism, not convergence, is what makes it safe.                   |
| Patch-theory laws (commute/associate)?   | **As test obligations**         | The theorems are proven for line-graphs; Sharp needs them at the non-commutative semantic layer, so they're earned by corpus tests, not inherited.                                              |
| Git/GitHub compatibility?                | **Preserved, as a consequence** | Snapshots export to byte-canonical Git objects; compatibility falls out of the substrate choice rather than driving it — which is why dropping the interop demand doesn't change the substrate. |

The synthesis Sharp ships: **snapshot substrate** (so episodes, semantic representations,
and Git export all have a stable addressing root), **deterministic conflict terms** at AST
granularity (so conflicts are first-class without a patch model), and the **patch-theory
laws as verification obligations** on the semantic engine (so the one thing patches prove is
checked where Sharp actually needs it).
