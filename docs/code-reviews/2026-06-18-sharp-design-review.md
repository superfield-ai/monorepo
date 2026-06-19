# Design Review — Sharp: A Semantically-Aware, Agent-First VCS

**Reviewer framing.** Read as an external design/thesis-committee review by a CS faculty
member working at the intersection of programming languages, software engineering, and
database systems. The goal is not to bless the documents but to find what is wrong, what is
unsupported, and what is missing — and to be precise about which of the design's claims are
*theorems*, which are *engineering bets*, and which are *over-statements*. Strengths are
recorded so the criticism is calibrated, not so it is softened.

**Scope.** Reviews the design as expressed in `whitepaper.md` (esp. the new §1.1 root
axiom), `semantic-patches.md`, `branch-semantics.md`, `storage-substrate.md`,
`comparison-merge-theories.md`, `snapshots-vs-patches.md`, and `jj-adoption.md`, as of PR
#721.

**Overall assessment.** Strong systems vision, unusually self-critical engineering docs, and
one genuinely good formal lens (conflict-serializability over the symbol graph). But the
work is, in its current form, **under-situated and over-claimed**: it argues against VCS
*substrates* (git, jj, Pijul, Darcs, CRDTs) while ignoring the 30-year research literature
on *semantic/structured/operation-based software merging* — which is both its closest prior
art and the source of empirical results that temper its central thesis. Several headline
claims need to be narrowed to what is actually guaranteed. In committee terms: **promising,
revise-and-resubmit**, with the required revisions below.

---

## 1. What the design gets right

These are real contributions and should not be lost in the revisions.

1. **The conflict-serializability lens (`semantic-patches.md` §3) is the right formalism.**
   Casting "are these two changes independent?" as read/write-set disjointness over the
   symbol graph (the Bernstein conditions) is correct, clean, and connects merge to a
   mature theory (Bernstein, Hadzilacos & Goodman 1987; Weihl's commutativity-based
   concurrency control, 1988). It also correctly explains *why* a line substrate cannot
   reach this: a line carries no read/write set. This is the strongest single idea in the
   set of documents.

2. **Determinism, not convergence (`comparison-merge-theories.md`, `snapshots-vs-patches.md`
   §3).** The insistence that the conflict term be a canonical, observer-independent
   description of divergence — rather than a CRDT-style auto-converged value — is the
   correct safety property for source code and is argued well.

3. **Provenance as first-class data (whitepaper §5).** Treating agent episodes (prompts,
   traces, failed siblings, judge outcomes) as the primary metadata layer is a genuine
   systems contribution. The "replay against a new model as measured evaluation" idea has no
   VCS precedent and is well-motivated.

4. **Intellectual honesty.** `scale-limits.md`, the "test obligations not axioms" framing in
   `snapshots-vs-patches.md` §4, and the explicit *deferral* (not hand-wave) of the
   semantic-patch fork are exactly the posture a reviewer wants. The branch-as-poset
   well-definedness *proposition* (`branch-semantics.md` §1.1) is stated as something to be
   proved, not assumed.

5. **The agent-first reframing of jj is insightful.** Inverting jj's "divergence is an
   anomaly" into "divergence is the workload" (`jj-adoption.md` §3) is a sharp observation
   and is correctly identified as mostly a polarity flip rather than a new mechanism.

---

## 2. Required revision (major): engage the software-merge literature

This is the most serious scholarly gap. The documents position Sharp against *storage
substrates* and *merge algebras* but never against the field that has studied exactly
Sharp's core idea — merging at a semantic/syntactic-structural altitude — since the early
1990s. The omission has two costs: it overstates novelty, and it ignores empirical results
that directly bear on whether the central thesis holds.

The literature that must be cited and confronted:

- **Surveys.** Mens, *A State-of-the-Art Survey on Software Merging*, IEEE TSE 2002 — the
  canonical taxonomy (textual / syntactic / semantic / operation-based merge). Sharp's
  whole §1.1 argument is a position *within* this taxonomy, not outside it.
- **Operation-based merge.** Lippe & van Oosterom, *Operation-Based Merging*, 1992. This is
  **direct prior art** for `semantic-patches.md`'s "history as declared operations." The
  idea that recording edit *operations* (rather than diffing states) yields better merges is
  three decades old; Sharp's contribution is the agent-harness capture of those operations
  (§6), not the operation-based model itself. Say so.
- **Refactoring-aware merge.** Dig et al., *MolhadoRef* / refactoring-aware SCM (OOPSLA
  2007). This is *precisely* Sharp's "rename is a declared structural operation with a
  language-computed reference set." Sharp must explain what it adds over MolhadoRef.
- **Structured / semistructured merge and its empirical evaluation.** Apel et al.,
  *Structured Merge with Auto-Tuning* (JDime, ASE 2012); Cavalcanti, Borba & Accioly,
  *Evaluating and Improving Semistructured Merge* (OOPSLA 2017); the Spork structured-merge
  work for Java (2021). These matter most, because they **measured** what structure buys.
  The findings are a caution, not a tailwind: structured merge reduces conflicts
  *meaningfully but partially*, is *expensive* (JDime auto-tunes precisely because full
  structured merge is too slow, falling back to unstructured), and can *introduce* new false
  behaviors. The empirical conflict-mining studies (Borba's group; Ghiotto et al. on the
  nature of merge conflicts) find a large fraction of real conflicts are *genuine semantic
  disagreements* that no structural representation dissolves.
- **Commercial language-aware merge.** SemanticMerge / Plastic SCM `gmaster` (Códice
  Software, ~2013) shipped language-aware merge for C#/Java and is a *cautionary* adoption
  precedent — limited uptake despite working technology. A design betting the farm on
  semantic merge owes the reader an account of why it succeeds where SemanticMerge stalled.

**Why this is required, not cosmetic.** The §1.1 thesis — "a conflict is an artifact of a
representation too weak to decide independence" — reads, against this literature, as
*partly* true and *empirically bounded*. Structure dissolves the spurious class; it does not
dissolve genuine semantic disagreement, and the measured size of the spurious class is
finite. The current framing ("conflict is a representation artifact," full stop) is exactly
the over-claim the structured-merge community already disciplined itself out of. Revise §1.1
to: spurious conflicts are a representation artifact (dissolvable); genuine conflicts are
not, and the empirical split is an open quantity Sharp should measure on its own corpus.

---

## 3. Required revision (major): state the merge guarantee precisely — it is not behavioral

The documents slide between three different guarantees without distinguishing them:

1. **Consistency / well-definedness** — the merge result is deterministic and
   order-independent for disjoint access sets. *Proved* by §3 / `branch-semantics.md` §1.1.
2. **Reference/type-level correctness** — the merged program parses, resolves references,
   and passes the language's diagnostics. *Enforced* by the verification gate (whitepaper
   §6.2).
3. **Behavioral correctness** — the merged program does what was intended.

The design delivers (1) and (2). It does **not** deliver (3), and nothing in the access-set
model or the compile gate can. Two changes with disjoint symbol-level read/write sets
"commute" and compile, yet can jointly violate a behavioral invariant the type system does
not encode (a protocol/ordering/idempotency assumption, a global-state interaction). The
symbol graph captures *reference* dependencies, not *semantic invariants*; serializability
gives *consistency*, not *intended behavior*.

This is not a flaw to fix — it is a boundary to state. As written, the abstract's thesis
sentence and §1.1 invite the easy rebuttal "semantic merge still ships behavioral bugs."
Pre-empt it: make explicit that Sharp's automated ceiling is reference/type-level
correctness, that behavioral correctness remains the province of tests/review/the Tier-2
oracle, and that the §1.1 "missed conflict" example (return-type narrowing) is caught
*because it is a type-level dependency* — a behavioral-only dependency would not be. The
honest claim is strong enough; the inflated one is fragile.

---

## 4. Required revision (major): determinism of the canonical term under toolchain evolution

The entire memoize-and-propagate machinery (`jj-adoption.md` §4, adopted into the live
dilemma term) rests on one property: *every node computing the same merge derives the
byte-identical term.* `semantic-patches.md` §5 correctly identifies canonical semantic diff
as the load-bearing risk — but understates a second, temporal failure mode the documents
elsewhere already know about.

The canonical term is computed from the *semantic representation*, which is produced by
tree-sitter grammars and rust-analyzer / `ts.LanguageService`. `research.md` itself flags
that a grammar update changes the AST for identical source bytes. Therefore the "same merge"
computed at time T₁ and at T₂ under a different analyzer version can yield a *different*
canonical term — which silently breaks (a) memoized-resolution reuse and (b) the
self-cancellation of projections, both of which assume term identity is stable. This is a
soundness issue, not a performance one: a propagated resolution could attach to the wrong
divergence after a toolchain bump.

The design needs a *term-versioning* story: the canonical term must be defined relative to a
pinned analyzer/grammar version, memoized resolutions keyed by that version, and a defined
behavior on version change (invalidate vs. migrate). Until that exists, "resolve once, apply
everywhere" is unsound across the lifetime of a long-lived repository.

---

## 5. Required revision (major): throughput of continuous speculative merge at fleet scale

`whitepaper.md` §6.7 maintains a derived projection `refs/sharp-merged/<feature>--<target>`,
recomputed whenever either side advances. The design sells this as "no rebase ever," and as
a *correctness* story it is elegant. As a *systems* story it is unanalyzed and potentially
fatal:

- With F live features against T integration targets, the projection set is O(F·T), and the
  fan-out workload the design celebrates makes F large by construction.
- `scale-limits.md` already concedes that `recompute_projection` is **whole-tree** and that
  tree materialization is N+1 over `object::load` — ~20k point reads for a 10k-file repo, on
  *every* recompute. Each recompute also runs language-server analysis (Tier 1/2), the
  expensive step JDime's auto-tuning exists to avoid.
- Therefore every tip advance on a busy target can trigger O(F) whole-tree, language-server-
  bearing recomputes. This is plausibly the dominant cost of the entire system and could be
  super-linear in fleet size.

A continuous-projection design without an *incremental* recompute (diff-scoped re-analysis,
memoized subtrees, dirty-symbol tracking) and without a throughput model is not yet
demonstrated to be viable at the scale that motivates it. This needs a complexity analysis
and an incrementalization plan before the "no rebase" claim can be called a win rather than
a relocated cost.

---

## 6. Secondary concerns

**6.1 Two concurrency-control layers (`jj-adoption.md` §1).** Re-implementing jj's lock-free
operation/view DAG *on top of* Postgres MVCC risks two concurrency controls fighting:
Postgres aborts-on-conflict under serializable isolation, while the jj model promises
"record divergence, never abort." Delivering the jj semantics means doing application-level
CAS-with-merge and *not* leaning on Postgres isolation — at which point Postgres is a dumb
store for this path and the "never block, never retry" claim must be validated empirically,
not asserted. (Cross-reference the `storage-substrate.md` §2.3 position that the algebra is
Rust-side; that is consistent, but the *operation-commit* path still needs a concrete
non-aborting protocol.)

**6.2 Strategic coherence: byte-isomorphism vs. the semantic-patch end-state.** The
whitepaper sells byte-identical Git objects (§2.1, §4.0) as a load-bearing *adoption*
pillar. The strategic direction (`semantic-patches.md`) demotes export to "a projection that
must re-earn byte-canonicality." These can be reconciled, but the documents should say
plainly whether the end-state keeps byte-isomorphism as a property or as a boundary
courtesy — otherwise v1's central compatibility promise looks like something the architecture
intends to grow out of.

**6.3 "Agents are semantically native" is rhetorically overloaded (§1.1).** Agents emit
*text*; the semantic structure is re-derived by the same language servers regardless of
substrate, so the "lossy down-projection" is largely *recoverable* loss. The defensible
claim — which §1.1 partly makes but the abstract oversells — is about *where the comparison
is made* and the *re-derivation tax*, not about unrecoverable intent. De-hype to avoid an
easy rebuttal.

**6.4 Database-native VCS prior art is uncited.** "All state in one queryable store" has
direct ancestors the documents should situate against: **Dolt** (Git-for-data on a
MySQL-compatible engine), **TerminusDB** (git-like over a datalog/graph store), **Irmin**
(OCaml git-like distributed store), **Noms**, and **Datomic** (immutable, time-travel
queries). `storage-substrate.md` is otherwise the cleanest document in the set; it should
acknowledge these.

**6.5 Per-language sustainability.** v1 is TS+Rust only, and the entire semantic apparatus
(operation vocabulary, access-set extraction, canonical diff) is per-language. This is the
structured-merge literature's known Achilles heel (language-specificity), and cross-language
refactors are flagged as research in `research.md`. The roadmap should be explicit that
each new language is a substantial, recurring investment, not a plugin.

**6.6 Replay-as-evaluation reproducibility (whitepaper §5).** Replay is only as sound as the
captured input boundary. Model sampling nondeterminism, tool nondeterminism, and uncaptured
environment state bound how much "replay against a new model" is a controlled experiment vs.
an approximation. State the assumptions (temperature, seeds, environment capture) under
which replay is a valid A/B.

**6.7 Minor rigor — make "internally consistent" automatic (`branch-semantics.md` §1.1).**
The well-definedness proposition's hypothesis ("every non-commuting pair is ordered by ≺")
should be guaranteed by *defining* ≺ to include every access-set conflict with its authored
order, so that intra-branch consistency holds by construction and only *inter-branch* union
can produce the unordered-conflict (= dilemma) case. As written the hypothesis is left as a
property to be hoped for rather than enforced.

---

## 7. Questions for the authors

1. On a corpus of real agent merges, what fraction of conflicts are *spurious* (dissolved by
   moving line→symbol) versus *genuine*? The §1.1 thesis lives or dies on this number, and
   the structured-merge literature predicts it is bounded.
2. What is the measured cost of one whole-tree projection recompute at 10k and 100k files,
   and what is the projected aggregate at F=100 live features? (See §5.)
3. How is the canonical conflict term defined across analyzer/grammar versions, and what
   happens to memoized resolutions on a version bump? (See §4.)
4. What concrete protocol makes the operation-commit path non-aborting on Postgres without
   reintroducing the retry-loops the design criticizes? (See §6.1.)
5. What does Sharp add over operation-based merge (Lippe & van Oosterom) and refactoring-
   aware merge (Dig/MolhadoRef), specifically? (See §2.)

---

## 8. Verdict and prioritized revisions

**Verdict: promising, revise-and-resubmit.** The design is not unsound, but it is presented
as more settled and more novel than the evidence currently supports. None of the required
revisions is fatal; all are about *honesty of claims* and *missing analysis*, which is
fixable in the documents and the near-term roadmap.

Priority order:

1. **(§2) Situate against the software-merge literature** and narrow §1.1 from "conflicts are
   artifacts" to "spurious conflicts are artifacts; the genuine fraction is an open,
   measurable quantity." Cheapest fix, largest credibility gain.
2. **(§3) State the merge guarantee precisely** — reference/type-level, not behavioral.
3. **(§4) Define canonical-term determinism under toolchain versioning** — this is a latent
   soundness bug in the memoization story, not just a doc gap.
4. **(§5) Provide a throughput/complexity model and incrementalization plan** for continuous
   speculative merge.
5. **(§6.1) Specify the non-aborting operation-commit protocol** on Postgres.
6. **(§6.2–6.7) Smaller honesty/citation fixes** — strategic coherence on byte-isomorphism,
   de-hype the agent-native claim, cite database-native VCS prior art, state per-language
   cost, qualify replay reproducibility, and make the poset proposition's hypothesis
   structural.

Items 1, 2, 3, 6.2–6.7 are document changes deliverable now. Items 4 and 5 (and the
empirical answer to item 1) require measurement and belong in the implementation roadmap —
i.e., they are natural sources for the feature tickets to be opened after this PR merges.
