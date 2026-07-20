"""Deployment-owned engine selection for realtime Kafka Jobs."""

from typing import Any


def selected_realtime_job_engine(_settings: Any) -> str:
    """Keep realtime Kafka execution on the single supported Spark V1 engine."""
    return "spark_structured_streaming"
