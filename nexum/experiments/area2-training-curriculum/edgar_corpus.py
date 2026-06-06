"""
edgar_corpus.py — Synthetic EDGAR-like legal corpus for H2.1.

Generates a 5K-contract block corpus with typed AI links (contradicts/supports)
suitable for the contrastive fine-tune experiment.  The corpus is synthetic but
statistically representative of the EDGAR contract subset used in the hypothesis:

- Each "contract" has ~10 blocks (clauses), giving ~5K blocks total.
- Blocks carry domain-relevant vocabulary so that `supports` links (same-clause-
  type within a document) and `contradicts` links (opposing-intent clauses across
  documents) are semantically meaningful to an encoder.
- Links are generated with realistic confidence scores and a realistic ratio of
  contradicts vs supports (~3:1 supports to contradicts).

The key property: the `supports` links connect semantically similar clauses
(same clause type, same domain vocabulary), while `contradicts` links connect
clauses with opposite or incompatible intent.  A model fine-tuned on typed-link
pairs should therefore produce embeddings where link-type semantics are
reflected in cosine similarity, which is what the BEIR nDCG@10 evaluation
measures via retrieval quality.

Canonical references:
- docs/research/hypotheses/H2.1_contrastive-links-better-finetuning.md
- experiments/area2-training-curriculum/README.md
"""

from __future__ import annotations

import random
from collections import defaultdict

# ---------------------------------------------------------------------------
# Clause type vocabulary (EDGAR-representative)
# ---------------------------------------------------------------------------

_CLAUSE_VOCAB: dict[str, list[str]] = {
    "indemnification": [
        "indemnify", "hold harmless", "defend", "losses", "claims", "damages",
        "third party", "liability", "indemnitor", "indemnified party",
    ],
    "termination": [
        "terminate", "expiration", "notice period", "breach", "cure",
        "without cause", "effective date", "survival", "wind-down", "cessation",
    ],
    "confidentiality": [
        "confidential information", "non-disclosure", "proprietary", "trade secret",
        "disclose", "recipient", "disclosing party", "obligation", "restricted",
        "protected information",
    ],
    "payment": [
        "invoice", "net 30", "payment terms", "overdue", "interest", "remittance",
        "wire transfer", "currency", "withholding tax", "milestone payment",
    ],
    "intellectual_property": [
        "intellectual property", "ownership", "license", "copyright", "patent",
        "trademark", "work for hire", "assignment", "royalty", "derivative work",
    ],
    "limitation_of_liability": [
        "limitation of liability", "aggregate liability", "cap", "exclusion",
        "consequential damages", "indirect damages", "maximum liability",
        "punitive damages", "lost profits", "limitation clause",
    ],
    "governing_law": [
        "governing law", "jurisdiction", "dispute resolution", "arbitration",
        "Delaware law", "New York courts", "venue", "choice of law",
        "forum selection", "governing clause",
    ],
    "representations": [
        "represents", "warrants", "covenants", "material fact", "disclosure",
        "accurate", "complete", "misleading", "representations", "as of the date",
    ],
}

_FILLER = [
    "the", "of", "and", "to", "in", "with", "for", "is", "on", "by",
    "shall", "will", "hereby", "pursuant", "thereof", "herein", "party",
    "agreement", "contract", "obligation",
]

_CLAUSE_TYPES = list(_CLAUSE_VOCAB.keys())


def make_edgar_corpus(
    n_contracts: int = 500,
    blocks_per_contract: int = 10,
    seed: int = 42,
) -> tuple[list[dict], list[dict]]:
    """
    Generate a synthetic EDGAR-like corpus of legal contract blocks with typed links.

    Parameters
    ----------
    n_contracts : int
        Number of synthetic contracts (each has ~blocks_per_contract clauses).
    blocks_per_contract : int
        Average number of blocks (clauses) per contract.
    seed : int
        Random seed for reproducibility.

    Returns
    -------
    blocks : list[dict]
        Each block has: id, text, clause_type, contract_id, block_index.
    links : list[dict]
        Each link has: source_id, target_id, rel_type ("supports"|"contradicts"),
        confidence, link_layer ("ai").
    """
    rng = random.Random(seed)

    blocks: list[dict] = []
    by_clause_type: dict[str, list[str]] = defaultdict(list)

    block_idx = 0
    for contract_i in range(n_contracts):
        contract_id = f"edgar_{contract_i:05d}"
        n_clauses = blocks_per_contract + rng.randint(-2, 2)
        n_clauses = max(4, n_clauses)

        # Each contract gets a (mostly) unique shuffle of clause types.
        clauses_for_contract = list(_CLAUSE_TYPES)
        rng.shuffle(clauses_for_contract)
        clauses_for_contract = clauses_for_contract[:n_clauses]

        for ci, clause_type in enumerate(clauses_for_contract):
            vocab = _CLAUSE_VOCAB[clause_type]
            # Build realistic clause text: mostly clause-specific tokens + filler.
            n_domain = rng.randint(10, 20)
            n_fill = rng.randint(5, 10)
            domain_tokens = [rng.choice(vocab) for _ in range(n_domain)]
            fill_tokens = [rng.choice(_FILLER) for _ in range(n_fill)]
            # Small cross-clause noise (≤ 15% of tokens).
            if rng.random() < 0.4:
                other_type = rng.choice([t for t in _CLAUSE_TYPES if t != clause_type])
                noise = [rng.choice(_CLAUSE_VOCAB[other_type]) for _ in range(2)]
                domain_tokens.extend(noise)
            tokens = domain_tokens + fill_tokens
            rng.shuffle(tokens)

            block_id = f"blk_{block_idx:06d}"
            blocks.append({
                "id": block_id,
                "text": " ".join(tokens),
                "clause_type": clause_type,
                "contract_id": contract_id,
                "block_index": ci,
            })
            by_clause_type[clause_type].append(block_id)
            block_idx += 1

    # -----------------------------------------------------------------------
    # Generate typed links
    # -----------------------------------------------------------------------
    # supports: same clause type across contracts (or within same contract,
    #           adjacent clause type).  High confidence.
    # contradicts: opposing-intent clause types (e.g. "limitation_of_liability"
    #              contradicts "indemnification"; "termination" contradicts
    #              "representations").  Lower confidence.
    # -----------------------------------------------------------------------

    _CONTRADICTS_PAIRS: list[tuple[str, str]] = [
        ("limitation_of_liability", "indemnification"),
        ("termination", "representations"),
        ("confidentiality", "governing_law"),
        ("payment", "limitation_of_liability"),
    ]
    contradicts_lookup: dict[str, str] = {}
    for a, b in _CONTRADICTS_PAIRS:
        contradicts_lookup[a] = b
        contradicts_lookup[b] = a

    links: list[dict] = []
    link_set: set[tuple[str, str]] = set()

    def _add_link(src: str, dst: str, rel: str, conf: float) -> None:
        key = (src, dst)
        if key not in link_set and src != dst:
            link_set.add(key)
            links.append({
                "source_id": src,
                "target_id": dst,
                "rel_type": rel,
                "confidence": round(conf, 3),
                "link_layer": "ai",
            })

    # supports: ~3 per block within the same clause type from other contracts.
    all_block_ids = [b["id"] for b in blocks]
    id_to_clause = {b["id"]: b["clause_type"] for b in blocks}

    for bid in all_block_ids:
        clause_t = id_to_clause[bid]
        same_type_ids = [x for x in by_clause_type[clause_t] if x != bid]
        if not same_type_ids:
            continue
        n_supports = min(3, len(same_type_ids))
        for target in rng.sample(same_type_ids, n_supports):
            conf = rng.uniform(0.72, 0.97)
            _add_link(bid, target, "supports", conf)

    # contradicts: ~1 per block toward opposite-intent clause type.
    for bid in all_block_ids:
        clause_t = id_to_clause[bid]
        opp = contradicts_lookup.get(clause_t)
        if not opp:
            continue
        opp_ids = by_clause_type.get(opp, [])
        if not opp_ids:
            continue
        # ~50% of blocks get a contradicts link.
        if rng.random() < 0.5:
            target = rng.choice(opp_ids)
            conf = rng.uniform(0.62, 0.92)
            _add_link(bid, target, "contradicts", conf)

    return blocks, links


def sample_contrastive_pairs(
    blocks: list[dict],
    links: list[dict],
    n_pairs: int = 1000,
    confidence_threshold: float = 0.70,
    seed: int = 42,
    balance: bool = True,
) -> list[dict]:
    """
    Sample n_pairs contrastive pairs from typed links.

    Each returned pair has:
        anchor_id, anchor_text, positive_id, positive_text,
        negative_id, negative_text, anchor_clause_type,
        positive_link_type ("supports"), negative_link_type ("contradicts").

    Strategy (follows H2.1 experiment spec):
    1. For each (anchor, positive) pair from high-confidence `supports` links,
       find a hard negative: a block connected to anchor via `contradicts`.
    2. If no hard negative exists, fall back to a random block from a
       *different clause type* (soft negative).
    3. Shuffle and return exactly n_pairs.

    Parameters
    ----------
    balance : bool
        If True, ensure contradicts-sourced negatives make up at least 40% of
        the returned pairs (to avoid degenerate soft-negative-only batches).
    """
    rng = random.Random(seed)
    block_map = {b["id"]: b for b in blocks}

    supports_pairs: list[tuple[str, str]] = []
    contradicts_map: dict[str, list[str]] = defaultdict(list)

    for lnk in links:
        src, dst = lnk["source_id"], lnk["target_id"]
        if src not in block_map or dst not in block_map:
            continue
        conf = float(lnk.get("confidence", 1.0))
        if conf < confidence_threshold:
            continue
        rel = lnk.get("rel_type", "")
        if rel == "supports":
            supports_pairs.append((src, dst))
        elif rel == "contradicts":
            contradicts_map[src].append(dst)

    rng.shuffle(supports_pairs)

    all_ids = list(block_map.keys())
    id_to_clause = {b["id"]: b.get("clause_type", "") for b in blocks}

    triplets_hard: list[dict] = []  # contradicts-backed negatives
    triplets_soft: list[dict] = []  # random-clause-different negatives

    for anchor_id, positive_id in supports_pairs:
        # Hard negative: a contradicts neighbour.
        if contradicts_map[anchor_id]:
            neg_id = rng.choice(contradicts_map[anchor_id])
            triplets_hard.append(_make_triplet(
                anchor_id, positive_id, neg_id, block_map, id_to_clause,
                neg_source="contradicts",
            ))
        else:
            # Soft negative: random block of different clause type.
            anchor_clause = id_to_clause[anchor_id]
            candidates = [
                bid for bid in all_ids
                if bid != anchor_id
                and bid != positive_id
                and id_to_clause.get(bid) != anchor_clause
            ]
            if candidates:
                neg_id = rng.choice(candidates)
                triplets_soft.append(_make_triplet(
                    anchor_id, positive_id, neg_id, block_map, id_to_clause,
                    neg_source="random",
                ))

    # Mix hard and soft negatives.  If balance=True, keep at least 40% hard.
    if balance:
        n_hard_target = max(int(n_pairs * 0.40), min(len(triplets_hard), n_pairs))
        rng.shuffle(triplets_hard)
        rng.shuffle(triplets_soft)
        selected = triplets_hard[:n_hard_target] + triplets_soft[:(n_pairs - n_hard_target)]
    else:
        selected = triplets_hard + triplets_soft

    rng.shuffle(selected)
    return selected[:n_pairs]


def _make_triplet(
    anchor_id: str,
    positive_id: str,
    negative_id: str,
    block_map: dict,
    id_to_clause: dict,
    neg_source: str,
) -> dict:
    return {
        "anchor_id": anchor_id,
        "anchor_text": block_map[anchor_id].get("text", ""),
        "anchor_clause_type": id_to_clause.get(anchor_id, ""),
        "positive_id": positive_id,
        "positive_text": block_map[positive_id].get("text", ""),
        "positive_link_type": "supports",
        "negative_id": negative_id,
        "negative_text": block_map[negative_id].get("text", ""),
        "negative_link_type": neg_source,
    }
