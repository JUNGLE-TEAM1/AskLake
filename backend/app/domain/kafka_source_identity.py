"""Managed Kafka source identities for the EKS MSK IAM runtime.

Browser drafts may select a broker and topic, but they never own a durable
consumer-group identity.  In IAM mode the API validates the deployment-owned
broker/topic namespace and derives one consumer group per persisted Job.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
import os
import re


KAFKA_SOURCE_TYPES = frozenset({"stream / kafka", "kafka json"})
KAFKA_GROUP_LABELS = frozenset({"consumer group id"})
KAFKA_OWNER_LABEL = "__Kafka Consumer Group Owner"


class KafkaSourceBoundaryError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True, slots=True)
class KafkaSourceBoundaryViolation:
    code: str
    message: str
    details: dict[str, str] | None = None


def managed_kafka_source_violations(
    source_type: str | None,
    source_config: Sequence[Sequence[str]] | None,
    *,
    environment: Mapping[str, str] | None = None,
) -> list[KafkaSourceBoundaryViolation]:
    try:
        validate_managed_kafka_source(source_type, source_config, environment=environment)
    except KafkaSourceBoundaryError as exc:
        return [KafkaSourceBoundaryViolation(code=exc.code, message=str(exc))]
    return []


def is_kafka_source_type(source_type: str | None) -> bool:
    return str(source_type or "").strip().casefold() in KAFKA_SOURCE_TYPES


def validate_managed_kafka_source(
    source_type: str | None,
    source_config: Sequence[Sequence[str]] | None,
    *,
    environment: Mapping[str, str] | None = None,
) -> None:
    env = environment or os.environ
    if not is_kafka_source_type(source_type) or _auth_mode(env) != "iam":
        return

    configured_broker = str(env.get("ASKLAKE_KAFKA_BROKER") or "").strip()
    allowed_prefixes = _csv_values(env.get("ASKLAKE_KAFKA_ALLOWED_TOPIC_PREFIXES"))
    if not configured_broker or not allowed_prefixes:
        raise KafkaSourceBoundaryError(
            "KAFKA_MANAGED_BOUNDARY_NOT_CONFIGURED",
            "MSK IAM requires a deployment-owned broker and at least one allowed topic prefix.",
        )

    requested_broker = _field_value(source_config, "Broker / Endpoint", "Broker")
    if _canonical_brokers(requested_broker) != _canonical_brokers(configured_broker):
        raise KafkaSourceBoundaryError(
            "KAFKA_BROKER_OUTSIDE_MANAGED_BOUNDARY",
            "Kafka broker must match the broker owned by this EKS deployment.",
        )

    topic = _field_value(source_config, "TOPIC / QUEUE NAME", "Topic")
    if not topic or not any(topic.startswith(prefix) for prefix in allowed_prefixes):
        raise KafkaSourceBoundaryError(
            "KAFKA_TOPIC_OUTSIDE_MANAGED_BOUNDARY",
            "Kafka topic is outside the topic namespace allowed by this EKS deployment.",
        )


def managed_kafka_source_config(
    source_type: str | None,
    source_config: Sequence[Sequence[str]] | None,
    *,
    execution_mode: str | None,
    job_id: str,
    environment: Mapping[str, str] | None = None,
) -> list[list[str]]:
    rows = [[str(row[0]), str(row[1])] for row in source_config or [] if len(row) >= 2]
    env = environment or os.environ
    if not is_kafka_source_type(source_type) or _auth_mode(env) != "iam":
        return rows

    validate_managed_kafka_source(source_type, rows, environment=env)
    group_id = managed_consumer_group(job_id, execution_mode)
    filtered = [
        row for row in rows
        if row[0].strip().casefold() not in KAFKA_GROUP_LABELS
        and row[0].strip() != KAFKA_OWNER_LABEL
    ]
    filtered.extend([
        ["CONSUMER GROUP ID", group_id],
        [KAFKA_OWNER_LABEL, "server:job-id"],
    ])
    return filtered


def managed_consumer_group(job_id: str, execution_mode: str | None) -> str:
    normalized_job_id = re.sub(r"[^a-z0-9-]+", "-", str(job_id).strip().lower()).strip("-")
    if not normalized_job_id:
        raise KafkaSourceBoundaryError(
            "KAFKA_JOB_IDENTITY_INVALID",
            "Kafka consumer group requires a non-empty Job identity.",
        )
    prefix = "asklake-stream" if str(execution_mode or "snapshot").casefold() == "continuous" else "asklake-batch"
    return f"{prefix}-{normalized_job_id}"[:255].rstrip("-")


def _auth_mode(environment: Mapping[str, str]) -> str:
    return str(environment.get("ASKLAKE_KAFKA_AUTH_MODE") or "none").strip().casefold()


def _canonical_brokers(value: str) -> tuple[str, ...]:
    return tuple(sorted(item.strip().casefold() for item in str(value or "").split(",") if item.strip()))


def _csv_values(value: str | None) -> tuple[str, ...]:
    return tuple(item.strip() for item in str(value or "").split(",") if item.strip())


def _field_value(source_config: Sequence[Sequence[str]] | None, *labels: str) -> str:
    expected = {label.casefold() for label in labels}
    for row in source_config or []:
        if len(row) >= 2 and str(row[0]).strip().casefold() in expected:
            return str(row[1]).strip()
    return ""
