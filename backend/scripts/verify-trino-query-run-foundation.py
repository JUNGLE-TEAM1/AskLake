import base64
from typing import Any

from app.core.auth_context import ActorContext, can
from app.core.config import Settings
from app.core.errors import ApiError
from app.schemas.catalog import CatalogDatasetResponse
from app.schemas.trino import QueryRunSubmitRequest, SubmitTrinoQueryRunRequest, TrinoClientPage
from app.services.trino_client import TrinoClient, parse_trino_page, validate_next_uri
from app.services.trino_query_run_service import (
    build_run_response,
    decode_cursor,
    decode_cursor_position,
    encode_cursor,
    is_run_submitter,
    trino_request_fingerprint,
)
from app.services.trino_sql_compiler import compile_trino_read_query
from app.services.trino_materialization import build_trino_materialization_statement
from app.services.trino_query_estimate import build_query_estimate, parse_plan_estimated_bytes, require_estimate_confirmation


def make_dataset(dataset_id: str, name: str, table: str | None) -> CatalogDatasetResponse:
    payload: dict[str, object] = {
        "description": "Trino foundation verification dataset",
        "freshness": "latest",
        "id": dataset_id,
        "layer": "SILVER",
        "lastUpdated": "2026-07-10T00:00:00Z",
        "name": name,
        "nextRefresh": "-",
        "owner": "AskLake",
        "quality": "ready",
        "rag": False,
        "rows": "0",
        "sampleRows": [],
        "schema": [],
        "size": "0 B",
        "source": "Trino",
        "status": "available",
        "tags": [],
    }
    if table:
        payload["queryEngineTable"] = {
            "catalog": "iceberg",
            "schema": "asklake",
            "table": table,
            "format": "iceberg",
        }
    return CatalogDatasetResponse.model_validate(payload)


def assert_client_identity(client: TrinoClient, expected_user: str, expected_password: str) -> None:
    requests: list[dict[str, Any]] = []

    def record_request(
        url: str,
        *,
        method: str,
        body: bytes | None = None,
        headers: dict[str, str] | None = None,
        allow_empty_response: bool = False,
    ) -> TrinoClientPage:
        requests.append({"allowEmpty": allow_empty_response, "body": body, "headers": headers or {}, "method": method, "url": url})
        return TrinoClientPage(queryId="query_identity_test", rawStats={"state": "RUNNING"})

    client._request = record_request  # type: ignore[method-assign]
    client.submit("SELECT 1")
    client.fetch("https://trino.internal:8443/v1/statement/next")
    client.cancel("https://trino.internal:8443/v1/statement/next")

    assert [request["method"] for request in requests] == ["POST", "GET", "DELETE"]
    expected_token = base64.b64encode(f"{expected_user}:{expected_password}".encode("utf-8")).decode("ascii")
    for request in requests:
        headers = request["headers"]
        assert headers["X-Trino-User"] == expected_user
        assert headers["Authorization"] == f"Basic {expected_token}"


def verify() -> None:
    runtime_settings = Settings(
        _env_file=None,
        trino_auth_password="api-secret",
        trino_auth_username="asklake-api",
        trino_base_url="https://trino.internal:8443",
        trino_user="fallback-user",
    )
    assert_client_identity(TrinoClient(runtime_settings), "asklake-api", "api-secret")
    assert_client_identity(
        TrinoClient(runtime_settings, username="asklake-materializer", password="materializer-secret"),
        "asklake-materializer",
        "materializer-secret",
    )

    canonical_request = QueryRunSubmitRequest(datasetId="ds_orders", query="SELECT * FROM orders")
    assert canonical_request.trino_request().base_dataset_id == "ds_orders"
    normalized_request = SubmitTrinoQueryRunRequest(
        baseDatasetId="ds_orders",
        clientRequestId="  request-1  ",
        query="SELECT * FROM orders",
    )
    assert normalized_request.client_request_id == "request-1"
    try:
        SubmitTrinoQueryRunRequest(baseDatasetId="ds_orders", clientRequestId="   ", query="SELECT * FROM orders")
    except ValueError:
        pass
    else:
        raise AssertionError("Blank clientRequestId must be rejected")
    orders = make_dataset("ds_orders", "orders", "orders_clean")
    customers = make_dataset("ds_customers", "customers", "customers_clean")
    compiled, references = compile_trino_read_query(
        "SELECT o.order_id FROM orders o JOIN customers c ON o.customer_id = c.customer_id",
        [orders, customers],
    )
    assert 'FROM "iceberg"."asklake"."orders_clean" AS o' in compiled
    assert 'JOIN "iceberg"."asklake"."customers_clean" AS c' in compiled
    assert [dataset.id for dataset in references] == ["ds_orders", "ds_customers"]

    comma_compiled, _ = compile_trino_read_query(
        "SELECT * FROM orders o, customers c WHERE o.customer_id = c.customer_id",
        [orders, customers],
    )
    assert '"iceberg"."asklake"."orders_clean" AS o' in comma_compiled
    assert '"iceberg"."asklake"."customers_clean" AS c' in comma_compiled

    missing_mapping = make_dataset("ds_missing", "missing_map", None)
    try:
        compile_trino_read_query("SELECT * FROM missing_map", [missing_mapping])
    except ApiError as error:
        assert error.code == "VALIDATION_ERROR"
    else:
        raise AssertionError("missing Trino mapping should fail")

    unavailable_mapping = orders.model_copy(update={"query_engine_status": "unavailable"})
    try:
        compile_trino_read_query("SELECT * FROM orders", [unavailable_mapping])
    except ApiError as error:
        assert error.code == "VALIDATION_ERROR"
    else:
        raise AssertionError("unverified Trino mapping should fail")

    for unsafe_query in [
        "SELECT * FROM iceberg.asklake.orders_clean",
        "SELECT * FROM TABLE(system.query(query => 'SELECT 1'))",
    ]:
        try:
            compile_trino_read_query(unsafe_query, [orders, customers])
        except ApiError:
            pass
        else:
            raise AssertionError(f"unsafe SQL should fail: {unsafe_query}")

    page = parse_trino_page({
        "id": "20260710_000000_00001_test",
        "nextUri": "http://trino:8080/v1/statement/next",
        "columns": [{"name": "order_id"}],
        "stats": {"state": "RUNNING", "elapsedTimeMillis": 25, "processedRows": 3},
    })
    run = build_run_response(
        SubmitTrinoQueryRunRequest(baseDatasetId="ds_orders", query="SELECT * FROM orders"),
        page,
        actor=type("Actor", (), {"id": "user_1", "name": "Demo User"})(),
        retention_seconds=300,
    )
    assert run.status == "running"
    assert run.stats and run.stats.processed_rows == 3
    assert run.result and run.result.columns == ["order_id"]
    assert run.submitted_by_user_id == "user_1"
    assert run.result and run.result.retention_expires_at
    opaque_cursor = encode_cursor(
        2,
        run_id=run.run_id,
        retention_expires_at=run.result.retention_expires_at,
        secret="verify-secret",
    )
    assert not opaque_cursor.startswith("page:")
    assert decode_cursor(
        opaque_cursor,
        run_id=run.run_id,
        retention_expires_at=run.result.retention_expires_at,
        secret="verify-secret",
    ) == 2
    offset_cursor = encode_cursor(
        2,
        run_id=run.run_id,
        retention_expires_at=run.result.retention_expires_at,
        secret="verify-secret",
        row_offset=75,
    )
    assert decode_cursor_position(
        offset_cursor,
        run_id=run.run_id,
        retention_expires_at=run.result.retention_expires_at,
        secret="verify-secret",
    ) == (2, 75)
    try:
        decode_cursor(
            opaque_cursor,
            run_id="trino_other",
            retention_expires_at=run.result.retention_expires_at,
            secret="verify-secret",
        )
    except ApiError:
        pass
    else:
        raise AssertionError("cursor must be bound to its Query Run")

    identified_actor = ActorContext(id="user_1", name="Shared Name", role="viewer")
    same_name_actor = ActorContext(id="user_2", name="Shared Name", role="viewer")
    assert is_run_submitter("user_1", "Shared Name", identified_actor)
    assert not is_run_submitter("user_1", "Shared Name", same_name_actor)
    assert is_run_submitter(None, "Shared Name", same_name_actor)
    assert can(
        identified_actor,
        "query",
        grants=[{"actions": ["query"], "principalId": "user_1", "principalType": "user"}],
    )

    request_a = SubmitTrinoQueryRunRequest(
        baseDatasetId="ds_orders",
        clientRequestId="request-1",
        query="SELECT * FROM orders\r\n",
        referenceDatasetIds=["ds_customers", "ds_orders"],
        resultPageSize=25,
    )
    request_b = SubmitTrinoQueryRunRequest(
        baseDatasetId="ds_orders",
        clientRequestId="request-2",
        query="SELECT * FROM orders\n",
        referenceDatasetIds=["ds_orders", "ds_customers"],
        resultPageSize=25,
    )
    assert trino_request_fingerprint(request_a) == trino_request_fingerprint(request_b)
    assert trino_request_fingerprint(request_a) != trino_request_fingerprint(
        request_b.model_copy(update={"query": "SELECT order_id FROM orders"}),
    )

    estimate_dataset = orders.model_copy(update={"size": "2 GB"})
    estimate_settings = Settings(
        _env_file=None,
        trino_query_confirmation_secret="verify-confirmation-secret",
        trino_query_warning_bytes=1_000_000_000,
    )
    estimate_actor = type("Actor", (), {"id": "user_1", "email": None, "name": "Demo User"})()
    estimate = build_query_estimate(
        actor=estimate_actor,
        context_datasets=[estimate_dataset],
        query="SELECT * FROM orders",
        runtime_settings=estimate_settings,
    )
    assert estimate.confirmation_required and estimate.confirmation_token
    require_estimate_confirmation(
        actor=estimate_actor,
        confirmation_token=estimate.confirmation_token,
        context_datasets=[estimate_dataset],
        query="SELECT * FROM orders",
        runtime_settings=estimate_settings,
    )
    unknown_size_estimate = build_query_estimate(
        actor=estimate_actor,
        context_datasets=[orders.model_copy(update={"size": "Trino managed"})],
        query="SELECT * FROM orders",
        runtime_settings=estimate_settings,
    )
    assert unknown_size_estimate.confirmation_required
    plan_backed_unknown_size_estimate = build_query_estimate(
        actor=estimate_actor,
        context_datasets=[orders.model_copy(update={"size": "Trino managed"})],
        query="SELECT * FROM orders",
        runtime_settings=estimate_settings,
        plan_estimated_bytes=9 * 1024,
    )
    assert not plan_backed_unknown_size_estimate.confirmation_required
    assert plan_backed_unknown_size_estimate.risk_level == "low"
    assert parse_plan_estimated_bytes("Estimates: {rows: 230 (9.00kB), cpu: 9.00k}") == 9 * 1024

    completed_run = run.model_copy(update={"status": "succeeded"})
    materialization_sql = build_trino_materialization_statement(
        completed_run,
        orders.query_engine_table,
        'SELECT * FROM "iceberg"."asklake"."orders_clean"',
    )
    assert materialization_sql.startswith('CREATE TABLE "iceberg"."asklake"."orders_clean"')

    validate_next_uri("https://trino.internal:8443/v1/statement/next", "https://trino.internal:8443")
    try:
        validate_next_uri("http://127.0.0.1:8080/v1/statement/next", "https://trino.internal:8443")
    except ApiError:
        pass
    else:
        raise AssertionError("untrusted Trino continuation URL should fail")


if __name__ == "__main__":
    verify()
    print("Trino Query Run foundation verification passed.")
