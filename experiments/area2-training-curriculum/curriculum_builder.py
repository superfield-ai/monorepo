"""
curriculum_builder.py — Construct training curricula from the block graph.

H2.1: contrastive pairs from typed links (contradicts / supports).
H2.2: BFS walk from high-centrality (high in-degree) blocks.
H2.4: version-delta test set from paired document versions.

Each builder is a pure function: given blocks and links dicts it returns a
list of training examples with no side effects.
"""

from __future__ import annotations

import random
from collections import defaultdict, deque


# ---------------------------------------------------------------------------
# H2.1 — Flat random baseline curriculum
# ---------------------------------------------------------------------------

def build_flat_random_curriculum(
    blocks: list[dict],   # [{id, text, domain}]
    n_pairs: int = 10_000,
    seed: int = 42,
) -> list[dict]:
    """
    Randomly sample block pairs.

    Label=1 if the two blocks share the same ``domain`` value, 0 otherwise.
    Returns exactly ``n_pairs`` dicts with keys:
        anchor_id, positive_id (same as anchor_id for flat curriculum),
        block_a_id, block_b_id, block_a_text, block_b_text, label.

    The returned list has exactly ``n_pairs`` entries.
    """
    rng = random.Random(seed)

    if len(blocks) < 2:
        return []

    pairs: list[dict] = []
    indices = list(range(len(blocks)))

    attempts = 0
    max_attempts = n_pairs * 20

    while len(pairs) < n_pairs and attempts < max_attempts:
        i, j = rng.sample(indices, 2)
        a = blocks[i]
        b = blocks[j]
        label = 1 if a.get("domain") == b.get("domain") else 0
        pairs.append(
            {
                "block_a_id": a["id"],
                "block_b_id": b["id"],
                "block_a_text": a.get("text", ""),
                "block_b_text": b.get("text", ""),
                "label": label,
            }
        )
        attempts += 1

    # Trim or pad to exactly n_pairs (trim only — if we didn't reach it
    # the caller gets what we could generate).
    return pairs[:n_pairs]


# ---------------------------------------------------------------------------
# H2.2 — BFS walk curriculum
# ---------------------------------------------------------------------------

def build_bfs_walk_curriculum(
    blocks: list[dict],
    links: list[dict],    # [{source_id, target_id, rel_type, confidence}]
    n_sequences: int = 1_000,
    sequence_length: int = 10,
    seed_strategy: str = "high_centrality",  # or "random"
    seed: int = 42,
) -> list[dict]:
    """
    H2.2: BFS walk from high-centrality blocks.

    High-centrality = blocks with the most *incoming* links (in-degree).
    Each returned dict has:
        sequence: list[str]   — block IDs in BFS traversal order (len ≤ sequence_length)
        seed_id: str          — the block ID used as BFS root
    """
    rng = random.Random(seed)

    # Build adjacency (outgoing) and in-degree maps.
    adjacency: dict[str, list[str]] = defaultdict(list)
    in_degree: dict[str, int] = defaultdict(int)

    block_ids = {b["id"] for b in blocks}

    for link in links:
        src = link["source_id"]
        dst = link["target_id"]
        if src in block_ids and dst in block_ids:
            adjacency[src].append(dst)
            in_degree[dst] += 1

    # Ensure every block appears in in_degree even if degree 0.
    for b in blocks:
        if b["id"] not in in_degree:
            in_degree[b["id"]] = 0

    # Select seed nodes.
    all_ids = [b["id"] for b in blocks]

    if seed_strategy == "high_centrality":
        # Sort descending by in-degree; take top n_sequences (with repetition
        # if corpus is smaller).
        sorted_by_degree = sorted(all_ids, key=lambda bid: in_degree[bid], reverse=True)
        seed_pool = sorted_by_degree[:max(1, len(sorted_by_degree))]
    else:
        seed_pool = all_ids[:]
        rng.shuffle(seed_pool)

    sequences: list[dict] = []

    for i in range(n_sequences):
        seed_node = seed_pool[i % len(seed_pool)]
        seq = _bfs_sequence(seed_node, adjacency, max_len=sequence_length, rng=rng)
        sequences.append({"sequence": seq, "seed_id": seed_node})

    return sequences


def _bfs_sequence(
    root: str,
    adjacency: dict[str, list[str]],
    max_len: int,
    rng: random.Random,
) -> list[str]:
    """BFS from root, returning up to max_len block IDs (including root)."""
    visited: set[str] = {root}
    queue: deque[str] = deque([root])
    result: list[str] = []

    while queue and len(result) < max_len:
        node = queue.popleft()
        result.append(node)
        neighbors = adjacency.get(node, [])
        # Shuffle for non-deterministic breadth order among ties.
        shuffled = neighbors[:]
        rng.shuffle(shuffled)
        for nbr in shuffled:
            if nbr not in visited and len(result) + len(queue) < max_len:
                visited.add(nbr)
                queue.append(nbr)

    return result


# ---------------------------------------------------------------------------
# H2.1 — Contrastive curriculum (triplet loss)
# ---------------------------------------------------------------------------

def build_contrastive_curriculum(
    blocks: list[dict],
    links: list[dict],
    link_types: list[str] = None,
    confidence_threshold: float = 0.7,
) -> list[dict]:
    """
    H2.1: contrastive pairs from typed links.

    Positive pairs: blocks connected by 'supports' links with confidence ≥ threshold.
    Negative pairs: blocks connected by 'contradicts' links.

    Returns triplets:
        [{anchor_id, positive_id, negative_id,
          anchor_text, positive_text, negative_text}]

    Strategy:
    - For each (anchor, positive) pair from 'supports' links, find a block
      connected to anchor via 'contradicts' to serve as the hard negative.
    - Falls back to a random block if no contradicts neighbour exists.
    """
    if link_types is None:
        link_types = ["contradicts", "supports"]

    block_map: dict[str, dict] = {b["id"]: b for b in blocks}

    # Collect high-confidence supports and contradicts links.
    supports_pairs: list[tuple[str, str]] = []
    contradicts_map: dict[str, list[str]] = defaultdict(list)

    for link in links:
        src = link["source_id"]
        dst = link["target_id"]
        rel = link.get("rel_type", "")
        conf = float(link.get("confidence", 1.0))

        if src not in block_map or dst not in block_map:
            continue

        if rel == "supports" and conf >= confidence_threshold:
            supports_pairs.append((src, dst))
        if rel == "contradicts" and conf >= confidence_threshold:
            contradicts_map[src].append(dst)

    # Build triplets.
    triplets: list[dict] = []
    all_ids = list(block_map.keys())

    # Use a seeded random for stable fallback negatives.
    rng = random.Random(0)

    for anchor_id, positive_id in supports_pairs:
        # Hard negative: a contradicts neighbour of the anchor.
        if contradicts_map[anchor_id]:
            negative_id = rng.choice(contradicts_map[anchor_id])
        else:
            # Soft negative: random block (not anchor, not positive).
            candidates = [bid for bid in all_ids if bid != anchor_id and bid != positive_id]
            if not candidates:
                continue
            negative_id = rng.choice(candidates)

        anchor_text = block_map[anchor_id].get("text", "")
        positive_text = block_map[positive_id].get("text", "")
        negative_text = block_map[negative_id].get("text", "")

        triplets.append(
            {
                "anchor_id": anchor_id,
                "positive_id": positive_id,
                "negative_id": negative_id,
                "anchor_text": anchor_text,
                "positive_text": positive_text,
                "negative_text": negative_text,
            }
        )

    return triplets


# ---------------------------------------------------------------------------
# H2.4 — Version-delta curriculum
# ---------------------------------------------------------------------------

def build_version_delta_curriculum(
    blocks_v1: list[dict],
    blocks_v2: list[dict],   # same documents, different versions
    links: list[dict],
) -> list[dict]:
    """
    H2.4: version-delta test set.

    Positive pairs: same block ID appears in both v1 and v2, but the text
        changed (same UUID, different content).
    Negative pairs: blocks that did NOT change between versions, paired
        with a different block that has similar-length text.

    Returns:
        [{block_v1_id, block_v2_id, text_v1, text_v2,
          changed: bool, pair_type: "positive"|"negative"}]
    """
    v1_map: dict[str, dict] = {b["id"]: b for b in blocks_v1}
    v2_map: dict[str, dict] = {b["id"]: b for b in blocks_v2}

    shared_ids = set(v1_map.keys()) & set(v2_map.keys())

    changed_ids: list[str] = []
    unchanged_ids: list[str] = []

    for bid in shared_ids:
        text_v1 = v1_map[bid].get("text", "")
        text_v2 = v2_map[bid].get("text", "")
        if text_v1 != text_v2:
            changed_ids.append(bid)
        else:
            unchanged_ids.append(bid)

    pairs: list[dict] = []

    # Positive pairs: changed blocks.
    for bid in changed_ids:
        pairs.append(
            {
                "block_v1_id": bid,
                "block_v2_id": bid,
                "text_v1": v1_map[bid].get("text", ""),
                "text_v2": v2_map[bid].get("text", ""),
                "changed": True,
                "pair_type": "positive",
            }
        )

    # Negative pairs: unchanged blocks (paired with themselves across versions).
    rng = random.Random(42)
    unchanged_sample = unchanged_ids[:]
    rng.shuffle(unchanged_sample)

    for bid in unchanged_sample[: len(changed_ids)]:
        pairs.append(
            {
                "block_v1_id": bid,
                "block_v2_id": bid,
                "text_v1": v1_map[bid].get("text", ""),
                "text_v2": v2_map[bid].get("text", ""),
                "changed": False,
                "pair_type": "negative",
            }
        )

    return pairs
