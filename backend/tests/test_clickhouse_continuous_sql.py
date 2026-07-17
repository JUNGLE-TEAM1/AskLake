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
from app.services.clickhouse_client import ClickHouseClient, ClickHouseRows
from app.services.clickhouse_continuous_publication import (
    ClickHouseContinuousSqlPublicationService,
)
from app.services.clickhouse_continuous_sql import (
    clickhouse_ingest_materialized_view_ddl,
    clickhouse_kafka_table_ddl,
    clickhouse_raw_table_ddl,
    replace_runtime_table,
    clickhouse_runtime_sql,
    clickhouse_type,
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
                rows=[["event_id", "Nullable(Int64)"], ["user_name", "Nullable(String)"]],
            )
        return ClickHouseRows(
            columns=["user_name", "__asklake_widget_value"],
            rows=[["Alice", 2], ["Bob", 1]],
        )

    def close(self) -> None:
        self.closed = True


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
        )

        self.assertIn('FROM "asklake"."events_kafka" AS e', query)
        self.assertIn('LEFT JOIN "asklake"."users_static" AS u', query)
        self.assertIn("e._offset AS kafka_offset", query)
        self.assertIn("now64(3) AS ingested_at", query)
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
