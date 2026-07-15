import pytest

from app.services.rag_evaluation import RagQualityGateError, enforce_quality_gate, evaluate_golden_case, evaluate_golden_set, ndcg_at_k, recall_at_k, reciprocal_rank, run_golden_set


def test_retrieval_quality_metrics_use_ranked_chunk_ids() -> None:
    ranked = ["irrelevant", "chunk-2", "chunk-1"]
    assert recall_at_k(ranked, {"chunk-1", "chunk-2"}, 2) == 0.5
    assert reciprocal_rank(ranked, {"chunk-1", "chunk-2"}, 3) == 0.5
    assert ndcg_at_k(ranked, {"chunk-1": 2, "chunk-2": 1}, 3) > 0


def test_golden_case_reports_recall_mrr_and_ndcg() -> None:
    result = evaluate_golden_case({"k": 2, "relevantDocumentIds": ["chunk-1"], "relevance": {"chunk-1": 2}}, ["chunk-1", "other"])
    assert result == {"recall": 1.0, "mrr": 1.0, "ndcg": 1.0}


def test_golden_runner_evaluates_parent_chunk_filter_and_dedup_metrics() -> None:
    cases = [{"id": "case-1", "filters": {"rating": {"operator": "gte", "value": 4}}, "relevantParentDocumentIds": ["p1"], "relevantChunkDocumentIds": ["c1"], "parentRelevance": {"p1": 2}, "chunkRelevance": {"c1": 2}, "k": 2}]
    responses = {"case-1": {"sources": [{"parentDocumentId": "p1", "chunkDocumentId": "c1", "metadata": {"rating": 5}}]}}
    report = enforce_quality_gate(evaluate_golden_set(cases, responses), {"parentRecall": 1, "parentMrr": 1, "parentNdcg": 1, "chunkRecall": 1, "filterPrecision": 1, "duplicateParentRate": 0})
    assert report["gate"]["passed"] is True
    assert report["metrics"]["parentRecall"] == 1.0


def test_golden_runner_rejects_duplicate_parents_or_bad_filter_results():
    cases = [{"id": "case-1", "filters": {"rating": {"operator": "gte", "value": 4}}, "relevantParentDocumentIds": ["p1"], "relevantChunkDocumentIds": ["c1"], "k": 2}]
    responses = {"case-1": {"sources": [{"parentDocumentId": "p1", "chunkDocumentId": "c1", "metadata": {"rating": 2}}, {"parentDocumentId": "p1", "chunkDocumentId": "c2", "metadata": {"rating": 2}}]}}
    with pytest.raises(RagQualityGateError):
        enforce_quality_gate(evaluate_golden_set(cases, responses))


def test_run_golden_set_calls_retriever_for_each_case():
    calls = []
    result = run_golden_set([{"id": "case-1", "relevantDocumentIds": ["p1"], "k": 1}], lambda case: calls.append(case["id"]) or {"sources": [{"parentDocumentId": "p1", "chunkDocumentId": "c1", "metadata": {}}]}, {"parentRecall": 1, "parentMrr": 1, "parentNdcg": 1, "chunkRecall": 0, "filterPrecision": 1, "duplicateParentRate": 0})
    assert calls == ["case-1"]
    assert result["gate"]["passed"] is True


def test_run_golden_set_rejects_duplicate_case_ids():
    with pytest.raises(ValueError, match="unique"):
        run_golden_set([{"id": "duplicate"}, {"id": "duplicate"}], lambda _: {"sources": []})
