# Ideas Sharp Incorporates From Jujutsu

This is the adoption registry: the `jj` ideas Sharp commits to incorporating, what each
one becomes once the operator is an agent harness rather than a human at a terminal, and
the order in which they land. The analysis behind these choices — what Sharp and `jj`
share philosophically, and where the agent assumption forces divergence — lives in
[`comparison-jujutsu.md`](./comparison-jujutsu.md). The theory behind the conflict
representation is compared against CRDTs and patch theory in
[`comparison-merge-theories.md`](./comparison-merge-theories.md), and the decision to keep
a snapshot substrate while still getting `jj`-style first-class conflicts (item §4 below)
is argued in [`snapshots-vs-patches.md`](./snapshots-vs-patches.md).

A framing note up front: we adopt these ideas because they are _better suited to agent
fleets than to `jj`'s own human audience_. `jj` built lock-free concurrency for the rare
case of two terminals racing; Sharp's normal case is N agents racing. `jj` treats a
divergent change as an anomaly; Sharp's fan-out makes divergence the workload. Most of
what follows is `jj`'s mechanism with its polarity inverted.

---

## 1. The operation/view layer: lock-free concurrency for agent fleets

**The `jj` idea.** Every command loads the repository at a specific **operation** — an
immutable snapshot of a **view** (refs, visible heads, working-copy commits) — works in
full isolation, and commits its own operation as a child of where it started. Operations
cannot fail to commit. Concurrent commands simply produce multiple operation heads; the
next reader merges the divergent views three-way against their common ancestor. Where
views disagree — one operation moved `main` to B, a concurrent one to C — the merged view
records the divergence as data ("main is at B or C") rather than blocking, erroring, or
taking the last writer. No locks exist anywhere in the system.

**What Sharp adopts.** Every mutating API call becomes an operation row in Postgres
pointing to an immutable view; divergent views merge deterministically; ref-level
disagreement becomes a queryable conflicted state (an MV-register, in CRDT terms — see
comparison-merge-theories.md §5) that the harness resolves on its own schedule, exactly
like a Tier 3 dilemma but at the ref layer.

**Why it matters for agents.** Postgres transactions give serialization — the loser of a
ref race aborts and retries. The operation/view layer is strictly better for a fleet:
agents never block, never retry-loop, and never silently clobber each other. Divergence
is recorded, not fought over.

## 2. Episode-scoped universal undo

**The `jj` idea.** Because the view at every operation is immutable, `jj op restore` is
just "point the repo at an earlier operation." Nothing is deleted; rewound commits become
hidden but stay addressable by commit ID.

**What Sharp adopts.** Every operation is tagged with the **episode** that performed it.
"Abort this agent run" becomes _restore the view to the operation before the episode
began_ — one atomic, total rollback of the run's ref and metadata effects. The episode
record and all its commits survive as labeled (negative-example) corpus, per whitepaper
§5.3.

**Why it matters for agents.** Undo for a human is convenience. Undo for a lights-out
pipeline is the difference between "quarantine a bad run in one call" and "hand-unwind a
fleet's interleaved writes."

## 3. Change IDs with intentional divergence: the fan-out primitive

**The `jj` idea.** A stable **change ID** names "this logical change, forever," separate
from the commit ID that moves on every amend or rebase. When one change ID has multiple
visible commits, `jj` calls it a **divergent change** — an anomaly to be repaired.

**What Sharp adopts.** The primitive, with its polarity inverted. The change ID is the
**task/intent ID**. A fan-out of N candidate implementations is a _deliberately_
divergent change: N sibling commits sharing one change ID, addressable as `task/0`,
`task/1`, …. Selection — judge, downstream oracle, or human — is what resolves the
divergence to one visible commit. The losers become hidden-but-addressable, feeding the
negative-example corpus. The `episode_links` relations `sibling` and `superseded_by`
get a crisp data-model home: they are divergence and its resolution.

**Why it matters for agents.** Fan-out stops being a convention layered on branches and
becomes a first-class identity in the data model, queryable as such.

## 4. Algebraic conflict terms: dilemmas that resolve themselves

**The `jj` idea.** An unresolved conflict is stored not as text markers but as an
algebraic term over trees: `A + (C − B)` ("tree A plus the diff from B to C"),
generalizing to any number of terms. The payoff is **cancellation**: rebasing a
conflicted commit from C to D simplifies `D + ((C + (B − A)) − C)` to `D + (B − A)` — no
recursive nesting — and reverting a conflicted commit cancels to a clean tree.
Materialization is lazy. Resolutions, once made, propagate to descendants.

**What Sharp adopts.** The Tier 3 **structured dilemma** (whitepaper §6.5) is upgraded
from a terminal report to a _live algebraic term_ over tree/AST states, re-simplified
every time the speculative-merge projection (§6.7) recomputes. A dilemma whose
conflicting side is later reverted, superseded by a sibling, or rendered moot by upstream
changes cancels to a resolution with no agent ever touching it — the pipeline unsticks
itself. Sharp also adopts the propagation rule: once any agent resolves a dilemma, the
resolution is memoized against the canonical term and applied automatically to every
descendant projection carrying the same term, so the fleet pays for each genuine decision
exactly once.

**Why it matters for agents.** Both properties depend on the term being a _canonical,
deterministic_ description of the divergence — any node computing the same merge derives
the byte-identical term. That determinism (not auto-convergence; see
comparison-merge-theories.md) is what makes memoized resolution safe.

## 5. Workspaces, staleness detection, and recovery commits

**The `jj` idea.** Many working copies (**workspaces**) attach to one repository; the
view records each workspace's working-copy commit. A working copy whose last-updating
operation is no longer current is detected as **stale**; if the operation was lost
entirely, `jj` auto-creates a **recovery commit** from whatever is on disk, so work is
never lost.

**What Sharp adopts.** Each agent sandbox is a registered workspace in Sharp's view. A
crashed or pre-empted agent's half-finished tree is snapshotted into a recovery commit
attached to its episode.

**Why it matters for agents.** Failure stops being lost work and becomes labeled data —
which, for Sharp's training and evaluation consumers, is precisely the point.

## 6. Automatic snapshotting: agents never have dirty state

**The `jj` idea.** The working copy _is_ a commit, snapshotted automatically before every
command. "Uncommitted state" does not exist; the staging area is deleted.

**What Sharp adopts.** The harness snapshots at every tool-step boundary, so an episode's
intermediate states are ordinary, addressable commits in the object store. Episodes
already record intermediate patches as payload (whitepaper §5); promoting them to real
commits unifies the two records.

**Why it matters for agents.** Checkpointing for free: replay, bisect, or resume an agent
run from any step. "Rewind the agent three steps and try a different tool call" becomes a
checkout, not a reconstruction.

## 7. Anonymous heads: delete the naming ceremony

**The `jj` idea.** A chain of commits needs no name to exist; the view tracks anonymous
heads, and names (**bookmarks**) are optional, human-facing labels.

**What Sharp adopts.** With change IDs (§3), the fan-out path needs no branch names at
all: a head is identified by (change ID, episode). Bookmarks exist only where a human
needs a handle during the transition.

**Why it matters for agents.** Agents inventing branch names
(`feat/fix-login-attempt-7-final-v2`) is pure ceremony plus a collision and
namespace-pollution surface. Names are for people; identity is for the data model. The
deeper consequence — that a branch is then a _labeled set of diffs_ rather than a sequence
of commits, with collapse as non-destructive set union — is developed in
[`branch-semantics.md`](./branch-semantics.md).

## 8. A history algebra: the revset vocabulary as SQL functions

**The `jj` idea.** Revsets are a small, closed, composable vocabulary over the commit
DAG — `conflicts()`, `divergent()`, `files(glob)`, `latest(n)`, `x::y`, set
union/intersection/negation — that composes safely no matter how it is combined.

**What Sharp adopts.** Sharp's position has been "SQL is our revset" (whitepaper §3.1).
True but incomplete: recursive-CTE SQL over a commit DAG is easy to get subtly wrong, and
an agent composing it from a prompt will get it wrong at scale. Sharp ships the revset
primitives as named SQL functions and views — `sharp_ancestors(commit)`,
`sharp_dilemmas(repo)`, `sharp_siblings(change_id)`, `sharp_touches(glob)` — a stable
query vocabulary that harness code and prompts compose the way a `jj` user composes
revsets.

**Why it matters for agents.** The engine was never the lesson; the closed vocabulary
was.

---

## Considered and not adopted

- **Pluggable storage backends.** `jj`'s backend abstraction validates that
  database-native storage is not heresy, and we take the lesson of keeping storage behind
  a clean boundary — but Sharp ships and optimizes exactly one substrate, Postgres
  (whitepaper §2.2). The distinction is that Sharp's boundary is _loose coupling_, not
  `jj`'s _portability layer_: one first-class implementation that exploits Postgres fully,
  not a maintained abstraction held to the intersection of several backends. Alternative
  substrates are an admissible, unsupported extension direction — the object/ref plane
  ports, the query/provenance plane is the reason Postgres is the floor. Our workload wants
  one query engine, not a portability layer. See [`storage-substrate.md`](./storage-substrate.md).
- **CLI-first interaction and revsets as a user interface.** Sharp's primary surface is
  library + HTTP + SQL (§2.5 of the comparison doc). We adopt the revset _vocabulary_
  (§8 above), not the terminal-first posture.
- **Conflict deferral to a human.** `jj` records a conflict and waits for a person; in a
  lights-out harness there is no person and no "later." Sharp dissolves conflicts
  deterministically or escalates a structured dilemma — the algebra of §4 makes deferral
  _safe to represent_, but resolution remains the pipeline's job, on the pipeline's
  clock.

---

## Adoption order and dependencies

| Stage | Items                                               | Rationale                                                                                                                                             |
| ----- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | §1 + §2 (operation/view layer, episode-scoped undo) | One feature; the highest-leverage structural change. Fleet-safe concurrency and atomic rollback at once. Everything else records into it.             |
| 2     | §3 + §7 (change IDs, anonymous heads)               | One schema change; makes fan-out first-class. Depends on the view (stage 1) to track anonymous heads.                                                 |
| 3     | §8 (revset vocabulary)                              | Cheap, immediately useful, independent — can land any time after stage 1 defines the view tables.                                                     |
| 4     | §5 + §6 (workspaces, auto-snapshot)                 | Client/harness boundary work; depends on stage 1 (views record workspace commits) and benefits from stage 2 (recovery commits need episode identity). |
| 5     | §4 (algebraic dilemma terms)                        | The deepest merge-engine investment; compounds with the projection machinery and pays off most once stages 1–2 give terms canonical identity.         |
