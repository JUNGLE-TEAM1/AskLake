from unittest.mock import patch

import httpx
import pytest
from fastapi import status

from app.core.config import Settings
from app.core.errors import ApiError
from app.services.ai_evidence import retain_used_rag_evidence, validate_used_evidence_ids
from app.services.ai_gateway_client import AiGatewayClient


def _generation_response(*, provider: str, metadata: dict[str, object] | None = None) -> httpx.Response:
    request = httpx.Request("POST", "http://ai-server:8090/v1/generate")
    payload: dict[str, object] = {
        "request_id": "request-provenance",
        "mode": "query_sql",
        "output": {
            "query_sql": "SELECT count(*) FROM customer_events",
            "explanation": "Counts the selected events.",
            "warnings": [],
            "usedEvidenceIds": [],
        },
        "provider": provider,
        "model": "sql-model",
    }
    if metadata is not None:
        payload["providerMetadata"] = metadata
    return httpx.Response(200, request=request, json=payload)


@pytest.mark.parametrize(
    ("provider", "metadata"),
    [
        ("mock", None),
        ("mock_local", None),
        ("deterministic_mock", None),
    ],
)
def test_gateway_rejects_mock_generation_provenance(
    provider: str,
    metadata: dict[str, object] | None,
) -> None:
    client = AiGatewayClient(Settings(
        ai_gateway_base_url="http://ai-server:8090",
        ai_gateway_service_token="service-secret",
    ))

    with (
        patch("app.services.ai_gateway_client.httpx.post", return_value=_generation_response(provider=provider, metadata=metadata)),
        patch.object(client, "_persist_generation_usage") as persist_usage,
        pytest.raises(ApiError) as raised,
    ):
        client.generate_query_sql(
            "request-provenance",
            "count rows",
            "",
            "dataset-1",
            ["dataset-1"],
            "context-secret",
        )

    assert raised.value.status_code == status.HTTP_502_BAD_GATEWAY
    persist_usage.assert_not_called()


@pytest.mark.parametrize("provider", ["openai_compatible", "openai_compatible_fallback"])
def test_gateway_accepts_real_primary_or_failover_provider(provider: str) -> None:
    client = AiGatewayClient(Settings(
        ai_gateway_base_url="http://ai-server:8090",
        ai_gateway_service_token="service-secret",
    ))

    with (
        patch(
            "app.services.ai_gateway_client.httpx.post",
            return_value=_generation_response(
                provider=provider,
                metadata={"fallbackApplied": provider.endswith("_fallback"), "route": "fallback" if provider.endswith("_fallback") else "primary"},
            ),
        ),
        patch.object(client, "_persist_generation_usage"),
    ):
        result = client.generate_query_sql(
            "request-provenance",
            "count rows",
            "",
            "dataset-1",
            ["dataset-1"],
            "context-secret",
        )

    assert result["provider"] == provider


def test_content_preserving_fallback_source_remains_visible_when_actually_used() -> None:
    rag_context = {
        "sources": [
            {"documentId": "doc-primary", "title": "primary", "fallbackApplied": False},
            {
                "documentId": "doc-fallback",
                "title": "fallback",
                "fallbackApplied": True,
                "fallbackReasons": ["context_expansion_unavailable"],
            },
        ],
        "retrieval": {"status": "degraded", "resultCount": 2},
    }

    assert validate_used_evidence_ids(
        ["doc-primary", "doc-fallback"],
        rag_context,
    ) == ["doc-primary", "doc-fallback"]

    retained = retain_used_rag_evidence(
        rag_context,
        ["doc-primary", "doc-fallback"],
    )

    assert retained is not None
    assert retained["sources"] == rag_context["sources"]
    assert retained["retrieval"]["resultCount"] == 2
    assert retained["retrieval"]["fallbackEvidenceCount"] == 1
    assert retained["retrieval"]["fallbackReasons"] == ["context_expansion_unavailable"]
