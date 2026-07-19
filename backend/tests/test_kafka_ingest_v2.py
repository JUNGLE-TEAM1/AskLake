from __future__ import annotations

from types import SimpleNamespace
import unittest
from unittest.mock import patch

from sqlalchemy import create_engine, select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Session

from app.core.config import Settings
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
        source_label="Kafka topic events.v2",
        continuous_config={"triggerIntervalSeconds": 5},
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
