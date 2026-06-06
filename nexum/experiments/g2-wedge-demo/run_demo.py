"""
G2 wedge demo runner.

Compares Nexum typed-link RAG against vanilla LlamaIndex RAG on the same
CUAD contract corpus, measuring attribution F1 on both.

Usage
-----
    python run_demo.py \\
        --nexum-url http://localhost:3000 \\
        --anthropic-key $ANTHROPIC_API_KEY \\
        --max-contracts 50 \\
        --max-questions 50 \\
        --output results/g2_result.json

Add ``--dry-run`` to skip all LLM calls and Nexum requests (useful for CI).
"""

from __future__ import annotations

import argparse
import json
import logging
import statistics
import sys
from pathlib import Path

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
)
logger = logging.getLogger("g2_demo")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _mean(values: list[float]) -> float:
    return statistics.mean(values) if values else 0.0


def _dry_run_result(n_questions: int, output_path: Path) -> None:
    """Emit a structurally-correct result JSON without any real computation."""
    result = {
        "nexum": {
            "attribution_f1": 0.0,
            "false_attribution_rate": 0.0,
            "mean_answer_length": 0,
        },
        "vanilla_rag": {
            "attribution_f1": 0.0,
            "false_attribution_rate": 0.0,
            "mean_answer_length": 0,
        },
        "delta_attribution_f1": 0.0,
        "g2_signal": "inconclusive",
        "n_questions": n_questions,
        "per_question": [],
        "dry_run": True,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, indent=2))
    print("[DRY RUN] G2 INCONCLUSIVE (no real evaluation performed)")
    print(f"Wrote dry-run result to {output_path}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def run(
    nexum_url: str,
    anthropic_key: str,
    max_contracts: int,
    max_questions: int,
    output_path: Path,
    dry_run: bool = False,
    cuad_contracts_path: str | None = None,
    cuad_qa_path: str | None = None,
) -> dict:
    from corpus import load_demo_corpus, load_eval_questions

    # ------------------------------------------------------------------
    # Corpus loading
    # ------------------------------------------------------------------
    contracts_path = cuad_contracts_path or "../../experiments/lab-bench/data/cuad/contracts.jsonl"
    qa_path = cuad_qa_path or "../../experiments/lab-bench/data/cuad/qa.jsonl"

    contracts = load_demo_corpus(contracts_path, max_contracts=max_contracts)
    questions = load_eval_questions(qa_path, max_questions=max_questions)

    logger.info(
        "Loaded %d contracts and %d evaluation questions.",
        len(contracts),
        len(questions),
    )

    if dry_run:
        _dry_run_result(len(questions), output_path)
        return json.loads(output_path.read_text())

    # ------------------------------------------------------------------
    # Initialise RAG systems
    # ------------------------------------------------------------------
    from attribution_eval import attribution_f1
    from nexum_rag import NexumRAG
    from vanilla_rag import VanillaRAG

    nexum = NexumRAG(nexum_url=nexum_url, anthropic_api_key=anthropic_key)
    vanilla = VanillaRAG(anthropic_api_key=anthropic_key)

    logger.info("Ingesting corpus into Nexum…")
    nexum.ingest(contracts)

    logger.info("Ingesting corpus into VanillaRAG…")
    vanilla.ingest(contracts)

    # ------------------------------------------------------------------
    # Evaluation loop
    # ------------------------------------------------------------------
    per_question = []

    for q in questions:
        question_text = q["question"]
        gold_span = q["gold_span"]
        gold_doc_id = q["contract_id"]

        nexum_resp = nexum.query(question_text, top_k=5)
        vanilla_resp = vanilla.query(question_text, top_k=5)

        nexum_f1 = attribution_f1(
            nexum_resp["citations"], gold_span, gold_doc_id
        )
        vanilla_f1 = attribution_f1(
            vanilla_resp["citations"], gold_span, gold_doc_id
        )

        per_question.append(
            {
                "question_id": q["id"],
                "question": question_text,
                "gold_doc_id": gold_doc_id,
                "nexum": {
                    "answer": nexum_resp["answer"],
                    "answer_length": len(nexum_resp["answer"]),
                    "is_mock": nexum_resp.get("is_mock", False),
                    **nexum_f1,
                },
                "vanilla_rag": {
                    "answer": vanilla_resp["answer"],
                    "answer_length": len(vanilla_resp["answer"]),
                    **vanilla_f1,
                },
            }
        )

    # ------------------------------------------------------------------
    # Aggregate
    # ------------------------------------------------------------------
    nexum_f1_scores = [r["nexum"]["f1"] for r in per_question]
    vanilla_f1_scores = [r["vanilla_rag"]["f1"] for r in per_question]
    nexum_far = [r["nexum"]["false_attribution_rate"] for r in per_question]
    vanilla_far = [r["vanilla_rag"]["false_attribution_rate"] for r in per_question]
    nexum_lengths = [r["nexum"]["answer_length"] for r in per_question]
    vanilla_lengths = [r["vanilla_rag"]["answer_length"] for r in per_question]

    mean_nexum_f1 = _mean(nexum_f1_scores)
    mean_vanilla_f1 = _mean(vanilla_f1_scores)
    delta = mean_nexum_f1 - mean_vanilla_f1

    # G2 pass criterion: Nexum attribution F1 > Vanilla by > 5 percentage points
    if delta > 0.05:
        g2_signal = "pass"
    elif delta < -0.05:
        g2_signal = "fail"
    else:
        g2_signal = "inconclusive"

    result = {
        "nexum": {
            "attribution_f1": round(mean_nexum_f1, 4),
            "false_attribution_rate": round(_mean(nexum_far), 4),
            "mean_answer_length": round(_mean(nexum_lengths)),
        },
        "vanilla_rag": {
            "attribution_f1": round(mean_vanilla_f1, 4),
            "false_attribution_rate": round(_mean(vanilla_far), 4),
            "mean_answer_length": round(_mean(vanilla_lengths)),
        },
        "delta_attribution_f1": round(delta, 4),
        "g2_signal": g2_signal,
        "n_questions": len(per_question),
        "per_question": per_question,
    }

    # ------------------------------------------------------------------
    # Output
    # ------------------------------------------------------------------
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, indent=2))

    print("\n" + "=" * 60)
    print("G2 WEDGE DEMO — RESULTS")
    print("=" * 60)
    print(f"  Questions evaluated : {result['n_questions']}")
    print(f"  Nexum   attribution F1 : {result['nexum']['attribution_f1']:.4f}")
    print(f"  Vanilla attribution F1 : {result['vanilla_rag']['attribution_f1']:.4f}")
    print(f"  Delta (Nexum − Vanilla): {result['delta_attribution_f1']:+.4f}")
    print(f"  Nexum   false attribution rate: {result['nexum']['false_attribution_rate']:.4f}")
    print(f"  Vanilla false attribution rate: {result['vanilla_rag']['false_attribution_rate']:.4f}")
    print("=" * 60)

    if g2_signal == "pass":
        print("G2 PASS — Nexum attribution F1 exceeds Vanilla RAG by > 5pp.")
    else:
        print("G2 INCONCLUSIVE — Delta is within ±5pp; no clear winner.")

    print(f"\nFull results written to: {output_path}")
    return result


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="G2 wedge demo: Nexum provenance vs. vanilla RAG attribution F1."
    )
    parser.add_argument(
        "--nexum-url",
        default="http://localhost:3000",
        help="Base URL of the Nexum API server.",
    )
    parser.add_argument(
        "--anthropic-key",
        default="",
        help="Anthropic API key (or set ANTHROPIC_API_KEY env var).",
    )
    parser.add_argument(
        "--max-contracts",
        type=int,
        default=50,
        help="Maximum number of CUAD contracts to ingest.",
    )
    parser.add_argument(
        "--max-questions",
        type=int,
        default=50,
        help="Maximum number of QA pairs to evaluate.",
    )
    parser.add_argument(
        "--output",
        default="results/g2_result.json",
        help="Output JSON path for results.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Skip all LLM calls and Nexum requests; emit a valid result skeleton.",
    )
    parser.add_argument(
        "--cuad-contracts",
        default=None,
        help="Override path to CUAD contracts JSONL.",
    )
    parser.add_argument(
        "--cuad-qa",
        default=None,
        help="Override path to CUAD QA JSONL.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    args = _parse_args(argv)

    import os

    api_key = args.anthropic_key or os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key and not args.dry_run:
        print("ERROR: --anthropic-key or ANTHROPIC_API_KEY is required.", file=sys.stderr)
        sys.exit(1)

    run(
        nexum_url=args.nexum_url,
        anthropic_key=api_key,
        max_contracts=args.max_contracts,
        max_questions=args.max_questions,
        output_path=Path(args.output),
        dry_run=args.dry_run,
        cuad_contracts_path=args.cuad_contracts,
        cuad_qa_path=args.cuad_qa,
    )


if __name__ == "__main__":
    main()
