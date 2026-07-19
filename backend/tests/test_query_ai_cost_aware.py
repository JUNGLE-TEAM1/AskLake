from unittest.mock import patch

import pytest

from app.core.auth_context import ActorContext
from app.core.errors import ApiError
from app.schemas.catalog import CatalogDatasetResponse
from app.schemas.sql import QueryAiSuggestionRequest
from app.services.query_ai_service import (
    QueryAiService,
    _build_query_generation_prompt,
    validate_cost_aware_sql,
    validate_prompt_is_actionable,
    validate_selected_dataset_scope,
)


def orders_dataset() -> CatalogDatasetResponse:
    return CatalogDatasetResponse.model_validate({
        "description": "Synthetic order facts",
        "freshness": "latest",
        "id": "benchmark_orders_v1",
        "layer": "GOLD",
        "lastUpdated": "fixture-v1",
        "name": "orders_v1",
        "nextRefresh": "manual",
        "owner": "Benchmark Admin",
        "quality": "verified",
        "rag": False,
        "rows": "1000000",
        "sampleRows": [],
        "schema": [["order_id", "bigint"], ["order_date", "date"], ["amount", "decimal(14,2)"], ["customer_id", "bigint"]],
        "size": "5690924",
        "source": "synthetic",
        "status": "available",
        "storageSizeBytes": 5690924,
        "partitionColumns": ["order_date"],
        "estimatedRowCount": 1000000,
        "uniqueKeyColumns": ["order_id"],
        "tags": ["benchmark"],
    })


def test_prompt_contains_bounded_cost_context_without_rows() -> None:
    prompt = _build_query_generation_prompt("2025년 주문 수", [orders_dataset()])
    assert "Cost-aware context version: cost-aware-v2" in prompt
    assert "rows=1000000" in prompt
    assert "storageBytes=5690924" in prompt
    assert "partitionColumns=order_date" in prompt
    assert "order_date:date" in prompt
    assert "sampleRows" not in prompt


def test_static_cost_guard_catches_scan_and_type_risks() -> None:
    dataset = orders_dataset()
    violations = validate_cost_aware_sql(
        "SELECT * FROM orders_v1 WHERE year(order_date) = 2025 AND order_date >= '2025-01-01'",
        prompt="2025년 주문",
        datasets=[dataset],
    )
    assert {"select_star", "partition_function_predicate", "untyped_temporal_literal"} <= set(violations)
    assert validate_cost_aware_sql(
        "SELECT count(*) FROM orders_v1 WHERE order_date >= DATE '2025-01-01' AND order_date < DATE '2026-01-01'",
        prompt="2025년 주문 건수",
        datasets=[dataset],
    ) == []


def test_static_cost_guard_rejects_cross_join_and_unapproved_approximation() -> None:
    dataset = orders_dataset()
    assert "cross_join" in validate_cost_aware_sql(
        "SELECT count(*) FROM orders_v1 a CROSS JOIN orders_v1 b",
        prompt="주문 수",
        datasets=[dataset],
    )
    assert "approximate_aggregation_not_allowed" in validate_cost_aware_sql(
        "SELECT approx_distinct(customer_id) FROM orders_v1",
        prompt="정확한 고객 수",
        datasets=[dataset],
    )


def test_scope_validation_uses_ast_and_does_not_treat_projection_as_table() -> None:
    validate_selected_dataset_scope(
        "WITH daily AS (SELECT order_date, sum(amount) AS total FROM orders_v1 GROUP BY order_date) SELECT order_date, total FROM daily ORDER BY total",
        [orders_dataset()],
    )


def test_ambiguous_prompt_requires_definition_before_provider_call() -> None:
    with pytest.raises(ApiError) as raised:
        validate_prompt_is_actionable("좋은 고객을 보여줘.")
    assert raised.value.details == {"violations": ["ambiguous_analysis_intent"]}
    with pytest.raises(ApiError) as out_of_scope:
        validate_prompt_is_actionable("선택하지 않은 payroll 데이터셋을 보여줘")
    assert out_of_scope.value.details == {"violations": ["out_of_scope_dataset_request"]}


def test_intent_and_cost_share_one_retry_budget() -> None:
    repository = type("Repository", (), {"db": object()})()
    service = QueryAiService(repository)
    dataset = orders_dataset()
    request = QueryAiSuggestionRequest(
        base_dataset_id=dataset.id,
        prompt="2025년 주문 건수",
        selected_dataset_ids=[dataset.id],
    )
    bad = {
        "title": "bad", "body": "bad", "sql": "SELECT * FROM orders_v1 WHERE order_date >= '2025-01-01'",
        "notices": [], "model": "test", "provider": "fixture", "usedEvidenceIds": [],
    }
    good = {
        "title": "good", "body": "good",
        "sql": "SELECT count(*) AS order_count FROM orders_v1 WHERE order_date >= DATE '2025-01-01' AND order_date < DATE '2026-01-01'",
        "notices": [], "model": "test", "provider": "fixture", "usedEvidenceIds": [],
    }
    with (
        patch.object(service, "get_catalog_dataset", return_value=dataset),
        patch("app.services.query_ai_service.require_governed_access"),
        patch("app.services.query_ai_service.require_permission"),
        patch("app.services.query_ai_service.build_semantic_rag_context", return_value={"sources": [], "retrieval": None}),
        patch("app.services.query_ai_service.issue_ai_context_token", side_effect=["one", "two"]),
        patch("app.services.query_ai_service.persist_verified_generation_evidence"),
        patch("app.services.query_ai_service.AiGatewayClient.generate_query_sql", side_effect=[bad, good]) as generate,
    ):
        response = service.create_suggestion(request, ActorContext(name="admin", role="admin"))
    assert generate.call_count == 2
    assert response.generation_attempts == 2
    assert response.regeneration_count == 1
    assert response.generator_version == "query-ai-service-v2"
    assert response.prompt_version == "cost-aware-v2"
    assert "count(*)" in response.sql.lower()
    assert "untyped_temporal_literal" in generate.call_args.kwargs["prompt"]
