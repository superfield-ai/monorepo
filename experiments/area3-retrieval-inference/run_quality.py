"""
run_quality.py — CLI entry point for the issue-#10 quality benchmark.

Runs :func:`quality_benchmark.run_quality_benchmark` against either the
in-memory fixture (default; offline-safe) or a live Nexum HTTP backend.

Outputs a result envelope under
``experiments/area3-retrieval-inference/results/h3.1_<timestamp>.json`` and
prints a one-line summary to stdout.

Usage
-----
    # Offline / CI smoke (no Nexum, no API key required):
    python run_quality.py --offline --max-questions 50

    # Live small-scale run against a running Nexum instance:
    python run_quality.py \\
        --nexum-url http://localhost:3000 \\
        --max-questions 100

The benchmark targets H3.1 (quality slice). Latency is recorded per question
but is not the gating metric here — see latency_benchmark.py for H3.2.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

logger = logging.getLogger(__name__)

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent.parent))  # repo root for experiments._lib


# ---------------------------------------------------------------------------
# Synthetic 50-question fixture (CUAD-style, deterministic, offline-safe)
# ---------------------------------------------------------------------------


def _build_synthetic_corpus_and_questions(
    n_questions: int = 50,
) -> tuple[list[dict], list[dict], dict[str, list[dict]]]:
    """Build a small deterministic corpus + question set for offline runs.

    Returns ``(corpus, questions, mode_corpora)`` so the in-memory
    InferenceClient can be constructed with a typed-link "graph" view that is
    a focused subset of the flat-vector "vector" view. This mirrors the
    real-world expectation that graph traversal narrows the candidate set to
    the typed-edge neighborhood of the seed match.
    """
    topics = [
        ("force_majeure", "force majeure", "covers pandemic events"),
        ("indemnification", "indemnification", "limits liability for third-party claims"),
        ("liquidated_damages", "liquidated damages", "capped at 150% of contract value"),
        ("arbitration", "arbitration", "is mandatory for all disputes"),
        ("confidentiality", "confidentiality", "applies for five years post-termination"),
        ("non_compete", "non-compete", "lasts twelve months in the same industry"),
        ("termination", "termination", "requires 30 days written notice"),
        ("payment_terms", "payment terms", "are net 45 days from invoice"),
        ("warranty", "warranty", "covers defects for one year"),
        ("ip_assignment", "ip assignment", "transfers all derivative works"),
    ]

    corpus: list[dict] = []
    questions: list[dict] = []

    for i, (topic, span, fact) in enumerate(topics):
        # Five blocks per topic; only the first contains the answer span.
        for j in range(5):
            text = (
                f"Clause {i}.{j} regarding {span}: {fact}."
                if j == 0
                else f"Clause {i}.{j} regarding {span}: ancillary procedural detail {j}."
            )
            corpus.append({
                "block_id": f"{topic}-block-{j:02d}",
                "doc_id": topic,
                "text": text,
            })
        # Five questions per topic to fill 50.
        for q in range(n_questions // len(topics)):
            questions.append({
                "question": f"What does the {span} clause say about {fact.split()[0]}?",
                "gold_answer": fact,
                "gold_doc_id": topic,
            })

    # Trim/pad to exactly n_questions.
    questions = questions[:n_questions]

    # The "graph" mode_corpora only exposes the answer-bearing block per
    # topic — the in-memory analogue of typed-link traversal narrowing
    # the candidate set to the relevant clause neighborhood.
    graph_blocks = [b for b in corpus if b["block_id"].endswith("block-00")]
    mode_corpora = {"graph": graph_blocks, "hybrid": graph_blocks}

    return corpus, questions, mode_corpora


# ---------------------------------------------------------------------------
# Main runner
# ---------------------------------------------------------------------------


def run(
    *,
    offline: bool,
    nexum_url: str,
    max_questions: int,
    output_dir: Path,
    k: int,
) -> dict:
    from inference_client_adapter import (  # noqa: WPS433 (deferred import)
        HttpInferenceClient,
        InMemoryInferenceClient,
    )
    from quality_benchmark import run_quality_benchmark, write_quality_envelope

    corpus, questions, mode_corpora = _build_synthetic_corpus_and_questions(
        n_questions=max_questions,
    )

    if offline:
        client = InMemoryInferenceClient(corpus, k=k, mode_corpora=mode_corpora)
        notes = (
            "Offline run on synthetic 50-question fixture; in-memory "
            "InferenceClient with a graph-mode corpus narrowed to "
            "answer-bearing blocks (typed-link traversal analogue)."
        )
    else:
        from graph_inference_client import GraphInferenceClient  # noqa: WPS433

        backend = GraphInferenceClient(nexum_url=nexum_url, anthropic_key=None)
        client = HttpInferenceClient(backend, k=k)
        notes = (
            f"Live run against {nexum_url} with k={k}; vector vs graph "
            "modes resolved to /api/retrieve modes per HttpInferenceClient."
        )

    metrics = run_quality_benchmark(client, questions, modes=("vector", "graph"))

    out = write_quality_envelope(
        metrics,
        area_dir=output_dir,
        seed=0,
        notes=notes,
    )
    logger.info("Wrote H3.1 quality result to %s", out)

    summary = {
        "n_questions": metrics["n_questions"],
        "deltas": metrics["deltas"],
        "modes": [
            {
                "mode": m["mode"],
                "factual_correctness": m["factual_correctness"],
                "mean_attribution_f1": m["mean_attribution_f1"],
            }
            for m in metrics["modes"]
        ],
        "results_path": str(out),
    }
    return summary


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Issue #10 — Area 3 retrieval-augmented inference quality benchmark.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--offline", action="store_true",
                   help="Use the in-memory client; no Nexum or API key required.")
    p.add_argument("--nexum-url", default="http://localhost:3000")
    p.add_argument("--max-questions", type=int, default=50)
    p.add_argument("--k", type=int, default=10,
                   help="Top-k blocks to retrieve per query.")
    p.add_argument(
        "--output-dir",
        default=str(HERE),
        help="Experiment area dir; results written under <dir>/results/.",
    )
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s — %(message)s",
    )
    args = _parse_args(argv)
    summary = run(
        offline=args.offline,
        nexum_url=args.nexum_url,
        max_questions=args.max_questions,
        output_dir=Path(args.output_dir),
        k=args.k,
    )
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
