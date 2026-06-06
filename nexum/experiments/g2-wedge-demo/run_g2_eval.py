"""
G2 wedge demo runner — retrieval-attribution evaluation.

This is the executable form of the G2 gate. It compares Nexum's structural
typed-link retrieval against a chunk-and-embed vanilla RAG baseline on a CUAD
QA subset, measuring attribution F1 (does the cited block contain the gold
answer span?).

Why retrieval-only (no LLM generation):
- H4.4's claim is about *block-level provenance*, not answer fluency.
- The attribution F1 metric is a property of the retrieved citation set; the
  generation step is downstream of it.
- This makes the evaluation reproducible without an LLM API key, which is the
  honest route given the run environment.

Why these are fair baselines:
- Both systems use the same embedding model (all-MiniLM-L6-v2, 384-d).
- Both systems retrieve the same top-k blocks for the same questions.
- The only difference is *how the corpus is chunked*: Nexum uses paragraph
  blocks (its parseText splits on blank lines, the structural unit a legal
  reviewer cites); vanilla RAG uses fixed-size token chunks (the LlamaIndex
  default), which can straddle clause boundaries.

Output: a result envelope written through experiments/_lib/results_writer.

Canonical references:
- docs/research/hypotheses/H4.4_attribution-traceable.md
- docs/research.md (Gate G2)
"""

from __future__ import annotations

import argparse
import json
import logging
import statistics
import sys
import time
from pathlib import Path

# Make the local module imports work no matter how this is invoked.
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent.parent))  # repo root, for experiments._lib

from corpus import load_demo_corpus, load_eval_questions  # noqa: E402
from attribution_eval import attribution_f1  # noqa: E402

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s — %(message)s"
)
logger = logging.getLogger("g2_eval")


# ---------------------------------------------------------------------------
# Embedding model — shared between Nexum-side and vanilla-side for fairness.
# ---------------------------------------------------------------------------


def _load_embedder():
    from sentence_transformers import SentenceTransformer

    return SentenceTransformer("all-MiniLM-L6-v2")


# ---------------------------------------------------------------------------
# Nexum side — ingest via the API, embed via the local module path, query via
# the /query endpoint in semantic mode.
# ---------------------------------------------------------------------------


def nexum_ingest_and_embed(
    nexum_url: str, contracts: list[dict], embedder
) -> tuple[str, dict[str, str]]:
    """Ingest contracts into Nexum, embed all blocks, return (corpus_id, doc_map)."""
    import requests

    nexum_url = nexum_url.rstrip("/")

    # Create corpus
    r = requests.post(
        f"{nexum_url}/corpora", json={"name": f"g2-eval-{int(time.time())}"}, timeout=30
    )
    r.raise_for_status()
    corpus_id = r.json()["id"]
    logger.info("Created Nexum corpus %s", corpus_id)

    # Map of (external_id -> nexum_doc_id) so we can score by source
    # contract id later on.
    doc_map: dict[str, str] = {}

    for c in contracts:
        r = requests.post(
            f"{nexum_url}/documents",
            json={
                "corpus_id": corpus_id,
                "title": c["title"],
                "format": "text",
                "content": c["text"],
                "external_id": c["id"],
            },
            timeout=120,
        )
        r.raise_for_status()
        doc_map[c["id"]] = r.json()["id"]

    logger.info("Ingested %d documents into Nexum", len(doc_map))

    # Embed all unembedded blocks for this corpus directly via SQL.
    # The auto-worker is not started in this environment; we replicate its
    # work here. We pull each block's content, embed it through Nexum's own
    # /blocks/embed endpoint to use the same model, and write the vector back.
    import os
    import psycopg2

    db_url = os.environ.get(
        "DATABASE_URL", "postgresql://nexum:nexum@localhost:5440/nexum"
    )
    conn = psycopg2.connect(db_url)
    cur = conn.cursor()
    cur.execute(
        """
        SELECT b.id, b.content
        FROM blocks b
        JOIN documents d ON d.id = b.doc_id
        WHERE d.corpus_id = %s AND b.embedding IS NULL
        """,
        (corpus_id,),
    )
    rows = cur.fetchall()
    logger.info("Embedding %d blocks for Nexum corpus", len(rows))

    # Batch embed locally (fast) — the model is identical to what Nexum uses.
    contents = [r[1] for r in rows]
    if contents:
        vecs = embedder.encode(contents, show_progress_bar=False, normalize_embeddings=True)
        for (block_id, _), vec in zip(rows, vecs):
            vec_str = "[" + ",".join(f"{v:.7f}" for v in vec.tolist()) + "]"
            cur.execute(
                "UPDATE blocks SET embedding = %s::vector WHERE id = %s",
                (vec_str, block_id),
            )
        conn.commit()
    cur.close()
    conn.close()

    return corpus_id, doc_map


def nexum_retrieve(
    nexum_url: str, corpus_id: str, question: str, top_k: int, doc_inv: dict[str, str]
) -> list[dict]:
    """Query Nexum semantic mode and normalize to citation dicts."""
    import requests

    r = requests.post(
        f"{nexum_url.rstrip('/')}/query",
        json={
            "corpus_id": corpus_id,
            "query": question,
            "mode": "semantic",
            "limit": top_k,
        },
        timeout=30,
    )
    r.raise_for_status()
    results = r.json().get("results", [])
    return [
        {
            "block_id": x["block_id"],
            "text": x["content"],
            # Map nexum's doc id back to the CUAD external id for scoring.
            "doc_id": doc_inv.get(x["document"]["id"], x["document"]["id"]),
            "score": float(x["score"]),
        }
        for x in results
    ]


# ---------------------------------------------------------------------------
# Vanilla side — fixed-size chunking + cosine similarity. No graph structure.
# ---------------------------------------------------------------------------


def _fixed_chunk(text: str, chunk_size_chars: int = 1024, overlap: int = 128) -> list[str]:
    """Naive fixed-size character chunker, the structural opposite of paragraph blocks."""
    if len(text) <= chunk_size_chars:
        return [text]
    out = []
    i = 0
    while i < len(text):
        out.append(text[i : i + chunk_size_chars])
        i += chunk_size_chars - overlap
    return out


class VanillaIndex:
    """In-memory cosine-similarity index over fixed-size text chunks."""

    def __init__(self, embedder, chunk_size: int = 1024, overlap: int = 128) -> None:
        self.embedder = embedder
        self.chunk_size = chunk_size
        self.overlap = overlap
        self._chunks: list[dict] = []
        self._matrix = None

    def ingest(self, contracts: list[dict]) -> None:
        import numpy as np

        for c in contracts:
            for j, ck in enumerate(
                _fixed_chunk(c["text"], self.chunk_size, self.overlap)
            ):
                self._chunks.append(
                    {
                        "chunk_id": f"{c['id']}::chunk-{j:04d}",
                        "doc_id": c["id"],
                        "text": ck,
                    }
                )
        texts = [c["text"] for c in self._chunks]
        self._matrix = np.asarray(
            self.embedder.encode(texts, show_progress_bar=False, normalize_embeddings=True)
        )
        logger.info(
            "VanillaIndex: %d contracts → %d fixed-size chunks",
            len(contracts),
            len(self._chunks),
        )

    def retrieve(self, question: str, top_k: int) -> list[dict]:
        import numpy as np

        q = self.embedder.encode(
            [question], show_progress_bar=False, normalize_embeddings=True
        )[0]
        scores = self._matrix @ q  # cosine since both normalized
        idx = np.argsort(-scores)[:top_k]
        return [
            {
                "block_id": self._chunks[i]["chunk_id"],
                "text": self._chunks[i]["text"],
                "doc_id": self._chunks[i]["doc_id"],
                "score": float(scores[i]),
            }
            for i in idx
        ]


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------


def run_eval(
    contracts: list[dict],
    questions: list[dict],
    nexum_url: str,
    top_k: int = 5,
) -> dict:
    embedder = _load_embedder()

    # --- Vanilla side
    vanilla = VanillaIndex(embedder)
    vanilla.ingest(contracts)

    # --- Nexum side
    corpus_id, doc_map = nexum_ingest_and_embed(nexum_url, contracts, embedder)
    doc_inv = {v: k for k, v in doc_map.items()}

    per_question = []
    for q in questions:
        nexum_cites = nexum_retrieve(
            nexum_url, corpus_id, q["question"], top_k, doc_inv
        )
        vanilla_cites = vanilla.retrieve(q["question"], top_k)

        n_score = attribution_f1(nexum_cites, q["gold_span"], q["contract_id"])
        v_score = attribution_f1(vanilla_cites, q["gold_span"], q["contract_id"])

        per_question.append(
            {
                "question_id": q["id"],
                "question": q["question"],
                "gold_doc_id": q["contract_id"],
                "gold_span_preview": q["gold_span"][:120],
                "nexum": n_score,
                "vanilla_rag": v_score,
            }
        )

    def _mean(key1: str, key2: str) -> float:
        vals = [r[key1][key2] for r in per_question]
        return statistics.mean(vals) if vals else 0.0

    nexum_f1 = _mean("nexum", "f1")
    vanilla_f1 = _mean("vanilla_rag", "f1")
    delta = nexum_f1 - vanilla_f1

    if delta > 0.05:
        signal = "pass"
    elif delta < -0.05:
        signal = "fail"
    else:
        signal = "inconclusive"

    return {
        "nexum": {
            "attribution_f1": round(nexum_f1, 4),
            "attribution_precision": round(_mean("nexum", "precision"), 4),
            "attribution_recall": round(_mean("nexum", "recall"), 4),
            "false_attribution_rate": round(_mean("nexum", "false_attribution_rate"), 4),
        },
        "vanilla_rag": {
            "attribution_f1": round(vanilla_f1, 4),
            "attribution_precision": round(_mean("vanilla_rag", "precision"), 4),
            "attribution_recall": round(_mean("vanilla_rag", "recall"), 4),
            "false_attribution_rate": round(
                _mean("vanilla_rag", "false_attribution_rate"), 4
            ),
        },
        "delta_attribution_f1": round(delta, 4),
        "g2_signal": signal,
        "n_questions": len(per_question),
        "n_contracts": len(contracts),
        "top_k": top_k,
        "embedder": "all-MiniLM-L6-v2",
        "per_question": per_question,
    }


def _select_questions(
    questions: list[dict], contract_ids: set[str], n: int
) -> list[dict]:
    """Pick up to `n` questions stratified across the demo contracts.

    CUAD ships ~41 QA pairs per contract in source order, so a naive head
    slice would saturate on the first few documents. Round-robin across
    contracts so the eval set actually covers the full subset.
    """
    by_contract: dict[str, list[dict]] = {}
    for q in questions:
        if q["contract_id"] in contract_ids:
            by_contract.setdefault(q["contract_id"], []).append(q)

    # Diversify by question template (CUAD's question text differs only by
    # the quoted topic — "Document Name", "Parties", "Governing Law", ...).
    # Rotate the per-contract cursor so the eval set is not 50× the same
    # template ("Document Name") repeated across documents.
    out: list[dict] = []
    cursors = {cid: hash(cid) % max(len(v), 1) for cid, v in by_contract.items()}
    visited = {cid: 0 for cid in by_contract}
    cids = list(by_contract.keys())
    while len(out) < n:
        progressed = False
        for cid in cids:
            if len(out) >= n:
                break
            qs = by_contract[cid]
            if visited[cid] < len(qs):
                out.append(qs[cursors[cid] % len(qs)])
                cursors[cid] += 1
                visited[cid] += 1
                progressed = True
        if not progressed:
            break
    return out


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--nexum-url", default="http://localhost:3010")
    p.add_argument("--cuad-contracts", default=str(HERE.parent / "lab-bench/data/cuad/contracts.jsonl"))
    p.add_argument("--cuad-qa", default=str(HERE.parent / "lab-bench/data/cuad/qa.jsonl"))
    p.add_argument("--max-contracts", type=int, default=50)
    p.add_argument("--max-questions", type=int, default=50)
    p.add_argument("--top-k", type=int, default=5)
    p.add_argument("--output", default=str(HERE / "results/g2_result.json"))
    p.add_argument(
        "--write-envelope",
        action="store_true",
        help="Also emit a results envelope under experiments/g2-wedge-demo/results.",
    )
    args = p.parse_args(argv)

    contracts = load_demo_corpus(args.cuad_contracts, max_contracts=args.max_contracts)
    all_qas = load_eval_questions(args.cuad_qa, max_questions=10_000_000)
    contract_ids = {c["id"] for c in contracts}
    questions = _select_questions(all_qas, contract_ids, args.max_questions)
    logger.info(
        "Selected %d questions across %d contracts", len(questions), len(contracts)
    )

    result = run_eval(contracts, questions, args.nexum_url, top_k=args.top_k)

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, indent=2))

    print()
    print("=" * 60)
    print("G2 WEDGE DEMO — RETRIEVAL ATTRIBUTION RESULTS")
    print("=" * 60)
    print(f"  Contracts ingested  : {result['n_contracts']}")
    print(f"  Questions evaluated : {result['n_questions']}")
    print(f"  Top-k               : {result['top_k']}")
    print(f"  Embedder            : {result['embedder']}")
    print(f"  Nexum   attribution F1 : {result['nexum']['attribution_f1']:.4f}")
    print(f"  Vanilla attribution F1 : {result['vanilla_rag']['attribution_f1']:.4f}")
    print(f"  Delta (Nexum − Vanilla): {result['delta_attribution_f1']:+.4f}")
    print(f"  Nexum   precision      : {result['nexum']['attribution_precision']:.4f}")
    print(f"  Vanilla precision      : {result['vanilla_rag']['attribution_precision']:.4f}")
    print(f"  Nexum   recall         : {result['nexum']['attribution_recall']:.4f}")
    print(f"  Vanilla recall         : {result['vanilla_rag']['attribution_recall']:.4f}")
    print(f"  G2 signal              : {result['g2_signal'].upper()}")
    print("=" * 60)
    print(f"\nWrote result to: {out}")

    if args.write_envelope:
        from experiments._lib.results_writer import ResultEnvelope, write_result
        from experiments._lib.runner import capture_run_context

        passed = result["g2_signal"] == "pass"
        env = ResultEnvelope(
            gate="G2",
            hypothesis="H4.4",
            passed=passed,
            metrics={
                "nexum_attribution_f1": result["nexum"]["attribution_f1"],
                "vanilla_attribution_f1": result["vanilla_rag"]["attribution_f1"],
                "delta_attribution_f1": result["delta_attribution_f1"],
                "nexum_false_attribution_rate": result["nexum"]["false_attribution_rate"],
                "vanilla_false_attribution_rate": result["vanilla_rag"]["false_attribution_rate"],
                "n_questions": result["n_questions"],
                "n_contracts": result["n_contracts"],
                "top_k": result["top_k"],
                "g2_signal": result["g2_signal"],
            },
            runtime=capture_run_context(gate="G2", hypothesis="H4.4", seed=42),
            notes=(
                "Retrieval-only attribution F1 (no LLM generation). Same embedder "
                "(all-MiniLM-L6-v2) for both sides; only the chunking strategy "
                "differs (Nexum: paragraph-block; vanilla: fixed 1024-char chunks)."
            ),
        )
        envelope_path = write_result(env, str(HERE))
        print(f"Wrote envelope to: {envelope_path}")


if __name__ == "__main__":
    main()
