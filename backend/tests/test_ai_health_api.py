from unittest.mock import patch
from types import SimpleNamespace

from fastapi import Response, status

from app.api.health import ai_health_check


def test_ai_health_reports_live_gateway_and_feature_capabilities() -> None:
    gateway_health = {
        "ok": True,
        "status": "ok",
        "provider": "openai_compatible",
        "model": "gpt-4.1-mini",
        "mcp": "ready",
        "routing": {"query_sql": "gpt-4.1-mini"},
        "capabilities": [
            "query_sql",
            "dashboard_assistant",
            "etl_transform",
            "classify_dataset",
            "segment_document",
            "rag_query_plan",
            "rag_relevance",
            "embeddings",
            "review_schema",
            "review_row",
        ],
    }
    response = Response()

    with (
        patch("app.api.health.AiGatewayClient") as gateway_client,
        patch("app.api.health.OpenSearchClient") as opensearch_client,
        patch("app.api.health.list_catalog_model_artifacts", return_value=[]),
        patch("app.api.health.settings", SimpleNamespace(opensearch_base_url="https://opensearch:9200")),
    ):
        gateway_client.return_value.health_status.return_value = gateway_health
        opensearch_client.return_value.health.return_value = True

        payload = ai_health_check(response)

    assert response.status_code == status.HTTP_200_OK
    assert payload["ok"] is True
    assert payload["provider"] == "openai_compatible"
    assert payload["model"] == "gpt-4.1-mini"
    assert payload["mcp"] == "ready"
    assert payload["routing"] == {"query_sql": "gpt-4.1-mini"}
    assert {item["id"]: item["status"] for item in payload["capabilities"]} == {
        "sql": "ready",
        "dashboard": "ready",
        "transform": "ready",
        "rag": "ready",
        "review": "ready",
        "ml": "unavailable",
    }
