# Nexum — Hypothesis Priority Queue

The curated priority queue consumed by the autonomous research agent loop. Ordered highest-priority first. The agent always selects from the top of this queue, subject to gate and blocking constraints.

Priority score formula: `(commercial_value × scientific_novelty × tractability) / (compute_cost × time_to_signal)`

All scores are manually assigned; reviewed weekly by a human. The agent reads from this queue rather than computing its own score. See `docs/research/methodology.md` for the statistical plan template each hypothesis must complete before an experiment is run.

---

## G0 — Differentiability Kill Criterion (H7.1 spike)

priority: 25  # highest tractability, lowest time-to-signal; binary pass/fail in days
phase: 0
gate: G0
blocked_on: none
design_partner_question: "Can your graph model be gradient-trained end-to-end, or is it purely a retrieval store?"
kill_criterion_spike: 5 days — implement typed-link message-passing forward pass on 10K-block synthetic corpus; run backpropagation; if loss does not decrease monotonically within 1K steps, G0 fails immediately
compute_budget: ~10 GPU-hours on A100; synthetic corpus fits in memory; negligible cloud cost (~$30)
status: queued

---

## G1 — Postgres Scale Floor (H1.1)

priority: 20  # high tractability, 3-day spike; blocks Areas 3/5/6 if it fails
phase: 0
gate: G1
blocked_on: none
design_partner_question: "Does your system stay fast enough to use as we grow from a small pilot corpus to our full document archive?"
kill_criterion_spike: 3 days — build 1M-block and 5M-block synthetic corpora in Postgres + pgvector; measure P99 query latency; pass criterion: P99 < 500ms at 5M blocks on target hardware
compute_budget: ~20 GPU-hours for corpus generation; PostgreSQL runs on CPU; ~$50 cloud cost
status: failed
verdict: FAIL — recursive CTE graph traversal (6-hop) is the binding constraint; P99=3347ms at 100K blocks (6.7× over gate). Semantic (HNSW) and fulltext pass. See H1.1 for full analysis. Binding constraint feeds H5.1.
issue: 135
results: experiments/g1-postgres-scale/results/g1_20260514T200417Z.json

---

## G2 — Wedge Demo / Attribution Beats Vanilla RAG (H4.4)

priority: 18  # highest commercial value; product-market fit gate
phase: 1
gate: G2
blocked_on: G1 (need confirmed storage stack for demo corpus)
design_partner_question: "Can you show me exactly which sentence in which document led to this answer — and prove it's not hallucinated?"
kill_criterion_spike: 3 days — build minimal provenance demo on CourtListener subset; run head-to-head attribution F1 vs. LlamaIndex citation mode on 50-question held-out set
compute_budget: ~40 GPU-hours (corpus ingestion + LLM inference for eval); ~$120 cloud cost
status: queued

---

## G4 — ONNX Losslessness Spike (H7.3)

priority: 16  # resolves frozen-export product tier story; run immediately after G0 on same small corpus
phase: 1
gate: G4
blocked_on: G0 (need trained differentiable graph model to export)
design_partner_question: "If I deploy your frozen model on our air-gapped servers, will it give the same answers as your live system?"
kill_criterion_spike: 4 days — export the G0 trained model to ONNX; run held-out eval on live graph and ONNX Runtime; pass criterion: < 1% attribution F1 delta
compute_budget: ~5 GPU-hours; ONNX export and eval are cheap; ~$15 cloud cost
status: blocked

---

## H1.2 — Heterogeneous Corpus Embedding vs. Graph Traversal Quality

priority: 14  # high scientific novelty; quantifies key claim; moderate tractability
phase: 1
gate: none
blocked_on: G1
design_partner_question: "Our corpus has PDFs, spreadsheets, and code — does your system handle all of them well, or does it break on certain types?"
kill_criterion_spike: 5 days — construct a 50K-block mixed-type corpus (legal PDFs + financial tables + code); define cross-type query eval set (50 queries); compare embedding recall@10 vs. graph traversal NDCG@10
compute_budget: ~15 GPU-hours (embedding 50K blocks + eval); ~$45 cloud cost
status: failed
verdict: FAIL (original criterion) — hybrid recall@10 matched semantic (0.075) exactly; the planted target was almost never one hop from semantic top-10. Edge-semantic mode (AGE typed-link embeddings) showed 10× gain (recall@10=0.765 vs 0.075). The original hybrid-expansion operationalisation is refuted; typed-edge embeddings are the productive direction. See H1.2 hypothesis file and issue #138 for full analysis.
issue: 138
results: experiments/area1-storage-fitness/results/h1.2_20260510T015402Z.json

---

## H5.1 — HNSW Index Update as Binding Constraint

priority: 13  # directly informs latency SLA for real-time ingest claim; clean and tractable
phase: 1
gate: none
blocked_on: G1
design_partner_question: "How long does it take for a newly uploaded document to be searchable in your system?"
kill_criterion_spike: 3 days — instrument ingestion pipeline; measure P50/P99 per stage (embed, index, link, cache invalidate) for single-block and 1K-block batch inserts
compute_budget: ~5 GPU-hours; instrumentation only; ~$15 cloud cost
status: queued

---

## H5.4 — Embedding Drift After Minor Content Edits

priority: 12  # cleanest hypothesis in the plan; tractable; motivates selective re-embedding product feature
phase: 1
gate: none
blocked_on: G1
design_partner_question: "If someone fixes a typo or updates a clause, does your system know to reindex that block, or does it silently serve stale results?"
kill_criterion_spike: 2 days — take 10K blocks; apply 1–10% token substitution; re-embed; measure cosine distance to original; identify drift threshold
compute_budget: ~8 GPU-hours (re-embedding 10K blocks); ~$24 cloud cost
status: queued

---

## H4.2 — Multi-Step Compositional Reasoning Requires ≥ 3-Hop Traversal

priority: 11  # high commercial value (legal cross-document reasoning); moderately complex
phase: 2
gate: none
blocked_on: G2 (need wedge demo infrastructure)
design_partner_question: "Can your system answer questions that require connecting facts across multiple documents — like whether clause A in contract X overrides clause B in contract Y given statute Z?"
kill_criterion_spike: 5 days — construct 2/3/4/5-hop question set (50 questions per hop count) from CourtListener corpus; measure graph-resident vs. static model accuracy by hop count
compute_budget: ~30 GPU-hours (LLM inference + graph traversal benchmarking); ~$90 cloud cost
status: blocked

---

## H2.1 — Contrastive Pairs from Typed Links Beat Random Sampling

priority: 10  # most novel hypothesis in the plan; high scientific novelty; compute-intensive
phase: 2
gate: none
blocked_on: G1
design_partner_question: "Can your system use the structure of our document corpus to train a model that understands our domain better than a generic fine-tune would?"
kill_criterion_spike: 7 days — construct 1K contrastive pairs from contradicts/supports links on 5K-contract EDGAR subset; fine-tune base LM on (a) flat random, (b) typed contrastive; evaluate on clause extraction; compare accuracy delta
compute_budget: ~80 GPU-hours (3 fine-tune runs on 7B model); ~$240 cloud cost
status: queued

---

## H3.2 — Latency Gap Bounded to 20–50x with Two-Tier Cache

priority: 9  # determines whether retrieval-augmented inference is deployable; architecturally critical
phase: 2
gate: none
blocked_on: G1, H5.1 (need binding constraint identified)
design_partner_question: "How much slower is your live retrieval system compared to just running a local model? Is it usable in production?"
kill_criterion_spike: 4 days — implement minimal graph-inference client; measure tokens/sec vs. llama.cpp GGUF baseline; simulate Zipfian cache at 1%/5%/10% of 1M-block corpus
compute_budget: ~20 GPU-hours; ~$60 cloud cost
status: blocked

---

## H7.2 — Typed Link Weights Develop Distinct Learned Profiles (G3)

priority: 9  # determines whether link types carry independent gradient signal; gates G3
phase: 1
gate: G3
blocked_on: G0
design_partner_question: "Does your system actually understand the difference between a document that contradicts another vs. one that supports it — or is that distinction just metadata?"
kill_criterion_spike: 5 days — extend G0 model to 100K-block legal corpus; measure cosine distance between contradicts and supports weight vectors after training; significance test p < 0.05
compute_budget: ~40 GPU-hours (GNN training on 100K blocks); ~$120 cloud cost
status: passed
passed_at: 2026-05-14T19:36:53Z
results_path: experiments/g3-typed-signal/results/g3_20260514T193653Z.json

---

## H5.2 — Partially-Linked Blocks Degrade Quality by Less Than 5%

priority: 8  # determines partial-visibility safety; informs ingest pipeline design
phase: 2
gate: none
blocked_on: G1, H5.1
design_partner_question: "If a document is being indexed and someone queries it mid-way through, will they get garbage results or something reasonable?"
kill_criterion_spike: 4 days — build 100-question eval; answer at three pipeline stages (embed only, + structural links, + AI links); measure accuracy delta across stages
compute_budget: ~15 GPU-hours; ~$45 cloud cost
status: blocked

---

## H5.3 — Version-Level Atomicity Eliminates Partial-Visibility Artifacts

priority: 7  # correctness guarantee; tractable; requires real document-length distribution from partner
phase: 2
gate: none
blocked_on: G2 (need partner corpus for document-length distribution), H5.1
design_partner_question: "If a document is being updated, will your users see a half-updated version, or does it flip atomically?"
kill_criterion_spike: 3 days — ingest a 500-page document; measure wall-clock window from first block insert to full version availability; evaluate inference quality at 25%/50%/75%/100% indexing completion
compute_budget: ~10 GPU-hours; ~$30 cloud cost
status: blocked

---

## H5.5 — Deferred HNSW Index Build Outperforms Synchronous Insert Under High Load

priority: 7  # ingest throughput under load; relevant for large institution onboarding
phase: 2
gate: none
blocked_on: G1, H5.1
design_partner_question: "If we upload 10,000 documents at once during a migration, will your system handle it without going down?"
kill_criterion_spike: 3 days — simulate 10K blocks/minute ingest against live query workload; compare synchronous index-on-insert vs. deferred consolidation on query recall
compute_budget: ~15 GPU-hours; ~$45 cloud cost
status: blocked

---

## H6.2 — In-Process GPU Embedding Below 5ms Per Block

priority: 6  # directly informs latency floor; ties to H5.1 binding constraint analysis
phase: 3
gate: none
blocked_on: H5.1 (need embedding confirmed as binding constraint)
design_partner_question: "Can you make your system fast enough that the latency is not noticeable to end users?"
kill_criterion_spike: 3 days — compare (a) OpenAI API, (b) CPU pgml, (c) GPU pgml+CUDA for single-block embedding latency P50/P99; tie to specific model SKU and hardware
compute_budget: ~10 GPU-hours; ~$30 cloud cost
status: queued

---

## H6.3 — GPU Sidecar Within 20% of In-Process GPU Latency

priority: 6  # architectural decision: sidecar vs. in-process; determines deployment story
phase: 3
gate: none
blocked_on: H6.2
design_partner_question: "How do you deploy the GPU acceleration — does it require modifying the database, or is it a separate component?"
kill_criterion_spike: 5 days — implement both sidecar and in-process GPU architectures; measure full inference step latency on 1,000 queries; compare P50/P99
compute_budget: ~20 GPU-hours; ~$60 cloud cost
status: queued

---

## H6.5 — Hot-Shard Management Achieves >80% of Full-Fit GPU Throughput at 10x VRAM

priority: 6  # most interesting GPU hypothesis; enables large-corpus GPU deployment
phase: 3
gate: none
blocked_on: H6.2, H6.6
design_partner_question: "Can your system use GPU acceleration even if our corpus is too large to fit in GPU memory?"
kill_criterion_spike: 5 days — synthesize corpus at 2x/5x/10x VRAM; compare CUDA UVM vs. hot-shard pinning (top 10% by in-degree) on throughput and recall@10
compute_budget: ~50 GPU-hours (large corpus generation + GPU paging benchmarks); ~$150 cloud cost
status: queued

---

## H6.4 — Batched GPU Inference Improves Throughput by >5x

priority: 5  # standard GPU batching; validates workload characteristics
phase: 3
gate: none
blocked_on: H6.2
design_partner_question: "Does your GPU acceleration scale with query volume, or is it only fast for individual queries?"
kill_criterion_spike: 2 days — sweep batch sizes 1/8/32/128/512; measure throughput and P99 latency; identify knee of curve
compute_budget: ~10 GPU-hours; ~$30 cloud cost
status: queued

---

## H6.6 — Nexum Access Distribution Is Zipfian Across Institution Corpora

priority: 5  # prerequisite empirical measurement for hot-shard strategy
phase: 3
gate: none
blocked_on: G2 (need real institution corpora)
design_partner_question: "How do you know which parts of our document archive to keep in fast memory?"
kill_criterion_spike: 3 days — instrument live query workload on 3 institution-type corpora; plot retrieval frequency rank-order; fit Zipf; measure top-5%/10%/20% coverage
compute_budget: ~5 GPU-hours (instrumentation only); ~$15 cloud cost
status: blocked

---

## H2.2 — BFS Walk Produces More Coherent Training Sequences Than Random Walk

priority: 5  # extends H2.1 signal; requires power analysis on perplexity delta before running
phase: 3
gate: none
blocked_on: H2.1
design_partner_question: "How does your system decide which documents to include in a fine-tuning run?"
kill_criterion_spike: 5 days — compare BFS walk from high-centrality blocks vs. random walk; evaluate next-token perplexity on held-out domain text; run power analysis before experiment
compute_budget: ~40 GPU-hours (LM training); ~$120 cloud cost
status: blocked

---

## H2.3 — AI Link Layer vs. Structural Layer Signal for Reasoning vs. Retrieval

priority: 5  # tightened: requires concrete task split with named benchmarks before staffing
phase: 3
gate: none
blocked_on: H2.1
design_partner_question: "Do the AI-inferred links in your graph add value over just using the document structure?"
kill_criterion_spike: 5 days — ablate link types (structural only / semantic only / AI only); evaluate on MultiHop-RAG (reasoning) and CUAD span F1 (retrieval); compare across ablations
compute_budget: ~60 GPU-hours (3 fine-tune runs); ~$180 cloud cost
status: blocked

---

## H2.4 — Graph-Derived Sequences Generalize Better Across Document Versions

priority: 4  # requires version-delta test set construction before runnable
phase: 3
gate: none
blocked_on: H2.1 (need version-delta fixture from docs/research/fixtures.md)
design_partner_question: "When our documents get updated, does your fine-tune hold up, or do we need to retrain from scratch?"
kill_criterion_spike: 5 days — construct version-delta test set from 10K EDGAR contracts (v1 and v2); compare graph-derived vs. flat-corpus training on version-delta eval
compute_budget: ~80 GPU-hours (fine-tune + eval); ~$240 cloud cost
status: blocked

---

## H3.1 — Graph-Resident Inference Outperforms Stale Snapshot RAG on Recency-Sensitive Questions

priority: 4  # baseline corrected; FreshQA-style construction required before running
phase: 2
gate: none
blocked_on: H5.1, H5.2 (need real-time ingest confirmed)
design_partner_question: "If someone updates a contract clause today, will your system's answers reflect that change immediately?"
kill_criterion_spike: 3 days — construct FreshQA-style corpus with known fact change (contract amendment); update delta blocks in graph; compare graph-resident vs. stale snapshot on 50 recency-sensitive questions
compute_budget: ~20 GPU-hours (LLM inference for eval); ~$60 cloud cost
status: blocked

---

## H3.3 — Sparse Attention RAG Competitive with Static Model on Summarization

priority: 4  # drop BLEU/ROUGE; use calibrated LM-as-judge rubric before staffing
phase: 2
gate: none
blocked_on: G1, H3.2
design_partner_question: "Can your retrieval-augmented system summarize a large document as well as a model that's read the whole thing?"
kill_criterion_spike: 5 days — implement k=1/5/10/50/100 block retrieval; evaluate on summarization benchmark (LM-as-judge, not BLEU/ROUGE); compare vs. static model at equivalent parameter count
compute_budget: ~30 GPU-hours; ~$90 cloud cost
status: blocked

---

## H4.1 — Retrieval-Augmented Client Produces More Auditable Outputs with No Accuracy Penalty

priority: 4  # requires operational definition of "auditable" before staffing (attribution F1 or expert rater)
phase: 2
gate: none
blocked_on: G2
design_partner_question: "Can your system explain its answers in a way that a lawyer or doctor could verify and stand behind in court or a clinical review?"
kill_criterion_spike: 3 days — run LegalBench (20-task sample) on Nexum vs. static model; compute attribution F1 against expert-labeled spans on 50-question held-out set; expert spot-check attribution accuracy
compute_budget: ~20 GPU-hours; ~$60 cloud cost
status: supported (simulation)
verdict: SUPPORTED (simulation) — provenance chain reduces time-to-verify by 55% (p<0.0001, Cohen's d=2.3) and error rate by 67% vs. static snapshot baseline. 38-item corpus, 4 document types. Live human-rater replication blocked on G2. See H4.1 hypothesis file and issue #141.
issue: 141
results: experiments/area4-provenance/results/h4.1_20260528T161011Z.json

---

## H7.4 — Staleness Curve: Frozen ONNX Accuracy Degrades as Function of Update Rate

priority: 4  # product-relevant; determines re-export cadence; requires G4 to confirm losslessness first
phase: 3
gate: none
blocked_on: G4
design_partner_question: "How often do we need to refresh the frozen model on our air-gapped servers as our document corpus evolves?"
kill_criterion_spike: 14 days — export frozen ONNX artifact; continuously ingest updates into live graph; evaluate both daily for 2 weeks at update rates 10/100/1K/10K blocks/day; plot accuracy delta vs. days-since-export
compute_budget: ~100 GPU-hours (2 weeks of daily eval + continuous ingest); ~$300 cloud cost
status: blocked

---

## H7.5 — ONNX Runtime Achieves ≥10x Throughput vs. Live Graph Traversal

priority: 3  # validates frozen deployment efficiency; requires G4 first
phase: 3
gate: none
blocked_on: G4
design_partner_question: "If we use the frozen model instead of the live graph, how much faster is it?"
kill_criterion_spike: 3 days — measure inference throughput (queries/sec) for (a) live Postgres traversal, (b) ONNX Runtime frozen artifact, (c) GPU-accelerated ONNX Runtime; report speedup ratio
compute_budget: ~20 GPU-hours; ~$60 cloud cost
status: blocked

---

## H6.1 — DEMOTED (see cut.md)

status: cut

---

## H1.3 — DEMOTED (see cut.md)

status: cut

---

## H3.4 — CUT (see cut.md)

status: cut

---

## H4.3 — CUT / REFRAME (see cut.md)

status: cut

---

## H7.4 (old) — DEMOTED (see cut.md)

status: cut
