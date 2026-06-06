"""
run_h5_4.py — H5.4: Embedding drift after minor content edits.

Runs the full H5.4 experiment harness:
  1. Applies 1%, 3%, 5%, and 10% token substitution to a corpus of up to 10K blocks.
  2. Re-embeds each variant with all-MiniLM-L6-v2 (local, no API key).
  3. Measures cosine distance between original and edited embeddings.
  4. Measures rank shift in ANN retrieval neighbourhood.
  5. Estimates the HNSW nearest-neighbor boundary — the cosine distance gap between
     the k-th and (k+1)-th nearest neighbor — and compares drift against it.
  6. Writes a canonical result envelope via experiments._lib.results_writer.

Pass criterion (H5.4): safe_edit_threshold >= 0.05
  (highest edit fraction where < 5% of blocks shift more than 3 retrieval positions)

Usage:
    # Default: 1K blocks, fast run
    python run_h5_4.py

    # Full scale: 10K blocks
    python run_h5_4.py --n-blocks 10000

    # Custom output path
    python run_h5_4.py --output results/h5_4_result.json

    # Custom corpus from JSON file (list of strings)
    python run_h5_4.py --corpus /path/to/corpus.json --n-blocks 10000

Canonical docs:
  - docs/research/hypotheses/H5.4_embedding-drift-below-threshold.md
  - docs/research/queue.md
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Synthetic corpus generator
# ---------------------------------------------------------------------------

_BASE_SENTENCES = [
    "The contract specifies that payment is due within thirty days of invoice.",
    "All intellectual property created under this agreement belongs to the client.",
    "Termination of this agreement requires sixty days written notice by either party.",
    "The governing law of this contract is the state of California, United States.",
    "Warranties are provided for a period of one year from the date of delivery.",
    "Confidential information shall not be disclosed to third parties without consent.",
    "Either party may seek injunctive relief to prevent irreparable harm from breach.",
    "Disputes shall be resolved through binding arbitration in San Francisco, CA.",
    "Force majeure events suspend obligations for the duration of the event.",
    "The agreement constitutes the entire understanding between the parties.",
]


def _generate_synthetic_corpus(n: int) -> list[str]:
    """Generate n synthetic legal clause texts for embedding drift experiments."""
    texts = []
    for i in range(n):
        base = _BASE_SENTENCES[i % len(_BASE_SENTENCES)]
        section = i // len(_BASE_SENTENCES) + 1
        clause = i + 1
        texts.append(f"{base} (Section {section}, Clause {clause}.)")
    return texts


def _load_corpus(path: str | None, n: int) -> list[str]:
    """Load corpus from JSON file or generate synthetic data."""
    if path and Path(path).is_file():
        with open(path) as f:
            data = json.load(f)
        if isinstance(data, list):
            return [str(item) for item in data[:n]]
    return _generate_synthetic_corpus(n)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(
        description="H5.4 — Embedding drift harness: measure cosine drift vs. HNSW boundary"
    )
    parser.add_argument(
        "--n-blocks",
        type=int,
        default=1000,
        metavar="N",
        help="Number of text blocks to process (default: 1000; full scale: 10000)",
    )
    parser.add_argument(
        "--corpus",
        default=None,
        metavar="PATH",
        help="Path to JSON file with text corpus [str, ...]. Uses synthetic if not given.",
    )
    parser.add_argument(
        "--top-k",
        type=int,
        default=8,
        metavar="K",
        help="ANN neighbourhood size for rank-shift and boundary measurement (default: 8)",
    )
    parser.add_argument(
        "--n-boundary-queries",
        type=int,
        default=200,
        metavar="N",
        help="Number of probe queries for HNSW boundary estimation (default: 200)",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=42,
        help="Random seed for reproducibility (default: 42)",
    )
    parser.add_argument(
        "--output",
        default=None,
        metavar="PATH",
        help="Output JSON path (default: results/h5_4_<timestamp>.json)",
    )
    parser.add_argument(
        "--area-dir",
        default=None,
        metavar="DIR",
        help="Experiment area dir for results_writer (default: the directory of this script)",
    )
    args = parser.parse_args()

    # Resolve experiment area dir
    script_dir = Path(__file__).parent
    area_dir = Path(args.area_dir) if args.area_dir else script_dir

    # Add repo root to sys.path so `experiments._lib` is importable as a package.
    # The directory layout is: <repo_root>/experiments/_lib/results_writer.py
    # script_dir = <repo_root>/experiments/area5-update-semantics
    repo_root = script_dir.parent.parent
    if str(repo_root) not in sys.path:
        sys.path.insert(0, str(repo_root))

    from experiments._lib.runner import capture_run_context
    from experiments._lib.results_writer import ResultEnvelope, write_result

    print(f"\n{'='*60}")
    print("  H5.4 — Embedding Drift After Minor Content Edits")
    print(f"{'='*60}")
    print(f"  Blocks    : {args.n_blocks}")
    print(f"  Top-k     : {args.top_k}")
    print(f"  Seed      : {args.seed}")

    # Load corpus
    texts = _load_corpus(args.corpus, args.n_blocks)
    print(f"  Corpus    : {len(texts)} texts loaded")

    # Capture runtime context
    ctx = capture_run_context(gate="H5.4", hypothesis="H5.4", seed=args.seed)

    # Import and run the drift measurement
    # The embedding_drift module is in the same directory
    if str(script_dir) not in sys.path:
        sys.path.insert(0, str(script_dir))

    from embedding_drift import measure_embedding_drift  # noqa: PLC0415

    print("\n  Running drift measurement (this may take several minutes)...")
    result = measure_embedding_drift(
        texts=texts,
        edit_fractions=[0.01, 0.03, 0.05, 0.10],
        n_samples=args.n_blocks,
        top_k=args.top_k,
        seed=args.seed,
        n_boundary_queries=args.n_boundary_queries,
    )

    # Print summary
    hnsw = result["hnsw_boundary"]
    print(f"\n  HNSW boundary (mean): {hnsw['mean_boundary']:.4f}")
    print(f"  HNSW boundary (p50) : {hnsw['p50_boundary']:.4f}")
    print(f"  HNSW boundary (p25) : {hnsw['p25_boundary']:.4f}")
    print(f"\n  {'Edit':>6} | {'Mean cos dist':>13} | {'P95 cos dist':>12} | "
          f"{'Mean rank shift':>15} | {'Pct>3 shifts':>12} | {'Pct>boundary':>12}")
    print(f"  {'-'*6}-+-{'-'*13}-+-{'-'*12}-+-{'-'*15}-+-{'-'*12}-+-{'-'*12}")
    for frac in [0.01, 0.03, 0.05, 0.10]:
        if frac in result:
            d = result[frac]
            print(
                f"  {frac:>6.0%} | {d['mean_cosine_distance']:>13.4f} | "
                f"{d['p95_cosine_distance']:>12.4f} | {d['mean_rank_shift']:>15.2f} | "
                f"{d['pct_blocks_shift_gt_3']:>12.3f} | "
                f"{d['pct_drift_exceeds_boundary']:>12.3f}"
            )

    print(f"\n  Safe edit threshold : {result['safe_edit_threshold']:.0%}")
    print(f"  H5.4 supported      : {result['h5_4_supported']}")

    # Flatten metrics for the result envelope
    metrics: dict = {
        "hnsw_boundary": hnsw,
        "safe_edit_threshold": result["safe_edit_threshold"],
        "h5_4_supported": result["h5_4_supported"],
        "n_blocks": len(texts),
        "top_k": args.top_k,
    }
    for frac in [0.01, 0.03, 0.05, 0.10]:
        if frac in result:
            key = f"edit_{int(frac * 100):02d}pct"
            metrics[key] = result[frac]

    passed = bool(result["h5_4_supported"])
    envelope = ResultEnvelope(
        gate="H5.4",
        hypothesis="H5.4",
        passed=passed,
        metrics=metrics,
        runtime=ctx,
        notes=(
            f"Token substitution harness on {len(texts)} blocks at 1%, 3%, 5%, 10% rates. "
            f"Drift compared against HNSW nearest-neighbor boundary "
            f"(mean={hnsw['mean_boundary']:.4f}). "
            f"Safe edit threshold: {result['safe_edit_threshold']:.0%}."
        ),
    )

    # Write result via results_writer
    filename = args.output.split("/")[-1] if args.output else None
    out_path = write_result(envelope, area_dir, filename=filename)
    print(f"\n  Result written to: {out_path}")

    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
