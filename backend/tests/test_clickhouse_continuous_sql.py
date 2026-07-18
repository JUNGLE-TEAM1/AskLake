import json
import unittest

import httpx
from sqlalchemy import create_engine
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.models.base import Base
from app.models.continuous_sql import ContinuousSqlJobModel, ContinuousSqlRunModel
from app.repositories.catalog_repository import CatalogRepository
from app.repositories.continuous_sql_repository import ContinuousSqlRepository
from app.repositories.dashboard_live_repository import (
    DashboardLiveRepository,
    ensure_dashboard_live_schema,
)
from app.repositories.realtime_event_repository import ensure_realtime_event_schema
from app.schemas.continuous_sql import ContinuousSqlOutput
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
from app.services.clickhouse_static_snapshot_cache import (
    ClickHouseStaticSnapshotCache,
    static_snapshot_cache_identity,
)
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
                rows=[
                    ["event_id", "Nullable(Int64)"],
                    ["user_name", "Nullable(String)"],
                    ["event_time", "Nullable(DateTime64(3))"],
                    ["event_type", "Nullable(String)"],
                ],
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


class ClickHouseContinuousSqlTests(unittest.TestCase):
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
                self.queries = getattr(self, "queries", []) + [query]
                if "invalid_key_rows" in query:
                    return ClickHouseRows(columns=["invalid_key_rows"], rows=[[0]])
                return ClickHouseRows(columns=["duplicate_found"], rows=[[1]])

        client = DuplicateStaticClient()
        cache = ClickHouseStaticSnapshotCache(
            Settings(_env_file=None, app_env="test"),
            object(),
        )
        with self.assertRaises(ClickHouseError) as caught:
            cache._verify_static_unique_key(
                client,
                "asklake",
                "users_static",
                ["id"],
                total_rows=3,
            )
        self.assertEqual(caught.exception.code, "CLICKHOUSE_STATIC_KEY_NOT_UNIQUE")
        self.assertTrue(any("GROUP BY `id`" in query for query in client.queries))
        self.assertTrue(any("optimize_aggregation_in_order = 1" in query for query in client.queries))
        self.assertTrue(any("max_memory_usage = 536870912" in query for query in client.queries))
        self.assertFalse(any("uniqExact" in query for query in client.queries))

    def test_verified_static_snapshot_cache_is_reused_across_job_prefixes(self) -> None:
        relation = self._job().relation_bindings[1]
        binding = {"datasetId": "dataset-users", "snapshotId": "101"}
        identity = static_snapshot_cache_identity(relation, binding, ["id"])
        self.assertEqual(
            identity,
            static_snapshot_cache_identity(relation, binding, ["id"]),
        )
        self.assertNotEqual(
            clickhouse_static_runtime_table("asklake_first", 1, binding),
            clickhouse_static_runtime_table("asklake_second", 1, binding),
        )

        class NoTrino:
            def __getattr__(self, name):
                raise AssertionError(f"Trino must not be used on a verified cache hit: {name}")

        class RegisteredCacheClient:
            def __init__(self) -> None:
                self.executed: list[str] = []
                self.queries: list[str] = []

            def execute(self, query: str, **_kwargs) -> str:
                self.executed.append(query)
                return ""

            def query(self, query: str, **_kwargs) -> ClickHouseRows:
                self.queries.append(query)
                if "asklake_static_cache_registry` FINAL" in query:
                    return ClickHouseRows(
                        columns=["table_name", "row_count"],
                        rows=[["asklake_existing_static", 3]],
                    )
                if "FROM system.tables" in query:
                    return ClickHouseRows(columns=["engine"], rows=[["MergeTree"]])
                if "FROM system.columns" in query:
                    return ClickHouseRows(
                        columns=["name", "type"],
                        rows=[["id", "Nullable(Int64)"], ["name", "Nullable(String)"]],
                    )
                if "count() AS row_count" in query:
                    return ClickHouseRows(columns=["row_count"], rows=[[3]])
                raise AssertionError(query)

        client = RegisteredCacheClient()
        cache = ClickHouseStaticSnapshotCache(
            Settings(_env_file=None, app_env="test"),
            NoTrino(),
        )
        table = cache.resolve(
            client,
            database="asklake",
            preferred_table="asklake_second_static",
            relation=relation,
            binding=binding,
            join_columns=["id"],
        )

        self.assertEqual(table, "asklake_existing_static")
        self.assertEqual(len(client.executed), 1)
        self.assertIn("CREATE TABLE IF NOT EXISTS", client.executed[0])

    def test_static_snapshot_load_is_rejected_before_disk_reserve_is_exhausted(self) -> None:
        class LowDiskClient:
            def query(self, query: str, **_kwargs) -> ClickHouseRows:
                self.query_text = query
                return ClickHouseRows(
                    columns=["free_space", "total_space"],
                    rows=[[1_000_000_000, 30_000_000_000]],
                )

        cache = ClickHouseStaticSnapshotCache(
            Settings(
                _env_file=None,
                app_env="test",
                clickhouse_static_load_min_free_bytes=2_147_483_648,
            ),
            object(),
        )

        with self.assertRaises(ClickHouseError) as caught:
            cache._require_load_capacity(LowDiskClient(), total_rows=12_092_405)

        self.assertEqual(caught.exception.code, "CLICKHOUSE_STATIC_DISK_LOW")

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

    def test_clickhouse_date_bucket_qualifies_source_column_behind_output_alias(self) -> None:
        client = FakeDashboardClickHouseClient()
        session = DashboardDatasetQuerySession(
            {
                "id": "dataset-hot",
                "name": "hot",
                "schema": [["event_time", "timestamp"], ["event_type", "string"]],
                "storageFormat": "clickhouse",
                "clickhouseTable": {"database": "asklake", "table": "hot_join"},
            },
            clickhouse_client=client,
        )
        try:
            session.read_widget(
                "line_chart",
                {
                    "aggregation": "count",
                    "xKey": "event_time",
                    "yKey": "__asklake_widget_value",
                    "seriesKey": "event_type",
                    "dateUnit": "month",
                },
            )
        finally:
            session.close()

        query = client.queries[-1]
        self.assertIn('AS "__asklake_source" FINAL', query)
        self.assertGreaterEqual(
            query.count('"__asklake_source"."event_time"'),
            2,
        )

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
