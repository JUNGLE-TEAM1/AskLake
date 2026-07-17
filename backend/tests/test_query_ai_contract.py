import unittest
from unittest.mock import patch

from fastapi import status
from pydantic import ValidationError

from app.core.auth_context import ActorContext
from app.core.errors import ApiError
from app.schemas.catalog import CatalogDatasetResponse
from app.schemas.sql import QueryAiSuggestionRequest
from app.services.query_ai_service import (
    QueryAiService,
    ensure_preview_limit,
    validate_query_intent_contract,
    validate_selected_dataset_scope,
)


def catalog_dataset(dataset_id: str = "reviews") -> CatalogDatasetResponse:
    return CatalogDatasetResponse.model_validate({
        "description": "Amazon review facts",
        "freshness": "latest",
        "id": dataset_id,
        "layer": "GOLD",
        "lastUpdated": "2026-07-12T00:00:00Z",
        "name": "review_gold",
        "nextRefresh": "manual",
        "owner": "data-team",
        "quality": "validated",
        "rag": False,
        "rows": "10",
        "sampleRows": [["review-1", "5"]],
        "schema": [["review_id", "string"], ["rating", "integer"]],
        "size": "1 KB",
        "source": "Amazon reviews",
        "status": "available",
        "tags": ["reviews"],
    })


def amazon_products_dataset() -> CatalogDatasetResponse:
    return CatalogDatasetResponse.model_validate({
        "description": "Amazon product catalog",
        "freshness": "latest",
        "id": "amazon-products",
        "layer": "GOLD",
        "lastUpdated": "2026-07-17T00:00:00Z",
        "name": "amazon_products",
        "nextRefresh": "manual",
        "owner": "data-team",
        "quality": "validated",
        "rag": False,
        "rows": "100",
        "sampleRows": [["Electronics", "Headphones", "29.9", "p-1"]],
        "schema": [
            ["category", "string"],
            ["title", "string"],
            ["price", "double"],
            ["product_id", "string"],
        ],
        "size": "10 KB",
        "source": "Amazon",
        "status": "available",
        "tags": ["amazon", "products"],
    })


class QueryAiContractTests(unittest.TestCase):
    def test_amazon_dataset_qualifier_cannot_be_hallucinated_as_a_title_filter(self) -> None:
        prompt = "Amazon 상품 카테고리별 평균 가격과 상품 수를 보여줘"

        with self.assertRaises(ApiError) as raised:
            validate_query_intent_contract(
                prompt,
                "SELECT * FROM amazon_products WHERE title LIKE '%Amazon%' LIMIT 100",
                [amazon_products_dataset()],
            )

        violations = raised.exception.details["violations"]
        self.assertIn("dataset_qualifier_filter", violations)
        self.assertIn("missing_average", violations)
        self.assertIn("missing_count", violations)
        self.assertIn("missing_grouping", violations)

    def test_amazon_aggregate_prompt_retries_once_and_returns_matching_sql(self) -> None:
        repository = type("Repository", (), {"db": object()})()
        service = QueryAiService(repository)
        dataset = amazon_products_dataset()
        request = QueryAiSuggestionRequest(
            base_dataset_id=dataset.id,
            prompt="Amazon 상품 카테고리별 평균 가격과 상품 수를 보여줘",
            selected_dataset_ids=[dataset.id],
        )
        bad = {
            "title": "Products",
            "body": "Wrong interpretation",
            "sql": "SELECT * FROM amazon_products WHERE title LIKE '%Amazon%' LIMIT 100",
            "notices": [],
            "model": "gateway-test-model",
            "provider": "openai_compatible",
            "usedEvidenceIds": [],
        }
        good = {
            "title": "Category summary",
            "body": "Average price and product count by category",
            "sql": (
                "SELECT category, AVG(price) AS average_price, COUNT(*) AS product_count "
                "FROM amazon_products GROUP BY category LIMIT 100"
            ),
            "notices": [],
            "model": "gateway-test-model",
            "provider": "openai_compatible",
            "usedEvidenceIds": [],
        }

        with (
            patch.object(service, "get_catalog_dataset", return_value=dataset),
            patch("app.services.query_ai_service.require_governed_access"),
            patch("app.services.query_ai_service.require_permission"),
            patch(
                "app.services.query_ai_service.build_semantic_rag_context",
                return_value={
                    "sources": [],
                    "retrieval": {"status": "no_published_semantic_model", "resultCount": 0},
                },
            ),
            patch("app.services.query_ai_service.issue_ai_context_token", side_effect=["token-1", "token-2"]),
            patch("app.services.query_ai_service.persist_verified_generation_evidence"),
            patch(
                "app.services.query_ai_service.AiGatewayClient.generate_query_sql",
                side_effect=[bad, good],
            ) as generate,
        ):
            response = service.create_suggestion(request, ActorContext(name="analyst", role="admin"))

        self.assertEqual(generate.call_count, 2)
        self.assertIn("AVG(price)", response.sql)
        self.assertIn("COUNT(*)", response.sql)
        self.assertIn("GROUP BY category", response.sql)
        self.assertNotIn("LIKE '%Amazon%'", response.sql)
        self.assertIn("검증 실패", generate.call_args.kwargs["prompt"])

    def test_preview_limit_is_applied_to_the_outer_query_not_a_nested_subquery(self) -> None:
        sql = ensure_preview_limit(
            "SELECT * FROM (SELECT * FROM review_gold LIMIT 5) nested_reviews"
        )

        self.assertIn("LIMIT 5", sql)
        self.assertTrue(sql.endswith("LIMIT 100;"))

    def test_preview_limit_preserves_safe_root_limit_and_caps_unsafe_root_limit(self) -> None:
        safe = "SELECT * FROM review_gold LIMIT 10"

        self.assertEqual(ensure_preview_limit(safe), safe)
        self.assertTrue(ensure_preview_limit("SELECT * FROM review_gold LIMIT 500").endswith("LIMIT 100;"))
        self.assertTrue(ensure_preview_limit("SELECT * FROM review_gold LIMIT ALL").endswith("LIMIT 100;"))

    def test_public_query_ai_request_matches_gateway_input_limits(self) -> None:
        with self.assertRaises(ValidationError):
            QueryAiSuggestionRequest(prompt="x" * 8_001, selected_dataset_ids=["reviews"])
        with self.assertRaises(ValidationError):
            QueryAiSuggestionRequest(
                prompt="count",
                selected_dataset_ids=[f"dataset-{index}" for index in range(101)],
            )

    def test_service_uses_catalog_database_and_route_for_governance_audit(self) -> None:
        repository = type("Repository", (), {"db": object()})()
        service = QueryAiService(repository)
        dataset = catalog_dataset()
        request = QueryAiSuggestionRequest(
            base_dataset_id=dataset.id,
            prompt="Show review counts",
            selected_dataset_ids=[dataset.id],
        )
        actor = ActorContext(name="analyst", role="admin")

        with (
            patch.object(service, "get_catalog_dataset", return_value=dataset),
            patch("app.services.query_ai_service.require_governed_access") as governed,
            patch("app.services.query_ai_service.require_permission"),
            patch("app.services.query_ai_service.persist_verified_generation_evidence") as persist_evidence,
            patch("app.services.query_ai_service.AiGatewayClient.generate_query_sql", return_value={
                "title": "Counts",
                "body": "Draft",
                "sql": "SELECT review_id FROM review_gold LIMIT 10",
                "notices": [],
                "model": "gateway-test-model",
                "provider": "openai_compatible",
                "requestId": "query-audit-1",
            }),
        ):
            response = service.create_suggestion(request, actor)

        self.assertEqual(response.sql, "SELECT review_id FROM review_gold LIMIT 10")
        self.assertIs(governed.call_args.args[0], repository.db)
        self.assertEqual(governed.call_args.kwargs["api_path"], "/api/query/ai-suggestions")
        persist_evidence.assert_called_once()

    def test_generated_sql_cannot_reference_an_unselected_dataset(self) -> None:
        with self.assertRaises(ApiError) as raised:
            validate_selected_dataset_scope(
                "SELECT * FROM secret_reviews",
                [catalog_dataset()],
            )

        self.assertEqual(raised.exception.status_code, status.HTTP_422_UNPROCESSABLE_ENTITY)
        self.assertEqual(raised.exception.details, {"tables": ["secret_reviews"]})

    def test_generated_sql_is_revalidated_as_read_only(self) -> None:
        repository = type("Repository", (), {"db": object()})()
        service = QueryAiService(repository)
        dataset = catalog_dataset()
        request = QueryAiSuggestionRequest(
            base_dataset_id=dataset.id,
            prompt="Delete bad reviews",
            selected_dataset_ids=[dataset.id],
        )

        with (
            patch.object(service, "get_catalog_dataset", return_value=dataset),
            patch("app.services.query_ai_service.require_governed_access"),
            patch("app.services.query_ai_service.require_permission"),
            patch("app.services.query_ai_service.AiGatewayClient.generate_query_sql", return_value={
                "title": "Unsafe",
                "body": "Draft",
                "sql": "DELETE FROM review_gold",
                "notices": [],
                "model": "gateway-test-model",
            }),
        ):
            with self.assertRaises(ApiError) as raised:
                service.create_suggestion(request, ActorContext(name="analyst", role="admin"))

        self.assertEqual(raised.exception.status_code, status.HTTP_403_FORBIDDEN)

    def test_gateway_mode_keeps_the_public_response_and_signed_dataset_scope(self) -> None:
        repository = type("Repository", (), {"db": object()})()
        service = QueryAiService(repository)
        dataset = catalog_dataset()
        request = QueryAiSuggestionRequest(
            base_dataset_id=dataset.id,
            prompt="Show review counts",
            selected_dataset_ids=[dataset.id],
        )

        with (
            patch.object(service, "get_catalog_dataset", return_value=dataset),
            patch("app.services.query_ai_service.require_governed_access"),
            patch("app.services.query_ai_service.require_permission"),
            patch("app.services.query_ai_service.persist_verified_generation_evidence"),
            patch("app.services.query_ai_service.AiGatewayClient.generate_query_sql") as generate,
        ):
            generate.return_value = {
                "title": "Counts",
                "body": "Gateway draft",
                "sql": "SELECT review_id FROM review_gold LIMIT 10",
                "notices": [],
                "model": "gateway-test-model",
                "provider": "openai_compatible",
                "requestId": "query-audit-2",
            }
            response = service.create_suggestion(request, ActorContext(name="analyst", role="admin"))

        self.assertEqual(response.model, "gateway-test-model")
        self.assertEqual(response.provider, "openai_compatible")
        self.assertEqual(response.sql, "SELECT review_id FROM review_gold LIMIT 10")
        self.assertEqual(generate.call_args.kwargs["selected_dataset_ids"], [dataset.id])
        self.assertTrue(generate.call_args.kwargs["context_token"])

    def test_sql_suggestion_returns_semantic_layer_rag_provenance(self) -> None:
        repository = type("Repository", (), {"db": object()})()
        service = QueryAiService(repository)
        dataset = catalog_dataset()
        request = QueryAiSuggestionRequest(
            base_dataset_id=dataset.id,
            prompt="Show negative review counts",
            selected_dataset_ids=[dataset.id],
        )
        rag_context = {
            "sources": [{"documentId": "doc-1", "datasetId": dataset.id, "parentDocumentId": "parent-1", "title": "review_text"}],
            "retrieval": {
                "provenance": "semantic_layer_rag",
                "semanticModelIds": ["sm_reviews"],
                "semanticModelNames": ["Reviews semantic layer"],
                "semanticModelVersions": [3],
                "datasetIds": [dataset.id],
                "status": "ready",
                "resultCount": 1,
            },
        }

        with (
            patch.object(service, "get_catalog_dataset", return_value=dataset),
            patch("app.services.query_ai_service.require_governed_access"),
            patch("app.services.query_ai_service.require_permission"),
            patch("app.services.query_ai_service.build_semantic_rag_context", return_value=rag_context),
            patch("app.services.query_ai_service.persist_verified_generation_evidence"),
            patch("app.services.query_ai_service.AiGatewayClient.generate_query_sql", return_value={
                "title": "Counts",
                "body": "Draft",
                "sql": "SELECT count(*) FROM review_gold LIMIT 10",
                "notices": [],
                "model": "gateway-test-model",
                "provider": "openai_compatible",
                "requestId": "query-audit-3",
                "usedEvidenceIds": ["doc-1"],
            }) as generate,
        ):
            response = service.create_suggestion(request, ActorContext(name="analyst", role="admin"))

        self.assertEqual(response.retrieval["provenance"], "semantic_layer_rag")
        self.assertEqual(response.retrieval["evidenceStatus"], "used")
        self.assertEqual(response.sources[0]["parentDocumentId"], "parent-1")
        self.assertEqual(response.used_evidence_ids, ["doc-1"])
        self.assertEqual(generate.call_args.kwargs["rag_context"], rag_context)

    def test_gateway_receives_semantic_layer_rag_context(self) -> None:
        repository = type("Repository", (), {"db": object()})()
        service = QueryAiService(repository)
        dataset = catalog_dataset()
        request = QueryAiSuggestionRequest(
            base_dataset_id=dataset.id,
            prompt="Show review counts",
            selected_dataset_ids=[dataset.id],
        )
        rag_context = {"sources": [], "retrieval": {"provenance": "semantic_layer_rag", "status": "ready"}}

        with (
            patch.object(service, "get_catalog_dataset", return_value=dataset),
            patch("app.services.query_ai_service.require_governed_access"),
            patch("app.services.query_ai_service.require_permission"),
            patch("app.services.query_ai_service.build_semantic_rag_context", return_value=rag_context),
            patch("app.services.query_ai_service.persist_verified_generation_evidence"),
            patch("app.services.query_ai_service.AiGatewayClient.generate_query_sql") as generate,
        ):
            generate.return_value = {
                "title": "Counts",
                "body": "Gateway draft",
                "sql": "SELECT review_id FROM review_gold LIMIT 10",
                "notices": [],
                "model": "gateway-test-model",
                "provider": "openai_compatible",
                "requestId": "query-audit-4",
                "usedEvidenceIds": [],
            }
            response = service.create_suggestion(request, ActorContext(name="analyst", role="admin"))

        self.assertEqual(response.retrieval["provenance"], "semantic_layer_rag")
        self.assertEqual(response.retrieval["evidenceStatus"], "not_used")
        self.assertEqual(response.sources, [])
        self.assertEqual(generate.call_args.kwargs["rag_context"], rag_context)


if __name__ == "__main__":
    unittest.main()
