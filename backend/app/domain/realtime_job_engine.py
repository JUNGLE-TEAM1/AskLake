"""Deployment-owned engine selection for realtime Kafka Jobs."""

from typing import Any


def selected_realtime_job_engine(configured_settings: Any) -> str:
    """Select V2 only for an explicitly enabled EC2-compatible profile.

    EKS values omit these retired V2 flags, so the deployment-owned default is
    always the fenced Spark V1 engine.
    """
    if (
        bool(getattr(configured_settings, "clickhouse_realtime_v2_enabled", False))
        and bool(getattr(configured_settings, "kafka_connect_sink_enabled", False))
        and getattr(configured_settings, "clickhouse_realtime_consumer_owner", "disabled")
        == "kafka_connect_v2"
    ):
        return "kafka_connect_clickhouse_v2"
    return "spark_structured_streaming"
