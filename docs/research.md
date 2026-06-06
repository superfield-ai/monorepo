# Nexum — Research Plan

## Mission

Build a typed-link retrieval substrate over a Postgres-native block graph that gives heterogeneous document corpora — legal, medical, research, enterprise — auditable answers, real-time ingest, and a domain-tunable training signal, with an optional frozen-snapshot deployment path for latency-sensitive or air-gapped use.

---

## Core Thesis

> Nexum is a typed-link retrieval substrate over a Postgres-native block graph, with three differentiating properties:
> 1. **Block-level provenance** — every generated answer traces back to the specific blocks that produced it, in a way dense transformer weights structurally cannot.
> 2. **Real-time ingest with version-atomic visibility** — new content is queryable end-to-end within a bounded window, with consistent snapshots across version cuts.
> 3. **Typed link structure as contrastive training signal** — `cites / contradicts / supports / elaborates / is-exception-to` edges are a curriculum substrate for domain fine-tunes that flat corpora cannot produce.
>
> The same store optionally feeds a frozen-snapshot deployment path (distilled student → GGUF/Safetensors) for latency-sensitive or air-gapped environments where graph-resident retrieval is unacceptable.

This thesis is novel where it matters, falsifiable, and tied to design-partner-visible artifacts. Earlier framings — "graph replaces ONNX/GGUF weight files," "live inference substrate," "isomorphism between training and serving" — overpromised. They are dropped. What survives below is the engineering program that the original framing was concealing.

The research plan below tests this thesis systematically. See `docs/research-plan-review-2026-04-27.md` for the review that drove this reframe and `docs/research/cut.md` (forthcoming) for the audit trail of demoted/cut hypotheses.

---

## Research Areas

### Area 1 — Storage Architecture Fitness

**Question:** For a given institution (legal firm, hospital, research lab, enterprise), what storage configuration minimizes total cost of ownership across ingestion throughput, query latency, storage footprint, and update fidelity?

**Sub-questions:**
- How does corpus heterogeneity (mixed document types, languages, schemas) affect the fitness of pure-relational vs. pure-graph vs. hybrid storage?
- At what corpus scale does PostgreSQL's recursive CTE traversal become the binding constraint, and what is the crossover point to a dedicated graph DB (Kuzu, Neptune, TigerGraph)?
- Is pgvector HNSW still optimal for ANN search at 100M+ blocks, or does a dedicated vector store (Qdrant, Weaviate, Milvus) pay off?
- How much does schema rigidity vs. JSONB flexibility matter across domains?

**Hypotheses to test:**
- **H1.1 [KEEP]:** PostgreSQL with pgvector is sufficient for corpora below 20M blocks with mixed document types, with no measurable query quality degradation vs. a specialized graph DB.
- **H1.2 [TIGHTEN]:** Heterogeneous corpora (PDFs + structured tables + code) degrade embedding quality more than they degrade structural link quality — graph traversal outperforms semantic search in cross-type queries. *Tighten:* define "cross-type query" with a concrete eval set; specify "degrades embedding quality" quantitatively (recall@k delta, not adjective).
- **H1.3 [DEMOTE → measurement]:** For a single-institution deployment, embedding storage dominates total DB size (> 70%) at 1536 dimensions. *This is arithmetic.* Compute once, document in a sizing memo, and use it to motivate quantization work — do not run as an experiment.

**Experiments:**
- Synthetic benchmark: build corpora at 1M / 5M / 20M / 100M blocks across 3 domain mixes (legal, medical, mixed). Measure query latency P50/P99 for all three query modes at each scale.
- Schema comparison: deploy same corpus into PostgreSQL, Kuzu, and Neo4j. Compare traversal time for 2-hop, 4-hop, 6-hop queries on the same link graph.
- Embedding dimension ablation: test 512 / 768 / 1024 / 1536 dimensions. Measure recall@10 on domain-specific test sets to find the minimum useful dimensionality per domain.

---

### Area 2 — Graph as Training Curriculum

**Question:** Can the typed link graph in Nexum serve directly as a training curriculum for a language model, and if so, what curriculum construction strategies produce the best downstream performance?

**Sub-questions:**
- Does link type (cites / contradicts / elaborates / supports / is-exception-to) encode enough signal to generate useful contrastive training pairs?
- Can a walk policy over the block graph produce training sequences that outperform random sampling of the same corpus?
- Does block-level dedup (shared UUIDs across document versions) naturally produce curriculum diversity, or does it create repetition artifacts?
- What is the minimum graph density (links per block) before curriculum-derived training improves over a flat corpus baseline?

**Hypotheses to test:**
- **H2.1 [KEEP — most novel hypothesis in the plan]:** Contrastive pairs drawn from `contradicts` and `supports` links produce better domain classification fine-tunes than randomly sampled pairs from the same corpus. *Required baseline:* RAG-only over the same corpus, in addition to flat-corpus training.
- **H2.2 [KEEP]:** A BFS walk policy seeded from high-centrality blocks produces more coherent training sequences than random walk, as measured by next-token perplexity on held-out domain text. *Tighten:* add a power analysis on perplexity deltas before running.
- **H2.3 [TIGHTEN]:** The `ai` link layer (LLM-classified) produces higher-quality training signal than the `structural` layer for tasks requiring reasoning, while `structural` is superior for factual retrieval. *Tighten:* "reasoning vs. retrieval" must be a concrete task split with named benchmarks (e.g., MultiHop-RAG for reasoning, CUAD/LEDGAR clause extraction for retrieval), not adjectives.
- **H2.4 [TIGHTEN]:** Training on graph-derived sequences generalizes better across document versions (version-delta test sets) than flat-corpus training. *Tighten:* the version-delta test set must be constructed and named before this is runnable; specify document source, version count, and edit-type mix.

**Experiments:**
- Construct curriculum from a legal corpus (e.g., 10K contracts). Fine-tune a base LM on three curricula: (a) flat random, (b) BFS walk over structural links, (c) contrastive pairs from AI links. Evaluate on clause extraction and contradiction detection tasks.
- Vary graph density by threshold: include only AI links with confidence > 0.5, > 0.7, > 0.9. Measure downstream task performance as a function of link confidence cutoff.
- Ablate link type: train separate models with only `structural`, only `semantic`, only `ai` links. Compare on 3 tasks per domain.

---

### Area 3 — Retrieval-Augmented Inference over the Block Graph

**Question:** When a transformer client treats the block graph as its retrieval store, what client architecture minimizes overhead, and where does the latency floor sit relative to vanilla RAG and to a static-weights baseline?

This area was previously framed as "graph replaces static weight files." That framing is dropped. The honest engineering question is: how good can typed-link, provenance-aware RAG over our store get, and at what latency? Parametric weights are not being eliminated — they are being augmented with a structured, real-time retrieval substrate.

**Sub-questions:**
- What client architecture minimizes overhead? (sparse cross-attention over retrieved blocks, iterative retrieve-then-generate, agentic multi-step retrieval)
- What latency multiplier does the retrieval-augmented path carry vs. plain parametric inference for equivalent tasks?
- Does typed-link retrieval (filtering / weighting by `cites`, `contradicts`, etc.) measurably improve answer quality over flat-vector RAG?
- What update granularity is required end-to-end for a freshly inserted block to influence the next inference call?

**Hypotheses to test:**
- **H3.1 [TIGHTEN]:** For factoid Q&A over a corpus updated in the last 24 hours, a graph-resident inference client outperforms **RAG over a stale snapshot** of the same corpus on recency-sensitive questions. *Baseline corrected:* the original "stale fine-tuned model" baseline made the experiment a tautology. The interesting question is whether typed-link retrieval beats vanilla RAG with the same recency, or whether all the gain is just from the freshness of the index. Use FreshQA-style construction.
- **H3.2 [KEEP]:** The latency gap between graph-resident inference and static model inference can be bounded to 20–50x (not 1000x) with a two-tier cache: hot blocks (high degree, recent access) in memory, cold blocks on disk-backed HNSW.
- **H3.3 [TIGHTEN]:** A transformer with sparse cross-attention over ANN-retrieved blocks produces outputs competitive with a comparably sized static model on summarization tasks, while accessing only 1–5% of the graph per inference call. *Tighten:* drop BLEU/ROUGE — they are weak signal in 2026. Use a calibrated LM-as-judge rubric or a current-gen summarization benchmark with human spot-check.
- ~~H3.4 [CUT]:~~ "Inserting a new block propagates to inference within one query cycle." *This is a tautology* — it is the definition of a coherent read-after-write, not a hypothesis. Tracked as a system invariant under Area 5 instead.

**Experiments:**
- Latency benchmark: implement a minimal graph-inference client (ANN retrieval → block aggregation → LM generation). Measure tokens/sec vs. llama.cpp GGUF baseline on same hardware for 5 task types.
- Cache tier experiment: simulate Zipfian access patterns over 1M blocks. Measure hit rates and effective latency with in-memory cache sizes of 1%, 5%, 10% of corpus.
- Knowledge recency test: take a corpus with a known "fact change" (e.g., a contract amendment). Update only the delta blocks in the graph. Compare graph-resident client vs. static model on questions that depend on the amendment.
- Sparse attention ablation: implement retrieval-augmented generation where the number of retrieved blocks per step varies (k=1, 5, 10, 50, 100). Plot task performance vs. latency.

---

### Area 4 — Provenance, Compositional Reasoning, and Single-Store Properties

**Question:** What does using one Postgres store for retrieval, training, and serving — i.e. *colocation* — actually buy, and where does it break down? (The earlier "isomorphism" framing is dropped: colocation is not a structure-preserving correspondence in the mathematical sense; it just removes a sync seam.)

**Sub-questions:**
- Does block-level provenance produce visibly better auditability for legal/medical buyers than vanilla-RAG citation lists?
- Does a unified store reduce train/serve skew bugs in practice? *(Phrased as a measurement, not as a hypothesis with a fabricated effect size.)*
- Are there tasks where parametric weights are strictly superior regardless of recency, e.g., compositional reasoning that cannot be decomposed into block-level retrieval?
- What is the minimum model size for the retrieval-augmented client to be competitive?

**Hypotheses to test:**
- **H4.1 [TIGHTEN]:** For tasks that decompose into graph queries, a retrieval-augmented client with block-level provenance produces more auditable outputs than a static model, with no accuracy penalty. *Tighten:* "more auditable" requires an operational definition — attribution F1 against expert-labeled spans, or expert-rater agreement scores.
- **H4.2 [KEEP]:** Multi-step compositional reasoning ("does clause A in contract X override clause B in contract Y given law Z?") requires ≥ 3-hop graph traversal; retrieval-augmented clients only match static-model accuracy above a minimum graph-density threshold.
- ~~H4.3 [CUT / REFRAME]:~~ "Train/serve skew accounts for > 30% of retrieval failures in two-store systems." *The 30% number is fabricated.* Recast as a measurement study — instrument a representative two-store deployment, count the skew-attributable failures, and report what we find. No a priori threshold.
- **H4.4 [KEEP — highest-value hypothesis commercially; lead with this]:** The graph's typed links enable attribution — tracing exactly which blocks contributed to a generated answer — with < 5% false attribution rate, something structurally impossible for dense transformer weights.

> **Note on terminology:** earlier drafts referred to "isomorphism" between training, retrieval, and inference stores. That term is mathematically loaded (structure-preserving correspondence) and overstates the claim. The actual property is *colocation* — one Postgres database for all three roles, which removes a sync seam. The architectural footnote is true and useful; the rhetorical lift was not.

**Experiments:**
- Adversarial skew test: deliberately introduce a 24-hour lag between corpus update and model re-training. Measure task degradation. Then repeat with graph-resident client on the same updated corpus. Compare.
- Compositional reasoning benchmark: construct multi-hop question sets requiring 2, 3, 4, 5 hops through the link graph. Measure accuracy as a function of hops for graph-resident vs. static model.
- Attribution audit: on a held-out QA set, collect predicted source blocks from the graph-resident client. Have domain experts verify attribution accuracy.

---

### Area 5 — Update Semantics and Live Consistency

**Question:** When one store simultaneously serves as knowledge base, training curriculum, and inference target, what are the consistency guarantees required for the "real-time updating model" claim to hold — and what breaks when they are violated?

The real-time-ingest claim assumes that inserting a block into the graph immediately makes that knowledge available at retrieval time. This is not trivially true. Embeddings must be computed, HNSW indexes must be updated, link classifiers must run, and any cached retrieval state must be invalidated. The question is how much of this must be synchronous before the system can credibly advertise real-time behavior, and what the practical latency floor is.

**Sub-questions:**
- What is the end-to-end latency from block insertion to that block being retrievable in an inference call — broken down by pipeline stage (embed, index, link, cache invalidation)?
- Is partial visibility safe? If a block is embedded and indexed but its AI links haven't been classified yet, does serving it degrade inference quality or produce inconsistent results?
- How does update contention behave under high-ingest conditions? If 10K blocks are inserted simultaneously (e.g., a new document version), does HNSW index build time create a retrieval dead zone?
- Can the versioning model (shared block UUIDs across document versions) be exploited to make updates atomic at the version level — presenting a consistent snapshot to inference clients while the new version is being indexed?
- What is the minimum embedding refresh granularity? If a block's content changes slightly (typo fix, metadata update), does its embedding drift enough to matter for retrieval, and can drift be detected cheaply without re-embedding the full corpus?

**Hypotheses to test:**
- **H5.1 [KEEP]:** End-to-end insertion-to-retrieval latency is dominated by the HNSW index update step (not embedding or link classification), and can be reduced below 500ms for single-block inserts by deferring index consolidation to a background process.
- **H5.2 [KEEP]:** Serving partially-linked blocks (embedded + indexed but AI links not yet classified) degrades inference quality by less than 5% on reasoning tasks — embedding alone carries most of the retrieval signal; link classification is a quality enhancement, not a correctness requirement.
- **H5.3 [KEEP]:** Version-level atomicity eliminates partial-visibility artifacts at the cost of a latency window proportional to document size; that window is acceptable for typical institutional documents. *Tighten:* tie the acceptance criterion to a real document-length distribution drawn from a partner corpus, not the arbitrary "500 pages" placeholder.
- **H5.4 [KEEP — cleanest hypothesis in the document]:** Embedding drift after minor content edits (< 5% token change) is below the retrieval discrimination threshold for 95% of blocks; selective re-embedding triggered by content-hash change is sufficient.
- **H5.5 [KEEP]:** Under high-ingest load (10K blocks/minute), a write-optimized insertion path (defer HNSW index build, serve new blocks via sequential scan until index catches up) outperforms a synchronous index-on-insert path in end-to-end query recall.

**Experiments:**
- Insertion latency breakdown: instrument the ingestion pipeline to record time at each stage (parse, embed, index insert, link classify, cache invalidate). Measure P50/P99 for single-block and batch (1K block) inserts.
- Partial-visibility eval: build a 100-question eval set. Answer each question at three pipeline stages: (a) after embedding only, (b) after structural links, (c) after AI links. Measure accuracy delta across stages.
- Version atomicity test: ingest a 500-page document. Measure the wall-clock window between first block insert and full version availability. Evaluate inference quality at 25%, 50%, 75%, 100% indexing completion.
- Embedding drift detection: take 10K blocks. Apply random minor edits (1–10% token substitution). Re-embed and measure cosine distance to original. Identify the token-change threshold at which retrieval rank shifts by more than 3 positions.
- High-ingest contention: simulate 10K blocks/minute ingest against a live query workload. Compare synchronous index-on-insert vs. deferred index consolidation on query recall and ingest throughput.

---

### Area 6 — GPU Acceleration for PostgreSQL Extensions

**Question:** Can GPU-accelerated operations inside PostgreSQL close the efficiency gap between graph-resident inference and static model inference — and which pipeline stages benefit most, including when the corpus is too large to fit in VRAM?

The order-of-magnitude latency penalty of retrieval-augmented inference over the block graph comes from three places: ANN retrieval (HNSW graph walk on CPU), embedding computation (either network round-trip or CPU inference), and aggregation (weighted sum or attention over retrieved block vectors). All three are parallelizable. GPUs are already the standard compute substrate for embedding models and attention. The question is whether bringing that compute inside — or immediately adjacent to — the PostgreSQL process is architecturally viable and worth the operational complexity.

A secondary and under-examined dimension is **GPU paging**: for extremely large Nexum deployments (100M+ blocks), the embedding matrix alone (100M × 1536 × 4 bytes ≈ 600 GB float32, or ~75 GB at int8) cannot fit in a single GPU's VRAM. This requires a tiered GPU memory strategy analogous to the CPU hot/cold cache in H3.2, but operating across VRAM → system RAM → NVMe with different latency characteristics and CUDA-specific constraints (pinned memory, UVM, peer access).

**Sub-questions:**
- Which operation in the inference step function (ANN retrieval, embedding, aggregation/attention) has the highest GPU speedup potential, and what is the crossover corpus size at which GPU wins?
- Can pgml's in-process model execution be extended to GPU-backed inference (via CUDA or ROCm), and what is the memory pressure implication for the Postgres buffer pool?
- Is a GPU-colocated sidecar (a small inference server on the same host, accessed via Unix socket) a better architecture than true in-process GPU execution for latency and operational simplicity?
- For the HNSW index specifically: do GPU-accelerated ANN libraries (FAISS-GPU, cuVS/RAFT) outperform pgvector's CPU HNSW at the corpus scales relevant to Nexum (1M–100M blocks), and can their indexes be kept in sync with the Postgres block table?
- Does batching inference requests (accumulating N queries before a GPU kernel launch) improve throughput enough to offset the added latency, and what is the optimal batch size per corpus scale?
- **GPU paging:** When the embedding corpus exceeds VRAM, what is the optimal tiering strategy across VRAM / pinned system RAM / NVMe? Can CUDA Unified Virtual Memory (UVM) or GPUDirect Storage manage this transparently, or does explicit shard management (Zipfian hot-shard promotion into VRAM) outperform automatic paging?
- Can the Nexum block graph's access patterns (high-degree blocks are disproportionately retrieved) be exploited to pre-load the top-N% of blocks by in-degree into VRAM, achieving near-full-fit performance even when the full corpus is 10x VRAM capacity?

**Hypotheses to test:**
- ~~H6.1 [DEMOTE → cite]:~~ "GPU ANN > 10x CPU HNSW at 10M+ blocks." *Already established in the cuVS / FAISS-GPU literature.* Cite published numbers in our sizing memo; do not re-benchmark as a Nexum finding. We benchmark only the Nexum-specific question of whether GPU ANN can be kept in sync with the Postgres block table (tracked under Area 5 / Area 6 engineering).
- **H6.2 [TIGHTEN]:** In-process GPU embedding reduces single-block embedding latency below 5ms, making HNSW index update the new binding constraint. *Tighten:* tie the claim to a specific embedding model and hardware SKU; the threshold is meaningless without them.
- **H6.3 [KEEP]:** A GPU-colocated sidecar accessed via Unix socket achieves within 20% of true in-process GPU latency, with significantly lower operational complexity — making it the preferred architecture over modifying the Postgres process directly. (Architecturally important; the answer changes the deployment story.)
- **H6.4 [KEEP]:** Batched GPU inference (batch size 32–128) improves throughput by > 5x vs. single-query GPU inference; the added queuing latency is acceptable for non-interactive workloads. (Standard but worth measuring on Nexum's actual workload.)
- **H6.5 [KEEP — most interesting GPU hypothesis]:** For a corpus that is 10x VRAM capacity, explicit hot-shard management (top 10% of blocks by in-degree pinned in VRAM) achieves > 80% of full-fit GPU throughput, whereas CUDA UVM automatic paging achieves < 30% due to page-fault overhead on irregular ANN access patterns.
- **H6.6 [KEEP]:** The Nexum block graph's access distribution is sufficiently Zipfian — measured empirically across real institution corpora — that a 10% VRAM footprint covers > 70% of inference retrievals, making the hot-shard strategy practical without per-institution tuning.

**Experiments:**
- ANN benchmark: load 10M blocks into pgvector (CPU HNSW), FAISS-GPU (flat + IVF), and cuVS/RAFT HNSW. Measure throughput (queries/sec) and recall@10 at equivalent index build time. Run on same GPU hardware.
- Embedding latency breakdown: compare (a) OpenAI API round-trip, (b) CPU-local model via pgml, (c) GPU-local model via pgml + CUDA. Measure P50/P99 for single and batched (32, 128) requests.
- Sidecar vs. in-process: implement both architectures. Measure latency for the full inference step function (ANN + embed + aggregate). Compare on a 1000-query workload.
- Batch size sweep: for GPU embedding and GPU ANN, sweep batch sizes 1, 8, 32, 128, 512. Measure throughput and P99 latency. Identify the knee of the curve.
- Buffer pool pressure: measure Postgres shared_buffers hit rate before and after loading a GPU-backed embedding model into the process. Quantify eviction pressure on the block table data pages.
- GPU paging benchmark: synthesize a corpus at 2x, 5x, 10x VRAM capacity. Compare three strategies: (a) CUDA UVM automatic paging, (b) explicit hot-shard pinning (top-N% by in-degree), (c) CPU HNSW fallback for cold shards + GPU for hot. Measure throughput and recall@10 across strategies.
- Access distribution measurement: instrument a live Nexum query workload across 3 institution-type corpora (legal, medical, mixed). Plot block retrieval frequency rank-order distribution. Fit a Zipf curve. Measure what fraction of retrievals are served by the top 5%, 10%, 20% of blocks.

---

### Area 7 — Differentiable Graph Model and Lossless Frozen Export

**Question:** Can the Nexum block graph be formulated as a differentiable model — with a well-defined forward pass over typed-link-weighted node aggregation, trained via gradient descent / backpropagation — and can the trained graph state be serialized to a portable inference artifact *without distillation loss*, such that the frozen artifact and the live graph produce equivalent outputs?

This is a foundational computer science research question, not an engineering optimization. The live graph is the authoritative model. The live graph is also, by hypothesis, a differentiable one: block embeddings are the parameters, typed link weights are learned coefficients, and the retrieval-augmented inference step (Area 3) is the forward pass. If the forward pass is differentiable, then the graph can be trained end-to-end — gradient descent updates block embeddings and link weights in place — without training a separate model at all.

The frozen export question follows from this: if the graph IS the model, then serializing it to ONNX is not compression (no distillation, no student model, no parameter reduction). It is serializing the actual model state — block embedding tensors + link weight tensors + the typed message-passing computation graph as ONNX operators — to a portable runtime. ONNX is the right target because it can represent arbitrary computation graphs, including message-passing GNNs, not just transformer architectures. GGUF is transformer-specific; Safetensors is weights-only with no computation graph. Neither can represent what the Nexum graph IS.

"Without loss of signal" is achievable in principle because: the exported artifact contains the same parameters as the live graph (no parameter count reduction), and the same computation graph (message-passing over typed edges). Loss in a distilled model comes from compressing a large teacher into a smaller student. That is not what is happening here. The only structural loss is the discrete graph topology — which nodes connect to which — which must be encoded as sparse adjacency tensors in the ONNX model. Whether ONNX Runtime can execute this efficiently is the engineering question.

This reframes the staleness problem precisely: a frozen ONNX export can only reason about blocks that existed at export time. New ingested blocks are invisible to the frozen model until re-export. The question is not "how accurate is the frozen model vs. the live graph on static tasks" (they should be equivalent by construction) — it is "how quickly does the frozen model degrade on tasks that require knowledge of recently ingested blocks."

**Sub-questions:**
- Can the retrieval-augmented forward pass (Area 3) be made fully differentiable — specifically, can the discrete graph traversal (which is inherently non-differentiable) be relaxed into a continuous operation (e.g., soft attention over neighbors weighted by typed link confidence) that admits backpropagation?
- Does gradient descent over block embeddings and link weights converge to useful optima? Does the learned graph outperform the non-trained graph (with randomly initialized link weights) on downstream tasks?
- Does typed-link structure provide meaningful gradient signal — i.e., do `contradicts` and `supports` edges develop distinct learned weight profiles that improve task performance, or does the optimizer collapse them?
- Can the full model state (block embedding matrix, link weight tensor, sparse adjacency tensor, message-passing computation graph) be expressed as a valid ONNX graph and executed by ONNX Runtime without approximation?
- What is the throughput ratio between ONNX Runtime execution of the frozen graph model vs. live graph traversal for equivalent inference tasks? (This determines the efficiency gain of freezing.)
- At what corpus update rate does re-export need to occur for the frozen artifact to remain within an acceptable accuracy bound of the live graph?

**Hypotheses to test:**
- **H7.1 [CORE — the central thesis of this area]:** The typed-link-weighted message-passing forward pass over the Nexum block graph is differentiable via soft attention relaxation of discrete traversal, and gradient descent over block embeddings and link weights converges in fewer than 10K gradient steps on domain-specific tasks. *Kill criterion:* if loss does not decrease monotonically within 1K steps on a 10K-block synthetic corpus, the differentiability claim fails and the area reverts to distillation (Area 2 curriculum → student model).
- **H7.2 [KEEP — typed link signal]:** `contradicts` and `supports` link weights develop statistically distinct learned profiles after training (measured by cosine distance between the weight vectors of same-type vs. cross-type edges), demonstrating that typed link structure carries independent gradient signal and is not collapsed by the optimizer.
- **H7.3 [KEEP — lossless export]:** An ONNX-serialized Nexum graph model produces outputs within 1% of the live graph on a held-out eval set (equivalent task accuracy, measured by attribution F1 and answer accuracy), confirming that serialization introduces no approximation loss beyond floating-point rounding.
- **H7.4 [KEEP — staleness curve]:** The accuracy degradation of a frozen ONNX artifact relative to the live graph follows a measurable curve as a function of corpus update rate and time-since-export. Run a staleness sweep; report the measured curve; fit post-hoc. Do not pre-commit to a functional form.
- **H7.5 [KEEP — efficiency]:** ONNX Runtime execution of the frozen graph model achieves at least 10x higher throughput than live graph traversal on equivalent inference tasks, by replacing dynamic Postgres traversal with pre-compiled sparse matrix operations on fixed adjacency tensors.

**Experiments:**
- Differentiability test: implement a minimal typed-link message-passing forward pass with soft attention relaxation. Train on a 10K-block synthetic corpus with known labeled relationships. Plot loss curve; verify gradient flow through link weight parameters; check for optimizer collapse on typed edges.
- Convergence benchmark: train the differentiable graph model on a 100K-block legal corpus. Evaluate on clause extraction and contradiction detection before and after training. Compare against the non-trained graph (fixed link weights) and against a conventionally fine-tuned transformer of equivalent parameter count.
- ONNX serialization: export the trained graph (block embedding matrix, link weight tensor, sparse adjacency tensor) as an ONNX model. Verify round-trip: run the ONNX model on a held-out eval set; compare outputs to live graph inference on the same inputs. Measure accuracy delta and floating-point error.
- Staleness curve: export a frozen ONNX artifact, then continuously ingest updates into the live graph. Evaluate both on a stable held-out set daily for 2 weeks. Plot accuracy delta vs. days-since-export at corpus update rates of 10, 100, 1K, 10K blocks/day.
- Throughput comparison: measure inference throughput (queries/sec) for (a) live graph traversal via Postgres, (b) ONNX Runtime on the frozen artifact, (c) GPU-accelerated ONNX Runtime. Target: quantify the efficiency gain of freezing and identify the latency floor.

---

## Related Research Documents

- [`research/pg-extensions.md`](research/pg-extensions.md) — Extended PostgreSQL options on the table (AGE, pgml, TimescaleDB, ParadeDB, Lantern) and the case for building a purpose-built `nexum` extension (`pgrx`-based) with a composite graph-vector index, curriculum walker, inference step function, and provenance aggregate.

---

## Research Sequencing — Bayesian Decision Program

The research areas are not fully independent, and their value is not equal. The goal is to answer the highest-uncertainty, highest-impact questions first so that negative results terminate expensive downstream work early rather than late. Each gate is the smallest experiment that resolves a binary decision with high confidence.

### Sequencing Principle

**Correctness before scalability.** The first questions are: does the system produce correct answers, and does typed-link provenance add measurable value over vanilla RAG? Scalability questions (does Postgres handle 5M blocks?) are irrelevant until correctness is established. An architecture that scales but gives wrong answers is not useful. An architecture that gives right answers at small scale can be scaled.

Experiments are therefore ordered by what they tell us about *whether this works*, not *how fast it runs*.

### Decision Gates

Five gates determine the shape of the program. Each gate produces a binary outcome that changes which subsequent work is staffed. They are listed here in the order they should be run — correctness gates first.

| Gate | Question | Type | Signal by | Stakes if NO |
|---|---|---|---|---|
| **G2** | Does provenance beat vanilla RAG visibly? | Correctness | Week 2 | Program narrows to pure systems research; all ML/curriculum/export work shelved |
| **G0** | Is the graph differentiable? | Research direction | Week 3 | Area 7 reverts to distillation; Area 2 becomes primary training mechanism |
| **G1** | Does Postgres scale to target corpus? | Scalability | Week 6 | Graph DB migration required; blocks Area 1 full, Area 6 |
| **G3** | Does typed-link structure carry independent gradient signal? | Research direction | Week 8 | Link types dropped from gradient axis; model reduces to untyped GNN |
| **G4** | Is ONNX serialization lossless? | Research direction | Week 8 | Frozen export requires distillation (lossy); changes product tier story |

G2 is the most load-bearing gate and must run first. If provenance does not measurably improve answers at small scale, none of the scalability or ML work matters. G0 is the most load-bearing gate for the differentiable graph thesis and runs second, independently of G2.

---

### Phase 0 — Correctness (Weeks 1–2)

**Prerequisite:** the API server must be running with at minimum: `POST /corpora`, `POST /documents` (text/markdown), `POST /query` (semantic mode), and the embedding pipeline. All Phase 0 experiments run at small corpus scale — hundreds to thousands of blocks, not millions.

**G2 — Wedge demo (H4.4)**
The first experiment to run as soon as the API is up. Ingest a small legal corpus (50–100 CUAD contracts) into Nexum and into a vanilla LlamaIndex RAG instance using the same documents. Run 50 QA pairs from the CUAD evaluation set through both. Measure attribution F1: what fraction of cited source blocks actually contain the gold answer span? Pass criterion: Nexum attribution F1 > vanilla RAG by > 5 percentage points on the held-out set. Time budget: 1 week from API readiness. This is a correctness test, not a performance test — run it at whatever scale the API can handle.

**Area 5 partial visibility (H5.2, H5.4) — parallel with G2**
Two sub-experiments that test live-ingest correctness at small scale:
- H5.2: does serving a block before its AI links are classified degrade answer quality by more than 5%? (embed-only vs. fully-linked)
- H5.4: does a minor content edit (< 5% token change) require re-embedding, or is the existing embedding still retrieval-accurate? Run on 10K blocks with synthetic edits.
Neither requires large corpora or performance measurement.

---

### Phase 1 — Quality Measurement (Weeks 2–4)

**Area 4 — Provenance and compositional reasoning (H4.1, H4.2, H4.4)**
After G2 confirms provenance adds value, measure precisely how much and under what conditions. Attribution audit: run 100 CUAD QA pairs, expert-verify the cited blocks (automated against gold spans). Multi-hop: construct 2/3/4/5-hop questions from cross-document CUAD relationships; measure whether Nexum's graph traversal closes the gap that vanilla RAG cannot. Pass: false attribution rate < 5% (H4.4) and Nexum outperforms vanilla at ≥ 3-hop questions (H4.2).

**Area 3 — Retrieval quality at small scale (H3.1, H3.3)**
At the same small scale as G2: does typed-link graph traversal produce better answers than flat ANN retrieval on the same corpus? Does adding graph expansion to a semantic query improve multi-hop answer quality? Use an LM-as-judge rubric on 50 questions. This answers the question "is the graph traversal doing useful work?" before we ask "is it fast?"

**G0 — Differentiability spike (H7.1) — parallel with Area 3**
Independent of the above. Implement the minimal typed-link message-passing forward pass on a 10K-block synthetic corpus. Run backpropagation. Pass criterion: loss decreases monotonically within 1K gradient steps. The outcome determines whether Areas 2 and 7 proceed on the differentiable or distillation path.

---

### Phase 2 — Scalability (Weeks 4–8, after Phase 0 passes)

Only run after G2 has confirmed correctness. Scalability experiments are meaningless if the system does not first produce correct answers.

**G1 — Postgres scale floor (H1.1)**
Build a 5M-block synthetic corpus; measure P50/P99 for all three query modes. Pass criterion: P99 < 500ms. Time budget: 3 days. This is a measurement, not a research experiment — it either passes or triggers a storage migration decision.

**Area 1 — Storage architecture fitness (H1.1, H1.2)**
If G1 passes, extend to 20M / 100M blocks. Compare Postgres vs. Kuzu for graph traversal. Run embedding dimension ablation (512 / 768 / 384 with our local model). These results inform Area 6 (GPU) and confirm the storage architecture for the full program.

**Area 5 — Full update semantics (H5.1, H5.3, H5.5)**
Now that the correctness sub-experiments (H5.2, H5.4) are done, measure the full latency picture: insertion-to-retrieval pipeline breakdown, version atomicity window, high-ingest contention. These results identify the binding constraint for Area 6.

---

### Phase 3 — Speculative (Weeks 8–16, gated on G0)

**If G0 passed:**
- **G4 — ONNX losslessness spike** (H7.3): export the trained graph to ONNX; verify < 1% accuracy delta
- **G3 — Typed-link gradient signal** (H7.2): measure whether edge types develop distinct learned profiles
- **Area 7 — Differentiable graph full run**: train at 100K-block scale; staleness curve; throughput comparison
- **Area 2 — Training curriculum** (H2.1–H2.4): characterize the signal that typed-link curriculum provides

**If G0 failed:**
- **Area 2 — Training curriculum** (primary path): contrastive pairs from `contradicts`/`supports` links → fine-tune a base LM → evaluate improvement over flat-corpus training
- **Area 7 — Distillation path**: graph → BFS curriculum → student model → GGUF export

**Area 6 — GPU acceleration** (depends on Area 5 identifying the binding constraint): only run after Area 5 latency baselines show that GPU would actually help.

---

### Dependency Tree

```
Phase 0: G2 wedge demo ───── Area 5 (H5.2, H5.4 only)
              │
         [passes?]
              │
Phase 1:  Area 4 ──── Area 3 ──── G0 (parallel, independent)
              │                        │
         [confirmed]             [G0 YES / NO]
              │                        │
Phase 2:  G1 scale ── Area 1 ──── Area 5 full
              │
         [passes?]
              │
Phase 3:  [G0 YES] G4 ── G3 ── Area 7 ── Area 2
          [G0 NO]  Area 2 (primary) ── Area 7 (distillation)
          Area 6 (after Area 5 identifies bottleneck)
```

---

### Program Kill Criteria

The program terminates or narrows at two hard gates:

1. **G2 fails (wedge demo, Phase 0):** If typed-link provenance does not produce measurably better attribution than vanilla RAG on a small real corpus within two weeks of API readiness, the program narrows immediately to pure systems research — Areas 1, 5, 6 only. All curriculum, retrieval-inference, and frozen-export work is shelved. No further staffing on Areas 2, 3, 4, 7. This is the earliest possible signal and the cheapest possible kill.

2. **G0 and H2.1 both fail:** If the graph is not differentiable (G0) and typed-link contrastive pairs do not improve fine-tuning over random sampling (H2.1), the typed link layer has no training signal — only retrieval value. The program narrows to: block-level provenance + real-time ingest + attribution as a pure retrieval product. The research thesis is falsified; this is a valid outcome.

---

## Metrics Taxonomy

| Metric | Type | Used In |
|---|---|---|
| Query latency P50/P99 (ms) | Efficiency | Areas 1, 3 |
| Storage bytes per block | Efficiency | Area 1 |
| ANN recall@10 | Quality | Areas 1, 3 |
| Graph traversal throughput (hops/sec) | Efficiency | Areas 1, 3 |
| Fine-tune task accuracy delta | Quality | Area 2 |
| Inference tokens/sec | Efficiency | Area 3 |
| Knowledge recency delta (hours) | Correctness | Areas 3, 4 |
| Attribution accuracy (%) | Auditability | Area 4 |
| Insertion-to-retrieval latency (ms) | Correctness | Areas 5, 6 |
| Embedding drift (cosine delta) | Correctness | Area 5 |
| GPU ANN throughput (queries/sec) | Efficiency | Area 6 |
| Batch inference throughput (tokens/sec) | Efficiency | Area 6 |
| Frozen artifact task accuracy vs. live graph (%) | Quality | Area 7 |
| Staleness accuracy decay (% / day) | Correctness | Area 7 |
| Export pipeline wall-clock time (hours) | Efficiency | Area 7 |

---

## Open Questions (not yet hypotheses)

These are not yet falsifiable but need conceptual resolution before experiments can be designed:

1. **Client architecture:** What is the right abstraction for a "graph-resident inference client"? Is it a transformer with retrieval-augmented attention, a differentiable memory network, a chain-of-thought agent, or something novel?
2. **Curriculum ordering:** BFS/DFS over the link graph is a natural walk, but is there a principled way to derive a total ordering of blocks that maximizes information gain per training step?
3. **Update atomicity:** When a block is updated in a live production corpus, which downstream inference operations need to be invalidated? Can a dependency graph over cached inference results be maintained cheaply?
4. **Embedding drift:** If blocks share a UUID across versions but the content changes (via `parent_block_id` lineage), the embedding is stale. How do we detect and manage embedding drift without re-embedding the entire corpus?
5. ~~**Multi-tenancy / intra-org permissions.**~~ Resolved: this is a product requirement, not a research question. A corpus deployment serves many users with different roles and permissions. The graph, database, and client must enforce access control natively — at the corpus level and block level — as specified in the product's principal and privacy model. No experiment needed; the design is in the product spec.

---

## Agent Loop Protocol

For autonomous research agents operating over this plan:

1. **Select** the next hypothesis from the **curated priority queue** maintained in `docs/research/queue.md`. Each entry carries a manually assigned score:
   `priority = (commercial_value × scientific_novelty × tractability) / (compute_cost × time_to_signal)`
   The queue is reviewed weekly by a human; the autonomous loop reads from it rather than computing its own score. *(The previous UCB-based selection is retired: bandit selection presumes commensurable reward, which recall@10, fine-tune accuracy delta, and tokens/sec do not provide. UCB systematically chases the noisiest evals.)*
2. **Operationalize** the selected hypothesis into a concrete experiment spec: dataset, metric, **named baseline** (from the prior-art list in `methodology.md`), intervention, **statistical plan** (n, power, CI), **compute budget**, and a **kill-criterion spike** — the smallest experiment, in days, that decides keep-or-drop.
3. **Execute** the spike first. If the spike passes, run the full experiment. Write results as a new block linked to the hypothesis block with `rel_type: supports | contradicts | inconclusive`.
4. **Spawn** child hypotheses sparingly: for each supported hypothesis, generate a more specific version; for each contradicted hypothesis, generate an alternative explanation. Children inherit the design-partner question from the parent or are not spawned.
5. **Prune** hypotheses superseded by results. Mark with a `confirmed: false` link from the child hypothesis block back to the parent.
6. **Escalate** to a human reviewer after every 5 cycles, or whenever a result contradicts a previously supported hypothesis, or when the wedge-demo (remediation Step 6) gates the next area's staffing.

Every hypothesis, experiment spec, result, and child hypothesis is stored as a block in the Nexum graph, making the research process itself a first-class corpus.

---

## Methodology and Product Scaffolding

The 2026-04-27 review (`docs/research-plan-review-2026-04-27.md`) flagged that this plan was missing both methodological scaffolding (statistical plans, prior-art baselines, named evals, null-result protocol, compute budgets) and product scaffolding (design partners, time-to-signal spikes, buy-vs-build calls, demos, pricing surfaces, buyer's-bar evals).

These scaffolds live alongside this plan rather than inline:

- `docs/research/methodology.md` *(forthcoming)* — standard evals adopted (BEIR, MTEB, FreshQA, LegalBench, MIRAGE, MultiHop-RAG, plus 3–5 institution-shaped sets), statistical plan template, prior-art baseline list (LlamaIndex, Vespa, ColBERT, RAPTOR, GraphRAG, MemGPT) with which hypothesis each baselines, compute-budget template, and the **null-result protocol** specifying when the program terminates.
- `docs/research/queue.md` *(forthcoming)* — the curated priority queue consumed by the agent loop above.
- `docs/research/cut.md` *(forthcoming)* — audit trail of CUT and DEMOTE'd hypotheses with one-line reasons.
- `docs/research/pricing-surfaces.md` *(forthcoming)* — mapping from hypothesis outputs to invoice lines (blocks/month, queries/month, audit-grade tier, etc.).

Per-hypothesis frontmatter is being extended (in `docs/research/hypotheses/`) to include: `baselines:`, `compute_budget:`, `design_partner_question:`, `demo:`, `kill_criterion_spike:`. Any hypothesis whose `design_partner_question` is empty after Step 4 of the remediation plan is reclassified as exploratory and not staffed until a partner asks.

### The wedge demo (Gate G2)

The wedge demo is Gate G2 in the Bayesian sequencing plan. It runs in Phase 1 (Weeks 3–6), in parallel with the ONNX losslessness spike (G4) and the Area 1 storage benchmark. It combines **H4.4 (block-level provenance)** + the typed-link retrieval forward pass (Area 3) + **H5.1 / H5.2 (real-time ingest)** on one legal or medical partner corpus. It runs regardless of G0 (differentiability) outcome — provenance quality does not depend on whether the graph is gradient-trainable.

Pass criterion: the demo produces visibly better attribution accuracy than vanilla RAG on a held-out question set, and at least two design partners engage within four weeks of the demo. If this criterion is not met, the program narrows immediately to pure systems research — Areas 1, 5, 6 only — and the curriculum / retrieval-inference / frozen-export work is shelved until a customer asks for it. This is the program's product-market fit gate and its null-result protocol.
