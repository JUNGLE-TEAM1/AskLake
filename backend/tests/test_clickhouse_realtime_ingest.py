from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
import json
import unittest

import httpx

from app.core.config import Settings
from app.realtime.domain.receipt import audit_receipt_range
from app.realtime.domain.source_position import OpaqueEnvelope, SourcePosition
from app.realtime.infrastructure.kafka_connect_gateway import (
    CONNECTOR_CLASS,
    KafkaConnectGateway,
    build_raw_sink_config,
    connector_config_fingerprint,
)
from app.realtime.repositories.receipt_repository import ReceiptRepository


def connect_settings() -> Settings:
    return Settings(
        app_env="test",
        clickhouse_realtime_v2_enabled=True,
        kafka_connect_sink_enabled=True,
        clickhouse_realtime_consumer_owner="kafka_connect_v2",
        kafka_connect_url="http://connect.internal:8083",
        _env_file=None,
    )


class _Result:
    def __init__(self, rowcount: int = 1) -> None:
        self.rowcount = rowcount


class _Session:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, object]]] = []

    def execute(self, statement, parameters):
        self.calls.append((str(statement), parameters))
        return _Result()


class ClickHouseRealtimeIngestTests(unittest.TestCase):
    def test_opaque_envelope_preserves_source_position_and_stable_identity(self) -> None:
        envelope = OpaqueEnvelope.from_value(
            topic="events.v2",
            partition=3,
            offset=42,
            payload='{"unknown":{"field":1}}',
            kafka_timestamp=datetime(2026, 7, 18, tzinfo=UTC),
        )
        document = envelope.canonical_document()

        self.assertEqual(document["payload"], '{"unknown":{"field":1}}')
        self.assertEqual(document["eventKey"], envelope.position.digest())
        self.assertEqual(len(document["payloadHash"]), 64)
        self.assertEqual(envelope.canonical_json(), envelope.canonical_json())

    def test_receipt_audit_never_crosses_gap_and_accepts_resolved_poison(self) -> None:
        positions = [SourcePosition("events", 0, value) for value in (10, 11, 13)]
        blocked = audit_receipt_range(expected=positions, raw=(positions[0], positions[2]))
        resolved = audit_receipt_range(
            expected=positions,
            raw=(positions[0], positions[2]),
            resolved=(positions[1],),
        )

        self.assertEqual(blocked.status, "blocked")
        self.assertEqual(blocked.missing_offsets, (11,))
        self.assertEqual(blocked.advance_to_offset, 10)
        self.assertEqual(resolved.status, "contiguous")
        self.assertEqual(resolved.advance_to_offset, 13)
        self.assertEqual(resolved.expected_positions_hash, resolved.raw_or_resolved_positions_hash)

    def test_connector_config_keeps_payload_opaque_and_dlq_auditable(self) -> None:
        config = build_raw_sink_config(
            topic="events.raw",
            table="raw_events_v2",
            dlq_topic="events.raw.dlq",
        )

        self.assertEqual(config["connector.class"], CONNECTOR_CLASS)
        self.assertEqual(config["value.converter"], "org.apache.kafka.connect.storage.StringConverter")
        self.assertEqual(config["exactlyOnce"], "true")
        self.assertEqual(config["consumer.override.isolation.level"], "read_committed")
        self.assertEqual(config["errors.deadletterqueue.topic.replication.factor"], "1")
        self.assertEqual(config["jdbcConnectionProperties"], "?ssl=true&sslmode=strict")
        self.assertEqual(config["zkPath"], "/asklake/realtime-v2/connect-state")
        self.assertEqual(config["zkDatabase"], "connect_state")
        self.assertNotIn("sslrootcert", config)
        self.assertNotIn("ssl_socket_sni", config)
        self.assertIn("HoistField$Value", config["transforms.hoistPayload.type"])
        self.assertTrue(config["password"].startswith("${file:"))
        self.assertNotIn("password", connector_config_fingerprint(config))

    def test_gateway_requires_plugin_and_all_tasks_running(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/connector-plugins":
                return httpx.Response(200, json=[{"class": CONNECTOR_CLASS}])
            return httpx.Response(200, json={
                "connector": {"state": "RUNNING"},
                "tasks": [{"id": 0, "state": "RUNNING"}, {"id": 1, "state": "RUNNING"}],
            })

        gateway = KafkaConnectGateway(connect_settings(), transport=httpx.MockTransport(handler))
        try:
            probe = gateway.probe()
        finally:
            gateway.close()

        self.assertTrue(probe.ready)
        self.assertEqual(probe.task_states, ("RUNNING", "RUNNING"))

    def test_receipt_repository_uses_cas_only_for_verified_range(self) -> None:
        positions = tuple(SourcePosition("events", 1, value) for value in (2, 4))
        audit = audit_receipt_range(expected=positions, raw=positions)
        session = _Session()

        advanced = ReceiptRepository(session).save_audit(
            pipeline_version_id="version-1",
            audit=audit,
            expected_previous_contiguous=1,
        )

        self.assertTrue(advanced)
        self.assertEqual(len(session.calls), 3)
        self.assertIn("last_contiguously_received_offset = :advance", session.calls[-1][0])
        self.assertEqual(session.calls[-1][1]["expected_previous"], 1)

    def test_raw_clickhouse_ddl_has_position_key_ttl_and_current_view(self) -> None:
        ddl = (Path(__file__).parents[2] / "deploy/clickhouse-v2/initdb/02-raw-ingest.sql").read_text()

        for fragment in (
            "raw_events_v2",
            "connect_state",
            "KeeperMap('/asklake/realtime-v2/connect-state')",
            "kafka_topic",
            "kafka_partition",
            "kafka_offset",
            "payload_hash",
            "ReplicatedReplacingMergeTree",
            "TTL ingested_at + INTERVAL 7 DAY DELETE",
            "raw_events_v2_current",
        ):
            self.assertIn(fragment, ddl)

    def test_tls_runtime_keeps_private_https_replication_endpoint(self) -> None:
        deploy_root = Path(__file__).parents[2] / "deploy/clickhouse-v2"
        tls_config = (deploy_root / "config.d/tls.xml").read_text()
        plaintext_override = (deploy_root / "initdb/99-disable-plaintext.sh").read_text()

        self.assertIn('<interserver_http_port remove="remove"/>', tls_config)
        self.assertIn("<interserver_https_port>9010</interserver_https_port>", tls_config)
        self.assertIn('<interserver_http_port remove="remove"/>', plaintext_override)
        self.assertNotIn("interserver_https_port remove", plaintext_override)

    def test_ingest_role_can_create_only_the_exactly_once_state_table(self) -> None:
        access_control = (
            Path(__file__).parents[2]
            / "deploy/clickhouse-v2/initdb/01-access-control.sh"
        ).read_text()

        self.assertIn(
            "GRANT CREATE TABLE ON \\`${database}\\`.connect_state TO asklake_v2_ingest_role;",
            access_control,
        )
        self.assertNotIn(
            "GRANT CREATE TABLE ON \\`${database}\\`.* TO asklake_v2_ingest_role;",
            access_control,
        )

    def test_observer_can_see_replica_metadata_without_reading_user_tables(self) -> None:
        access_control = (
            Path(__file__).parents[2]
            / "deploy/clickhouse-v2/initdb/01-access-control.sh"
        ).read_text()

        self.assertIn(
            "GRANT SHOW TABLES ON \\`${database}\\`.* TO asklake_v2_observer_role;",
            access_control,
        )
        self.assertNotIn(
            "GRANT SELECT ON \\`${database}\\`.* TO asklake_v2_observer_role;",
            access_control,
        )


if __name__ == "__main__":
    unittest.main()
