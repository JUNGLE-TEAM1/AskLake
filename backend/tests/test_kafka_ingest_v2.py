from __future__ import annotations

from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from sqlalchemy import create_engine, select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.auth_context import ActorContext
from app.core.errors import ApiError
from app.models.base import Base
from app.models.catalog import CatalogDatasetModel
from app.models.dashboard_live import DatasetFreshnessModel
from app.models.realtime import RealtimeEventModel
from app.realtime.infrastructure.kafka_connect_gateway import ConnectorProbe
from app.repositories.catalog_repository import dataset_model_to_payload
from app.schemas.catalog import CatalogDatasetResponse
from app.services.clickhouse_client import ClickHouseRows
from app.services.kafka_ingest_v2 import (
    ClickHouseKafkaIngestV2Gateway,
    kafka_ingest_v2_enabled,
    kafka_ingest_v2_selected,
    require_kafka_ingest_v2_ready,
)
from app.services import etl_service


@compiles(JSONB, "sqlite")
def compile_jsonb_for_sqlite(_type, _compiler, **_kwargs):
    return "JSON"


class FakeConnector:
    def __init__(self) -> None:
        self.state = "RUNNING"
        self.registered = True
        self.paused = False
        self.resumed = False

    def probe(self) -> ConnectorProbe:
        return ConnectorProbe(
            worker_ready=True,
            registered=self.registered,
            connector_state="PAUSED" if self.paused else self.state,
            task_states=() if self.paused else ("RUNNING",),
        )

    def pause_connector(self) -> None:
        self.paused = True

    def resume_connector(self) -> None:
        self.paused = False
        self.resumed = True

    def restart_failed(self) -> None:
        self.state = "RUNNING"

    def close(self) -> None:
        pass


class FakeIngestService:
    def __init__(self) -> None:
        self.register_calls: list[dict[str, object]] = []

    def register(self, **kwargs):
        self.register_calls.append(dict(kwargs))
        return {"registered": True}


class FakeClickHouse:
    def __init__(self) -> None:
        self.rows: list[list[object]] = []

    def query(self, _query: str, **_kwargs) -> ClickHouseRows:
        return ClickHouseRows(
            columns=[
                "kafka_partition",
                "min(kafka_offset)",
                "max(kafka_offset)",
                "count()",
                "max(ingested_at)",
            ],
            rows=self.rows,
        )

    def close(self) -> None:
        pass


def job():
    return SimpleNamespace(
        id="JOB-KAFKA-V2",
        name="Kafka V2 ingestion",
        owner="owner",
        created_by="owner",
        target="kafka_v2_events",
        target_description="",
        target_layer="BRONZE",
        storage_path="s3a://lake/kafka-v2",
        target_path="s3a://lake/kafka-v2",
        source_label="Kafka topic events.v2",
        continuous_config={
            "runtimeEngine": "kafka_connect_clickhouse_v2",
            "runtimeGeneration": 1,
            "triggerIntervalSeconds": 5,
        },
        schema_columns=[
            {"sourceName": "event_id", "targetName": "event_id", "type": "long", "included": True},
            {"sourceName": "region", "targetName": "region", "type": "string", "included": True},
        ],
        dataset_id="ds_kafka_v2_events",
        rag=False,
        execution_mode="continuous",
        source_config=[["TOPIC / QUEUE NAME", "events.v2"]],
    )


def runtime():
    return SimpleNamespace(
        broker="redpanda:9092",
        consumer_group_id="asklake-kafka-v2",
        topic="events.v2",
    )


class KafkaIngestV2Tests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite+pysqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.connector = FakeConnector()
        self.ingest = FakeIngestService()
        self.clickhouse = FakeClickHouse()
        self.settings = Settings(
            _env_file=None,
            app_env="test",
            clickhouse_realtime_v2_enabled=True,
            kafka_connect_sink_enabled=True,
            clickhouse_realtime_consumer_owner="kafka_connect_v2",
            kafka_connect_url="http://connect.internal:8083",
        )
        self.gateway = ClickHouseKafkaIngestV2Gateway(
            self.settings,
            session_factory=lambda: Session(self.engine),
            client_factory=lambda: self.clickhouse,  # type: ignore[arg-type]
            connector_factory=lambda _name: self.connector,  # type: ignore[arg-type]
            ingest_service_factory=lambda _settings: self.ingest,  # type: ignore[arg-type]
        )

    def tearDown(self) -> None:
        self.engine.dispose()

    def test_v2_flags_route_continuous_kafka_away_from_spark(self) -> None:
        self.assertTrue(kafka_ingest_v2_enabled(job(), self.settings))
        self.assertFalse(kafka_ingest_v2_enabled(
            SimpleNamespace(execution_mode="snapshot"), self.settings
        ))

    def test_legacy_continuous_job_without_engine_marker_remains_v1(self) -> None:
        legacy = job()
        legacy.continuous_config = {"triggerIntervalSeconds": 5}

        self.assertFalse(kafka_ingest_v2_selected(legacy))
        self.assertFalse(kafka_ingest_v2_enabled(legacy, self.settings))

    def test_selected_v2_job_fails_closed_when_runtime_flags_are_disabled(self) -> None:
        disabled = Settings(_env_file=None, app_env="test")

        with self.assertRaises(ApiError) as raised:
            require_kafka_ingest_v2_ready(job(), disabled)

        self.assertEqual(raised.exception.code, "CLICKHOUSE_KAFKA_INGEST_V2_UNAVAILABLE")

    def test_control_plane_only_start_rejects_unavailable_v2_before_persisting_intent(self) -> None:
        disabled = Settings(_env_file=None, app_env="test")
        with (
            patch.object(etl_service, "settings", disabled),
            patch.object(etl_service, "execute_continuous_command") as execute,
            self.assertRaises(ApiError) as raised,
        ):
            etl_service.command_kafka_continuous_job(
                None, job(), "startContinuous", ActorContext(name="owner")
            )

        self.assertEqual(raised.exception.code, "CLICKHOUSE_KAFKA_INGEST_V2_UNAVAILABLE")
        execute.assert_not_called()

    def test_external_api_admission_assigns_exact_eks_owner_generation(self) -> None:
        with (
            patch.object(etl_service.settings, "asklake_continuous_control_plane", "external_ec2"),
            patch.object(etl_service.settings, "kafka_continuous_v2_api_enabled", True),
            patch.object(
                etl_service.settings,
                "kafka_continuous_v2_owner_generation",
                "v2-job-1073-g1",
            ),
        ):
            runtime_model = etl_service.continuous_runtime_from_job(job())
            require_kafka_ingest_v2_ready(job(), etl_service.settings)

        claim = runtime_model.metrics["ownerClaim"]
        self.assertEqual(claim["owner"], "eks-kafka-connect-clickhouse-v2")
        self.assertEqual(claim["generation"], "v2-job-1073-g1")
        self.assertEqual(claim["topic"], "events.v2")
        self.assertEqual(claim["consumerGroup"], "asklake-stream-job-kafka-v2")
        self.assertEqual(claim["stateRevision"], 1)

    def test_external_api_persists_start_intent_without_dispatching_worker_side_effect(self) -> None:
        response = Mock()
        with (
            patch.object(etl_service.settings, "asklake_continuous_control_plane", "external_ec2"),
            patch.object(etl_service.settings, "kafka_continuous_v2_api_enabled", True),
            patch.object(
                etl_service.settings,
                "kafka_continuous_v2_owner_generation",
                "v2-job-1073-g1",
            ),
            patch.object(etl_service, "execute_continuous_command", return_value=response) as execute,
        ):
            result = etl_service.command_kafka_continuous_job(
                None, job(), "startContinuous", ActorContext(name="owner")
            )

        self.assertIs(result, response)
        self.assertFalse(execute.call_args.kwargs["dispatch_worker"])

    def test_etl_worker_facade_delegates_to_v2_before_spark_bridge(self) -> None:
        expected = {"containerState": "running", "worker": "kafka_connect_clickhouse_v2"}
        with (
            patch.object(etl_service, "settings", self.settings),
            patch.object(etl_service, "run_clickhouse_kafka_ingest_v2", return_value=expected) as routed,
        ):
            result = etl_service.run_kafka_continuous_worker(job(), runtime(), "start")

        self.assertEqual(result, expected)
        routed.assert_called_once()

    def test_start_registers_connector_and_creates_preparing_catalog(self) -> None:
        result = self.gateway.manage(job(), runtime(), "start")

        self.assertEqual(result["worker"], "kafka_connect_clickhouse_v2")
        self.assertEqual(result["containerState"], "running")
        self.assertTrue(self.connector.resumed)
        self.assertEqual(self.ingest.register_calls[0]["table"], "raw_events_v2")
        with Session(self.engine) as db:
            catalog = db.get(CatalogDatasetModel, "ds_kafka_v2_events")
            payload = dataset_model_to_payload(catalog)
        self.assertEqual(payload["status"], "preparing")
        self.assertEqual(CatalogDatasetResponse.model_validate(payload).freshness, "realtime")
        self.assertEqual(payload["physicalBindings"][0]["status"], "pending")
        self.assertEqual(payload["streamingSource"]["topic"], "events.v2")

    def test_first_raw_offset_publishes_catalog_and_sse_revision(self) -> None:
        self.gateway.manage(job(), runtime(), "start")
        self.clickhouse.rows = [[0, 4, 6, 3, "2026-07-19T12:00:00Z"]]

        result = self.gateway.manage(job(), runtime(), "status")

        self.assertEqual(result["publicationRevision"], 1)
        with Session(self.engine) as db:
            catalog = db.get(CatalogDatasetModel, "ds_kafka_v2_events")
            freshness = db.get(DatasetFreshnessModel, "ds_kafka_v2_events")
            event = db.scalar(select(RealtimeEventModel))
            payload = dataset_model_to_payload(catalog)
        self.assertEqual(payload["status"], "available")
        self.assertEqual(payload["rows"], "3")
        self.assertEqual(payload["physicalBindings"][0]["status"], "active")
        self.assertEqual(freshness.latest_revision, 1)
        self.assertEqual(event.schema_version, 2)
        self.assertEqual(event.payload["mutationType"], "append")


if __name__ == "__main__":
    unittest.main()
