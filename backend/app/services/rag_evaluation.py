"""Small, deterministic retrieval-quality metrics for Dataset golden sets."""

from __future__ import annotations

import math
from typing import Any, Callable, Iterable


DEFAULT_QUALITY_THRESHOLDS = {
    "parentRecall": 0.60,
    "parentMrr": 0.40,
    "parentNdcg": 0.50,
    "chunkRecall": 0.60,
    "filterPrecision": 1.0,
    "duplicateParentRate": 0.0,
}


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


def _case_metrics(case: dict[str, Any], retrieved: list[str], *, prefix: str, relevant_key: str, relevance_key: str) -> dict[str, float]:
    relevant = case.get(relevant_key)
    if relevant is None:
        relevant = case.get("relevantDocumentIds") or []
    metrics = evaluate_golden_case({"k": case.get("k", 8), "relevantDocumentIds": relevant, "relevance": case.get(relevance_key) or case.get("relevance") or {}}, retrieved)
    return {f"{prefix}{name.title()}": value for name, value in metrics.items()}


def _matches_filter(metadata: dict[str, Any], filters: dict[str, Any]) -> bool:
    for field, predicate in (filters or {}).items():
        if field not in metadata or not isinstance(predicate, dict):
            return False
        value = metadata[field]
        expected = predicate.get("value")
        operator = predicate.get("operator")
        try:
            if operator == "eq" and value != expected and str(value) != str(expected):
                return False
            if operator == "gte" and value < expected:
                return False
            if operator == "gt" and value <= expected:
                return False
            if operator == "lte" and value > expected:
                return False
            if operator == "lt" and value >= expected:
                return False
        except TypeError:
            return False
    return True


def evaluate_golden_set(cases: Iterable[dict[str, Any]], responses: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """Evaluate real RAG API response payloads at parent and chunk level."""
    case_reports: list[dict[str, Any]] = []
    for index, case in enumerate(cases):
        case_id = str(case.get("id") or index)
        response = responses.get(case_id) or {}
        sources = response.get("sources") if isinstance(response, dict) else []
        sources = [item for item in sources if isinstance(item, dict)] if isinstance(sources, list) else []
        parent_ids = [str(item.get("parentDocumentId") or item.get("documentId") or "") for item in sources]
        chunk_ids = []
        for item in sources:
            nested_chunks = item.get("chunks") if isinstance(item.get("chunks"), list) else []
            if nested_chunks:
                chunk_ids.extend(str(chunk.get("chunkDocumentId") or chunk.get("documentId") or "") for chunk in nested_chunks if isinstance(chunk, dict))
            else:
                chunk_ids.append(str(item.get("chunkDocumentId") or item.get("documentId") or ""))
        parent_metrics = _case_metrics(case, parent_ids, prefix="parent", relevant_key="relevantParentDocumentIds", relevance_key="parentRelevance")
        chunk_metrics = _case_metrics(case, chunk_ids, prefix="chunk", relevant_key="relevantChunkDocumentIds", relevance_key="chunkRelevance")
        filters = case.get("filters") or {}
        filter_precision = sum(1 for item in sources if _matches_filter(item.get("metadata") or {}, filters)) / len(sources) if sources else (1.0 if not filters else 0.0)
        duplicate_parent_rate = 1.0 - (len(set(parent_ids)) / len(parent_ids)) if parent_ids else 0.0
        case_reports.append({"id": case_id, **parent_metrics, **chunk_metrics, "filterPrecision": filter_precision, "duplicateParentRate": duplicate_parent_rate, "resultCount": len(sources)})
    count = len(case_reports)
    if not count:
        return {"caseCount": 0, "cases": [], "metrics": {}}
    metric_names = ["parentRecall", "parentMrr", "parentNdcg", "chunkRecall", "chunkMrr", "chunkNdcg", "filterPrecision", "duplicateParentRate"]
    averages = {name: sum(float(item.get(name, 0.0)) for item in case_reports) / count for name in metric_names}
    return {"caseCount": count, "cases": case_reports, "metrics": averages}


class RagQualityGateError(ValueError):
    pass


def enforce_baseline_gate(report: dict[str, Any], baseline: dict[str, Any], *, max_relative_drop: float = 0.05) -> dict[str, Any]:
    """Require Recall@8 and MRR@8 to stay within the agreed relative drop."""
    if not 0 <= max_relative_drop < 1:
        raise ValueError("max_relative_drop must be between 0 and 1")
    current = report.get("metrics") or {}
    previous = baseline.get("metrics") or {}
    failures = []
    for metric in ("parentRecall", "parentMrr"):
        before = float(previous.get(metric, 0.0))
        after = float(current.get(metric, 0.0))
        minimum = before * (1.0 - max_relative_drop)
        if after < minimum:
            failures.append({"metric": metric, "current": after, "baseline": before, "minimum": minimum})
    return {**report, "baselineGate": {"passed": not failures, "failures": failures, "maxRelativeDrop": max_relative_drop}}


def enforce_quality_gate(report: dict[str, Any], thresholds: dict[str, float] | None = None) -> dict[str, Any]:
    required = {**DEFAULT_QUALITY_THRESHOLDS, **(thresholds or {})}
    metrics = report.get("metrics") or {}
    failures = []
    for metric, threshold in required.items():
        actual = float(metrics.get(metric, 0.0))
        passed = actual <= threshold if metric == "duplicateParentRate" else actual >= threshold
        if not passed:
            failures.append({"metric": metric, "actual": actual, "required": threshold})
    result = {**report, "gate": {"passed": not failures, "failures": failures, "thresholds": required}}
    if failures:
        raise RagQualityGateError(str(result["gate"]))
    return result


def run_golden_set(cases: Iterable[dict[str, Any]], retrieve: Callable[[dict[str, Any]], dict[str, Any]], thresholds: dict[str, float] | None = None) -> dict[str, Any]:
    case_list = list(cases)
    case_ids = [str(case.get("id") or index) for index, case in enumerate(case_list)]
    if len(case_ids) != len(set(case_ids)):
        raise ValueError("Golden case IDs must be unique")
    responses = {case_id: retrieve(case) for case_id, case in zip(case_ids, case_list)}
    return enforce_quality_gate(evaluate_golden_set(case_list, responses), thresholds)
