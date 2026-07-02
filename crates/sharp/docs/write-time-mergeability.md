# Write-Time Mergeability: Admission-Controlled Writes

> **Document status — design proposal.** This document proposes a target model,
> not a report on the current state of `crates/sharp`. It builds on two layers
> that are themselves forward-looking: the continuous speculative merge of
> whitepaper §6.7, implemented today only in the lazy, poll-only, text-only form
> described in [`projections.md`](./projections.md), and the symbol-level
> `R(o)`/`W(o)` access sets of [`semantic-patches.md`](./semantic-patches.md),
> which are explicitly post-v1. Present-tense prose describes the intended
> design. §7 states the design-vs-implemented gap plainly; the bar this document
> holds itself to, like the whitepaper's, is internal consistency, not
> implementation parity.

---

## 1. The axiom, carried one step further

Everything in this proposal is downstream of the root axiom (whitepaper §1.1),
so it is restated first: **a merge conflict is not a property of two changes; it
is a property of two changes and the representation in which the VCS compares
them.** At line altitude, the independence question — _are these two changes
independent?_ — is answered by the wrong proxy, lexical adjacency, and the proxy
fails in both directions: it manufactures conflicts the program does not contain
and it clears merges the program does conflict about. At symbol and type
altitude, independence is computed rather than approximated, spurious conflicts
dissolve, and the conflicts that remain are genuine and precisely nameable
(`semantic-patches.md` §3).

The whitepaper uses that precision to make merges _decidable_. This document
proposes using it to make unmergeable states **inadmissible**.

The reason the axiom must lead is that it is what makes the proposal tolerable
at all. Consider enforcing "your branch must always merge cleanly against its
target" at line altitude: two agents editing adjacent lines of the same config
object — taxonomy class A1, the most common false conflict in practice
([`merge-conflict-taxonomy.md`](./merge-conflict-taxonomy.md)) — would block
each other constantly over conflicts that do not exist. A hard mergeability
gate over a lexical substrate is a denial-of-service on parallel work, which is
why no line-based VCS has ever shipped one and why git's design surfaces
conflicts as late as possible instead. At semantic altitude the same gate is
silent for every pair of changes with disjoint access sets — which the root
axiom argues, and the structured-merge literature measures, is the large
majority. **Precision is the enabling technology for the policy.** The gate
proposed here is only as tolerable as the independence relation is exact; a
Sharp that computed independence loosely could not afford this document.

---

## 2. The flip: from merge-time exception to write-time invariant

Every existing VCS — git, Jujutsu, Pijul, and Sharp v1 — treats mergeability as
a question asked _after_ work is done. A branch accumulates changes in
isolation; at some later integration moment the system computes whether the
accumulated work still composes with the target, and if it does not, a conflict
is reported and someone (or some agent) resolves it. The conflict is an
**exception raised at merge time**. Sharp's continuous speculative merge
(whitepaper §6.7) already improves _when_ the question is asked — continuously,
as either tip advances, rather than at PR time — but the answer is still
advisory: a `dilemma` status is a queryable signal a pipeline polls
(`projections.md`), not a constraint on the branch's ability to proceed.

The proposal is to invert this. **Mergeability against the branch's target
becomes a continuously-enforced write-time invariant: a branch that does not
merge cleanly against its target cannot advance.** A conflicted branch tip is
not an error state to be reported; it is a state the system refuses to
represent — the way a lost compare-and-swap is not an error state a ref passes
through but a write that simply never happened (whitepaper §4.2). Conflicts
move from merge-time exceptions to write-time type errors.

One nuance carries the entire design, so it is stated carefully. Mergeability
against the **fork point** is trivially and permanently true — a branch always
merges cleanly against the commit it forked from, so an invariant phrased that
way enforces nothing. The invariant that matters is against the **moving
current tip of the target**: as the target advances underneath the branch, a
branch that was mergeable a moment ago may no longer be. The target's movement
is not an event the branch's author caused, so the invariant cannot be "the
branch is never in conflict" — that is not within any one writer's power to
maintain. The precise statement is:

> **The invariant.** For a branch `feature` tracking target `target`: a
> conflict between them surfaces within one write of becoming true — on the
> branch's next attempted write, or on the target's next advance, whichever
> comes first — and the branch cannot advance past it until the conflict is
> dissolved.

A conflict may therefore _exist_ transiently (the target moved; the affected
branch has not yet acted), but it cannot be _built upon_. Work never
accumulates on top of a stale, unmergeable foundation, which is the failure
mode the merge-time model permits without bound: in git, a branch can diverge
for weeks, compounding changes over a conflict that became true on day one, and
the whole accumulated interest comes due at once when someone finally merges.
Under the invariant, the maximum outstanding conflict debt is **one write**.

This is a paradigm flip, not a feature addition, and it changes what the
system _is_. A VCS under the merge-time model is a historian: it records what
each author did and reports, after the fact, where the records disagree. A VCS
under the write-time model is an **admission controller**: it decides, at the
moment of each write, whether the write is consistent with the world it must
eventually join, and refuses admission otherwise. §8 returns to this framing.

---

## 3. Why agents make this newly possible — and why git never could

The write-time model is not a new idea whose time has come; it is an old
impossibility whose preconditions have changed. Three properties of
agent-authored change, none of which holds for human-authored change, make the
flip feasible now. This section is the load-bearing argument of the document.

### 3.1 Writes are brokered tool calls, observable at authoring time

A human edits text in an editor the VCS does not mediate; the VCS first learns
about the change when the human volunteers it (`git add`), long after authoring
intent is gone. An agent in a harness does not edit this way. The harness
_issues_ the change as a brokered tool call — a language-server rename, a
scoped edit to a named symbol, a move refactor — and the operation is
observable at authoring time with its exact language-computed access sets, no
reconstruction heuristic required (`semantic-patches.md` §6). The write path
therefore has a natural interposition point that git's design never had:
**every write already passes through a broker that can say no.** Admission
control requires an admission point, and the agent-first setting supplies one
for free, as a property of how agents author rather than as new ceremony
imposed on them.

### 3.2 Interruption is cheap, and resolution happens in-context

The deeper reason git could never enforce this is human interruption cost.
Stopping a human mid-thought to resolve a conflict someone else just created is
expensive and infuriating; batching conflicts to a single merge moment is a
_concession to human attention_, not a virtue of the model. But the batching
has a hidden price: by the time a merge-time conflict is resolved, the author's
context is gone. The human who wrote the conflicting change has moved on;
whoever resolves the conflict — often someone else entirely — must reconstruct
two sets of intentions from diffs and commit messages. Merge-time resolution
is resolution by archaeology.

For an agent, interruption is just a tool result. A rejected write arrives as
a structured response in the same conversational turn as the write itself,
while the intent behind the change is still in the agent's context window. The
conflict is resolved **by the agent that caused it, at the moment it is
caused, with its reasoning still live** — the exact inversion of the
archaeology model. The agent reads the structured dilemma (whitepaper §6.5),
adjusts its approach, and continues; no context is reconstructed because no
context was lost. What made continuous enforcement intolerable for humans —
constant interruption — is, for an agent, indistinguishable from normal
operation.

### 3.3 The gate is silent where it should be

§1 already made this argument and it completes the triad: at semantic
altitude, disjoint access sets pass the gate with no interaction at all, so
the common case — parallel work on independent symbols — proceeds exactly as
it would without the invariant. The gate only speaks when independence
genuinely fails, and then it speaks in the language's own terms: _these
symbols, this contract_. A precise gate that is silent for independent work
and specific when it fires is a tool an autonomous pipeline can live inside.
An imprecise gate is a wall. Git's substrate could only ever build the wall,
which is why it never built the gate.

---

## 4. Three enforcement points

The invariant is enforced at three escalating points on the write path. Each
catches what the previous one let through; each is cheaper than letting the
conflict age past it.

### 4.1 Plan admission: declared write sets and advisory leases

Before an agent writes anything, its dispatching coordinator declares the
task's **predicted write set** — the symbols, signatures, and contracts the
task expects to modify, in the same `W(o)` vocabulary the operation substrate
defines (`semantic-patches.md` §3). The coordinator checks predicted sets
across in-flight tasks at dispatch time: tasks with disjoint predictions run
concurrently; tasks with overlapping predictions are serialized or re-scoped
**before either has written a line**. This is the cheapest possible
enforcement point — a conflict avoided at planning costs nothing but a
scheduling decision.

Two design constraints keep this honest:

- **Leases, not locks.** A declared write set is an **advisory lease with an
  expiry**, never a lock. Sharp's ref plane is lock-free by construction —
  refs advance via compare-and-swap precisely so that no writer can wedge the
  system by holding something (whitepaper §4.2), and landing on the
  set-of-diffs model is likewise a CAS on set membership
  ([`branch-semantics.md`](./branch-semantics.md) §5). A lease that could
  block indefinitely would reintroduce, at the planning layer, the
  held-resource failure mode the storage layer was designed to exclude. A
  lease expresses _intent_ that scheduling should respect; it expires if the
  holder stalls, and it is never consulted by the correctness machinery below
  — §4.2 and §4.3 enforce the invariant whether or not any lease was ever
  taken. Leases are an optimization on conflict _latency_, not a guarantor of
  conflict _absence_. In the terms of `branch-semantics.md` §6, a lease is
  **policy order**: it may add scheduling order between semantically
  independent tasks, and it may never substitute for the semantic check.

- **Graceful widening.** Predicted write sets will be wrong — an agent
  partway through a task discovers it must touch a symbol it did not declare.
  This is a normal event, not a contract violation. The agent issues a
  **lease-expansion request** as an ordinary tool call; the coordinator
  grants it if the widened set is still disjoint from other live leases, or
  returns the overlap as a structured scheduling dilemma if not (wait,
  negotiate, or re-scope). A model that punished mis-prediction would teach
  agents to over-declare, and universally over-declared write sets degrade to
  a global lock. The incentive design matters as much as the mechanism.

### 4.2 Write admission: per-edit checking against the speculative merge

The plan layer schedules; the write layer enforces. Every semantic edit an
agent submits is checked, at admission, against the **current speculative
merge with the target tip** — the same `(feature, target)` projection
whitepaper §6.7 defines, consulted per-write instead of polled:

- **Disjoint fast path.** If the edit's access sets are disjoint from
  everything the target has accumulated since the branch's last
  synchronization point, the write is admitted with **no merge analysis at
  all** — a set-intersection test, not a merge. By the root axiom's corpus
  expectation this is the overwhelmingly common case, and it is what makes
  per-write enforcement affordable (§7.3).
- **Overlap path.** If access sets intersect, Tier-1 semantic merge runs
  incrementally over just the affected symbols — not the whole tree — using
  the same analyzers (`ts.LanguageService`, rust-analyzer) that computed the
  sets. If Tier 1 resolves deterministically and the result passes intrinsic
  verification (whitepaper §6.2), the write is admitted and the projection
  advances with it.
- **Rejection is a structured dilemma, delivered as a tool result.** If the
  merge cannot be resolved, the write is refused and the agent receives the
  Tier-3 structured dilemma (whitepaper §6.5) — which symbols are in tension,
  what the candidate resolutions were, what would decide it — as the tool
  call's response. This is the §3.2 property doing its work: the dilemma
  lands in the context of the agent whose write created it, in the turn that
  created it.

### 4.3 Tip advance: the hard gate

The final enforcement point is the invariant itself, stated as a ref rule:
**the branch ref advances only if the speculative-merge projection
`refs/sharp-merged/<feature>--<target>` is green** — status `clean`, intrinsic
verification passed. The CAS that advances the feature tip is conditional not
only on the expected old value (as every Sharp ref CAS already is) but on the
mergeability of the new one. A write that would make the branch unmergeable
does not produce a conflicted branch; it produces a failed CAS and a dilemma.
The unmergeable branch tip is **unrepresentable**.

The target's side of the invariant is handled by the same machinery running in
the other direction. When the target advances (a sibling branch lands), every
projection onto it goes stale — exactly as today (`projections.md`) — but
staleness is no longer a fact awaiting a poll. It is **pushed into the
affected agents' loops as an interrupt-quality event**: the harness surfaces
it as a tool result at the agent's next step, and the agent performs the
micro-merge _now_, while both its own intent and the landed change are fresh —
not at PR time, after both have gone cold. Each landing thus fans out a wave
of small, immediate, in-context reconciliations instead of banking a large,
deferred, out-of-context one.

The payoff at the end of the pipeline is that **landing degenerates to the
no-op it was always supposed to be.** Whitepaper §6.7 already promises that
merge time is a single CAS promoting the projection's commit — no merge logic
runs at landing because the speculative merge _is_ the merged state. Under the
write-time invariant that promise stops being contingent: the projection is
green not because it happened to be recomputed recently but because green is
the only state the branch was ever permitted to occupy. The merge queue — the
serialization point where CI systems today burn hours revalidating stale
branches — has no work left to do.

---

## 5. The database analogy, completed

Sharp's merge model is already borrowed from database concurrency theory, and
the flip is best understood as finishing the borrowing.
[`branch-semantics.md`](./branch-semantics.md) models a branch as a
transaction: a set of operations, each carrying read and write sets `R(o)` /
`W(o)` over the symbol graph, with merge as **set union plus the
serializability check** (`branch-semantics.md` §5, `semantic-patches.md` §3 —
the Bernstein conditions, applied to symbols instead of rows).

What that model left open is _when_ the serializability check runs, and
database systems have named both answers. Checking at commit time — let the
transaction run against its snapshot, validate at the end, abort on conflict —
is **optimistic concurrency control**, and it is exactly Sharp's current
posture: the branch works in isolation, the projection detects violations, and
detection can arrive arbitrarily long after the violating write. Checking at
write time — validate each access as it happens, so a doomed transaction
learns it is doomed at the first conflicting access rather than at commit —
is the immediate-validation family. The flip proposed here is precisely that
move: **from detecting serializability violations at commit to enforcing
serializability at each write.**

The database experience also explains why the write-time answer is right for
this workload. Optimistic control wins when conflicts are rare _and aborts are
cheap_. For a database transaction an abort discards milliseconds of work. For
a feature branch, "abort" means discarding or reworking an agent-run's worth
of accumulated changes — the most expensive artifact in the system — and the
cost grows with every write stacked on top of the undetected conflict.
Write-time validation caps the loss at a single operation. The analogy is not
decoration; it is the same theorem with a different unit of work, and the unit
of work is what decides the policy.

---

## 6. What this demands of the roadmap

The proposal reorders Sharp's own priorities, and honesty requires saying so
plainly rather than presenting the model as a free consequence of existing
plans.

**The semantic-operation substrate moves onto the critical path.** The
`R(o)`/`W(o)` access sets that every enforcement point above consumes are the
post-v1 fork of `semantic-patches.md` — deliberately deferred, gated on the
canonical-diff crux (§5 there), with the decision explicitly held open pending
the §8 spikes. Write-time mergeability cannot be built without them: the
disjointness fast path (§4.2) _is_ an access-set intersection, and the lease
vocabulary (§4.1) _is_ a declared write set. Adopting this proposal therefore
means promoting the operation substrate — at minimum its access-set extraction
for declared structural operations, the part `semantic-patches.md` §6 argues
is capture rather than reconstruction — from "reconsider when the spikes
report" to a prerequisite. The canonical-diff crux does not get easier because
this document wants it solved; the dependency runs in one direction only.

**Projections go from lazy/poll/text-only to eager/push/full-pipeline.** The
implemented projection layer ([`projections.md`](./projections.md)) is a
correct skeleton of the wrong temperament for this model: recomputation is
lazy-on-read, staleness is a status a pipeline polls, the merge is Tier-1
_text_ only (the semantic tiers, intrinsic verification, and hooks are not
wired in), there is no real common-ancestor walk, and neither the
`refs/sharp-merged/...` ref nor the no-op CAS promotion exists yet. Every one
of those becomes load-bearing here: enforcement needs the projection
recomputed eagerly on target advance (or incrementally per admitted write),
staleness delivered as a push into the agent loop rather than a poll,
and the full merge model — not text merge — deciding admission. The
projection stops being a cache of an answer and becomes the enforcement
mechanism itself, and its engineering budget should be priced accordingly.

---

## 7. Honest hard problems

Three problems are real, unsolved in this document, and stated rather than
minimized.

### 7.1 Hot symbols and liveness

The gate is silent for disjoint work, but real codebases have symbols that are
_structurally_ non-disjoint: the enum every feature adds a variant to, the
registry every module appends to, the barrel file every export passes through.
Two agents extending the same enum have overlapping write sets by any sound
analysis, so under a naive reading of the invariant they serialize — and a hot
enough symbol serializes the whole fleet. This is the liveness risk: the
write-time model converts a class of merge conflicts into a class of
contention, and contention on hot symbols could be worse than the conflicts
were.

The escape hatch is only expressible at semantic altitude, which is why it
belongs to Sharp and not to a line substrate: **commutative operation types.**
"Add a variant to this enum" and "add an entry to this registry" are
operations whose results compose by set union regardless of order — the
merge-conflict taxonomy's class A1/A2 (parallel additions), where the correct
resolution is always _both, in either order_. Declaring these as commutative
operation kinds — CRDT-style, with set-union merge semantics — lets the
admission gate treat two additions to the same symbol as **disjoint by
construction**, because the operation type itself carries the proof that
order does not matter. A line substrate cannot express this (two additions
collide as text no matter what); an operation substrate can, because the
operation, not its textual footprint, is the stored unit. Identifying which
operation kinds are safely commutative per language — and refusing the
annotation where ordering is semantically observable (a Rust enum whose
discriminant values matter, an ordered match) — is real per-language design
work the operation vocabulary (`semantic-patches.md` §2) does not yet include.

### 7.2 The type-level ceiling still holds

Nothing in this proposal moves the automated ceiling the whitepaper fixes
(§1.1): the invariant enforces _consistency_ and _reference- and type-level
correctness_, not _behavioral correctness_. Two writes with disjoint access
sets pass every gate in §4 and can still jointly violate a behavioral
invariant the type system does not encode. The flip **narrows the conflict
surface — it does not eliminate integration risk.** Tests, hooks (whitepaper
§6.3), and the Tier-2 oracle remain exactly as necessary as before; what
changes is that they run against branches that are always structurally
mergeable, so a test failure at integration is a genuine behavioral finding
rather than noise from a stale merge. Claiming more than that would repeat the
mistake the root axiom exists to bound.

### 7.3 Cost

Continuous enforcement is not free. Every target advance potentially touches
every in-flight branch: the cost of a landing is **O(in-flight branches)**
staleness events, each of which may trigger analysis. Two mitigations keep
this from being disqualifying, and both are already in the design's
vocabulary:

- **The disjointness fast path.** The access-set intersection test (§4.2)
  is a set operation over symbol identifiers — no analyzer, no
  materialization. By the corpus expectation that most concurrent work is
  independent, most staleness events resolve to "still disjoint, still
  green" at set-intersection cost, and the fan-out is cheap in the common
  case. This is the same lever `projections.md` already pulls (staleness
  marking is cheap; expensive work is deferred to where it is needed) —
  retargeted from read-driven to overlap-driven.
- **Incremental analyzers.** Where overlap does force analysis, the
  analyzers Sharp delegates to (whitepaper §2.1) are built for exactly this
  shape of work: rust-analyzer and `ts.LanguageService` are incremental
  engines designed to revalidate small deltas against a warm index at
  editor-keystroke latency, not batch compilers. Putting the analyzer on
  the write path is a real latency budget (`semantic-patches.md` §7 prices
  this for authoring; admission adds a second consumer), but it is the
  workload these tools were engineered for.

Whether the two mitigations hold at fleet scale — hundreds of in-flight
branches over a hot monorepo — is an empirical question in the same class as
the `semantic-patches.md` §8 spikes, and should be measured on the same
corpus before the model is committed to.

---

## 8. Summary

| Question                              | Answer                                                                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| What flips?                           | Mergeability: from a merge-time exception to a continuously-enforced write-time invariant. An unmergeable branch tip is unrepresentable.   |
| Against what is mergeability checked? | The moving current tip of the target — never the fork point, where it is trivially true.                                                    |
| The invariant, precisely?             | A conflict surfaces within one write of becoming true and must be dissolved before the branch advances. Max conflict debt: one write (§2).  |
| Why is this possible now?             | Agent writes are brokered tool calls with exact access sets; interruption is a tool result; resolution happens in the author's live context (§3). |
| Why was it never possible before?     | At line altitude the gate fires spuriously and constantly; semantic independence keeps it silent for disjoint work (§1, root axiom).        |
| Where is it enforced?                 | Plan admission (advisory leases, not locks), write admission (disjoint fast path / incremental Tier 1 / Tier-3 dilemma), tip advance (§4).  |
| The database frame?                   | Branches are transactions with `R(o)`/`W(o)` sets; the flip is immediate serializability validation instead of commit-time detection (§5). |
| What does it demand?                  | Access sets promoted to the critical path; projections from lazy/poll/text-only to eager/push/full-pipeline (§6).                           |
| What stays hard?                      | Hot-symbol liveness (escape hatch: commutative operation types), the type-level ceiling, O(in-flight branches) cost per landing (§7).       |

Git records what happened and reports conflicts as history; Sharp under this
model admits what may happen and makes an unmergeable branch unrepresentable —
a VCS as admission controller rather than historian.
