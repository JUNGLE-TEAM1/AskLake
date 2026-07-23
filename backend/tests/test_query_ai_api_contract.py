from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.api.sql import get_query_ai_service
from app.core.auth_context import ActorContext, get_actor_context
from app.main import create_app
from app.schemas.catalog import CatalogDatasetResponse
from app.services.query_ai_service import QueryAiService


def catalog_dataset() -> CatalogDatasetResponse:
    return CatalogDatasetResponse.model_validate({
        "description": "Amazon order facts",
        "freshness": "latest",
        "id": "orders",
        "layer": "GOLD",
        "lastUpdated": "2026-07-17T00:00:00Z",
        "name": "amazon_orders",
        "nextRefresh": "manual",
        "owner": "data-team",
        "quality": "validated",
        "rag": True,
        "rows": "10",
        "sampleRows": [["Seoul", "120"]],
        "schema": [["region", "string"], ["revenue", "decimal"]],
        "size": "1 KB",
        "source": "Amazon",
        "status": "available",
        "tags": ["orders"],
    })


def test_sql_ai_api_returns_editor_sql_and_only_action_used_evidence() -> None:
    app = create_app()
    service = QueryAiService(SimpleNamespace(db=SimpleNamespace()))
    app.dependency_overrides[get_actor_context] = lambda: ActorContext(name="sql-editor", role="admin")
    app.dependency_overrides[get_query_ai_service] = lambda: service
    rag_context = {
        "sources": [
            {"documentId": "doc-used", "datasetId": "orders", "title": "Revenue definition"},
            {"documentId": "doc-unused", "datasetId": "orders", "title": "Unrelated note"},
        ],
        "retrieval": {
            "datasetIds": ["orders"],
            "provenance": "semantic_layer_rag",
            "resultCount": 2,
            "status": "ready",
        },
    }

    try:
        with (
            patch.object(service, "get_catalog_dataset", return_value=catalog_dataset()),
            patch("app.services.query_ai_service.require_governed_access"),
            patch("app.services.query_ai_service.require_permission"),
            patch("app.services.query_ai_service.build_semantic_rag_context", return_value=rag_context),
            patch("app.services.query_ai_service.issue_ai_context_token", return_value="contract-token"),
            patch("app.services.query_ai_service.persist_verified_generation_evidence"),
            patch(
                "app.services.query_ai_service.AiGatewayClient.generate_query_sql",
                return_value={
                    "body": "Region revenue query",
                    "model": "contract-stub",
                    "notices": [],
                    "provider": "contract-stub",
                    "requestId": "query-contract-request",
                    "sql": "SELECT region, sum(revenue) FROM amazon_orders GROUP BY region LIMIT 100",
                    "title": "Revenue by region",
                    "usedEvidenceIds": ["doc-used"],
                },
            ),
        ):
            response = TestClient(app).post(
                "/api/query/ai-suggestions",
                json={
                    "baseDatasetId": "orders",
                    "currentQuery": "",
                    "mode": "draft_sql",
                    "prompt": "지역별 매출 SQL을 작성해줘",
                    "selectedDatasetIds": ["orders"],
                },
            )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["sql"].startswith("SELECT region")
    assert payload["usedEvidenceIds"] == ["doc-used"]
    assert [source["documentId"] for source in payload["sources"]] == ["doc-used"]
    assert payload["retrieval"]["evidenceStatus"] == "used"
    assert payload["joinEvidence"] == []


def test_sql_ai_api_rejects_provider_sql_outside_selected_dataset_scope() -> None:
    app = create_app()
    service = QueryAiService(SimpleNamespace(db=SimpleNamespace()))
    app.dependency_overrides[get_actor_context] = lambda: ActorContext(name="sql-editor", role="admin")
    app.dependency_overrides[get_query_ai_service] = lambda: service

    try:
        with (
            patch.object(service, "get_catalog_dataset", return_value=catalog_dataset()),
            patch("app.services.query_ai_service.require_governed_access"),
            patch("app.services.query_ai_service.require_permission"),
            patch("app.services.query_ai_service.build_semantic_rag_context", return_value=None),
            patch("app.services.query_ai_service.issue_ai_context_token", return_value="contract-token"),
            patch(
                "app.services.query_ai_service.AiGatewayClient.generate_query_sql",
                return_value={
                    "body": "Out of scope",
                    "model": "contract-stub",
                    "notices": [],
                    "provider": "contract-stub",
                    "requestId": "query-contract-rejected",
                    "sql": "SELECT * FROM private_orders",
                    "title": "Unsafe",
                    "usedEvidenceIds": [],
                },
            ),
        ):
            response = TestClient(app).post(
                "/api/query/ai-suggestions",
                json={
                    "baseDatasetId": "orders",
                    "mode": "draft_sql",
                    "prompt": "모든 주문을 보여줘",
                    "selectedDatasetIds": ["orders"],
                },
            )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 422
    assert response.json()["error"]["details"] == {"tables": ["private_orders"]}
