#!/usr/bin/env bash
# Run the Nexum standard evaluation suite.
#
# Usage:
#   ./run_suite.sh [OPTIONS]
#
# Options:
#   --nexum-url URL         Nexum API base URL (default: http://localhost:3000)
#   --output DIR            Results directory (default: results/run-<timestamp>)
#   --max-questions N       Cap for per-eval question limits (default: 500)
#   --include-freshqa       Also run FreshQA time-sensitive QA eval
#   --include-legalbench    Also run LegalBench 20-task eval (requires --include-freshqa
#                           or runs independently)
#   --include-ogb           Also run OGB ogbl-biokg link-prediction eval
#   --ingest-ogb            Pass --ingest to OGB eval (builds Nexum corpus from scratch)
#   --ogb-corpus-id ID      Reuse an existing OGB corpus instead of ingesting
#   --legalbench-tasks LIST  Comma-separated LegalBench task names or "default20"
#                            (default: default20)
#   --max-ogb-edges N       Number of OGB test edges to evaluate (default: 1000)
#
# Standard evals (always run):
#   1. BEIR subset (trec-covid, hotpotqa, fiqa) — NDCG@10
#   2. HotpotQA Supporting Fact F1 — attribution proxy
#   3. CUAD span F1 — legal clause extraction
#
# Optional evals:
#   4. FreshQA exact-match accuracy — time-sensitive questions
#   5. LegalBench macro accuracy — 20-task legal reasoning sample
#   6. OGB ogbl-biokg — typed link-prediction MRR / Hits@{1,3,10}
#
# Results written to $OUTPUT_DIR/{beir,hotpotqa,cuad,freshqa,legalbench,ogb}/

set -euo pipefail

NEXUM_URL="${NEXUM_URL:-http://localhost:3000}"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
OUTPUT_DIR="${OUTPUT_DIR:-results/run-$TIMESTAMP}"
MAX_QUESTIONS="${MAX_QUESTIONS:-500}"
MAX_OGB_EDGES="${MAX_OGB_EDGES:-1000}"
LEGALBENCH_TASKS="${LEGALBENCH_TASKS:-default20}"

INCLUDE_FRESHQA=false
INCLUDE_LEGALBENCH=false
INCLUDE_OGB=false
INGEST_OGB=false
OGB_CORPUS_ID=""

# Parse flags
while [[ $# -gt 0 ]]; do
  case $1 in
    --nexum-url)          NEXUM_URL="$2"; shift 2 ;;
    --output)             OUTPUT_DIR="$2"; shift 2 ;;
    --max-questions)      MAX_QUESTIONS="$2"; shift 2 ;;
    --include-freshqa)    INCLUDE_FRESHQA=true; shift ;;
    --include-legalbench) INCLUDE_LEGALBENCH=true; shift ;;
    --include-ogb)        INCLUDE_OGB=true; shift ;;
    --ingest-ogb)         INGEST_OGB=true; shift ;;
    --ogb-corpus-id)      OGB_CORPUS_ID="$2"; shift 2 ;;
    --legalbench-tasks)   LEGALBENCH_TASKS="$2"; shift 2 ;;
    --max-ogb-edges)      MAX_OGB_EDGES="$2"; shift 2 ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

mkdir -p "$OUTPUT_DIR"
echo "Nexum lab-bench suite"
echo "  Nexum:         $NEXUM_URL"
echo "  Output:        $OUTPUT_DIR"
echo "  Time:          $TIMESTAMP"
echo "  FreshQA:       $INCLUDE_FRESHQA"
echo "  LegalBench:    $INCLUDE_LEGALBENCH"
echo "  OGB biokg:     $INCLUDE_OGB"
echo ""

# -------------------------------------------------------------------------
# 1. Fetch fixtures (idempotent — skips if data already present)
# -------------------------------------------------------------------------
echo "=== Fixtures ==="
if [[ ! -f data/cuad/contracts.jsonl ]]; then
  echo "Downloading CUAD…"
  python fixtures/cuad.py --output-dir data/cuad
else
  echo "CUAD already present."
fi

if [[ ! -f data/hotpotqa/questions.jsonl ]]; then
  echo "Downloading HotpotQA (distractor split)…"
  python fixtures/hotpotqa.py --output-dir data/hotpotqa --split distractor
else
  echo "HotpotQA already present."
fi

echo ""

# -------------------------------------------------------------------------
# 2. BEIR subset
# -------------------------------------------------------------------------
echo "=== BEIR (trec-covid, hotpotqa, fiqa) ==="
python eval/beir_eval.py \
  --nexum-url "$NEXUM_URL" \
  --datasets trec-covid hotpotqa fiqa \
  --query-mode semantic \
  --output "$OUTPUT_DIR/beir"
echo ""

# -------------------------------------------------------------------------
# 3. HotpotQA Supporting Fact F1
# -------------------------------------------------------------------------
echo "=== HotpotQA Supporting Fact F1 ==="
python eval/hotpotqa_eval.py \
  --nexum-url "$NEXUM_URL" \
  --questions data/hotpotqa/questions.jsonl \
  --corpus data/hotpotqa/corpus.jsonl \
  --max-questions "$MAX_QUESTIONS" \
  --output "$OUTPUT_DIR/hotpotqa"
echo ""

# -------------------------------------------------------------------------
# 4. CUAD span F1
# -------------------------------------------------------------------------
echo "=== CUAD span F1 ==="
python eval/cuad_eval.py \
  --nexum-url "$NEXUM_URL" \
  --contracts data/cuad/contracts.jsonl \
  --qa data/cuad/qa.jsonl \
  --max-questions "$MAX_QUESTIONS" \
  --output "$OUTPUT_DIR/cuad"
echo ""

# -------------------------------------------------------------------------
# 5. FreshQA (optional)
# -------------------------------------------------------------------------
if [[ "$INCLUDE_FRESHQA" == "true" ]]; then
  echo "=== FreshQA time-sensitive QA ==="
  python eval/freshqa_eval.py \
    --nexum-url "$NEXUM_URL" \
    --max-questions "$MAX_QUESTIONS" \
    --output "$OUTPUT_DIR/freshqa"
  echo ""
fi

# -------------------------------------------------------------------------
# 6. LegalBench (optional)
# -------------------------------------------------------------------------
if [[ "$INCLUDE_LEGALBENCH" == "true" ]]; then
  echo "=== LegalBench 20-task eval ==="
  python eval/legalbench_eval.py \
    --nexum-url "$NEXUM_URL" \
    --tasks "$LEGALBENCH_TASKS" \
    --output "$OUTPUT_DIR/legalbench"
  echo ""
fi

# -------------------------------------------------------------------------
# 7. OGB ogbl-biokg link prediction (optional — heavy; requires OGB install)
# -------------------------------------------------------------------------
if [[ "$INCLUDE_OGB" == "true" ]]; then
  echo "=== OGB ogbl-biokg link prediction ==="
  OGB_ARGS=(
    --nexum-url "$NEXUM_URL"
    --max-test-edges "$MAX_OGB_EDGES"
    --output "$OUTPUT_DIR/ogb"
  )
  if [[ "$INGEST_OGB" == "true" ]]; then
    OGB_ARGS+=(--ingest)
  elif [[ -n "$OGB_CORPUS_ID" ]]; then
    OGB_ARGS+=(--corpus-id "$OGB_CORPUS_ID")
  fi
  python eval/ogb_eval.py "${OGB_ARGS[@]}"
  echo ""
fi

# -------------------------------------------------------------------------
# Summary
# -------------------------------------------------------------------------
INCLUDE_FRESHQA_PY=$( [[ "$INCLUDE_FRESHQA" == "true" ]] && echo "True" || echo "False" )
INCLUDE_LEGALBENCH_PY=$( [[ "$INCLUDE_LEGALBENCH" == "true" ]] && echo "True" || echo "False" )
INCLUDE_OGB_PY=$( [[ "$INCLUDE_OGB" == "true" ]] && echo "True" || echo "False" )

OUTPUT_DIR="$OUTPUT_DIR" \
INCLUDE_FRESHQA="$INCLUDE_FRESHQA_PY" \
INCLUDE_LEGALBENCH="$INCLUDE_LEGALBENCH_PY" \
INCLUDE_OGB="$INCLUDE_OGB_PY" \
python - <<'PYEOF'
import json, pathlib, os

out = os.environ.get("OUTPUT_DIR", "results")
include_freshqa = os.environ.get("INCLUDE_FRESHQA", "False") == "True"
include_legalbench = os.environ.get("INCLUDE_LEGALBENCH", "False") == "True"
include_ogb = os.environ.get("INCLUDE_OGB", "False") == "True"
lines = []

beir_summary = pathlib.Path(out) / "beir" / "summary.json"
if beir_summary.exists():
    d = json.loads(beir_summary.read_text())
    lines.append(f"BEIR mean NDCG@10: {d['mean_ndcg@10']:.4f}")
    for name, r in d.get("datasets", {}).items():
        lines.append(f"  {name}: NDCG@10={r['ndcg@10']:.4f}  Recall@100={r['recall@100']:.4f}")

hp_summary = pathlib.Path(out) / "hotpotqa" / "hotpotqa_summary.json"
if hp_summary.exists():
    d = json.loads(hp_summary.read_text())
    lines.append(f"HotpotQA  Answer F1: {d['answer_f1']:.4f}  Supporting Fact F1: {d['supporting_fact_f1']:.4f}")

cuad_summary = pathlib.Path(out) / "cuad" / "cuad_summary.json"
if cuad_summary.exists():
    d = json.loads(cuad_summary.read_text())
    lines.append(f"CUAD      Mean F1: {d['mean_f1']:.4f}  Has-answer accuracy: {d['has_answer_accuracy']:.4f}")

if include_freshqa:
    fq_summary = pathlib.Path(out) / "freshqa" / "freshqa_summary.json"
    if fq_summary.exists():
        d = json.loads(fq_summary.read_text())
        lines.append(
            f"FreshQA   Accuracy: {d['accuracy']:.4f}  "
            f"Changed-answer accuracy: {d['accuracy_on_changed_answers']:.4f}  "
            f"(n={d['n_questions']})"
        )
        for qtype, acc in d.get("accuracy_by_type", {}).items():
            lines.append(f"  {qtype}: {acc:.4f}")

if include_legalbench:
    lb_summary = pathlib.Path(out) / "legalbench" / "legalbench_summary.json"
    if lb_summary.exists():
        d = json.loads(lb_summary.read_text())
        lines.append(
            f"LegalBench Macro accuracy: {d['macro_accuracy']:.4f}  "
            f"({d['n_tasks_ok']}/{d['n_tasks']} tasks)"
        )
        for task, acc in d.get("per_task_accuracy", {}).items():
            if acc == acc:  # skip NaN
                lines.append(f"  {task}: {acc:.4f}")

if include_ogb:
    ogb_summary = pathlib.Path(out) / "ogb" / "ogb_summary.json"
    if ogb_summary.exists():
        d = json.loads(ogb_summary.read_text())
        lines.append(
            f"OGB biokg  MRR: {d['mrr']:.4f}  "
            f"Hits@1: {d['hits@1']:.4f}  "
            f"Hits@3: {d['hits@3']:.4f}  "
            f"Hits@10: {d['hits@10']:.4f}  "
            f"(gHAWK baseline MRR: {d['ghawk_baseline_mrr']:.3f})"
        )

print("\n=== Results ===")
print("\n".join(lines))
summary_path = pathlib.Path(out) / "suite_summary.txt"
summary_path.write_text("\n".join(lines) + "\n")
print(f"\nSummary written to {summary_path}")
PYEOF
