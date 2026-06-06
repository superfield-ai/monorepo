"""
run_area3.py — Orchestrator CLI for Area 3 experiments.

Runs the latency benchmark (H3.2), optional recency test (H3.1), and
sparse attention ablation (H3.3) and writes results to a JSON file.

Usage
-----
    python run_area3.py \\
        --nexum-url http://localhost:3000 \\
        --anthropic-key $ANTHROPIC_API_KEY \\
        --skip-recency-test \\
        --max-questions 50 \\
        --output results/area3_results.json
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Synthetic eval questions (used when no external dataset is provided)
# ---------------------------------------------------------------------------

_SYNTHETIC_QUESTIONS = [
    {
        "question": "What are the key provisions of a standard non-disclosure agreement?",
        "gold_answer": "confidentiality",
    },
    {
        "question": "How does a force majeure clause affect contract obligations?",
        "gold_answer": "unforeseeable events",
    },
    {
        "question": "What constitutes a material breach of contract?",
        "gold_answer": "breach",
    },
    {
        "question": "What is the difference between indemnification and limitation of liability?",
        "gold_answer": "indemnification",
    },
    {
        "question": "When does an arbitration clause preclude court litigation?",
        "gold_answer": "arbitration",
    },
    {
        "question": "What are the requirements for a valid consideration in contract law?",
        "gold_answer": "consideration",
    },
    {
        "question": "How are liquidated damages clauses enforced?",
        "gold_answer": "damages",
    },
    {
        "question": "What disclosures are required in a merger agreement?",
        "gold_answer": "disclosure",
    },
]

_SYNTHETIC_CORPUS = [
    {
        "block_id": f"synth-block-{i:04d}",
        "text": f"Synthetic corpus block {i}: contract law provision relating to clause {i}.",
    }
    for i in range(20)
]

_SYNTHETIC_AMENDMENTS = [
    {
        "block_id": "amendment-0001",
        "text": "Amendment: The force majeure clause now includes pandemic events as of 2024.",
        "metadata": {"amendment_date": "2024-01-01"},
    },
    {
        "block_id": "amendment-0002",
        "text": "Amendment: Liquidated damages cap is raised to 150% of contract value.",
        "metadata": {"amendment_date": "2024-03-15"},
    },
]

_SYNTHETIC_RECENCY_QUESTIONS = [
    {
        "question": "Does the force majeure clause cover pandemic events?",
        "gold_answer": "pandemic",
        "requires_amendment": True,
    },
    {
        "question": "What is the liquidated damages cap?",
        "gold_answer": "150%",
        "requires_amendment": True,
    },
]


# ---------------------------------------------------------------------------
# Main run function (also callable from tests)
# ---------------------------------------------------------------------------


def run(
    nexum_url: str,
    anthropic_key: str | None,
    skip_recency_test: bool = False,
    max_questions: int = 50,
    output_path: Path | str = "results/area3_results.json",
    k_values: list[int] | None = None,
    n_latency_reps: int = 5,
    dry_run: bool = False,
) -> dict:
    """Run all Area 3 experiments and return the combined results dict.

    Parameters
    ----------
    nexum_url:
        URL of the running Nexum instance.
    anthropic_key:
        Anthropic API key (may be None for offline/dry-run).
    skip_recency_test:
        Skip H3.1 (requires a corpus with known amendments).
    max_questions:
        Cap on number of eval questions per experiment.
    output_path:
        Where to write the JSON results file.
    k_values:
        k values for latency benchmark and ablation sweep.
    n_latency_reps:
        Repetitions per (query, k) pair for the latency benchmark.
    dry_run:
        If True, skip all live calls and return a stub result.
    """
    from graph_inference_client import GraphInferenceClient
    from latency_benchmark import run_latency_benchmark
    from sparse_attention_ablation import run_sparse_attention_ablation

    if k_values is None:
        k_values = [1, 5, 10, 50, 100]

    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    client = GraphInferenceClient(nexum_url=nexum_url, anthropic_key=anthropic_key)
    eval_questions = _SYNTHETIC_QUESTIONS[:max_questions]

    # ------------------------------------------------------------------
    # Dry run — return a stub so that tests verify the output structure
    # without any live calls.
    # ------------------------------------------------------------------
    if dry_run:
        stub: dict = {
            "dry_run": True,
            "nexum_url": nexum_url,
            "n_questions": len(eval_questions),
            "k_values": k_values,
            "latency_benchmark": {k: {
                "p50_total_ms": 0.0,
                "p99_total_ms": 0.0,
                "p50_retrieval_ms": 0.0,
                "p99_retrieval_ms": 0.0,
                "p50_generation_ms": 0.0,
                "p99_generation_ms": 0.0,
                "mean_total_ms": 0.0,
                "tokens_per_sec_estimate": 0.0,
                "n_samples": 0,
            } for k in k_values},
            "sparse_ablation": {k: {
                "mean_judge_score": 0.0,
                "p50_latency_ms": 0.0,
                "p99_latency_ms": 0.0,
                "n_questions": len(eval_questions),
            } for k in k_values},
            "recency_test": None,
        }
        output_path.write_text(json.dumps(stub, indent=2))
        return stub

    # ------------------------------------------------------------------
    # H3.2: Latency benchmark
    # ------------------------------------------------------------------
    logger.info("Running latency benchmark (H3.2)…")
    latency_queries = [q["question"] for q in eval_questions[:10]]
    latency_results = run_latency_benchmark(
        client=client,
        queries=latency_queries,
        k_values=k_values,
        n_reps=n_latency_reps,
    )

    # ------------------------------------------------------------------
    # H3.3: Sparse attention ablation
    # ------------------------------------------------------------------
    logger.info("Running sparse attention ablation (H3.3)…")
    ablation_results = run_sparse_attention_ablation(
        client=client,
        eval_questions=eval_questions,
        k_values=k_values,
    )

    # ------------------------------------------------------------------
    # H3.1: Recency test (optional)
    # ------------------------------------------------------------------
    recency_results: dict | None = None
    if not skip_recency_test:
        logger.info("Running recency test (H3.1)…")
        try:
            import sys as _sys
            import os as _os
            _wedge_dir = str(Path(__file__).parent.parent / "g2-wedge-demo")
            if _wedge_dir not in _sys.path:
                _sys.path.insert(0, _wedge_dir)
            from vanilla_rag import VanillaRAG  # type: ignore[import]
            from recency_test import run_recency_test

            vanilla = VanillaRAG(anthropic_api_key=anthropic_key or "")
            # Ingest only the initial corpus (not the amendments)
            _corpus_docs = [
                {"id": b["block_id"], "title": b["block_id"], "text": b["text"]}
                for b in _SYNTHETIC_CORPUS
            ]
            try:
                vanilla.ingest(_corpus_docs)
            except Exception as exc:
                logger.warning("VanillaRAG ingest failed (likely offline): %s", exc)

            recency_results = run_recency_test(
                nexum_client=client,
                vanilla_client=vanilla,
                corpus=_SYNTHETIC_CORPUS,
                amendments=_SYNTHETIC_AMENDMENTS,
                questions=_SYNTHETIC_RECENCY_QUESTIONS,
            )
        except Exception as exc:  # noqa: BLE001
            logger.error("Recency test failed: %s", exc)
            recency_results = {"error": str(exc)}

    # ------------------------------------------------------------------
    # Combine and write results
    # ------------------------------------------------------------------
    combined: dict = {
        "nexum_url": nexum_url,
        "n_questions": len(eval_questions),
        "k_values": k_values,
        "latency_benchmark": latency_results,
        "sparse_ablation": ablation_results,
        "recency_test": recency_results,
    }

    output_path.write_text(json.dumps(combined, indent=2))
    logger.info("Results written to %s", output_path)
    return combined


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Area 3 — Retrieval-Augmented Inference experiments (H3.1–H3.3)",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--nexum-url",
        default="http://localhost:3000",
        help="Base URL of the running Nexum instance.",
    )
    parser.add_argument(
        "--anthropic-key",
        default=None,
        help="Anthropic API key (falls back to ANTHROPIC_API_KEY env var).",
    )
    parser.add_argument(
        "--skip-recency-test",
        action="store_true",
        help="Skip H3.1 recency test (requires a corpus with known amendments).",
    )
    parser.add_argument(
        "--max-questions",
        type=int,
        default=50,
        help="Maximum number of eval questions per experiment.",
    )
    parser.add_argument(
        "--output",
        default="results/area3_results.json",
        help="Output JSON file path.",
    )
    parser.add_argument(
        "--k-values",
        nargs="+",
        type=int,
        default=[1, 5, 10, 50, 100],
        help="k values for latency and ablation sweeps.",
    )
    parser.add_argument(
        "--n-latency-reps",
        type=int,
        default=5,
        help="Repetitions per (query, k) pair for the latency benchmark.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Skip all live calls; write a stub result for CI verification.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    import os

    args = _parse_args(argv)
    anthropic_key = args.anthropic_key or os.environ.get("ANTHROPIC_API_KEY")

    results = run(
        nexum_url=args.nexum_url,
        anthropic_key=anthropic_key,
        skip_recency_test=args.skip_recency_test,
        max_questions=args.max_questions,
        output_path=args.output,
        k_values=args.k_values,
        n_latency_reps=args.n_latency_reps,
        dry_run=args.dry_run,
    )

    # Print summary to stdout
    print(json.dumps({k: v for k, v in results.items() if k != "per_question"}, indent=2))


if __name__ == "__main__":
    main(sys.argv[1:])
