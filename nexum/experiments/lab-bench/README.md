# Nexum Lab Bench

Evaluation harness for the Nexum research program. Runs standard benchmarks against a live Nexum instance and reports the metrics defined in `docs/lab-bench.md`.

## Prerequisites

- Python ≥ 3.10
- A running Nexum API (default: `http://localhost:3000`)

## Setup

```bash
cd experiments/lab-bench

# Create a virtual environment
python -m venv .venv
source .venv/bin/activate

# Install dependencies
pip install -e .
```

## Running the standard suite

```bash
# Start Nexum (from repo root)
npm run dev &

# Run the full standard eval suite
./run_suite.sh

# With a non-default Nexum URL
NEXUM_URL=http://my-nexum-host:3000 ./run_suite.sh

# Smaller run for development (100 questions instead of 500)
MAX_QUESTIONS=100 ./run_suite.sh --output results/dev-run
```

Results are written to `results/run-<timestamp>/`:
```
results/run-20260501-120000/
├── suite_summary.txt       ← human-readable summary
├── beir/
│   ├── summary.json        ← mean NDCG@10 across datasets
│   ├── trec-covid.json
│   ├── hotpotqa.json
│   └── fiqa.json
├── hotpotqa/
│   ├── hotpotqa_summary.json  ← Answer F1, Supporting Fact F1
│   └── hotpotqa_detail.jsonl
└── cuad/
    ├── cuad_summary.json   ← Mean F1, has-answer accuracy
    └── cuad_detail.jsonl
```

## Individual benchmarks

### BEIR retrieval
```bash
python eval/beir_eval.py \
  --nexum-url http://localhost:3000 \
  --datasets trec-covid hotpotqa fiqa dbpedia-entity nfcorpus \
  --query-mode semantic \
  --output results/beir
```

### HotpotQA Supporting Fact F1
```bash
# Download fixture first
python fixtures/hotpotqa.py --output-dir data/hotpotqa

# Run eval
python eval/hotpotqa_eval.py \
  --questions data/hotpotqa/questions.jsonl \
  --corpus data/hotpotqa/corpus.jsonl \
  --max-questions 500
```

### CUAD span F1
```bash
# Download fixture
python fixtures/cuad.py --output-dir data/cuad

# Run eval
python eval/cuad_eval.py \
  --contracts data/cuad/contracts.jsonl \
  --qa data/cuad/qa.jsonl \
  --max-questions 1000
```

## Corpus fixtures

Download and prepare corpora for ingestion:

```bash
python fixtures/cuad.py        # CUAD — 500 contracts, 13K annotations
python fixtures/hotpotqa.py    # HotpotQA Wikipedia paragraphs
python fixtures/ledgar.py      # LEDGAR — 846K legal provisions
python fixtures/synthetic.py --size 1m   # 1M synthetic blocks (scale test)
python fixtures/synthetic.py --size 5m   # 5M blocks
```

## Standard baselines

Every result should be compared against these baselines (as documented in `docs/lab-bench.md`):

| Capability | Required baseline |
|---|---|
| Retrieval | BM25 (via BEIR's default), ColBERT-v2 |
| Multi-hop QA | Chain-of-thought on same LLM |
| Clause extraction | Fine-tuned BERT on CUAD |

## Directory structure

```
experiments/lab-bench/
├── adapters/
│   ├── nexum_retriever.py   # BEIR-compatible retriever over Nexum API
│   └── nexum_embedder.py    # MTEB embedder wrapper (forthcoming)
├── eval/
│   ├── beir_eval.py         # BEIR NDCG@10 evaluation
│   ├── hotpotqa_eval.py     # Supporting Fact F1
│   └── cuad_eval.py         # Span F1 for contract clauses
├── fixtures/
│   ├── cuad.py              # CUAD download + JSONL emit
│   ├── hotpotqa.py          # HotpotQA download + JSONL emit
│   ├── ledgar.py            # LEDGAR download + JSONL emit
│   └── synthetic.py         # Synthetic block corpus generator
├── results/                 # gitignored (except .gitkeep)
├── pyproject.toml
├── run_suite.sh             # Standard suite runner
└── README.md
```

## Adding a new benchmark

1. Add a fixture script in `fixtures/` that emits JSONL (one doc per line: `{id, title, text, ...}`)
2. Add an eval script in `eval/` that ingests via the Nexum API and computes the target metric
3. Add the benchmark to `run_suite.sh`
4. Document the required baseline in `docs/lab-bench.md`
