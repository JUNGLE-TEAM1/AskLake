import base64
from typing import Any

from app.core.auth_context import ActorContext, can
from app.core.config import Settings
from app.core.errors import ApiError
from app.schemas.catalog import CatalogDatasetResponse
from app.schemas.trino import QueryRunSubmitRequest, SubmitTrinoQueryRunRequest, TrinoClientPage, TrinoQueryRunResult
from app.services.trino_client import TrinoClient, TrinoQueryInfo, parse_trino_page, validate_next_uri
from app.services.trino_query_run_service import (
    apply_trino_page,
    apply_trino_query_info,
    build_run_response,
    decode_cursor,
    decode_cursor_position,
    encode_cursor,
    is_run_submitter,
    parse_trino_data_size_bytes,
    parse_trino_duration_ms,
    query_run_estimate_snapshot,
    result_collection_progress_percentage,
    trino_stats,
    trino_request_fingerprint,
    with_result_collection_timing,
)
from app.services.trino_sql_compiler import compile_trino_read_query
from app.services.trino_materialization import build_trino_materialization_statement
from app.services.trino_query_estimate import build_query_estimate, estimate_iceberg_scan_bytes, parse_dataset_size, parse_plan_estimated_bytes, require_estimate_confirmation


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


def verify_result_storage_contract() -> None:
    for storage_backend in ("s3", "minio", "postgres"):
        assert TrinoQueryRunResult(storage=storage_backend).storage == storage_backend


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


class ScalarEstimateClient:
    def __init__(self, value: int) -> None:
        self.statement = ""
        self.value = value

    def submit(self, statement: str) -> TrinoClientPage:
        self.statement = statement
        return TrinoClientPage(queryId="metadata_estimate", rawStats={"state": "FINISHED"}, rows=[[self.value]])

    def fetch(self, _next_uri: str) -> TrinoClientPage:
        raise AssertionError("scalar metadata estimate should fit in one page")


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
    assert run.stats.query_state == "RUNNING"
    assert run.result and run.result.columns == ["order_id"]
    assert run.result.collection_started_at
    assert run.submitted_by_user_id == "user_1"
    assert run.result and run.result.retention_expires_at

    timing_seed = run.model_copy(update={
        "submitted_at": "2026-07-12T00:00:00+00:00",
        "result": run.result.model_copy(update={
            "collection_completed_at": None,
            "collection_elapsed_ms": None,
            "collection_started_at": None,
            "first_page_available_at": None,
            "first_page_elapsed_ms": None,
            "total_ready_ms": None,
        }),
    })
    collection_started = with_result_collection_timing(
        timing_seed,
        at="2026-07-12T00:00:02+00:00",
    )
    first_page_ready = with_result_collection_timing(
        collection_started,
        at="2026-07-12T00:00:05+00:00",
        first_page_available=True,
    )
    collection_ready = with_result_collection_timing(
        first_page_ready,
        at="2026-07-12T00:00:12+00:00",
        collection_completed=True,
        first_page_available=True,
    )
    assert collection_ready.result
    assert collection_ready.result.collection_started_at == "2026-07-12T00:00:02+00:00"
    assert collection_ready.result.first_page_available_at == "2026-07-12T00:00:05+00:00"
    assert collection_ready.result.collection_completed_at == "2026-07-12T00:00:12+00:00"
    assert collection_ready.result.first_page_elapsed_ms == 5_000
    assert collection_ready.result.collection_elapsed_ms == 10_000
    assert collection_ready.result.total_ready_ms == 12_000
    timing_payload = collection_ready.model_dump(by_alias=True, exclude_none=True, mode="json")
    assert timing_payload["result"]["collectionStartedAt"] == "2026-07-12T00:00:02+00:00"
    assert timing_payload["result"]["firstPageElapsedMs"] == 5_000
    assert timing_payload["result"]["totalReadyMs"] == 12_000
    timing_replayed = with_result_collection_timing(
        collection_ready,
        at="2026-07-12T00:00:20+00:00",
        collection_completed=True,
        first_page_available=True,
    )
    assert timing_replayed.result
    assert timing_replayed.result.collection_started_at == collection_ready.result.collection_started_at
    assert timing_replayed.result.first_page_available_at == collection_ready.result.first_page_available_at
    assert timing_replayed.result.collection_completed_at == collection_ready.result.collection_completed_at
    assert timing_replayed.result.collection_elapsed_ms == collection_ready.result.collection_elapsed_ms
    assert timing_replayed.result.total_ready_ms == collection_ready.result.total_ready_ms

    live_info = TrinoQueryInfo(
        query_id=page.query_id,
        raw_stats={
            "completedDrivers": 39,
            "elapsedTime": "3.50s",
            "peakUserMemoryReservation": "64MB",
            "processedInputDataSize": "1.50GB",
            "processedInputPositions": 123_456,
            "progressPercentage": 24.074074074074073,
            "queuedTime": "125ms",
            "totalCpuTime": "2.25s",
            "totalDrivers": 162,
        },
        state="RUNNING",
    )
    live_run = apply_trino_query_info(run, live_info)
    assert live_run.stats and live_run.stats.completed_drivers == 39
    assert live_run.stats.cpu_ms == 2_250
    assert live_run.stats.elapsed_ms == 3_500
    assert live_run.stats.peak_memory_bytes == 64 * 1024**2
    assert live_run.stats.processed_bytes == int(1.5 * 1024**3)
    assert live_run.stats.processed_rows == 123_456
    assert live_run.stats.total_drivers == 162
    assert live_run.stats.progress_percentage == 24.074074074074073
    assert live_run.stats.queued_ms == 125
    assert live_run.stats.progress_observed_at

    output_complete_run = apply_trino_query_info(
        live_run,
        TrinoQueryInfo(
            query_id=page.query_id,
            raw_stats={
                "completedDrivers": 162,
                "outputDataSize": "34.5MB",
                "outputPositions": 4_000_000,
                "progressPercentage": 100,
                "totalDrivers": 162,
            },
            state="RUNNING",
        ),
    )
    assert output_complete_run.stats and output_complete_run.stats.output_rows == 4_000_000
    query_completed_at = output_complete_run.stats.query_completed_at
    assert query_completed_at

    finished_run = apply_trino_query_info(
        output_complete_run,
        TrinoQueryInfo(
            query_id=page.query_id,
            raw_stats={
                "completedDrivers": 162,
                "outputDataSize": "34.5MB",
                "outputPositions": 4_000_000,
                "progressPercentage": 100,
                "totalDrivers": 162,
            },
            state="FINISHED",
        ),
    )
    assert finished_run.stats and finished_run.stats.output_rows == 4_000_000
    assert finished_run.stats.output_bytes == int(34.5 * 1024 * 1024)
    assert finished_run.stats.query_completed_at == query_completed_at
    replayed_finished_run = apply_trino_query_info(
        finished_run,
        TrinoQueryInfo(
            query_id=page.query_id,
            raw_stats={"progressPercentage": 100},
            state="FINISHED",
        ),
    )
    assert replayed_finished_run.stats
    assert replayed_finished_run.stats.query_completed_at == query_completed_at
    stale_live_run = apply_trino_query_info(
        replayed_finished_run,
        TrinoQueryInfo(
            query_id=page.query_id,
            raw_stats={
                "completedDrivers": 1,
                "elapsedTime": "1s",
                "processedInputDataSize": "1MB",
                "processedInputPositions": 1,
                "progressPercentage": 1,
                "totalDrivers": 10,
            },
            state="RUNNING",
        ),
    )
    assert stale_live_run.stats
    assert stale_live_run.stats.query_state == "FINISHED"
    assert stale_live_run.stats.elapsed_ms == 3_500
    assert stale_live_run.stats.processed_bytes == int(1.5 * 1024**3)
    assert stale_live_run.stats.processed_rows == 123_456
    assert stale_live_run.stats.progress_percentage == 100
    stale_page_run = apply_trino_page(
        stale_live_run,
        TrinoClientPage(
            nextUri="http://trino:8080/v1/statement/stale-page",
            queryId=page.query_id,
            rawStats={
                "cpuTimeMillis": 100,
                "elapsedTimeMillis": 500,
                "peakMemoryBytes": 512,
                "processedBytes": 1_024,
                "processedRows": 10,
                "progressPercentage": 2,
                "queuedTimeMillis": 10,
                "state": "RUNNING",
            },
            state="RUNNING",
        ),
    )
    assert stale_page_run.stats
    assert stale_page_run.stats.query_state == "FINISHED"
    assert stale_page_run.stats.cpu_ms == 2_250
    assert stale_page_run.stats.elapsed_ms == 3_500
    assert stale_page_run.stats.peak_memory_bytes == 64 * 1024**2
    assert stale_page_run.stats.processed_bytes == int(1.5 * 1024**3)
    assert stale_page_run.stats.processed_rows == 123_456
    assert stale_page_run.stats.progress_percentage == 100
    assert stale_page_run.stats.queued_ms == 125
    assert parse_trino_data_size_bytes("181499379B") == 181_499_379
    assert parse_trino_duration_ms("1.5m") == 90_000
    assert parse_trino_duration_ms("2.25s") == 2_250
    assert parse_trino_duration_ms("invalid") is None
    assert round(result_collection_progress_percentage(
        629_041,
        4_000_000,
        storage_status="collecting",
    ) or 0, 1) == 15.7
    assert result_collection_progress_percentage(4_000_000, 4_000_000, storage_status="available") == 100
    assert result_collection_progress_percentage(10, None, storage_status="collecting") is None

    query_info_requests: list[dict[str, Any]] = []
    query_info_client = TrinoClient(runtime_settings)

    def query_info_request(
        url: str,
        *,
        method: str,
        body: bytes | None = None,
        headers: dict[str, str] | None = None,
        allow_empty_response: bool = False,
        timeout_seconds: float | None = None,
    ) -> dict[str, Any]:
        query_info_requests.append({
            "allowEmpty": allow_empty_response,
            "body": body,
            "headers": headers or {},
            "method": method,
            "timeout": timeout_seconds,
            "url": url,
        })
        return {
            "queryId": page.query_id,
            "queryStats": {"progressPercentage": 50.0},
            "state": "RUNNING",
        }

    query_info_client._request_json = query_info_request  # type: ignore[method-assign]
    parsed_info = query_info_client.query_info(page.query_id)
    assert parsed_info.state == "RUNNING" and parsed_info.raw_stats["progressPercentage"] == 50.0
    assert query_info_requests[0]["url"].endswith(f"/v1/query/{page.query_id}")
    assert query_info_requests[0]["headers"]["X-Trino-User"] == "asklake-api"
    assert query_info_requests[0]["timeout"] == runtime_settings.trino_progress_timeout_seconds
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
    ) == (2, 75, 0)
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
    assert estimate.estimate_source == "catalog_heuristic"
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
    snapshot = query_run_estimate_snapshot(plan_backed_unknown_size_estimate)
    assert "confirmationToken" not in snapshot.model_dump(by_alias=True)
    assert snapshot.estimated_bytes == 9 * 1024
    assert parse_plan_estimated_bytes("Estimates: {rows: 230 (9.00kB), cpu: 9.00k}") == 9 * 1024
    assert parse_dataset_size("10 GiB") == 10 * 1024**3
    assert parse_dataset_size("1.5 TiB") == int(1.5 * 1024**4)

    ten_gib = 10 * 1024**3
    iceberg_dataset = orders.model_copy(update={
        "schema_": [("order_id", "bigint"), ("payload", "varchar")],
        "storage_size_bytes": ten_gib,
    })
    scalar_client = ScalarEstimateClient(325 * 1024**2)
    assert estimate_iceberg_scan_bytes(
        client=scalar_client,  # type: ignore[arg-type]
        context_datasets=[iceberg_dataset],
        query="SELECT order_id FROM orders",
    ) == 325 * 1024**2
    assert "$files" in scalar_client.statement and "order_id" in scalar_client.statement
    assert "payload" not in scalar_client.statement

    metadata_estimate = build_query_estimate(
        actor=estimate_actor,
        context_datasets=[iceberg_dataset],
        query="SELECT order_id FROM orders",
        runtime_settings=estimate_settings,
        iceberg_estimated_bytes=ten_gib,
    )
    assert metadata_estimate.estimate_source == "iceberg_metadata"
    assert metadata_estimate.iceberg_estimated_bytes == ten_gib
    assert metadata_estimate.estimated_bytes == ten_gib
    assert metadata_estimate.estimated_duration_seconds == 40.0
    assert metadata_estimate.duration_estimate_source == "configured_throughput"
    assert metadata_estimate.estimated_throughput_bytes_per_second == 268_435_456

    conservative_dataset = orders.model_copy(update={"size": "1 MB", "storage_size_bytes": ten_gib})
    conservative_estimate = build_query_estimate(
        actor=estimate_actor,
        context_datasets=[conservative_dataset],
        query="SELECT * FROM orders",
        runtime_settings=estimate_settings,
        plan_estimated_bytes=325 * 1024**2,
    )
    assert conservative_estimate.known_input_bytes == ten_gib
    assert conservative_estimate.plan_estimated_bytes == 325 * 1024**2
    assert conservative_estimate.estimated_bytes == ten_gib
    assert conservative_estimate.estimated_duration_seconds == 40
    assert conservative_estimate.estimate_source == "conservative_bound"
    assert conservative_estimate.risk_level == "high"
    assert conservative_estimate.confirmation_required and conservative_estimate.confirmation_token
    assert any("보수적 추정치" in warning for warning in conservative_estimate.warnings)
    conservative_snapshot = query_run_estimate_snapshot(conservative_estimate)
    assert conservative_snapshot.plan_estimated_bytes == 325 * 1024**2
    assert conservative_snapshot.estimate_source == "conservative_bound"

    plan_dominant_estimate = build_query_estimate(
        actor=estimate_actor,
        context_datasets=[orders.model_copy(update={"size": "1 GB", "storage_size_bytes": None})],
        query="SELECT * FROM orders",
        runtime_settings=estimate_settings,
        plan_estimated_bytes=2 * 1024**3,
    )
    assert plan_dominant_estimate.estimated_bytes == 2 * 1024**3
    assert plan_dominant_estimate.estimate_source == "trino_plan"

    joined_estimate = build_query_estimate(
        actor=estimate_actor,
        context_datasets=[
            orders.model_copy(update={"size": "1 GiB", "storage_size_bytes": None}),
            customers.model_copy(update={"size": "1 GiB", "storage_size_bytes": None}),
        ],
        query="SELECT * FROM orders JOIN customers ON orders.customer_id = customers.customer_id",
        runtime_settings=estimate_settings,
        plan_estimated_bytes=2 * 1024**3,
    )
    assert joined_estimate.known_input_bytes == 2 * 1024**3
    assert joined_estimate.estimated_bytes == int(2 * 1024**3 * 1.25)
    assert joined_estimate.estimate_source == "conservative_bound"

    hard_limit_settings = estimate_settings.model_copy(update={"trino_query_max_estimated_bytes": 5 * 1024**3})
    try:
        require_estimate_confirmation(
            actor=estimate_actor,
            confirmation_token=conservative_estimate.confirmation_token,
            context_datasets=[conservative_dataset],
            query="SELECT * FROM orders",
            runtime_settings=hard_limit_settings,
            estimate=conservative_estimate,
        )
    except ApiError as error:
        assert error.status_code == 409
    else:
        raise AssertionError("conservative estimate must enforce the configured execution limit")

    split_stats = trino_stats({"completedSplits": 25, "totalSplits": 100, "state": "RUNNING"})
    assert split_stats and split_stats.progress_percentage == 25
    assert split_stats.completed_splits == 25 and split_stats.total_splits == 100
    finished_stats = trino_stats({"state": "FINISHED"})
    assert finished_stats and finished_stats.progress_percentage == 100
    assert finished_stats.query_completed_at
    unknown_progress_stats = trino_stats({"state": "RUNNING"})
    assert unknown_progress_stats and unknown_progress_stats.progress_percentage is None

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
    verify_result_storage_contract()
    verify()
    print("Trino Query Run foundation verification passed.")
