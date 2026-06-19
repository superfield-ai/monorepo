# Storage Substrate: Postgres Is One Loosely-Coupled Implementation, Not the Architecture

Sharp stores all repository state in a single queryable storage substrate (whitepaper §2.3), realized on PostgreSQL in v1 ([`postgres-storage-plugin.md`](./postgres-storage-plugin.md)). That is a statement about
the **one implementation Sharp ships and optimizes**, not about the architecture being
welded to Postgres. The storage substrate sits behind a loosely-coupled module boundary;
Postgres is the single maintained implementation of that boundary. Other substrates — other
databases, flat files, even Git and Git metadata — are an _architecturally admissible,
deliberately unsupported_ extension direction. Sharp focuses on the Postgres module and
leaves the rest as room others can build into.

This document draws the one distinction that keeps "pluggable" from contradicting the
single-query-engine arguments the rest of the design rests on: **loose coupling is not
portability**, and the boundary has **two planes with very different substrate
requirements**.

"Repository state in a queryable database" is not unprecedented, and the neighbors are worth
naming: **Dolt** (a Git-for-data VCS built directly on a MySQL-compatible engine),
**TerminusDB** (git-like versioning over a datalog/graph store), **Irmin** (an OCaml git-like
distributed store), **Noms** (content-addressed and decentralized), and **Datomic**
(immutable facts with time-travel queries). They establish that putting a VCS behind a query engine
is sound. Sharp's difference is not _that_ it puts a VCS in a database but _what_ it puts
there — semantic representations and agent episodes as first-class rows, queried alongside
objects and refs — and its insistence that this is one fully-exploited implementation, not a
portability layer.

---

## 1. Loose coupling is not portability

`jj`'s backend abstraction is a _portability layer_: multiple backends are maintained and
expected to behave equivalently (local Git on disk in open source, a cloud backend at
Google). Portability layers levy a standing tax — every feature must be expressible on the
**intersection** of all backends, and the abstraction is a contract the project keeps.

Sharp takes the opposite posture, and on purpose. There is **one** maintained
implementation, and it exploits Postgres fully — recursive CTEs over the commit DAG, JOINs
across objects/refs/episodes/projections, transactional CAS, the revset vocabulary as SQL
functions (`jj-adoption.md` §8). None of that is held back to a lowest common denominator,
because there is no second backend to be common with.

What "loosely coupled" buys is therefore not feature parity across substrates. It is:

- **Hygiene** — the object/ref store is reached through a module boundary rather than
  Postgres calls smeared through the merge engine, the episode layer, and the projection
  machinery. The boundary is good engineering regardless of whether a second backend ever
  exists.
- **Optionality** — the boundary is clean enough that an outside party _could_ implement a
  different substrate, at their own cost and risk, without Sharp having anticipated their
  exact backend.

The boundary is a courtesy to potential extenders, **not a contract Sharp maintains.** Sharp
does not run a backend-conformance suite, does not promise behavioral equivalence, and will
not avoid a Postgres-specific capability to keep some hypothetical backend reachable. The
single-query-engine integration is the moat (`snapshots-vs-patches.md` §2.1); a portability
abstraction would forfeit exactly that integration to serve backends that do not exist.

---

## 2. The boundary has two planes

The reason "swap the substrate" is not a single yes/no is that Sharp's storage serves two
very different concerns, and only one of them is substrate-agnostic.

### 2.1 The object/ref plane — genuinely substrate-agnostic

Content-addressed objects (blobs, trees, commits) and refs (whitepaper §4) are a
key→bytes store plus a small mutable pointer namespace with compare-and-swap. This is the
plane `jj`'s `Backend` trait abstracts and the plane Git itself implements on a filesystem.
Nothing about it needs a relational engine:

- **Objects** are an immutable content-addressed map: `hash → bytes`. A KV store, a flat
  directory of hash-named files, an object store, or another database all serve it.
- **Refs** are a tiny mutable map `name → target` with CAS (the `sharp.refs` discriminated
  union, migration `0005`). Any store with an atomic compare-and-swap can hold it.

An alternative substrate that implements only this plane is entirely conceivable.

### 2.2 The retrieval plane — Postgres is a scale floor, not where the logic lives

The features that make Sharp _Sharp_ are not object storage; they are **selection at corpus
scale** over the provenance, DAG, and semantic tables:

- **Episodes as a corpus** (whitepaper §5) — "every failed sibling that touched symbol `X`",
  "the episode set to replay against a new model" — are indexed selections over millions of
  rows, not key lookups.
- **Continuous speculative-merge projections** (whitepaper §6.7) are stored as rows and
  selected by predicate (`… WHERE status = 'dilemma'`).
- **DAG walks and semantic lookups** — retrieving the operations, read/write sets,
  ancestors, and reference sets a given computation needs — are indexed queries (recursive
  CTEs over the commit DAG, JOINs across objects/refs/episodes).

What the store provides here is **efficient, indexed retrieval of the right subset** from a
large corpus, so the metadata spine is snapshot-addressed and co-located precisely so these
can JOIN against objects and refs (`snapshots-vs-patches.md` §2.1). That is the job a
relational engine is good at, and doing it by pulling whole tables into memory does not
scale. For this, Postgres is a **scale floor**: a substrate that cannot select subsets
efficiently does not make these features slower, it makes them impractical at corpus size.

What is _not_ on this list: the conflict-term algebra, the serializability check, the merge
tiers, the dilemma simplification. Those are computation, not queries — §2.3.

### 2.3 The algebra is Rust, above any substrate

The clever, differentiated logic does **not** live in SQL and does not need to. The `jj`
conflict-term simplification and cancellation (`jj-adoption.md` §4), the
conflict-serializability check (`semantic-patches.md` §3), the semantic merge tiers
(whitepaper §6), and dilemma resolution all run in **Rust client code**, over data the store
hands up. The store's contract is "give me these rows efficiently"; the algebra is applied
above it. (Retrieval-shaped vocabulary like revsets, `jj-adoption.md` §8, may be SQL
selection functions or Rust composition over retrieved sets — that is a §2.2 choice, not
algebra.)

This is deliberate, and it sharpens the loose-coupling thesis rather than weakening it:

- **The portable part is the valuable part.** The merge engine, conflict algebra, and
  serializability logic — the substance of Sharp — are substrate-independent Rust that sits
  above _any_ store able to feed it.
- **The substrate's job is narrow.** Store the object/ref plane (§2.1) and retrieve subsets
  of the provenance/DAG/semantic tables (§2.2). It does not host computation; SQL is storage
  and selection, not where the algebra hides.
- **So an alternative substrate forfeits less than it first appears.** It loses _scalable
  retrieval_ (§2.2), not the algebra — the Rust layer still runs, fed by whatever selection
  the substrate can offer, fast or slow. "Sharp on flat files" is a coherent object store
  whose algebra runs but whose corpus-scale queries are starved.

The single-query-engine integration (`snapshots-vs-patches.md` §2.1) remains the moat, but
the precise reason is now sharper: **one store can be selected across in one query** at
corpus scale — episodes JOINed to refs JOINed to projections — not that any computation lives
inside it.

---

## 3. Theoretical alternative substrates, and what each forfeits

Sketched only to mark the direction — none is on the roadmap.

- **Another relational database.** The closest fit: it can serve the object/ref plane and
  scalable retrieval both. The cost is re-deriving the Postgres-specific SQL (recursive CTEs,
  the selection functions) and re-tuning the projection and tree-materialization paths; the
  Rust algebra (§2.3) carries over untouched. Plausible; unrewarding without a concrete need,
  since indexed retrieval is exactly what Sharp tuned to Postgres.
- **Flat files / a KV store.** Serves the object/ref plane cleanly and is appealing for a
  zero-dependency local mode. The Rust algebra (§2.3) still runs; what it forfeits is
  scalable retrieval (§2.2) unless paired with a separate index — at which point the index
  _is_ the query substrate and the flat files are just the object store under it.
- **Git and Git metadata.** Object/ref storage is what Git's own model already is, and this
  is the substrate `jj` runs on by default. A Git-backed object/ref plane would make the
  interop boundary (whitepaper §7) nearly trivial in one direction, at the cost of scalable
  retrieval (§2.2) and of pushing Sharp's provenance into Git notes / side refs, where it is
  far weaker to select across than rows. This is also the natural seam at which a `jj-lib`-backed object/ref plane could
  slot in, if the adopt-vs-reimplement question (the borrow list in `jj-adoption.md`) ever
  resolved toward adoption — the storage boundary is where that decision would land.

In every case the pattern is the same: the object/ref plane ports, the Rust algebra (§2.3)
ports, and what does not come along for free is **scalable retrieval** (§2.2) — the reason
Postgres is the shipped substrate.

---

## 4. What Sharp commits to

- **One maintained substrate: Postgres**, serving both planes, fully exploited.
- **A loosely-coupled storage boundary** around the object/ref plane — for engineering
  hygiene and to leave an extension point open, not as a portability guarantee.
- **No backend-parity contract** — no conformance suite, no behavioral-equivalence promise,
  no self-imposed ceiling that keeps Sharp on the intersection of substrates.
- **Alternative substrates are an outside-the-roadmap direction** that others may pursue,
  with the explicit understanding that scalable retrieval (§2.2) is theirs to re-earn on a
  query engine, while the Rust algebra (§2.3) — the substance of Sharp — ports above any
  substrate for free.

This refines, and does not retract, the "Postgres-only by design" stance in
`snapshots-vs-patches.md` and `jj-adoption.md`: Sharp is Postgres-only in _what it ships and
optimizes_, and loosely coupled in _how it is structured_ — one first-class implementation
behind a clean boundary, rather than a portability abstraction over many.
