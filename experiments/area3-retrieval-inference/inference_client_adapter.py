"""
inference_client_adapter.py — Python adapter for the Phase-2 InferenceClient
seam (src/inference/client.ts, PR #93).

The TypeScript scout in `src/inference/client.ts` fixes the cross-issue type
surface for Areas 2 and 3:

    interface InferenceClient {
      embed(text)               -> number[]
      retrieve(query, mode)     -> RetrievalResult{ blocks, latencyMs, ... }
      score(query, evidence)    -> EvidenceScore[]   # one per evidence, in order
    }

This module provides a Python class with the same surface so that Area-3
quality benchmarks can be wired against either:

  - a real Nexum HTTP backend (default), via :class:`HttpInferenceClient`, or
  - an offline/in-memory fixture, via :class:`InMemoryInferenceClient`.

Both implement the same three methods. Tests exercise the in-memory variant;
small-scale quality runs use the HTTP variant against `mode='vector'`,
`mode='graph'`, or `mode='hybrid'` to keep the discriminator strings
identical to the TS seam.

Canonical references:
- src/inference/client.ts            (the seam this mirrors)
- docs/research/hypotheses/H3.1_*.md (hypothesis under test)
- docs/research.md                   (Area 3 charter)
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Any, Iterable, Literal, Protocol

logger = logging.getLogger(__name__)


# Discriminator strings copied verbatim from src/inference/client.ts.
# Keep in sync; if the TS seam adds a mode, mirror it here.
RetrievalMode = Literal["vector", "graph", "hybrid"]
_VALID_MODES: tuple[str, ...] = ("vector", "graph", "hybrid")


@dataclass(frozen=True)
class RetrievedBlock:
    """One retrieved block with its rank-time score.

    Mirrors the TS `RetrievedBlock` interface. `score` is opaque (any monotone-
    with-relevance scalar); only relative order is contractually meaningful.
    """

    block_id: str
    score: float
    text: str = ""
    doc_id: str | None = None
    meta: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "block_id": self.block_id,
            "score": float(self.score),
            "text": self.text,
            "doc_id": self.doc_id,
            "meta": dict(self.meta),
        }


@dataclass
class RetrievalResult:
    """Bundle of retrieved blocks plus runtime metadata.

    Mirrors the TS `RetrievalResult`. `mode` echoes the request so call sites
    can persist provenance without tracking it separately.
    """

    mode: RetrievalMode
    blocks: list[RetrievedBlock]
    latency_ms: float
    meta: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class EvidenceScore:
    """Per-block relevance/faithfulness score in [0, 1]. Mirrors TS."""

    block_id: str
    score: float
    meta: dict[str, Any] = field(default_factory=dict)


class InferenceClient(Protocol):
    """Python protocol mirroring `InferenceClient` in src/inference/client.ts.

    Implementations MUST be safe to call sequentially; concurrency is the
    backend's responsibility.
    """

    name: str

    def embed(self, text: str) -> list[float]: ...

    def retrieve(self, query: str, mode: RetrievalMode) -> RetrievalResult: ...

    def score(
        self, query: str, evidence: list[RetrievedBlock]
    ) -> list[EvidenceScore]: ...


# ---------------------------------------------------------------------------
# In-memory client — used by tests and offline CI runs.
# ---------------------------------------------------------------------------


class InMemoryInferenceClient:
    """Minimal in-memory `InferenceClient` for tests and offline CI.

    Embeddings are deterministic bag-of-tokens hashes (32-d) so the same text
    always returns the same vector. Retrieval is cosine-rank over a corpus
    supplied at construction time. Scoring re-uses the same cosine similarity
    so the seam is exercised end-to-end without a network call.

    The constructor accepts an optional ``mode_corpora`` mapping so callers can
    simulate the difference between flat ANN (``vector``) and typed-link
    traversal (``graph``) — typically by supplying a smaller, more-focused set
    of blocks for the ``graph`` mode (the in-memory analogue of AGE narrowing
    the candidate set via typed edges).
    """

    name = "in-memory-inference-client"

    def __init__(
        self,
        corpus: Iterable[dict],
        *,
        k: int = 10,
        mode_corpora: dict[str, list[dict]] | None = None,
    ) -> None:
        self._corpus = [dict(b) for b in corpus]
        self._k = int(k)
        self._mode_corpora = {
            mode: [dict(b) for b in blocks]
            for mode, blocks in (mode_corpora or {}).items()
        }
        # Pre-embed everything so retrieve() is O(N) cosine.
        self._embedded: dict[str, list[tuple[dict, list[float]]]] = {
            "_default": [(b, self._hash_embed(b.get("text", ""))) for b in self._corpus]
        }
        for mode, blocks in self._mode_corpora.items():
            self._embedded[mode] = [
                (b, self._hash_embed(b.get("text", ""))) for b in blocks
            ]

    # -- Protocol surface ----------------------------------------------------

    def embed(self, text: str) -> list[float]:
        return self._hash_embed(text)

    def retrieve(self, query: str, mode: RetrievalMode) -> RetrievalResult:
        if mode not in _VALID_MODES:
            raise ValueError(f"unknown mode {mode!r}; expected one of {_VALID_MODES}")
        bucket = self._embedded.get(mode, self._embedded["_default"])
        qvec = self._hash_embed(query)

        t0 = time.perf_counter()
        scored = [
            (b, _cosine(qvec, vec))
            for b, vec in bucket
        ]
        scored.sort(key=lambda x: x[1], reverse=True)
        top = scored[: self._k]
        latency_ms = (time.perf_counter() - t0) * 1000.0

        blocks = [
            RetrievedBlock(
                block_id=b.get("block_id") or b.get("id") or f"in-mem-{i}",
                score=float(s),
                text=b.get("text", ""),
                doc_id=b.get("doc_id"),
                meta={"mode": mode},
            )
            for i, (b, s) in enumerate(top)
        ]
        return RetrievalResult(mode=mode, blocks=blocks, latency_ms=latency_ms)

    def score(
        self, query: str, evidence: list[RetrievedBlock]
    ) -> list[EvidenceScore]:
        qvec = self._hash_embed(query)
        out: list[EvidenceScore] = []
        for b in evidence:
            sim = _cosine(qvec, self._hash_embed(b.text))
            # Map cosine in [-1, 1] to [0, 1].
            normalised = max(0.0, min(1.0, (sim + 1.0) / 2.0))
            out.append(EvidenceScore(block_id=b.block_id, score=normalised))
        return out

    # -- Internals -----------------------------------------------------------

    @staticmethod
    def _hash_embed(text: str, dim: int = 32) -> list[float]:
        """Deterministic bag-of-tokens hash embedding.

        Not a real model; just enough signal to make cosine comparisons rank
        related strings above unrelated ones, which is all the tests need.
        """
        vec = [0.0] * dim
        for tok in text.lower().split():
            h = hash(tok) % dim
            vec[h] += 1.0
        # L2 normalise so cosine is well-defined.
        norm = sum(v * v for v in vec) ** 0.5
        if norm == 0.0:
            return vec
        return [v / norm for v in vec]


def _cosine(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = sum(x * x for x in a) ** 0.5
    nb = sum(y * y for y in b) ** 0.5
    if na == 0.0 or nb == 0.0:
        return 0.0
    return dot / (na * nb)


# ---------------------------------------------------------------------------
# HTTP client — wraps GraphInferenceClient to expose the InferenceClient seam.
# ---------------------------------------------------------------------------


class HttpInferenceClient:
    """Adapter around :class:`GraphInferenceClient` that conforms to the
    Phase-2 :class:`InferenceClient` seam.

    The TS seam exposes `mode in {vector, graph, hybrid}`; Nexum's REST
    `/api/retrieve` endpoint exposes `mode in {semantic, graph, fulltext}`.
    The mapping is fixed here once so downstream code uses the seam vocabulary
    and the route mapping is auditable in one place.
    """

    name = "http-inference-client"

    _MODE_MAP: dict[str, str] = {
        "vector": "semantic",
        "graph": "graph",
        "hybrid": "graph",  # backend collapses hybrid to graph for now
    }

    def __init__(self, graph_client: Any, *, k: int = 10) -> None:
        self._client = graph_client
        self._k = int(k)

    def embed(self, text: str) -> list[float]:
        # The Nexum REST surface does not yet expose embed-only; reuse the
        # in-memory hash so the seam contract is honoured. Real embeddings
        # are produced by the ingest path; this method exists to satisfy the
        # protocol for callers that only need a deterministic vector.
        return InMemoryInferenceClient._hash_embed(text)

    def retrieve(self, query: str, mode: RetrievalMode) -> RetrievalResult:
        if mode not in _VALID_MODES:
            raise ValueError(f"unknown mode {mode!r}; expected one of {_VALID_MODES}")
        backend_mode = self._MODE_MAP[mode]
        t0 = time.perf_counter()
        raw = self._client.retrieve(query, k=self._k, mode=backend_mode)
        latency_ms = (time.perf_counter() - t0) * 1000.0
        blocks = [
            RetrievedBlock(
                block_id=str(b.get("block_id", "")),
                score=float(b.get("score", 0.0)),
                text=str(b.get("text", "")),
                doc_id=b.get("doc_id"),
                meta={
                    "mode": mode,
                    "backend_mode": backend_mode,
                    "links": b.get("links", []),
                },
            )
            for b in raw
        ]
        return RetrievalResult(
            mode=mode,
            blocks=blocks,
            latency_ms=latency_ms,
            meta={"backend_mode": backend_mode},
        )

    def score(
        self, query: str, evidence: list[RetrievedBlock]
    ) -> list[EvidenceScore]:
        # Re-rank by cosine of the hash-embed; deterministic and keyless. A
        # learned re-ranker can be slotted in here later without touching
        # call sites — that is the point of the seam.
        qvec = self.embed(query)
        out: list[EvidenceScore] = []
        for b in evidence:
            sim = _cosine(qvec, self.embed(b.text))
            out.append(
                EvidenceScore(
                    block_id=b.block_id,
                    score=max(0.0, min(1.0, (sim + 1.0) / 2.0)),
                )
            )
        return out
