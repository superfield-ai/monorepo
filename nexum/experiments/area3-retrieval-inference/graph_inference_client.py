"""
graph_inference_client.py — Minimal graph-inference client for Area 3.

Implements the retrieval-augmented inference forward pass:
    ANN retrieval → typed-link graph traversal → block aggregation → LM generation.

Talks to the Nexum REST API; falls back to mock responses on ConnectionError
so that tests and offline development work without a live service.
"""

from __future__ import annotations

import logging
import time
from typing import Any

import requests

logger = logging.getLogger(__name__)

# Default mock blocks returned when Nexum is unreachable.
_MOCK_BLOCKS: list[dict] = [
    {
        "block_id": f"mock-block-{i:04d}",
        "text": f"Mock block {i}: This is placeholder text returned when Nexum is unreachable.",
        "score": round(1.0 - i * 0.05, 4),
        "links": [],
    }
    for i in range(10)
]


class GraphInferenceClient:
    """
    ANN retrieval → typed-link graph traversal → block aggregation → LM generation.

    Implements the retrieval-augmented inference forward pass over Nexum's REST API.

    Parameters
    ----------
    nexum_url:
        Base URL of the running Nexum instance (e.g. ``"http://localhost:3000"``).
    anthropic_key:
        Anthropic API key for generation calls.  When ``None`` the client uses a
        stub generator so that retrieve-only workflows are unaffected.
    timeout_s:
        Per-request HTTP timeout in seconds (default 10).
    """

    def __init__(
        self,
        nexum_url: str,
        anthropic_key: str | None = None,
        timeout_s: float = 10.0,
    ) -> None:
        self.nexum_url = nexum_url.rstrip("/")
        self.anthropic_key = anthropic_key
        self.timeout_s = timeout_s
        self._anthropic_client: Any = None

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _get_anthropic_client(self) -> Any:
        """Lazy-init the Anthropic client (avoids import cost when key absent)."""
        if self._anthropic_client is None:
            if self.anthropic_key is None:
                return None
            try:
                import anthropic  # type: ignore[import]

                self._anthropic_client = anthropic.Anthropic(api_key=self.anthropic_key)
            except ImportError:
                logger.warning("anthropic package not installed; generation will be mocked.")
        return self._anthropic_client

    def _build_context(self, blocks: list[dict]) -> str:
        """Concatenate retrieved block texts into a numbered context string."""
        parts: list[str] = []
        for i, b in enumerate(blocks, start=1):
            text = b.get("text", "").strip()
            block_id = b.get("block_id", f"block-{i}")
            parts.append(f"[{i}] (id={block_id})\n{text}")
        return "\n\n".join(parts)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def retrieve(
        self,
        query: str,
        k: int = 10,
        mode: str = "graph",
    ) -> list[dict]:
        """Return ranked blocks with provenance from Nexum.

        Parameters
        ----------
        query:
            Free-text query string.
        k:
            Number of blocks to retrieve.
        mode:
            Retrieval mode: ``"graph"`` (default, typed-link-aware),
            ``"semantic"`` (ANN only), or ``"fulltext"``.

        Returns
        -------
        list[dict]
            Each element: ``{block_id, text, score, links}`` where ``links`` is
            a list of ``{rel_type, target_block_id}`` dicts.
        """
        try:
            response = requests.post(
                f"{self.nexum_url}/api/retrieve",
                json={"query": query, "k": k, "mode": mode},
                timeout=self.timeout_s,
            )
            response.raise_for_status()
            data = response.json()
            return data.get("blocks", [])
        except requests.ConnectionError:
            logger.warning(
                "Nexum unreachable at %s; returning mock blocks.", self.nexum_url
            )
            return _MOCK_BLOCKS[:k]
        except requests.HTTPError as exc:
            logger.error("Nexum HTTP error during retrieve: %s", exc)
            return _MOCK_BLOCKS[:k]
        except Exception as exc:  # noqa: BLE001
            logger.error("Unexpected error during retrieve: %s", exc)
            return _MOCK_BLOCKS[:k]

    def generate(
        self,
        query: str,
        blocks: list[dict],
        model: str = "claude-haiku-4-5-20251001",
    ) -> str:
        """Generate an answer from retrieved blocks.

        Parameters
        ----------
        query:
            The user question.
        blocks:
            Retrieved blocks (output of :meth:`retrieve`).
        model:
            Anthropic model identifier.

        Returns
        -------
        str
            Generated answer string.
        """
        context = self._build_context(blocks)
        prompt = (
            "You are a precise research assistant. Answer the question using only "
            "the provided context blocks. Cite the block number [N] for each claim.\n\n"
            f"Context:\n{context}\n\n"
            f"Question: {query}\n\n"
            "Answer:"
        )

        client = self._get_anthropic_client()
        if client is None:
            return (
                f"[MOCK ANSWER] Query: {query!r} — "
                f"answered from {len(blocks)} retrieved blocks."
            )

        try:
            message = client.messages.create(
                model=model,
                max_tokens=512,
                messages=[{"role": "user", "content": prompt}],
            )
            return message.content[0].text
        except Exception as exc:  # noqa: BLE001
            logger.error("Anthropic generation error: %s", exc)
            return (
                f"[MOCK ANSWER] Generation failed ({exc}); "
                f"query: {query!r}; {len(blocks)} blocks retrieved."
            )

    def query(
        self,
        query: str,
        k: int = 10,
        model: str = "claude-haiku-4-5-20251001",
    ) -> dict:
        """End-to-end retrieve + generate.

        Handles :exc:`requests.ConnectionError` gracefully — returns a mock
        response so that callers and tests work without a live Nexum instance.

        Returns
        -------
        dict
            ``{answer: str, blocks: list[dict], latency_ms: float,
               retrieval_ms: float, generation_ms: float, is_mock: bool}``
        """
        t_start = time.perf_counter()

        # --- Retrieve ---
        t_retrieve_start = time.perf_counter()
        is_mock = False
        try:
            blocks = self.retrieve(query, k=k)
        except requests.ConnectionError:
            logger.warning(
                "ConnectionError during query(); using mock blocks."
            )
            blocks = _MOCK_BLOCKS[:k]
            is_mock = True
        retrieval_ms = (time.perf_counter() - t_retrieve_start) * 1000.0

        # Detect mock blocks from retrieve() fallback path
        if blocks and blocks[0].get("block_id", "").startswith("mock-block-"):
            is_mock = True

        # --- Generate ---
        t_gen_start = time.perf_counter()
        answer = self.generate(query, blocks, model=model)
        generation_ms = (time.perf_counter() - t_gen_start) * 1000.0

        total_ms = (time.perf_counter() - t_start) * 1000.0

        return {
            "answer": answer,
            "blocks": blocks,
            "latency_ms": total_ms,
            "retrieval_ms": retrieval_ms,
            "generation_ms": generation_ms,
            "is_mock": is_mock,
        }
