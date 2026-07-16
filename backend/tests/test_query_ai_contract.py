import unittest
from unittest.mock import patch

from fastapi import status
from pydantic import ValidationError

from app.core.auth_context import ActorContext
from app.core.errors import ApiError
from app.schemas.catalog import CatalogDatasetResponse
from app.schemas.sql import QueryAiSuggestionRequest
from app.services.query_ai_service import (
    OpenAiResponsesClient,
    QueryAiService,
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


class QueryAiContractTests(unittest.TestCase):
    def test_public_query_ai_request_matches_gateway_input_limits(self) -> None:
        with self.assertRaises(ValidationError):
            QueryAiSuggestionRequest(prompt="x" * 8_001, selected_dataset_ids=["reviews"])
        with self.assertRaises(ValidationError):
            QueryAiSuggestionRequest(
                prompt="count",
                selected_dataset_ids=[f"dataset-{index}" for index in range(101)],
            )

    def test_missing_provider_configuration_is_reported_as_unavailable(self) -> None:
        client = OpenAiResponsesClient(api_key=None, model="gpt-test")

        with self.assertRaises(ApiError) as raised:
            client.create_json_response(system_prompt="system", user_payload={"prompt": "count"})

        self.assertEqual(raised.exception.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)
        self.assertIn("OPENAI_API_KEY", raised.exception.message)

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
            patch(
                "app.services.query_ai_service.OpenAiResponsesClient.create_json_response",
                return_value='{"title":"Counts","body":"Draft","sql":"SELECT review_id FROM review_gold LIMIT 10","notices":[]}',
            ),
        ):
            response = service.create_suggestion(request, actor)

        self.assertEqual(response.sql, "SELECT review_id FROM review_gold LIMIT 10")
        self.assertIs(governed.call_args.args[0], repository.db)
        self.assertEqual(governed.call_args.kwargs["api_path"], "/api/query/ai-suggestions")

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
            patch(
                "app.services.query_ai_service.OpenAiResponsesClient.create_json_response",
                return_value='{"title":"Unsafe","body":"Draft","sql":"DELETE FROM review_gold","notices":[]}',
            ),
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
            patch("app.services.query_ai_service.settings.ai_query_provider", "gateway"),
            patch("app.services.query_ai_service.AiGatewayClient.generate_query_sql") as generate,
        ):
            generate.return_value = {
                "title": "Counts",
                "body": "Gateway draft",
                "sql": "SELECT review_id FROM review_gold LIMIT 10",
                "notices": [],
                "model": "gateway-test-model",
            }
            response = service.create_suggestion(request, ActorContext(name="analyst", role="admin"))

        self.assertEqual(response.model, "gateway-test-model")
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
            "sources": [{"datasetId": dataset.id, "parentDocumentId": "parent-1", "title": "review_text"}],
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
            patch(
                "app.services.query_ai_service.OpenAiResponsesClient.create_json_response",
                return_value='{"title":"Counts","body":"Draft","sql":"SELECT count(*) FROM review_gold LIMIT 10","notices":[]}',
            ) as generate,
        ):
            response = service.create_suggestion(request, ActorContext(name="analyst", role="admin"))

        self.assertEqual(response.retrieval["provenance"], "semantic_layer_rag")
        self.assertEqual(response.sources[0]["parentDocumentId"], "parent-1")
        self.assertEqual(generate.call_args.kwargs["user_payload"]["ragContext"], rag_context)

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
            patch("app.services.query_ai_service.settings.ai_query_provider", "gateway"),
            patch("app.services.query_ai_service.build_semantic_rag_context", return_value=rag_context),
            patch("app.services.query_ai_service.AiGatewayClient.generate_query_sql") as generate,
        ):
            generate.return_value = {
                "title": "Counts",
                "body": "Gateway draft",
                "sql": "SELECT review_id FROM review_gold LIMIT 10",
                "notices": [],
                "model": "gateway-test-model",
            }
            response = service.create_suggestion(request, ActorContext(name="analyst", role="admin"))

        self.assertEqual(response.retrieval["provenance"], "semantic_layer_rag")
        self.assertEqual(generate.call_args.kwargs["rag_context"], rag_context)


if __name__ == "__main__":
    unittest.main()
