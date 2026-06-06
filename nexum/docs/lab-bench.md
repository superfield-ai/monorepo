# Nexum — Lab Benchmarking Reference

This document specifies the standard benchmarks, corpora, and evaluation fixtures for the Nexum research program. It is organized by what Nexum is being measured on, not by benchmark origin. Every experiment in the research plan must name a baseline from this document before it is staffed.

---

## What We Are Measuring

Nexum has three differentiating claims:

1. **Typed-link retrieval** — block-level provenance, typed edges (`cites`, `contradicts`, `supports`, `elaborates`, `is-exception-to`), multi-hop graph traversal — produces higher-quality answers than vanilla RAG over the same corpus.
2. **Attribution fidelity** — every generated claim traces to specific source blocks, with < 5% false attribution rate. This is structurally impossible for dense transformer weights.
3. **Differentiable graph model** — the typed-link forward pass can be trained via backpropagation and exported losslessly to ONNX, producing a frozen artifact equivalent to the live graph.

Each benchmark below is labeled with which claim(s) it tests.

---

## Standard Benchmarks

### Retrieval and RAG — Claims 1, 2

#### BEIR (Benchmarking Information Retrieval)
- **Tests**: Zero-shot retrieval across 18 heterogeneous datasets (medical, legal, news, general)
- **Metric**: NDCG@10 (primary), Recall@k, MAP
- **Baselines**: BM25 (floor), NV-Embed-v2, Voyage 4 Large, Gemini Embedding 2 (67.71 NDCG@10 as of April 2026)
- **Download**: `pip install beir` / Hugging Face datasets
- **Use in Nexum**: Primary retrieval benchmark. Run against all three Nexum query modes (semantic, full-text, graph traversal) to establish whether typed-link graph traversal improves over embedding-only retrieval.
- **Key datasets within BEIR**: TREC-COVID, HotpotQA (multi-hop), FIQA (financial QA), DBPedia (entity retrieval)

#### MTEB (Massive Text Embedding Benchmark)
- **Tests**: 8 task categories (classification, clustering, retrieval, STS, bitext mining, pair classification, reranking, summarization) across 56+ datasets in 112 languages
- **Metric**: Task-specific — nDCG@10 (retrieval), accuracy (classification), v-measure (clustering)
- **Baselines**: Sentence-transformers family; Gemini Embedding 2 (April 2026 leader)
- **Install**: `pip install "mteb[leaderboard]"` (Python > 3.10)
- **Run**: Initialize MTEB with tasks; call `evaluation.run(model, output_folder)`; results as JSON
- **Use in Nexum**: Embedding quality benchmark for the block embedding model. Validates that our embedding choice (Area 1, H1.2) generalizes across domain types.

#### RAGBench
- **Tests**: RAG system evaluation across 5 industry domains (biomedicine, law, general, customer support, finance); 100K examples
- **Metric**: TRACe framework — Utilization, Relevance, Adherence, Completeness; also RoBERTa-based evaluator
- **Key finding**: Fine-tuned RoBERTa outperforms zero-shot LLM evaluation for RAG tasks
- **Use in Nexum**: Domain coverage baseline. Nexum's typed-link retrieval should outperform standard RAG on the legal and biomedical subsets where cross-document reasoning is required.

#### MultiHop-RAG
- **Tests**: Multi-hop query answering requiring retrieval and reasoning across multiple supporting documents
- **Metric**: Answer EM/F1, supporting evidence F1
- **Baseline**: Existing RAG systems have poor multi-hop performance — this is the gap Nexum's graph traversal targets
- **Use in Nexum**: Primary validation benchmark for graph traversal (Area 3, H4.2). Nexum's 3-hop+ traversal should close the gap that vanilla RAG cannot bridge.

#### HotpotQA
- **Tests**: Multi-hop reasoning over Wikipedia paragraphs; requires identifying supporting sentences
- **Metric**: Span-level EM/F1 (answers), Supporting Fact F1 (sentence-level provenance)
- **Baselines**: Dense retrievers + LLMs with chain-of-thought
- **Download**: `huggingface-cli download hotpotqa/hotpot_qa`
- **Size**: 113K Wikipedia-based QA pairs
- **Settings**: Distractor (10 paragraphs) and Full Wiki (5M+ Wikipedia paragraphs)
- **Use in Nexum**: Supporting Fact F1 is a direct proxy for Nexum's attribution claim (Claim 2). Nexum's `sourced-from` links should produce higher Supporting Fact F1 than vanilla RAG by providing explicit sentence-level provenance.

#### MuSiQue
- **Tests**: Multi-hop QA via single-hop question composition; harder than HotpotQA
- **Metric**: Exact Match (EM), token-level F1 for answers; paragraph-level EM/F1 for supporting paragraphs
- **Baselines**: SP-CoT (FSM-based prompting, ~38–41% F1); GPT-3.5 baseline ~3.1% EM zero-shot
- **Use in Nexum**: Upper-bound for multi-hop difficulty. If Nexum's graph traversal doesn't improve over CoT baselines on MuSiQue, the graph traversal mechanism needs revision.

#### FreshQA
- **Tests**: Time-sensitive retrieval on freshness-critical queries; answers change over time
- **Metric**: Accuracy on time-sensitive QA
- **Baselines**: Web search engines; Valyu (79%), Parallel (52%), Google (39%), Exa (24%) as of 2025
- **Download**: `github.com/freshllms/freshqa` (updated weekly)
- **Size**: 600 questions
- **Use in Nexum**: Validates the real-time ingest claim (Area 5, H5.1–H5.2). A frozen model will degrade on FreshQA; the live Nexum graph should not.

---

### Legal Domain — Claims 1, 2

#### CUAD (Contract Understanding Atticus Dataset)
- **Tests**: Contract review via span-selection QA over 41 clause type categories
- **Metric**: Span-level EM/F1
- **Baselines**: Fine-tuned transformers; performance varies strongly by model size and training
- **Download**: `atticusprojectai.org/cuad`
- **Size**: 500+ contracts, 13,000+ expert annotations from legal professionals
- **Use in Nexum**: Clause extraction is a direct test of Nexum's block-level precision (Claim 1). A synthesized block linking to the specific contract clause should outperform a model returning full-document context.

#### LEDGAR (LexGLUE)
- **Tests**: Contract provision (paragraph) classification — 12 principal topic categories
- **Metric**: Micro-F1, Macro-F1
- **Baselines**: Zero-shot LLM micro-F1/macro-F1 ~19.2/26.8% below domain fine-tuned models
- **Source**: SEC EDGAR Exhibit-10 contracts (publicly available)
- **Download**: `huggingface-cli download lex_glue`; Unitxt catalog: `unitxt.ai`
- **Size**: 846,274 annotated provisions from 60,540 contracts (2016–2019)
- **Use in Nexum**: Large-scale legal classification corpus. Doubles as a training fixture and an evaluation set for typed-link curriculum experiments (Area 2).

#### LegalBench
- **Tests**: 162 collaborative tasks covering legal reasoning in English — binary/multi-class classification, extraction, generation, entailment
- **Coverage**: Statutes, judicial opinions, contracts; 36 distinct legal corpora
- **Metric**: Task-specific accuracy, F1
- **Download**: `huggingface-cli download nguha/legalbench`; GitHub: `HazyResearch/legalbench`
- **Use in Nexum**: Broadest legal coverage. Use to validate that Nexum generalizes across legal sub-domains (contract law, evidence, civil procedure) rather than overfitting to CUAD's contract focus.

#### CourtListener Corpus
- **What it is**: Millions of US court opinions, 1754–present, from 406 of 423 jurisdictions
- **Access**: Free; bulk download API at `courtlistener.com/help/api/bulk-data/`
- **Use in Nexum**: Primary legal ingestion fixture for integration tests and the legal wedge demo (Gate G2). Ingest a subset of federal district court opinions as the partner corpus for the G2 demo. Source for LegalBench tasks.

---

### Biomedical Domain — Claims 1, 2

#### MIRAGE (Medical Information Retrieval-Augmented Generation Evaluation)
- **Tests**: RAG evaluation for medical QA — 7,663 questions from 5 medical QA datasets
- **Composition**: MMLU-Med, MedQA-US, MedMCQA (examination QA); PubMedQA, BioASQ (research QA)
- **Metric**: Accuracy over retrieval + LLM combinations
- **Baselines**: 41 combinations tested; RAG improves accuracy by up to 18% over chain-of-thought alone
- **Download**: `github.com/Teddy-XiongGZ/MIRAGE`
- **Use in Nexum**: Best benchmark for validating medical RAG. Nexum's typed-link graph (with `contradicts` links between conflicting studies) should outperform flat-vector RAG on clinical reasoning questions.

#### BioASQ (2025 Edition)
- **Tests**: Large-scale biomedical semantic indexing and QA; 83 competing teams, 1000+ submissions in 2025
- **Tasks (BioASQ 2025)**: Task B (semantic QA), Task Synergy13 (developing topics), MultiClinSum (multilingual clinical summarization), BioNNE-L (nested entity linking), ELCardioCC (clinical coding), GutBrainIE (information extraction)
- **Metric**: GMAP, MRR, ROUGE, P/R/F1; manual expert evaluation on selected submissions
- **Baselines**: Modern LLM + retriever combinations (Llama, Gemma, GPT, Claude, Mistral); BM25 + BGE-M3 dense retrievers
- **Download**: `participants-area.bioasq.org/datasets` (registration required)
- **Use in Nexum**: BioASQ's manual expert evaluation makes it the gold-standard for attribution auditing in the medical domain. Use Task B for standard QA; Synergy13 for freshness (since it covers developing research topics).

#### MIMIC-III
- **What it is**: 40,000+ critical care patients, 2001–2012; vital signs, lab results, provider notes, procedure codes, imaging reports
- **Access**: PhysioNet account + data use agreement + privacy training (required). AWS Open Data also available.
- **Download**: `physionet.org/content/mimiciii/1.4/`
- **Use in Nexum**: Clinical notes ingestion fixture for testing block parsing fidelity (product challenge: OCR, multi-section clinical documents). Do not use as a primary eval corpus without completing DUA.
- **Note**: Access is gated; plan 1–2 weeks for approval. Kaggle hosts a public subset for initial experiments.

---

### Knowledge Graph Tasks — Claims 1, 3

#### Open Graph Benchmark (OGB)
- **Tests**: Node property prediction (`ogbn-*`), link prediction (`ogbl-*`), graph property prediction (`ogbg-*`) at scale
- **KG-relevant datasets**:
  - `ogbl-biokg`: Heterogeneous biomedical KG (heterogeneous node/edge types — directly analogous to Nexum's typed links)
  - `ogbl-wikikg`: Wikidata KG (large-scale entity/relation triples)
- **Metric**: Task-specific — ROC-AUC, MRR, Hits@k for link prediction
- **Baselines**: gHAWK (SOTA, December 2025), GNN families (GCN, GAT, GraphSAGE, CompGCN)
- **Install**: `pip install ogb`; data loaders via PyTorch Geometric or DGL
- **Scale**: 100M+ nodes, 1B+ edges
- **Use in Nexum**: Primary GNN benchmark for the differentiable graph model (Area 7, H7.1–H7.3). `ogbl-biokg` is the closest structural analogue to Nexum's typed-link graph — heterogeneous edge types, link prediction as the task. Use as the baseline for evaluating whether Nexum's differentiable forward pass is competitive with SOTA GNNs.

#### WebQSP / ComplexWebQuestions / GrailQA
- **Tests**: SPARQL-based QA over Freebase knowledge graphs; ranging from single-hop (WebQSP) to complex multi-hop (CWQ, GrailQA)
- **Metric**: F1, accuracy on query execution
- **Baselines**: Semantic parsing models; LLM-based SPARQL generation
- **CWQ download**: `huggingface-cli download drt/complex_web_questions`; Size: 34,689 examples + 12.7M web snippets
- **GrailQA size**: 64,000 questions
- **Use in Nexum**: Compositional reasoning benchmark for Area 4 (H4.2: multi-step reasoning requires ≥ 3-hop graph traversal). Compare Nexum's graph traversal against SPARQL execution on the same questions. Nexum won't have Freebase; adapt by mapping CWQ entities to a Nexum-ingested Wikipedia corpus.

---

### Embedding Benchmarks — Internal Calibration

#### MTEB Retrieval Subset
- Described above under Retrieval. Use as the embedding quality calibration benchmark.
- Run periodically when changing the embedding model or dimensionality (Area 1, H1.2).

---

## Standard Corpora (Fixtures)

These are the corpora used for building synthetic Nexum deployments for experiments. They are not evaluation benchmarks — they are what gets ingested into the graph.

| Corpus | Domain | Size | Access | Primary Use |
|---|---|---|---|---|
| SEC EDGAR (Exhibit-10) | Legal | 60K+ contracts | Free, bulk API | LEDGAR training fixture; Area 2 curriculum |
| CourtListener | Legal | Millions of opinions | Free, bulk API | G2 wedge demo; legal integration tests |
| PubMed Central (PMC Open Access) | Biomedical | 4M+ articles | Free, OAI-PMH | MIRAGE/BioASQ ingestion fixture |
| Wikipedia dump | General | ~20M articles, ~4B tokens | Free, `dumps.wikimedia.org` | HotpotQA/MuSiQue ingestion; Area 1 scale tests |
| arXiv bulk | Scientific | 2M+ papers | Free, S3 bulk | Research domain ingestion fixture |
| RedPajama-V2 (filtered subset) | General web | 100T tokens (filter to domain) | Free, Hugging Face | Pretraining signal baseline; Area 2 flat-corpus baseline |
| MIMIC-III | Clinical | 40K patients | DUA required | Parsing fidelity stress test (complex clinical notes) |

### Synthetic Corpora (Constructed)

For scale experiments (Area 1, H1.1) where real corpus size is insufficient:

- **Scale fixture**: Generate synthetic block corpora at 1M / 5M / 20M / 100M blocks using Wikipedia + PubMed + EDGAR with controlled document-type mix (legal: 40%, biomedical: 30%, general: 30%). Document the generation procedure in `docs/research/fixtures.md`.
- **Version-delta fixture**: Take 10K contracts from EDGAR. Apply controlled edits (1–10% token substitution per document) to produce v1 and v2. Used for Area 5 (H5.4, embedding drift) and Area 7 (staleness curve).
- **Typed-link density fixture**: Take HotpotQA Wikipedia paragraphs. Ingest into Nexum. Vary AI-link confidence threshold (> 0.5, > 0.7, > 0.9) to produce corpora of different link densities. Used for Area 2 (H2.1) and Area 4 (H4.2).

---

## Recommended Standard Evaluation Suite

Run these benchmarks as the Nexum standard eval suite — the minimum set needed to make a release claim:

| Benchmark | Claim Tested | Cadence |
|---|---|---|
| BEIR (subset: TREC-COVID, HotpotQA, FIQA) | Claim 1: typed-link retrieval | Every research area milestone |
| HotpotQA Supporting Fact F1 | Claim 2: attribution fidelity | Every synthesis/attribution change |
| CUAD span F1 | Claim 1: block-level precision on legal | Every legal corpus release |
| MIRAGE accuracy | Claim 1: medical RAG | Every medical corpus release |
| OGB ogbl-biokg MRR | Claim 3: differentiable GNN | Every Area 7 experiment iteration |
| FreshQA accuracy | Claims 1+3: recency (live vs. frozen) | Area 5 and Area 7 experiments |
| LegalBench (sampled, 20 tasks) | Claim 1: legal generalization | Quarterly |

---

## Baselines to Cite in Every Experiment

Every experiment must name the specific system it is compared against. Acceptable baselines:

| Capability | Required Baseline |
|---|---|
| Retrieval | BM25 (floor), DPR, ColBERT-v2, LlamaIndex default RAG |
| Multi-hop reasoning | Chain-of-thought prompting on same LLM, RAPTOR |
| Attribution | Vanilla RAG with citation (LlamaIndex citation mode) |
| Knowledge graph inference | CompGCN, RotatE (for link prediction), GraphRAG (Microsoft) |
| Frozen export / distillation | Student model fine-tuned on flat corpus (no typed-link signal) |
| Embedding quality | `text-embedding-3-small` (OpenAI), `bge-m3` (BAAI) |

---

## Metrics Mapping to Research Areas

| Metric | Benchmark Source | Research Area | Nexum Claim |
|---|---|---|---|
| NDCG@10 | BEIR, MTEB | Areas 1, 3 | Claim 1 |
| Supporting Fact F1 | HotpotQA | Area 4 | Claim 2 |
| Attribution F1 (expert-labeled) | CUAD, LegalBench | Area 4 | Claim 2 |
| Answer accuracy | MIRAGE, BioASQ | Areas 3, 4 | Claims 1, 2 |
| Multi-hop accuracy by hop count | CWQ, GrailQA | Area 4 | Claim 1 |
| FreshQA accuracy (live vs. frozen) | FreshQA | Areas 5, 7 | Claims 1, 3 |
| MRR on link prediction | OGB ogbl-biokg | Area 7 | Claim 3 |
| ONNX vs. live graph accuracy delta | Internal (held-out) | Area 7 | Claim 3 |
| Query latency P50/P99 | Internal | Areas 1, 3, 6 | Infrastructure |
| Insertion-to-retrieval latency | Internal | Area 5 | Infrastructure |

---

## Access and Setup

```
# BEIR
pip install beir

# MTEB
pip install "mteb[leaderboard]"

# OGB (Open Graph Benchmark)
pip install ogb

# Hugging Face datasets (HotpotQA, LegalBench, CUAD, MuSiQue, CWQ)
pip install datasets
huggingface-cli download hotpotqa/hotpot_qa
huggingface-cli download nguha/legalbench
huggingface-cli download drt/complex_web_questions
huggingface-cli download allenai/musique

# CourtListener bulk data
curl https://www.courtlistener.com/help/api/bulk-data/

# SEC EDGAR (Exhibit-10 contracts — LEDGAR source)
curl https://efts.sec.gov/LATEST/search-index?q=%22EX-10%22&dateRange=custom&startdt=2016-01-01&enddt=2019-12-31

# Wikipedia dumps
wget https://dumps.wikimedia.org/enwiki/latest/enwiki-latest-pages-articles.xml.bz2

# PubMed Central Open Access
curl https://ftp.ncbi.nlm.nih.gov/pub/pmc/oa_bulk/

# MIMIC-III (requires DUA)
# Register at physionet.org, complete training, then:
# wget -r -N -c -np --user <username> --ask-password https://physionet.org/files/mimiciii/1.4/
```

---

## Related Documents

- `docs/research.md` — research areas, hypotheses, Bayesian sequencing plan
- `docs/research/methodology.md` *(forthcoming)* — statistical plan templates, power analysis requirements, null-result protocol
- `docs/research/queue.md` *(forthcoming)* — curated hypothesis priority queue
- `docs/research/fixtures.md` *(forthcoming)* — synthetic corpus generation procedures and dataset checksums
