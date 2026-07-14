"""Small, deterministic retrieval-quality metrics for Dataset golden sets."""

from __future__ import annotations

import math
from typing import Any, Iterable


def recall_at_k(retrieved: Iterable[str], relevant: set[str], k: int) -> float:
    if not relevant or k <= 0:
        return 0.0
    found = len(set(list(retrieved)[:k]) & relevant)
    return found / len(relevant)


def reciprocal_rank(retrieved: Iterable[str], relevant: set[str], k: int) -> float:
    for rank, document_id in enumerate(list(retrieved)[:k], start=1):
        if document_id in relevant:
            return 1.0 / rank
    return 0.0


def ndcg_at_k(retrieved: Iterable[str], relevance: dict[str, float], k: int) -> float:
    ranked = list(retrieved)[:k]
    if not relevance or k <= 0:
        return 0.0

    def gain(score: float) -> float:
        return (2.0**score) - 1.0

    dcg = sum(gain(float(relevance.get(document_id, 0.0))) / math.log2(rank + 1) for rank, document_id in enumerate(ranked, start=1))
    ideal = sorted((float(score) for score in relevance.values()), reverse=True)[:k]
    idcg = sum(gain(score) / math.log2(rank + 1) for rank, score in enumerate(ideal, start=1))
    return dcg / idcg if idcg else 0.0


def evaluate_golden_case(case: dict[str, Any], retrieved: Iterable[str]) -> dict[str, float]:
    relevant = {str(item) for item in case.get("relevantDocumentIds") or []}
    graded = {str(key): float(value) for key, value in (case.get("relevance") or {}).items()}
    k = int(case.get("k") or 8)
    ranked = [str(item) for item in retrieved]
    return {"recall": recall_at_k(ranked, relevant, k), "mrr": reciprocal_rank(ranked, relevant, k), "ndcg": ndcg_at_k(ranked, graded or {item: 1.0 for item in relevant}, k)}
