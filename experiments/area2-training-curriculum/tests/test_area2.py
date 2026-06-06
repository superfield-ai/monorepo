"""
tests/test_area2.py — Unit tests for the Area 2 training curriculum experiment.

Test inventory (11 tests per issue spec):

 1. test_flat_curriculum_pair_count
 2. test_flat_curriculum_balanced
 3. test_bfs_walk_uses_high_degree_seeds
 4. test_bfs_walk_sequence_length
 5. test_contrastive_curriculum_has_triplets
 6. test_contrastive_curriculum_link_types
 7. test_link_density_ablation_structure
 8. test_higher_confidence_fewer_links
 9. test_link_type_ablation_structure
10. test_version_delta_curriculum_changed_blocks
11. test_finetuner_trains_without_error  (slow — skipped by default)

Tests 1–10 pass without GPU or network access.
Test 11 requires sentence-transformers; skipped by default (@pytest.mark.slow).
"""

from __future__ import annotations

import sys
import os

import pytest

# ---------------------------------------------------------------------------
# Ensure the parent directory (experiment root) is on sys.path so that the
# module-level imports work when pytest is invoked from any working directory.
# ---------------------------------------------------------------------------

_EXPERIMENT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _EXPERIMENT_ROOT not in sys.path:
    sys.path.insert(0, _EXPERIMENT_ROOT)


# ---------------------------------------------------------------------------
# Shared synthetic fixtures
# ---------------------------------------------------------------------------

def _make_blocks(n: int = 100, n_domains: int = 4) -> list[dict]:
    domains = ["legal", "medical", "research", "finance"]
    return [
        {
            "id": f"block_{i:04d}",
            "text": f"This is block number {i} about topic {i % 10}.",
            "domain": domains[i % n_domains],
        }
        for i in range(n)
    ]


def _make_links(blocks: list[dict], n_links: int = 200, seed: int = 42) -> list[dict]:
    """Build synthetic links with a mix of rel_types and confidence values."""
    import random
    rng = random.Random(seed)
    ids = [b["id"] for b in blocks]
    rel_types = ["cites", "supports", "contradicts", "elaborates", "is-exception-to"]
    link_layers = {
        "cites": "structural",
        "elaborates": "structural",
        "is-exception-to": "structural",
        "supports": "semantic",
        "contradicts": "semantic",
    }
    links = []
    for _ in range(n_links):
        src, dst = rng.sample(ids, 2)
        rel = rng.choice(rel_types)
        links.append(
            {
                "source_id": src,
                "target_id": dst,
                "rel_type": rel,
                "link_layer": link_layers.get(rel, "ai"),
                "confidence": round(rng.uniform(0.3, 1.0), 2),
            }
        )
    return links


# ---------------------------------------------------------------------------
# Test 1 — flat curriculum pair count
# ---------------------------------------------------------------------------

def test_flat_curriculum_pair_count():
    from curriculum_builder import build_flat_random_curriculum

    blocks = _make_blocks(50)
    pairs = build_flat_random_curriculum(blocks, n_pairs=500, seed=42)
    assert len(pairs) == 500, f"Expected 500 pairs, got {len(pairs)}"


# ---------------------------------------------------------------------------
# Test 2 — flat curriculum label balance
# ---------------------------------------------------------------------------

def test_flat_curriculum_balanced():
    from curriculum_builder import build_flat_random_curriculum

    # Use 2 domains so same-domain probability ≈ 50%, giving balanced labels.
    blocks = _make_blocks(200, n_domains=2)
    pairs = build_flat_random_curriculum(blocks, n_pairs=1_000, seed=7)

    n_positive = sum(1 for p in pairs if p["label"] == 1)
    ratio = n_positive / len(pairs)

    assert 0.40 <= ratio <= 0.60, (
        f"Label balance out of [40%, 60%] range: {ratio:.3f} ({n_positive}/{len(pairs)} positive)"
    )


# ---------------------------------------------------------------------------
# Test 3 — BFS walk uses high-degree seeds
# ---------------------------------------------------------------------------

def test_bfs_walk_uses_high_degree_seeds():
    from curriculum_builder import build_bfs_walk_curriculum
    from collections import defaultdict

    blocks = _make_blocks(50)
    ids = [b["id"] for b in blocks]

    # Manually make block_0010 a hub by giving it many incoming links.
    hub_id = "block_0010"
    links = []
    for i in range(40):
        if ids[i] != hub_id:
            links.append(
                {
                    "source_id": ids[i],
                    "target_id": hub_id,
                    "rel_type": "cites",
                    "link_layer": "structural",
                    "confidence": 0.9,
                }
            )
    # Add some random outgoing edges from the hub so BFS can traverse.
    for i in range(1, 10):
        links.append(
            {
                "source_id": hub_id,
                "target_id": ids[i],
                "rel_type": "cites",
                "link_layer": "structural",
                "confidence": 0.9,
            }
        )

    sequences = build_bfs_walk_curriculum(
        blocks=blocks,
        links=links,
        n_sequences=5,
        sequence_length=10,
        seed_strategy="high_centrality",
        seed=42,
    )

    assert sequences, "Expected at least one sequence"
    first_seed = sequences[0]["seed_id"]
    assert first_seed == hub_id, (
        f"Expected first seed to be high-degree hub '{hub_id}', got '{first_seed}'"
    )


# ---------------------------------------------------------------------------
# Test 4 — BFS walk sequence length constraint
# ---------------------------------------------------------------------------

def test_bfs_walk_sequence_length():
    from curriculum_builder import build_bfs_walk_curriculum

    blocks = _make_blocks(80)
    links = _make_links(blocks, n_links=300)

    max_len = 8
    sequences = build_bfs_walk_curriculum(
        blocks=blocks,
        links=links,
        n_sequences=50,
        sequence_length=max_len,
        seed_strategy="random",
        seed=42,
    )

    for seq in sequences:
        assert len(seq["sequence"]) <= max_len, (
            f"Sequence length {len(seq['sequence'])} exceeds limit {max_len}"
        )


# ---------------------------------------------------------------------------
# Test 5 — contrastive curriculum produces triplets
# ---------------------------------------------------------------------------

def test_contrastive_curriculum_has_triplets():
    from curriculum_builder import build_contrastive_curriculum

    blocks = _make_blocks(50)
    links = _make_links(blocks, n_links=200)

    triplets = build_contrastive_curriculum(
        blocks=blocks,
        links=links,
        link_types=["contradicts", "supports"],
        confidence_threshold=0.5,
    )

    assert len(triplets) > 0, "Expected at least one triplet"

    for t in triplets:
        for key in ("anchor_id", "positive_id", "negative_id"):
            assert key in t, f"Triplet missing key '{key}': {t}"


# ---------------------------------------------------------------------------
# Test 6 — contrastive curriculum link type semantics
# ---------------------------------------------------------------------------

def test_contrastive_curriculum_link_types():
    from curriculum_builder import build_contrastive_curriculum

    blocks = _make_blocks(30)
    ids = [b["id"] for b in blocks]

    # Create explicit supports and contradicts links.
    # supports: block_0000 → block_0001 (should form anchor/positive pair)
    # contradicts: block_0000 → block_0002 (should be used as negative)
    links = [
        {
            "source_id": ids[0],
            "target_id": ids[1],
            "rel_type": "supports",
            "link_layer": "semantic",
            "confidence": 0.9,
        },
        {
            "source_id": ids[0],
            "target_id": ids[2],
            "rel_type": "contradicts",
            "link_layer": "semantic",
            "confidence": 0.9,
        },
    ]

    triplets = build_contrastive_curriculum(
        blocks=blocks,
        links=links,
        link_types=["contradicts", "supports"],
        confidence_threshold=0.7,
    )

    assert len(triplets) >= 1, "Expected at least one triplet from supports link"

    # The positive pair must come from the supports link.
    t = triplets[0]
    assert t["anchor_id"] == ids[0], (
        f"Anchor should be the source of supports link, got {t['anchor_id']}"
    )
    assert t["positive_id"] == ids[1], (
        f"Positive should be the target of supports link, got {t['positive_id']}"
    )
    # The negative should be the contradicts target (ids[2]) since it exists.
    assert t["negative_id"] == ids[2], (
        f"Negative should be the contradicts target '{ids[2]}', got {t['negative_id']}"
    )


# ---------------------------------------------------------------------------
# Test 7 — link density ablation structure
# ---------------------------------------------------------------------------

def test_link_density_ablation_structure():
    from link_density_ablation import run_link_density_ablation

    blocks = _make_blocks(50)
    links = _make_links(blocks, n_links=300)

    def mock_eval(curriculum: list[dict]) -> float:
        return 0.8

    thresholds = [0.5, 0.7, 0.9]
    results = run_link_density_ablation(
        blocks=blocks,
        links=links,
        confidence_thresholds=thresholds,
        eval_fn=mock_eval,
        n_pairs=100,
        seed=42,
    )

    for thresh in thresholds:
        assert thresh in results, f"Threshold {thresh} missing from results"
        entry = results[thresh]
        for key in ("n_links_included", "n_pairs_generated", "eval_accuracy"):
            assert key in entry, f"Key '{key}' missing for threshold {thresh}"
        assert entry["eval_accuracy"] == 0.8


# ---------------------------------------------------------------------------
# Test 8 — higher confidence threshold → fewer links
# ---------------------------------------------------------------------------

def test_higher_confidence_fewer_links():
    from link_density_ablation import run_link_density_ablation

    blocks = _make_blocks(50)
    # Generate links with varied confidence so both thresholds have links.
    links = _make_links(blocks, n_links=500, seed=0)

    def mock_eval(curriculum: list[dict]) -> float:
        return 0.5

    results = run_link_density_ablation(
        blocks=blocks,
        links=links,
        confidence_thresholds=[0.5, 0.9],
        eval_fn=mock_eval,
        n_pairs=200,
        seed=42,
    )

    n_links_low = results[0.5]["n_links_included"]
    n_links_high = results[0.9]["n_links_included"]

    assert n_links_high < n_links_low, (
        f"Expected fewer links at threshold 0.9 ({n_links_high}) "
        f"than at 0.5 ({n_links_low})"
    )


# ---------------------------------------------------------------------------
# Test 9 — link type ablation structure
# ---------------------------------------------------------------------------

def test_link_type_ablation_structure():
    from link_type_ablation import run_link_type_ablation

    blocks = _make_blocks(60)
    links = _make_links(blocks, n_links=300)

    def mock_eval(curriculum: list[dict], task: str) -> float:
        return 0.75

    link_types = ["structural", "semantic", "ai"]
    results = run_link_type_ablation(
        blocks=blocks,
        links=links,
        link_types_to_test=link_types,
        eval_fn=mock_eval,
        seed=42,
    )

    for lt in link_types:
        assert lt in results, f"Link type '{lt}' missing from results"
        for key in ("reasoning_accuracy", "retrieval_accuracy"):
            assert key in results[lt], f"Key '{key}' missing for link type '{lt}'"

    assert "h2_3_signal" in results, "Missing 'h2_3_signal' key"
    assert isinstance(results["h2_3_signal"], str), "h2_3_signal must be a string"


# ---------------------------------------------------------------------------
# Test 10 — version delta curriculum: changed blocks appear as positive pairs
# ---------------------------------------------------------------------------

def test_version_delta_curriculum_changed_blocks():
    from curriculum_builder import build_version_delta_curriculum

    # Create 20 blocks in v1.
    blocks_v1 = _make_blocks(20)
    # In v2, alter blocks with even index.
    blocks_v2 = []
    changed_ids = set()
    for i, b in enumerate(blocks_v1):
        b2 = dict(b)
        if i % 2 == 0:
            b2["text"] = b["text"] + " [modified]"
            changed_ids.add(b["id"])
        blocks_v2.append(b2)

    links = _make_links(blocks_v1, n_links=50)

    pairs = build_version_delta_curriculum(
        blocks_v1=blocks_v1,
        blocks_v2=blocks_v2,
        links=links,
    )

    assert len(pairs) > 0, "Expected at least one pair"

    # Every positive pair should be a changed block.
    positive_ids = {p["block_v1_id"] for p in pairs if p["pair_type"] == "positive"}
    assert positive_ids.issubset(changed_ids), (
        f"Some positive pairs are not changed blocks: {positive_ids - changed_ids}"
    )
    # Positive pairs must have changed=True.
    for p in pairs:
        if p["pair_type"] == "positive":
            assert p["changed"] is True, f"Positive pair should have changed=True: {p}"

    # All changed blocks should appear as positive pairs.
    assert changed_ids == positive_ids, (
        f"Changed blocks not fully represented as positive pairs.\n"
        f"Changed: {changed_ids}\nPositive: {positive_ids}"
    )


# ---------------------------------------------------------------------------
# Test 11 — finetuner trains without error (slow, skipped by default)
# ---------------------------------------------------------------------------

@pytest.mark.slow
def test_finetuner_trains_without_error():
    """
    Smoke-test CurriculumFinetuner.train_classification() on a tiny dataset.

    Requires sentence-transformers to be installed.
    Skipped by default; run with: pytest -m slow
    """
    sentence_transformers = pytest.importorskip(
        "sentence_transformers",
        reason="sentence-transformers not installed",
    )

    from lm_finetuner import CurriculumFinetuner

    # 20 synthetic pairs.
    blocks = _make_blocks(20)
    pairs = [
        {
            "block_a_text": blocks[i]["text"],
            "block_b_text": blocks[j]["text"],
            "label": 1 if blocks[i]["domain"] == blocks[j]["domain"] else 0,
        }
        for i, j in [(0, 1), (0, 4), (1, 5), (2, 6), (3, 7),
                     (4, 8), (5, 9), (6, 10), (7, 11), (8, 12),
                     (9, 13), (10, 14), (11, 15), (12, 16), (13, 17),
                     (14, 18), (15, 19), (16, 17), (17, 18), (18, 19)]
    ]

    finetuner = CurriculumFinetuner(model_name="all-MiniLM-L6-v2", device="cpu")
    result = finetuner.train_classification(pairs, n_epochs=1)

    assert "final_loss" in result
    assert "training_time_sec" in result
    assert result["training_time_sec"] >= 0.0
    assert isinstance(result["final_loss"], float)
