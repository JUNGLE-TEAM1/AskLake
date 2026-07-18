from __future__ import annotations

from datetime import UTC, datetime
import json
import os
import statistics
import subprocess
import sys
import time
from pathlib import Path
from uuid import uuid4

from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.core.auth_context import ActorContext
from app.core.config import Settings
from app.models.base import Base
from app.repositories.catalog_repository import CatalogRepository
from app.repositories.continuous_sql_repository import ContinuousSqlRepository
from app.repositories.dashboard_card_repository import delete_dashboard_card
from app.repositories.dashboard_live_repository import (
    DashboardLiveRepository,
    ensure_dashboard_live_schema,
)
from app.repositories.dashboard_runtime_repository import DashboardRuntimeRepository
from app.repositories.realtime_event_repository import ensure_realtime_event_schema
from app.schemas.continuous_sql import (
    ContinuousSqlCommandRequest,
    ContinuousSqlCreateRequest,
)
from app.schemas.dashboard import (
    CreateDashboardRequest,
    CreateDraftWidgetRequest,
)
from app.schemas.trino import TrinoClientPage
from app.services import clickhouse_client as clickhouse_client_module
from app.services.clickhouse_client import ClickHouseClient, qualified_clickhouse_table
from app.services.clickhouse_continuous_sql import (
    ClickHouseContinuousSqlWorkerGateway,
    clickhouse_runtime_names,
    clickhouse_static_runtime_table,
)
from app.services.iceberg_dataset_reader import execute_trino_rows, quote_trino_identifier
from app.services.trino_client import TrinoClient
from app.services.continuous_sql_service import ContinuousSqlService
from app.services.dashboard_card_service import create_dashboard_card
from app.services.dashboard_physical_data import DashboardDatasetQuerySession
from app.services.dashboard_runtime_service import DashboardRuntimeService


class FixtureTrinoClient:
    """Return one pinned static Iceberg snapshot without requiring a local Trino lake."""

    def submit(self, query: str, **_kwargs) -> TrinoClientPage:
        if "count(*)" in query.casefold():
            return TrinoClientPage(
                queryId="fixture-static-count",
                columns=["_col0"],
                rows=[[2]],
            )
        return TrinoClientPage(
            queryId="fixture-static-snapshot",
            columns=["id", "name"],
            rows=[[1, "Alice"], [2, "Bob"]],
        )

    def fetch(self, _next_uri: str, **_kwargs) -> TrinoClientPage:
        raise AssertionError("Fixture static snapshot fits in one Trino page")

    def cancel(self, _next_uri: str, **_kwargs) -> None:
        return None


def catalog_payload(
    *,
    dataset_id: str,
    dataset_name: str,
    owner: str,
    schema: list[list[str]],
    relation_mode: str,
    table: str,
    streaming_source: dict[str, object] | None = None,
    snapshot_id: str = "101",
    storage_location: str | None = None,
) -> dict[str, object]:
    payload: dict[str, object] = {
        "description": f"ClickHouse E2E input {dataset_name}",
        "downstream": [],
        "estimatedRowCount": 2,
        "freshness": "latest",
        "id": dataset_id,
        "lastUpdated": datetime.now(UTC).isoformat(),
        "layer": "BRONZE" if relation_mode == "streaming" else "SILVER",
        "materializationRuns": [],
        "name": dataset_name,
        "nextRefresh": "-",
        "owner": owner,
        "quality": "verified fixture",
        "queryEngineStatus": "available",
        "queryEngineTable": {
            "catalog": "iceberg",
            "schema": "asklake",
            "table": table,
            "format": "iceberg",
        },
        "rag": False,
        "relationMode": relation_mode,
        "rows": "2",
        "sampleRows": [],
        "schema": schema,
        "schemaFingerprint": f"{dataset_id}-v1",
        "size": "fixture",
        "source": "ClickHouse Kafka JOIN E2E",
        "status": "available",
        "storageFormat": "iceberg",
        "storageLocation": storage_location or f"s3a://asklake-fixture/{dataset_name}",
        "tags": ["clickhouse-e2e"],
        "upstream": [],
    }
    if relation_mode == "streaming":
        payload["streamingSource"] = streaming_source or {}
    else:
        payload["icebergSnapshotId"] = snapshot_id
        payload["uniqueKeySets"] = [["id"]]
    return payload


def env_enabled(name: str) -> bool:
    return str(os.getenv(name) or "").strip().casefold() in {"1", "true", "yes"}


def prepare_live_static_snapshot(
    client: TrinoClient,
    table: str,
) -> tuple[str, str]:
    qualified = ".".join(
        quote_trino_identifier(item) for item in ("iceberg", "asklake", table)
    )
    snapshots = ".".join((
        quote_trino_identifier("iceberg"),
        quote_trino_identifier("asklake"),
        quote_trino_identifier(f"{table}$snapshots"),
    ))
    files = ".".join((
        quote_trino_identifier("iceberg"),
        quote_trino_identifier("asklake"),
        quote_trino_identifier(f"{table}$files"),
    ))
    execute_trino_rows(client, "CREATE SCHEMA IF NOT EXISTS iceberg.asklake")
    execute_trino_rows(client, f"DROP TABLE IF EXISTS {qualified}")
    execute_trino_rows(
        client,
        f"CREATE TABLE {qualified} (id BIGINT, name VARCHAR) WITH (format = 'PARQUET')",
    )
    try:
        execute_trino_rows(
            client,
            f"INSERT INTO {qualified} VALUES (1, 'Alice'), (2, 'Bob')",
        )
        snapshot_rows = execute_trino_rows(
            client,
            f"SELECT snapshot_id FROM {snapshots} ORDER BY committed_at DESC LIMIT 1",
        ).rows
        file_rows = execute_trino_rows(
            client,
            f"SELECT file_path FROM {files} LIMIT 1",
        ).rows
        if not snapshot_rows or not file_rows:
            raise RuntimeError("Live Iceberg static fixture did not publish snapshot/file evidence")
        snapshot_id = str(snapshot_rows[0][0])
        file_path = str(file_rows[0][0])
        storage_location = file_path.split("/data/", 1)[0]
        return snapshot_id, storage_location
    except Exception:
        execute_trino_rows(client, f"DROP TABLE IF EXISTS {qualified}")
        raise


def drop_live_static_snapshot(client: TrinoClient, table: str) -> None:
    qualified = ".".join(
        quote_trino_identifier(item) for item in ("iceberg", "asklake", table)
    )
    execute_trino_rows(client, f"DROP TABLE IF EXISTS {qualified}")


def first_widget(runtime) -> object:
    for widgets in runtime.widgets_by_page_id.values():
        if widgets:
            return widgets[0]
    raise RuntimeError("Published dashboard has no widget")


def widget_count(widget) -> int:
    return sum(
        int(row.get("__asklake_widget_value") or 0)
        for row in widget.data
        if isinstance(row, dict)
    )


def wait_for_worker_rows(
    gateway: ClickHouseContinuousSqlWorkerGateway,
    repository: ContinuousSqlRepository,
    job_id: str,
    expected_count: int,
    *,
    timeout_seconds: float = 20,
) -> tuple[dict[str, object], float]:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        job = repository.get_job(job_id)
        run = repository.get_run(job.active_run_id) if job and job.active_run_id else None
        if job is None or run is None:
            raise RuntimeError("Continuous SQL Job or active Run disappeared")
        status_payload = gateway.manage(job, run, "status")
        offsets = status_payload.get("clickhouseOffsets") or []
        visible_count = sum(int(item["rowCount"]) for item in offsets)
        if visible_count >= expected_count:
            return status_payload, time.perf_counter()
        time.sleep(0.02)
    raise RuntimeError(
        f"ClickHouse did not materialize {expected_count} Kafka JOIN rows in time"
    )


def reconcile_until_revision(
    service: ContinuousSqlService,
    live_repository: DashboardLiveRepository,
    job_id: str,
    actor: ActorContext,
    previous_revision: int,
    *,
    timeout_seconds: float = 10,
) -> int:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        service.get(job_id, actor, reconcile=True)
        freshness = live_repository.get_freshness(
            service.repository.get_job(job_id).output_dataset_id
        )
        revision = int(freshness.latest_revision or 0) if freshness is not None else 0
        if revision > previous_revision:
            return revision
        time.sleep(0.02)
    raise RuntimeError("ClickHouse progress did not publish a new Catalog revision")


def cleanup_database(
    db: Session,
    *,
    dashboard_id: str | None,
    job_id: str | None,
    dataset_ids: list[str],
) -> None:
    db.rollback()
    if dashboard_id:
        DashboardRuntimeRepository(db).delete_dashboard_runtime(dashboard_id)
        delete_dashboard_card(db, dashboard_id)
        db.commit()

    for dataset_id in dataset_ids:
        for table_name in (
            "dashboard_widget_results",
            "dataset_kafka_partition_cursors",
            "dataset_revision_commits",
            "dataset_freshness",
        ):
            db.execute(
                text(f"DELETE FROM {table_name} WHERE dataset_id = :dataset_id"),
                {"dataset_id": dataset_id},
            )
    if job_id:
        for table_name in (
            "continuous_sql_commands",
            "continuous_sql_batches",
            "continuous_sql_runs",
            "continuous_sql_jobs",
        ):
            db.execute(
                text(f"DELETE FROM {table_name} WHERE job_id = :job_id")
                if table_name != "continuous_sql_jobs"
                else text("DELETE FROM continuous_sql_jobs WHERE id = :job_id"),
                {"job_id": job_id},
            )
    for dataset_id in dataset_ids:
        db.execute(
            text("DELETE FROM catalog_datasets WHERE id = :dataset_id"),
            {"dataset_id": dataset_id},
        )
    db.commit()


def run() -> dict[str, object]:
    suffix = uuid4().hex[:10]
    topic = f"asklake_clickhouse_e2e_{suffix}"
    stream_dataset_id = f"dataset-events-{suffix}"
    static_dataset_id = f"dataset-users-{suffix}"
    output_dataset_id = f"dataset-joined-{suffix}"
    stream_name = f"events_{suffix}"
    static_name = f"users_{suffix}"
    output_name = f"joined_events_{suffix}"
    output_table = f"joined_events_{suffix}"
    producer_table = f"producer_{suffix}"
    database_url = os.getenv(
        "CLICKHOUSE_E2E_DATABASE_URL",
        "postgresql+psycopg://asklake:asklake_dev@localhost:54328/asklake",
    )
    settings = Settings(
        _env_file=None,
        app_env="test",
        database_url=database_url,
        continuous_sql_join_enabled=True,
        clickhouse_continuous_join_enabled=True,
        clickhouse_url=os.getenv("CLICKHOUSE_URL", "http://localhost:8123"),
        clickhouse_user=os.getenv("CLICKHOUSE_USER", "asklake"),
        clickhouse_password=os.getenv(
            "CLICKHOUSE_PASSWORD", "asklake_clickhouse_dev"
        ),
        clickhouse_database=os.getenv("CLICKHOUSE_DATABASE", "asklake"),
        trino_enabled=True,
        trino_base_url=os.getenv("TRINO_BASE_URL", "http://localhost:8088"),
    )
    clickhouse_client_module.settings = settings
    broker = os.getenv("CLICKHOUSE_E2E_KAFKA_BROKER", "redpanda:9092")
    redpanda_container = os.getenv(
        "CLICKHOUSE_E2E_REDPANDA_CONTAINER", "asklake-redpanda"
    )
    subprocess.run(
        ["docker", "exec", redpanda_container, "rpk", "topic", "create", topic],
        check=True,
        capture_output=True,
        text=True,
    )

    engine = create_engine(database_url, pool_pre_ping=True)
    Base.metadata.create_all(engine)
    db = Session(engine)
    client = ClickHouseClient(settings)
    actor = ActorContext(name=f"clickhouse-e2e-{suffix}", role="admin")
    live_static_snapshot = env_enabled("CLICKHOUSE_E2E_LIVE_TRINO")
    trino_client = TrinoClient(settings) if live_static_snapshot else FixtureTrinoClient()
    gateway = ClickHouseContinuousSqlWorkerGateway(
        settings,
        trino_client=trino_client,
    )
    job_id: str | None = None
    dashboard_id: str | None = None
    runtime_names: dict[str, str] | None = None
    started = time.perf_counter()
    status_payload: dict[str, object] = {}
    static_snapshot_id = "101"
    static_storage_location = f"s3a://asklake-fixture/{static_name}"
    live_static_created = False
    try:
        if live_static_snapshot:
            static_snapshot_id, static_storage_location = prepare_live_static_snapshot(
                trino_client,
                static_name,
            )
            live_static_created = True
        ensure_dashboard_live_schema(db)
        ensure_realtime_event_schema(db)
        catalog = CatalogRepository(db)
        catalog.save_dataset_payload(
            catalog_payload(
                dataset_id=stream_dataset_id,
                dataset_name=stream_name,
                owner=actor.name,
                schema=[["event_id", "bigint"], ["user_id", "bigint"]],
                relation_mode="streaming",
                table=stream_name,
                streaming_source={
                    "broker": broker,
                    "topic": topic,
                    "consumerGroupId": f"legacy-{suffix}",
                    "initialOffsetPolicy": "earliest",
                    "recordParsing": {
                        "enabled": True,
                        "delimiterKind": "whitespace",
                        "delimiterPattern": "\\s+",
                        "header": False,
                        "expectedFieldCount": 2,
                        "columns": [
                            {"position": 0, "name": "event_id", "inferredType": "Integer"},
                            {"position": 1, "name": "user_id", "inferredType": "Integer"},
                        ],
                    },
                    "schemaColumns": [
                        {"included": True, "nullable": False, "sourceName": "event_id", "targetName": "event_id", "type": "bigint"},
                        {"included": True, "nullable": False, "sourceName": "user_id", "targetName": "user_id", "type": "bigint"},
                    ],
                },
            )
        )
        catalog.save_dataset_payload(
            catalog_payload(
                dataset_id=static_dataset_id,
                dataset_name=static_name,
                owner=actor.name,
                schema=[["id", "bigint"], ["name", "string"]],
                relation_mode="static",
                table=static_name,
                snapshot_id=static_snapshot_id,
                storage_location=static_storage_location,
            )
        )

        service = ContinuousSqlService(
            db,
            runtime_settings=settings,
            gateway=gateway,
        )
        created_job = service.create(
            ContinuousSqlCreateRequest.model_validate({
                "name": "ClickHouse Kafka JOIN E2E",
                "query": (
                    f"SELECT e.event_id, u.name AS user_name FROM {stream_name} e "
                    f"INNER JOIN {static_name} u ON e.user_id = u.id"
                ),
                "relationDatasetIds": [stream_dataset_id, static_dataset_id],
                "staticBindingPolicy": "PINNED_AT_START",
                "triggerIntervalSeconds": 1,
                "clientRequestId": f"clickhouse-e2e-{suffix}",
                "output": {
                    "datasetId": output_dataset_id,
                    "datasetName": output_name,
                    "layer": "GOLD",
                    "servingMode": "clickhouse",
                    "clickhouseTarget": {
                        "database": settings.clickhouse_database,
                        "table": output_table,
                    },
                },
            }),
            actor,
        )
        job_id = created_job.id
        runtime_names = clickhouse_runtime_names(job_id)
        service.command(
            job_id,
            ContinuousSqlCommandRequest(
                command="start", commandId=f"start-{suffix}"
            ),
            actor,
        )
        client.execute(
            f"CREATE TABLE {qualified_clickhouse_table(settings.clickhouse_database, producer_table)} "
            "(`message` String) ENGINE = Kafka SETTINGS "
            f"kafka_broker_list = '{broker}', kafka_topic_list = '{topic}', "
            f"kafka_group_name = 'producer_{suffix}', kafka_format = 'RawBLOB'"
        )

        events_published_at = time.perf_counter()
        client.insert_json_rows(
            settings.clickhouse_database,
            producer_table,
            ["message"],
            [["1001 1"], ["1002 2"], ["1003 999"]],
        )
        status_payload, joined_at = wait_for_worker_rows(
            gateway,
            service.repository,
            job_id,
            3,
        )
        live_repository = DashboardLiveRepository(db, ensure_schema=False)
        first_revision = reconcile_until_revision(
            service,
            live_repository,
            job_id,
            actor,
            0,
        )
        catalog_published_at = time.perf_counter()

        dashboard = create_dashboard_card(
            db,
            CreateDashboardRequest(
                title=f"ClickHouse JOIN E2E {suffix}",
                source="catalog",
                datasetId=output_dataset_id,
                owner=actor.name,
            ),
            actor.name,
        )
        dashboard_id = dashboard.id
        dashboard_repository = DashboardRuntimeRepository(db)
        dashboard_service = DashboardRuntimeService(
            dashboard_repository,
            CatalogRepository(db),
            live_repository,
        )
        draft = dashboard_service.ensure_draft_runtime(dashboard_id, actor)
        page_id = draft.pages[0].id
        dashboard_service.create_draft_widget(
            dashboard_id,
            page_id,
            CreateDraftWidgetRequest.model_validate({
                "type": "bar_chart",
                "title": "JOIN 결과 사용자별 이벤트 수",
                "datasetId": output_dataset_id,
                "config": {
                    "aggregation": "count",
                    "color": {"colors": ["#2563eb"]},
                    "xKey": "user_name",
                    "yKey": "__asklake_widget_value",
                },
            }),
            actor,
        )
        dashboard_service.publish_dashboard(dashboard_id, actor)
        published_runtime = dashboard_service.get_published_runtime(
            dashboard_id, actor
        )
        published_widget = first_widget(published_runtime)
        if widget_count(published_widget) != 2:
            raise RuntimeError("Published dashboard widget did not show matched JOIN rows")
        dashboard_ready_at = time.perf_counter()

        service.command(
            job_id,
            ContinuousSqlCommandRequest(
                command="pause", commandId=f"pause-{suffix}"
            ),
            actor,
        )
        paused_status = gateway.manage(
            service.repository.get_job(job_id),
            service.repository.get_run(service.repository.get_job(job_id).active_run_id),
            "status",
        )
        if paused_status.get("containerState") != "not_running":
            raise RuntimeError("ClickHouse Kafka consumer did not stop on pause")
        paused_input_count = sum(
            int(item["rowCount"])
            for item in paused_status.get("clickhouseOffsets") or []
        )
        paused_revision = int(
            live_repository.get_freshness(output_dataset_id).latest_revision or 0
        )
        client.insert_json_rows(
            settings.clickhouse_database,
            producer_table,
            ["message"],
            [["1500 1"]],
        )
        time.sleep(0.5)
        still_paused = gateway.manage(
            service.repository.get_job(job_id),
            service.repository.get_run(service.repository.get_job(job_id).active_run_id),
            "status",
        )
        if sum(int(item["rowCount"]) for item in still_paused.get("clickhouseOffsets") or []) != paused_input_count:
            raise RuntimeError("ClickHouse consumed Kafka rows while the Job was paused")
        unchanged_freshness = live_repository.get_freshness(output_dataset_id)
        if int(unchanged_freshness.latest_revision or 0) != paused_revision:
            raise RuntimeError("Catalog revision advanced while the Job was paused")
        service.command(
            job_id,
            ContinuousSqlCommandRequest(
                command="resume", commandId=f"resume-{suffix}"
            ),
            actor,
        )

        warm_latencies_ms: list[float] = []
        expected_input_count = 4
        expected_joined_count = 3
        status_payload, _ = wait_for_worker_rows(
            gateway,
            service.repository,
            job_id,
            expected_input_count,
            timeout_seconds=10,
        )
        latest_revision = reconcile_until_revision(
            service,
            live_repository,
            job_id,
            actor,
            paused_revision,
        )
        resumed_runtime = dashboard_service.get_published_runtime(dashboard_id, actor)
        if widget_count(first_widget(resumed_runtime)) != expected_joined_count:
            raise RuntimeError("Dashboard did not refresh the Kafka row queued during pause")
        for index in range(10):
            event_started = time.perf_counter()
            client.insert_json_rows(
                settings.clickhouse_database,
                producer_table,
                ["message"],
                [[f"{2000 + index} {1 + (index % 2)}"]],
            )
            expected_input_count += 1
            expected_joined_count += 1
            status_payload, _ = wait_for_worker_rows(
                gateway,
                service.repository,
                job_id,
                expected_input_count,
                timeout_seconds=10,
            )
            latest_revision = reconcile_until_revision(
                service,
                live_repository,
                job_id,
                actor,
                latest_revision,
            )
            published_runtime = dashboard_service.get_published_runtime(
                dashboard_id, actor
            )
            published_widget = first_widget(published_runtime)
            if widget_count(published_widget) != expected_joined_count:
                raise RuntimeError(
                    "Published dashboard widget did not refresh to the latest JOIN rows"
                )
            warm_latencies_ms.append(
                (time.perf_counter() - event_started) * 1000
            )

        output = qualified_clickhouse_table(
            settings.clickhouse_database, output_table
        )
        client.execute(f"INSERT INTO {output} SELECT * FROM {output} FINAL LIMIT 1")
        raw_count = int(
            client.query(f"SELECT count() AS value FROM {output}").rows[0][0]
        )
        deduplicated_count = int(
            client.query(f"SELECT count() AS value FROM {output} FINAL").rows[0][0]
        )
        if (
            raw_count <= deduplicated_count
            or deduplicated_count != expected_joined_count
        ):
            raise RuntimeError(
                "ReplacingMergeTree offset identity did not remove the duplicate"
            )

        widget_cases = {
            "metric": {"aggregation": "sum", "valueKey": "event_id"},
            "table": {"columns": ["event_id", "user_name"], "limit": 20},
            "bar_chart": {
                "aggregation": "sum",
                "xKey": "user_name",
                "yKey": "event_id",
            },
            "line_chart": {
                "aggregation": "count",
                "xKey": "event_id",
                "yKey": "event_id",
                "seriesKey": "user_name",
            },
            "area_chart": {
                "aggregation": "count",
                "xKey": "event_id",
                "yKey": "event_id",
                "seriesKey": "user_name",
            },
            "donut_chart": {
                "aggregation": "sum",
                "labelKey": "user_name",
                "valueKey": "event_id",
            },
            "pie_chart": {
                "aggregation": "sum",
                "labelKey": "user_name",
                "valueKey": "event_id",
            },
            "radial_bar_chart": {
                "aggregation": "avg",
                "labelKey": "user_name",
                "valueKey": "event_id",
            },
            "heatmap_chart": {
                "aggregation": "count",
                "xKey": "user_name",
                "yKey": "event_id",
                "valueKey": "event_id",
            },
            "treemap_chart": {
                "aggregation": "sum",
                "labelKey": "user_name",
                "valueKey": "event_id",
            },
        }
        all_widgets_session = DashboardDatasetQuerySession(
            catalog.get_dataset_payload(output_dataset_id)
        )
        try:
            for widget_type, config in widget_cases.items():
                result = all_widgets_session.read_widget(widget_type, config)
                if not result["data"]:
                    raise RuntimeError(
                        f"ClickHouse dashboard widget returned no data: {widget_type}"
                    )
        finally:
            all_widgets_session.close()

        ordered_latencies = sorted(warm_latencies_ms)
        p95_index = max(0, int(len(ordered_latencies) * 0.95 + 0.999) - 1)
        freshness = live_repository.get_freshness(output_dataset_id)
        return {
            "ok": True,
            "flow": {
                "continuousSqlJobCreated": True,
                "kafkaConsumerStarted": True,
                "catalogDatasetPublished": True,
                "dashboardCreated": True,
                "joinedWidgetPublished": True,
                "liveWidgetRefreshed": True,
                "pauseResumeVerified": True,
            },
            "jobId": job_id,
            "dashboardId": dashboard_id,
            "widgetId": published_widget.id,
            "topic": topic,
            "kafkaResetMode": "fresh unique topic + fixture replay",
            "staticSnapshotMode": (
                "live MinIO S3/Iceberg exact snapshot via Trino"
                if live_static_snapshot
                else "bounded fixture Trino response"
            ),
            "staticSnapshotId": static_snapshot_id,
            "staticStorageLocation": static_storage_location,
            "inputRowCount": expected_input_count,
            "rowCount": deduplicated_count,
            "rawRowCountAfterDuplicate": raw_count,
            "catalogRevision": int(freshness.latest_revision or 0),
            "verifiedWidgetTypes": sorted(widget_cases),
            "joinLatencyMs": round((joined_at - events_published_at) * 1000, 2),
            "catalogPublicationLatencyMs": round(
                (catalog_published_at - events_published_at) * 1000, 2
            ),
            "dashboardReadyLatencyMs": round(
                (dashboard_ready_at - events_published_at) * 1000, 2
            ),
            "warmEndToEndP50Ms": round(
                statistics.median(ordered_latencies), 2
            ),
            "warmEndToEndP95Ms": round(ordered_latencies[p95_index], 2),
            "warmEndToEndSamplesMs": [
                round(value, 2) for value in warm_latencies_ms
            ],
            "setupLatencyMs": round(
                (events_published_at - started) * 1000, 2
            ),
            "offsets": status_payload.get("clickhouseOffsets"),
            "widget": published_widget.model_dump(
                by_alias=True, mode="json"
            ),
        }
    finally:
        if job_id:
            try:
                service.command(
                    job_id,
                    ContinuousSqlCommandRequest(
                        command="stop", commandId=f"stop-{suffix}"
                    ),
                    actor,
                )
            except Exception:
                pass
        for table in (
            producer_table,
            output_table,
            runtime_names["raw"] if runtime_names else "",
            clickhouse_static_runtime_table(
                runtime_names["prefix"], 1, {"snapshotId": static_snapshot_id}
            ) if runtime_names else "",
        ):
            if not table:
                continue
            try:
                client.execute(
                    f"DROP TABLE IF EXISTS "
                    f"{qualified_clickhouse_table(settings.clickhouse_database, table)}"
                )
            except Exception:
                pass
        client.close()
        if live_static_created:
            try:
                drop_live_static_snapshot(trino_client, static_name)
            except Exception:
                pass
        try:
            cleanup_database(
                db,
                dashboard_id=dashboard_id,
                job_id=job_id,
                dataset_ids=[
                    stream_dataset_id,
                    static_dataset_id,
                    output_dataset_id,
                ],
            )
        finally:
            db.close()
            engine.dispose()
        subprocess.run(
            ["docker", "exec", redpanda_container, "rpk", "topic", "delete", topic],
            check=False,
            capture_output=True,
            text=True,
        )


if __name__ == "__main__":
    print(json.dumps(run(), ensure_ascii=False, indent=2))
