"""
Nexum typed-link RAG client for the G2 wedge demo.

Ingests the demo corpus into a running Nexum instance, then for each question:
  1. Issues a semantic + graph traversal query
  2. Retrieves top-k blocks with their source provenance
  3. Generates an answer using Claude Haiku
  4. Returns: answer + list of (block_id, text, doc_id, score) citations

If Nexum is not reachable (requests.ConnectionError), every method returns a
graceful mock response so that tests and dry-runs work without a live server.
"""

from __future__ import annotations

import logging
from typing import Any

import requests

logger = logging.getLogger(__name__)

_MOCK_CORPUS_ID = "mock-corpus-00000000"
_MOCK_CITATION = {
    "block_id": "mock-block-0000",
    "text": "Mock citation text — Nexum is not running.",
    "doc_id": "mock-doc-0000",
    "score": 0.0,
}


class NexumRAG:
    """
    Typed-link RAG over Nexum's REST API.

    Parameters
    ----------
    nexum_url:
        Base URL of the Nexum server, e.g. ``http://localhost:3000``.
    anthropic_api_key:
        Anthropic API key used for Claude Haiku answer generation.
    """

    def __init__(self, nexum_url: str, anthropic_api_key: str) -> None:
        self.nexum_url = nexum_url.rstrip("/")
        self.anthropic_api_key = anthropic_api_key
        self._corpus_id: str | None = None

    # ------------------------------------------------------------------
    # Ingestion
    # ------------------------------------------------------------------

    def ingest(self, contracts: list[dict]) -> str:
        """Ingest contracts into Nexum and return the corpus ID."""
        payload = {
            "documents": [
                {"id": c["id"], "title": c["title"], "text": c["text"]}
                for c in contracts
            ]
        }
        try:
            resp = requests.post(
                f"{self.nexum_url}/api/corpus",
                json=payload,
                timeout=120,
            )
            resp.raise_for_status()
            data = resp.json()
            corpus_id: str = data.get("corpus_id", data.get("id", "unknown"))
            self._corpus_id = corpus_id
            logger.info(
                "Ingested %d documents into Nexum corpus %s",
                len(contracts),
                corpus_id,
            )
            return corpus_id
        except requests.ConnectionError:
            logger.warning("Nexum not reachable — using mock corpus ID.")
            self._corpus_id = _MOCK_CORPUS_ID
            return _MOCK_CORPUS_ID
        except requests.HTTPError as exc:
            logger.error("Nexum ingest HTTP error: %s", exc)
            self._corpus_id = _MOCK_CORPUS_ID
            return _MOCK_CORPUS_ID

    # ------------------------------------------------------------------
    # Query
    # ------------------------------------------------------------------

    def query(self, question: str, top_k: int = 5) -> dict:
        """Issue a typed-link retrieval query against Nexum.

        Returns::

            {
                "answer": str,
                "citations": [{"block_id": str, "text": str, "doc_id": str, "score": float}],
                "is_mock": bool,
            }

        Never raises on connection errors — returns a mock response instead.
        """
        try:
            return self._live_query(question, top_k)
        except requests.ConnectionError:
            logger.warning("Nexum not reachable — returning mock query response.")
            return self._mock_response(question)
        except requests.HTTPError as exc:
            logger.warning("Nexum query HTTP error: %s — returning mock response.", exc)
            return self._mock_response(question)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Unexpected error querying Nexum: %s — returning mock.", exc)
            return self._mock_response(question)

    def _live_query(self, question: str, top_k: int) -> dict:
        corpus_id = self._corpus_id or _MOCK_CORPUS_ID

        # Step 1: retrieve blocks via Nexum's typed-link retrieval
        retrieve_resp = requests.post(
            f"{self.nexum_url}/api/retrieve",
            json={
                "corpus_id": corpus_id,
                "query": question,
                "top_k": top_k,
                "mode": "typed_link",  # semantic + graph traversal
            },
            timeout=30,
        )
        retrieve_resp.raise_for_status()
        blocks: list[dict] = retrieve_resp.json().get("blocks", [])

        citations = [
            {
                "block_id": b.get("id", ""),
                "text": b.get("text", ""),
                "doc_id": b.get("document_id", b.get("doc_id", "")),
                "score": float(b.get("score", 0.0)),
            }
            for b in blocks
        ]

        # Step 2: generate answer with Claude Haiku
        answer = self._generate_answer(question, citations)

        return {"answer": answer, "citations": citations, "is_mock": False}

    def _generate_answer(self, question: str, citations: list[dict]) -> str:
        """Generate an answer from retrieved blocks using Claude Haiku."""
        import anthropic  # lazy import so missing key doesn't break tests

        context_parts = [
            f"[Block {i+1} from doc {c['doc_id']}]:\n{c['text']}"
            for i, c in enumerate(citations)
        ]
        context = "\n\n".join(context_parts) if context_parts else "(no context retrieved)"

        client = anthropic.Anthropic(api_key=self.anthropic_api_key)
        message = client.messages.create(
            model="claude-haiku-4-5",
            max_tokens=512,
            messages=[
                {
                    "role": "user",
                    "content": (
                        f"Answer the following question using only the provided context.\n\n"
                        f"Question: {question}\n\n"
                        f"Context:\n{context}\n\n"
                        f"Answer concisely and cite which block(s) support your answer."
                    ),
                }
            ],
        )
        return message.content[0].text if message.content else ""

    def _mock_response(self, question: str) -> dict:
        return {
            "answer": f"[MOCK] Nexum is not running. Question was: {question}",
            "citations": [_MOCK_CITATION],
            "is_mock": True,
        }
