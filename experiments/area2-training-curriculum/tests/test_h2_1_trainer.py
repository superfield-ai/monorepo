"""
tests/test_h2_1_trainer.py — Smoke tests for the H2.1 head-to-head trainer.

Fast (≤ 5 s on CPU). Confirms:
  - structured corpus generates `supports` links connecting same-domain blocks
    (the curriculum's only signal source);
  - the three orderings each return a permutation of the block indices;
  - the head-to-head returns a verdict in the documented enum.
"""

from __future__ import annotations

import os
import sys

import pytest

_HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_REPO = os.path.dirname(os.path.dirname(_HERE))
for p in (_REPO, _HERE):
    if p not in sys.path:
        sys.path.insert(0, p)


def test_structured_corpus_supports_are_same_domain():
    from h2_1_curriculum_trainer import make_structured_corpus

    blocks, links = make_structured_corpus(n_blocks=200, seed=0)
    domain = {b["id"]: b["domain"] for b in blocks}
    supports = [ln for ln in links if ln["rel_type"] == "supports"]
    assert supports, "expected supports links in structured corpus"
    same = sum(1 for ln in supports if domain[ln["source_id"]] == domain[ln["target_id"]])
    # Every supports edge is constructed within a domain bucket — it should be 100%.
    assert same == len(supports), (
        f"supports links should connect same-domain blocks; got {same}/{len(supports)}"
    )


def test_orderings_are_permutations():
    from h2_1_curriculum_trainer import (
        make_structured_corpus,
        curriculum_order,
        interleaved_curriculum_order,
        random_order,
    )

    blocks, links = make_structured_corpus(n_blocks=120, seed=1)
    n = len(blocks)
    for label, order in [
        ("bfs", curriculum_order(blocks, links, seed=1)),
        ("interleaved", interleaved_curriculum_order(blocks, links, seed=1)),
        ("random", random_order(n, seed=1)),
    ]:
        assert sorted(order) == list(range(n)), f"{label} ordering is not a permutation"


def test_compare_returns_known_verdict():
    from h2_1_curriculum_trainer import compare_curriculum_vs_random

    cmp = compare_curriculum_vs_random(n_blocks=200, seeds=[0, 1], n_epochs=2)
    assert cmp.verdict in {"curriculum_better", "random_better", "tie"}
    assert cmp.verdict_basis in {"bfs", "interleaved"}
    # All three orderings produce a number in [0, 1].
    for arm in (cmp.curriculum_bfs, cmp.curriculum_interleaved, cmp.random):
        v = arm["final_eval_acc_mean"]
        assert 0.0 <= v <= 1.0, f"out-of-range eval acc: {v}  arm={arm}"
        assert arm["n_runs"] == 2
