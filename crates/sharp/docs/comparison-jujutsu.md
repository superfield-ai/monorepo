# Sharp and Jujutsu (`jj`): Shared Instincts, Divergent Audience

Of the post-Git version control systems, [Jujutsu (`jj`)](https://github.com/jj-vcs/jj) is the one Sharp is closest to in spirit. We arrived at many of the same conclusions about what is wrong with Git's model, and in several places `jj` is the prior art that validates a decision Sharp also made. This document is an honest accounting: what we share with `jj` philosophically and at the implementation layer, and what has to change once you stop assuming a human is the one producing — and resolving — the code.

`jj` is a shipping, widely used, human-facing VCS with years of production hardening. Sharp is a v1 substrate aimed at lights-out, agent-authored development. The comparison below is not "which is better" — they are pointed at different operators. It is "where the same idea shows up, and where the agent assumption forces it to mutate."

---

## 1. What We Share

### 1.1 Keep Git's object model; change everything around it

`jj`'s defining pragmatic bet is that the blob/tree/commit/ref content-addressed core is _right_, and that the things worth replacing are the working-copy model, the conflict model, and the operation model layered on top. `jj` runs on a Git backend by default and interoperates with Git remotes precisely because it does not relitigate the object graph.

Sharp makes the identical bet, and pushes it one notch harder: Sharp's object IDs _are_ Git's object IDs, byte-for-byte (whitepaper §2.2, §4.0). We keep blob/tree/commit/ref and Git's content-addressing hash so that import and export round-trip against real GitHub remotes without a mapping table. Both systems treat "Git's data model good, Git's _workflow_ bad" as the starting axiom.

### 1.2 The backend is not sacred — and it does not have to be a filesystem

`jj` abstracts the storage backend behind an interface. The open-source default is the Git backend on local disk, but the same abstraction is what lets Google run `jj` against a cloud backend internally. The lesson `jj` teaches is that "the repository is a `.git` directory on a filesystem" is an assumption, not a requirement.

Sharp takes that lesson to its conclusion: **all repository state lives in a single queryable storage substrate** (whitepaper §2.3) — objects, refs, semantic representations, episodes, and mutable metadata in one store, realized on PostgreSQL in v1 ([`postgres-storage-plugin.md`](./postgres-storage-plugin.md)). `jj`'s pluggable-backend design and Google's cloud backend are, to us, direct validation that putting a VCS behind a query engine is not heresy. We made one substrate the only one Sharp ships rather than one of several, because our workload (agent harnesses issuing concurrent queries over history and provenance) wants a query engine, not a file tree. This is a substrate choice downstream of the semantic-independence thesis (whitepaper §1.1), not the headline of the design.

### 1.3 Conflicts are data, not a stop-the-world text edit

This is the deepest shared instinct. Git treats a conflict as an interruption: it writes `<<<<<<<` markers into your working tree and refuses to proceed until a human edits them out. `jj` rejects this outright. In `jj`, **conflicts are first-class objects recorded inside commits**. A merge that conflicts still produces a commit; you can keep working on top of it, rebase it, and resolve the conflict later, at leisure. Conflicts propagate and are tracked rather than blocking the world.

Sharp shares the conviction that text-marker conflicts are a design failure, and never emits conflict markers (whitepaper §6.5). Where `jj` _stores_ the conflict and defers it to a human, Sharp tries to _dissolve_ it deterministically (§3.1) and, when it genuinely cannot, returns a **structured dilemma** — a machine-readable description of which AST nodes are in tension and what the candidate resolutions were. Same refusal to stop the world with text markers; different thing produced at the point of irreducible disagreement, for reasons that are entirely about audience (§2.1).

### 1.4 A complete, queryable record of operations — and real undo

`jj`'s operation log is one of its best ideas: every command that mutates the repo is recorded as an operation, the whole history of operations is inspectable, and `jj undo` / `jj op restore` can rewind _any_ operation, not just commits. The repo's evolution is itself a first-class, navigable artifact.

Sharp shares the "record everything, nothing is lost" ethos but instantiates it along a different axis. Our immutable commits + append-only **episodes** (whitepaper §5) plus a mutable-metadata layer (§2.5) give the same "you can always see how you got here and revise annotations without rewriting facts" property. `jj`'s op-log records _what VCS operations happened_; Sharp's episode log records _why the code is what it is_ (§2.2 below). They are complementary records of the same underlying value: history should be a queryable substrate, not an opaque side effect.

### 1.5 Stable identity, separate from the rewritable view

`jj` separates the **change ID** (stable across rewrites — it names "this logical change" forever) from the **commit ID** (which changes every time the change is amended or rebased). You point at the stable thing; the materialized commit underneath is free to move.

Sharp has the same shape in its **continuous speculative merge** (whitepaper §6.7). The feature branch's commits and SHAs are stable forever; the "rebased onto main" view is a _projection_ — a derived ref that recomputes whenever either side advances — never a rewrite of the branch. Both systems answer "how do I keep a thing current without destroying its identity?" by splitting a stable anchor from a moving derived view.

### 1.6 Kill the rebase dance

`jj` makes rebasing cheap, automatic, and non-blocking: descendants auto-rebase, and because conflicts don't halt anything, a rebase that conflicts still completes and leaves the conflict recorded for later. The destructive, force-push-laden Git rebase ritual largely evaporates.

Sharp eliminates rebase as a _concept_: there is no `sharp rebase` (whitepaper §6.7). A feature branch never needs to be rebased onto its target because the speculative-merge projection _is_ the up-to-date merged state, and landing is a no-op CAS promotion. Both systems independently concluded that "stop, rewrite history, resolve everything at once, force-push" is the single worst recurring Git workflow — and both removed the need for it. We removed it harder because an agent fan-out cannot tolerate one branch's rebase blocking the others.

### 1.7 Drop the ceremony

`jj` has no staging area / index — the working copy _is_ a commit, snapshotted automatically. It deletes a whole category of Git ceremony (`git add -p`, the index, detached HEAD confusion). Sharp's "minimalist merge" (whitepaper §2.6) is the same impulse applied to the merge surface: one merge model, no rebase variant, no fast-forward variant, no workflow-specific command sprawl. Both treat Git's proliferation of workflow commands as a cost to be paid down, not a feature.

---

## 2. What Has To Change Because Agents Write the Code

Everything in §1 is a shared _instinct_. The divergence is not that we disagree with `jj` — it is that `jj`'s design has a human in two specific roles that Sharp cannot assume: the human who _resolves the conflict_ and the human who _knows why the change was made_. Remove that human and several of `jj`'s elegant deferrals stop working.

### 2.1 The conflict's audience is a machine, so deferral is not enough

`jj`'s first-class conflict is brilliant _for a human_: it lets you keep moving and come back to resolve the markers when you have the context and the attention. The resolution mechanism is still, ultimately, a person reading a materialized conflict and editing it.

In a lights-out harness there is no person and no "later." A recorded-but-unresolved conflict is not progress; it is a stuck pipeline. So Sharp cannot stop at "store the conflict and defer." It needs to _resolve_ far more cases automatically and _refuse to guess_ on the rest:

- **Tier 1 deterministic semantic merge** (whitepaper §6.1) collapses the common cases `jj` would record as conflicts into a single answer, using the language's own rename/reference APIs (`ts.LanguageService`, rust-analyzer) rather than text three-way merge.
- **Structured dilemma, not materialized conflict** (§6.5): when Sharp truly cannot decide, it hands the calling agent a machine-readable description of the tension — nodes, candidates, verification failures, oracle result — because an agent needs a _decision problem it can act on_, not conflict markers it would have to re-parse.

`jj` defers the conflict to a human; Sharp dissolves it or escalates it as structured data. Same anti-text-marker philosophy, forced one step further by the absence of a resolver.

### 2.2 The record has to capture _why_, not just _what_

`jj`'s operation log answers "what operations were run against this repo." That is the right record for a human driving a CLI. It says nothing about _why the code contains what it contains_, because for a human that lives in their head and their PR description.

When an agent authored the change, the "why" is the most valuable artifact in the system, and it is structured: the prompts, the retrieved context, the tool-call trace, the intermediate patches, the validation results, the judge/selector outcome, and the snapshot that won. Sharp records all of it as first-class **episodes** attached to the commit (whitepaper §5). `jj` has no analogue and shouldn't — its operator doesn't need one. Sharp's operator (a training/eval/audit pipeline) needs nothing more.

### 2.3 Correctness needs a gate a human's eyes used to provide

When a human resolves a `jj` conflict, their judgment is the correctness check — they look at the merge and know if it's wrong. Remove the human and that check is gone. Sharp replaces it with **intrinsic verification** (whitepaper §6.2): every candidate merge tree must parse, resolve its symbol references, and pass the language's own diagnostics (`getSemanticDiagnostics`, `cargo check`) before it can be emitted. The guarantee — _Sharp never silently emits a wrong merge that would not compile_ — is only necessary because there is no human glance to catch it. `jj`, being language-agnostic by design, has no semantic layer and needs none; its human supplies it.

### 2.4 Fan-out and negative examples are the workload, not an edge case

`jj`'s model — even with its excellent history-editing — is fundamentally one operator making a sequence of edits. The operation log is sequential. Agent harnesses invert this: they fan out _N_ candidate changes from the same parent, score them, and select one. Sharp's data model is built for that shape directly — `episode_links` with `sibling` / `superseded_by` relations (§5.1), and per-branch speculative-merge projections so concurrent branches never block each other (§6.7).

And critically, the _losers_ are data. Sharp keeps **failed siblings** as first-class, queryable rows with their full trace (§5.3) — the negative-example corpus for training and evaluation. `jj` lets you undo and discard a bad attempt; the discarded attempt carries no labeled meaning afterward. For Sharp, "what was tried and rejected, and why" is a primary asset.

### 2.5 The primary interface is an API, not a CLI

`jj` is, correctly, CLI-first, with a revset query language for a human to slice history at the terminal. Sharp's primary consumer is a harness, so the primary surface is a **library + HTTP API plus an operator-scoped read-only query passthrough** (whitepaper §3.1), with the Git-shaped CLI retained for the humans still in the loop during the transition. Querying the store for every projection whose status is `dilemma` (§6.7) is the agent-native equivalent of a revset — a queryable signal a pipeline can poll, not a command a person types.

### 2.6 Replay-as-evaluation has no VCS precedent

Because Sharp records an episode's full input boundary, it can **replay** it against a newer model or harness and produce a _new_ episode linked to the original (whitepaper §5.4). Bulk replay over a corpus of historical episodes turns every model or harness upgrade into a measured experiment against real production workloads. This is meaningless in a human VCS — you cannot "replay" a developer — so `jj` has nothing here, and Sharp treats it as a killer feature.

---

## 3. Summary Table

| Dimension                   | Jujutsu (`jj`)                                                                              | Sharp                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Git object model            | Kept (Git backend)                                                                          | Kept, byte-isomorphic (Git hash)                                                        |
| Storage backend             | Pluggable; Git-on-filesystem default, cloud backend at Google                               | Single queryable substrate (PostgreSQL plugin in v1)                                    |
| Conflicts                   | First-class, recorded in commits, deferred to a human                                       | Dissolved deterministically; else machine-readable structured dilemma                   |
| "Record everything"         | Operation log + universal undo                                                              | Immutable commits + append-only episodes + mutable metadata                             |
| Stable vs. moving identity  | Change ID (stable) vs. commit ID (moves)                                                    | Feature branch SHAs (stable) vs. speculative-merge projection (moves)                   |
| Rebase                      | Cheap, automatic, non-blocking                                                              | Eliminated entirely; projection replaces it                                             |
| Provenance of intent        | Out of scope (lives with the human)                                                         | First-class episodes: prompts, context, traces, judge outcomes                          |
| Merge correctness gate      | The human's judgment                                                                        | Intrinsic verification (parse + symbols + language diagnostics)                         |
| Fan-out / negative examples | Sequential edits; discarded attempts unlabeled                                              | Concurrent siblings; failed siblings kept as corpus                                     |
| Primary interface           | CLI + revsets                                                                               | Library + HTTP + SQL; CLI for humans                                                    |
| Replay for evaluation       | N/A                                                                                         | Replay episodes against new models/harnesses                                            |
| Concurrency model           | Lock-free operation-log DAG; divergent views auto-merged, ref disagreement recorded as data | Postgres transactions today; operation/view layer is the planned borrow (§4.1)          |
| Working copies              | Many workspaces per repo; staleness detection, recovery commits                             | Agent sandboxes; workspace registration and recovery commits are planned borrows (§4.5) |

---

## 4. What Sharp Should Borrow: `jj`'s Power Ideas, Ranked for Agent-First Development

The borrowing is not one-directional. A deeper read of `jj`'s design documents — the concurrency model, the conflict algebra, the working-copy and workspace machinery — surfaces a set of ideas that are not merely compatible with an agent-first substrate but are _better suited to it than to `jj`'s own human audience_. Ranked by leverage for Sharp:

One framing correction first: `jj` is sometimes described as bringing "Darcs-like patch theory" back. It does not — `jj` is snapshot-based, like Git (Pijul is the patch-theory heir). What `jj` actually has is an **algebraic representation of conflicts over snapshots** (§4.4 below), which delivers the practically valuable slice of patch theory — conflicts that compose, commute, and cancel — without the theoretical machinery. That distinction matters for Sharp: borrow the algebra, not the theory.

### 4.1 The operation log as a DAG: lock-free concurrency for agent fleets

`jj`'s deepest implementation idea is not undo — it is _how_ undo falls out of the concurrency model. Every command loads the repo at a specific **operation**, works against that immutable snapshot in full isolation, and commits its own operation as a child of where it started. Operations cannot fail to commit. Concurrent commands simply produce multiple operation heads, and the next reader auto-merges the divergent **views** (3-way, against the common-ancestor view). Where the views disagree — one operation moved ref `main` to B, a concurrent one moved it to C — the merged view _records the divergence as data_ ("main is at B or C") instead of erroring, blocking, or last-writer-wins. No locks anywhere; `jj` is safe even on rsync'd/Dropbox'd storage.

This is the exact shape of Sharp's primary workload: N agents mutating one repo concurrently. Postgres gives Sharp transactions and MVCC, but transactions only give _serialization_ — the loser of a ref race gets an abort and must retry. `jj`'s model is strictly better for a harness: **every API mutation becomes an operation row pointing to an immutable view; divergent views merge deterministically; ref-level disagreement becomes a queryable conflicted state** the harness resolves on its own schedule, exactly like a Tier-3 dilemma but at the ref layer. Agents never block, never retry-loop, and never silently clobber each other.

### 4.2 Universal undo: `op restore` as the episode-scoped safety rail

Given 4.1, `jj undo` / `jj op restore` is just "point the view at an earlier operation" — nothing is deleted, rewound commits become hidden but stay addressable by commit ID. For Sharp this is the missing operator-and-harness recovery primitive: tag every operation with the **episode** that performed it, and "abort this agent run" becomes _restore the view to the operation before the episode began_ — one atomic, total rollback of the run's ref and metadata effects, while the episode record and all its commits survive as the (negative-example) corpus. Undo for a human is convenience; undo for a lights-out pipeline is the difference between "quarantine a bad run in one call" and "hand-unwind a fleet's interleaved writes."

### 4.3 Change ID + intentional divergence: the native fan-out primitive

`jj` separates the stable **change ID** ("this logical change, forever") from the moving commit ID, and calls it a **divergent change** when one change ID has multiple visible commits — in `jj`, an anomaly to be repaired. Sharp should adopt the primitive and _invert its polarity_: the change ID is the **task/intent ID**, and a fan-out of N candidate implementations is a _deliberately divergent change_ — N sibling commits sharing one change ID, addressable as `task/0`, `task/1`, … Selection (judge, oracle, human) is what _resolves_ the divergence down to one visible commit; the losers become hidden-but-addressable, feeding §5.3's negative-example corpus. This gives Sharp the lightweight "stable anchor, moving view" identity noted earlier, plus a crisp data-model home for `episode_links`' `sibling`/`superseded_by` relations: they are divergence and its resolution.

### 4.4 The conflict algebra that cancels: dilemmas that resolve themselves

`jj` stores an unresolved conflict not as markers but as an algebraic term over trees: `A + (C − B)` ("A plus the diff from B to C"), generalizing to any number of terms. The payoff is **cancellation**: rebase a conflicted commit from C to D and the term `D + ((C + (B − A)) − C)` simplifies to `D + (B − A)` — no recursive nesting; revert a conflicted commit and the terms cancel to a clean tree. Materialization is lazy.

Sharp's structured dilemma (§6.5) is today a terminal report. Borrowing the algebra makes it a _live_ term: store the dilemma as an expression over tree/AST states, and re-simplify it every time the speculative-merge projection recomputes. A dilemma whose conflicting side is later reverted, superseded by a sibling, or rendered moot by upstream changes then **cancels to a resolution with no agent ever touching it** — the pipeline unsticks itself. Pair it with `jj`'s resolution-propagation rule: once any agent resolves a dilemma, that resolution is memoized and automatically propagated to every descendant projection carrying the same term, so the fleet pays for each genuine decision exactly once.

### 4.5 Workspaces, staleness detection, and recovery commits: crash-safe materialization

`jj` supports many working copies on one repo (**workspaces**), records each workspace's working-copy commit in the view, detects when a working copy is **stale** (the operation that last updated it is no longer current), and — if the operation was lost entirely — auto-creates a **recovery commit** from whatever is on disk so nothing is ever lost. Translate directly: each agent sandbox is a registered workspace in Sharp's view; a crashed or pre-empted agent's half-finished tree is snapshotted into a recovery commit attached to its episode. Failure stops being lost work and becomes labeled data — which for Sharp's training/eval consumers is precisely the point.

### 4.6 Working-copy-as-commit: agents never have dirty state

`jj` snapshots the working copy into a real commit before every command; "uncommitted state" does not exist. In an agent harness this becomes **automatic checkpointing**: snapshot at every tool-step boundary and an episode's intermediate states are ordinary addressable commits — replay, bisect, or resume an agent run from any step. Sharp's episodes already record intermediate patches as payload (§5); promoting them to real commits in the object store unifies the two records and makes "rewind the agent three steps and try a different tool call" a checkout, not a reconstruction.

### 4.7 Anonymous branches: delete the naming ceremony

`jj` tracks anonymous heads in the view; a chain of commits needs no name to exist, and names (**bookmarks**) are optional human-facing labels. Agents inventing branch names (`feat/fix-login-attempt-7-final-v2`) is pure ceremony plus a collision and namespace-pollution surface. With 4.3, Sharp needs no branch names at all in the fan-out path: a head is identified by (change ID, episode), and bookmarks exist only where a human needs a handle during the transition.

### 4.8 A history algebra, not just raw SQL

Sharp's position is "SQL is our revset" (§2.5) — true but incomplete. The lesson of revsets is not the query _engine_, it is the **closed, composable vocabulary**: `conflicts()`, `divergent()`, `files(glob)`, `latest(n)`, `x::y`, set union/intersection/negation — small functions over the DAG that compose safely. Recursive-CTE SQL over a commit DAG is easy to get subtly wrong, and an agent composing it from a prompt will get it wrong at scale. Sharp should ship the revset primitives as named SQL functions and views — `sharp_ancestors(c)`, `sharp_dilemmas(repo)`, `sharp_siblings(change_id)`, `sharp_touches(glob)` — a stable query vocabulary that harness code and prompts can compose the way a `jj` user composes revsets.

### Adoption order

4.1 + 4.2 are one feature (the operation/view layer) and the highest-leverage structural change — they give fleet-safe concurrency and episode-scoped rollback at once. 4.3 + 4.7 are one schema change (change IDs, anonymous heads) that makes fan-out first-class. 4.4 is the deepest merge-engine investment and compounds with the projection machinery. 4.5/4.6 extend the client/harness boundary. 4.8 is cheap and immediately useful.

`jj` proved that a Git-compatible, conflict-as-data, rewrite-free VCS is not only possible but pleasant. Sharp's contribution is to ask what that same substrate has to become when the author and the conflict-resolver are both machines — and the answer is: semantic merge with a verification gate, structured dilemmas instead of deferred conflicts, and episodes as the record of why.
