from types import SimpleNamespace
from unittest.mock import patch

from app.core.auth_context import ActorContext
from app.services.semantic_rag_context import build_semantic_rag_context
from app.services.rag_tokens import count_tokens


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
    assert "semanticModels" not in result["sources"][0]


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


def test_shared_resolver_keeps_content_preserving_chunking_fallback_for_generation() -> None:
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
        active_embedding_provider="openai_compatible",
        active_embedding_model="text-embedding-3-small",
        active_embedding_dimensions=1536,
    )
    alias = "asklake-rag-ds-reviews"

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
                    "documentId": "doc-trusted",
                    "datasetId": "reviews",
                    "retrievalAlias": alias,
                    "fallbackApplied": False,
                },
                {
                    "documentId": "doc-fallback",
                    "datasetId": "reviews",
                    "retrievalAlias": alias,
                    "fallbackApplied": True,
                    "fallbackReasons": ["gateway_timeout"],
                },
            ],
            "retrieval": {
                "status": "degraded",
                "resultCount": 2,
                "fallbackEvidenceCount": 1,
                "fallbackReasons": ["gateway_timeout"],
            },
        }

        result = build_semantic_rag_context(
            db=object(),
            settings=SimpleNamespace(),
            actor=actor,
            query="late delivery",
            dataset_ids=["reviews"],
        )

    assert [source["documentId"] for source in result["sources"]] == ["doc-trusted", "doc-fallback"]
    assert all(source["semanticModelIds"] == ["sm_reviews"] for source in result["sources"])
    assert result["sources"][1]["fallbackApplied"] is True
    assert result["retrieval"]["resultCount"] == 2
    assert result["retrieval"]["fallbackEvidenceCount"] == 1
    assert result["retrieval"]["fallbackReasons"] == ["gateway_timeout"]


def test_shared_resolver_bounds_total_body_context_and_compacts_nested_chunks() -> None:
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
        active_embedding_provider="openai_compatible",
        active_embedding_model="text-embedding-3-small",
        active_embedding_dimensions=1536,
    )
    alias = "asklake-rag-ds-reviews"
    long_body = " ".join(f"token{index}" for index in range(200))

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
                    "documentId": f"doc-{index}",
                    "datasetId": "reviews",
                    "retrievalAlias": alias,
                    "body": long_body,
                    "context": long_body,
                    "chunks": [{
                        "documentId": f"chunk-{index}",
                        "chunkDocumentId": f"chunk-{index}",
                        "chunkIndex": 0,
                        "charStart": 0,
                        "charEnd": len(long_body),
                        "body": long_body,
                        "metadata": {"duplicated": long_body},
                    }],
                }
                for index in range(2)
            ],
            "retrieval": {"status": "ready", "resultCount": 2},
        }

        result = build_semantic_rag_context(
            db=object(),
            settings=SimpleNamespace(rag_context_max_tokens=100),
            actor=actor,
            query="late delivery",
            dataset_ids=["reviews"],
        )

    assert sum(count_tokens(source["body"]) for source in result["sources"]) <= 100
    assert result["retrieval"]["contextTokenBudget"] == 100
    assert result["retrieval"]["contextTokenCount"] <= 100
    assert all("context" not in source for source in result["sources"])
    assert all("semanticModels" not in source for source in result["sources"])
    assert all("body" not in source["chunks"][0] for source in result["sources"])
    assert all("metadata" not in source["chunks"][0] for source in result["sources"])
