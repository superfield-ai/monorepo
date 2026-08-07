# Semantic Patches: The Formal Model of Independence

This is the formal-model document for Sharp's central claim: that the independence of two
changes is decidable — and a conflict nameable — when changes carry symbol-level access
sets instead of line positions. It defines the operation vocabulary and its **footprints**,
states independence as conflict-serializability, fixes the epistemic discipline (the
**tri-state certificate**) that keeps the model sound over an incomplete analyzer, and
commits to the experiment that would validate — or bound — the whole approach.

**Scope note: almost everything in this document is [design target].** Sharp v1 stores
snapshots, not operations ([`snapshots-vs-patches.md`](./snapshots-vs-patches.md)), and
implements none of the footprint machinery. What v1 actually ships at the merge surface:

- rename-aware Tier-1 merge for Rust — rust-analyzer's rename-location sets drive
  rename-vs-edit resolution, but propagation is text-level whole-word replacement, not
  span-aware rewriting (`semantic_merge.rs`, which says so in its own comments);
- tree-sitter AST whitespace-equivalence (`ast_equivalence.rs`) and the unified Tier-1
  driver with structured dilemmas — `MergeOutcome::{CleanOk, Dilemma, Unhandled}` and
  `DilemmaPayload` in `tier1.rs`;
- Tier-2 scoring of multiple merge candidates against other in-flight branches
  (`oracle.rs`);
- the compile-refusal gate: a merged candidate that fails `cargo check` is refused before
  storage (`SharpError::MergeRefused`, `semantic_merge.rs`).

Everything else here — stored operations, footprints, Bernstein checking, tri-state
certificates, resource declarations, the degradation ladder — is [design target] and
labeled as such. The v1 snapshot substrate is not a compromise this model corrects; it is the
correct v1 answer for the reasons `snapshots-vs-patches.md` records. This model is the
content of the open lower-right cell of the
[`comparison-merge-theories.md`](./comparison-merge-theories.md) §4.5 matrix (semantic
atom, first-class change), and it is designed to run first as an **overlay** — footprints
computed and recorded alongside snapshots, exercised advisorily — before any substrate
decision is revisited ("Validation: the base-rate experiment", adoption path).

---

## Operations and footprints

_Status: [design target]._

A change is a set of **operations** over the code graph, not hunks over text. The
vocabulary is small and language-defined:

- **Structural operations** — `rename(symbol, new_name)`, `change_signature(symbol, sig)`,
  `move(symbol, target_module)`, `add_definition(symbol)`, `remove_definition(symbol)`,
  `change_visibility(symbol, vis)`. These are exactly the refactors a language server
  already exposes (`textDocument/rename`, rust-analyzer's move assists), and each carries a
  language-computed set of affected sites.
- **Intra-symbol body edits** — a change confined to one definition's body, altering no
  signature or reference. It has no clean structural name; it is represented as a text/AST
  patch scoped to a single symbol, so even the unstructured case is bounded by the graph
  rather than floating over a file's line space.

The point of the vocabulary is not expressiveness — text is maximally expressive. It is
that each operation carries the one thing a line cannot: a **footprint**, the pair
`(R(T), W(T))` of read and write sets over the code graph.

The access-set universe is deliberately finer than "symbols." Its elements are **facets**:
`symbol × {name, signature, visibility, body}`, later extended with declared named
resources ("Resource-extended footprints"). Examples:

- `rename(foo, bar)` writes `foo.name` and every reference site of `foo`.
- `change_signature(f, sig)` writes `f.signature` and reads the types the new signature
  mentions.
- a body edit of `f` writes `f.body` and reads the `name` and `signature` facets of every
  item the new body references.

Faceting is what keeps honest read sets small: a caller depends on `f.signature`, not on
`f.body`, so an implementation-only change to `f` does not interfere with `f`'s callers.
Without the facet split, every caller–callee pair would conflict and the model would
serialize the world — the read-set-explosion risk this document returns to in its
validation section.

History under this model is a DAG of operations rather than of trees; a tree is
recoverable at any point by replay. Making the operation store the _canonical_ unit is a
substrate decision with a real bill — the metadata spine re-keys from snapshot hashes,
Git export becomes a projection that must re-earn byte-canonicality, and the vocabulary
plus footprint extraction is recurring per-language work
(`snapshots-vs-patches.md` §2). That bill is why v1 stays snapshot-based and why this
model is specified to run as an overlay first: nothing in the sections below requires the
substrate fork in order to be tested.

---

## Independence as conflict-serializability

_Status: [design target]; the formal core. Borrowed from database concurrency theory, not
invented._

Model each change as a transaction `T` with footprint `(R(T), W(T))`. Two changes `T₁`
and `T₂` are **independent** — they commute, producing the identical program in either
order — exactly when the Bernstein conditions hold:

```
W(T₁) ∩ W(T₂) = ∅      no write–write conflict
W(T₁) ∩ R(T₂) = ∅      no write–read  conflict
R(T₁) ∩ W(T₂) = ∅      no read–write  conflict
```

`R(T₁) ∩ R(T₂)` is unconstrained: shared reads do not conflict. When all three hold, the
merge is a no-decision — order does not matter and the operations compose with no human,
no heuristic, no guess. When any intersection is non-empty there is a genuine, _nameable_
conflict — "operation A writes `foo.signature`; operation B reads it" — surfaced as a
structured **dilemma** (v1's embryo of the shape is `DilemmaPayload` in `tier1.rs`), never
text markers, never a silent pick.

Three precisions bound this to what the mathematics actually supports:

1. **The theorem is conditional on footprint completeness.** Disjointness implies
   commutation only if `R` and `W` contain every access the change makes. The conditions
   themselves are trivial set algebra; the entire weight of the model rests on where
   footprints come from and when they may be trusted — the subject of the next two
   sections.

2. **It dissolves the manufactured class and names the genuine class; it does not shrink
   genuine disagreement.** Line-based merge errs in both directions: adjacent-but-
   independent edits collide (manufactured conflicts), and semantically interfering edits
   with zero textual overlap merge silently and fail to compile (missed conflicts) —
   whitepaper.md, "The root axiom". Serializability over footprints removes the
   manufactured class and converts the missed class into named intersections — where
   footprints see them. Genuinely dependent changes stay dependent: the
   rename-versus-signature-change pair that `snapshots-vs-patches.md` §4 concedes "does
   not commute" is simply `W(T₁) ∩ W(T₂) ≠ ∅`; the model _identifies_ it rather than
   guessing, and correct non-commutation is a feature. Three decades of structured-merge
   research (Mens's 2002 survey; the JDime and semistructured-merge measurements) caution
   that the manufactured fraction is meaningful but bounded and that many real conflicts
   are genuine disagreements no representation dissolves. How that split falls for
   concurrent agent-authored work is an empirical question this document commits to
   measuring, not a premise it assumes.

3. **The ceiling is reference/type-level, not behavioral.** A proven-independent pair
   composes deterministically (consistency) and — with the verification gate — compiles
   and resolves (reference/type correctness). Nothing in the model delivers behavioral
   correctness: two changes with disjoint footprints can jointly violate an invariant the
   type system never sees — an ordering assumption, a protocol state, a resource budget.
   Executed-in-CI behavioral assertions are the _complement_ of the independence
   certificate, not a redundancy it retires (whitepaper.md, "Boundaries").

Within those bounds, the consequences are what the other two documents build on. A line
carries no read or write set — it is an anonymous position in a file — which is why patch
theory could prove commutation only for line-graphs; over footprints, order-independence
of pairwise-independent sets returns as a conditional theorem at the semantic layer.
Concretely:

- a branch becomes a dependency-ordered _set_ of operations rather than a sequence, and
  landing becomes admission of a union — branch-semantics.md, "Branches as sets";
- the conflict relation over footprints, intersected with the **frontier** (the union of
  footprints of all in-flight branches), is what the landable prefix, fission, and
  dynamic-phase admission are computed from — branch-semantics.md, "The landable prefix
  and fission" and "Dynamic phases";
- queried continuously instead of once at land time, the same relation generalizes the
  merge queue — whitepaper.md, "What the protocol unlocks"; branch-semantics.md, "The
  generalized merge queue".

---

## Soundness and the tri-state certificate

_Status: [design target]._

Static analysis has blind spots: macro expansion, build-time codegen, reflection, dynamic
dispatch, conditional compilation, cross-language seams. Worse, analyzers do not reliably
flag their own blind spots — an _empty_ references answer is indistinguishable from an
_incomplete_ one. A model that read "the analyzer found no intersection" as "independent"
would be unsound in exactly the silent way line merges are.

The discipline: every independence claim is a **tri-state certificate** —
proven-independent / proven-conflicting / **unknown** — governed by two rules:

- **Safe-direction trust.** The analyzer is trusted only in the direction where its errors
  are harmless: found references create dependencies; absent references prove nothing. Any
  reported intersection suffices for proven-conflicting. Proven-independent is never
  concluded from an empty query answer.
- **Blind spots are unknown by construction.** A per-language taxonomy of known blind-spot
  categories is part of the model. A footprint entry that falls inside one — a symbol
  produced or consumed through a macro, a codegen boundary, an FFI seam — is forced to
  _unknown_ regardless of what the analyzer reports. Proven-independent therefore requires
  a positive completeness argument, and only one source can supply it: a captured
  structural operation whose effect set the language computed, over a region outside every
  blind-spot category ("Capture, not reconstruction").

For admission, unknown is treated as dependent: the pair is not certified to commute, so
it serializes through the ordinary gate rather than landing concurrently on the
certificate's authority. But unknown is _reported_ distinctly from proven-conflicting,
because the remedies differ. A proven conflict names the facets to negotiate; an unknown
names the coverage gap — which blind-spot category, which footprint entries — and can
often be discharged: declare the resource, re-express the edit as a captured operation, or
accept serialization. Collapsing the two states would either alarm on phantom conflicts or
tempt the system to clear what it cannot see.

The certificate's cost model is deliberately asymmetric. False dependencies — extra
dilemmas, lost concurrency — are the price the design pays on purpose; a false
independence — a genuine conflict cleared — is the failure treated as intolerable. Whether
the price is affordable is the read-set-explosion question, and it is measured, not
assumed ("Validation: the base-rate experiment").

---

## Capture, not reconstruction

_Status: [design target]; this is the "why now"._

For the model to run, footprints must be obtained. There are two ways, and they are not
equal.

**Reconstruction** — reducing `(old_tree, new_tree)` to operations after the fact — is
hard in two distinct ways. It is computationally hard: minimal tree edit distance with
moves is NP-hard in general, and rename/move detection is the same heuristic family as
Git's `-M`/`-C`, needed here as reliable rather than advisory. And it is under-determined,
which is worse: "rename `foo`→`bar` then edit the body" and "delete `foo`, add `bar` with
the new body" yield the same tree but different operations, different footprints, and
different merge behavior against a third branch. The machinery downstream — memoized
dilemma resolutions, self-cancelling projections
([`jj-adoption.md`](./jj-adoption.md) §4) — needs the derivation to be **canonical**: a
deterministic function from tree pairs to a unique operation sequence. That function is
unsolved in general and would be per-language.

**Capture** dissolves most of this, and it is the structural reason the model became
feasible now rather than in 2005: the author is an agent in a harness. A human destroys
the operation before the VCS sees it — the rename is in their head; the text is what
remains — which is why Darcs and Pijul reconstruct from line states, and why operation-
based merge (Lippe & van Oosterom, 1992) and refactoring-aware merge (Dig et al.,
_MolhadoRef_, 2007) had to coax operations out of humans through IDE instrumentation. An
agent's edit is already a tool call the harness brokers and records (episode capture —
whitepaper.md, "Episodes"). A footprint-aware `rename` call _is_ an operation with a
language-computed effect set at the moment of issue: captured, not reconstructed — no
detection heuristic, no canonicality problem for that operation. Sharp's claim over this
lineage is deliberately narrow: capture at the harness boundary, serializability
certification over captured footprints, and canonical-term determinism — not the
operation-based idea itself.

Two honesty requirements bound the claim:

- **Adoption is voluntary, not coerced.** Sharp does not impose an operation vocabulary.
  Nothing stops an agent writing free text, and a system that worked only under coercion
  would not be adopted: SemanticMerge shipped working language-aware merge around 2013 and
  stalled — working technology is not adoption. The bet — stated as a bet — is that
  footprint-aware tooling wins on its own merits: an operation with a proven footprint can
  be certified independent and land without waiting, so agents that use the tooling land
  faster. Because adoption is a harness integration rather than a per-developer habit
  change, the diffusion problem differs from SemanticMerge's — favorable, but unproven.
- **Body edits are the residue, and their footprints are weaker.** Free-form text inside
  one definition is still reconstruction, bounded to a symbol: `W` is the enclosing
  symbol's `body` facet by construction, but `R` is computed by resolving the new body's
  references — exactly where the analyzer's blind spots live. Body-edit footprints are
  therefore _unknown_-heavy in precisely the regions (macros, codegen, dynamic dispatch)
  the tri-state discipline exists for. The realistic model is hybrid: declared structural
  operations with exact footprints, plus symbol-scoped body edits whose footprints are
  sound in the found direction and honest about the rest.

What fraction of real change traffic is structural versus body-edit — and therefore how
much of the model runs at full capture strength — is empirical, and is folded into the
validation plan below.

---

## Resource-extended footprints

_Status: [design target]; a design direction, entirely unimplemented._

Symbol graphs are per-language, and the costliest conflicts in real systems live at seams
no language server owns: two changes that both alter a database schema, a wire format, a
config key, an endpoint contract, a build script. A footprint model that stopped at
symbols would certify independence precisely where independence is least assured.

The extension is cheap because the formal model never cared what the set elements were.
Extend the access-set universe with **declared named resources** — `writes: table users`,
`reads: config STRIPE_KEY`, `touches: endpoint /v1/charges` — namespaced identifiers
declared by the agent (or suggested by advisory tooling from migration files and config
diffs; the advisory layer suggests, never acts) at operation-issue time. The Bernstein
conditions apply unchanged over the extended universe: two changes that are
symbol-disjoint but both declare `writes: table users` are proven-conflicting, with the
conflict named at the seam where it lives.

Epistemic status, stated exactly: declarations can prove conflict; they can never prove
seam-independence. A declared intersection is a found access — the safe direction again —
so it yields a genuine, nameable dilemma. An absent declaration proves nothing: undeclared
resource access is a blind spot exactly as a macro is, so the resource component of a
certificate is at best _independent-as-declared_, never proven-independent. That residual
is one more reason the behavioral-CI complement (whitepaper.md, "Boundaries") is
permanent. The aim is recall on the costliest conflict class at declaration cost — not a
verified model of the world's resources.

---

## Oracle discipline

_Status: [design target] rules; v1 already runs the relationship in miniature._

The language server is the **oracle** in Sharp's trichotomy — kernel / oracle / advisory
layer, whitepaper.md, "The protocol" — and it is the designated complexity sink: complex,
external, allowed to be incomplete, wrapped by the kernel's tri-state discipline. Sharp
borrows a semantic engine per language instead of building one; it is a second client of
the IDE market's LSP investment (whitepaper.md, "Why now"). Complexity is thereby
relocated, not eliminated — placed where it is cheapest to maintain and safest to get
wrong. (Naming note: v1's `oracle.rs` uses "oracle" for the Tier-2 _oracle branches_
that merge candidates are scored against; the trichotomy's oracle is the language server.)

The v1 embryo: `semantic_merge.rs` consults rust-analyzer's rename-location index during
Tier-1 merge, treats its answers as advisory — an analyzer error falls through to textual
merge — and gates every result behind `cargo check`, refusing any merge whose output does
not compile (`SharpError::MergeRefused`). The trust asymmetry is already the right one:
the oracle's found locations improve the merge; its silence never clears anything the
compile gate would catch.

Rules for the full model [design target]:

- **The oracle is in the merge path — price it.** Merging stops being pure computation
  over stored objects: a live language server with a loaded workspace sits in the latency
  budget, with warm-up and flakiness. Captured operations move analysis to authoring time
  (the footprint is computed when the tool call is issued); projections amortize the rest
  by keeping a server warm per (feature, target) pair — whitepaper.md, "Boundaries".
- **Pin the oracle version in the merge record.** Oracle answers change across versions
  for identical source bytes: a merge that is CleanOk under rust-analyzer 2026.1 may be a
  Dilemma under 2026.2. Replayability therefore requires the merge record to carry
  (oracle identity, version); memoized artifacts — cached footprints, dilemma
  resolutions — are keyed by that pin; and a version bump has defined semantics,
  invalidate or migrate, never a silent re-key. Without this, "resolve once, apply
  everywhere" is sound within one toolchain version and silently wrong across one.
- **Degrade honestly, never silently — the degradation ladder.** Language support is a
  ladder, and every certificate records the rung that produced it:
  1. _Full LSP_ (references, rename, signature intelligence): structural capture and
     footprint computation at full strength.
  2. _Syntax only_ (a tree-sitter grammar, no resolution): symbol boundaries and
     AST-equivalence are available — v1's `ast_equivalence.rs` is this rung — but
     reference resolution is absent, so footprints are unknown-heavy.
  3. _No support_: text three-way with every footprint entry marked unknown. Under
     unknown-treated-as-dependent, such changes are never certified to commute; they
     serialize through the ordinary behavioral gate. The bottom rung is the classic
     CI-gated merge queue — Sharp's degenerate case (whitepaper.md, "Positioning") and
     its honest fallback, plus an explicit record of being it.
- **Per-language cost is recurring.** Each rung is earned per language: operation
  vocabulary, facet model, blind-spot taxonomy, extraction. This is a substantial,
  recurring investment, not a plugin. v1 scopes to Rust and TypeScript.

---

## Validation: the base-rate experiment

_Status: committed plan; not yet run._

The model has one known way to fail even if every component works: **read-set explosion**.
Honest R-sets may be large — a body edit reads the signature of everything it calls, and
popular facets (a core type, a widely-imported module) may appear in nearly every
footprint. If honest footprints make almost every concurrent pair Bernstein-dependent, the
frontier saturates, everything serializes, and Sharp degenerates into an expensive queue.
The tempting fix — trimming R-sets — is unsound: a trimmed read set clears merges the
model cannot see. The facet split exists to keep honest sets small; whether it suffices is
not decidable from the armchair.

So the load-bearing quantity is empirical: **the Bernstein-independence base rate of real
concurrent work**. The committed experiment:

1. Mine git history — this monorepo and public corpora — for temporally-overlapping merged
   PRs: pairs whose open intervals overlap and which both landed.
2. Compute retroactive footprints for each PR at facet granularity with today's analyzers,
   applying the tri-state discipline (blind-spot categories forced to unknown).
3. Measure: the fraction of overlapping pairs that are proven-independent; the unknown
   fraction; and, for the pairs that conflicted textually or broke after merging, whether
   footprints would have named the interference.

Reading the results honestly cuts both ways. Retroactive footprints are reconstruction —
the weak path by this document's own argument — so the measured proven-independent rate is
a _lower bound_ on what captured operations could certify, and unknown-heavy results
indict reconstruction before they indict the model. But if the manufactured-conflict class
turns out small — if most overlapping pairs that conflicted were genuine disagreements —
then the model's headroom over a line-based merge queue is bounded no matter how good
capture becomes, and the design must say so.

The experiment is also step one of a deliberately advisory-before-authoritative adoption
path: (1) run the history experiment; (2) ship footprint-overlap prediction as advisory PR
annotations and measure precision/recall against actual conflicts and post-merge breakage;
(3) only with that evidence let certificates gate admission; (4) only then derive plan
structure from them (branch-semantics.md, "The plan loop"). Each step is falsifiable and
useful alone; nothing downstream is entitled to trust the model has not earned upstream.

Two companion measurements from the same corpus carry over from the earlier draft of this
document, because the eventual substrate decision still depends on them: the
structural-versus-body-edit split of real change traffic (how much of the model runs at
full capture strength), and whether symbol-scoped diffs of body edits are deterministic
across nodes and across pinned analyzer versions (the canonicality the memoized machinery
needs). If capture coverage is low and body-edit diffs cannot be made canonical, the
snapshot substrate is not a waypoint but the destination — and this document is the record
of what was measured before deciding.
