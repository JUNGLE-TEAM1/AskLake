from app.services.rag_evaluation import evaluate_golden_case, ndcg_at_k, recall_at_k, reciprocal_rank


def test_retrieval_quality_metrics_use_ranked_chunk_ids() -> None:
    ranked = ["irrelevant", "chunk-2", "chunk-1"]
    assert recall_at_k(ranked, {"chunk-1", "chunk-2"}, 2) == 0.5
    assert reciprocal_rank(ranked, {"chunk-1", "chunk-2"}, 3) == 0.5
    assert ndcg_at_k(ranked, {"chunk-1": 2, "chunk-2": 1}, 3) > 0


def test_golden_case_reports_recall_mrr_and_ndcg() -> None:
    result = evaluate_golden_case({"k": 2, "relevantDocumentIds": ["chunk-1"], "relevance": {"chunk-1": 2}}, ["chunk-1", "other"])
    assert result == {"recall": 1.0, "mrr": 1.0, "ndcg": 1.0}
