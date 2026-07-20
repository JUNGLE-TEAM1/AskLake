"""Deployment-owned engine selection for newly created realtime Kafka Jobs."""

from typing import Protocol


class RealtimeJobEngineSettings(Protocol):
    clickhouse_realtime_v2_enabled: bool
    kafka_connect_sink_enabled: bool
    clickhouse_realtime_consumer_owner: str


def selected_realtime_job_engine(settings: RealtimeJobEngineSettings) -> str:
    if (
        settings.clickhouse_realtime_v2_enabled
        and settings.kafka_connect_sink_enabled
        and settings.clickhouse_realtime_consumer_owner == "kafka_connect_v2"
    ):
        return "kafka_connect_clickhouse_v2"
    return "spark_structured_streaming"
