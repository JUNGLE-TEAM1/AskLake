from types import SimpleNamespace

from app.core.auth_context import ActorContext
from app.services.semantic_rag_context import build_semantic_rag_context


def test_disabled_rag_context_preserves_compatibility_shape() -> None:
    result = build_semantic_rag_context(
        db=object(),
        settings=SimpleNamespace(),
        actor=ActorContext(name="analyst", role="viewer"),
        query="배송이 느린 리뷰",
        dataset_ids=[" reviews ", "orders", "reviews", "", " orders "],
        semantic_model_id="ignored-while-rag-is-retired",
        filters={"rating": {"operator": "gte", "value": 3}},
    )

    assert result == {
        "sources": [],
        "retrieval": {
            "mode": "disabled",
            "status": "disabled",
            "provenance": "rag_removed",
            "datasetIds": ["reviews", "orders"],
            "resultCount": 0,
        },
    }
