import asyncio
import unittest
from unittest.mock import Mock, call, patch

import httpx
from fastapi import status
from fastapi.testclient import TestClient

from app.core.auth_context import ActorContext
from app.core.config import Settings
from app.core.errors import ApiError
from app.mcp.catalog import get_dataset_context, get_datasets_context
from app.mcp.context import issue_ai_context_token, verify_ai_context_token
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
            ai_gateway_generate_path="/v1/query-sql",
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
        request = httpx.Request("POST", "http://ai-server:8090/v1/query-sql")
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

    def test_gateway_response_has_stable_typed_contract(self) -> None:
        request = httpx.Request("POST", "http://ai-server:8090/v1/query-sql")
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
        with patch("app.services.ai_gateway_client.httpx.post", return_value=response) as post:
            result = self.client.generate_query_sql(
                "request-1", "count rows", "", "dataset-1", ["dataset-1"], "context-secret"
            )

        self.assertEqual(set(result), {"title", "body", "sql", "notices", "model"})
        self.assertEqual(post.call_args.kwargs["headers"]["X-Request-ID"], "request-1")
        self.assertEqual(post.call_args.kwargs["headers"]["X-AskLake-AI-Context"], "context-secret")
        self.assertEqual(post.call_args.args[0], "http://ai-server:8090/v1/query-sql")

    def test_gateway_maps_current_nested_internal_server_response(self) -> None:
        request = httpx.Request("POST", "http://ai-server:8090/v1/query-sql")
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
                },
                "provider": "mock",
                "model": "mock-query-sql",
            },
        )
        with patch("app.services.ai_gateway_client.httpx.post", return_value=response):
            result = self.client.generate_query_sql(
                "request-1", "count rows", "", "dataset-1", ["dataset-1"], "context-secret"
            )

        self.assertEqual(result["title"], "SQL draft")
        self.assertEqual(result["body"], "Counts the selected events.")
        self.assertEqual(result["sql"], "SELECT count(*) FROM customer_events")
        self.assertEqual(result["notices"], ["Review before execution."])
        self.assertEqual(result["model"], "mock-query-sql")


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


if __name__ == "__main__":
    unittest.main()
