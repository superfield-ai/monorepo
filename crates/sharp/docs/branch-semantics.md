# Branch Semantics: Branches, Phases, and the Plan Loop

A branch is a dependency-ordered **set of operations**, not a sequence of commits. This
document defines that model and then follows it upward through everything it makes
composable: how a branch splits along its conflict boundary (**fission**), how landing
generalizes the merge queue, how phases stop being planning guesses and become admission
controllers, and how the development plan becomes the other half of a closed loop with the
code. `whitepaper.md` ("What the protocol unlocks") summarizes this ladder;
`semantic-patches.md` ("Operations and footprints", "Independence as
conflict-serializability") supplies the substrate it stands on.

**Scope.** Two implementation states are distinguished throughout, and the distinction is
never blurred:

- **[v1].** The substrate is refs to commits (`sharp.refs`); the set-of-operations
  view is *derivable* (diff base against tip) and any dependency relation is inferred at
  **path granularity**, not symbol granularity — v1 approximates the operation model at the
  resolution of files. The landing gate is real and CI-enforced: `merge_flow.rs` refuses a
  merge whose materialized tree fails `cargo check` (`SharpError::MergeRefused`).
  Continuous speculative merge exists in the lazy, poll-only, text-only form documented in
  [`projections.md`](./projections.md) (`projections.rs`): staleness is trigger-driven,
  recompute is read-driven, conflicts surface as a queryable `dilemma` status.
- **[design target].** Symbol-level footprints, fission, the generalized merge queue,
  dynamic phases, and the plan loop all require the operation model of
  `semantic-patches.md` ("Operations and footprints") and are native only there. Present tense below describes
  the target; each section flags its own status.

---

## Branches as sets

An **operation** is a semantic change carrying a **footprint**: a read set `R(o)` and a
write set `W(o)` over symbols, signatures, and type contracts (`semantic-patches.md`,
"Operations and footprints").

A **branch** is a set of operations `B = {o₁ … oₙ}` together with the dependency partial
order they induce. For two operations, `oᵢ ≺ oⱼ` exactly when their footprints conflict —
`W(oᵢ) ∩ (R(oⱼ) ∪ W(oⱼ)) ≠ ∅` or `R(oᵢ) ∩ W(oⱼ) ≠ ∅`, i.e. any Bernstein condition
fails — and authoring causality places `oⱼ` after `oᵢ`. This is
the conflict relation of serializability theory (`semantic-patches.md`, "Independence as
conflict-serializability"); the branch's poset is its precedence graph. Operations with
disjoint footprints are **incomparable**: no order between them is recorded, because none
carries meaning. Conversely, `≺` is *defined* to order every footprint-conflicting pair
within a branch by its authoring order; since a branch is authored as one causal stream,
every such pair is ordered by construction. Internal consistency is therefore structural,
not hoped for — only the **union** of two independently-authored branches can present a
conflicting pair with no order between them, and that case is not a defect of the poset
but the **dilemma** itself, a structured, named conflict report.

A branch is a poset, not a sequence. The linear history git and jj display is one
topological sort of that poset — an arbitrary choice among many.

> **Proposition (well-definedness).** If every non-commuting pair in `B` is ordered by `≺`
> — guaranteed by construction within a branch; a condition to *check* when `B` is a union
> — then every topological sort of `B`, applied to the base tree, materializes the same
> tree. The branch has one net effect, independent of display order.

*Why.* Two topological sorts of a poset differ by adjacent transpositions of incomparable
elements; incomparable means footprint-disjoint, which means commuting. Every non-commuting
pair is pinned by `≺` and never transposed. ∎

The scope of this proposition is exactly its statement: **consistency** — a deterministic,
order-independent net effect. It does not by itself say the result compiles (that is the
verification gate's job) and it says nothing about behavior (see "The generalized merge
queue" for the ceiling).

### One scale-free object, four roles

On this substrate the git distinction between "a commit" and "a branch" — different types,
one a snapshot, one a pointer — dissolves. There is one kind of object, a labeled set of
operations, and it is scale-free:

| git/jj concept  | here                                                   |
| --------------- | ------------------------------------------------------ |
| a commit        | a singleton (one operation)                            |
| a feature       | a small set of operations                              |
| a phase         | a union of feature sets                                |
| main            | the largest set                                        |
| a tree/snapshot | the **materialization** of any set, computed on demand |

"Commit," "feature," "phase," and "main" are **roles and sizes, not types**. Every verb
defined for one role works at every scale — merge, diff, materialize, and the gate all take
"a set of operations" and do not care whether it is one edit or all of main.

### Collapse is set union, and landing is union under a gate

The features→phases→main flow is set algebra: `phase.ops ∪= feature.ops`;
`main.ops ∪= phase.ops`. Union is idempotent and associative, so phases nest and rollup
order among independent features does not matter — the Proposition, one level up. Collapse
is a **relabeling, not a rewrite**: operations are immutable facts; branch and phase labels
are mutable metadata over them. The collapsed view and the granular per-operation view
(with its episodes) coexist permanently — git's squash forces a choice and destroys
identity; union does neither. Names are optional: features are anonymous by default,
identified by task-ID and episode (`jj-adoption.md` §3, §7); labels are spent only on
things addressed repeatedly (phases, main).

**Merge is set union plus the serializability check**, and its two outcomes are the two
halves of the root axiom (`whitepaper.md`, "The root axiom"):

- **Independent** — disjoint footprints: the merge is `B₁ ∪ B₂`, order-free and
  rebase-free. There is no sequence to replay, so there is nothing to rebase; the no-rebase
  property is the absence of the thing rebase operates on.
- **Conflicting** — footprints overlap with no causal order: the overlap is the dilemma,
  named in the language's terms, never as text markers.

**Landing** is the atomic metadata operation `main.ops ∪= feature.ops`, admitted only if
the union passes the gate — a CAS on set membership, not a fast-forward of a pointer.
Because certificates are tri-state (`semantic-patches.md`, "Soundness and the tri-state
certificate"), *unknown* footprints are treated as dependent: the gate errs toward
serializing, never toward silently admitting.

*Status.* v1 approximates all of this at path granularity: the set view is derived by
diffing, union is emulated by squash-export, the gate is the `cargo check` refusal in
`merge_flow.rs`, and projections (`projections.rs`) compute text-level three-way merges
with target-as-base rather than a true common ancestor. The roles table and the gate
discipline are real today; the symbol-granular poset is not.

---

## The landable prefix and fission

*Status: [design target]. Requires symbol-level footprints; v1 has no fission.*

A branch in flight accumulates operations; the projection against its target names, at any
moment, the **conflict set** `C ⊆ O` — the operations whose footprints collide with the
target or with the **frontier** (the union of footprints of all in-flight branches).
Because the branch is a poset, the conflict does not poison the whole branch. Define the
forward slice `↑C = {o ∈ O : ∃c ∈ C, c ≼ o}` — the conflicting operations and everything
that depends on them. The **landable prefix** is

> **L = O ∖ ↑C** — the maximal downward-closed, frontier-disjoint subset of the branch's
> operations.

Downward-closed means nothing in `L` depends on anything outside it, so `L` stands alone;
maximality follows because any downward-closed set avoiding `C` must also avoid `↑C`. This
is program slicing applied to merge scheduling.

**Fission** is the act: land `L` now; the deferred remainder `↑C` becomes a new branch,
born with a machine-named blocker ("waits on the dilemma over `foo::bar`'s signature").
Fission needs **no new kernel verb** — by the kernel admission rule (`whitepaper.md`, "The
protocol") it earns none, because it needs no new authority: it is a partition plus two
ordinary gated merges. The gate is the safety net, not the analysis: it **refuses any cut
whose landed half does not stand alone** — if unknown-heavy footprints or an analysis gap
produced a bad slice, the union simply fails admission (in v1 terms: the materialized tree
fails verification). Fission proposes; the gate disposes.

Three effects follow:

- **Agents self-shape branches to the frontier.** The landable prefix is queryable while
  authoring, so a branch is grown toward "mostly landable" rather than discovered to be
  stuck at PR time.
- **Greedy local landing decongests globally.** Each fission shrinks the in-flight mass
  holding footprints against the frontier — the dynamics of fine-grained locking replacing
  a table lock. (This is an expectation about dynamics, not a theorem; the base-rate
  experiment in `semantic-patches.md`, "Validation: the base-rate experiment", is the
  evidence plan.)
- **Landed footprints become facts.** An in-flight footprint is an estimate; a landed one
  is committed. Every fission converts lower-bound claims on the frontier into settled
  ground the admission controller can trust.

### Additive-first design pressure

Purely additive operations — new definitions, symbols nothing references yet — conflict
with nothing and are always in `L`. What defers is the **wiring**: edits to shared call
sites and hot signatures. An agent optimizing the size of its landable prefix is therefore
pushed, by the gradient rather than by doctrine, toward branch-by-abstraction: land the
substrate now, defer the switchover — the discipline trunk-based development preaches, now
with a machine-checkable criterion. The advisory layer makes the gradient legible: *"this
edit rewrites `foo::bar`'s signature, which sits in 3 live write-sets; the additive
alternative lands today, switchover deferred (unblocked when #841 lands)."* The advisory
layer suggests; it never acts (`whitepaper.md`, "The protocol"). The same query works
pre-code — the frontier is inspectable at design time — and for human developers as PR
annotations. The failure mode this incentive creates (landing substrate, letting wiring
rot) is real and is treated in "Failure modes".

---

## The generalized merge queue

*Status: [design target] as a whole; v1 implements the continuous half in degenerate text
form (`projections.rs`).*

The honest baseline for Sharp is not vanilla git; it is the **merge queue** (bors, GitHub
merge queue), which already provides CI-gated serialized unions with behavioral coverage
(`whitepaper.md`, "Positioning"). A classic merge queue is the **degenerate case** of this
document's model — degenerate in four independent dimensions, each of which Sharp relaxes:

| dimension        | classic merge queue        | sharp (design target)                                  |
| ---------------- | -------------------------- | ------------------------------------------------------ |
| when checked     | once, at land time         | continuously, during authoring                         |
| granularity      | the whole PR               | symbol-level operations (fission lands sub-PR prefixes) |
| certificate      | an opaque CI bit           | named, tri-state structural certificates               |
| admission order  | FIFO                       | any linearization of the dependency poset; policy picks |

The relaxations are what the earlier sections built: the continuous check is the
projection; sub-PR granularity is fission; the certificate names its symbols and admits
*unknown*; and because landing admits any linear extension of the poset, order among
independent work is a **policy** choice ("Policy order"), not a queue accident.

**What survives, deliberately: a thin final CI gate.** Sharp's certificate ceiling is
type-level — it guarantees consistency and reference/type correctness, not behavioral
correctness. Two changes with disjoint symbol footprints can still jointly violate a
runtime invariant (a DB schema, a wire protocol, an ordering or resource budget) that no
symbol graph encodes. Behavioral verification therefore stays in CI: executed-in-CI
assertions are the **complement** of the independence certificate, never replaced by it.
What changes is the queue's *residual* work: branches arriving at the gate are already
structurally merged and type-checked, so a red at the gate is a genuine behavioral
finding, not stale-merge noise. Sharp's differential over the queue it generalizes is
exactly four things: earlier signal (authoring time vs land time), named reasons (a
dilemma vs a red CI bit), no-rebase development, and sub-PR granularity.

In v1 the continuous half exists as `projections.rs`: lazy-on-read recompute, text-only
three-way merge, conflicts surfaced as a queryable `dilemma` status rather than a named
symbol certificate, and no promotion CAS. That is the degenerate-but-real seed of this
section, and [`projections.md`](./projections.md) states its limits plainly.

---

## Dynamic phases

*Status: [design target]. Requires footprints and a live frontier.*

In the roles table a phase is a union of feature sets. Under a static plan, *which*
features share a phase is an upfront bin-packing guess: a planner predicts what will
interfere and partitions work accordingly, and the prediction ages badly as the code
moves. With footprints and projections, the guess becomes measurable, and the phase
becomes an **online admission controller against the live frontier**.

Admission of an emergent feature is one query: intersect its (declared or estimated)
footprint with the frontier.

- **Disjoint** → admit into the current phase; it can proceed concurrently with everything
  in flight.
- **Overlap** → a named dilemma → defer or demote, with a machine-named reason ("writes
  `users` table schema; overlaps in-flight #812") rather than a scheduling hunch.

The formal object: a **dynamic phase** is a maximal antichain of the dependency poset that
is also an independent set of the interference graph — no member waits on another
(antichain), no two members' footprints violate the Bernstein conditions (independent
set), and admission continues until either condition would break (maximal).

Two bounds keep this honest. First, tri-state discipline applies: a footprint that is
*unknown*-heavy (macro-generated code, cross-language seams — `semantic-patches.md`,
"Soundness and the tri-state certificate") is treated as dependent, so admission degrades
toward serialization, never toward false concurrency. Second, the controller is only as
useful as the independence base rate of real concurrent work, which is an **empirical
open question**: honest read sets may saturate the frontier and serialize everything. The
committed measurement is the git-history experiment in `semantic-patches.md`
("Validation: the base-rate experiment"); until it reports, dynamic phases are an argued
design, not a demonstrated one.

---

## The plan loop

*Status: [design target]. Ordered last on the adoption path deliberately — see below.*

A development plan asserts, implicitly, which work items are independent. In this model
that assertion becomes explicit and checkable: **the plan is a hypothesis about
footprints; brokered operations are the measurement; reconciliation is the posterior.**
Each plan unit carries a declared footprint (what this task will read and write —
capture, not reconstruct: emitted at operation-issue time by voluntarily adopted tooling,
`semantic-patches.md`, "Capture, not reconstruction"). As the agent works, realized
footprints stream back, and the delta between declared and realized updates the plan's
dependency structure.

The update rule is **asymmetric**, and the asymmetry is a soundness requirement, not a
style choice:

- **Realized ⊃ declared → tighten immediately.** The task touched more than it declared.
  That is already a fact; re-check the Bernstein conditions against the frontier now, add
  the discovered dependency edge, or demote the task out of its phase.
- **Realized ⊊ declared → loosen only at declared-complete.** Mid-flight, a realized
  footprint is a **lower bound** — the agent may simply not have touched that code *yet*.
  Concluding independence from a partial trace is unsound; the declared envelope stays in
  force until the task declares itself complete, and only then does the plan reclaim the
  unused breadth.

**Plan units co-split with branches.** When fission cuts `L` from `↑C`, the tracking issue
splits with it: *"substrate of X"* (closes when `L` lands) and *"wire X"* (born with the
machine-named blocker that deferred it). The plan's shape stays isomorphic to the actual
partition of the work — no orphaned issue claiming credit for a half-landed feature, no
invisible deferred half.

The loop is bidirectional but not symmetric in authority. The plan's **necessity
structure** — dependency edges and interference — is code-derivable and machine-updated by
exactly the rules above. Everything else about the plan is policy, and policy is
human-sovereign ("Policy order").

**Adoption order.** Deriving plan structure from footprints is the *last* rung of the
adoption ladder, not the first: (1) run the history experiment; (2) ship footprint-overlap
prediction as advisory PR annotations and measure precision/recall against actual
conflicts; (3) only then let footprints gate admission; (4) only then derive plan
structure. Each step is falsifiable and useful alone; the plan loop inherits whatever
error rate the earlier steps measured, so it must not lead.

---

## Policy order

*Status: the layering rule is substrate-independent and applies to v1 today.*

The poset records only **semantic** dependency. Real workflows impose order for reasons
that are not footprint conflicts: land the refactor before the feature though they are
independent, hold a phase for review, sequence by risk, gate on a release train. That is
**policy order** — a separate relation, layered on top.

One rule keeps the layers coherent: **policy order must extend the semantic poset.** Any
policy order `≼` must satisfy `≺ ⊆ ≼`: it may add order between semantically independent
operations; it may never contradict a semantic dependency. Every admissible landing
schedule is a linear (or partial) extension of the poset.

The two layers have different owners, and the sovereignty split is strict:

- The **necessity structure** — dependencies and interference — is code-derivable,
  machine-maintained, and updated by the plan loop's rules. Humans do not hand-edit it;
  they fix the code or the footprints it is derived from.
- The **policy order** is human-sovereign. Machines may *inform* it — the advisory layer
  can annotate a schedule with "this serialization is a choice, not a constraint" so
  humans know which orderings are load-bearing — but machines never overwrite it. A
  bad advisory tip costs efficiency, never correctness.

Review gates, landing queues, and release trains all live in the policy layer, so the
substrate stays "a branch is a set" while real-world sequencing keeps a home. Do not
oversell the set model as "order never matters": semantic order always matters where it
exists, and policy may add more.

---

## Failure modes

The mechanisms above create their own pathologies. Naming them is part of the design.

**Wiring debt and additive-crumb gaming.** If landing is the reward signal, agents will
land trivial substrate and let switchovers rot — the additive-first gradient, gamed. The
countermeasure is to make the deferred half the visible instrument: the *"wire X"* issue
born at fission is the debt record; age it, alarm on it, and make the tracked metric
**wiring issues closed**, not segments landed. Dormant substrate must not fake test
coverage: behavioral acceptance tests attach to the wiring issue, so it cannot close on a
green that never executed the feature.

**Control-loop thrash.** A plan reacting in realtime to fluctuating mid-flight footprints
oscillates: admit, demote, re-admit. Damping is built in at three points: footprints
ratchet outward and are reconciled only at explicit checkpoints (never continuously
downward — the asymmetric rule); demotion requires a dilemma that *persists across N
projection refreshes*, not a transient overlap; and fission deliberately moves the fast
dynamics into the agent (a local response) instead of the planner (a global reshuffle).
A machine-derived plan also ships with a derivation explainer — the human-readable trace
of *why* this edge exists — or humans will route around the plan entirely.

**Frontier saturation.** Honest read sets may be large enough that everything interferes
with everything, collapsing dynamic phases into a serial queue; trimmed read sets break
soundness. There is no design answer to this, only a measurement: the independence base
rate of real concurrent work is empirical, and the committed experiment
(`semantic-patches.md`, "Validation: the base-rate experiment") decides whether the
admission controller admits enough concurrency to be worth its machinery.

**Silent degradation.** Every mechanism here consumes footprints, and footprints come from
per-language oracles. A language without a capable language server falls back to text
three-way merge with every footprint entry marked *unknown* (`semantic-patches.md`,
"Oracle discipline") — which, by tri-state discipline, serializes that language's work
against everything it might touch. That is the intended behavior: degrade honestly toward
less concurrency, never silently toward false independence. A deployment should expect
mixed-language repos to see the full benefit only on oracle-covered languages.

---

## Summary

| Question                          | Answer                                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| What is a branch?                 | A dependency-ordered **set** of operations — a poset; commits/features/phases/main are roles, not types. |
| What is landing?                  | Set union admitted by the serializability gate; a CAS on set membership. v1 gate: `cargo check` refusal. |
| What is fission?                  | Land the landable prefix `L = O ∖ ↑C` now; defer `↑C` as a new branch with a machine-named blocker.      |
| Relation to a merge queue?        | The classic queue is the degenerate case: one-shot, PR-granular, CI-bit, FIFO. Sharp relaxes all four.   |
| What still needs CI?              | Behavior. The certificate ceiling is type-level; executed-in-CI assertions are its complement.           |
| What is a dynamic phase?          | An online admission controller: maximal antichain of the poset ∩ independent set of the interference graph. |
| What is the plan?                 | A hypothesis about footprints, updated by measurement — tighten immediately, loosen only at completion.  |
| Who owns which order?             | Necessity structure: machine-derived. Policy order: human-sovereign, extends `≺`, never contradicts it.  |
| Known failure modes?              | Wiring debt (age the wiring issue), control-loop thrash (damping), frontier saturation (measure), silent degradation (forbidden — degrade loudly). |
| [v1] or [design target]?          | v1: path-granularity approximation, text projections, cargo-check gate. Everything symbol-granular is target. |
