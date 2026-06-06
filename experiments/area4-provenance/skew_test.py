"""
H4.3 (recast as measurement): Train/serve skew test.

Compares Nexum (always-live corpus) vs. stale vanilla RAG (corpus frozen at
T-24h) vs. live vanilla RAG.  No a priori threshold — report what we find.

This is a measurement study, not a hypothesis test with a fabricated effect size.
"""

from __future__ import annotations


def simulate_skew_test(
    nexum_client,
    stale_client,
    live_client,
    questions: list[dict],
) -> dict:
    """H4.3: Compare Nexum vs. stale RAG vs. live RAG on recency-sensitive questions.

    Parameters
    ----------
    nexum_client:
        Always-live Nexum client.  Must implement ``query(question: str) -> dict``
        returning ``{"answer": str, ...}``.
    stale_client:
        Vanilla RAG client with corpus frozen at T-24h.  Same interface.
    live_client:
        Vanilla RAG client with current corpus.  Same interface.
    questions:
        List of recency-sensitive question dicts.  Each must contain:
            - ``question``    : question text
            - ``gold_answer`` : expected answer (as of T=now)

    Returns
    -------
    dict with keys:
        nexum_accuracy        : fraction of questions Nexum answered correctly
        stale_accuracy        : fraction answered correctly by stale RAG
        live_accuracy         : fraction answered correctly by live RAG
        skew_penalty          : stale_accuracy - live_accuracy (cost of staleness)
        nexum_vs_stale_delta  : nexum_accuracy - stale_accuracy
    """
    nexum_correct = 0
    stale_correct = 0
    live_correct = 0
    n = len(questions)

    for item in questions:
        question = item["question"]
        gold = item["gold_answer"].strip().lower()

        nexum_resp = nexum_client.query(question)
        stale_resp = stale_client.query(question)
        live_resp = live_client.query(question)

        if nexum_resp.get("answer", "").strip().lower() == gold:
            nexum_correct += 1
        if stale_resp.get("answer", "").strip().lower() == gold:
            stale_correct += 1
        if live_resp.get("answer", "").strip().lower() == gold:
            live_correct += 1

    nexum_accuracy = nexum_correct / n if n else 0.0
    stale_accuracy = stale_correct / n if n else 0.0
    live_accuracy = live_correct / n if n else 0.0

    skew_penalty = stale_accuracy - live_accuracy
    nexum_vs_stale_delta = nexum_accuracy - stale_accuracy

    return {
        "nexum_accuracy": round(nexum_accuracy, 4),
        "stale_accuracy": round(stale_accuracy, 4),
        "live_accuracy": round(live_accuracy, 4),
        "skew_penalty": round(skew_penalty, 4),
        "nexum_vs_stale_delta": round(nexum_vs_stale_delta, 4),
    }
