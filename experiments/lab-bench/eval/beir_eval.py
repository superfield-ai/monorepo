"""
Run BEIR evaluation against a Nexum instance.

Evaluates Nexum's retrieval against BM25 (floor) and reports NDCG@10,
Recall@100, and MAP for each target dataset.

Usage:
  python eval/beir_eval.py \
    --nexum-url http://localhost:3000 \
    --datasets trec-covid hotpotqa fiqa \
    --output results/beir

Standard suite: trec-covid, hotpotqa, fiqa, dbpedia-entity, nfcorpus
Full BEIR: add msmarco, nq, quora, scifact, arguana, fever, climate-fever,
           scidocs, signal1m, trec-news, robust04
"""

from __future__ import annotations

import argparse
import json
import logging
from datetime import datetime
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger(__name__)

STANDARD_DATASETS = [
    "trec-covid",
    "hotpotqa",
    "fiqa",
    "dbpedia-entity",
    "nfcorpus",
]


def run_beir(
    nexum_url: str,
    datasets: list[str],
    output_dir: Path,
    query_mode: str = "semantic",
    top_k: int = 100,
    data_dir: str = "data/beir",
) -> dict:
    try:
        from beir import util
        from beir.datasets.data_loader import GenericDataLoader
        from beir.retrieval.evaluation import EvaluateRetrieval
    except ImportError:
        raise SystemExit("Install beir: pip install beir")

    from adapters.nexum_retriever import NexumRetriever

    output_dir.mkdir(parents=True, exist_ok=True)
    all_results: dict[str, dict] = {}

    for dataset in datasets:
        logger.info("=== BEIR dataset: %s ===", dataset)

        # Download dataset
        url = f"https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/{dataset}.zip"
        data_path = util.download_and_unzip(url, data_dir)
        corpus, queries, qrels = GenericDataLoader(data_folder=data_path).load(split="test")

        logger.info(
            "Corpus: %d docs, Queries: %d, QRels: %d",
            len(corpus),
            len(queries),
            len(qrels),
        )

        # Nexum retrieval
        retriever = NexumRetriever(
            nexum_url=nexum_url,
            query_mode=query_mode,
            top_k=top_k,
        )
        evaluator = EvaluateRetrieval(retriever, score_function="cos_sim", k_values=[1, 10, 100])
        results = evaluator.retrieve(corpus, queries)

        ndcg, _map, recall, precision = EvaluateRetrieval.evaluate(
            qrels, results, evaluator.k_values
        )

        dataset_results = {
            "dataset": dataset,
            "query_mode": query_mode,
            "n_corpus": len(corpus),
            "n_queries": len(queries),
            "ndcg@10": ndcg.get("NDCG@10", 0.0),
            "ndcg@1": ndcg.get("NDCG@1", 0.0),
            "ndcg@100": ndcg.get("NDCG@100", 0.0),
            "map@10": _map.get("MAP@10", 0.0),
            "recall@10": recall.get("Recall@10", 0.0),
            "recall@100": recall.get("Recall@100", 0.0),
        }
        all_results[dataset] = dataset_results

        # Write per-dataset result
        out_path = output_dir / f"{dataset}.json"
        out_path.write_text(json.dumps(dataset_results, indent=2))
        logger.info("NDCG@10: %.4f  Recall@100: %.4f", dataset_results["ndcg@10"], dataset_results["recall@100"])

    # Write summary
    summary = {
        "run_at": datetime.utcnow().isoformat() + "Z",
        "nexum_url": nexum_url,
        "query_mode": query_mode,
        "datasets": all_results,
        "mean_ndcg@10": sum(r["ndcg@10"] for r in all_results.values()) / len(all_results),
    }
    (output_dir / "summary.json").write_text(json.dumps(summary, indent=2))
    logger.info("Mean NDCG@10 across %d datasets: %.4f", len(datasets), summary["mean_ndcg@10"])
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description="Run BEIR evaluation against Nexum")
    parser.add_argument("--nexum-url", default="http://localhost:3000")
    parser.add_argument(
        "--datasets",
        nargs="+",
        default=STANDARD_DATASETS,
        help="BEIR dataset names",
    )
    parser.add_argument(
        "--query-mode",
        choices=["semantic", "fulltext", "graph"],
        default="semantic",
    )
    parser.add_argument("--top-k", type=int, default=100)
    parser.add_argument("--output", default="results/beir", type=Path)
    parser.add_argument("--data-dir", default="data/beir")
    args = parser.parse_args()

    run_beir(
        nexum_url=args.nexum_url,
        datasets=args.datasets,
        output_dir=args.output,
        query_mode=args.query_mode,
        top_k=args.top_k,
        data_dir=args.data_dir,
    )


if __name__ == "__main__":
    main()
