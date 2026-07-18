from __future__ import annotations

from app.core.config import Settings, settings
from app.realtime.infrastructure.kafka_connect_gateway import (
    ConnectorProbe,
    KafkaConnectGateway,
    build_raw_sink_config,
    connector_config_fingerprint,
)
from app.services.realtime_feature_flags import validate_clickhouse_consumer_ownership


class RealtimeIngestService:
    def __init__(self, runtime_settings: Settings | None = None) -> None:
        self.settings = runtime_settings or settings

    def probe(self) -> ConnectorProbe:
        if not self.settings.clickhouse_realtime_v2_enabled:
            return ConnectorProbe(False, False, "DISABLED", ())
        validate_clickhouse_consumer_ownership(
            job_id=self.settings.kafka_connect_connector_name,
            generation=1,
            configured_owner=self.settings.clickhouse_realtime_consumer_owner,
            claimed_owners=("kafka_connect_v2",),
        )
        gateway = KafkaConnectGateway(self.settings)
        try:
            return gateway.probe()
        finally:
            gateway.close()

    def register(self, *, topic: str, table: str, dlq_topic: str, generation: int) -> dict[str, object]:
        validate_clickhouse_consumer_ownership(
            job_id=self.settings.kafka_connect_connector_name,
            generation=generation,
            configured_owner=self.settings.clickhouse_realtime_consumer_owner,
            claimed_owners=("kafka_connect_v2",),
        )
        config = build_raw_sink_config(topic=topic, table=table, dlq_topic=dlq_topic)
        gateway = KafkaConnectGateway(self.settings)
        try:
            gateway.put_connector(config)
        finally:
            gateway.close()
        return {
            "connectorName": self.settings.kafka_connect_connector_name,
            "configFingerprint": connector_config_fingerprint(config),
            "registered": True,
        }
