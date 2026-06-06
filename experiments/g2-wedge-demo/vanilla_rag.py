"""
Vanilla LlamaIndex RAG baseline for the G2 wedge demo.

Uses LlamaIndex's VectorStoreIndex with in-memory storage.  The same
underlying LLM (Claude Haiku) is used as in NexumRAG for a fair comparison —
the only difference is the retrieval mechanism.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

logger = logging.getLogger(__name__)

if TYPE_CHECKING:
    pass


class VanillaRAG:
    """
    LlamaIndex default RAG over the demo corpus.

    Same underlying LLM (Claude Haiku) as :class:`NexumRAG` for fair
    comparison.  Returns answers with LlamaIndex's default source-node
    citations.

    Parameters
    ----------
    anthropic_api_key:
        Anthropic API key used for Claude Haiku.
    chunk_size:
        Token chunk size passed to LlamaIndex's node parser (default 1024,
        matching the methodology doc's LlamaIndex citation-mode configuration).
    """

    def __init__(self, anthropic_api_key: str, chunk_size: int = 1024) -> None:
        self.anthropic_api_key = anthropic_api_key
        self.chunk_size = chunk_size
        self._index = None
        self._documents: list[dict] = []

    # ------------------------------------------------------------------
    # Ingestion
    # ------------------------------------------------------------------

    def ingest(self, contracts: list[dict]) -> None:
        """Ingest contracts into an in-memory VectorStoreIndex.

        The index is built eagerly so that :meth:`query` is stateless.

        Parameters
        ----------
        contracts:
            List of ``{id, title, text}`` dicts, same format as
            :func:`corpus.load_demo_corpus`.
        """
        try:
            from llama_index.core import Document, Settings, VectorStoreIndex
            from llama_index.core.node_parser import SentenceSplitter
        except ImportError as exc:
            raise ImportError(
                "llama-index-core is required. "
                "Install with: pip install llama-index-core"
            ) from exc

        self._configure_llm()

        # Store raw contracts so we can map doc_id later
        self._documents = contracts

        # Build LlamaIndex Document objects
        docs = [
            Document(
                text=c["text"],
                doc_id=c["id"],
                metadata={"title": c["title"], "doc_id": c["id"]},
            )
            for c in contracts
        ]

        splitter = SentenceSplitter(chunk_size=self.chunk_size)
        self._index = VectorStoreIndex.from_documents(
            docs,
            transformations=[splitter],
            show_progress=False,
        )
        logger.info(
            "VanillaRAG: ingested %d contracts into in-memory index.", len(contracts)
        )

    def _configure_llm(self) -> None:
        """Point LlamaIndex's global Settings at Claude Haiku via Anthropic."""
        try:
            from llama_index.core import Settings
            from llama_index.llms.anthropic import Anthropic as LlamaAnthropic
        except ImportError:
            # llama-index-llms-anthropic may not be installed; fall back to
            # OpenAI-compatible wrapper via the anthropic SDK directly.
            logger.warning(
                "llama-index-llms-anthropic not found; LLM calls may fail."
            )
            return

        Settings.llm = LlamaAnthropic(
            model="claude-haiku-4-5",
            api_key=self.anthropic_api_key,
            max_tokens=512,
        )

    # ------------------------------------------------------------------
    # Query
    # ------------------------------------------------------------------

    def query(self, question: str, top_k: int = 5) -> dict:
        """Run a query against the in-memory index.

        Returns::

            {
                "answer": str,
                "citations": [{"text": str, "doc_id": str, "score": float}],
            }
        """
        if self._index is None:
            raise RuntimeError("Call ingest() before query().")

        try:
            from llama_index.core.query_engine import RetrieverQueryEngine
            from llama_index.core.response_synthesizers import get_response_synthesizer
        except ImportError as exc:
            raise ImportError("llama-index-core is required.") from exc

        retriever = self._index.as_retriever(similarity_top_k=top_k)
        response_synthesizer = get_response_synthesizer()
        engine = RetrieverQueryEngine(
            retriever=retriever,
            response_synthesizer=response_synthesizer,
        )

        response = engine.query(question)

        citations = []
        for node_with_score in (response.source_nodes or []):
            node = node_with_score.node
            citations.append(
                {
                    "text": node.get_content(),
                    "doc_id": node.metadata.get("doc_id", node.node_id or ""),
                    "score": float(node_with_score.score or 0.0),
                }
            )

        return {
            "answer": str(response),
            "citations": citations,
        }
