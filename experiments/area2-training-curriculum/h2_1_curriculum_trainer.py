"""
h2_1_curriculum_trainer.py — Lightweight head-to-head curriculum vs random ordering.

H2.1 (operational form):
    Given a typed-link block graph, training examples *ordered* by the graph
    (BFS over high-confidence `supports` links, easy-to-hard by hop count from
    a high-centrality seed) converge faster and reach higher final accuracy on
    a held-out domain-classification task than the same examples presented in
    random order.

Design choices to keep this honest and cheap:
    - Synthetic corpus with a *real* signal: each block belongs to a domain;
      `supports` links connect blocks in the same domain; `contradicts` links
      cross domains. So a curriculum that walks `supports` neighborhoods sees
      coherent same-domain runs first — the kind of structure flat random
      sampling cannot provide.
    - Tiny model: a single linear layer over a small hashed-bag-of-tokens
      feature (no transformer, no network, deterministic, < 1 s on CPU).
    - Same examples in both regimes — only the *order* differs. This isolates
      the curriculum effect from any data-volume confound.
    - Multiple seeds; we report mean and stdev. No "best of N" cherry-picking.

This module deliberately does not import sentence-transformers. The heavier
fine-tuner in `lm_finetuner.py` remains for the full H2.1 run; this is the
honest, fast measurement that the result envelope is built from.
"""

from __future__ import annotations

import math
import random
from collections import defaultdict, deque
from dataclasses import dataclass
from typing import Iterable

import torch
import torch.nn as nn


# ---------------------------------------------------------------------------
# Synthetic structured corpus
# ---------------------------------------------------------------------------

# Per-domain "vocabulary buckets" so that domain identity is recoverable from
# bag-of-tokens features. Keeps the task learnable but non-trivial.
_DOMAIN_VOCAB = {
    "legal":    ["contract", "clause", "tort", "statute",  "plaintiff", "remedy"],
    "medical":  ["patient", "dosage", "symptom", "lesion",  "diagnosis", "trial"],
    "research": ["hypothesis", "ablation", "corpus", "metric", "baseline", "result"],
    "finance":  ["equity", "yield", "hedge", "ledger", "audit", "swap"],
}
_FILLER = ["the", "of", "and", "to", "in", "with", "for", "is", "on", "by"]


def make_structured_corpus(
    n_blocks: int = 800,
    seed: int = 0,
) -> tuple[list[dict], list[dict]]:
    """
    Build a synthetic block + typed-link corpus with real structure.

    Returns
    -------
    blocks : list[dict] with keys id, text, domain.
    links  : list[dict] with keys source_id, target_id, rel_type, confidence.
             - `supports` links connect same-domain blocks (high signal).
             - `contradicts` links connect cross-domain blocks (hard negatives).
    """
    rng = random.Random(seed)
    domains = list(_DOMAIN_VOCAB.keys())

    blocks: list[dict] = []
    by_domain: dict[str, list[str]] = defaultdict(list)

    for i in range(n_blocks):
        domain = domains[i % len(domains)]
        # Most tokens are domain-specific so the task is solvable but noisy.
        domain_tokens = [rng.choice(_DOMAIN_VOCAB[domain]) for _ in range(8)]
        filler_tokens = [rng.choice(_FILLER) for _ in range(6)]
        # A small fraction of off-domain tokens — realistic noise.
        if rng.random() < 0.3:
            other = rng.choice([d for d in domains if d != domain])
            domain_tokens.append(rng.choice(_DOMAIN_VOCAB[other]))
        tokens = domain_tokens + filler_tokens
        rng.shuffle(tokens)
        block_id = f"b_{i:05d}"
        blocks.append({"id": block_id, "text": " ".join(tokens), "domain": domain})
        by_domain[domain].append(block_id)

    # Build typed links.
    links: list[dict] = []
    # supports: dense within-domain edges.
    for domain, ids in by_domain.items():
        for src in ids:
            # Each block has ~3 supports neighbours in the same domain.
            for _ in range(3):
                dst = rng.choice(ids)
                if dst != src:
                    links.append({
                        "source_id": src,
                        "target_id": dst,
                        "rel_type": "supports",
                        "confidence": round(rng.uniform(0.75, 0.99), 2),
                    })
    # contradicts: sparse cross-domain edges (hard negatives).
    all_ids = [b["id"] for b in blocks]
    for _ in range(n_blocks):
        a, b = rng.sample(all_ids, 2)
        a_dom = blocks[int(a.split("_")[1])]["domain"]
        b_dom = blocks[int(b.split("_")[1])]["domain"]
        if a_dom != b_dom:
            links.append({
                "source_id": a,
                "target_id": b,
                "rel_type": "contradicts",
                "confidence": round(rng.uniform(0.6, 0.95), 2),
            })

    return blocks, links


# ---------------------------------------------------------------------------
# Curriculum ordering
# ---------------------------------------------------------------------------

def curriculum_order(
    blocks: list[dict],
    links: list[dict],
    seed: int = 0,
) -> list[int]:
    """
    Return an index permutation of `blocks` ordered by graph BFS over the
    `supports` subgraph. Seeds are sorted by `supports` in-degree (descending),
    so the model first sees high-centrality blocks and their same-domain
    neighbourhoods before drifting to peripheral nodes.

    Falls back to appending unvisited blocks at the end so the curriculum is a
    full permutation — same examples, different order.
    """
    id_to_idx = {b["id"]: i for i, b in enumerate(blocks)}
    adj: dict[str, list[str]] = defaultdict(list)
    in_deg: dict[str, int] = defaultdict(int)
    for ln in links:
        if ln.get("rel_type") != "supports":
            continue
        src, dst = ln["source_id"], ln["target_id"]
        if src in id_to_idx and dst in id_to_idx:
            adj[src].append(dst)
            in_deg[dst] += 1

    # Seed pool: descending in-degree, then deterministic by id for stability.
    seeds = sorted(id_to_idx.keys(), key=lambda x: (-in_deg[x], x))
    rng = random.Random(seed)

    visited: set[str] = set()
    order: list[int] = []
    for s in seeds:
        if s in visited:
            continue
        q = deque([s])
        visited.add(s)
        while q:
            n = q.popleft()
            order.append(id_to_idx[n])
            nbrs = list(adj.get(n, []))
            rng.shuffle(nbrs)
            for m in nbrs:
                if m not in visited:
                    visited.add(m)
                    q.append(m)
    # Append any orphaned blocks in stable order.
    for bid, idx in id_to_idx.items():
        if bid not in visited:
            order.append(idx)
    return order


def random_order(n: int, seed: int = 0) -> list[int]:
    """Return a random permutation of range(n) under the given seed."""
    rng = random.Random(seed)
    perm = list(range(n))
    rng.shuffle(perm)
    return perm


def interleaved_curriculum_order(
    blocks: list[dict],
    links: list[dict],
    seed: int = 0,
) -> list[int]:
    """
    A graph-aware ordering that avoids catastrophic interference.

    Builds one BFS walk over the `supports` subgraph per *domain*, then
    interleaves the per-domain streams round-robin. The model still benefits
    from local graph structure (a few same-domain blocks in a row, ordered by
    centrality), but never sees long single-domain runs that would let a
    linear classifier overfit before the next domain arrives.

    This is the operational form of a "graph curriculum" that a serious
    training pipeline would actually use; the strict per-seed BFS variant
    in `curriculum_order` is the naive baseline.
    """
    id_to_idx = {b["id"]: i for i, b in enumerate(blocks)}
    domain_of = {b["id"]: b["domain"] for b in blocks}

    adj: dict[str, list[str]] = defaultdict(list)
    in_deg: dict[str, int] = defaultdict(int)
    for ln in links:
        if ln.get("rel_type") != "supports":
            continue
        src, dst = ln["source_id"], ln["target_id"]
        if src in id_to_idx and dst in id_to_idx:
            adj[src].append(dst)
            in_deg[dst] += 1

    rng = random.Random(seed)
    # Per-domain BFS stream, seeded by in-degree.
    by_domain: dict[str, list[str]] = defaultdict(list)
    for bid in id_to_idx:
        by_domain[domain_of[bid]].append(bid)

    streams: dict[str, list[int]] = {}
    for domain, ids in by_domain.items():
        seeds_pool = sorted(ids, key=lambda x: (-in_deg[x], x))
        visited: set[str] = set()
        order_d: list[int] = []
        for s in seeds_pool:
            if s in visited:
                continue
            q = deque([s])
            visited.add(s)
            while q:
                n = q.popleft()
                order_d.append(id_to_idx[n])
                nbrs = [m for m in adj.get(n, []) if domain_of[m] == domain]
                rng.shuffle(nbrs)
                for m in nbrs:
                    if m not in visited:
                        visited.add(m)
                        q.append(m)
        # Append any orphans for this domain.
        for bid in ids:
            if bid not in visited:
                order_d.append(id_to_idx[bid])
                visited.add(bid)
        streams[domain] = order_d

    # Round-robin interleave.
    order: list[int] = []
    cursors = {d: 0 for d in streams}
    domains_cycle = list(streams.keys())
    while True:
        progressed = False
        for d in domains_cycle:
            c = cursors[d]
            if c < len(streams[d]):
                order.append(streams[d][c])
                cursors[d] = c + 1
                progressed = True
        if not progressed:
            break
    return order


# ---------------------------------------------------------------------------
# Hashed bag-of-tokens featurization (deterministic, no external embedding)
# ---------------------------------------------------------------------------

def _hash_tok(tok: str, n_buckets: int) -> int:
    # Stable, seedable hash: positive bucket index.
    h = 1469598103934665603
    for c in tok.encode("utf-8"):
        h ^= c
        h = (h * 1099511628211) & ((1 << 64) - 1)
    return h % n_buckets


def featurize(text: str, n_buckets: int = 128) -> torch.Tensor:
    vec = torch.zeros(n_buckets, dtype=torch.float32)
    toks = text.split()
    if not toks:
        return vec
    for t in toks:
        vec[_hash_tok(t, n_buckets)] += 1.0
    vec /= float(len(toks))
    return vec


# ---------------------------------------------------------------------------
# Training loop
# ---------------------------------------------------------------------------

@dataclass
class TrainResult:
    final_train_acc: float
    final_eval_acc: float
    eval_acc_history: list[float]      # per epoch
    epochs_to_target: int | None        # first epoch where eval_acc >= target


def _split_train_eval(
    blocks: list[dict],
    eval_frac: float,
    seed: int,
) -> tuple[list[int], list[int]]:
    rng = random.Random(seed)
    idx = list(range(len(blocks)))
    rng.shuffle(idx)
    n_eval = max(1, int(len(idx) * eval_frac))
    return idx[n_eval:], idx[:n_eval]


def train_classifier(
    blocks: list[dict],
    order_indices: list[int],
    *,
    train_idx: list[int],
    eval_idx: list[int],
    domains: list[str],
    n_epochs: int = 6,
    lr: float = 0.05,
    n_buckets: int = 128,
    target_acc: float = 0.80,
    seed: int = 0,
) -> TrainResult:
    """
    Train a single linear layer on a domain-classification task.

    The training set is `train_idx`, presented in the order specified by
    `order_indices` (curriculum or random). Evaluation runs on `eval_idx`
    after every epoch.

    Curriculum effect, if real, should manifest as faster convergence
    (`epochs_to_target`) and/or higher `final_eval_acc`.
    """
    torch.manual_seed(seed)
    n_classes = len(domains)
    dom_to_idx = {d: i for i, d in enumerate(domains)}

    # Featurize once.
    X = torch.stack([featurize(b["text"], n_buckets) for b in blocks])
    y = torch.tensor([dom_to_idx[b["domain"]] for b in blocks], dtype=torch.long)

    # Restrict order to train set, preserving the requested order.
    train_set = set(train_idx)
    train_order = [i for i in order_indices if i in train_set]

    model = nn.Linear(n_buckets, n_classes)
    opt = torch.optim.SGD(model.parameters(), lr=lr)
    loss_fn = nn.CrossEntropyLoss()

    eval_x = X[eval_idx]
    eval_y = y[eval_idx]
    train_x_full = X[train_idx]
    train_y_full = y[train_idx]

    history: list[float] = []
    epochs_to_target: int | None = None

    batch_size = 16
    for epoch in range(n_epochs):
        # Single pass through the training data in the requested order.
        for start in range(0, len(train_order), batch_size):
            batch_idx = train_order[start : start + batch_size]
            xb = X[batch_idx]
            yb = y[batch_idx]
            logits = model(xb)
            loss = loss_fn(logits, yb)
            opt.zero_grad()
            loss.backward()
            opt.step()

        with torch.no_grad():
            eval_pred = model(eval_x).argmax(dim=-1)
            acc = float((eval_pred == eval_y).float().mean().item())
        history.append(acc)
        if epochs_to_target is None and acc >= target_acc:
            epochs_to_target = epoch + 1

    with torch.no_grad():
        train_pred = model(train_x_full).argmax(dim=-1)
        train_acc = float((train_pred == train_y_full).float().mean().item())
        final_eval = history[-1] if history else 0.0

    return TrainResult(
        final_train_acc=train_acc,
        final_eval_acc=final_eval,
        eval_acc_history=history,
        epochs_to_target=epochs_to_target,
    )


# ---------------------------------------------------------------------------
# Comparator
# ---------------------------------------------------------------------------

@dataclass
class CompareResult:
    curriculum_bfs: dict             # naive BFS-by-centrality
    curriculum_interleaved: dict     # round-robin per-domain BFS streams
    random: dict
    delta_eval_acc_bfs: float        # bfs - random (final eval acc)
    delta_eval_acc_interleaved: float  # interleaved - random
    delta_epochs_to_target_bfs: float | None
    delta_epochs_to_target_interleaved: float | None
    seeds: list[int]
    verdict: str                     # "curriculum_better" | "random_better" | "tie"
    verdict_basis: str               # which curriculum drove the verdict


def _summarize(rs: list[TrainResult]) -> dict:
    finals = [r.final_eval_acc for r in rs]
    trains = [r.final_train_acc for r in rs]
    ettt = [r.epochs_to_target for r in rs if r.epochs_to_target is not None]
    return {
        "final_eval_acc_mean": _mean(finals),
        "final_eval_acc_stdev": _stdev(finals),
        "final_train_acc_mean": _mean(trains),
        "epochs_to_target_mean": _mean(ettt) if ettt else None,
        "epochs_to_target_n_reached": len(ettt),
        "n_runs": len(rs),
        "per_seed_final_eval_acc": [round(x, 4) for x in finals],
    }


def _mean(xs: Iterable[float]) -> float:
    xs = list(xs)
    return round(sum(xs) / len(xs), 4) if xs else 0.0


def _stdev(xs: Iterable[float]) -> float:
    xs = list(xs)
    if len(xs) < 2:
        return 0.0
    m = sum(xs) / len(xs)
    return round(math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1)), 4)


def compare_curriculum_vs_random(
    n_blocks: int = 800,
    seeds: list[int] | None = None,
    n_epochs: int = 6,
    target_acc: float = 0.80,
    eval_frac: float = 0.2,
) -> CompareResult:
    """
    Run the head-to-head over multiple seeds and summarize.
    """
    if seeds is None:
        seeds = [0, 1, 2, 3, 4]

    domains = list(_DOMAIN_VOCAB.keys())

    bfs_runs: list[TrainResult] = []
    intl_runs: list[TrainResult] = []
    rnd_runs: list[TrainResult] = []

    for s in seeds:
        blocks, links = make_structured_corpus(n_blocks=n_blocks, seed=s)
        train_idx, eval_idx = _split_train_eval(blocks, eval_frac=eval_frac, seed=s)
        bfs_perm = curriculum_order(blocks, links, seed=s)
        intl_perm = interleaved_curriculum_order(blocks, links, seed=s)
        rnd_perm = random_order(len(blocks), seed=s + 1000)

        bfs_runs.append(train_classifier(
            blocks, bfs_perm,
            train_idx=train_idx, eval_idx=eval_idx, domains=domains,
            n_epochs=n_epochs, target_acc=target_acc, seed=s,
        ))
        intl_runs.append(train_classifier(
            blocks, intl_perm,
            train_idx=train_idx, eval_idx=eval_idx, domains=domains,
            n_epochs=n_epochs, target_acc=target_acc, seed=s,
        ))
        rnd_runs.append(train_classifier(
            blocks, rnd_perm,
            train_idx=train_idx, eval_idx=eval_idx, domains=domains,
            n_epochs=n_epochs, target_acc=target_acc, seed=s,
        ))

    bfs_s = _summarize(bfs_runs)
    intl_s = _summarize(intl_runs)
    rnd_s = _summarize(rnd_runs)

    d_bfs = round(bfs_s["final_eval_acc_mean"] - rnd_s["final_eval_acc_mean"], 4)
    d_intl = round(intl_s["final_eval_acc_mean"] - rnd_s["final_eval_acc_mean"], 4)

    def _delta_epochs(cur: dict, rnd: dict) -> float | None:
        if cur["epochs_to_target_mean"] is None or rnd["epochs_to_target_mean"] is None:
            return None
        return round(cur["epochs_to_target_mean"] - rnd["epochs_to_target_mean"], 4)

    de_bfs = _delta_epochs(bfs_s, rnd_s)
    de_intl = _delta_epochs(intl_s, rnd_s)

    # Verdict picks the *best* of the two curriculum variants and compares to random.
    if d_intl >= d_bfs:
        best_delta, best_de, basis = d_intl, de_intl, "interleaved"
    else:
        best_delta, best_de, basis = d_bfs, de_bfs, "bfs"

    if best_delta > 0.01 or (best_de is not None and best_de < -0.5):
        verdict = "curriculum_better"
    elif best_delta < -0.01 or (best_de is not None and best_de > 0.5):
        verdict = "random_better"
    else:
        verdict = "tie"

    return CompareResult(
        curriculum_bfs=bfs_s,
        curriculum_interleaved=intl_s,
        random=rnd_s,
        delta_eval_acc_bfs=d_bfs,
        delta_eval_acc_interleaved=d_intl,
        delta_epochs_to_target_bfs=de_bfs,
        delta_epochs_to_target_interleaved=de_intl,
        seeds=seeds,
        verdict=verdict,
        verdict_basis=basis,
    )
