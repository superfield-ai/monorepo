"""
run_h2_1_contrastive.py — H2.1 contrastive fine-tune experiment.

Generates 1K contrastive pairs from `contradicts`/`supports` links on a
synthetic 5K-contract EDGAR subset, fine-tunes an encoder on:
    (a) flat random pairs (baseline),
    (b) typed contrastive pairs from the link graph.

Evaluates both on BEIR-style nDCG@10 on a held-out corpus and writes a
canonical result envelope via experiments._lib.results_writer.

Pass criterion (H2.1):
    typed_contrastive nDCG@10 >= random_baseline nDCG@10 + 0.02  (≥ 2pp)

Usage::

    # Fast CPU run (no heavy fine-tuning, bag-of-tokens featurizer)
    python run_h2_1_contrastive.py --skip-finetuning

    # Full run (sentence-transformers all-MiniLM-L6-v2, ~5 min on CPU)
    python run_h2_1_contrastive.py

    # With explicit output path
    python run_h2_1_contrastive.py --output results/h2_1_contrastive.json

Canonical references:
- docs/research/hypotheses/H2.1_contrastive-links-better-finetuning.md
- docs/research/queue.md
- experiments/area2-training-curriculum/README.md
"""

from __future__ import annotations

import argparse
import copy
import json
import random
import sys
import time
from pathlib import Path

# ---------------------------------------------------------------------------
# Path setup — allow running from any cwd.
# ---------------------------------------------------------------------------

_HERE = Path(__file__).resolve().parent
_REPO = _HERE.parents[1]
for p in (str(_REPO), str(_HERE)):
    if p not in sys.path:
        sys.path.insert(0, p)

from experiments._lib.runner import capture_run_context          # noqa: E402
from experiments._lib.results_writer import ResultEnvelope, write_result  # noqa: E402
from edgar_corpus import make_edgar_corpus, sample_contrastive_pairs     # noqa: E402
from beir_evaluator import evaluate_retrieval                            # noqa: E402


# ---------------------------------------------------------------------------
# Flat-random pair builder (baseline)
# ---------------------------------------------------------------------------

def _build_random_pairs(
    train_blocks: list[dict],
    n_pairs: int,
    seed: int = 42,
) -> list[dict]:
    """
    Build random contrastive triplets from the training split.

    Same size as typed-contrastive pairs so training is fair.
    Positive: random pair of same clause type.
    Negative: random pair of different clause type.
    """
    rng = random.Random(seed)
    by_clause: dict[str, list[dict]] = {}
    for b in train_blocks:
        ct = b.get("clause_type", "unknown")
        by_clause.setdefault(ct, []).append(b)

    clause_types = list(by_clause.keys())
    triplets: list[dict] = []

    attempts = 0
    while len(triplets) < n_pairs and attempts < n_pairs * 30:
        attempts += 1
        # Anchor
        ct_anchor = rng.choice(clause_types)
        pool = by_clause[ct_anchor]
        if len(pool) < 2:
            continue
        anchor, positive = rng.sample(pool, 2)
        # Negative: different clause type
        neg_ct = rng.choice([t for t in clause_types if t != ct_anchor])
        if not by_clause.get(neg_ct):
            continue
        negative = rng.choice(by_clause[neg_ct])
        triplets.append({
            "anchor_id": anchor["id"],
            "anchor_text": anchor["text"],
            "anchor_clause_type": ct_anchor,
            "positive_id": positive["id"],
            "positive_text": positive["text"],
            "positive_link_type": "random_same_type",
            "negative_id": negative["id"],
            "negative_text": negative["text"],
            "negative_link_type": "random_diff_type",
        })

    rng.shuffle(triplets)
    return triplets[:n_pairs]


# ---------------------------------------------------------------------------
# Contrastive fine-tune using manual PyTorch TripletMarginLoss loop
# ---------------------------------------------------------------------------

def _finetune_contrastive(
    triplets: list[dict],
    model_name: str = "all-MiniLM-L6-v2",
    n_epochs: int = 1,
    batch_size: int = 16,
    seed: int = 42,
):
    """
    Fine-tune a sentence-transformer using a manual PyTorch TripletMarginLoss loop.

    Avoids the sentence_transformers Trainer API (requires `accelerate`).
    Uses torch.nn.TripletMarginWithDistanceLoss with cosine distance instead.

    Returns a trained sentence_transformers.SentenceTransformer model instance.
    """
    import torch
    import torch.nn as nn
    import torch.nn.functional as F
    from sentence_transformers import SentenceTransformer

    torch.manual_seed(seed)
    model = SentenceTransformer(model_name, device="cpu")
    model.train()

    # Collect only valid triplets.
    valid = [
        t for t in triplets
        if t.get("anchor_text") and t.get("positive_text") and t.get("negative_text")
    ]
    if not valid:
        return model

    # AdamW on encoder parameters.
    optimizer = torch.optim.AdamW(model.parameters(), lr=2e-5)
    loss_fn = nn.TripletMarginWithDistanceLoss(
        distance_function=lambda a, b: 1.0 - F.cosine_similarity(a, b),
        margin=0.2,
    )

    import random
    rng = random.Random(seed)

    def _encode_with_grad(texts: list[str]):
        """Encode through model.forward() to keep gradient graph intact."""
        features = model.preprocess(texts)
        return model.forward(features)["sentence_embedding"]

    for epoch in range(n_epochs):
        rng.shuffle(valid)
        epoch_loss = 0.0
        n_batches = 0
        for i in range(0, len(valid), batch_size):
            batch = valid[i: i + batch_size]
            anchors = [t["anchor_text"] for t in batch]
            positives = [t["positive_text"] for t in batch]
            negatives = [t["negative_text"] for t in batch]

            # Encode through forward() to keep gradients.
            enc_a = _encode_with_grad(anchors)
            enc_p = _encode_with_grad(positives)
            enc_n = _encode_with_grad(negatives)

            loss = loss_fn(enc_a, enc_p, enc_n)
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()

            epoch_loss += loss.item()
            n_batches += 1

    model.eval()
    return model


# ---------------------------------------------------------------------------
# Main experiment
# ---------------------------------------------------------------------------

def run_experiment(
    n_contracts: int = 500,
    n_pairs: int = 1000,
    held_out_frac: float = 0.20,
    confidence_threshold: float = 0.70,
    n_epochs: int = 1,
    k: int = 10,
    seed: int = 42,
    model_name: str = "all-MiniLM-L6-v2",
    skip_finetuning: bool = False,
) -> dict:
    """
    Run the H2.1 contrastive fine-tune experiment.

    Returns a metrics dict ready for the result envelope.
    """
    print(f"[H2.1] Building EDGAR corpus: n_contracts={n_contracts} seed={seed}")
    blocks, links = make_edgar_corpus(n_contracts=n_contracts, seed=seed)
    total_blocks = len(blocks)
    print(f"[H2.1] Corpus: {total_blocks} blocks, {len(links)} links")

    # -----------------------------------------------------------------------
    # Train / held-out split (stratified by clause_type for fair eval).
    # -----------------------------------------------------------------------
    rng = random.Random(seed)
    by_clause: dict[str, list[dict]] = {}
    for b in blocks:
        ct = b.get("clause_type", "unknown")
        by_clause.setdefault(ct, []).append(b)

    train_blocks: list[dict] = []
    held_out_blocks: list[dict] = []

    for ct, blist in by_clause.items():
        shuffled = list(blist)
        rng.shuffle(shuffled)
        n_held = max(1, int(len(shuffled) * held_out_frac))
        held_out_blocks.extend(shuffled[:n_held])
        train_blocks.extend(shuffled[n_held:])

    print(f"[H2.1] Split: {len(train_blocks)} train, {len(held_out_blocks)} held-out")

    # -----------------------------------------------------------------------
    # Build training pairs.
    # -----------------------------------------------------------------------
    train_block_ids = {b["id"] for b in train_blocks}

    # Typed contrastive pairs (from links, restricted to train split).
    train_links = [
        lnk for lnk in links
        if lnk["source_id"] in train_block_ids
        and lnk["target_id"] in train_block_ids
    ]
    typed_pairs = sample_contrastive_pairs(
        blocks=train_blocks,
        links=train_links,
        n_pairs=n_pairs,
        confidence_threshold=confidence_threshold,
        seed=seed,
        balance=True,
    )
    print(f"[H2.1] Typed contrastive pairs: {len(typed_pairs)}")

    # Count link-type distribution.
    n_hard = sum(1 for p in typed_pairs if p.get("negative_link_type") == "contradicts")
    n_soft = len(typed_pairs) - n_hard

    # Flat random pairs (baseline — same size, different source).
    random_pairs = _build_random_pairs(train_blocks, n_pairs=n_pairs, seed=seed + 1)
    print(f"[H2.1] Random baseline pairs: {len(random_pairs)}")

    # -----------------------------------------------------------------------
    # Fine-tune two encoders (or skip and use zero-shot BoW fallback).
    # -----------------------------------------------------------------------
    t0 = time.perf_counter()
    if skip_finetuning:
        print("[H2.1] skip_finetuning=True — using bag-of-tokens baseline")
        typed_model = None
        random_model = None
        finetune_time_typed = 0.0
        finetune_time_random = 0.0
    else:
        print(f"[H2.1] Fine-tuning typed model ({n_epochs} epoch(s), {len(typed_pairs)} pairs)…")
        ft0 = time.perf_counter()
        typed_model = _finetune_contrastive(
            typed_pairs, model_name=model_name, n_epochs=n_epochs, seed=seed,
        )
        finetune_time_typed = round(time.perf_counter() - ft0, 2)
        print(f"[H2.1]   typed fine-tune done in {finetune_time_typed}s")

        print(f"[H2.1] Fine-tuning random model ({n_epochs} epoch(s), {len(random_pairs)} pairs)…")
        ft1 = time.perf_counter()
        random_model = _finetune_contrastive(
            random_pairs, model_name=model_name, n_epochs=n_epochs, seed=seed,
        )
        finetune_time_random = round(time.perf_counter() - ft1, 2)
        print(f"[H2.1]   random fine-tune done in {finetune_time_random}s")

    # -----------------------------------------------------------------------
    # Evaluate: BEIR nDCG@10 on held-out corpus.
    # -----------------------------------------------------------------------
    print(f"[H2.1] Evaluating nDCG@{k} on held-out corpus ({len(held_out_blocks)} blocks)…")

    typed_eval = evaluate_retrieval(
        query_blocks=held_out_blocks,
        corpus_blocks=held_out_blocks,
        model=typed_model,
        k=k,
    )
    random_eval = evaluate_retrieval(
        query_blocks=held_out_blocks,
        corpus_blocks=held_out_blocks,
        model=random_model,
        k=k,
    )

    ndcg_typed = typed_eval["ndcg_at_k"]
    ndcg_random = random_eval["ndcg_at_k"]
    delta = round(ndcg_typed - ndcg_random, 6)

    print(f"[H2.1] nDCG@{k}: typed={ndcg_typed:.4f}  random={ndcg_random:.4f}  Δ={delta:+.4f}")

    elapsed = round(time.perf_counter() - t0, 2)
    # Pass criterion: ≥ 2pp nDCG@10 improvement.
    passed = delta >= 0.02
    print(f"[H2.1] verdict = {'PASS' if passed else 'FAIL'}  (elapsed {elapsed}s)")

    return {
        "n_contracts": n_contracts,
        "n_total_blocks": total_blocks,
        "n_train_blocks": len(train_blocks),
        "n_held_out_blocks": len(held_out_blocks),
        "n_links_total": len(links),
        "n_train_links": len(train_links),
        "n_typed_pairs": len(typed_pairs),
        "n_random_pairs": len(random_pairs),
        "n_hard_negatives": n_hard,
        "n_soft_negatives": n_soft,
        "confidence_threshold": confidence_threshold,
        "n_epochs": n_epochs,
        "model_name": model_name if not skip_finetuning else "bag-of-tokens",
        "skip_finetuning": skip_finetuning,
        "finetune_time_typed_sec": finetune_time_typed if not skip_finetuning else None,
        "finetune_time_random_sec": finetune_time_random if not skip_finetuning else None,
        "typed_contrastive": typed_eval,
        "random_baseline": random_eval,
        "ndcg_at_k_typed": ndcg_typed,
        "ndcg_at_k_random": ndcg_random,
        "delta_ndcg": delta,
        "k": k,
        "pass_threshold_delta": 0.02,
        "elapsed_sec": elapsed,
        "passed": passed,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        description="H2.1 contrastive fine-tune from typed-link pairs"
    )
    p.add_argument("--n-contracts", type=int, default=500,
                   help="Number of synthetic EDGAR contracts (default 500 ≈ 5K blocks)")
    p.add_argument("--n-pairs", type=int, default=1000,
                   help="Number of training pairs per condition (default 1000)")
    p.add_argument("--n-epochs", type=int, default=1,
                   help="Fine-tune epochs (default 1; increase for convergence)")
    p.add_argument("--model", default="all-MiniLM-L6-v2",
                   help="Sentence-transformers model name (default all-MiniLM-L6-v2)")
    p.add_argument("--k", type=int, default=10,
                   help="nDCG cutoff (default 10)")
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--confidence-threshold", type=float, default=0.70)
    p.add_argument("--skip-finetuning", action="store_true",
                   help="Skip fine-tuning; use bag-of-tokens encoder (fast CI mode)")
    p.add_argument("--output", default=None,
                   help="Explicit output JSON path (overrides default envelope path)")
    args = p.parse_args(argv)

    metrics = run_experiment(
        n_contracts=args.n_contracts,
        n_pairs=args.n_pairs,
        n_epochs=args.n_epochs,
        model_name=args.model,
        k=args.k,
        seed=args.seed,
        confidence_threshold=args.confidence_threshold,
        skip_finetuning=args.skip_finetuning,
    )

    rc = capture_run_context(gate="H2.1", hypothesis="H2.1", seed=args.seed)
    envelope = ResultEnvelope(
        gate="H2.1",
        hypothesis="H2.1",
        passed=metrics["passed"],
        metrics=metrics,
        runtime=rc,
        notes=(
            "Contrastive fine-tune experiment: typed-link pairs (contradicts/supports "
            "from synthetic EDGAR corpus) vs flat random pairs of equal size.  "
            "Evaluated on BEIR-style nDCG@10 on a 20% held-out split.  "
            "Pass criterion: delta_ndcg >= 0.02 (2pp improvement).  "
            f"Model: {metrics['model_name']}.  "
            f"n_typed_pairs={metrics['n_typed_pairs']}  "
            f"n_random_pairs={metrics['n_random_pairs']}  "
            f"n_hard_negatives={metrics['n_hard_negatives']}."
        ),
    )

    if args.output:
        out = Path(args.output)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(
            json.dumps(envelope.to_dict(results_path=str(out.as_posix())),
                       indent=2, sort_keys=True),
            encoding="utf-8",
        )
    else:
        out = write_result(envelope, _HERE)

    print(f"[H2.1] Envelope written to {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
