"""
MTEB-compatible embedder adapter for Nexum.

MTEB's evaluation runner calls ``model.encode(sentences)`` and expects a
numpy array of shape ``(n_sentences, embedding_dim)`` in return.

This adapter calls Nexum's ``/blocks/embed`` endpoint.  If the endpoint is
unreachable and *local_fallback* is enabled the adapter transparently falls
back to a local ``sentence-transformers`` model so that offline or CI
environments can still exercise the MTEB harness.

Usage::

    from adapters.nexum_embedder import NexumEmbedder
    import mteb

    model = NexumEmbedder(nexum_url="http://localhost:3000")
    tasks = mteb.get_tasks(tasks=["MSMARCO"])
    evaluation = mteb.MTEB(tasks=tasks)
    results = evaluation.run(model, output_folder="results/mteb")
"""

from __future__ import annotations

import logging
from typing import Any

import numpy as np
import requests

logger = logging.getLogger(__name__)

# Lazy import so the library is only required when local_fallback=True and the
# Nexum endpoint is unavailable.
try:
    from sentence_transformers import SentenceTransformer  # noqa: F401  (re-exported for patching)
except ImportError:  # pragma: no cover
    SentenceTransformer = None  # type: ignore[assignment,misc]

_DEFAULT_LOCAL_MODEL = "sentence-transformers/all-MiniLM-L6-v2"


class NexumEmbedder:
    """
    MTEB-compatible embedder backed by Nexum's embedding endpoint.

    Parameters
    ----------
    nexum_url:
        Base URL of the Nexum REST API (e.g. ``http://localhost:3000``).
    api_key:
        Optional bearer token for Nexum authentication.
    local_fallback:
        When *True*, fall back to a local ``sentence-transformers`` model if
        the Nexum endpoint is unavailable.  Defaults to *True*.
    local_model_name:
        Which sentence-transformers model to use for the local fallback.
    """

    def __init__(
        self,
        nexum_url: str = "http://localhost:3000",
        api_key: str | None = None,
        local_fallback: bool = True,
        local_model_name: str = _DEFAULT_LOCAL_MODEL,
    ) -> None:
        self.nexum_url = nexum_url.rstrip("/")
        self.local_fallback = local_fallback
        self.local_model_name = local_model_name
        self._session = requests.Session()
        if api_key:
            self._session.headers["Authorization"] = f"Bearer {api_key}"
        self._local_model: Any = None  # lazily initialised

    # ------------------------------------------------------------------
    # MTEB interface
    # ------------------------------------------------------------------

    def encode(
        self,
        sentences: list[str],
        batch_size: int = 32,
        **kwargs: Any,
    ) -> np.ndarray:
        """
        Encode *sentences* into embedding vectors.

        Parameters
        ----------
        sentences:
            List of strings to embed.
        batch_size:
            Number of sentences to send per HTTP request.

        Returns
        -------
        np.ndarray
            Shape ``(len(sentences), embedding_dim)``.
        """
        try:
            return self._encode_via_nexum(sentences, batch_size)
        except (requests.ConnectionError, requests.Timeout) as exc:
            if self.local_fallback:
                logger.warning(
                    "Nexum embed endpoint unreachable (%s). Falling back to local model '%s'.",
                    exc,
                    self.local_model_name,
                )
                return self._encode_local(sentences, batch_size)
            raise

    # ------------------------------------------------------------------
    # Remote path
    # ------------------------------------------------------------------

    def _encode_via_nexum(self, sentences: list[str], batch_size: int) -> np.ndarray:
        """Send sentences to Nexum's /blocks/embed endpoint in batches."""
        all_embeddings: list[list[float]] = []

        for start in range(0, len(sentences), batch_size):
            batch = sentences[start : start + batch_size]
            resp = self._session.post(
                f"{self.nexum_url}/blocks/embed",
                json={"sentences": batch},
            )
            resp.raise_for_status()
            payload = resp.json()
            batch_embeddings: list[list[float]] = payload["embeddings"]
            all_embeddings.extend(batch_embeddings)

        return np.array(all_embeddings, dtype=np.float32)

    # ------------------------------------------------------------------
    # Local fallback path
    # ------------------------------------------------------------------

    def _encode_local(self, sentences: list[str], batch_size: int) -> np.ndarray:
        """Encode using a local sentence-transformers model."""
        if SentenceTransformer is None:
            raise RuntimeError(
                "sentence-transformers is not installed. "
                "Install it with: pip install sentence-transformers"
            )
        if self._local_model is None:
            logger.info("Loading local model '%s'…", self.local_model_name)
            self._local_model = SentenceTransformer(self.local_model_name)
        embeddings = self._local_model.encode(
            sentences,
            batch_size=batch_size,
            show_progress_bar=False,
            convert_to_numpy=True,
        )
        return np.array(embeddings, dtype=np.float32)
