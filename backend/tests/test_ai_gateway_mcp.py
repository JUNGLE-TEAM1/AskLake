import asyncio
import unittest
from unittest.mock import Mock, call, patch

import httpx
from fastapi import status
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext
from app.core.config import Settings
from app.core.errors import ApiError
from app.mcp.catalog import get_dataset_context, get_datasets_context
from app.mcp.context import consume_ai_context_token, issue_ai_context_token, verify_ai_context_token
from app.models.identity import AiContextConsumptionModel
from app.mcp.server import create_mcp_components
from app.schemas.catalog import CatalogDatasetResponse
from app.services.ai_gateway_client import AiGatewayClient


SECRET = "test-ai-context-secret"


def context_token(
    *,
    dataset_ids: list[str] | None = None,
    permissions: dict[str, list[str]] | None = None,
    now: int | None = None,
    ttl_seconds: int = 300,
) -> str:
    dataset_ids = dataset_ids or ["dataset-1"]
    return issue_ai_context_token(
        request_id="request-1",
        actor=ActorContext(name="analyst", role="viewer"),
        allowed_dataset_ids=dataset_ids,
        dataset_permissions=permissions or {dataset_id: ["query"] for dataset_id in dataset_ids},
        secret=SECRET,
        now=now,
        ttl_seconds=ttl_seconds,
    )


def dataset_payload(sample_count: int = 25, dataset_id: str = "dataset-1") -> dict[str, object]:
    return {
        "description": "Reviewed customer events",
        "freshness": "latest",
        "id": dataset_id,
        "layer": "GOLD",
        "lastUpdated": "2026-07-14T00:00:00Z",
        "name": "customer_events",
        "nextRefresh": "manual",
        "owner": "data-team",
        "quality": "validated",
        "rag": False,
        "rows": "25",
        "sampleRows": [[f"row-{index}", "ok"] for index in range(sample_count)],
        "schema": [["event_id", "string"], ["status", "string"]],
        "size": "1 KB",
        "source": "warehouse",
        "status": "available",
        "tags": ["events"],
    }


class FakeSession:
    def __enter__(self) -> "FakeSession":
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def add(self, _value: object) -> None:
        return None

    def commit(self) -> None:
        return None

    def execute(self, *_args: object, **_kwargs: object) -> None:
        return None

    def rollback(self) -> None:
        return None


class AiContextSecurityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.dataset = CatalogDatasetResponse.model_validate(dataset_payload())
        self.repository = Mock()
        self.repository.get_dataset_payload.return_value = dataset_payload()

    def test_invalid_context_token_is_rejected_before_catalog_load(self) -> None:
        with patch("app.mcp.catalog.settings.ai_context_signing_secret", SECRET), patch(
            "app.mcp.catalog.SessionLocal"
        ) as session_local:
            with self.assertRaises(ApiError) as raised:
                get_dataset_context("dataset-1", context_token="invalid")

        self.assertEqual(raised.exception.status_code, status.HTTP_401_UNAUTHORIZED)
        session_local.assert_not_called()

    def test_non_ascii_context_token_is_rejected_as_unauthorized(self) -> None:
        with self.assertRaises(ApiError) as raised:
            verify_ai_context_token("é")

        self.assertEqual(raised.exception.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_expired_context_token_is_rejected(self) -> None:
        token = context_token(now=1_000, ttl_seconds=30)

        with self.assertRaises(ApiError) as raised:
            verify_ai_context_token(token, secret=SECRET, now=1_031)

        self.assertEqual(raised.exception.status_code, status.HTTP_401_UNAUTHORIZED)
        self.assertIn("expired", raised.exception.message)

    def test_context_token_ttl_cannot_exceed_configured_maximum(self) -> None:
        with self.assertRaises(ApiError) as raised:
            context_token(ttl_seconds=301)

        self.assertEqual(raised.exception.status_code, status.HTTP_422_UNPROCESSABLE_ENTITY)

    def test_context_token_is_consumed_once_across_database_sessions(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:")
        AiContextConsumptionModel.__table__.create(bind=engine)
        token = context_token()
        claims = verify_ai_context_token(token, secret=SECRET)

        with Session(engine) as first_session:
            consume_ai_context_token(first_session, token, claims)
        with Session(engine) as second_session, self.assertRaises(ApiError) as raised:
            consume_ai_context_token(second_session, token, claims)

        self.assertEqual(raised.exception.status_code, status.HTTP_409_CONFLICT)

    def test_dataset_outside_signed_scope_is_denied(self) -> None:
        token = context_token(dataset_ids=["other-dataset"])

        with patch("app.mcp.catalog.settings.ai_context_signing_secret", SECRET), patch(
            "app.mcp.catalog.SessionLocal"
        ) as session_local:
            with self.assertRaises(ApiError) as raised:
                get_dataset_context("dataset-1", context_token=token)

        self.assertEqual(raised.exception.status_code, status.HTTP_403_FORBIDDEN)
        session_local.assert_not_called()

    def test_request_id_must_match_signed_context(self) -> None:
        token = context_token()
        with patch("app.mcp.catalog.SessionLocal") as session_local:
            with self.assertRaises(ApiError) as raised:
                get_dataset_context("dataset-1", context_token=token, request_id="other-request")

        self.assertEqual(raised.exception.status_code, status.HTTP_401_UNAUTHORIZED)
        session_local.assert_not_called()

    def test_catalog_context_reloads_data_and_caps_sample_rows(self) -> None:
        token = context_token()
        with (
            patch("app.mcp.catalog.settings.ai_context_signing_secret", SECRET),
            patch("app.mcp.catalog.SessionLocal", return_value=FakeSession()),
            patch("app.mcp.catalog.CatalogRepository", return_value=self.repository),
            patch(
                "app.mcp.catalog.dataset_with_persisted_permission_grants",
                return_value=self.dataset,
            ),
            patch("app.mcp.catalog.require_governed_access"),
            patch("app.mcp.catalog.require_permission"),
        ):
            result = get_dataset_context(
                "dataset-1",
                context_token=token,
                sample_row_limit=10_000,
            )

        self.repository.get_dataset_payload.assert_called_once_with("dataset-1")
        self.assertEqual(len(result.sample_rows), 20)
        self.assertEqual(result.schema_[0].name, "event_id")
        self.assertNotIn("storage", result.model_dump_json().lower())
        self.assertNotIn("credential", result.model_dump_json().lower())

    def test_catalog_context_bounds_wide_schema_and_sample_values_transparently(self) -> None:
        token = context_token()
        wide_schema = [(f"column_{index}", "string") for index in range(300)]
        wide_dataset = self.dataset.model_copy(update={
            "schema_": wide_schema,
            "sample_rows": [["x" * 1_000 for _ in range(300)]],
        })
        with (
            patch("app.mcp.catalog.settings.ai_context_signing_secret", SECRET),
            patch("app.mcp.catalog.SessionLocal", return_value=FakeSession()),
            patch("app.mcp.catalog.CatalogRepository", return_value=self.repository),
            patch("app.mcp.catalog.dataset_with_persisted_permission_grants", return_value=wide_dataset),
            patch("app.mcp.catalog.require_governed_access"),
            patch("app.mcp.catalog.require_permission"),
        ):
            result = get_dataset_context("dataset-1", context_token=token)

        self.assertEqual(len(result.schema_), 256)
        self.assertTrue(result.schema_truncated)
        self.assertEqual(len(result.sample_column_names), 64)
        self.assertEqual(len(result.sample_rows[0]), 64)
        self.assertEqual(len(result.sample_rows[0][0]), 256)
        self.assertTrue(result.sample_rows_truncated)

    def test_catalog_context_redacts_credential_like_sample_columns(self) -> None:
        token = context_token()
        sensitive_dataset = self.dataset.model_copy(update={
            "schema_": [("api_key", "string"), ("status", "string")],
            "sample_rows": [["should-not-leak", "ok"]],
        })
        with (
            patch("app.mcp.catalog.settings.ai_context_signing_secret", SECRET),
            patch("app.mcp.catalog.SessionLocal", return_value=FakeSession()),
            patch("app.mcp.catalog.CatalogRepository", return_value=self.repository),
            patch(
                "app.mcp.catalog.dataset_with_persisted_permission_grants",
                return_value=sensitive_dataset,
            ),
            patch("app.mcp.catalog.require_governed_access"),
            patch("app.mcp.catalog.require_permission"),
        ):
            result = get_dataset_context("dataset-1", context_token=token)

        self.assertEqual(result.sample_rows[0], ["[REDACTED]", "ok"])

    def test_catalog_context_redacts_common_pii_columns_and_values(self) -> None:
        token = context_token()
        sensitive_dataset = self.dataset.model_copy(update={
            "schema_": [("customer_id", "string"), ("comment", "string")],
            "sample_rows": [["customer-42", "contact me at person@example.com or 010-1234-5678"]],
        })
        with (
            patch("app.mcp.catalog.settings.ai_context_signing_secret", SECRET),
            patch("app.mcp.catalog.SessionLocal", return_value=FakeSession()),
            patch("app.mcp.catalog.CatalogRepository", return_value=self.repository),
            patch(
                "app.mcp.catalog.dataset_with_persisted_permission_grants",
                return_value=sensitive_dataset,
            ),
            patch("app.mcp.catalog.require_governed_access"),
            patch("app.mcp.catalog.require_permission"),
        ):
            result = get_dataset_context("dataset-1", context_token=token)

        self.assertEqual(
            result.sample_rows[0],
            ["[REDACTED]", "contact me at [REDACTED_EMAIL] or [REDACTED_PHONE]"],
        )

    def test_batch_catalog_context_returns_multiple_authorized_datasets_in_one_session(self) -> None:
        token = context_token(dataset_ids=["dataset-1", "dataset-2"])
        first_dataset = self.dataset
        second_dataset = CatalogDatasetResponse.model_validate(dataset_payload(dataset_id="dataset-2"))
        self.repository.get_dataset_payload.side_effect = [
            dataset_payload(dataset_id="dataset-1"),
            dataset_payload(dataset_id="dataset-2"),
        ]
        with (
            patch("app.mcp.catalog.settings.ai_context_signing_secret", SECRET),
            patch("app.mcp.catalog.SessionLocal", return_value=FakeSession()) as session_local,
            patch("app.mcp.catalog.CatalogRepository", return_value=self.repository),
            patch(
                "app.mcp.catalog.dataset_with_persisted_permission_grants",
                side_effect=[first_dataset, second_dataset],
            ),
            patch("app.mcp.catalog.require_governed_access"),
            patch("app.mcp.catalog.require_permission"),
        ):
            result = get_datasets_context(
                ["dataset-1", "dataset-2"],
                context_token=token,
            )

        session_local.assert_called_once_with()
        self.assertEqual([context.dataset_id for context in result], ["dataset-1", "dataset-2"])
        self.assertEqual(
            self.repository.get_dataset_payload.call_args_list,
            [call("dataset-1"), call("dataset-2")],
        )

    def test_batch_catalog_context_rejects_dataset_outside_signed_scope_before_db_load(self) -> None:
        token = context_token(dataset_ids=["dataset-1"])
        with (
            patch("app.mcp.catalog.settings.ai_context_signing_secret", SECRET),
            patch("app.mcp.catalog.SessionLocal") as session_local,
        ):
            with self.assertRaises(ApiError) as raised:
                get_datasets_context(
                    ["dataset-1", "dataset-2"],
                    context_token=token,
                )

        self.assertEqual(raised.exception.status_code, status.HTTP_403_FORBIDDEN)
        session_local.assert_not_called()

    def test_batch_catalog_context_caps_samples_for_every_dataset(self) -> None:
        token = context_token(dataset_ids=["dataset-1", "dataset-2"])
        first_dataset = CatalogDatasetResponse.model_validate(dataset_payload(dataset_id="dataset-1"))
        second_dataset = CatalogDatasetResponse.model_validate(dataset_payload(dataset_id="dataset-2"))
        self.repository.get_dataset_payload.side_effect = [
            dataset_payload(dataset_id="dataset-1"),
            dataset_payload(dataset_id="dataset-2"),
        ]
        with (
            patch("app.mcp.catalog.settings.ai_context_signing_secret", SECRET),
            patch("app.mcp.catalog.SessionLocal", return_value=FakeSession()),
            patch("app.mcp.catalog.CatalogRepository", return_value=self.repository),
            patch(
                "app.mcp.catalog.dataset_with_persisted_permission_grants",
                side_effect=[first_dataset, second_dataset],
            ),
            patch("app.mcp.catalog.require_governed_access"),
            patch("app.mcp.catalog.require_permission"),
        ):
            result = get_datasets_context(
                ["dataset-1", "dataset-2"],
                context_token=token,
                sample_row_limit=10_000,
            )

        self.assertEqual([len(context.sample_rows) for context in result], [20, 20])

    def test_mcp_service_token_guard_rejects_invalid_token(self) -> None:
        async def request() -> tuple[int, bytes]:
            messages: list[tuple[str, object]] = []

            async def receive() -> dict[str, object]:
                return {"type": "http.request", "body": b"", "more_body": False}

            async def send(message: dict[str, object]) -> None:
                messages.append((str(message["type"]), message.get("status") or message.get("body", b"")))

            scope = {
                "type": "http",
                "method": "GET",
                "path": "/",
                "headers": [(b"authorization", b"Bearer wrong")],
                "query_string": b"",
                "scheme": "http",
                "server": ("testserver", 80),
                "client": ("testclient", 1),
                "root_path": "",
                "http_version": "1.1",
            }
            with patch("app.mcp.server.settings.ai_mcp_service_token", "expected"):
                internal_mcp_app, _lifespan = create_mcp_components()
                await internal_mcp_app(scope, receive, send)
            return int(messages[0][1]), messages[1][1]  # type: ignore[arg-type]

        status_code, _body = asyncio.run(request())
        self.assertEqual(status_code, status.HTTP_401_UNAUTHORIZED)

    def test_mcp_streamable_http_initializes_with_internal_auth_and_scope(self) -> None:
        async def initialize() -> int:
            with patch("app.mcp.server.settings.ai_mcp_service_token", "expected"):
                internal_app, lifespan = create_mcp_components()
                async with lifespan():
                    client = TestClient(internal_app)
                    response = client.post(
                        "/mcp",
                        headers={
                            "Authorization": "Bearer expected",
                            "Accept": "application/json, text/event-stream",
                            "Host": "fastapi:8080",
                            "X-AskLake-AI-Context": context_token(),
                        },
                        json={
                            "jsonrpc": "2.0",
                            "id": 1,
                            "method": "initialize",
                            "params": {
                                "protocolVersion": "2025-06-18",
                                "capabilities": {},
                                "clientInfo": {"name": "test", "version": "1"},
                            },
                        },
                    )
                    return response.status_code

        self.assertEqual(asyncio.run(initialize()), status.HTTP_200_OK)

    def test_mcp_streamable_http_registers_batch_catalog_tool(self) -> None:
        async def list_tools() -> list[str]:
            with patch("app.mcp.server.settings.ai_mcp_service_token", "expected"):
                internal_app, lifespan = create_mcp_components()
                async with lifespan():
                    client = TestClient(internal_app)
                    response = client.post(
                        "/mcp",
                        headers={
                            "Authorization": "Bearer expected",
                            "Accept": "application/json, text/event-stream",
                            "X-AskLake-AI-Context": context_token(),
                        },
                        json={
                            "jsonrpc": "2.0",
                            "id": 1,
                            "method": "initialize",
                            "params": {
                                "protocolVersion": "2025-06-18",
                                "capabilities": {},
                                "clientInfo": {"name": "test", "version": "1"},
                            },
                        },
                    )
                    self.assertEqual(response.status_code, status.HTTP_200_OK)
                    tools_response = client.post(
                        "/mcp",
                        headers={
                            "Authorization": "Bearer expected",
                            "Accept": "application/json, text/event-stream",
                            "Content-Type": "application/json",
                            "X-AskLake-AI-Context": context_token(),
                        },
                        json={"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
                    )
                    self.assertEqual(tools_response.status_code, status.HTTP_200_OK)
                    return [item["name"] for item in tools_response.json()["result"]["tools"]]

        self.assertIn("asklake.catalog.get_datasets_context", asyncio.run(list_tools()))


class AiGatewayClientTests(unittest.TestCase):
    def setUp(self) -> None:
        self.runtime_settings = Settings(
            ai_gateway_base_url="http://ai-server:8090",
            ai_gateway_generate_path="/v1/generate",
            ai_gateway_service_token="service-secret",
            ai_gateway_timeout_seconds=2,
        )
        self.client = AiGatewayClient(self.runtime_settings)

    def test_timeout_maps_to_gateway_timeout_without_logging_token(self) -> None:
        with patch("app.services.ai_gateway_client.httpx.post", side_effect=httpx.TimeoutException("timed out")):
            with self.assertRaises(ApiError) as raised:
                self.client.generate_query_sql(
                    "request-1", "count rows", "", "dataset-1", ["dataset-1"], "context-secret"
                )

        self.assertEqual(raised.exception.status_code, status.HTTP_504_GATEWAY_TIMEOUT)
        self.assertNotIn("context-secret", str(raised.exception))

    def test_gateway_auth_and_upstream_statuses_are_mapped(self) -> None:
        request = httpx.Request("POST", "http://ai-server:8090/v1/generate")
        for code, expected_status in (
            (401, status.HTTP_401_UNAUTHORIZED),
            (502, status.HTTP_502_BAD_GATEWAY),
            (503, status.HTTP_503_SERVICE_UNAVAILABLE),
        ):
            with self.subTest(code=code), patch(
                "app.services.ai_gateway_client.httpx.post",
                return_value=httpx.Response(code, request=request),
            ):
                with self.assertRaises(ApiError) as raised:
                    self.client.generate_query_sql(
                        "request-1", "count rows", "", "dataset-1", ["dataset-1"], "context-secret"
                    )
                self.assertEqual(raised.exception.status_code, expected_status)

    def test_gateway_rejects_removed_flat_legacy_contract(self) -> None:
        request = httpx.Request("POST", "http://ai-server:8090/v1/generate")
        response = httpx.Response(
            200,
            request=request,
            json={
                "title": "Count",
                "body": "Draft",
                "sql": "SELECT count(*) FROM customer_events",
                "notices": [],
                "model": "internal-model",
            },
        )
        with patch("app.services.ai_gateway_client.httpx.post", return_value=response):
            with self.assertRaises(ApiError) as raised:
                self.client.generate_query_sql(
                    "request-1", "count rows", "", "dataset-1", ["dataset-1"], "context-secret"
                )

        self.assertEqual(raised.exception.status_code, status.HTTP_502_BAD_GATEWAY)

    def test_gateway_maps_current_nested_internal_server_response(self) -> None:
        request = httpx.Request("POST", "http://ai-server:8090/v1/generate")
        response = httpx.Response(
            200,
            request=request,
            json={
                "request_id": "request-1",
                "mode": "query_sql",
                "output": {
                    "query_sql": "SELECT count(*) FROM customer_events",
                    "explanation": "Counts the selected events.",
                    "warnings": ["Review before execution."],
                    "usedEvidenceIds": [],
                },
                "provider": "openai_compatible",
                "model": "sql-model",
                "usage": {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15, "estimatedCostUsd": 0.0},
            },
        )
        with (
            patch("app.services.ai_gateway_client.httpx.post", return_value=response) as post,
            patch.object(self.client, "_persist_generation_usage") as persist,
        ):
            result = self.client.generate_query_sql(
                "request-1", "count rows", "", "dataset-1", ["dataset-1"], "context-secret"
            )

        self.assertEqual(result["title"], "SQL draft")
        self.assertEqual(result["body"], "Counts the selected events.")
        self.assertEqual(result["sql"], "SELECT count(*) FROM customer_events")
        self.assertEqual(result["notices"], ["Review before execution."])
        self.assertEqual(result["model"], "sql-model")
        self.assertEqual(result["provider"], "openai_compatible")
        self.assertEqual(result["usedEvidenceIds"], [])
        self.assertEqual(post.call_args.kwargs["headers"]["X-Request-ID"], "request-1")
        self.assertEqual(post.call_args.kwargs["headers"]["X-AskLake-AI-Context"], "context-secret")
        self.assertEqual(post.call_args.args[0], "http://ai-server:8090/v1/generate")
        self.assertEqual(post.call_args.kwargs["json"]["current_query"], "")
        self.assertEqual(post.call_args.kwargs["json"]["base_dataset_id"], "dataset-1")
        persist.assert_called_once()

    def test_etl_transform_uses_the_unified_generation_contract(self) -> None:
        request = httpx.Request("POST", "http://ai-server:8090/v1/generate")
        response = httpx.Response(200, request=request, json={
            "request_id": "request-etl",
            "mode": "etl_transform",
            "output": {"sql": "upper(product_name)", "schemaContext": "product_name string"},
            "provider": "openai_compatible",
            "model": "gpt-test",
        })
        with patch("app.services.ai_gateway_client.httpx.post", return_value=response) as post:
            result = self.client.generate_etl_transform(
                request_id="request-etl",
                question="대문자로",
                prompt_type="field_transform",
                metadata={"column": "product_name"},
                context="",
                engine="spark",
            )

        self.assertEqual(result["sql"], "upper(product_name)")
        self.assertEqual(result["model"], "gpt-test")
        self.assertEqual(post.call_args.kwargs["json"]["mode"], "etl_transform")
        self.assertNotIn("X-AskLake-AI-Context", post.call_args.kwargs["headers"])

    def test_sql_generation_returns_only_evidence_from_supplied_rag_candidates(self) -> None:
        request = httpx.Request("POST", "http://ai-server:8090/v1/generate")
        rag_context = {
            "sources": [{"documentId": "doc-allowed", "body": "relevant fact"}],
            "retrieval": {"provenance": "semantic_layer_rag", "resultCount": 1},
        }
        payload = {
            "request_id": "request-evidence",
            "mode": "query_sql",
            "output": {
                "query_sql": "SELECT count(*) FROM customer_events",
                "explanation": "Uses the relevant fact.",
                "warnings": [],
                "usedEvidenceIds": ["doc-allowed"],
            },
            "provider": "openai_compatible",
            "model": "sql-model",
            "usage": {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15, "estimatedCostUsd": 0.0},
        }
        with patch(
            "app.services.ai_gateway_client.httpx.post",
            return_value=httpx.Response(200, request=request, json=payload),
        ):
            result = self.client.generate_query_sql(
                "request-evidence",
                "count rows",
                "",
                "dataset-1",
                ["dataset-1"],
                "context-secret",
                rag_context,
            )
        self.assertEqual(result["usedEvidenceIds"], ["doc-allowed"])

        payload["output"]["usedEvidenceIds"] = ["doc-invented"]
        with patch(
            "app.services.ai_gateway_client.httpx.post",
            return_value=httpx.Response(200, request=request, json=payload),
        ), self.assertRaises(ApiError) as raised:
            self.client.generate_query_sql(
                "request-evidence",
                "count rows",
                "",
                "dataset-1",
                ["dataset-1"],
                "context-secret",
                rag_context,
            )
        self.assertEqual(raised.exception.status_code, status.HTTP_502_BAD_GATEWAY)

    def test_dashboard_generation_forwards_signed_mcp_scope(self) -> None:
        request = httpx.Request("POST", "http://ai-server:8090/v1/generate")
        response = httpx.Response(200, request=request, json={
            "request_id": "request-dashboard",
            "mode": "dashboard_assistant",
            "output": {"message": "차트를 만들었습니다.", "actions": [], "warnings": [], "usedEvidenceIds": []},
            "provider": "openai_compatible",
            "model": "gpt-test",
        })
        with patch("app.services.ai_gateway_client.httpx.post", return_value=response) as post:
            result = self.client.generate_dashboard_response(
                request_id="request-dashboard",
                prompt="지역별 막대 차트",
                dashboard_context={"availableDatasets": [{"id": "sales"}]},
                selected_dataset_ids=["sales"],
                context_token="signed-dashboard-context",
            )

        self.assertEqual(result["message"], "차트를 만들었습니다.")
        self.assertEqual(result["model"], "gpt-test")
        self.assertEqual(result["provider"], "openai_compatible")
        self.assertEqual(post.call_args.kwargs["headers"]["X-AskLake-AI-Context"], "signed-dashboard-context")
        self.assertEqual(post.call_args.kwargs["json"]["selected_dataset_ids"], ["sales"])

    def test_embeddings_validate_gateway_contract_and_numeric_values(self) -> None:
        runtime_settings = Settings(
            ai_gateway_base_url="http://ai-server:8090",
            ai_gateway_service_token="service-secret",
            rag_embedding_model="embedding-model",
            rag_embedding_dimensions=2,
            rag_embedding_batch_size=2,
        )
        client = AiGatewayClient(runtime_settings)
        request = httpx.Request("POST", "http://ai-server:8090/v1/embeddings")
        valid_response = httpx.Response(200, request=request, json={
            "provider": "openai_compatible",
            "model": "embedding-model",
            "dimensions": 2,
            "data": [[0.1, 0.2], [0.3, 0.4]],
        })

        with patch("app.services.ai_gateway_client.httpx.post", return_value=valid_response) as post:
            result = client.create_embeddings(["camera", "speaker"])

        self.assertEqual(result, [[0.1, 0.2], [0.3, 0.4]])
        self.assertEqual(post.call_args.kwargs["json"]["model"], "embedding-model")

        invalid_payloads = (
            {"provider": "openai_compatible", "model": "other-model", "dimensions": 2, "data": [[0.1, 0.2]]},
            {"provider": "openai_compatible", "model": "embedding-model", "dimensions": 3, "data": [[0.1, 0.2, 0.3]]},
            {"provider": "openai_compatible", "model": "embedding-model", "dimensions": 2, "data": []},
        )
        for payload in invalid_payloads:
            with self.subTest(payload=payload), patch(
                "app.services.ai_gateway_client.httpx.post",
                return_value=httpx.Response(200, request=request, json=payload),
            ):
                with self.assertRaises(ApiError) as raised:
                    client.create_embeddings(["camera"])
                self.assertEqual(raised.exception.status_code, status.HTTP_502_BAD_GATEWAY)

        nonfinite_response = httpx.Response(
            200,
            request=request,
            content=b'{"provider":"openai_compatible","model":"embedding-model","dimensions":2,"data":[[NaN,0.2]]}',
            headers={"content-type": "application/json"},
        )
        with patch("app.services.ai_gateway_client.httpx.post", return_value=nonfinite_response):
            with self.assertRaises(ApiError) as raised:
                client.create_embeddings(["camera"])
        self.assertEqual(raised.exception.status_code, status.HTTP_502_BAD_GATEWAY)

    def test_embeddings_reject_invalid_input_without_calling_gateway(self) -> None:
        with patch("app.services.ai_gateway_client.httpx.post") as post:
            with self.assertRaises(ApiError) as raised:
                self.client.create_embeddings(["   "])

        self.assertEqual(raised.exception.status_code, status.HTTP_422_UNPROCESSABLE_ENTITY)
        post.assert_not_called()


class AiGatewaySettingsTests(unittest.TestCase):
    def test_gateway_base_url_rejects_credentials_and_query_parameters(self) -> None:
        with self.assertRaises(ValueError):
            Settings(ai_gateway_base_url="http://user:pass@ai-server:8090/v1")
        with self.assertRaises(ValueError):
            Settings(ai_gateway_base_url="http://ai-server:8090/v1?target=external")

    def test_internal_ai_paths_reject_absolute_urls_and_queries(self) -> None:
        with self.assertRaises(ValueError):
            Settings(ai_gateway_generate_path="https://external.example/v1/generate")
        with self.assertRaises(ValueError):
            Settings(ai_mcp_path="/internal/mcp?target=external")
        with self.assertRaises(ValueError):
            Settings(ai_gateway_embeddings_path="https://external.example/v1/embeddings")


if __name__ == "__main__":
    unittest.main()
