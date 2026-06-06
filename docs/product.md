# Nexum — Product Overview

Nexum is a document intelligence API. It ingests documents from any source — internal or external — parses them into addressable blocks, and builds a typed link graph across the corpus. Customers deploy agents on top of the API that read the graph and write living documents: handbooks, profiles, strategic plans, or any other synthesized artifact their workflow requires.

Nexum does not own the end-user experience. It owns the substrate: ingestion, graph, provenance, and synthesis primitives. What customers build on top is up to them.

---

## The Problem

Organizations accumulate knowledge across documents they never connect. A policy document contradicts a commitment made in a contract signed last year. A customer profile lives across three CRMs and a support inbox. A strategic forecast is undermined by a competitor announcement nobody linked to it. The connections exist — they just live in someone's head, or nowhere. When people leave, the knowledge goes with them.

Nexum makes those connections explicit, machine-readable, and continuously maintained.

---

## The Flat File Ceiling

Markdown files — and tools like Obsidian that layer wiki-like linking on top of them — are the current state of the art for personal knowledge management. For a single person working alone, they are nearly optimal: human-readable, version-controllable, portable, and cheap to reason over.

The scaling problems are obvious. Search degrades. Ownership fragments. Cross-document consistency breaks silently. Refactoring propagates manually or not at all.

The less obvious problem is forward-looking. Current LLMs consume linear text: a document is flattened into a token sequence, and the model reasons over that sequence. This is a first-generation constraint, not a permanent one. Future reasoning machines — whether trained differently or equipped with richer I/O — may operate natively on structured graphs: querying subgraphs, traversing edges, operating on block-level nodes rather than character streams. A knowledge base built as flat files is not ready for that interface.

A flat file is an acceptable *report format* — a serialization of knowledge for human reading. But reports do not have to be the storage model. The same report can be generated on demand by loading the relevant branches of a document tree stored as structured nodes with typed relationships. When the output format and the storage format are decoupled, the knowledge base can serve multiple consumers: a human reading a rendered document, a current LLM consuming a text serialization, and a future reasoning engine traversing the graph directly.

A common counter-argument points to the current generation of coding and knowledge-work agents — Claude Code, Cursor, Aider, and similar — which do most of their reading via `grep`, `find`, and `cat` over flat files in a CLI environment. The argument runs: agents already navigate flat files effectively, so flat files must be the right substrate. This conflates the substrate with the tooling. Those agents read files that way because their tool harness is a Unix shell. The harness was chosen for portability and developer ergonomics, not because line-oriented text grep is the optimal way to query a knowledge base. An agent equipped with a graph query tool — semantic search over blocks and edges, link traversal, provenance filters — does not need to reconstruct meaning from regex hits. The CLI pattern is an artifact of how today's tools are deployed, not evidence of how knowledge should be stored.

Nexum is built on this premise. The canonical representation is the graph; flat text is one rendering of it, and `grep`-over-files is one (limited) way to query it.

---

## Who It's For

Nexum is a platform API. Direct customers are teams building document-intelligence products or internal tools — not end users navigating a corpus manually.

Strong fits:
- **AI product teams** embedding document intelligence into their own applications, where answers must be grounded in source material with auditable citations
- **Enterprise automation teams** building agents that read across internal systems (contracts, comms, records) and produce synthesized outputs
- **Knowledge management platform builders** who need a reliable graph layer beneath their own UX

The underlying use cases span any knowledge-intensive domain: legal, finance, healthcare, operations, strategy. Nexum is not optimized for any single vertical.

---

## Initial Target Use Cases

Three use cases anchor the initial product — chosen because each has a clear graph structure, an existing pain point that flat files make worse, and a natural agent-consumption story.

### Software Documentation

A software project produces at least four distinct document types that must stay consistent with one another: product specification, implementation notes, issue tracker, and end-user support documentation. In practice they diverge constantly. A decision recorded in a product doc is not propagated to the implementation notes. A bug in the issue tracker is closed but the user-facing docs still describe the broken behavior. A support ticket reveals an undocumented edge case that nobody links to the spec.

Nexum makes the links between these document types explicit and machine-maintained. An agent can flag a contradiction between an open issue and the current spec, or identify support tickets that describe behavior not covered in end-user documentation. The graph is the connective tissue the project already needs but currently maintains by hand.

### Legal Case Files

A legal matter generates a large, interconnected document set: pleadings, exhibits, contracts, correspondence, deposition transcripts, court orders, and research memos. Relevant passages span dozens of documents. Contradictions between a deposition and a contract clause, or between two expert declarations, are exactly the kind of cross-document relationship that wins or loses a case — and exactly the kind that lawyers currently find by reading everything twice.

Nexum ingests the case corpus, resolves structural citations, and infers semantic and logical links across the full document set. Agents can synthesize profiles of key facts, flag contradictions between witness statements, and maintain running memos that update as new material is filed. Provenance is preserved throughout — every synthesized claim traces to the source block that supports it.

### Company Handbook

A handbook is a codification of how a company operates: policies, processes, decision rights, escalation paths, standards of conduct, and institutional knowledge that would otherwise live only in the heads of long-tenured employees. Done well, it is both a human reference and an agent-consumable procedure library.

The problem with existing handbooks is maintenance. They are written once, go stale, and contradict the actual policies documented in more recent Slack threads, board resolutions, or operational runbooks. Nexum treats the handbook as a living synthesized artifact: the handbook agent polls the internal corpus for new source material — decisions, postmortems, updated policies — and revises the affected handbook sections when contradictions appear. The handbook is always a synthesis of the current source record, not a snapshot from the last time someone updated a Google Doc.

Because every handbook block traces to source blocks, agents consuming the handbook for automated decision-making can verify provenance and flag when the underlying source has changed. The handbook is not just for humans reading a rendered page; it is a queryable knowledge base that agents can traverse.

---

## Principal Model

Nexum has one principal type: **entities**. Both human users and agents are entities. They share the same identity model, the same scope system, and the same access control checks. The only difference is how they authenticate and what scopes they are granted.

**Human principals** authenticate via session token (cookie or Bearer JWT). They are created through the registration flow and interact via the API or any application built on top of it.

**Agent principals** authenticate via API key (Bearer token). They are registered through the same entity creation endpoint as users, with `type: agent`. Their properties include a name, description, a list of granted scopes, and the corpus IDs they are permitted to read from and write to. There is no separate agent management API — agents are entities, created and managed with the same CRUD operations as any other principal.

Scopes are additive string grants stored on the entity. Example scopes: `corpus:read`, `corpus:write`, `blocks:synthesize`, `links:create`, `external:ingest`. A human administrator grants scopes to an agent at registration time; an agent cannot grant itself new scopes.

Agents interact with Nexum exclusively through the API. They do not have a UI. They poll for new material on a schedule; Nexum does not push events to agents.

---

## Privacy and Need-to-Know Access

Nexum enforces access control at every layer of the graph. Authorization is not only about which corpus a principal can enter — it is about which blocks within that corpus they can see, and whether they can infer the existence of blocks they cannot read.

**Corpus-level access** is the outer boundary. An entity (human or agent) must have `corpus:read` scope on a corpus to receive any block from it. Corpus access is granted explicitly by a human administrator; it is not inherited from organizational membership or role.

**Block-level access** is the inner boundary. Within an authorized corpus, individual blocks or block subtrees can carry additional access restrictions — classification levels, team tags, or explicit principal allowlists. An agent with `corpus:read` does not automatically see all blocks in that corpus; it sees the subset for which it is authorized. This is the need-to-know layer: an agent responsible for synthesizing customer profiles has no business reading internal compensation records, even if both live in the same corpus.

**Links inherit the most restrictive endpoint.** A link between block A and block B is not visible to a principal who cannot see both A and B. The graph does not leak the existence of a relationship through a visible endpoint. A principal traversing from a visible block will not receive edges that point to blocks outside their access boundary — those edges are silently absent from their traversal result.

**Synthesized blocks inherit source access levels.** When an agent synthesizes a block from sources of varying access levels, the synthesized block's access level is set to the most restrictive of its sources, unless the administrator explicitly overrides it. This prevents access escalation through synthesis: a summary of a restricted source block does not become a loophole for reading restricted content.

**The graph does not leak shape.** A principal cannot determine the size or structure of a corpus beyond what they are authorized to see. Block IDs, link counts, and traversal depth are all scoped to the principal's authorized view.

**Agent scopes are purposive, not permissive.** Scopes are granted for a stated purpose; an agent is not granted "read everything in this corpus" as a default. The principle is minimum necessary access: the Handbook Agent gets read access on the internal corpus and write access on the handbook corpus — nothing else. A narrowly scoped agent cannot be co-opted by a malicious prompt to exfiltrate data outside its purpose.

---

## Core API Capabilities

### 1. Document Ingestion

POST a document — PDF, DOCX, Markdown, or plain text — and Nexum parses it into addressable blocks (paragraphs, clauses, numbered lines), embeds each block, and indexes it for all three query modes. Returns block IDs immediately; embedding and linking complete asynchronously.

Supported formats:
- PDF — filings, reports, contracts, research papers
- DOCX — drafts, redlines, internal memos
- Markdown — agent output, structured notes
- Plain text — transcripts, logs, extracted CRM records

**External source ingestion.** Documents do not have to originate from within the organization. Any agent can ingest external material — news articles, regulatory notices, trade journal pieces, competitor announcements — via the same ingest endpoint. External documents carry source metadata: origin URL, publication date, source type, and a caller-assigned credibility weight. Blocks from external documents propagate that metadata into any links and synthesized blocks derived from them.

### 2. Document Versioning

Every document in Nexum is versioned. Submitting a new draft creates a new version while preserving the original. The full history is retained and queryable.

**Unchanged blocks are shared across versions.** If a paragraph doesn't change between v1 and v2, it is the same record — same ID, same graph connections. Links accumulated in v1 are automatically present in v2 wherever that block survived.

**Changed blocks carry lineage.** A modified paragraph records its predecessor. The full edit history of any block is traversable.

**Current version is always the default.** All queries operate on current versions unless a prior version is explicitly requested.

### 3. Three Layers of Links

All links are created by the system — no customer is expected to tag relationships manually. The three layers differ in how the link is detected, and carry different default confidence weights as a result.

**Structural links** — resolved automatically from citations in the text. A document that references another block by name, number, or explicit citation gets a navigable edge to the target block. High confidence; the source text is explicit. These are deterministic.

**Semantic links** — blocks covering similar territory are linked via embedding similarity. No explicit citation required. Confidence is proportional to embedding proximity; the score is queryable. These are probabilistic, not deterministic.

**AI-inferred links** — an LLM reads blocks in context and asserts typed relationships: *supports*, *contradicts*, *elaborates*, *overrides*, *is-exception-to*. These capture logical and argumentative structure beyond surface similarity. Confidence is assigned by the model and recorded on the link. AI-inferred links carry lower default confidence than structural links and should be filtered by confidence when precision is required.

All three link types are first-class graph participants. They are not equivalent — the system exposes their confidence scores and mechanism of origin so agents and consumers can reason about how much to weight any given edge.

### 4. Relationship Types

Links are typed and weighted:
- **Cites** — explicit reference in text
- **Contradicts** — logically incompatible claims
- **Elaborates** — expands on a point
- **Overrides** — a later provision supersedes an earlier one
- **Supports** — corroborating evidence or argument
- **Is-exception-to** — carve-outs and qualifications

Each link carries a `confidence` score (0–1) and a `mechanism` field (`structural`, `semantic`, `ai_inferred`). Query filters can restrict traversal by minimum confidence or mechanism type.

### 5. Query API

Two first-class retrieval modes plus their composition, all returning block IDs (or link IDs, for edge-targeted vector queries) with relevance scores and link context:

- **Vector search** (`mode: "vector"`) — natural language query against the embedding index. The `target` parameter selects the embedding space:
  - `target: "blocks"` (default) — cosine similarity over block embeddings; returns ranked blocks with connected neighbours.
  - `target: "edges"` — cosine similarity over edge embeddings; returns ranked typed links. Either a free-text `query` or a structured `(src_text, dst_text, rel_hint?)` triple may be supplied; the triple is embedded with the same template the linker uses at write time.
- **Graph traversal** (`mode: "graph"`) — walk the link graph from a seed block; configurable depth, link-type filters, and direction (forward / backward / both).
- **Hybrid** (`mode: "hybrid"`) — vector-ANN seed followed by one-hop graph expansion through the typed-link graph.

`semantic` is accepted as a backward-compat alias for `vector`. Results across all modes include provenance: who created each link, when, and with what confidence.

**Edge embeddings.** Both nodes (blocks) and edges (links) carry vector embeddings. A vector query with `target: "edges"` can therefore surface relevant *relationships*, not just relevant blocks. For example: a query for "obligations that override earlier commitments" can match `overrides` links whose embedded representation scores highly against that query, independent of whether the individual blocks rank well in isolation. This makes the graph traversable by meaning, not just by structure.

**Internal signals.** The tsvector index on block content and the edge-embedding column on links remain part of the storage layer. They are reachable through internal helpers and experiment harnesses but are not exposed as public Query API modes; the prior `fulltext` and `edge_semantic` mode names are no longer accepted.

### 6. Polling Cursor

Agents discover new ingest by polling `GET /blocks?corpus_id=X&since=<ISO_TIMESTAMP>`. The response returns all blocks created or updated after the cursor, along with their link state. Agents advance their cursor on each successful poll and repeat on their own schedule.

This is the primary mechanism for event-driven synthesis. Nexum does not push events to agents; agents pull.

### 7. Synthesis API

Write synthesized blocks back into the graph. A synthesized block is a first-class graph participant — linkable, versioned, and traceable to the source blocks that produced it.

The API accepts:
- The synthesized block content
- The entity ID of the agent that produced it (must match the authenticated principal)
- A list of source block IDs the synthesis drew from
- An optional confidence score

Nexum automatically creates `sourced-from` links between the synthesized block and its sources. If a source block is later corrected or retracted, the derived synthesized blocks are marked stale and returned with a `stale: true` flag on subsequent reads — agents discover staleness on their next poll cycle.

### 8. Synthesis Quorum

High-impact or mission-critical synthesized blocks can require multi-agent consensus before being published to the graph. The pattern draws from aerospace voting systems: no single agent's output is trusted unilaterally; the block is only committed once a quorum of independent agents has affirmed it.

**How it works.** Each quorum task is framed as a yes/no question — a prompt that can only resolve to "yes" (affirm) or "no" (reject). The proposer submits a candidate block along with a quorum configuration specifying the eligible voters (by entity ID), the required threshold (e.g., 3-of-5), and the yes/no question to put to each. The block exists in a `pending` state — readable by quorum participants but not traversable in normal queries. Each voting agent independently reads the source blocks and the candidate block, evaluates the yes/no question, and submits its vote. When the threshold of "yes" votes is reached, Nexum promotes the block to `published` status. If the threshold cannot be reached (too many "no" votes or dissents), the block remains pending; the customer's workflow determines next steps.

The yes/no constraint is the key discipline. A question like "Does this block accurately represent the obligations stated in the source clauses?" is resolvable. A question like "Is this the best possible synthesis?" is not. Quorum prompts must be written for binary resolution, not comparative judgment.

**Quorum does not require large models.** Classification and yes/no evaluation are tasks well-suited to smaller, faster models. A quorum panel of five lightweight models voting on a binary prompt is cheaper and faster than a single frontier model producing unchecked synthesis — and provides a stronger reliability signal for the use cases where quorum is warranted.

**What this provides.** A published block in a quorum corpus carries a record of every agent that voted, how they voted, and the question that was posed. Any consumer can verify that N independent agents affirmed the claim against the same source material. Provenance includes not just who synthesized, but who vouched for it and on what question.

**The source of useful disagreement.** The yes/no question is shared across all panel members; prompt variation is not a diversity axis. Useful disagreement — a "no" vote that prevents a false claim from publishing — comes from two controlled sources:

- **Different inference engines.** Panel members run different models, model versions, or providers on the same question. Disagreement surfaces engine-level divergence.
- **Non-deterministic graph traversal.** Panel members walk the source graph differently — different seed blocks, different walk orders, different evidence sampling. Disagreement surfaces sensitivity to which evidence was included.

**Scope.** `blocks:quorum_sign` is a distinct scope. An agent cannot participate in quorum voting unless explicitly granted this scope on the target corpus. The quorum configuration — eligible voters, threshold, and whether human principals can vote — is set when the corpus is created.

### 9. Provenance on Every Block and Link

Every block and link carries full provenance: origin type (`source` / `synthesized` / `external`), creator (parser, embedding model, AI agent, human, caller-specified agent ID), timestamp, confidence, and — for external blocks — source metadata. Provenance is queryable and filterable.

---

## Key Properties

**Block-level precision.** Links resolve to specific paragraphs and lines, not documents. Queries return the exact block, not the document it came from.

**Graph-native embeddings.** Nodes and edges both carry vector embeddings. Semantic search operates over the full graph — surfacing relevant relationships, not just relevant documents. A future reasoning engine with native graph I/O can query the same substrate directly.

**Non-destructive.** Source documents are never modified. The graph is maintained separately and layered over the originals.

**Versioned and auditable.** Full version history on every document. Unchanged blocks share identity and graph connections across versions. Modified blocks carry lineage back to their predecessors.

**Incrementally updatable.** Ingest a new document or a new version and only the affected blocks and links are recomputed.

**External-source aware.** External documents are first-class ingest targets. Credibility weights and source metadata propagate through the graph so agents can reason about the reliability of synthesized claims.

**Quorum-gated publishing.** High-stakes synthesized blocks can require multi-agent consensus before entering the traversable graph. Published blocks in a quorum corpus carry cryptographic attestations from every signing agent — a verifiable record that independent agents reached the same conclusion from the same source material.

---

## Synthesis Agents — Reference Patterns

The following patterns are reference agent definitions — documented templates showing how to register an agent entity, configure its scopes, and implement its polling loop. They are not built-in features. Customers register these agents in their own Nexum deployment, configure them with the appropriate corpus access, and run the poll loop wherever they run their other services.

Each agent is an entity in the system: registered via `POST /entities` with `type: agent`, granted scopes by a human administrator, and authenticated on every API call with its API key.

### Handbook Agent

**Registration:** `type: agent`, scopes: `corpus:read` (internal corpus), `corpus:write` (handbook corpus), `blocks:synthesize`, `links:create`.

**Poll loop:** On each cycle, calls `GET /blocks?corpus_id=<internal>&since=<cursor>` to find new source material — decision logs, incident reports, postmortems, leadership communications. For each new block, queries the graph for related handbook entries via semantic search and graph traversal. If a new block contradicts an existing handbook entry (a `contradicts` link appears), the agent synthesizes a revised entry and writes it back via the synthesis API. The prior entry becomes its predecessor; nothing is deleted. Advances the cursor on success.

The approval step — who reviews the draft, in what tool, on what schedule — is built by the customer. The agent writes a draft synthesized block with a `pending_review: true` flag in its properties; the customer's application reads that flag and routes it to the appropriate reviewer.

### Customer Profile Agent

**Registration:** `type: agent`, scopes: `corpus:read` (all source corpora), `corpus:write` (profiles corpus), `blocks:synthesize`, `links:create`.

**Poll loop:** On each cycle, polls for new blocks across all source corpora — contracts, support tickets, CRM exports, call transcripts. Groups new blocks by customer entity. For each customer with new activity, re-synthesizes the affected sections of their profile and writes updated blocks. Creates `sourced-from` links to every source block used.

When a contract block and a support-ticket block carry incompatible claims, the existing `contradicts` link in the graph surfaces automatically in the next synthesis pass. The profile agent includes the conflict in its output with both sides of the contradiction visible; resolution is the customer's workflow.

### Strategic Planning Agent

**Registration:** `type: agent`, scopes: `corpus:read` (internal + external corpora), `external:ingest`, `corpus:write` (strategy corpus), `blocks:synthesize`, `links:create`.

**Poll loop:** Two input streams. Internal: polls for new blocks from financial projections, OKRs, board decks, roadmaps. External: fetches configured sources (trade press, competitor sites, regulatory feeds), ingests new documents via `POST /ingest` with `origin: external` and source metadata, then polls for the resulting blocks. Synthesizes structured strategy documents — competitive maps, risk registers, scenario plans — and writes them back. Each synthesized claim links to its source blocks; external blocks propagate their source metadata into those links.

This pattern illustrates the general external-source capability. Any agent with `external:ingest` scope can bring outside material into the graph. The strategic planning agent is one application; the same mechanism works for any workflow that needs to reason across internal and external material.

### Credibility Agent (Reference Template)

**Registration:** `type: agent`, scopes: `corpus:read` (external corpus), `blocks:synthesize`.

**Purpose:** Evaluates external source blocks and writes credibility assessments back as synthesized metadata blocks. Other agents query these assessments when reasoning about external material.

**Poll loop:** On each cycle, polls for new `origin: external` blocks. For each new block, evaluates the source against configurable criteria — publication history, domain reputation, cross-referenceability with other sources in the corpus, freshness. Writes a synthesized credibility block linked to the source block with a numeric score and a short rationale. Agents that synthesize from external material query for the linked credibility block before including the source in their output.

The credibility evaluation logic is entirely within the agent — Nexum has no built-in taxonomy. Different deployments implement different credibility models appropriate to their domain. Nexum ships this template as a starting point; the evaluation prompt and scoring rubric are customer-defined.

### Quorum Agent Panel (Reference Template)

**Registration:** Multiple agents, each `type: agent`, scopes: `corpus:read` (source corpus), `blocks:quorum_sign` (quorum corpus). No single agent has `corpus:write` on the quorum corpus directly — publishing is gated by the quorum mechanism.

**Purpose:** Ensures that high-stakes synthesized intelligence — risk assessments, legal findings, mission-critical operational decisions — is attested to by multiple independent reasoners before entering the traversable graph. Modeled on aerospace voting systems (where flight-critical computations are run on separate hardware and cross-checked) and blockchain multi-signature schemes (where funds cannot move without N-of-M keyholders signing).

**Pattern:** One agent (the *proposer*) synthesizes a candidate block from the source corpus and submits it with `status: pending_quorum` and a quorum configuration listing the eligible signing agents and the required threshold. The proposer then polls until the block is promoted or rejected. Each signing agent runs independently: it reads the same source block IDs, runs its own synthesis, and compares its output hash to the pending block's hash. If they match, it submits its signature via `POST /blocks/<id>/sign`. If they diverge, it submits a dissent with its alternative content; the conflict is recorded and the proposer is notified.

The agents in a quorum panel should be meaningfully independent, but the independence must come from controlled axes — different inference engines (different models, versions, or providers) or non-deterministic graph traversal (different walk orders, seed blocks, or evidence sampling). The task prompt itself is written deterministically and is shared across the panel; varying the prompt across members produces noise without diagnostic meaning. A panel of identical agents running the same prompt on the same engine with the same traversal provides redundancy against failure, not independence against error.

**What customers configure:** Which corpora require quorum, the eligible agent panel, the signing threshold, whether human principals can sign (and count toward the threshold), and the conflict-resolution workflow when agents dissent.

---

## Synthesized vs. Source Blocks

Source blocks originate from documents the customer ingested — filings, contracts, transcripts, reports. They are the record of what was written or said.

Synthesized blocks are agent outputs. They are claims with provenance, not ground truth. A synthesized block's reliability is a function of its sources: how many support it, whether any contradict it, and the credibility weights of the external documents in its lineage.

Every block carries an `origin` field: `source`, `synthesized`, or `external`. Synthesized blocks carry the ID of the agent that produced them. External blocks carry source metadata. The graph does not treat synthesized blocks as less traversable — they are fully linkable — but their epistemic status is always visible in the API response.

---

## Challenges

### Unsupervised Synthesis and Background Grooming

Nexum is an intelligence platform, not a search index. The difference is unsupervised synthesis: the system continues to improve its knowledge graph autonomously, between ingest events, without a human triggering each reasoning step. A product that only synthesizes when explicitly asked is a marginally better RAG pipeline. Continuous background grooming is what makes the graph increasingly useful over time — surfacing contradictions, retiring stale claims, connecting newly-ingested material to existing knowledge, and improving the quality of the synthesized layer.

The engineering challenge is doing this without the graph degenerating. Done naively, background agents synthesize from prior synthesized output, drift away from source, and a quorum of similar agents will happily ratify the drift. This is the failure mode the ML literature calls *model collapse*: each generation loses fidelity to the original signal.

Grooming that converges toward a global maximum — rather than degenerating into churn — requires three things: anchoring, adversarial review, and a measurable fitness function. Without all three, background activity is wasted compute at best and corpus pollution at worst.

**Fitness functions.** Improvement must be measurable per cycle. Candidates that fall out of the existing graph model:
- **Source coverage** — fraction of source blocks reachable from a synthesized block via `sourced-from`
- **Contradiction debt** — count of unresolved `contradicts` edges
- **Redundancy** — synthesized blocks whose embeddings cluster tightly while sourcing different blocks
- **Predictive accuracy** — when new source material arrives, how well did existing syntheses predict or accommodate it
- **Human signal** — citations, reads, edits, dwell time on synthesized blocks, emitted by the customer's application and stored as block metadata

If none of these metrics move during a grooming cycle, the cycle was wasted. The default action is no-op.

**Mechanisms that push toward a global maximum:**

- **Re-grounding pass.** Agents periodically re-synthesize claims by re-reading the *source* blocks, not the prior synthesized block. This breaks the synthesis-of-synthesis chain that causes collapse.
- **Adversarial pairing.** Every writer agent is paired with a critic agent that has `corpus:read` only. The critic finds unsupported claims, stale reasoning, missing sources, and broken `sourced-from` links — and writes `contradicts` or `unsupported` edges against the writer's output. The writer cannot dismiss the critic; it can only respond by re-grounding.
- **Tournament replacement.** A new synthesized block does not auto-replace its predecessor. It enters as a sibling draft. Promotion requires beating the incumbent on the configured fitness function — by quorum vote, predictive score, or source coverage. Prevents churn without improvement.
- **Diversity in the quorum panel.** The quorum mechanism becomes a grooming mechanism only if panel agents are meaningfully different along controlled axes — different inference engines, or non-deterministic graph traversal. Prompt variation is not a valid diversity axis; the task definition is shared and deterministic. Identical agents on identical engines with identical traversal converge on identical errors.
- **Confidence decay.** Synthesized blocks lose confidence over time unless re-validated against source. Forces periodic re-touching, but the only way to restore confidence is re-grounding, not re-wording.
- **Bounded synthesis budget.** Cap the total synthesized volume per source block. Prevents accumulation of paraphrases. New syntheses must displace old ones.
- **Random source-block audits.** A grooming agent picks source blocks at random and asks: do all synthesized blocks sourced from this still hold? Cheap probabilistic garbage collection.

**Tensions.** Adversarial agents and quorum agents pull opposite ways — one rewards disagreement, the other agreement. They serve different stages: critics for draft refinement, quorum for publication. Conflating them produces deadlock or false consensus. And no procedure guarantees a global maximum on a graph this complex; the best available defenses are panel diversity (different agent panels run independent syntheses; the best wins on fitness) and external validation (newly-ingested source material arbitrates between competing syntheses retroactively).

A Grooming Agent reference template is a natural addition to the agent patterns above: runs on a schedule, computes the configured fitness metrics on a target corpus, identifies the highest-deficit area (most contradictions, lowest coverage, highest decay), and runs a targeted re-synthesis with adversarial pairing and tournament promotion. Each cycle emits a grooming report block — itself a graph participant, auditable and queryable.

### Human-in-the-Loop Recalibration

Fully automated grooming has a ceiling. Some claims sit at uncertainty levels the system cannot resolve from source alone — contested interpretations, ambiguous policies, judgment calls that require domain expertise. Periodically, the system needs ground truth that only a human expert can supply. The cost of getting that ground truth is what determines whether it happens.

The pattern is a **sampling audit, not a review queue**. A review queue assumes the human will read every draft; that fails the moment the corpus is non-trivial. A sampling audit assumes the human will answer a small number of strategically chosen questions, and that those answers — combined with the graph's existing structure — are enough to recalibrate the rest.

**Question selection is Bayesian.** A human-in-the-loop agent maintains a posterior over which claims in the corpus are correct, contested, or stale. On each interaction, it picks the question whose answer would most reduce the expected uncertainty across the graph: high prior uncertainty, high downstream impact (many synthesized blocks depend on it), and a clear yes/no formulation. Asking a human to confirm a claim that is already 99% certain wastes their attention; asking about a claim that affects nothing is equally wasteful. The selection function maximizes expected information gain per question.

**Interface is designed for ambient attention.** Questions arrive on the user's phone as a short batch — five to ten yes/no items, swipe-to-answer. No reading the source material in-app. No essay-writing. If the question can't be answered confidently in seconds, it's the wrong question and the agent should have framed it more sharply or surfaced the uncertainty for a different mechanism.

**Answers are first-class graph blocks.** Each human response is a synthesized block of `origin: human_signal`, linked to the claim it answered, with provenance: which human, when, and the question text as it was posed. Confidence scores on linked synthesized blocks update accordingly. A *yes* from a credentialed expert raises confidence; a *no* triggers re-grounding or marks the claim contested.

**Sampling, not coverage.** The system does not aim to have every claim audited. It aims to have *enough* claims audited that the inferred quality of unaudited claims can be estimated statistically — like a financial auditor sampling 5% of transactions to bound the error rate of the other 95%. The grooming agent uses audit results to recalibrate its own fitness functions: if humans systematically reject the system's high-confidence claims in some subdomain, confidence scores in that subdomain are deflated globally.

**Tensions.** Question fatigue is real — bad questions burn the human's willingness to answer good ones. The Bayesian selector itself depends on uncertainty estimates that may be miscalibrated, in which case the system asks the wrong questions confidently. And humans answer easy questions and skip hard ones, biasing the sample toward the system's existing comfort zone; the selector must weight by skip rate and occasionally surface hard questions even when expected information gain is lower, to detect blind spots.

This mechanism complements rather than replaces the automated grooming loop: the automated loop handles the bulk of low-stakes consolidation; the human-in-the-loop loop handles the small number of high-leverage uncertainties where a human's seconds-of-attention beat hours of agent reasoning.

### Document Parsing Fidelity

Every capability in Nexum depends on the quality of the initial parse. A block that misrepresents its source — because a table was flattened into garbage, because an OCR'd scan introduced phantom words, because a multi-column PDF was read in the wrong order — will generate false links, corrupt syntheses, and propagate error through the graph. Bad parsing is silent: the system has no way to know a block is wrong unless its content is compared against the original document by a human.

Real documents are adversarial inputs. The formats Nexum must handle include:

- **PDFs with complex layout**: multi-column text, footnotes, sidebars, watermarks, page headers that repeat across blocks.
- **Scanned documents**: OCR output with recognition errors, degraded character quality, mixed handwriting and print.
- **Redacted documents**: blacked-out passages that must be preserved as explicitly-redacted blocks, not silently dropped.
- **Legal instruments with cross-references**: section numbering that changes between versions, defined terms that span dozens of pages.
- **Exhibits and attachments**: embedded images, spreadsheets, or secondary PDFs that need to be extracted and ingested as linked sub-documents.

The parsing layer is not a solved problem and should not be treated as one. The strategy:

- **Use best-in-class third-party parsers** for the common cases (PDF, DOCX). Do not build a general parser. Evaluate regularly and switch when better options emerge.
- **Block-level confidence scores on ingested blocks** — the parser emits a parse confidence alongside each block. Low-confidence blocks are flagged for human review before links are inferred from them.
- **Source preservation** — the original document is always retained. Any block can be compared to its source passage. When a parse error is discovered and corrected, the block is re-versioned and downstream links and syntheses are marked stale.
- **Parsing as a first-class failure mode** — the system surfaces parse-quality issues to administrators as a distinct signal, not mixed in with synthesis or link-quality metrics.

The practical consequence: Nexum's intelligence is only as good as the text it starts from. Customers who ingest low-quality scans or poorly-structured PDFs will see degraded graph quality regardless of how well the rest of the system works. This should be communicated directly rather than abstracted away.

---

## Open Product Questions

Resolved decisions are struck through. Remaining questions affect API design or roadmap sequencing.

~~**Vertical focus vs. platform positioning.**~~ Resolved: Nexum is a vertically agnostic platform API. Legal, finance, healthcare, and operations are all valid deployment targets. No single vertical is prioritized in the core product.

~~**Who owns the handbook agent's approval workflow?**~~ Resolved: the customer. Nexum surfaces contradictions and synthesized revisions via the API; the approval UX is built by the customer in whatever tool they use.

~~**Agent conflict resolution policy.**~~ Resolved: Nexum surfaces `contradicts` links and marks stale synthesized blocks; policy is implemented by the customer on top of the API.

~~**Corpus permissions model.**~~ Resolved: agents are entities with explicit scope grants on registered corpora. Nexum enforces scope at the API boundary; customers control which scopes each agent receives.

~~**Synthesis trigger model.**~~ Resolved: agents poll via the `since` cursor endpoint on their own schedule. Nexum does not push events. Polling is the canonical trigger mechanism.

~~**External source credibility model.**~~ Resolved: Nexum ships a Credibility Agent reference template. Evaluation logic, scoring rubric, and taxonomy are customer-defined within the agent. No built-in taxonomy.

All major product design questions are currently resolved. Open questions will be added here as new decisions arise.
