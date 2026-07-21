from unittest.mock import patch

import pytest

from app.core.auth_context import ActorContext
from app.core.errors import ApiError
from app.schemas.catalog import CatalogDatasetResponse
from app.schemas.sql import QueryAiSuggestionRequest
from app.services.query_ai_join_contract import (
    build_query_join_plan,
    join_context_lines,
    prompt_requests_join,
    used_join_evidence,
    validate_query_join_contract,
)
from app.services.query_ai_service import QueryAiService, _validate_generation_prompt_size


def dataset(
    dataset_id: str,
    name: str,
    schema: list[list[str]],
    *,
    unique_key_columns: list[str] | None = None,
    unique_key_sets: list[list[str]] | None = None,
    estimated_rows: int = 1_000,
) -> CatalogDatasetResponse:
    return CatalogDatasetResponse.model_validate({
        "description": f"{name} analytics data",
        "freshness": "latest",
        "id": dataset_id,
        "layer": "GOLD",
        "lastUpdated": "2026-07-19T00:00:00Z",
        "name": name,
        "nextRefresh": "manual",
        "owner": "data-team",
        "quality": "validated",
        "rag": False,
        "rows": str(estimated_rows),
        "sampleRows": [],
        "schema": schema,
        "size": "1 MB",
        "source": "commerce",
        "status": "available",
        "estimatedRowCount": estimated_rows,
        "uniqueKeyColumns": unique_key_columns or [],
        "uniqueKeySets": unique_key_sets or [],
        "tags": [name],
    })


def commerce_datasets() -> tuple[CatalogDatasetResponse, CatalogDatasetResponse, CatalogDatasetResponse]:
    orders = dataset(
        "orders",
        "orders_v1",
        [
            ["order_id", "bigint"],
            ["customer_id", "bigint"],
            ["product_id", "bigint"],
            ["amount", "decimal(14,2)"],
        ],
        unique_key_columns=["order_id"],
        estimated_rows=1_000_000,
    )
    customers = dataset(
        "customers",
        "customers_v1",
        [["customer_id", "bigint"], ["region", "varchar"]],
        unique_key_columns=["customer_id"],
    )
    products = dataset(
        "products",
        "products_v1",
        [["product_id", "bigint"], ["category", "varchar"]],
        unique_key_columns=["product_id"],
    )
    return orders, customers, products


def test_catalog_unique_keys_become_exact_allowed_relationships() -> None:
    orders, customers, products = commerce_datasets()
    plan = build_query_join_plan([orders, customers, products], None)

    lines = "\n".join(join_context_lines(plan, [orders, customers, products]))
    assert '"orders_v1"."customer_id" = "customers_v1"."customer_id"' in lines
    assert '"orders_v1"."product_id" = "products_v1"."product_id"' in lines
    assert "source=catalog_unique_key" in lines

    violations = validate_query_join_contract(
        """
        SELECT c.region, p.category, SUM(o.amount) AS revenue
        FROM orders_v1 o
        JOIN customers_v1 c ON o.customer_id = c.customer_id
        JOIN products_v1 p ON o.product_id = p.product_id
        GROUP BY c.region, p.category
        """,
        datasets=[orders, customers, products],
        plan=plan,
        join_required=True,
    )
    assert violations == []
    evidence = used_join_evidence(
        """
        SELECT c.region, p.category, SUM(o.amount) AS revenue
        FROM orders_v1 o
        JOIN customers_v1 c ON o.customer_id = c.customer_id
        JOIN products_v1 p ON o.product_id = p.product_id
        GROUP BY c.region, p.category
        """,
        datasets=[orders, customers, products],
        plan=plan,
    )
    assert len(evidence) == 2
    assert {item["source"] for item in evidence} == {"catalog_unique_key"}


def test_invented_or_missing_join_keys_are_rejected() -> None:
    orders, customers, products = commerce_datasets()
    plan = build_query_join_plan([orders, customers, products], None)

    invented = validate_query_join_contract(
        "SELECT o.order_id, p.category FROM orders_v1 o JOIN products_v1 p ON o.customer_id = p.product_id",
        datasets=[orders, products],
        plan=build_query_join_plan([orders, products], None),
        join_required=True,
    )
    missing = validate_query_join_contract(
        "SELECT o.order_id FROM orders_v1 o JOIN customers_v1 c ON o.made_up_id = c.customer_id",
        datasets=[orders, customers],
        plan=build_query_join_plan([orders, customers], None),
        join_required=True,
    )
    unqualified = validate_query_join_contract(
        "SELECT o.order_id FROM orders_v1 o JOIN customers_v1 c ON customer_id = c.customer_id",
        datasets=[orders, customers],
        plan=build_query_join_plan([orders, customers], None),
        join_required=True,
    )

    assert "join_relationship_not_allowed" in invented
    assert "join_column_not_found:o.made_up_id" in missing
    assert "join_column_unqualified:customer_id" in unqualified
    assert plan.relationships


def test_join_predicate_must_be_an_and_of_column_equalities() -> None:
    orders, customers, _products = commerce_datasets()
    plan = build_query_join_plan([orders, customers], None)

    for predicate in (
        "o.customer_id > c.customer_id",
        "o.customer_id = c.customer_id OR o.order_id = c.customer_id",
        "TRUE",
    ):
        violations = validate_query_join_contract(
            f"SELECT o.order_id FROM orders_v1 o JOIN customers_v1 c ON {predicate}",
            datasets=[orders, customers],
            plan=plan,
            join_required=True,
        )
        assert "join_predicate_must_be_column_equality" in violations

    using_violations = validate_query_join_contract(
        "SELECT o.order_id FROM orders_v1 o JOIN customers_v1 c USING (customer_id)",
        datasets=[orders, customers],
        plan=plan,
        join_required=True,
    )
    assert "join_using_not_allowed" in using_violations


def test_semantic_model_relationship_supports_nonconventional_keys() -> None:
    events = dataset(
        "events",
        "click_events",
        [["event_id", "bigint"], ["account_ref", "varchar"]],
        unique_key_columns=["event_id"],
    )
    users = dataset(
        "users",
        "user_directory",
        [["external_key", "varchar"], ["segment", "varchar"]],
    )
    rag_context = {
        "sources": [],
        "retrieval": {
            "semanticModels": [{
                "id": "sm_commerce",
                "version": 7,
                "relationships": [{
                    "fromDatasetId": "events",
                    "toDatasetId": "users",
                    "relationshipType": "many_to_one",
                    "joinExpression": "click_events.account_ref = user_directory.external_key",
                }],
            }],
        },
    }
    plan = build_query_join_plan([events, users], rag_context)

    assert len(plan.relationships) == 1
    assert plan.relationships[0].source == "semantic_model:sm_commerce@7"
    assert validate_query_join_contract(
        "SELECT e.event_id, u.segment FROM click_events e JOIN user_directory u ON e.account_ref = u.external_key",
        datasets=[events, users],
        plan=plan,
        join_required=True,
    ) == []


def test_invalid_semantic_relationship_is_ignored_fail_closed() -> None:
    events = dataset("events", "click_events", [["event_id", "bigint"], ["user_id", "bigint"]])
    users = dataset("users", "users", [["user_id", "varchar"]])
    rag_context = {
        "retrieval": {
            "semanticModels": [{
                "id": "sm_invalid",
                "version": 1,
                "relationships": [{
                    "fromDatasetId": "events",
                    "toDatasetId": "users",
                    "joinExpression": "click_events.user_id = users.user_id",
                }],
            }],
        },
    }

    assert build_query_join_plan([events, users], rag_context).relationships == ()


def test_namespaced_foreign_key_can_match_a_verified_generic_id() -> None:
    clicks = dataset("clicks", "click_events", [["event_id", "bigint"], ["user_id", "bigint"]])
    users = dataset("users", "users", [["id", "bigint"], ["name", "varchar"]], unique_key_columns=["id"])
    unrelated = dataset("accounts", "accounts", [["id", "bigint"]], unique_key_columns=["id"])

    plan = build_query_join_plan([clicks, users], None)
    assert len(plan.relationships) == 1
    assert plan.relationships[0].pairs[0].left_column == "user_id"
    assert plan.relationships[0].pairs[0].right_column == "id"
    assert build_query_join_plan([users, unrelated], None).relationships == ()


def test_quoted_korean_and_space_identifiers_keep_the_same_join_contract() -> None:
    orders = dataset(
        "orders-ko",
        "주문 데이터",
        [["주문 ID", "bigint"], ["고객 ID", "bigint"]],
        unique_key_columns=["주문 ID"],
    )
    customers = dataset(
        "customers-ko",
        "고객 마스터",
        [["고객 ID", "bigint"], ["지역 이름", "varchar"]],
        unique_key_columns=["고객 ID"],
    )
    plan = build_query_join_plan([orders, customers], None)
    prompt_context = "\n".join(join_context_lines(plan, [orders, customers]))

    assert '"주문 데이터"."고객 ID" = "고객 마스터"."고객 ID"' in prompt_context
    assert validate_query_join_contract(
        'SELECT c."지역 이름", COUNT(o."주문 ID") AS order_count '
        'FROM "주문 데이터" o JOIN "고객 마스터" c ON o."고객 ID" = c."고객 ID" '
        'GROUP BY c."지역 이름"',
        datasets=[orders, customers],
        plan=plan,
        join_required=True,
    ) == []


def test_composite_key_requires_every_key_pair() -> None:
    facts = dataset(
        "facts",
        "sales_facts",
        [["tenant_id", "bigint"], ["product_id", "bigint"], ["amount", "double"]],
    )
    products = dataset(
        "products",
        "tenant_products",
        [["tenant_id", "bigint"], ["product_id", "bigint"], ["category", "varchar"]],
        unique_key_sets=[["tenant_id", "product_id"]],
    )
    plan = build_query_join_plan([facts, products], None)

    assert validate_query_join_contract(
        "SELECT f.amount, p.category FROM sales_facts f JOIN tenant_products p "
        "ON f.tenant_id = p.tenant_id AND f.product_id = p.product_id",
        datasets=[facts, products],
        plan=plan,
        join_required=True,
    ) == []
    assert "join_relationship_not_allowed" in validate_query_join_contract(
        "SELECT f.amount, p.category FROM sales_facts f JOIN tenant_products p "
        "ON f.product_id = p.product_id",
        datasets=[facts, products],
        plan=plan,
        join_required=True,
    )


def test_join_intent_is_detected_from_language_or_cross_dataset_columns() -> None:
    orders, customers, _products = commerce_datasets()
    assert prompt_requests_join("orders와 customers를 JOIN해서 보여줘", [orders, customers])
    assert prompt_requests_join("order_id와 region을 같이 분석해줘", [orders, customers])
    assert not prompt_requests_join("주문 금액 합계를 보여줘", [orders, customers])
    assert not prompt_requests_join("orders와 customers의 건수를 각각 보여줘", [orders, customers])


def test_service_retries_wrong_join_once_using_allowed_relationship_prompt() -> None:
    orders, customers, products = commerce_datasets()
    repository = type("Repository", (), {"db": object()})()
    service = QueryAiService(repository)
    request = QueryAiSuggestionRequest(
        base_dataset_id=orders.id,
        prompt="orders와 customers를 JOIN해서 지역별 주문을 보여줘",
        selected_dataset_ids=[orders.id, customers.id, products.id],
    )
    bad = {
        "title": "bad",
        "body": "bad",
        "sql": "SELECT c.region, COUNT(o.order_id) AS order_count FROM orders_v1 o "
        "JOIN customers_v1 c ON o.order_id = c.customer_id GROUP BY c.region",
        "notices": [],
        "model": "test",
        "provider": "fixture",
        "usedEvidenceIds": [],
    }
    good = {
        "title": "good",
        "body": "good",
        "sql": "SELECT c.region, COUNT(o.order_id) AS order_count FROM orders_v1 o "
        "JOIN customers_v1 c ON o.customer_id = c.customer_id GROUP BY c.region",
        "notices": [],
        "model": "test",
        "provider": "fixture",
        "usedEvidenceIds": [],
    }
    datasets = {
        orders.id: orders,
        customers.id: customers,
        products.id: products,
    }
    with (
        patch.object(service, "get_catalog_dataset", side_effect=lambda dataset_id: datasets[dataset_id]),
        patch("app.services.query_ai_service.require_governed_access"),
        patch("app.services.query_ai_service.require_permission"),
        patch("app.services.query_ai_service.build_semantic_rag_context", return_value={"sources": [], "retrieval": None}),
        patch("app.services.query_ai_service.issue_ai_context_token", side_effect=["one", "two"]) as issue_context,
        patch("app.services.query_ai_service.persist_verified_generation_evidence"),
        patch("app.services.query_ai_service.AiGatewayClient.generate_query_sql", side_effect=[bad, good]) as generate,
    ):
        response = service.create_suggestion(request, ActorContext(name="admin", role="admin"))

    assert generate.call_count == 2
    assert generate.call_args.kwargs["selected_dataset_ids"] == [
        "orders",
        "customers",
        "products",
    ]
    assert issue_context.call_args.kwargs["allowed_dataset_ids"] == [
        "orders",
        "customers",
        "products",
    ]
    assert issue_context.call_args.kwargs["dataset_permissions"] == {
        "orders": ["query"],
        "customers": ["query"],
        "products": ["query"],
    }
    assert "allowedRelationship" in generate.call_args.kwargs["prompt"]
    assert "join_relationship_not_allowed" in generate.call_args.kwargs["prompt"]
    assert "o.order_id = c.customer_id" in generate.call_args.kwargs["prompt"]
    assert "o.customer_id = c.customer_id" in response.sql
    assert response.join_evidence == [{
        "source": "catalog_unique_key",
        "relationshipType": "many_to_one",
        "leftDatasetId": "orders",
        "leftDatasetName": "orders_v1",
        "rightDatasetId": "customers",
        "rightDatasetName": "customers_v1",
        "columnPairs": [{"leftColumn": "customer_id", "rightColumn": "customer_id"}],
    }]


def test_service_does_not_call_provider_when_join_relationship_is_missing() -> None:
    events = dataset("events", "click_events", [["event_id", "bigint"], ["account_ref", "varchar"]])
    users = dataset("users", "users", [["external_key", "varchar"]])
    repository = type("Repository", (), {"db": object()})()
    service = QueryAiService(repository)
    request = QueryAiSuggestionRequest(
        base_dataset_id=events.id,
        prompt="events와 users를 조인해줘",
        selected_dataset_ids=[events.id, users.id],
    )
    datasets = {events.id: events, users.id: users}
    with (
        patch.object(service, "get_catalog_dataset", side_effect=lambda dataset_id: datasets[dataset_id]),
        patch("app.services.query_ai_service.require_governed_access"),
        patch("app.services.query_ai_service.require_permission"),
        patch("app.services.query_ai_service.build_semantic_rag_context", return_value={"sources": [], "retrieval": None}),
        patch("app.services.query_ai_service.AiGatewayClient.generate_query_sql") as generate,
    ):
        with pytest.raises(ApiError) as raised:
            service.create_suggestion(request, ActorContext(name="admin", role="admin"))

    assert raised.value.details["violations"] == ["join_relationship_missing"]
    generate.assert_not_called()


def test_multi_dataset_context_is_never_silently_truncated() -> None:
    dataset_ids = ["clicks", "users", "products"]

    with pytest.raises(ApiError) as raised:
        _validate_generation_prompt_size("x" * 32_001, dataset_ids)

    assert raised.value.details == {
        "violations": ["query_ai_context_too_large"],
        "datasetIds": dataset_ids,
        "promptCharacters": 32_001,
        "promptCharacterLimit": 32_000,
    }
