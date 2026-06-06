"""
run_area5.py — Orchestrator CLI for Area 5 experiments (H5.1–H5.5).

Usage:
    python run_area5.py \\
      --nexum-url http://localhost:3000 \\
      --skip-insertion-latency \\
      --skip-partial-visibility \\
      --output results/area5_results.json

H5.1 results are written through ``experiments._lib.results_writer``
(ResultEnvelope) so the orchestrator's update-hypothesis-status.sh and
downstream meta-analyses can parse a single canonical envelope shape.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Path setup: allow running from repo root or from area5-update-semantics/
# ---------------------------------------------------------------------------
_here = os.path.dirname(os.path.abspath(__file__))
_repo_root = os.path.abspath(os.path.join(_here, "..", ".."))
for _p in (_repo_root,):
    if _p not in sys.path:
        sys.path.insert(0, _p)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _load_eval_questions(path: str | None) -> list[dict]:
    """Load eval questions from a JSON file, or return a synthetic set."""
    if path and Path(path).is_file():
        with open(path) as f:
            return json.load(f)
    # Synthetic 100-question placeholder
    return [
        {"question": f"Synthetic question {i}?", "answer": f"answer_{i}"}
        for i in range(100)
    ]


def _load_texts(path: str | None, n: int = 1000) -> list[str]:
    """Load text corpus from a JSON file, or return synthetic texts."""
    if path and Path(path).is_file():
        with open(path) as f:
            data = json.load(f)
        return data[:n] if isinstance(data, list) else []
    # Synthetic corpus for embedding drift
    base_sentences = [
        "The contract specifies that payment is due within thirty days of invoice.",
        "All intellectual property created under this agreement belongs to the client.",
        "Termination of this agreement requires sixty days written notice.",
        "The governing law of this contract is the state of California.",
        "Warranties are provided for a period of one year from the date of delivery.",
    ]
    texts = []
    for i in range(n):
        base = base_sentences[i % len(base_sentences)]
        texts.append(f"{base} (Document {i // len(base_sentences) + 1}, clause {i + 1}.)")
    return texts


def _banner(title: str) -> None:
    print(f"\n{'='*60}")
    print(f"  {title}")
    print(f"{'='*60}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(
        description="Area 5 — Update semantics and live consistency (H5.1–H5.5)"
    )
    parser.add_argument(
        "--nexum-url",
        default="http://localhost:3000",
        help="Base URL for the Nexum API (default: http://localhost:3000)",
    )
    parser.add_argument(
        "--skip-insertion-latency",
        action="store_true",
        help="Skip H5.1 insertion latency benchmark (use when Nexum is not running)",
    )
    parser.add_argument(
        "--skip-partial-visibility",
        action="store_true",
        help="Skip H5.2 partial visibility eval (use when Nexum is not running)",
    )
    parser.add_argument(
        "--skip-embedding-drift",
        action="store_true",
        help="Skip H5.4 embedding drift (requires sentence-transformers + slow)",
    )
    parser.add_argument(
        "--eval-questions",
        default=None,
        metavar="PATH",
        help="Path to JSON file with eval questions [{question, answer}, ...]",
    )
    parser.add_argument(
        "--corpus",
        default=None,
        metavar="PATH",
        help="Path to JSON file with text corpus [str, ...] for embedding drift",
    )
    parser.add_argument(
        "--n-single-blocks",
        type=int,
        default=100,
        help="Number of single-block inserts for H5.1 (default: 100)",
    )
    parser.add_argument(
        "--n-batch-blocks",
        type=int,
        default=1000,
        help="Batch size for H5.1 batch insert benchmark (default: 1000)",
    )
    parser.add_argument(
        "--n-drift-samples",
        type=int,
        default=200,
        help="Number of text samples for H5.4 embedding drift (default: 200)",
    )
    parser.add_argument(
        "--output",
        default="results/area5_results.json",
        metavar="PATH",
        help="Output path for JSON results (default: results/area5_results.json)",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=42,
        help="Random seed for reproducibility (default: 42)",
    )
    args = parser.parse_args()

    # Ensure output directory exists
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    all_results: dict[str, Any] = {}

    # ------------------------------------------------------------------
    # H5.1 — Insertion latency
    # ------------------------------------------------------------------
    if not args.skip_insertion_latency:
        _banner("H5.1 — Insertion-to-Retrieval Latency Breakdown")
        from insertion_latency import measure_insertion_latency  # noqa: PLC0415
        h5_1_result = measure_insertion_latency(
            nexum_url=args.nexum_url,
            n_single_blocks=args.n_single_blocks,
            n_batch_blocks=args.n_batch_blocks,
            seed=args.seed,
        )
        all_results["h5_1"] = h5_1_result
        print(f"  Bottleneck stage : {h5_1_result['bottleneck_stage']}")
        print(f"  Single-block P99 : {h5_1_result['single_block']['total_ms']['p99_ms']:.1f} ms")
        print(f"  H5.1 supported   : {h5_1_result['h5_1_supported']}")

        # Write H5.1 result through canonical ResultEnvelope so
        # update-hypothesis-status.sh and downstream meta-analyses can parse it.
        try:
            from experiments._lib.results_writer import ResultEnvelope, write_result  # noqa: PLC0415
            from experiments._lib.runner import capture_run_context  # noqa: PLC0415

            run_ctx = capture_run_context(gate="H5.1", hypothesis="H5.1", seed=args.seed)
            bottleneck = h5_1_result["bottleneck_stage"]
            notes = (
                f"Bottleneck stage: {bottleneck}. "
                f"Single-block P99: {h5_1_result['single_block']['total_ms']['p99_ms']:.1f} ms. "
                f"H5.1 pass criterion (<500 ms P99): {'PASS' if h5_1_result['h5_1_supported'] else 'FAIL'}."
            )
            if bottleneck != "index_insert_ms":
                notes += (
                    f" NOTE: HNSW insert is NOT the binding constraint — "
                    f"{bottleneck} dominates. See downstream hypothesis priority queue."
                )
            envelope = ResultEnvelope(
                gate="H5.1",
                hypothesis="H5.1",
                passed=h5_1_result["h5_1_supported"],
                metrics=h5_1_result,
                runtime=run_ctx,
                notes=notes,
            )
            h5_1_out = write_result(envelope, area_dir=_here)
            print(f"  H5.1 results written to {h5_1_out}")
        except ImportError as exc:
            print(f"  [WARN] Could not write canonical H5.1 result envelope: {exc}")
    else:
        print("\n[SKIP] H5.1 insertion latency (--skip-insertion-latency)")

    # ------------------------------------------------------------------
    # H5.2 — Partial visibility
    # ------------------------------------------------------------------
    if not args.skip_partial_visibility:
        _banner("H5.2 — Partial-Link Safety")
        eval_questions = _load_eval_questions(args.eval_questions)
        from partial_visibility import run_partial_visibility_eval  # noqa: PLC0415
        result = run_partial_visibility_eval(
            eval_questions=eval_questions,
            nexum_url=args.nexum_url,
            seed=args.seed,
        )
        all_results["h5_2"] = result
        print(f"  Accuracy (embed only)   : {result['accuracy_embedding_only']:.3f}")
        print(f"  Accuracy (structural)   : {result['accuracy_structural_links']:.3f}")
        print(f"  Accuracy (AI links)     : {result['accuracy_ai_links']:.3f}")
        print(f"  Delta embed→AI          : {result['delta_embedding_to_ai']:+.3f}")
        print(f"  H5.2 supported          : {result['h5_2_supported']}")
    else:
        print("\n[SKIP] H5.2 partial visibility (--skip-partial-visibility)")

    # ------------------------------------------------------------------
    # H5.3 — Version atomicity
    # ------------------------------------------------------------------
    _banner("H5.3 — Version-Level Atomic Visibility")
    from version_atomicity import simulate_version_atomicity  # noqa: PLC0415
    result = simulate_version_atomicity()
    all_results["h5_3"] = result
    for pages, info in result.items():
        if pages == "h5_3_signal":
            continue
        print(
            f"  {pages:>4} pages | {info['total_blocks']:>5} blocks | "
            f"window {info['estimated_index_window_ms']/1000:.1f}s | "
            f"50%-complete: {info['partial_visibility_at_50pct']}"
        )
    print(f"\n  Signal: {result['h5_3_signal']}")

    # ------------------------------------------------------------------
    # H5.4 — Embedding drift
    # ------------------------------------------------------------------
    if not args.skip_embedding_drift:
        _banner("H5.4 — Embedding Drift for Minor Edits")
        texts = _load_texts(args.corpus, n=args.n_drift_samples)
        from embedding_drift import measure_embedding_drift  # noqa: PLC0415
        result = measure_embedding_drift(
            texts=texts,
            n_samples=args.n_drift_samples,
            seed=args.seed,
        )
        all_results["h5_4"] = result
        for frac in [0.01, 0.02, 0.05, 0.10, 0.20]:
            if frac in result:
                d = result[frac]
                print(
                    f"  edit={frac:.0%} | "
                    f"cos_dist={d['mean_cosine_distance']:.4f} | "
                    f"rank_shift={d['mean_rank_shift']:.2f} | "
                    f"pct_shift>{3}={d['pct_blocks_shift_gt_3']:.3f}"
                )
        print(f"  Safe edit threshold : {result['safe_edit_threshold']:.0%}")
        print(f"  H5.4 supported      : {result['h5_4_supported']}")
    else:
        print("\n[SKIP] H5.4 embedding drift (--skip-embedding-drift)")

    # ------------------------------------------------------------------
    # H5.5 — High-ingest contention
    # ------------------------------------------------------------------
    _banner("H5.5 — High-Ingest Contention: Deferred vs. Synchronous")
    from high_ingest_contention import simulate_high_ingest_contention  # noqa: PLC0415
    result = simulate_high_ingest_contention(seed=args.seed)
    all_results["h5_5"] = result
    s, d = result["synchronous"], result["deferred"]
    print(f"  Strategy      | throughput (blk/s) | recall | P99 latency (ms)")
    print(f"  Synchronous   | {s['ingest_throughput']:>18.1f} | {s['query_recall']:.4f} | {s['p99_query_latency_ms']:.1f}")
    print(f"  Deferred      | {d['ingest_throughput']:>18.1f} | {d['query_recall']:.4f} | {d['p99_query_latency_ms']:.1f}")
    print(f"  H5.5 supported: {result['h5_5_supported']}")

    # ------------------------------------------------------------------
    # Write results
    # ------------------------------------------------------------------
    with open(output_path, "w") as f:
        json.dump(all_results, f, indent=2, default=str)
    print(f"\nResults written to {output_path}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
