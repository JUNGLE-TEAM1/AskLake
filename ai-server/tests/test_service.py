import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.llm_client import (
    OpenAICompatibleClient,
    ProviderResponseError,
    ProviderTimeoutError,
    parse_chat_completion,
)
from app.main import create_app
from app.mcp_client import McpContextError, _decode_batch_tool_result
from app.schemas import (
    DashboardAssistantOutput,
    DatasetClassificationOutput,
    DocumentSegmentationOutput,
    EtlTransformOutput,
    QuerySqlOutput,
    ReviewRowOutput,
    ReviewSchemaOutput,
)


AUTH = {"Authorization": "Bearer test-token"}


def make_settings(**overrides: object) -> Settings:
    values: dict[str, object] = {
        "app_env": "testing",
        "internal_auth_token": "test-token",
        "provider": "mock",
    }
    values.update(overrides)
    return Settings(**values)


def test_health_is_public_and_generate_requires_bearer_auth() -> None:
    client = TestClient(create_app(make_settings()))

    health = client.get("/health").json()
    assert health["status"] == "ok"
    assert health["service"] == "ai-gateway"
    assert health["mcp"] == "disabled"
    assert {"query_sql", "etl_transform", "dashboard_assistant", "review_schema", "review_row", "embeddings"}.issubset(health["capabilities"])
    response = client.post("/v1/generate", json={"prompt": "count rows"})

    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"

    invalid = client.post(
        "/v1/generate",
        headers={"Authorization": "Bearer wrong-token"},
        json={"prompt": "count rows"},
    )
    assert invalid.status_code == 401
    assert "test-token" not in invalid.text


def test_mock_generate_returns_stable_structured_query_sql_contract() -> None:
    client = TestClient(create_app(make_settings()))

    response = client.post(
        "/v1/generate",
        headers=AUTH,
        json={"prompt": "count rows", "context": {"datasets": []}, "tools": []},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["mode"] == "query_sql"
    assert payload["output"]["query_sql"] == "SELECT 1 AS mock_result;"
    assert response.headers["x-request-id"] == payload["request_id"]
    assert float(response.headers["x-ai-mcp-duration-ms"]) == 0.0
    assert "generation" in response.headers["server-timing"]


def test_mock_generate_uses_mcp_camel_case_dataset_name() -> None:
    client = TestClient(create_app(make_settings()))

    response = client.post(
        "/v1/generate",
        headers=AUTH,
        json={
            "prompt": "count rows",
            "context": {"datasets": [{"datasetName": "review_gold"}]},
        },
    )

    assert response.status_code == 200
    assert response.json()["output"]["query_sql"] == "SELECT * FROM review_gold LIMIT 100;"


@pytest.mark.parametrize(
    ("mode", "context", "output_key"),
    [
        ("etl_transform", {"promptType": "sql_transform"}, "sql"),
        ("dashboard_assistant", {}, "actions"),
        ("review_schema", {}, "columns"),
        ("review_row", {"requestedColumns": [{"targetName": "sentiment"}]}, "values"),
    ],
)
def test_mock_gateway_supports_every_unified_generation_mode(
    mode: str,
    context: dict[str, object],
    output_key: str,
) -> None:
    client = TestClient(create_app(make_settings()))

    response = client.post(
        "/v1/generate",
        headers=AUTH,
        json={"mode": mode, "prompt": "test request", "context": context},
    )

    assert response.status_code == 200
    assert response.json()["mode"] == mode
    assert output_key in response.json()["output"]


def test_provider_output_schemas_require_every_declared_object_property() -> None:
    def assert_strict_objects(value: object) -> None:
        if isinstance(value, dict):
            properties = value.get("properties")
            if isinstance(properties, dict):
                assert value.get("additionalProperties") is False
                assert set(value.get("required") or []) == set(properties)
            for child in value.values():
                assert_strict_objects(child)
        elif isinstance(value, list):
            for child in value:
                assert_strict_objects(child)

    for output_model in (
        QuerySqlOutput,
        DatasetClassificationOutput,
        DocumentSegmentationOutput,
        EtlTransformOutput,
        DashboardAssistantOutput,
        ReviewSchemaOutput,
        ReviewRowOutput,
    ):
        assert_strict_objects(output_model.model_json_schema())


def test_request_limits_reject_large_context_and_body() -> None:
    app = create_app(make_settings(max_context_bytes=128, max_request_bytes=1024))
    client = TestClient(app)

    context_response = client.post(
        "/v1/generate",
        headers=AUTH,
        json={"prompt": "count rows", "context": {"data": "x" * 200}},
    )
    body_response = client.post(
        "/v1/generate",
        content=json.dumps({"prompt": "x" * 1_500}),
        headers={**AUTH, "content-type": "application/json"},
    )

    assert context_response.status_code == 422
    assert body_response.status_code == 413


def test_provider_response_is_parsed_and_request_is_openai_compatible() -> None:
    captured: dict[str, object] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["authorization"] = request.headers["authorization"]
        captured["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": '{"query_sql":"SELECT 2;","explanation":"draft","warnings":[]}'
                        }
                    }
                ]
            },
        )

    settings = make_settings(
        provider="openai_compatible",
        provider_base_url="https://llm.example.test/v1",
        provider_api_key="provider-secret",
    )
    transport = httpx.MockTransport(handler)
    http_client = httpx.AsyncClient(transport=transport)
    llm_client = OpenAICompatibleClient(settings, http_client=http_client)
    client = TestClient(create_app(settings, llm_client=llm_client))

    response = client.post("/v1/generate", headers=AUTH, json={"prompt": "count rows"})

    assert response.status_code == 200
    assert response.json()["output"]["query_sql"] == "SELECT 2;"
    assert captured["url"] == "https://llm.example.test/v1/chat/completions"
    assert captured["authorization"] == "Bearer provider-secret"
    assert captured["body"]["response_format"]["json_schema"]["strict"] is True
    assert "provider-secret" not in response.text

    import asyncio

    asyncio.run(http_client.aclose())


def test_unconfigured_real_provider_fails_closed() -> None:
    settings = make_settings(provider="openai_compatible", provider_api_key=None)
    client = TestClient(create_app(settings))

    response = client.post("/v1/generate", headers=AUTH, json={"prompt": "count rows"})

    assert response.status_code == 503
    assert "API_KEY" not in response.text


def test_health_reports_unready_when_internal_auth_is_missing() -> None:
    client = TestClient(create_app(Settings(app_env="testing", provider="mock")))

    response = client.get("/health")

    assert response.status_code == 503
    assert response.json()["status"] == "unavailable"


def test_provider_timeout_maps_to_gateway_timeout() -> None:
    class TimeoutClient:
        provider_name = "test"
        model_name = "test-model"

        async def generate(self, request: object) -> object:
            del request
            raise ProviderTimeoutError("internal timeout detail")

        async def close(self) -> None:
            return None

    client = TestClient(create_app(make_settings(), llm_client=TimeoutClient()))

    response = client.post("/v1/generate", headers=AUTH, json={"prompt": "count rows"})

    assert response.status_code == 504
    assert "internal timeout" not in response.text


def test_production_remote_provider_requires_tls() -> None:
    with pytest.raises(ValueError, match="https"):
        Settings(
            app_env="production",
            internal_auth_token="test-token",
            provider="openai_compatible",
            provider_base_url="http://llm.example.test/v1",
            provider_api_key="provider-secret",
        )


def test_mock_provider_is_rejected_outside_tests() -> None:
    with pytest.raises(ValueError, match="test environments"):
        Settings(app_env="local", internal_auth_token="test-token", provider="mock")


def test_mcp_server_url_rejects_credentials_and_query_parameters() -> None:
    with pytest.raises(ValueError):
        Settings(mcp_server_url="http://user:pass@backend:8080/internal/mcp")
    with pytest.raises(ValueError):
        Settings(mcp_server_url="http://backend:8080/internal/mcp?scope=all")


def test_invalid_provider_output_is_rejected_without_leaking_provider_body() -> None:
    with pytest.raises(ProviderResponseError, match="query_sql contract"):
        parse_chat_completion({"choices": [{"message": {"content": "not json"}}]})


def test_mcp_context_is_consumed_once_per_generation_request() -> None:
    class FakeMcpClient:
        async def get_catalog_context(self, **kwargs: object) -> dict[str, object]:
            assert kwargs["request_id"] == "request-1"
            return {"datasets": [{"dataset_name": "review_gold"}]}

    settings = make_settings(
        mcp_enabled=True,
        mcp_server_url="http://backend:8080/internal/mcp",
        mcp_service_token="mcp-token",
        context_replay_ttl_seconds=300,
    )
    app = create_app(settings)
    app.state.mcp_client = FakeMcpClient()
    client = TestClient(app)
    request = {
        "request_id": "request-1",
        "prompt": "count rows",
        "selected_dataset_ids": ["dataset-1"],
    }
    headers = {**AUTH, "X-AskLake-AI-Context": "signed-context"}

    first = client.post("/v1/generate", headers=headers, json=request)
    second = client.post("/v1/generate", headers=headers, json=request)

    assert first.status_code == 200
    assert second.status_code == 409


def test_mcp_failure_is_returned_without_internal_error_details() -> None:
    class FailingMcpClient:
        async def get_catalog_context(self, **kwargs: object) -> dict[str, object]:
            del kwargs
            raise McpContextError("private MCP failure")

    settings = make_settings(
        mcp_enabled=True,
        mcp_server_url="http://backend:8080/internal/mcp",
        mcp_service_token="mcp-token",
    )
    app = create_app(settings)
    app.state.mcp_client = FailingMcpClient()
    client = TestClient(app)

    response = client.post(
        "/v1/generate",
        headers={**AUTH, "X-AskLake-AI-Context": "signed-context"},
        json={"request_id": "request-1", "prompt": "count", "selected_dataset_ids": ["d1"]},
    )

    assert response.status_code == 502
    assert "private MCP failure" not in response.text


def test_mcp_context_is_bounded_before_provider_invocation() -> None:
    class LargeMcpClient:
        async def get_catalog_context(self, **kwargs: object) -> dict[str, object]:
            del kwargs
            return {"datasets": [{"dataset_name": "review_gold", "description": "x" * 1_000}]}

    settings = make_settings(
        mcp_enabled=True,
        mcp_server_url="http://backend:8080/internal/mcp",
        mcp_service_token="mcp-token",
        max_context_bytes=128,
    )
    app = create_app(settings)
    app.state.mcp_client = LargeMcpClient()
    client = TestClient(app)

    response = client.post(
        "/v1/generate",
        headers={**AUTH, "X-AskLake-AI-Context": "signed-context"},
        json={"request_id": "request-1", "prompt": "count", "selected_dataset_ids": ["d1"]},
    )

    assert response.status_code == 422


def test_mcp_batch_result_unwraps_fastmcp_result_envelope_and_preserves_order() -> None:
    result = type(
        "ToolResult",
        (),
        {
            "structuredContent": {
                "result": [
                    {"datasetId": "dataset-1", "datasetName": "events"},
                    {"datasetId": "dataset-2", "datasetName": "users"},
                ]
            }
        },
    )()

    decoded = _decode_batch_tool_result(result, ["dataset-1", "dataset-2"])

    assert [item["datasetId"] for item in decoded] == ["dataset-1", "dataset-2"]


def test_mcp_batch_result_rejects_missing_or_reordered_dataset() -> None:
    result = type(
        "ToolResult",
        (),
        {
            "structuredContent": {
                "result": [{"datasetId": "dataset-2"}]
            }
        },
    )()

    with pytest.raises(McpContextError, match="incomplete"):
        _decode_batch_tool_result(result, ["dataset-1", "dataset-2"])
