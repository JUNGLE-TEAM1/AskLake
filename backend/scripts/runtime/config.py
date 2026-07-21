"""Typed environment configuration for Spark and Kafka runtime workers."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping
import os

from runtime.contracts import load_spark_job_manifest, required_env


@dataclass(frozen=True, slots=True)
class SparkJobConfig:
    source_path: str
    source_format: str
    output_path: str
    run_id: str
    row_limit: int
    direct_cache_max_source_bytes: int
    manifest: dict[str, Any]

    @classmethod
    def from_environment(
        cls,
        environ: Mapping[str, str] | None = None,
    ) -> "SparkJobConfig":
        source = environ if environ is not None else os.environ
        try:
            row_limit = int(source.get("ASKLAKE_SPARK_RUN_ROW_LIMIT", "0") or "0")
        except ValueError as exc:
            raise ValueError("ASKLAKE_SPARK_RUN_ROW_LIMIT must be an integer.") from exc
        if row_limit < 0:
            raise ValueError("ASKLAKE_SPARK_RUN_ROW_LIMIT must be zero or greater.")
        try:
            direct_cache_max_source_bytes = int(
                source.get("ASKLAKE_SPARK_DIRECT_CACHE_MAX_SOURCE_BYTES", "0") or "0"
            )
        except ValueError as exc:
            raise ValueError(
                "ASKLAKE_SPARK_DIRECT_CACHE_MAX_SOURCE_BYTES must be an integer."
            ) from exc
        if direct_cache_max_source_bytes < 0:
            raise ValueError(
                "ASKLAKE_SPARK_DIRECT_CACHE_MAX_SOURCE_BYTES must be zero or greater."
            )
        return cls(
            source_path=required_env("ASKLAKE_SPARK_SOURCE_PATH", environ=source),
            source_format=required_env("ASKLAKE_SPARK_SOURCE_FORMAT", environ=source).lower(),
            output_path=required_env("ASKLAKE_SPARK_OUTPUT_PATH", environ=source),
            run_id=required_env("ASKLAKE_SPARK_RUN_ID", environ=source),
            row_limit=row_limit,
            direct_cache_max_source_bytes=direct_cache_max_source_bytes,
            manifest=load_spark_job_manifest(environ=source),
        )


@dataclass(frozen=True, slots=True)
class KafkaWorkerConfig:
    job_id: str
    broker: str
    topic: str
    consumer_group_id: str
    output_path: str
    checkpoint_path: str
    trigger_seconds: int

    @classmethod
    def from_environment(
        cls,
        environ: Mapping[str, str] | None = None,
    ) -> "KafkaWorkerConfig":
        source = environ if environ is not None else os.environ
        try:
            trigger_seconds = int(source.get("ASKLAKE_CONTINUOUS_TRIGGER_SECONDS", "30"))
        except ValueError as exc:
            raise ValueError("ASKLAKE_CONTINUOUS_TRIGGER_SECONDS must be an integer.") from exc
        if trigger_seconds <= 0:
            raise ValueError("ASKLAKE_CONTINUOUS_TRIGGER_SECONDS must be greater than zero.")
        return cls(
            job_id=required_env("ASKLAKE_CONTINUOUS_JOB_ID", environ=source),
            broker=required_env("ASKLAKE_CONTINUOUS_BROKER", environ=source),
            topic=required_env("ASKLAKE_CONTINUOUS_TOPIC", environ=source),
            consumer_group_id=required_env(
                "ASKLAKE_CONTINUOUS_CONSUMER_GROUP_ID",
                environ=source,
            ),
            output_path=required_env("ASKLAKE_CONTINUOUS_OUTPUT_PATH", environ=source),
            checkpoint_path=required_env("ASKLAKE_CONTINUOUS_CHECKPOINT_PATH", environ=source),
            trigger_seconds=trigger_seconds,
        )
