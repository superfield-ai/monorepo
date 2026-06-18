# Branch Semantics: A Branch Is a Labeled Set of Diffs, Not a Sequence of Commits

The way work actually flows in practice — features collapse into phases, phases collapse
into main — is a story about _sets of changes being rolled up_, not about sequences of
commits being replayed. Git forces the second model because its substrate is a chain of
snapshots; the rollup is then emulated with squash and rebase, both of which rewrite
history and destroy identity. This document defines the model Sharp targets instead: **a
branch is a dependency-ordered set of operations**, the linear commit sequence is one
arbitrary view of it, and collapse is a non-destructive relabeling.

**Scope.** This is the _target_ model, native only on the semantic-operation substrate
([`semantic-patches.md`](./semantic-patches.md)). Sharp v1's substrate is still refs to
commits (the `sharp.refs` discriminated union; whitepaper §3.1), so in v1 the set-of-diffs
view is _derivable_ (diff a branch base against its tip) but not primary, and collapse is
emulated by squash-export. §9 maps the model onto both substrates. Like the operation
substrate it rests on, the native form is post-v1; the model is defined here so the v1
ref layer can be understood as an approximation of it rather than the thing itself.

This model is the workflow-side face of the merge-engine argument in
[`semantic-patches.md`](./semantic-patches.md): the same operation substrate that makes
merge correct also makes branches sets. One substrate, two payoffs.

---

## 1. The model

An **operation** is a semantic diff over the code graph (`semantic-patches.md` §2): a
rename, a signature change, a move, a scoped body edit — each carrying a read set `R(o)` and
a write set `W(o)` over symbols, signatures, and type contracts.

A **branch** is a set of operations `B = {o₁ … oₙ}` together with the **dependency partial
order** they induce. For two operations, `oᵢ ≺ oⱼ` ("`oⱼ` depends on `oᵢ`") exactly when
their access sets conflict and authoring causality places `oⱼ` after `oᵢ` — i.e. `oⱼ` reads
or overwrites something `oᵢ` wrote (`W(oᵢ) ∩ (R(oⱼ) ∪ W(oⱼ)) ≠ ∅`). This is the conflict
relation of serializability theory (`semantic-patches.md` §3); the branch's poset is its
precedence graph. Operations whose access sets are disjoint are **incomparable** — the
order between them is not recorded because it carries no meaning. Conversely, `≺` is
_defined_ to order **every** access-set-conflicting pair within a branch by its authoring
order; since a branch is authored as one causal stream, every such pair is so ordered by
construction. Internal consistency (the precondition of §1.1's proposition) is therefore
automatic _within_ a branch — only the **union** of two independently-authored branches can
present a conflicting pair with no order between them, which is not a cyclic poset but the
merge dilemma (§5).

A branch is therefore a **poset, not a sequence**. The linear commit history git and jj
present is one **topological sort** of that poset — an arbitrary choice among many.

### 1.1 Why the set is well-defined: net effect is sequence-independent

The claim "the sequence doesn't matter" is precise and provable, not loose.

> **Proposition.** Let `B` be internally consistent — every non-commuting pair of operations
> in it is ordered by `≺` (guaranteed by construction for a single branch, per above; a
> precondition to _check_ when `B` is a union of branches). Then every topological sort of
> `B`, applied in order to the base tree, materializes the **same** tree. The branch has a
> single net effect, independent of which sequence is chosen to display it.

_Why._ Any two topological sorts of a poset differ only by a series of adjacent
transpositions of **incomparable** elements. Incomparable means access-set-disjoint, which
means commuting (`semantic-patches.md` §3): swapping them does not change the result. Every
non-commuting pair is fixed in relative order by `≺` and so is never transposed. Therefore
all sorts yield the identical tree — the serializability theorem, applied to one branch. ∎

Two consequences define branch identity and conflict:

- **Branch equality is set equality.** Two branches are the same change iff they hold the
  same operations (by canonical operation identity, `semantic-patches.md` §5), regardless of
  the order either was authored or displayed in.
- **The dilemma is the only place order is genuinely undetermined.** "Internally
  consistent" is the precondition, and authoring causality supplies it _within_ a branch: a
  revert after an edit, a fix after a fix, are non-commuting and the later one is meant to
  win, so `≺` records exactly that. The case with no determining order is two operations
  from _different_ branches that mutually conflict with no causal link between them — which
  is not a cyclic poset but a **merge dilemma** (whitepaper §6.5), resolved or escalated,
  never silently sequenced.

---

## 2. One scale-free object, four roles

On this substrate the distinction git draws between "a commit" and "a branch" — different
kinds of things, one a snapshot, the other a pointer to one — dissolves. There is **one
kind of object: a labeled set of operations**, and it is scale-free:

| git/jj concept | here                          |
| -------------- | ----------------------------- |
| a commit       | a singleton (one operation)   |
| a feature      | a small set of operations     |
| a phase        | a union of feature sets       |
| main           | the largest set               |
| a tree/snapshot| the **materialization** of any set, computed on demand |

"Commit," "branch," "phase," and "main" are **roles and sizes**, not types. A snapshot is
not a peer of these; it is the *projection* of a set into a concrete tree (whitepaper §7),
available at any scale. This is jj's "the working copy is a commit" uniformity carried one
step further: not only is the working copy an ordinary commit, a _branch_ is an ordinary
set of the same atoms a single change is made of.

The payoff is that every operation defined for one role works at every scale, because
they are the same object. Merge, collapse, diff, materialize, and the verification gate
all take "a set of operations" and do not care whether it is one diff or all of main.

---

## 3. Collapse is set union, and it is non-destructive

Your features→phases→main flow is set algebra over these objects:

- **feature** — a small poset of operations, usually _anonymous_ (§4).
- **phase** — `phase.ops ∪= feature.ops` for each feature folded in.
- **main** — the distinguished set that must pass the verification gate (whitepaper §6.2) on
  its materialized net effect before any union lands.

Union is **idempotent and associative**, so phases nest to any depth and the rollup order
among independent features does not matter — the same Proposition (§1.1), one level up.

The decisive difference from git squash: **collapse is a relabeling, not a rewrite.** Git
squash replaces N commits with one and destroys the originals' identity. Collapse here adds
a membership edge — "these operations now also belong to this phase" — while every operation
keeps its canonical identity and its episode (whitepaper §5). This is the §2.5
immutable/mutable split doing the load-bearing work:

- **Operations are immutable facts.** They are never rewritten, reordered, or deleted by a
  collapse.
- **Groupings are mutable metadata.** A branch or phase is a _label over a set_; folding,
  unfolding, and regrouping move labels, never operations.

So the collapsed view (one rolled-up bundle for review or export) and the granular view
(every operation with its trace) coexist permanently. git forces a choice between a clean
phase boundary and the underlying detail; here you keep both, and the detail remains the
negative/positive-example corpus the episode layer exists to capture (`jj-adoption.md` §3).
Reverts collapse too: a revert is another operation writing the same symbols, so the set
keeps both and the net effect cancels by the `jj` term algebra (`jj-adoption.md` §4) — the
history is retained, the materialization is clean.

---

## 4. Three identity layers; names are optional

Separating identity from naming is what removes branch ceremony without losing
addressability. Three layers, kept distinct:

1. **Operation identity** — content: the canonical operation term (`semantic-patches.md`
   §5). Survives everything.
2. **Task / change-ID** — intent: the stable name of "this logical change," across rewrites
   and regroupings (`jj-adoption.md` §3). A fan-out of N candidates is N operation-sets
   sharing one task-ID; a feature is the set that won.
3. **Branch / phase label** — nominal: an optional, mutable handle on a set, for humans and
   operators.

Features are **anonymous by default** — identified by `(task-ID, episode)`, never needing a
`feat/fix-login-attempt-7-final-v2` (`jj-adoption.md` §7). Names are spent only where
something is _addressed_ repeatedly: phases, main, a long-lived integration line. This is
jj's bookmark — an optional label on a commit — generalized to an optional label on a _set_,
and it kills both the naming ceremony and the branch-namespace collision surface in the
fan-out path.

---

## 5. Merge and landing are union under a gate

Because a branch is a set, merge is **set union plus the serializability check**, and the
two outcomes are exactly the two halves of the root axiom (whitepaper §1.1):

- **Independent** (`B₁` and `B₂` have disjoint read/write footprints): the merge is
  `B₁ ∪ B₂`, free, order-free, and rebase-free. There is no sequence to replay and nothing
  to linearize, so there is nothing to rebase — the "no rebase" property (whitepaper §6.7)
  is not a feature here, it is the absence of the thing rebase operates on.
- **Conflicting** (footprints overlap with no causal order): the overlapping symbols are the
  structured dilemma (whitepaper §6.5), reported in the language's terms, never as markers.

This sharpens continuous speculative merge (whitepaper §6.7): the projection
`feature--target` is literally the question "are `feature.ops` and `target.ops`
independent?", recomputed as either side grows. **Landing** is then the atomic metadata
operation `main.ops ∪= feature.ops`, admitted only if the union passes the gate — a CAS on
a set membership, not a fast-forward of a pointer along a chain.

---

## 6. Two orders: semantic and policy

The poset records only **semantic** dependency. Real workflows also impose order for
reasons that are _not_ access-set conflicts: land the refactor before the feature though
they are independent, hold a phase for review, sequence by risk, gate on a release train.
That is **policy order**, and it is a separate relation layered on top.

The one rule that keeps the two coherent: **policy order must extend the semantic poset.**
Any policy order `≼` an operator imposes has to satisfy `≺ ⊆ ≼` — it may _add_ order
between semantically-independent operations, but it may never contradict a semantic
dependency. Equivalently, every admissible landing schedule is a linear (or partial)
extension of the poset. Semantic order is the floor; policy order is anything above it.

This is where review gates, landing queues, and release trains live — in the policy layer
over the set — so the substrate stays "a branch is a set of diffs" while real-world
sequencing still has a home. Do not oversell the set model as "order never matters":
semantic order always matters where it exists, and policy may add more.

---

## 7. git and jj as projections, not the substrate

Everything git treats as a history-mutating operation becomes, here, a read-only projection
of the poset:

- **Linearize** (what rebase produces) = pick a topological sort. By §1.1 every choice has
  the same net effect, so linearization is a _display_ decision, free of the force-push and
  history-rewrite that rebase forces in git.
- **Squash** = take the net effect — the materialized tree of the whole set as a single
  commit. Non-destructive, because the operations survive behind the projection.
- **Git export** (whitepaper §7) chooses one linear extension respecting both the semantic
  poset and any policy order (§6) and emits byte-canonical commits. The export _is_ a topo-
  sort; the substrate never held the sequence to begin with.

This is precisely where the model passes jj. jj removes the **naming** ceremony (anonymous
heads) and adds **stable identity** (change IDs) — both adopted here (§4) — but a jj branch
is still an ancestry chain of snapshots: jj keeps the _sequence_ as substrate and derives
the diffs. This model inverts that: the **set of diffs is the substrate**, and the sequence
is the derived projection. jj fixed how branches are _named and identified_; this fixes what
a branch _is_.

---

## 8. The human-narrative objection

A linear history reads as a story, and a poset does not. The objection: collapsing to a set
loses the narrative a careful commit sequence conveys.

The answer is that the narrative was never lost, only de-privileged. A narrative is a
_chosen linear extension_ of the poset annotated with the reasons for each step — and the
reasons live, richer than a commit message, in the episode attached to each operation
(whitepaper §5): the prompt, the context, the trace, the judge outcome. The model does not
delete the story; it stops treating _one arbitrary sequence_ as the canonical truth and lets
any number of narratives be projected from the same set, each carrying the actual "why"
instead of a one-line summary of it. A human who wants the familiar straight-line read asks
for a topological sort; nothing stops them, and what they get is better-annotated than git's.

---

## 9. v1 and the fork

The model's _fidelity_ tracks the substrate, and this should not be overstated for v1:

- **Semantic-operation substrate (the fork).** Native. Operations carry symbol-level
  read/write sets, so the dependency poset is exact, collapse is set union over real
  operation identities, and §1.1's Proposition holds at symbol granularity.
- **Snapshot substrate (v1).** Approximated. A branch is a ref to a commit; the
  set-of-diffs view is _derived_ by diffing base against tip, and any dependency relation is
  inferred at path granularity (or coarser), not symbol granularity. Collapse is emulated by
  squash-export, which on the snapshot substrate _is_ destructive of the constituent commits
  unless their episodes are retained separately. v1 gets the _ergonomic_ wins reachable
  without operations — anonymous heads and change IDs (`jj-adoption.md` §3, §7, stage 2) —
  but the non-destructive, sequence-free guarantees are the fork's.

So this document is to branch semantics what `semantic-patches.md` is to merge: the target
both share, reachable in full only on the operation substrate, approximated by v1's ref
layer in the meantime. The decision to move is the same decision, gated by the same crux
(canonical semantic diff, `semantic-patches.md` §5) — which is the point: branches-as-sets
is not a separate feature to fund, it is a consequence of the operation substrate that
arrives for free if that substrate is built.

---

## Summary

| Question                          | Answer                                                                                          |
| --------------------------------- | ----------------------------------------------------------------------------------------------- |
| What is a branch?                 | A dependency-ordered **set** of semantic operations — a poset, not a sequence.                   |
| Why is the set well-defined?      | Every topological sort materializes the same tree (serializability, §1.1). Net effect is unique. |
| Commit vs branch vs phase vs main? | One scale-free object — a labeled set of operations — in different roles and sizes (§2).         |
| What is collapse?                 | Set union; a non-destructive **relabeling** (immutable ops, mutable grouping), not a rewrite.    |
| What is merge / landing?          | Set union under the serializability gate; landing is `main.ops ∪= feature.ops` (§5).             |
| Where does ordering live?         | Semantic order in the poset; policy order layered above, required to extend it (§6).             |
| What about rebase / squash?       | Read-only projections — pick a topo-sort, or take the net effect — never substrate mutations.    |
| How is this past jj?              | jj keeps the sequence as substrate and fixes its naming; here the **set** is the substrate (§7). |
| v1 or the fork?                   | Native on the operation substrate; v1 approximates it over refs at coarser fidelity (§9).        |
