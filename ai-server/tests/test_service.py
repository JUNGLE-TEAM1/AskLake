import json

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.config import Settings
from app.llm_client import (
    OpenAICompatibleClient,
    ProviderResponseError,
    ProviderTimeoutError,
    build_chat_completion_request,
    parse_chat_completion,
    validate_used_evidence_scope,
)
from app.main import ContextReplayGuard, create_app
from app.mcp_client import McpContextError, _decode_batch_tool_result
from app.schemas import (
    DashboardAssistantOutput,
    DatasetClassificationOutput,
    DocumentSegmentationOutput,
    EtlTransformOutput,
    GenerateRequest,
    QuerySqlOutput,
    RagQueryPlanOutput,
    RagRelevanceOutput,
    ReviewRowOutput,
    ReviewSchemaOutput,
)


AUTH = {"Authorization": "Bearer test-token"}


def test_internal_generation_prompt_has_room_for_multi_dataset_contracts() -> None:
    request = GenerateRequest.model_validate({"prompt": "x" * 32_000})
    assert len(request.prompt) == 32_000

    with pytest.raises(ValidationError):
        GenerateRequest.model_validate({"prompt": "x" * 32_001})


def test_default_context_budget_accepts_dashboard_and_mcp_contracts() -> None:
    """Keep the default above the combined dashboard + MCP context footprint."""

    client = TestClient(create_app(make_settings()))

    response = client.post(
        "/v1/generate",
        headers=AUTH,
        json={"prompt": "Create a chart", "context": {"dashboard": "x" * (48 * 1024)}},
    )

    assert response.status_code == 200


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
    assert {"query_sql", "etl_transform", "dashboard_assistant", "review_schema", "review_row", "rag_query_plan", "rag_relevance", "embeddings"}.issubset(health["capabilities"])
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
    assert payload["output"]["usedEvidenceIds"] == []
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
        ("rag_query_plan", {"datasets": [{"datasetId": "reviews"}]}, "plans"),
        ("rag_relevance", {"candidates": [{"documentId": "doc-1"}]}, "judgments"),
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
        RagQueryPlanOutput,
        RagRelevanceOutput,
    ):
        assert_strict_objects(output_model.model_json_schema())


def test_generation_evidence_ids_must_match_supplied_rag_sources() -> None:
    request = GenerateRequest.model_validate({
        "prompt": "count rows",
        "context": {
            "ragContext": {
                "sources": [{"documentId": "doc-allowed", "body": "relevant fact"}],
            },
        },
    })
    allowed = QuerySqlOutput.model_validate({
        "query_sql": "SELECT count(*) FROM reviews",
        "explanation": "uses the relevant fact",
        "warnings": [],
        "usedEvidenceIds": ["doc-allowed"],
    })
    validate_used_evidence_scope(request, allowed)

    invented = allowed.model_copy(update={"used_evidence_ids": ["doc-invented"]})
    with pytest.raises(ProviderResponseError, match="outside"):
        validate_used_evidence_scope(request, invented)


def test_dashboard_generation_evidence_scope_remains_strict_after_normalization() -> None:
    request = GenerateRequest.model_validate({
        "mode": "dashboard_assistant",
        "prompt": "아무거나 만들어줘",
        "context": {
            "ragContext": {
                "sources": [{"documentId": "doc-allowed", "body": "relevant fact"}],
            },
        },
    })
    output = DashboardAssistantOutput.model_validate({
        "message": "차트를 만들었습니다.",
        "actions": [{
            "type": "report",
            "widgetId": None,
            "markdown": "매출 요약",
            "widget": None,
            "patch": None,
            "usedEvidenceIds": ["dataset-invented", "doc-allowed"],
        }],
        "warnings": [],
        "usedEvidenceIds": ["dataset-invented", "doc-allowed"],
    })

    with pytest.raises(ProviderResponseError, match="outside"):
        validate_used_evidence_scope(request, output)


def test_provider_schema_constrains_evidence_ids_to_request_sources() -> None:
    settings = make_settings()
    request = GenerateRequest.model_validate({
        "mode": "dashboard_assistant",
        "prompt": "차트를 만들어줘",
        "context": {
            "ragContext": {
                "sources": [
                    {"documentId": "doc-a", "body": "first"},
                    {"documentId": "doc-b", "body": "second"},
                ],
            },
        },
    })

    schema = build_chat_completion_request(settings, request)["response_format"]["json_schema"]["schema"]
    evidence_schemas: list[dict[str, object]] = []

    def collect_evidence_schemas(value: object) -> None:
        if isinstance(value, dict):
            properties = value.get("properties")
            if isinstance(properties, dict) and isinstance(properties.get("usedEvidenceIds"), dict):
                evidence_schemas.append(properties["usedEvidenceIds"])
            for child in value.values():
                collect_evidence_schemas(child)
        elif isinstance(value, list):
            for child in value:
                collect_evidence_schemas(child)

    collect_evidence_schemas(schema)

    assert len(evidence_schemas) == 2
    assert all(item["items"]["enum"] == ["doc-a", "doc-b"] for item in evidence_schemas)


def test_provider_schema_requires_empty_evidence_without_rag_sources() -> None:
    request = GenerateRequest.model_validate({"prompt": "count rows"})

    schema = build_chat_completion_request(make_settings(), request)["response_format"]["json_schema"]["schema"]
    evidence_schema = schema["properties"]["usedEvidenceIds"]

    assert evidence_schema["maxItems"] == 0
    assert "enum" not in evidence_schema["items"]


def test_query_provider_output_discards_only_unknown_evidence() -> None:
    output = parse_chat_completion(
        {
            "choices": [{
                "message": {
                    "content": json.dumps({
                        "query_sql": "SELECT count(*) FROM reviews",
                        "explanation": "uses supplied evidence",
                        "warnings": [],
                        "usedEvidenceIds": ["dataset-invented", "doc-allowed"],
                    }),
                },
            }],
        },
        "query_sql",
        allowed_evidence_ids=["doc-allowed"],
    )

    assert isinstance(output, QuerySqlOutput)
    assert output.query_sql == "SELECT count(*) FROM reviews"
    assert output.used_evidence_ids == ["doc-allowed"]
    assert output.warnings == ["Provider가 제공한 미확인 evidence ID를 제거했습니다."]


def test_dashboard_provider_output_repairs_evidence_union_without_dropping_action() -> None:
    output = parse_chat_completion(
        {
            "choices": [{
                "message": {
                    "content": json.dumps({
                        "message": "완료",
                        "actions": [{
                            "type": "report",
                            "widgetId": None,
                            "markdown": "매출 요약",
                            "widget": None,
                            "patch": None,
                            "usedEvidenceIds": ["dataset-invented", "doc-allowed"],
                        }],
                        "warnings": [],
                        "usedEvidenceIds": ["dataset-invented"],
                    }),
                },
            }],
        },
        "dashboard_assistant",
        allowed_evidence_ids=["doc-allowed"],
    )

    assert isinstance(output, DashboardAssistantOutput)
    assert len(output.actions) == 1
    assert output.actions[0].used_evidence_ids == ["doc-allowed"]
    assert output.used_evidence_ids == ["doc-allowed"]
    assert output.warnings == ["Provider가 제공한 미확인 evidence ID를 제거했습니다."]


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
                            "content": '{"query_sql":"SELECT 2;","explanation":"draft","warnings":[],"usedEvidenceIds":[]}'
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


def test_provider_routes_modes_to_configured_models_and_reports_actual_model() -> None:
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={
            "choices": [{"message": {"content": '{"query_sql":"SELECT 1;","explanation":"ok","warnings":[],"usedEvidenceIds":[]}'}}],
            "usage": {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120},
        })

    settings = make_settings(
        provider="openai_compatible",
        provider_api_key="provider-secret",
        provider_model="default-model",
        provider_model_query_sql="sql-model",
        provider_input_cost_per_million_tokens=1.0,
        provider_output_cost_per_million_tokens=2.0,
    )
    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = TestClient(create_app(settings, llm_client=OpenAICompatibleClient(settings, http_client=http_client)))

    response = client.post("/v1/generate", headers=AUTH, json={"mode": "query_sql", "prompt": "count rows"})

    assert response.status_code == 200
    assert captured["body"]["model"] == "sql-model"
    assert response.json()["model"] == "sql-model"
    assert response.json()["usage"] == {
        "inputTokens": 100,
        "outputTokens": 20,
        "totalTokens": 120,
        "estimatedCostUsd": 0.00014,
    }

    import asyncio
    asyncio.run(http_client.aclose())


def test_provider_retries_transient_failure_then_succeeds() -> None:
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            return httpx.Response(429, json={"error": {"message": "rate limited"}})
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"query_sql":"SELECT 2;","explanation":"ok","warnings":[],"usedEvidenceIds":[]}'}}]})

    settings = make_settings(
        provider="openai_compatible",
        provider_api_key="provider-secret",
        provider_max_attempts=2,
        provider_retry_base_seconds=0,
    )
    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = TestClient(create_app(settings, llm_client=OpenAICompatibleClient(settings, http_client=http_client)))

    response = client.post("/v1/generate", headers=AUTH, json={"prompt": "count rows"})

    assert response.status_code == 200
    assert calls == 2

    import asyncio
    asyncio.run(http_client.aclose())


def test_provider_fails_over_and_reports_fallback_provenance() -> None:
    urls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        urls.append(str(request.url))
        if request.url.host == "primary.example.test":
            return httpx.Response(503, json={"error": {"message": "unavailable"}})
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"query_sql":"SELECT 3;","explanation":"ok","warnings":[],"usedEvidenceIds":[]}'}}]})

    settings = make_settings(
        provider="openai_compatible",
        provider_base_url="https://primary.example.test/v1",
        provider_api_key="primary-secret",
        provider_fallback_base_url="https://fallback.example.test/v1",
        provider_fallback_api_key="fallback-secret",
        provider_fallback_model="fallback-model",
        provider_max_attempts=1,
    )
    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = TestClient(create_app(settings, llm_client=OpenAICompatibleClient(settings, http_client=http_client)))

    response = client.post("/v1/generate", headers=AUTH, json={"prompt": "count rows"})

    assert response.status_code == 200
    assert urls == [
        "https://primary.example.test/v1/chat/completions",
        "https://fallback.example.test/v1/chat/completions",
    ]
    assert response.json()["provider"] == "openai_compatible_fallback"
    assert response.json()["model"] == "fallback-model"

    import asyncio
    asyncio.run(http_client.aclose())


def test_unconfigured_real_provider_fails_closed() -> None:
    settings = make_settings(provider="openai_compatible", provider_api_key=None)
    client = TestClient(create_app(settings))

    response = client.post("/v1/generate", headers=AUTH, json={"prompt": "count rows"})

    assert response.status_code == 503
    assert "API_KEY" not in response.text


def test_health_actively_probes_provider_models_endpoint() -> None:
    requests: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(str(request.url))
        return httpx.Response(200, json={"data": []})

    settings = make_settings(
        provider="openai_compatible",
        provider_base_url="https://llm.example.test/v1",
        provider_api_key="provider-secret",
    )
    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = TestClient(create_app(settings, llm_client=OpenAICompatibleClient(settings, http_client=http_client)))

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json()["checks"]["provider"] == "ready"
    assert requests == ["https://llm.example.test/v1/models"]

    import asyncio
    asyncio.run(http_client.aclose())


def test_embeddings_retry_transient_provider_failure() -> None:
    calls = 0
    bodies: list[dict[str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        assert request.url.path.endswith("/embeddings")
        bodies.append(json.loads(request.content))
        calls += 1
        if calls == 1:
            return httpx.Response(503, json={"error": {"message": "unavailable"}})
        return httpx.Response(200, json={
            "model": "embedding-model",
            "data": [
                {"index": 1, "embedding": [0.3, 0.4]},
                {"index": 0, "embedding": [0.1, 0.2]},
            ],
        })

    settings = make_settings(
        provider="openai_compatible",
        provider_api_key="provider-secret",
        provider_max_attempts=2,
        provider_retry_base_seconds=0,
        embedding_dimensions=2,
    )
    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = TestClient(create_app(settings, llm_client=OpenAICompatibleClient(settings, http_client=http_client)))

    response = client.post(
        "/v1/embeddings",
        headers=AUTH,
        json={"model": "embedding-model", "input": ["camera", "speaker"]},
    )

    assert response.status_code == 200
    assert calls == 2
    assert bodies == [
        {"model": "embedding-model", "input": ["camera", "speaker"], "dimensions": 2},
        {"model": "embedding-model", "input": ["camera", "speaker"], "dimensions": 2},
    ]
    assert response.json()["data"] == [[0.1, 0.2], [0.3, 0.4]]

    import asyncio
    asyncio.run(http_client.aclose())


@pytest.mark.parametrize(
    "provider_payload",
    [
        {"model": "embedding-model", "data": []},
        {"model": "embedding-model", "data": [{"index": 0, "embedding": [0.1]}]},
        {"model": "embedding-model", "data": [{"index": 1, "embedding": [0.1, 0.2]}]},
        {"model": "wrong-model", "data": [{"index": 0, "embedding": [0.1, 0.2]}]},
    ],
)
def test_embeddings_fail_closed_on_count_dimensions_or_index_mismatch(
    provider_payload: dict[str, object],
) -> None:
    settings = make_settings(
        provider="openai_compatible",
        provider_api_key="provider-secret",
        provider_max_attempts=1,
        embedding_dimensions=2,
    )
    http_client = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _request: httpx.Response(200, json=provider_payload))
    )
    client = TestClient(create_app(settings, llm_client=OpenAICompatibleClient(settings, http_client=http_client)))

    response = client.post(
        "/v1/embeddings",
        headers=AUTH,
        json={"model": "embedding-model", "input": ["camera"]},
    )

    assert response.status_code == 502
    assert "embedding-model" not in response.text

    import asyncio
    asyncio.run(http_client.aclose())


def test_embeddings_reject_nonfinite_and_oversized_provider_responses() -> None:
    responses = iter([
        httpx.Response(
            200,
            content=b'{"model":"embedding-model","data":[{"index":0,"embedding":[NaN,0.2]}]}',
            headers={"content-type": "application/json"},
        ),
        httpx.Response(
            200,
            content=(b'{"model":"embedding-model","data":[]}' + b" " * 70_000),
            headers={"content-type": "application/json"},
        ),
    ])
    settings = make_settings(
        provider="openai_compatible",
        provider_api_key="provider-secret",
        provider_max_attempts=1,
        embedding_dimensions=2,
        embedding_batch_size=1,
        max_embedding_provider_response_bytes=64 * 1024,
    )
    http_client = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _request: next(responses))
    )
    client = TestClient(create_app(settings, llm_client=OpenAICompatibleClient(settings, http_client=http_client)))

    for _ in range(2):
        response = client.post(
            "/v1/embeddings",
            headers=AUTH,
            json={"model": "embedding-model", "input": ["camera"]},
        )
        assert response.status_code == 502

    import asyncio
    asyncio.run(http_client.aclose())


def test_embeddings_reject_blank_input_before_provider_call() -> None:
    client = TestClient(create_app(make_settings()))

    response = client.post(
        "/v1/embeddings",
        headers=AUTH,
        json={"model": "embedding-model", "input": ["   "]},
    )

    assert response.status_code == 422


def test_health_accepts_a_configured_fallback_only_provider() -> None:
    settings = make_settings(
        provider="openai_compatible",
        provider_api_key=None,
        provider_fallback_base_url="https://fallback.example.test/v1",
        provider_fallback_api_key="fallback-secret",
        provider_fallback_model="fallback-model",
        provider_healthcheck_enabled=False,
    )
    client = TestClient(create_app(settings))

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json()["checks"]["provider"] == "ready"


def test_embedding_response_budget_must_cover_declared_batch_contract() -> None:
    with pytest.raises(ValueError, match="too small"):
        make_settings(
            embedding_batch_size=64,
            embedding_dimensions=1536,
            max_embedding_provider_response_bytes=64 * 1024,
        )


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


def test_blank_optional_provider_settings_are_treated_as_unset() -> None:
    settings = Settings(
        provider_fallback_base_url="  ",
        provider_fallback_api_key="",
        provider_fallback_model="",
        provider_model_query_sql="",
        mcp_server_url="",
    )

    assert settings.provider_fallback_base_url is None
    assert settings.provider_fallback_api_key is None
    assert settings.provider_fallback_model is None
    assert settings.provider_model_query_sql is None
    assert settings.mcp_server_url is None


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


def test_context_replay_guard_stays_memory_bounded() -> None:
    import asyncio

    guard = ContextReplayGuard(max_entries=2)
    assert asyncio.run(guard.consume("token-1", "request-1", 300)) is True
    assert asyncio.run(guard.consume("token-2", "request-2", 300)) is True
    assert asyncio.run(guard.consume("token-3", "request-3", 300)) is True
    assert len(guard._seen) == 2
    assert asyncio.run(guard.consume("token-3", "request-3", 300)) is False


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
