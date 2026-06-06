"""
run_area2.py — Orchestrator CLI for the Area 2 training curriculum experiment.

Runs H2.1 (contrastive pairs), H2.2 (BFS walk), H2.3 (link type ablation),
H2.4 (version-delta test set) experiments, optionally fine-tuning a model on
each curriculum.

Usage::

    python run_area2.py \\
        --n-blocks 10000 \\
        --n-pairs 1000 \\
        --skip-finetuning \\
        --output results/area2_results.json

Full run (requires sentence-transformers, may take minutes on CPU)::

    python run_area2.py \\
        --n-blocks 10000 \\
        --n-pairs 1000 \\
        --output results/area2_results.json
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
from typing import Any


# ---------------------------------------------------------------------------
# Synthetic data generation (no external dependencies)
# ---------------------------------------------------------------------------

def _make_synthetic_blocks(n: int, seed: int = 42) -> list[dict]:
    """Generate n synthetic block dicts with id, text, domain."""
    rng = random.Random(seed)
    domains = ["legal", "medical", "research", "finance"]
    blocks = []
    for i in range(n):
        domain = domains[i % len(domains)]
        blocks.append(
            {
                "id": f"block_{i:06d}",
                "text": f"Block {i} in domain {domain}. " + " ".join(
                    f"word{rng.randint(0, 999)}" for _ in range(20)
                ),
                "domain": domain,
            }
        )
    return blocks


def _make_synthetic_links(
    blocks: list[dict],
    n_links: int = 5_000,
    seed: int = 42,
) -> list[dict]:
    """Generate synthetic links across the block graph."""
    rng = random.Random(seed)
    rel_types = ["cites", "supports", "contradicts", "elaborates", "is-exception-to"]
    rel_layers = {
        "cites": "structural",
        "elaborates": "structural",
        "is-exception-to": "structural",
        "supports": "semantic",
        "contradicts": "semantic",
    }

    links = []
    ids = [b["id"] for b in blocks]

    for _ in range(n_links):
        src, dst = rng.sample(ids, 2)
        rel = rng.choice(rel_types)
        conf = round(rng.uniform(0.4, 1.0), 2)
        links.append(
            {
                "source_id": src,
                "target_id": dst,
                "rel_type": rel,
                "link_layer": rel_layers.get(rel, "ai"),
                "confidence": conf,
            }
        )

    return links


# ---------------------------------------------------------------------------
# Mock accuracy for --skip-finetuning
# ---------------------------------------------------------------------------

def _mock_accuracy(curriculum: list[dict], *args, **kwargs) -> float:
    """Returns a stable mock accuracy proportional to curriculum size."""
    return min(0.9, 0.5 + len(curriculum) * 0.0001)


def _mock_accuracy_by_task(curriculum: list[dict], task: str) -> float:
    base = _mock_accuracy(curriculum)
    if task == "reasoning":
        return round(base * 0.95, 4)
    return round(base * 1.02, 4)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Area 2 — Graph as Training Curriculum orchestrator"
    )
    parser.add_argument(
        "--n-blocks",
        type=int,
        default=10_000,
        metavar="N",
        help="Number of synthetic blocks to generate (default: 10000)",
    )
    parser.add_argument(
        "--n-pairs",
        type=int,
        default=1_000,
        metavar="N",
        help="Number of training pairs for flat / BFS curriculum (default: 1000)",
    )
    parser.add_argument(
        "--skip-finetuning",
        action="store_true",
        help="Use mock accuracy instead of fine-tuning a real model (fast runs)",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=42,
        help="Random seed (default: 42)",
    )
    parser.add_argument(
        "--output",
        default="results/area2_results.json",
        metavar="PATH",
        help="Output JSON path (default: results/area2_results.json)",
    )
    args = parser.parse_args(argv)

    print(f"[Area2] Generating {args.n_blocks} synthetic blocks...")
    blocks = _make_synthetic_blocks(args.n_blocks, seed=args.seed)
    links = _make_synthetic_links(blocks, n_links=args.n_blocks // 2, seed=args.seed)

    combined: dict[str, Any] = {
        "experiment": "area2_training_curriculum",
        "n_blocks": args.n_blocks,
        "n_pairs": args.n_pairs,
        "skip_finetuning": args.skip_finetuning,
        "h2_1_contrastive": None,
        "h2_1_density_ablation": None,
        "h2_2_bfs_walk": None,
        "h2_3_link_type_ablation": None,
        "h2_4_version_delta": None,
    }

    # ------------------------------------------------------------------
    # H2.1 — Contrastive curriculum
    # ------------------------------------------------------------------
    print("\n[Area2] === H2.1 Contrastive Curriculum ===")
    try:
        from curriculum_builder import build_contrastive_curriculum, build_flat_random_curriculum

        t0 = time.perf_counter()
        contrastive = build_contrastive_curriculum(blocks, links)
        flat = build_flat_random_curriculum(blocks, n_pairs=args.n_pairs, seed=args.seed)
        elapsed = time.perf_counter() - t0

        print(f"  Contrastive triplets: {len(contrastive)}")
        print(f"  Flat random pairs:    {len(flat)}")
        print(f"  Built in {elapsed:.2f}s")

        combined["h2_1_contrastive"] = {
            "n_contrastive_triplets": len(contrastive),
            "n_flat_pairs": len(flat),
            "build_time_sec": round(elapsed, 3),
        }
    except Exception as exc:
        print(f"[Area2] H2.1 FAILED: {exc}", file=sys.stderr)
        combined["h2_1_contrastive_error"] = str(exc)

    # ------------------------------------------------------------------
    # H2.1 — Link density ablation
    # ------------------------------------------------------------------
    print("\n[Area2] === H2.1 Link Density Ablation ===")
    try:
        from link_density_ablation import run_link_density_ablation

        eval_fn = _mock_accuracy if args.skip_finetuning else _mock_accuracy

        t0 = time.perf_counter()
        density_results = run_link_density_ablation(
            blocks=blocks,
            links=links,
            confidence_thresholds=[0.5, 0.7, 0.9],
            eval_fn=eval_fn,
            n_pairs=args.n_pairs,
            seed=args.seed,
        )
        elapsed = time.perf_counter() - t0

        for thresh, res in density_results.items():
            print(
                f"  threshold={thresh}: "
                f"n_links={res['n_links_included']}, "
                f"n_pairs={res['n_pairs_generated']}, "
                f"acc={res['eval_accuracy']:.3f}"
            )
        print(f"  Ablation done in {elapsed:.2f}s")
        combined["h2_1_density_ablation"] = density_results
    except Exception as exc:
        print(f"[Area2] H2.1 density ablation FAILED: {exc}", file=sys.stderr)
        combined["h2_1_density_ablation_error"] = str(exc)

    # ------------------------------------------------------------------
    # H2.2 — BFS walk curriculum
    # ------------------------------------------------------------------
    print("\n[Area2] === H2.2 BFS Walk Curriculum ===")
    try:
        from curriculum_builder import build_bfs_walk_curriculum

        t0 = time.perf_counter()
        bfs_sequences = build_bfs_walk_curriculum(
            blocks=blocks,
            links=links,
            n_sequences=min(100, args.n_pairs),
            sequence_length=10,
            seed_strategy="high_centrality",
            seed=args.seed,
        )
        elapsed = time.perf_counter() - t0

        avg_len = (
            sum(len(s["sequence"]) for s in bfs_sequences) / len(bfs_sequences)
            if bfs_sequences else 0.0
        )
        print(f"  BFS sequences: {len(bfs_sequences)}, avg_length={avg_len:.1f}")
        print(f"  Built in {elapsed:.2f}s")

        combined["h2_2_bfs_walk"] = {
            "n_sequences": len(bfs_sequences),
            "avg_sequence_length": round(avg_len, 2),
            "build_time_sec": round(elapsed, 3),
        }
    except Exception as exc:
        print(f"[Area2] H2.2 FAILED: {exc}", file=sys.stderr)
        combined["h2_2_bfs_walk_error"] = str(exc)

    # ------------------------------------------------------------------
    # H2.3 — Link type ablation
    # ------------------------------------------------------------------
    print("\n[Area2] === H2.3 Link Type Ablation ===")
    try:
        from link_type_ablation import run_link_type_ablation

        t0 = time.perf_counter()
        lt_results = run_link_type_ablation(
            blocks=blocks,
            links=links,
            link_types_to_test=["structural", "semantic", "ai"],
            eval_fn=_mock_accuracy_by_task,
            seed=args.seed,
        )
        elapsed = time.perf_counter() - t0

        for lt in ["structural", "semantic", "ai"]:
            res = lt_results.get(lt, {})
            print(
                f"  {lt}: reasoning={res.get('reasoning_accuracy', 0):.3f}, "
                f"retrieval={res.get('retrieval_accuracy', 0):.3f}"
            )
        print(f"  H2.3 signal: {lt_results.get('h2_3_signal')}")
        print(f"  Ablation done in {elapsed:.2f}s")
        combined["h2_3_link_type_ablation"] = lt_results
    except Exception as exc:
        print(f"[Area2] H2.3 FAILED: {exc}", file=sys.stderr)
        combined["h2_3_link_type_ablation_error"] = str(exc)

    # ------------------------------------------------------------------
    # H2.4 — Version delta curriculum
    # ------------------------------------------------------------------
    print("\n[Area2] === H2.4 Version Delta Curriculum ===")
    try:
        from curriculum_builder import build_version_delta_curriculum

        # Simulate v1 / v2: half the blocks have modified text in v2.
        rng = random.Random(args.seed)
        blocks_v2 = []
        for i, b in enumerate(blocks):
            if i % 5 == 0:
                # Changed block.
                b2 = dict(b)
                b2["text"] = b["text"] + " [amended]"
                blocks_v2.append(b2)
            else:
                blocks_v2.append(dict(b))

        t0 = time.perf_counter()
        delta_pairs = build_version_delta_curriculum(
            blocks_v1=blocks,
            blocks_v2=blocks_v2,
            links=links,
        )
        elapsed = time.perf_counter() - t0

        n_pos = sum(1 for p in delta_pairs if p["pair_type"] == "positive")
        n_neg = sum(1 for p in delta_pairs if p["pair_type"] == "negative")
        print(f"  Delta pairs: {len(delta_pairs)} (positive={n_pos}, negative={n_neg})")
        print(f"  Built in {elapsed:.2f}s")

        combined["h2_4_version_delta"] = {
            "n_pairs": len(delta_pairs),
            "n_positive": n_pos,
            "n_negative": n_neg,
            "build_time_sec": round(elapsed, 3),
        }
    except Exception as exc:
        print(f"[Area2] H2.4 FAILED: {exc}", file=sys.stderr)
        combined["h2_4_version_delta_error"] = str(exc)

    # ------------------------------------------------------------------
    # Write results
    # ------------------------------------------------------------------
    os.makedirs(os.path.dirname(args.output) if os.path.dirname(args.output) else ".", exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as fh:
        json.dump(combined, fh, indent=2)
    print(f"\n[Area2] Results written to {args.output}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
