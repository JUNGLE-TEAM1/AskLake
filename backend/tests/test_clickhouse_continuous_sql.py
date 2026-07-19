import json
import unittest
from unittest.mock import patch

import httpx
from sqlalchemy import create_engine
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.models.base import Base
from app.models.continuous_sql import ContinuousSqlJobModel, ContinuousSqlRunModel
from app.realtime.domain.source_boundary import PartitionBoundary, SourceBoundary
from app.realtime.sql.clickhouse_compiler import ClickHouseRealtimeCompiler
from app.repositories.catalog_repository import CatalogRepository
from app.repositories.continuous_sql_repository import ContinuousSqlRepository
from app.repositories.dashboard_live_repository import (
    DashboardLiveRepository,
    ensure_dashboard_live_schema,
)
from app.repositories.realtime_event_repository import ensure_realtime_event_schema
from app.schemas.continuous_sql import ContinuousSqlOutput
from app.schemas.trino import TrinoClientPage
from app.services.clickhouse_client import ClickHouseClient, ClickHouseError, ClickHouseRows
from app.services.clickhouse_continuous_publication import (
    ClickHouseContinuousSqlPublicationService,
)
from app.services.clickhouse_continuous_sql import (
    ClickHouseContinuousSqlWorkerGateway,
    clickhouse_ingest_materialized_view_ddl,
    clickhouse_kafka_table_ddl,
    clickhouse_raw_table_ddl,
    clickhouse_static_table_ddl,
    clickhouse_static_runtime_table,
    continuous_sql_static_join_columns,
    replace_runtime_table,
    referenced_relation_schema,
    clickhouse_runtime_sql,
    clickhouse_type,
)
from app.services.clickhouse_realtime_v2 import (
    ClickHouseRealtimeV2WorkerGateway,
    build_realtime_v2_plan,
    realtime_v2_connector_name,
    realtime_v2_dimension_version_id,
    realtime_v2_dimension_versions,
    realtime_v2_dlq_topic,
    realtime_v2_schema_fingerprint,
)
from app.services.clickhouse_realtime_v2_support import upsert_realtime_v2_catalog_dataset
from app.services.continuous_sql_gateway import RoutedContinuousSqlWorkerGateway
from app.services.dashboard_physical_data import DashboardDatasetQuerySession


@compiles(JSONB, "sqlite")
def compile_jsonb_for_sqlite(_type, _compiler, **_kwargs):
    return "JSON"


class FakeDashboardClickHouseClient:
    def __init__(self) -> None:
        self.queries: list[str] = []
        self.closed = False

    def query(self, query: str, **_kwargs) -> ClickHouseRows:
        self.queries.append(query)
        if query.startswith("DESCRIBE TABLE"):
            return ClickHouseRows(
                columns=["name", "type"],
                rows=[["event_id", "Nullable(Int64)"], ["user_name", "Nullable(String)"]],
            )
        return ClickHouseRows(
            columns=["user_name", "__asklake_widget_value"],
            rows=[["Alice", 2], ["Bob", 1]],
        )

    def close(self) -> None:
        self.closed = True


class FakeContinuousStatusClient:
    def __init__(
        self,
        *,
        consumer_error: str = "",
        consumer_ready: bool = True,
        last_exception_ms: int = 0,
        last_poll_ms: int = 0,
    ) -> None:
        self.consumer_error = consumer_error
        self.consumer_ready = consumer_ready
        self.last_exception_ms = last_exception_ms
        self.last_poll_ms = last_poll_ms

    def query(self, query: str, **_kwargs) -> ClickHouseRows:
        if "FROM system.tables" in query:
            return ClickHouseRows(
                columns=["name"],
                rows=[
                    ["asklake_1a82dae6b2097fb1_kafka"],
                    ["asklake_1a82dae6b2097fb1_raw"],
                    ["asklake_1a82dae6b2097fb1_ingest_mv"],
                    ["asklake_1a82dae6b2097fb1_join_mv"],
                    ["joined_events"],
                ],
            )
        if "FROM system.kafka_consumers" in query:
            return ClickHouseRows(
                columns=["is_currently_used", "num_messages_read", "exception_text", "last_poll_ms", "last_exception_ms"],
                rows=[[
                    self.consumer_ready,
                    3,
                    self.consumer_error,
                    self.last_poll_ms,
                    self.last_exception_ms,
                ]],
            )
        if "GROUP BY kafka_partition" in query:
            return ClickHouseRows(columns=[], rows=[])
        if "count() AS row_count" in query:
            return ClickHouseRows(columns=["row_count"], rows=[[0]])
        raise AssertionError(query)


class FakeRoutedGateway:
    def __init__(self, name: str) -> None:
        self.name = name
        self.calls: list[str] = []

    def manage(self, _job, _run, action: str, _options=None):
        self.calls.append(action)
        return {"gateway": self.name, "containerState": "running"}


class ClickHouseContinuousSqlTests(unittest.TestCase):
    def test_v2_catalog_waits_for_first_publication(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:")
        Base.metadata.create_all(engine)
        job = self._job()
        run = ContinuousSqlRunModel(
            run_id="v2-run",
            job_id=job.id,
            generation=1,
            fencing_token="fence",
            plan_hash=job.plan_hash,
            status="running",
            static_bindings=[{"datasetId": "dataset-users", "snapshotId": "77"}],
            checkpoint_path="clickhouse://asklake/v2",
        )
        plan = build_realtime_v2_plan(
            job,
            run,
            dimension_version_ids=realtime_v2_dimension_versions(job, run),
            database="asklake_realtime_v2",
        )
        with Session(engine) as db:
            upsert_realtime_v2_catalog_dataset(
                db,
                job,
                plan,
                published=False,
                version_id="pipeline-v2",
                binding_epoch=1,
                updated_at="2026-07-19T00:00:00+00:00",
                database="asklake_realtime_v2",
                serving_view="serving_current_v2",
            )
            db.flush()
            payload = CatalogRepository(db).get_dataset_payload(job.output_dataset_id)

        self.assertEqual(payload["status"], "preparing")
        self.assertEqual(payload["physicalBindings"][0]["status"], "pending")
        engine.dispose()

    def test_v2_owner_routes_clickhouse_jobs_to_v2_gateway(self) -> None:
        v1 = FakeRoutedGateway("v1")
        v2 = FakeRoutedGateway("v2")
        iceberg = FakeRoutedGateway("iceberg")
        configured = Settings(
            _env_file=None,
            app_env="test",
            continuous_sql_join_enabled=True,
            clickhouse_realtime_v2_enabled=True,
            kafka_connect_sink_enabled=True,
            clickhouse_realtime_consumer_owner="kafka_connect_v2",
            kafka_connect_url="http://connect.internal:8083",
        )
        gateway = RoutedContinuousSqlWorkerGateway(
            configured,
            iceberg_gateway=iceberg,
            clickhouse_gateway=v1,
            clickhouse_v2_gateway=v2,
        )

        result = gateway.manage(self._job(), None, "status")

        self.assertEqual(result["gateway"], "v2")
        self.assertEqual(v2.calls, ["status"])
        self.assertEqual(v1.calls, [])

    def test_v2_plan_compiles_existing_continuous_sql_contract(self) -> None:
        job = self._job()
        run = ContinuousSqlRunModel(
            run_id="v2-run",
            job_id=job.id,
            generation=1,
            fencing_token="fence",
            plan_hash=job.plan_hash,
            status="running",
            static_bindings=[{"datasetId": "dataset-users", "snapshotId": "77"}],
            checkpoint_path="clickhouse://asklake/v2",
        )
        dimensions = realtime_v2_dimension_versions(job, run)
        plan = build_realtime_v2_plan(
            job,
            run,
            dimension_version_ids=dimensions,
            database="asklake_realtime_v2",
        )
        compiled = ClickHouseRealtimeCompiler().compile(
            plan,
            boundary=SourceBoundary.build((
                PartitionBoundary("events", 0, -1, 2),
            )),
            serving_database="asklake_realtime_v2",
            serving_table="serving_events_v2",
            serving_dataset_id=job.output_dataset_id,
            pipeline_version_id="pipeline-v2",
            pipeline_generation=1,
        )

        self.assertEqual(plan.relations[0].physical_table, "raw_events_v2_current")
        self.assertEqual(plan.relations[1].physical_table, "dimension_current_v2_latest")
        self.assertIn("serving_events_v2", compiled.insert_sql)
        self.assertIn("raw_events_v2_current", compiled.insert_sql)
        for metadata in (
            "kafka_partition",
            "kafka_offset",
            "kafka_timestamp",
        ):
            self.assertGreaterEqual(compiled.select_sql.count(metadata), 2)

    def test_v2_connector_identity_and_dlq_are_job_scoped_and_bounded(self) -> None:
        first = realtime_v2_connector_name("asklake-clickhouse-realtime-v2", "events-1")
        second = realtime_v2_connector_name("asklake-clickhouse-realtime-v2", "events-2")
        dlq = realtime_v2_dlq_topic("x" * 249)

        self.assertNotEqual(first, second)
        self.assertEqual(
            first,
            realtime_v2_connector_name("asklake-clickhouse-realtime-v2", "events-1"),
        )
        self.assertLessEqual(len(first), 128)
        self.assertLessEqual(len(dlq), 249)
        self.assertTrue(dlq.endswith(".dlq"))

    def test_v2_long_schema_descriptor_is_stored_as_bounded_fingerprint(self) -> None:
        descriptor = "|".join(
            f"field_{index}:String:nullable:included" for index in range(20)
        )

        fingerprint = realtime_v2_schema_fingerprint(descriptor)
        version_id = realtime_v2_dimension_version_id("products", "77", descriptor)

        self.assertEqual(len(fingerprint), 64)
        self.assertTrue(all(character in "0123456789abcdef" for character in fingerprint))
        self.assertEqual(
            version_id,
            realtime_v2_dimension_version_id("products", "77", fingerprint),
        )

    def test_v2_status_repairs_a_missing_control_plane_before_materializing(self) -> None:
        class RepairingGateway(ClickHouseRealtimeV2WorkerGateway):
            def __init__(self) -> None:
                super().__init__(Settings(_env_file=None, app_env="test"))
                self.provisioned = False

            def _control_plane_ready(self, _job, _run) -> bool:
                return self.provisioned

            def _provision(self, _job, _run) -> None:
                self.provisioned = True

            def _status(self, _job, _run):
                return {"containerState": "running"}

        job = self._job()
        run = ContinuousSqlRunModel(
            run_id="v2-repair-run",
            job_id=job.id,
            generation=1,
            fencing_token="repair-fence",
            plan_hash=job.plan_hash,
            status="starting",
            static_bindings=[],
            checkpoint_path="clickhouse://asklake/v2-repair",
        )
        gateway = RepairingGateway()

        result = gateway.manage(job, run, "status")

        self.assertTrue(gateway.provisioned)
        self.assertEqual(result["containerState"], "running")

    def test_v2_dimension_snapshot_is_published_in_bounded_batches(self) -> None:
        class PagedTrino:
            def __init__(self) -> None:
                self.queries: list[str] = []

            def submit(self, query: str, **_kwargs) -> TrinoClientPage:
                self.queries.append(query)
                if "count(*)" in query:
                    return TrinoClientPage(queryId="count", rows=[[3]])
                return TrinoClientPage(
                    queryId="rows",
                    rows=[[1, "Alice"], [2, "Bob"]],
                    nextUri="http://trino:8080/v1/statement/rows/1",
                )

            def fetch(self, _next_uri: str, **_kwargs) -> TrinoClientPage:
                return TrinoClientPage(queryId="rows", rows=[[3, "Carol"]])

        class BatchedClickHouse:
            def __init__(self) -> None:
                self.batch_sizes: list[int] = []

            def insert_json_rows(self, _database, _table, _columns, rows) -> int:
                materialized = list(rows)
                self.batch_sizes.append(len(materialized))
                return len(materialized)

        job = self._job()
        trino = PagedTrino()
        clickhouse = BatchedClickHouse()
        gateway = ClickHouseRealtimeV2WorkerGateway(
            Settings(_env_file=None, app_env="test"),
            trino_client=trino,  # type: ignore[arg-type]
        )

        with patch("app.services.clickhouse_realtime_v2._DIMENSION_INSERT_BATCH_ROWS", 2):
            evidence = gateway._publish_dimension_snapshot(
                clickhouse,  # type: ignore[arg-type]
                job,
                job.relation_bindings[1],
                {"snapshotId": "77"},
                version_id="dimension-v77",
            )

        self.assertEqual(clickhouse.batch_sizes, [2, 1])
        self.assertEqual(evidence.row_count, 3)
        self.assertEqual(len(evidence.checksum), 64)
        self.assertIn('ORDER BY "id"', trino.queries[-1])

    def test_output_contract_is_additive_and_keeps_iceberg_default(self) -> None:
        iceberg = ContinuousSqlOutput.model_validate({
            "datasetId": "dataset-output",
            "datasetName": "output",
            "storagePath": "s3a://lake/output",
            "icebergTarget": {
                "catalog": "iceberg",
                "namespace": "asklake",
                "table": "output",
                "writeMode": "append",
            },
        })
        clickhouse = ContinuousSqlOutput.model_validate({
            "datasetId": "dataset-hot",
            "datasetName": "hot",
            "servingMode": "clickhouse",
            "clickhouseTarget": {
                "database": "asklake",
                "table": "hot_join",
            },
        })

        self.assertEqual(iceberg.serving_mode, "iceberg")
        self.assertEqual(clickhouse.clickhouse_target.table_uri, "clickhouse://asklake/hot_join")

    def test_clickhouse_runtime_sql_preserves_join_and_maps_kafka_metadata(self) -> None:
        query = clickhouse_runtime_sql(
            "SELECT e.event_id, u.name AS user_name, "
            "e.kafka_timestamp AS kafka_timestamp, "
            "e.kafka_partition AS kafka_partition, "
            "e.kafka_offset AS kafka_offset, e.ingested_at AS ingested_at "
            "FROM `__asklake_relation_0` e "
            "LEFT JOIN `__asklake_relation_1` u ON e.user_id = u.id",
            stream_relation={"runtimeView": "__asklake_relation_0", "alias": "e"},
            database="asklake",
            kafka_table="events_kafka",
            static_tables={"__asklake_relation_1": "users_static"},
            output_schema=[["event_id", "long"], ["user_name", "string"]],
        )

        self.assertIn('FROM "asklake"."events_kafka" AS e', query)
        self.assertIn('LEFT JOIN "asklake"."users_static" AS u', query)
        self.assertIn("e._offset AS kafka_offset", query)
        self.assertIn("now64(3) AS ingested_at", query)
        self.assertIn('e.event_id AS "event_id"', query)
        self.assertIn('u.name AS "user_name"', query)
        self.assertNotIn('AS user_name AS "user_name"', query)
        self.assertEqual(clickhouse_type("bigint", nullable=True), "Nullable(Int64)")

    def test_runtime_table_replacement_does_not_match_relation_name_prefix(self) -> None:
        query = (
            "SELECT * FROM `__asklake_relation_1` a "
            "JOIN `__asklake_relation_10` b ON a.id = b.id"
        )

        replaced = replace_runtime_table(
            query,
            "__asklake_relation_1",
            "`asklake`.`static_one`",
        )

        self.assertIn("`asklake`.`static_one` a", replaced)
        self.assertIn("`__asklake_relation_10` b", replaced)

    def test_kafka_ddl_uses_dedicated_group_and_low_latency_settings(self) -> None:
        job = self._job()
        ddl = clickhouse_kafka_table_ddl(
            job,
            job_target(job),
            "events_kafka",
            job.relation_bindings[0],
        )

        self.assertIn("kafka_group_name = 'asklake_clickhouse_", ddl)
        self.assertIn("`_raw_message` String", ddl)
        self.assertIn("kafka_format = 'RawBLOB'", ddl)
        self.assertIn("kafka_commit_every_batch = 1", ddl)
        self.assertIn("kafka_poll_timeout_ms = 100", ddl)
        raw_ddl = clickhouse_raw_table_ddl(
            "asklake", "events_raw", job.relation_bindings[0]
        )
        ingest_ddl = clickhouse_ingest_materialized_view_ddl(
            "asklake",
            "events_ingest_mv",
            "events_kafka",
            "events_raw",
            job.relation_bindings[0],
        )
        self.assertIn("ReplacingMergeTree", raw_ddl)
        self.assertIn("_offset AS kafka_offset", ingest_ddl)
        self.assertIn("TO `asklake`.`events_raw`", ingest_ddl)

    def test_whitespace_kafka_ingest_uses_saved_parsing_contract(self) -> None:
        stream = {
            "schema": [["event_time", "timestamp"], ["event_id", "long"], ["user_id", "string"]],
            "streamingSource": {
                "recordParsing": {
                    "enabled": True,
                    "delimiterKind": "whitespace",
                    "delimiterPattern": "\\s+",
                    "header": False,
                    "expectedFieldCount": 3,
                    "columns": [
                        {"position": 0, "name": "time"},
                        {"position": 1, "name": "event"},
                        {"position": 2, "name": "user"},
                    ],
                },
                "schemaColumns": [
                    {"included": True, "sourceName": "time", "targetName": "event_time"},
                    {"included": True, "sourceName": "event", "targetName": "event_id"},
                    {"included": True, "sourceName": "user", "targetName": "user_id"},
                ],
            },
        }

        ddl = clickhouse_ingest_materialized_view_ddl(
            "asklake", "events_ingest_mv", "events_kafka", "events_raw", stream
        )

        self.assertIn("splitByRegexp('\\\\s+'", ddl)
        self.assertIn("parseDateTime64BestEffortOrNull", ddl)
        self.assertIn("_record_fields[2]", ddl)
        self.assertIn("throwIf(length(_record_fields) != 3", ddl)

    def test_json_kafka_ingest_supports_nested_source_paths(self) -> None:
        stream = {
            "schema": [["event_id", "long"], ["user_id", "string"]],
            "streamingSource": {
                "recordParsing": {},
                "schemaColumns": [
                    {"sourceName": "raw.event_id", "targetName": "event_id"},
                    {"sourceName": "raw.user_id", "targetName": "user_id"},
                ],
            },
        }

        ddl = clickhouse_ingest_materialized_view_ddl(
            "asklake", "events_ingest_mv", "events_kafka", "events_raw", stream
        )

        self.assertIn("JSON_VALUE(_raw_message, '$.\"raw\".\"event_id\"')", ddl)
        self.assertIn("isValidJSON(_raw_message)", ddl)

    def test_static_snapshot_table_is_scoped_and_only_referenced_columns_are_loaded(self) -> None:
        relation = {
            "schema": [["id", "bigint"], ["name", "string"], ["unused", "string"]],
            "referencedColumns": ["id", "name"],
        }

        self.assertEqual(referenced_relation_schema(relation), [("id", "bigint"), ("name", "string")])
        first = clickhouse_static_runtime_table("asklake_prefix", 1, {"snapshotId": "101"})
        replay = clickhouse_static_runtime_table("asklake_prefix", 1, {"snapshotId": "101"})
        changed = clickhouse_static_runtime_table("asklake_prefix", 1, {"snapshotId": "102"})
        self.assertEqual(first, replay)
        self.assertNotEqual(first, changed)
        ddl = clickhouse_static_table_ddl(
            "asklake",
            first,
            referenced_relation_schema(relation),
            order_by=["id"],
        )
        self.assertIn("ORDER BY (`id`)", ddl)
        self.assertIn("SETTINGS allow_nullable_key = 1", ddl)

    def test_compiled_static_join_key_is_used_for_runtime_exact_verification(self) -> None:
        job = self._job()
        self.assertEqual(
            continuous_sql_static_join_columns(job, "dataset-users"),
            ["id"],
        )

        class DuplicateStaticClient:
            def query(self, query: str, **_kwargs) -> ClickHouseRows:
                self.query_text = query
                return ClickHouseRows(
                    columns=["total_rows", "invalid_key_rows", "distinct_keys"],
                    rows=[[3, 0, 2]],
                )

        client = DuplicateStaticClient()
        with self.assertRaises(ClickHouseError) as caught:
            ClickHouseContinuousSqlWorkerGateway._verify_static_unique_key(
                client,
                "asklake",
                "users_static",
                ["id"],
            )
        self.assertEqual(caught.exception.code, "CLICKHOUSE_STATIC_KEY_NOT_UNIQUE")
        self.assertIn("uniqExact(tuple(`id`))", client.query_text)

    def test_status_reports_kafka_consumer_failure_instead_of_false_running(self) -> None:
        job = self._job()
        gateway = ClickHouseContinuousSqlWorkerGateway(Settings(_env_file=None, app_env="test"))
        worker = gateway._status(
            FakeContinuousStatusClient(consumer_error="Cannot parse Kafka message"),
            job,
            job_target(job),
        )

        self.assertEqual(worker["containerState"], "failed")
        self.assertEqual(worker["lastErrorCode"], "CLICKHOUSE_KAFKA_CONSUMER_ERROR")
        self.assertIn("Cannot parse", worker["lastErrorMessage"])

    def test_status_ignores_consumer_exception_after_a_new_successful_poll(self) -> None:
        job = self._job()
        gateway = ClickHouseContinuousSqlWorkerGateway(Settings(_env_file=None, app_env="test"))
        worker = gateway._status(
            FakeContinuousStatusClient(
                consumer_error="Temporary broker error",
                last_exception_ms=100,
                last_poll_ms=200,
            ),
            job,
            job_target(job),
        )

        self.assertEqual(worker["containerState"], "running")
        self.assertIsNone(worker["lastErrorCode"])

    def test_http_client_parses_json_rows_without_driver_dependency(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            self.assertIn("FORMAT JSON", request.content.decode("utf-8"))
            return httpx.Response(
                200,
                json={
                    "meta": [{"name": "value", "type": "UInt64"}],
                    "data": [{"value": 7}],
                },
            )

        client = ClickHouseClient(
            Settings(_env_file=None, app_env="test"),
            transport=httpx.MockTransport(handler),
        )
        try:
            result = client.query("SELECT 7 AS value")
        finally:
            client.close()
        self.assertEqual(result.columns, ["value"])
        self.assertEqual(result.rows, [[7]])

    def test_v2_reader_uses_dedicated_endpoint_database_and_identity(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            self.assertEqual(request.url.host, "clickhouse-v2")
            self.assertEqual(request.url.params["database"], "asklake_realtime_v2")
            self.assertTrue(request.headers.get("authorization", "").startswith("Basic "))
            return httpx.Response(
                200,
                json={
                    "meta": [{"name": "ok", "type": "UInt8"}],
                    "data": [{"ok": 1}],
                },
            )

        configured = Settings(
            _env_file=None,
            app_env="test",
            clickhouse_v2_url="https://clickhouse-v2:8443",
            clickhouse_v2_database="asklake_realtime_v2",
            clickhouse_v2_reader_user="asklake_v2_reader",
            clickhouse_v2_reader_password="reader-secret",
        )
        client = ClickHouseClient.realtime_v2_reader(
            configured,
            transport=httpx.MockTransport(handler),
        )
        try:
            self.assertTrue(client.ping())
        finally:
            client.close()

    def test_dashboard_query_uses_clickhouse_final_and_existing_widget_contract(self) -> None:
        client = FakeDashboardClickHouseClient()
        session = DashboardDatasetQuerySession(
            {
                "id": "dataset-hot",
                "name": "hot",
                "schema": [["event_id", "long"], ["user_name", "string"]],
                "storageFormat": "clickhouse",
                "clickhouseTable": {"database": "asklake", "table": "hot_join"},
            },
            clickhouse_client=client,
        )
        try:
            result = session.read_widget(
                "bar_chart",
                {"xKey": "user_name", "aggregation": "count"},
            )
        finally:
            session.close()

        self.assertEqual(result["data"][0]["user_name"], "Alice")
        self.assertTrue(any("FINAL" in query for query in client.queries))
        self.assertTrue(client.closed)

    def test_offset_progress_publishes_catalog_revision_idempotently(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:")
        Base.metadata.create_all(engine)
        db = Session(engine)
        try:
            ensure_dashboard_live_schema(db)
            ensure_realtime_event_schema(db)
            repository = ContinuousSqlRepository(db)
            job = self._job()
            run = ContinuousSqlRunModel(
                run_id="clickhouse-run-1",
                job_id=job.id,
                generation=1,
                fencing_token="fence",
                plan_hash=job.plan_hash,
                status="running",
                static_bindings=[{"datasetId": "dataset-users", "snapshotId": "101"}],
                checkpoint_path=job.checkpoint_path,
                started_at="2026-07-17T00:00:00+00:00",
            )
            repository.add_job(job)
            repository.add_run(run)
            db.commit()
            service = ClickHouseContinuousSqlPublicationService(db)
            worker = {
                "clickhouseOutputRowCount": 2,
                "clickhouseOffsets": [{
                    "partition": 0,
                    "minOffset": 4,
                    "maxOffset": 6,
                    "rowCount": 3,
                    "latestIngestedAt": "2026-07-17 00:00:01.000",
                }],
            }

            first = service.reconcile_progress(job, run, worker)
            replay = service.reconcile_progress(job, run, worker)
            payload = CatalogRepository(db).get_dataset_payload(job.output_dataset_id)
            live_repository = DashboardLiveRepository(db, ensure_schema=False)
            freshness = live_repository.get_freshness(job.output_dataset_id)
            continuous_job = live_repository.continuous_job_by_dataset(
                job.output_dataset_id
            )

            self.assertEqual(first.stage, "dashboard_ready")
            self.assertEqual(replay.id, first.id)
            self.assertEqual(payload["storageFormat"], "clickhouse")
            self.assertEqual(payload["clickhouseTable"]["table"], "joined_events")
            self.assertEqual(payload["rows"], "2")
            self.assertEqual(int(freshness.latest_revision), 1)
            self.assertEqual(continuous_job.id, job.id)
            self.assertEqual(
                continuous_job.continuous_config["triggerIntervalSeconds"],
                1,
            )
        finally:
            db.close()
            engine.dispose()

    @staticmethod
    def _job() -> ContinuousSqlJobModel:
        return ContinuousSqlJobModel(
            id="clickhouse-job",
            name="ClickHouse JOIN",
            owner="owner",
            created_by="owner",
            original_sql="SELECT e.event_id, u.name AS user_name FROM events e LEFT JOIN users u ON e.user_id = u.id",
            normalized_sql="SELECT e.event_id, u.name AS user_name FROM events e LEFT JOIN users u ON e.user_id = u.id",
            plan_version="continuous-sql-v1",
            plan_hash="plan-hash",
            compiled_plan={
                "runtimeSql": "SELECT e.event_id, u.name AS user_name FROM `__asklake_relation_0` e LEFT JOIN `__asklake_relation_1` u ON e.user_id = u.id",
                "outputSchema": [["event_id", "long"], ["user_name", "string"]],
                "streamingSource": {"broker": "redpanda:9092", "topic": "events"},
                "servingMode": "clickhouse",
                "joins": [{
                    "type": "LEFT",
                    "rightAlias": "u",
                    "rightDatasetId": "dataset-users",
                    "keys": [{
                        "leftAlias": "e",
                        "leftColumn": "user_id",
                        "rightAlias": "u",
                        "rightColumn": "id",
                    }],
                }],
            },
            relation_bindings=[
                {
                    "alias": "e",
                    "runtimeView": "__asklake_relation_0",
                    "datasetId": "dataset-events",
                    "datasetName": "events",
                    "mode": "streaming",
                    "queryEngineTable": {"catalog": "iceberg", "schema": "asklake", "table": "events", "format": "iceberg"},
                    "schema": [["event_id", "bigint"], ["user_id", "bigint"]],
                    "schemaFingerprint": "events-v1",
                    "streamingSource": {"broker": "redpanda:9092", "topic": "events"},
                },
                {
                    "alias": "u",
                    "runtimeView": "__asklake_relation_1",
                    "datasetId": "dataset-users",
                    "datasetName": "users",
                    "mode": "static",
                    "queryEngineTable": {"catalog": "iceberg", "schema": "asklake", "table": "users", "format": "iceberg"},
                    "schema": [["id", "bigint"], ["name", "string"]],
                    "schemaFingerprint": "users-v1",
                },
            ],
            static_binding_policy="PINNED_AT_START",
            trigger_interval_seconds=1,
            checkpoint_path="clickhouse://asklake/joined_events/_consumer",
            output_dataset_id="dataset-joined-events",
            output_dataset_name="joined_events",
            output_layer="GOLD",
            output_storage_path="clickhouse://asklake/joined_events",
            output_target={
                "engine": "clickhouse",
                "database": "asklake",
                "table": "joined_events",
            },
            desired_state="running",
            observed_state="running",
            generation=1,
            fencing_token="fence",
            active_run_id="clickhouse-run-1",
        )


def job_target(job: ContinuousSqlJobModel):
    from app.schemas.continuous_sql import ClickHouseWriterTarget

    return ClickHouseWriterTarget.model_validate(job.output_target)


if __name__ == "__main__":
    unittest.main()
