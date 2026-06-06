"""
OGB ogbl-biokg link prediction evaluation.

ogbl-biokg is a heterogeneous biomedical knowledge graph with ~93k entities
across 5 types (disease, drug, function, protein, sideeffect) and ~51M edges
across 51 relation types.  It is the closest structural analogue to Nexum's
typed-link graph.

Published gHAWK baseline (Shen et al., 2024): MRR ≈ 0.900
OGB leaderboard: https://ogb.stanford.edu/docs/linkprop/#ogbl-biokg

This script:
1. Loads ogbl-biokg via the OGB Python API.
2. Optionally (``--ingest``): converts the graph to Nexum blocks + typed links
   and ingests them before evaluation.
3. For each test edge (head, relation, tail): queries Nexum's graph-traversal
   API to rank candidate tail entities.
4. Computes MRR, Hits@1, Hits@3, Hits@10.

Without ``--ingest`` the script assumes the biokg corpus is already in Nexum.

Usage::

    # First time (ingest + eval):
    python eval/ogb_eval.py --nexum-url http://localhost:3000 \\
        --ingest --max-test-edges 1000 --output results/ogb

    # Subsequent runs (corpus already ingested):
    python eval/ogb_eval.py --nexum-url http://localhost:3000 \\
        --corpus-id <id> --max-test-edges 1000 --output results/ogb
"""

from __future__ import annotations

import argparse
import json
import logging
import math
from pathlib import Path
from typing import Any

import numpy as np
import requests

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger(__name__)

# gHAWK published baseline for reference in result output.
_GHAWK_MRR = 0.900


# ---------------------------------------------------------------------------
# Metric helpers
# ---------------------------------------------------------------------------

def hits_at_k(ranks: list[int], k: int) -> float:
    """
    Fraction of queries where the true entity appears within rank *k*.

    Parameters
    ----------
    ranks:
        List of 1-indexed ranks for each query.
    k:
        Cut-off rank.
    """
    if not ranks:
        return 0.0
    return sum(1 for r in ranks if r <= k) / len(ranks)


def compute_mrr_and_hits(
    ranks: list[int],
) -> tuple[float, float, float, float]:
    """
    Compute MRR, Hits@1, Hits@3, Hits@10 from a list of 1-indexed ranks.

    Returns
    -------
    (mrr, hits@1, hits@3, hits@10)
    """
    if not ranks:
        return 0.0, 0.0, 0.0, 0.0
    mrr = sum(1.0 / r for r in ranks) / len(ranks)
    h1 = hits_at_k(ranks, k=1)
    h3 = hits_at_k(ranks, k=3)
    h10 = hits_at_k(ranks, k=10)
    return mrr, h1, h3, h10


# ---------------------------------------------------------------------------
# Nexum ingestion helpers
# ---------------------------------------------------------------------------

def _entity_block_id(entity_type: str, entity_id: int) -> str:
    return f"biokg-{entity_type}-{entity_id}"


def ingest_biokg(
    nexum_url: str,
    dataset: Any,
    session: requests.Session,
    batch_size: int = 256,
) -> str:
    """
    Ingest ogbl-biokg into Nexum as blocks (entities) + typed links (edges).

    Returns the Nexum corpus ID.
    """
    graph = dataset.graph  # ogb returns a dict with 'edge_index_dict', etc.
    entity_types: list[str] = dataset.graph["node_feat_dict"].keys() if "node_feat_dict" in graph else []

    # Create corpus
    resp = session.post(
        f"{nexum_url}/corpora",
        json={
            "name": "ogbl-biokg",
            "description": "OGB biomedical knowledge graph for link-prediction eval",
        },
    )
    resp.raise_for_status()
    corpus_id: str = resp.json()["id"]
    logger.info("Created corpus %s", corpus_id)

    # Ingest entities as blocks
    num_nodes: dict[str, int] = graph.get("num_nodes_dict", {})
    for etype, n in num_nodes.items():
        logger.info("Ingesting %d %s entities…", n, etype)
        for start in range(0, n, batch_size):
            batch_blocks = [
                {
                    "external_id": _entity_block_id(etype, i),
                    "content": f"{etype} entity {i}",
                    "metadata": {"entity_type": etype, "entity_id": i},
                }
                for i in range(start, min(start + batch_size, n))
            ]
            r = session.post(
                f"{nexum_url}/blocks/batch",
                json={"corpus_id": corpus_id, "blocks": batch_blocks},
            )
            r.raise_for_status()

    # Ingest edges as typed links
    edge_index_dict: dict[tuple, Any] = graph.get("edge_index_dict", {})
    for (src_type, rel_type, dst_type), edge_index in edge_index_dict.items():
        heads = edge_index[0].tolist()
        tails = edge_index[1].tolist()
        logger.info(
            "Ingesting %d (%s, %s, %s) edges…",
            len(heads),
            src_type,
            rel_type,
            dst_type,
        )
        for start in range(0, len(heads), batch_size):
            batch_links = [
                {
                    "source_external_id": _entity_block_id(src_type, heads[j]),
                    "target_external_id": _entity_block_id(dst_type, tails[j]),
                    "link_type": rel_type,
                    "metadata": {
                        "src_type": src_type,
                        "dst_type": dst_type,
                    },
                }
                for j in range(start, min(start + batch_size, len(heads)))
            ]
            r = session.post(
                f"{nexum_url}/links/batch",
                json={"corpus_id": corpus_id, "links": batch_links},
            )
            r.raise_for_status()

    logger.info("Ingestion complete. Corpus: %s", corpus_id)
    return corpus_id


# ---------------------------------------------------------------------------
# Rank computation via Nexum graph traversal
# ---------------------------------------------------------------------------

def rank_tail_entity(
    nexum_url: str,
    corpus_id: str,
    head_external_id: str,
    relation: str,
    true_tail_external_id: str,
    num_candidates: int,
    session: requests.Session,
) -> int:
    """
    Query Nexum for candidate tail entities reachable from *head* via
    *relation*.  Returns the 1-indexed rank of *true_tail* in the result list.

    If *true_tail* is not in the results, returns *num_candidates* + 1 (worst rank).
    """
    resp = session.post(
        f"{nexum_url}/graph/traverse",
        json={
            "corpus_id": corpus_id,
            "start_block_external_id": head_external_id,
            "link_type": relation,
            "limit": num_candidates,
        },
    )
    resp.raise_for_status()
    results = resp.json().get("results", [])

    for rank, block in enumerate(results, start=1):
        if block.get("external_id") == true_tail_external_id:
            return rank

    return num_candidates + 1  # not found → worst possible rank


# ---------------------------------------------------------------------------
# Main eval
# ---------------------------------------------------------------------------

def run_eval(
    nexum_url: str,
    output_dir: Path,
    corpus_id: str | None = None,
    ingest: bool = False,
    max_test_edges: int | None = None,
    num_candidates: int = 500,
) -> dict[str, Any]:
    output_dir.mkdir(parents=True, exist_ok=True)
    session = requests.Session()

    from ogb.linkproppred import LinkPropPredDataset  # lazy import

    logger.info("Loading ogbl-biokg dataset…")
    dataset = LinkPropPredDataset(name="ogbl-biokg")

    if ingest or corpus_id is None:
        corpus_id = ingest_biokg(nexum_url, dataset, session)
        (output_dir / "corpus_id.txt").write_text(corpus_id)

    split_edge = dataset.get_edge_split()
    test_edges = split_edge["test"]

    # ogbl-biokg test edges are stored per (src_type, rel, dst_type) triple
    all_ranks: list[int] = []
    detail_rows: list[dict[str, Any]] = []
    n_evaluated = 0

    for triple_key, edges in test_edges.items():
        src_type, rel_type, dst_type = triple_key

        # edges is a dict with 'head', 'tail', 'head_neg', 'tail_neg'
        heads = edges["head"].tolist()
        tails = edges["tail"].tolist()

        for i in range(len(heads)):
            if max_test_edges and n_evaluated >= max_test_edges:
                break

            head_eid = _entity_block_id(src_type, heads[i])
            tail_eid = _entity_block_id(dst_type, tails[i])

            rank = rank_tail_entity(
                nexum_url,
                corpus_id,
                head_eid,
                rel_type,
                tail_eid,
                num_candidates,
                session,
            )
            all_ranks.append(rank)
            detail_rows.append(
                {
                    "triple": [head_eid, rel_type, tail_eid],
                    "rank": rank,
                }
            )
            n_evaluated += 1

        if max_test_edges and n_evaluated >= max_test_edges:
            break

    mrr, h1, h3, h10 = compute_mrr_and_hits(all_ranks)

    summary: dict[str, Any] = {
        "n_test_edges": n_evaluated,
        "corpus_id": corpus_id,
        "mrr": mrr,
        "hits@1": h1,
        "hits@3": h3,
        "hits@10": h10,
        "ghawk_baseline_mrr": _GHAWK_MRR,
        "mrr_vs_ghawk": mrr - _GHAWK_MRR,
    }
    (output_dir / "ogb_summary.json").write_text(json.dumps(summary, indent=2))

    detail_path = output_dir / "ogb_detail.jsonl"
    with detail_path.open("w") as df:
        for row in detail_rows:
            df.write(json.dumps(row) + "\n")

    logger.info(
        "MRR: %.4f  Hits@1: %.4f  Hits@3: %.4f  Hits@10: %.4f  "
        "(gHAWK baseline MRR: %.3f)",
        mrr,
        h1,
        h3,
        h10,
        _GHAWK_MRR,
    )
    return summary


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="OGB ogbl-biokg link-prediction eval against Nexum")
    parser.add_argument("--nexum-url", default="http://localhost:3000")
    parser.add_argument(
        "--corpus-id",
        default=None,
        help="Existing Nexum corpus ID. Implies --no-ingest.",
    )
    parser.add_argument(
        "--ingest",
        action="store_true",
        default=False,
        help="Convert the OGB graph to Nexum blocks+links and ingest before eval.",
    )
    parser.add_argument(
        "--max-test-edges",
        type=int,
        default=None,
        help="Limit number of test edges evaluated (useful for quick runs).",
    )
    parser.add_argument(
        "--num-candidates",
        type=int,
        default=500,
        help="Number of candidate tails to rank per query.",
    )
    parser.add_argument("--output", default="results/ogb", type=Path)
    args = parser.parse_args()

    run_eval(
        nexum_url=args.nexum_url,
        output_dir=args.output,
        corpus_id=args.corpus_id,
        ingest=args.ingest,
        max_test_edges=args.max_test_edges,
        num_candidates=args.num_candidates,
    )


if __name__ == "__main__":
    main()
