"""
BEIR-compatible retriever adapter for Nexum.

Usage with BEIR:
    from beir.retrieval.evaluation import EvaluateRetrieval
    from adapters.nexum_retriever import NexumRetriever

    retriever = NexumRetriever(nexum_url="http://localhost:3000", corpus_id="my-corpus")
    evaluator = EvaluateRetrieval(retriever)
    results = evaluator.retrieve(corpus, queries)
    ndcg, _map, recall, precision = EvaluateRetrieval.evaluate(qrels, results, [1, 10, 100])
"""

from __future__ import annotations

import logging
from typing import Any

import requests

logger = logging.getLogger(__name__)


class NexumRetriever:
    """
    Implements BEIR's BaseRetriever interface over Nexum's query API.

    The adapter ingests the BEIR corpus into a Nexum corpus on first call
    (if the corpus does not already exist), then issues Nexum semantic-search
    queries for each BEIR query and maps the ranked block results back to
    BEIR document IDs.
    """

    def __init__(
        self,
        nexum_url: str = "http://localhost:3000",
        corpus_id: str | None = None,
        api_key: str | None = None,
        query_mode: str = "semantic",
        top_k: int = 100,
        batch_size: int = 64,
    ) -> None:
        """
        Args:
            nexum_url: Base URL of the running Nexum API.
            corpus_id: Nexum corpus ID to query. If None, a new corpus is
                       created during `ingest()`.
            api_key: Bearer token for Nexum authentication.
            query_mode: One of "semantic", "fulltext", "graph".
            top_k: Number of results to return per query.
            batch_size: Ingestion batch size (documents per request).
        """
        self.nexum_url = nexum_url.rstrip("/")
        self.corpus_id = corpus_id
        self.top_k = top_k
        self.query_mode = query_mode
        self.batch_size = batch_size
        self._session = requests.Session()
        if api_key:
            self._session.headers["Authorization"] = f"Bearer {api_key}"

    # ------------------------------------------------------------------
    # BEIR interface
    # ------------------------------------------------------------------

    def search(
        self,
        corpus: dict[str, dict[str, str]],
        queries: dict[str, str],
        top_k: int,
        **kwargs: Any,
    ) -> dict[str, dict[str, float]]:
        """
        BEIR retrieval entry point. Called by EvaluateRetrieval.retrieve().

        Args:
            corpus: {doc_id: {"title": ..., "text": ...}}
            queries: {query_id: query_text}
            top_k: number of docs to return per query

        Returns:
            {query_id: {doc_id: score}}
        """
        if self.corpus_id is None:
            self.corpus_id = self._ingest_corpus(corpus)

        results: dict[str, dict[str, float]] = {}
        for qid, qtext in queries.items():
            hits = self._query(qtext, top_k or self.top_k)
            results[qid] = hits
        return results

    # ------------------------------------------------------------------
    # Ingestion
    # ------------------------------------------------------------------

    def _ingest_corpus(self, corpus: dict[str, dict[str, str]]) -> str:
        """Ingest a BEIR corpus into Nexum. Returns the corpus ID."""
        resp = self._session.post(
            f"{self.nexum_url}/corpora",
            json={"name": "beir-corpus", "description": "BEIR evaluation corpus"},
        )
        resp.raise_for_status()
        corpus_id: str = resp.json()["id"]
        logger.info("Created Nexum corpus %s", corpus_id)

        doc_ids = list(corpus.keys())
        for i in range(0, len(doc_ids), self.batch_size):
            batch = doc_ids[i : i + self.batch_size]
            for doc_id in batch:
                doc = corpus[doc_id]
                text = f"{doc.get('title', '')}\n\n{doc.get('text', '')}".strip()
                ingest_resp = self._session.post(
                    f"{self.nexum_url}/documents",
                    json={
                        "corpus_id": corpus_id,
                        "external_id": doc_id,
                        "content": text,
                        "format": "text",
                    },
                )
                ingest_resp.raise_for_status()
            logger.info(
                "Ingested %d / %d documents", min(i + self.batch_size, len(doc_ids)), len(doc_ids)
            )

        return corpus_id

    # ------------------------------------------------------------------
    # Query
    # ------------------------------------------------------------------

    def _query(self, query_text: str, top_k: int) -> dict[str, float]:
        """
        Issue a Nexum query and map block results to BEIR doc IDs.

        Returns {doc_id: score} where score is the Nexum relevance score
        (cosine similarity for semantic mode, BM25 rank score for fulltext).
        """
        resp = self._session.post(
            f"{self.nexum_url}/query",
            json={
                "corpus_id": self.corpus_id,
                "query": query_text,
                "mode": self.query_mode,
                "limit": top_k,
            },
        )
        resp.raise_for_status()
        blocks = resp.json().get("results", [])

        # Nexum returns blocks with a `document.external_id` field that maps
        # back to the BEIR doc_id used during ingestion.
        doc_scores: dict[str, float] = {}
        for block in blocks:
            doc_id = block.get("document", {}).get("external_id")
            score = float(block.get("score", 0.0))
            if doc_id and (doc_id not in doc_scores or score > doc_scores[doc_id]):
                doc_scores[doc_id] = score
        return doc_scores
