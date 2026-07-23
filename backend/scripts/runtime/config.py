"""Typed environment configuration for Spark and Kafka runtime workers."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping
import os

from runtime.contracts import load_spark_job_manifest, required_env


KAFKA_MSK_IAM_OPTIONS = {
    "kafka.security.protocol": "SASL_SSL",
    "kafka.sasl.mechanism": "AWS_MSK_IAM",
    "kafka.sasl.jaas.config": "software.amazon.msk.auth.iam.IAMLoginModule required;",
    "kafka.sasl.client.callback.handler.class": (
        "software.amazon.msk.auth.iam.IAMClientCallbackHandler"
    ),
}


def kafka_auth_mode(broker: str, configured: str | None = None) -> str:
    endpoints = [endpoint.strip() for endpoint in str(broker or "").split(",") if endpoint.strip()]
    inferred = "iam" if endpoints and all(endpoint.rsplit(":", 1)[-1] == "9098" for endpoint in endpoints) else "none"
    mode = str(configured or "").strip().lower() or inferred
    if mode not in {"iam", "none"}:
        raise ValueError("ASKLAKE_KAFKA_AUTH_MODE must be iam or none.")
    if mode == "iam" and inferred != "iam":
        raise ValueError("ASKLAKE_KAFKA_AUTH_MODE=iam requires only port 9098 broker endpoints.")
    if mode == "none" and inferred == "iam":
        raise ValueError("Port 9098 broker endpoints require ASKLAKE_KAFKA_AUTH_MODE=iam.")
    return mode


def kafka_security_options(auth_mode: str) -> dict[str, str]:
    if auth_mode == "iam":
        return dict(KAFKA_MSK_IAM_OPTIONS)
    if auth_mode == "none":
        return {}
    raise ValueError(f"Unsupported Kafka auth mode: {auth_mode}")


@dataclass(frozen=True, slots=True)
class SparkJobConfig:
    source_path: str
    source_format: str
    output_path: str
    run_id: str
    row_limit: int
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
        return cls(
            source_path=required_env("ASKLAKE_SPARK_SOURCE_PATH", environ=source),
            source_format=required_env("ASKLAKE_SPARK_SOURCE_FORMAT", environ=source).lower(),
            output_path=required_env("ASKLAKE_SPARK_OUTPUT_PATH", environ=source),
            run_id=required_env("ASKLAKE_SPARK_RUN_ID", environ=source),
            row_limit=row_limit,
            manifest=load_spark_job_manifest(environ=source),
        )


@dataclass(frozen=True, slots=True)
class KafkaWorkerConfig:
    job_id: str
    broker: str
    auth_mode: str
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
        broker = required_env("ASKLAKE_CONTINUOUS_BROKER", environ=source)
        return cls(
            job_id=required_env("ASKLAKE_CONTINUOUS_JOB_ID", environ=source),
            broker=broker,
            auth_mode=kafka_auth_mode(broker, source.get("ASKLAKE_KAFKA_AUTH_MODE")),
            topic=required_env("ASKLAKE_CONTINUOUS_TOPIC", environ=source),
            consumer_group_id=required_env(
                "ASKLAKE_CONTINUOUS_CONSUMER_GROUP_ID",
                environ=source,
            ),
            output_path=required_env("ASKLAKE_CONTINUOUS_OUTPUT_PATH", environ=source),
            checkpoint_path=required_env("ASKLAKE_CONTINUOUS_CHECKPOINT_PATH", environ=source),
            trigger_seconds=trigger_seconds,
        )
