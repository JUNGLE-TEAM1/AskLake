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
        active_embedding_provider="openai",
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
        rag_service.return_value.search_target_context.return_value = {"datasetId": "reviews"}
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
        active_embedding_provider="openai",
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
        rag_service.return_value.search_target_context.return_value = {"datasetId": "reviews"}
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


def test_explicit_model_preserves_dataset_order_and_normalizes_requested_ids() -> None:
    actor = ActorContext(name="analyst", role="admin")
    model = {
        "id": "sm_multi",
        "name": "Multi dataset model",
        "version": 1,
        "status": "published",
        "datasetIds": ["dataset-b", "dataset-a"],
    }
    profile_by_id = {
        dataset_id: SimpleNamespace(
            review_state="approved",
            serving_status="serving",
            target_alias=f"alias-{dataset_id}",
            active_embedding_provider="openai",
            active_embedding_model="text-embedding-3-small",
            active_embedding_dimensions=1536,
        )
        for dataset_id in model["datasetIds"]
    }

    with (
        patch("app.services.semantic_rag_context.SemanticModelService") as semantic_service,
        patch("app.services.semantic_rag_context.RagService") as rag_service,
        patch("app.services.semantic_rag_context.RagSearchService") as search_service,
    ):
        semantic_service.return_value.published_query_model.return_value = model
        rag_service.return_value.profile.side_effect = lambda dataset_id, _actor: profile_by_id[dataset_id]
        rag_service.return_value.search_target_context.side_effect = (
            lambda dataset_id, _actor, **_kwargs: {"datasetId": dataset_id}
        )
        search_service.return_value.search.return_value = {"sources": [], "retrieval": {"status": "ready"}}

        from_model = build_semantic_rag_context(
            db=object(),
            settings=SimpleNamespace(),
            actor=actor,
            query="query",
            dataset_ids=[],
            semantic_model_id="sm_multi",
        )
        normalized = build_semantic_rag_context(
            db=object(),
            settings=SimpleNamespace(),
            actor=actor,
            query="query",
            dataset_ids=[" dataset-a "],
            semantic_model_id="sm_multi",
        )

    assert from_model["retrieval"]["datasetIds"] == ["dataset-b", "dataset-a"]
    assert normalized["retrieval"]["datasetIds"] == ["dataset-a"]


def test_shared_resolver_rejects_partially_mismatched_explicit_model_selection() -> None:
    actor = ActorContext(name="analyst", role="admin")
    model = {
        "id": "sm_a",
        "name": "Model A",
        "version": 1,
        "status": "published",
        "datasetIds": ["dataset-a"],
    }

    with (
        patch("app.services.semantic_rag_context.SemanticModelService") as semantic_service,
        patch("app.services.semantic_rag_context.RagService"),
        patch("app.services.semantic_rag_context.RagSearchService") as search_service,
    ):
        semantic_service.return_value.published_query_model.return_value = model
        result = build_semantic_rag_context(
            db=object(),
            settings=SimpleNamespace(),
            actor=actor,
            query="query",
            dataset_ids=["dataset-a", "dataset-b"],
            semantic_model_id="sm_a",
        )

    assert result["sources"] == []
    assert result["retrieval"]["status"] == "semantic_model_dataset_mismatch"
    assert result["retrieval"]["missingDatasetIds"] == ["dataset-b"]
    search_service.return_value.search.assert_not_called()


def test_shared_resolver_does_not_attribute_unbound_dataset_to_another_model() -> None:
    actor = ActorContext(name="analyst", role="admin")
    model = {
        "id": "sm_a",
        "name": "Model A",
        "version": 1,
        "status": "published",
        "datasetIds": ["dataset-a"],
    }

    with (
        patch("app.services.semantic_rag_context.SemanticModelService") as semantic_service,
        patch("app.services.semantic_rag_context.RagService"),
        patch("app.services.semantic_rag_context.RagSearchService") as search_service,
    ):
        semantic_service.return_value.published_query_models_for_datasets.return_value = [model]
        result = build_semantic_rag_context(
            db=object(),
            settings=SimpleNamespace(),
            actor=actor,
            query="query",
            dataset_ids=["dataset-a", "dataset-b"],
        )

    assert result["sources"] == []
    assert result["retrieval"]["status"] == "dataset_without_published_semantic_model"
    assert result["retrieval"]["missingDatasetIds"] == ["dataset-b"]
    search_service.return_value.search.assert_not_called()


def test_source_dataset_must_match_alias_target_dataset() -> None:
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
        active_embedding_provider="openai",
        active_embedding_model="text-embedding-3-small",
        active_embedding_dimensions=1536,
    )

    with (
        patch("app.services.semantic_rag_context.SemanticModelService") as semantic_service,
        patch("app.services.semantic_rag_context.RagService") as rag_service,
        patch("app.services.semantic_rag_context.RagSearchService") as search_service,
    ):
        semantic_service.return_value.published_query_models_for_datasets.return_value = [model]
        rag_service.return_value.profile.return_value = profile
        rag_service.return_value.search_target_context.return_value = {"datasetId": "reviews"}
        search_service.return_value.search.return_value = {
            "sources": [
                {
                    "documentId": "doc-valid",
                    "datasetId": "reviews",
                    "retrievalAlias": "asklake-rag-ds-reviews",
                    "title": "valid document in a contaminated response",
                },
                {
                    "documentId": "doc-other-dataset",
                    "datasetId": "orders",
                    "retrievalAlias": "asklake-rag-ds-reviews",
                    "title": "wrongly indexed document",
                },
            ],
            "retrieval": {"status": "ready", "resultCount": 2},
        }

        result = build_semantic_rag_context(
            db=object(),
            settings=SimpleNamespace(),
            actor=actor,
            query="배송이 느린 리뷰",
            dataset_ids=["reviews"],
        )

    assert result["sources"] == []
    assert result["retrieval"]["status"] == "evidence_scope_mismatch"
    assert result["retrieval"]["resultCount"] == 0
