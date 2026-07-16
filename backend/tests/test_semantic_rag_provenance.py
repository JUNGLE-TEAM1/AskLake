from types import SimpleNamespace
from unittest.mock import patch

from app.core.auth_context import ActorContext
from app.services.semantic_rag_context import build_semantic_rag_context


def test_shared_resolver_attaches_model_and_source_provenance() -> None:
    actor = ActorContext(name="analyst", role="admin")
    model = {
        "id": "sm_reviews",
        "name": "Reviews semantic layer",
        "version": 3,
        "status": "published",
        "datasetIds": ["reviews"],
    }
    profile = SimpleNamespace(
        review_state="approved",
        serving_status="serving",
        target_alias="asklake-rag-ds-reviews",
        active_embedding_model="text-embedding-3-small",
        active_embedding_dimensions=1536,
    )
    search_result = {
        "sources": [{
            "datasetId": "reviews",
            "parentDocumentId": "parent-1",
            "retrievalAlias": "asklake-rag-ds-reviews",
            "title": "review_text",
        }],
        "retrieval": {"status": "ready", "resultCount": 1},
    }

    with (
        patch("app.services.semantic_rag_context.SemanticModelService") as semantic_service,
        patch("app.services.semantic_rag_context.RagService") as rag_service,
        patch("app.services.semantic_rag_context.RagSearchService") as search_service,
    ):
        semantic_service.return_value.published_query_models_for_datasets.return_value = [model]
        rag_service.return_value.profile.return_value = profile
        search_service.return_value.search.return_value = search_result

        result = build_semantic_rag_context(
            db=object(),
            settings=SimpleNamespace(),
            actor=actor,
            query="배송이 느린 리뷰",
            dataset_ids=["reviews"],
        )

    assert result["retrieval"]["provenance"] == "semantic_layer_rag"
    assert result["retrieval"]["semanticModelNames"] == ["Reviews semantic layer"]
    assert result["retrieval"]["semanticModelVersions"] == [3]
    assert result["sources"][0]["semanticModelIds"] == ["sm_reviews"]
    assert result["sources"][0]["semanticModels"] == [model]


def test_shared_resolver_can_start_from_a_published_semantic_model() -> None:
    actor = ActorContext(name="analyst", role="admin")
    model = {
        "id": "sm_reviews",
        "name": "Reviews semantic layer",
        "version": 3,
        "status": "published",
        "datasetIds": ["reviews"],
        "metrics": [{"name": "negative_reviews", "label": "Negative reviews", "expression": "count(*)"}],
        "dimensions": [{"name": "region", "label": "Region", "columnName": "region"}],
        "vocabulary": [{"term": "VIP", "synonyms": ["high value"]}],
    }
    profile = SimpleNamespace(
        review_state="approved",
        serving_status="serving",
        target_alias="asklake-rag-ds-reviews",
        active_embedding_model="text-embedding-3-small",
        active_embedding_dimensions=1536,
    )

    with (
        patch("app.services.semantic_rag_context.SemanticModelService") as semantic_service,
        patch("app.services.semantic_rag_context.RagService") as rag_service,
        patch("app.services.semantic_rag_context.RagSearchService") as search_service,
    ):
        semantic_service.return_value.published_query_model.return_value = model
        rag_service.return_value.profile.return_value = profile
        search_service.return_value.search.return_value = {"sources": [], "retrieval": {"status": "ready"}}

        result = build_semantic_rag_context(
            db=object(),
            settings=SimpleNamespace(),
            actor=actor,
            query="VIP 리뷰",
            dataset_ids=[],
            semantic_model_id="sm_reviews",
        )

    assert result["retrieval"]["datasetIds"] == ["reviews"]
    assert result["retrieval"]["semanticModels"][0]["metrics"][0]["name"] == "negative_reviews"
    search_service.return_value.search.assert_called_once()
