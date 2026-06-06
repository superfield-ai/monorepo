# Nexum — Research Methodology Reference

This document is the methodological scaffolding for the Nexum research program. Every experiment operationalized from `docs/research.md` must reference the evals, baselines, statistical plan template, null-result protocol, and compute budget template defined here before it is staffed.

---

## Standard Evals Adopted

Each benchmark below specifies: what it measures, the exact metric used in Nexum experiments, and which hypotheses it covers.

### BEIR (Benchmarking Information Retrieval)

**What it measures:** Zero-shot retrieval quality across 18 heterogeneous datasets spanning medical, legal, news, and general corpora. Tests whether a retrieval system generalizes without per-dataset fine-tuning.

**Nexum metric:** NDCG@10 (primary). Secondary: Recall@10, MAP.

**Hypotheses covered:** H1.1, H1.2, H3.x retrieval experiments.

**Notes:** Run against all three Nexum query modes (semantic, full-text, graph traversal). TREC-COVID, HotpotQA, and FIQA subsets are the minimum required; full 18-dataset run is the release-claim standard. BM25 is the mandatory floor baseline on every BEIR run.

---

### MTEB Retrieval Subset (Massive Text Embedding Benchmark)

**What it measures:** Embedding model generalization across retrieval tasks — whether the block embedding choice holds across domain types and languages.

**Nexum metric:** nDCG@10 (retrieval tasks). Run the retrieval subset only (not classification or clustering) unless embedding model changes affect those task types.

**Hypotheses covered:** H1.2 (heterogeneous corpus embedding quality vs. graph traversal quality).

**Notes:** Run when changing embedding model, dimensionality, or quantization. Cadence: every Area 1 milestone and before any embedding model upgrade. Baselines: `text-embedding-3-small` (OpenAI), `bge-m3` (BAAI), Gemini Embedding 2.

---

### FreshQA

**What it measures:** Time-sensitive factoid retrieval — whether a system's answers track corpus updates. Answers change over time; stale systems degrade visibly.

**Nexum metric:** Accuracy on time-sensitive questions (binary correct/incorrect).

**Hypotheses covered:** H3.1 (graph-resident inference vs. stale snapshot), H7.4 (staleness curve for frozen ONNX artifact).

**Notes:** Run at two points in Area 5 and Area 7 experiments: once against the live Nexum graph, and once against the frozen ONNX artifact at varying days-since-export. The delta between live and frozen is the primary signal. Reference baselines (2025): Valyu 79%, Parallel 52%, Google 39%.

---

### LegalBench (20-task sample)

**What it measures:** Legal reasoning generalization across 162 tasks covering statutes, judicial opinions, and contracts. The 20-task sample covers binary classification, extraction, and entailment tasks — sufficient to claim domain generalization without full 162-task compute.

**Nexum metric:** Task-specific accuracy (binary/multi-class classification tasks); F1 (extraction tasks). Report micro-F1 over the 20-task sample.

**Hypotheses covered:** H4.1 (auditable outputs vs. static model), H4.4 (typed-link attribution, < 5% false attribution rate).

**Notes:** Task selection for the 20-task sample: stratify across legal sub-domain (contract law, evidence, civil procedure) and task type (classification, extraction, entailment). Document the 20 tasks chosen in `docs/research/fixtures.md` before first run. Cadence: quarterly for regression; every attribution architecture change for H4.4.

---

### MIRAGE (Medical Information Retrieval-Augmented Generation Evaluation)

**What it measures:** RAG quality for medical QA — 7,663 questions drawn from MMLU-Med, MedQA-US, MedMCQA, PubMedQA, and BioASQ. Tests whether typed-link retrieval improves over flat-vector RAG in clinical reasoning.

**Nexum metric:** Accuracy (answer selection from multiple-choice; QA correctness).

**Hypotheses covered:** H4.1 (medical domain, auditable RAG outputs).

**Notes:** Use PubMed Central Open Access as the ingestion fixture. The `contradicts` link type (conflicting studies) is the primary typed-link signal targeted here. Baseline: best-performing RAG combination in the MIRAGE paper (RAG over BM25 + LLM). Nexum's typed-link graph should close the gap on clinical reasoning questions where conflicting evidence is present.

---

### MultiHop-RAG / HotpotQA Supporting Fact F1

**What it measures:** Multi-hop retrieval and reasoning — whether a system can answer questions that require chaining multiple supporting documents, and whether it correctly identifies which documents support each answer.

**Nexum metric:** Supporting Fact F1 (HotpotQA sentence-level provenance). Answer F1 is secondary; Supporting Fact F1 is the direct proxy for Nexum's attribution claim.

**Hypotheses covered:** H4.2 (multi-step compositional reasoning requires ≥ 3-hop graph traversal), H4.4 (attribution accuracy).

**Notes:** Run HotpotQA in Distractor setting (10 paragraphs) for controlled experiments; Full Wiki setting for scale claims. For H4.2: construct multi-hop question sets requiring 2, 3, 4, 5 hops through the Nexum link graph; measure accuracy as a function of hop count. MultiHop-RAG covers the same gap but uses a simpler corpus; use HotpotQA Supporting Fact F1 as the primary publication metric.

---

### CUAD Span F1 (Contract Understanding Atticus Dataset)

**What it measures:** Span-level contract clause extraction across 41 clause-type categories over 500+ expert-annotated contracts. Tests block-level precision — whether Nexum retrieves the exact clause span rather than full-document context.

**Nexum metric:** Span-level F1 (primary), span-level EM (secondary).

**Hypotheses covered:** H2.3 (structural vs. AI link layer signal for factual retrieval), H4.4 (attribution < 5% false attribution rate on legal clauses).

**Notes:** A synthesized block linking to a specific contract clause should outperform a model returning full-document context. This is the primary legal attribution benchmark. Baseline: fine-tuned transformer (CUAD paper's best model) and LlamaIndex citation RAG over the same documents.

---

### OGB ogbl-biokg MRR (Open Graph Benchmark — Biomedical KG Link Prediction)

**What it measures:** Link prediction quality on a heterogeneous biomedical knowledge graph with typed edge categories — the closest structural analogue to Nexum's typed-link graph. MRR (Mean Reciprocal Rank) measures whether the model ranks the correct missing link highest.

**Nexum metric:** MRR (primary), Hits@10 (secondary). Report both to match OGB leaderboard format.

**Hypotheses covered:** H7.1 (differentiable typed-link forward pass), H7.5 (ONNX Runtime throughput vs. live graph traversal).

**Notes:** ogbl-biokg's heterogeneous edge types map directly to Nexum's `cites / contradicts / supports / elaborates / is-exception-to` schema. Use as the GNN baseline environment before running on the Nexum graph. gHAWK (SOTA, December 2025) is the required comparison point. Run via PyTorch Geometric or DGL with the `pip install ogb` loader.

---

## Statistical Plan Template

Every hypothesis must complete this template before any experiment is staffed. An incomplete template is a gate — the experiment does not run.

```
Hypothesis: [H-ID, e.g. H1.1]
Dataset: [name + version, e.g. BEIR v1.0.1 / HotpotQA distractor setting]
Metric: [exact metric name + formula, e.g. NDCG@10 = sum((2^rel_i - 1) / log2(i+1)) / IDCG@10]
Baseline: [named system from prior-art list below, e.g. ColBERT-v2 on BEIR]
Sample size (n): [number of queries/documents; justify: why this n is sufficient for the
                  target effect size at the stated power]
Power: [target β, e.g. 0.8 — 80% probability of detecting a true effect of the stated size]
Effect size: [minimum detectable delta, e.g. +2 NDCG@10 points vs. BM25 baseline]
CI: [95% two-sided]
Compute budget: [GPU-hours + cost estimate at current cloud spot pricing]
Kill criterion spike: [smallest experiment, in days, that decides keep-or-drop before
                       committing to the full experiment]
Design partner question: [the question a paying customer would ask to validate this;
                          if blank, hypothesis is reclassified as exploratory and not staffed]
```

**Power analysis requirement:** For any hypothesis where the primary metric is continuous (NDCG@10, F1, accuracy), run a power analysis before the experiment. Specify: effect size δ (minimum detectable), standard deviation σ (from a pilot run or prior literature), desired power 1-β = 0.80, α = 0.05 two-sided. Compute n = 2σ²(z_{α/2} + z_β)² / δ². Document this in the template; do not proceed without it.

---

## Prior-Art Baseline List

Every experiment must name at least one baseline from this list. "We beat vanilla RAG" requires specifying which RAG system, on which benchmark, with which configuration.

### LlamaIndex (Default RAG Citation Mode)

**What it does:** Document ingestion → chunk-level embedding → semantic retrieval → LLM generation with source citation. The de facto reference implementation of production RAG.

**Applies to:** H3.1 (graph-resident inference vs. stale snapshot), H4.1 (auditable outputs), H4.4 (attribution accuracy), G2 (wedge demo — does Nexum provenance beat LlamaIndex citation?).

**Where to get it:** `pip install llama-index`. Use `CitationQueryEngine` with default chunk size 1024. Document the exact version used in each experiment (LlamaIndex releases frequently).

**Configuration for Nexum experiments:** Same underlying LLM (e.g., GPT-4o or Claude Sonnet) as the Nexum client; same corpus ingested; only the retrieval and attribution mechanism differs. This isolates the typed-link graph's contribution.

---

### Vespa (Typed Retrieval)

**What it does:** Production-grade retrieval platform with native support for typed fields, structured queries, ANN (HNSW), and tensor computation. The closest commercial system to Nexum's typed-link retrieval model.

**Applies to:** H1.1 (PostgreSQL vs. specialized retrieval DB at scale), H3.2 (latency floor for typed retrieval).

**Where to get it:** `pip install pyvespa`; Vespa Cloud free tier for experiments. Deploy a schema with equivalent typed fields to Nexum's link types.

**Configuration:** Match Nexum's block schema as closely as Vespa's type system allows. The comparison tests whether Postgres + pgvector is competitive with a purpose-built retrieval store at equivalent corpus scale.

---

### ColBERT-v2 (Late Interaction Retrieval)

**What it does:** Token-level late interaction retrieval — each query token interacts with each passage token at retrieval time. Significantly outperforms single-vector embedding retrieval on BEIR while remaining practical for production deployment.

**Applies to:** H1.2 (embedding quality vs. graph traversal quality on cross-type queries), H3.3 (sparse attention RAG outputs vs. static model), BEIR baseline (ColBERT-v2 is the standard neural retrieval BEIR reference point).

**Where to get it:** `pip install ragatouille` (easiest ColBERT-v2 wrapper) or `stanford-oval/colbert` GitHub.

**Configuration:** Index the same corpus used in the Nexum experiment. Run the identical query set. Report NDCG@10 side-by-side.

---

### RAPTOR (Hierarchical Summarization RAG)

**What it does:** Recursive abstractive processing — builds a tree of summaries over the document corpus at multiple granularities (chunk → section → document → cluster). Retrieval fetches from both leaf nodes and summary nodes, improving multi-hop reasoning over long documents.

**Applies to:** H3.3 (summarization tasks: does sparse attention RAG beat RAPTOR's hierarchical approach?), H4.2 (compositional reasoning: does graph traversal outperform hierarchical summarization?).

**Where to get it:** `pip install raptor` or reference implementation at `parthsarthi03/raptor`. Build the RAPTOR index on the same corpus used in the Nexum experiment.

**Configuration:** Use the same underlying LLM. The comparison isolates whether Nexum's explicit typed-link graph structure outperforms RAPTOR's implicit structure learned via summarization.

---

### GraphRAG (Microsoft, Graph-Based RAG)

**What it does:** Extracts entity and relationship graphs from documents (via LLM), builds community hierarchies, and uses graph-based retrieval for global and local queries. The closest published system to Nexum's graph-based retrieval.

**Applies to:** H4.2 (multi-step compositional reasoning), H4.4 (attribution accuracy — GraphRAG cites entity relationships; Nexum cites typed blocks).

**Where to get it:** `pip install graphrag`; Microsoft open-source. Run with default configuration, then with tuned configuration. Report both.

**Configuration:** Same corpus, same LLM, same question set. The key differentiator is GraphRAG's entity-graph vs. Nexum's typed-link block graph — and whether pre-defined typed links outperform LLM-extracted entity relations.

---

### MemGPT (Memory-Augmented Agent)

**What it does:** Hierarchical memory management for LLM agents — main context + external memory + archival storage. Simulates infinite context via paging. Relevant for long-document and multi-session retrieval tasks.

**Applies to:** H3.2 (latency floor: is Nexum's retrieval path competitive with MemGPT's context paging?), H4.2 (compositional reasoning: does graph traversal outperform hierarchical memory paging for multi-hop questions?).

**Where to get it:** `pip install letta` (MemGPT was rebranded to Letta). Use the default archival memory backend.

---

### BM25 (Retrieval Floor)

**What it does:** Sparse lexical retrieval — probabilistic TF-IDF variant. The mandatory floor baseline for any retrieval experiment. No neural or graph retrieval claim is credible without beating BM25 first.

**Applies to:** All retrieval hypotheses (H1.1, H1.2, H3.1, H3.2, H3.3, H4.2, H4.4).

**Where to get it:** `pip install rank-bm25` or Elasticsearch/OpenSearch BM25. For BEIR, use `beir.retrieval.search.lexical.BM25Search`.

**Configuration:** Do not tune BM25 parameters (k1, b) to the test corpus — use defaults. BM25 is the unsophisticated floor; beating it with tuned parameters is not a meaningful result.

---

### gHAWK (GNN SOTA, OGB December 2025)

**What it does:** Current SOTA graph neural network on the OGB leaderboard (December 2025). Represents the best published GNN performance on OGB tasks, including ogbl-biokg link prediction.

**Applies to:** H7.1 (differentiable typed-link forward pass), H7.5 (ONNX Runtime efficiency vs. live graph traversal).

**Where to get it:** OGB leaderboard at `ogb.stanford.edu/docs/leader_linkprop/`. Use the published checkpoint if available; otherwise re-implement from the paper. Document which gHAWK variant and checkpoint is used.

**Configuration:** Run on ogbl-biokg with the standard OGB evaluation protocol (MRR, Hits@10, Hits@20, Hits@50). Nexum's forward pass must be evaluated on the same protocol for the comparison to be valid.

---

## Null-Result Protocol

### When the program terminates or narrows:

**G2 fails (wedge demo):** If block-level provenance does not produce visibly better attribution accuracy than LlamaIndex citation RAG on a real partner corpus by Week 6 — and no design partners engage within four weeks of the demo — the program narrows immediately to pure systems research (Areas 1, 5, 6 only). Areas 2, 3, 4, 7 are shelved. No further staffing on curriculum, retrieval-inference, or frozen-export work until a paying customer asks for it.

**Failure definition for G2:** Attribution F1 on the held-out QA set is not statistically significantly higher for Nexum than for LlamaIndex citation mode (p < 0.05, two-sided), OR fewer than 2 design partners engage within 4 weeks of the demo. Either condition alone triggers the narrowing.

**G0 AND H2.1 both fail:** If the graph is not differentiable (G0 fails: loss does not decrease monotonically within 1K gradient steps on a 10K-block synthetic corpus) AND typed-link contrastive pairs do not improve fine-tuning over flat-corpus training (H2.1 fails: no statistically significant accuracy delta on clause extraction or contradiction detection at p < 0.05), then the typed link layer has no training signal — only retrieval value. The program narrows to: block-level provenance + real-time ingest + attribution (Areas 1, 3, 4, 5) as a pure retrieval product. The core research thesis — that typed links are a training curriculum — is falsified. This is a valid and publishable outcome; document it as a negative result.

**Failure definition for G0:** Training loss on the typed-link message-passing forward pass does not decrease monotonically within 1K gradient steps on the 10K-block synthetic corpus. "Monotonically" allows for plateau but not oscillation or divergence.

**Failure definition for H2.1:** The contrastive-pair fine-tuned model does not achieve a statistically significant accuracy improvement (p < 0.05, two-sided t-test) over the flat-corpus baseline on both clause extraction AND contradiction detection on the held-out legal evaluation set.

**G1 fails (Postgres scale):** P99 query latency exceeds 500ms at 5M blocks on the target hardware budget. Consequence: graph DB migration required (Kuzu or Neptune). Areas 3, 5, 6 are blocked until the storage question is resolved. G2 wedge demo can proceed on a reduced corpus (< 5M blocks) during the migration.

**G3 fails (typed-link gradient signal):** `contradicts` and `supports` edge weight vectors are not statistically significantly separated (p < 0.05, cosine distance between same-type vs. cross-type weight vectors) after training on the 100K-block legal corpus. Consequence: link types are dropped from the gradient training axis. The model reduces to standard GNN aggregation over untyped edges. Areas 2 and 7 continue with untyped edges only; the typed-link training claim is withdrawn.

**G4 fails (ONNX losslessness):** Accuracy delta between ONNX Runtime and live graph exceeds 1% on attribution F1 on the held-out eval set. Consequence: frozen export requires distillation (lossy); the "lossless serialization" product tier story changes. The frozen artifact is competitive but not equivalent to the live graph. Area 7 continues with a distillation framing.

---

## Compute Budget Template

For each experiment class, fill this template before requesting GPU allocation.

### Scale Benchmark (Area 1)

```
Corpus size: [1M / 5M / 20M / 100M blocks]
Storage estimate: [blocks × avg block size bytes × replication factor]
  - 1M blocks × 6KB avg × 3 (block + embedding + links) = ~18GB
  - 5M blocks: ~90GB
  - 20M blocks: ~360GB
  - 100M blocks: ~1.8TB
Query count: [minimum 1,000 queries per corpus scale per query mode]
Query modes: [semantic / full-text / graph traversal — run all three at each scale]
Wall-clock estimate: [benchmark tool + corpus size → query throughput estimate]
Hardware: [CPU/GPU SKU; RAM; NVMe vs. SSD storage class]
Parallelism: [number of parallel query workers]
Cost estimate: [cloud instance type × hours × spot price]
```

### Training Experiment (Areas 2, 7)

```
Model size: [parameter count, e.g. 7B for base LM; GNN parameter count for Area 7]
Dataset size: [number of training pairs / blocks / sequences]
Training steps: [total steps; justify relative to convergence criterion]
GPU SKU: [e.g. A100 80GB; H100 80GB]
GPU count: [single vs. multi-GPU; if multi, specify DDP/FSDP strategy]
Estimated GPU-hours: [steps × batch_size / throughput × GPU_count]
Cost estimate: [GPU-hours × spot price per GPU-hour]
Checkpoint cadence: [every N steps; how many checkpoints retained]
Evaluation cadence: [every N steps on held-out set]
Kill criterion: [if loss does not decrease by X within N steps, terminate and log]
```

### Latency Benchmark (Areas 3, 5, 6)

```
Hardware spec: [CPU model, RAM, GPU model, NVMe vs. SSD, network bandwidth]
Query count: [minimum 10,000 queries for P99 stability; 1,000 for P50]
Replication: [number of independent runs; report mean ± std across runs]
Warmup: [discard first N queries to allow cache warm-up; document N]
Percentiles reported: [P50, P95, P99 minimum; P999 for latency-sensitive claims]
Concurrency: [1 / 8 / 32 / 128 concurrent clients — report the full sweep]
Corpus size at test time: [must match the target deployment scale]
Cache state: [cold start vs. warmed cache — run both; report separately]
```

---

## Phase-0 Gate Verification Harness

Phase-0 contains four gate experiments (#73 G0, #74 G1, #4 H1.1, #3 G4)
that must emit comparable JSON artifacts. The shared seam is the
`experiments._lib` package, scouted by issue #77 and lives at
`experiments/_lib/`.

### Components

- `experiments/_lib/runner.py` — `capture_run_context(gate, hypothesis, seed,
  image_digest=None)` returns a `RunContext` with hardware profile,
  Python/torch versions, accelerator info, RAM, hostname, git SHA,
  Docker image digest, and an env-var allowlist snapshot.
- `experiments/_lib/results_writer.py` — `ResultEnvelope` dataclass plus
  `write_result(envelope, area_dir)` which writes
  `experiments/<area>/results/<gate>_<UTC-timestamp>.json` in the
  canonical envelope shape.
- `scripts/update-hypothesis-status.sh` — flips the YAML frontmatter
  `status` field of a hypothesis markdown file (e.g. `H1.1.md`) from
  `untested` to `passed` or `failed`, recording `last_tested` (UTC
  ISO-8601) and `results_path`. Idempotent: re-running with identical
  arguments produces a byte-identical file.

### Canonical envelope shape

```json
{
  "schema_version": 1,
  "gate": "G0|G1|G4|H1.1|...",
  "hypothesis": "H7.1",
  "pass": true,
  "metrics": { "...gate-specific metric block..." },
  "runtime": { "...RunContext.to_dict()..." },
  "results_path": "experiments/<area>/results/<gate>_<ts>.json",
  "notes": "optional",
  "extra": { }
}
```

### Conventions

- **RNG seed.** Each gate run carries a single integer seed, captured
  verbatim in `runtime.seed`. Gate experiments fan it out to
  `numpy.random.seed`, `torch.manual_seed`, `torch.cuda.manual_seed_all`,
  and `random.seed`.
- **Hardware profile.** `runtime.platform`, `runtime.cpu`, `runtime.ram_bytes`,
  `runtime.accelerator` capture the host. CPU-only smoke runs without
  torch are supported (the harness degrades to `device=cpu`).
- **Image digest.** `runtime.image_digest` should be the Docker image
  digest used for the run. Falls back to `$NEXUM_IMAGE_DIGEST` when not
  passed explicitly.
- **Env vars.** Only an allowlist of harness-relevant keys
  (`CUDA_VISIBLE_DEVICES`, `PYTHONHASHSEED`, `NEXUM_GATE`,
  `NEXUM_RUN_ID`, `NEXUM_IMAGE_DIGEST`) is captured into
  `runtime.env`. This avoids leaking secrets via result JSON.
- **Filenames.** `<gate>_<UTC-timestamp>.json` where the timestamp slug is
  `YYYYMMDDTHHMMSSZ`. Append-only — old files are not rewritten.
- **Schema version.** Top-level `schema_version` is `1`. Bump on
  breaking changes to the envelope and document the migration in
  `docs/research/queue.md`.

### CI smoke test

`experiments/_lib/tests/test_harness.py` runs a 100-block toy corpus
end-to-end through the harness (`capture_run_context` → `ResultEnvelope`
→ `write_result` → JSON round-trip) and asserts the existing
`experiments/g4-onnx-lossless/results/g4_result.json` legacy artifact
remains parseable. Run with:

```
python3 -m pytest experiments/_lib/tests/ -q
```

This test runs in the `experiments-harness` GitHub Actions job on every
push.
