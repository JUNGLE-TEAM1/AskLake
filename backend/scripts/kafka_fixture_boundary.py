import re

try:
    from kafka_fixture_slots import (
        EksFixtureSlotConfigurationError,
        fixture_slot_for_consumer_group,
    )
except ModuleNotFoundError:
    from scripts.kafka_fixture_slots import (
        EksFixtureSlotConfigurationError,
        fixture_slot_for_consumer_group,
    )


class KafkaFixtureBoundaryError(ValueError):
    pass


EKS_MVP_FIXTURE_TOPIC = "asklake.eks-mvp.fixture.v1"
EKS_MVP_OUTPUT_PREFIX = "eks-mvp/output"
EKS_MVP_CHECKPOINT_PREFIX = "eks-mvp/checkpoints"


def validate_kafka_fixture_boundary(
    *,
    environment,
    source_boundary,
    source_format,
    source_path,
    iceberg_target=None,
):
    if str(source_format or "").strip().lower() != "kafka":
        return None

    boundary = source_boundary if isinstance(source_boundary, dict) else {}
    runtime_fixture_batch_id = str(
        environment.get("ASKLAKE_KAFKA_FIXTURE_BATCH_ID") or ""
    ).strip()
    boundary_fixture_batch_id = str(boundary.get("fixtureBatchId") or "").strip()
    if not runtime_fixture_batch_id and not boundary_fixture_batch_id:
        return None

    if str(boundary.get("kind") or "").strip() != "kafka_snapshot":
        raise KafkaFixtureBoundaryError(
            "KAFKA_FIXTURE_BOUNDARY_INVALID sourceBoundary.kind must be kafka_snapshot"
        )

    broker = _required(environment.get("ASKLAKE_KAFKA_BROKER"), "ASKLAKE_KAFKA_BROKER")
    brokers = [item.strip() for item in broker.split(",") if item.strip()]
    if not brokers or any(not re.fullmatch(r"[^,\s:]+:9098", item) for item in brokers):
        raise KafkaFixtureBoundaryError(
            "KAFKA_FIXTURE_BOUNDARY_INVALID every MSK bootstrap endpoint must use IAM port 9098"
        )

    auth_mode = _required(
        environment.get("ASKLAKE_KAFKA_AUTH_MODE"),
        "ASKLAKE_KAFKA_AUTH_MODE",
    ).lower()
    if auth_mode != "iam":
        raise KafkaFixtureBoundaryError(
            "KAFKA_FIXTURE_BOUNDARY_INVALID ASKLAKE_KAFKA_AUTH_MODE must be iam"
        )

    static_credential_names = (
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
    )
    injected_credentials = [
        name for name in static_credential_names if str(environment.get(name) or "").strip()
    ]
    if injected_credentials:
        raise KafkaFixtureBoundaryError(
            "KAFKA_FIXTURE_BOUNDARY_INVALID static AWS credential environment is forbidden: "
            + ", ".join(injected_credentials)
        )

    topic = _required(
        environment.get("ASKLAKE_KAFKA_TOPIC") or source_path,
        "ASKLAKE_KAFKA_TOPIC",
    )
    consumer_group = _required(
        environment.get("ASKLAKE_KAFKA_CONSUMER_GROUP"),
        "ASKLAKE_KAFKA_CONSUMER_GROUP",
    )
    fixture_batch_id = _required(
        runtime_fixture_batch_id,
        "ASKLAKE_KAFKA_FIXTURE_BATCH_ID",
    )
    try:
        runtime_expected_count = int(
            _required(
                environment.get("ASKLAKE_KAFKA_EXPECTED_COUNT"),
                "ASKLAKE_KAFKA_EXPECTED_COUNT",
            )
        )
    except ValueError as exc:
        raise KafkaFixtureBoundaryError(
            "KAFKA_FIXTURE_BOUNDARY_INVALID ASKLAKE_KAFKA_EXPECTED_COUNT must be a positive integer"
        ) from exc
    if runtime_expected_count <= 0:
        raise KafkaFixtureBoundaryError(
            "KAFKA_FIXTURE_BOUNDARY_INVALID ASKLAKE_KAFKA_EXPECTED_COUNT must be a positive integer"
        )

    if topic != EKS_MVP_FIXTURE_TOPIC:
        raise KafkaFixtureBoundaryError(
            "KAFKA_FIXTURE_BOUNDARY_INVALID topic is outside the EKS MVP fixture boundary"
        )
    try:
        fixture_slot = fixture_slot_for_consumer_group(consumer_group, environment)
    except EksFixtureSlotConfigurationError as exc:
        raise KafkaFixtureBoundaryError(
            "KAFKA_FIXTURE_BOUNDARY_INVALID fixture slot configuration is invalid"
        ) from exc
    if fixture_slot is None:
        raise KafkaFixtureBoundaryError(
            "KAFKA_FIXTURE_BOUNDARY_INVALID consumer group is not an approved EKS fixture slot"
        )
    if iceberg_target is not None:
        target_table = (
            str(iceberg_target.get("table") or "").strip()
            if isinstance(iceberg_target, dict)
            else ""
        )
        if target_table != fixture_slot.iceberg_table:
            raise KafkaFixtureBoundaryError(
                "KAFKA_FIXTURE_BOUNDARY_INVALID Iceberg target does not match the approved fixture slot"
            )

    _require_equal(boundary, "topic", topic)
    _require_equal(boundary, "consumerGroup", consumer_group)
    _require_equal(boundary, "fixtureBatchId", fixture_batch_id)
    _required(boundary.get("snapshotId"), "sourceBoundary.snapshotId")

    try:
        expected_count = int(boundary.get("expectedCount"))
    except (TypeError, ValueError) as exc:
        raise KafkaFixtureBoundaryError(
            "KAFKA_FIXTURE_BOUNDARY_INVALID sourceBoundary.expectedCount must be a positive integer"
        ) from exc
    if expected_count <= 0:
        raise KafkaFixtureBoundaryError(
            "KAFKA_FIXTURE_BOUNDARY_INVALID sourceBoundary.expectedCount must be a positive integer"
        )
    if expected_count != runtime_expected_count:
        raise KafkaFixtureBoundaryError(
            "KAFKA_FIXTURE_BOUNDARY_INVALID sourceBoundary.expectedCount does not match the runtime value"
        )

    output_path = _normalized_path(
        _required(boundary.get("outputPath"), "sourceBoundary.outputPath")
    )
    checkpoint_path = _normalized_path(
        _required(boundary.get("checkpointPath"), "sourceBoundary.checkpointPath")
    )
    if _paths_overlap(output_path, checkpoint_path):
        raise KafkaFixtureBoundaryError(
            "KAFKA_FIXTURE_BOUNDARY_INVALID outputPath and checkpointPath must not overlap"
        )
    _require_mvp_path(output_path, EKS_MVP_OUTPUT_PREFIX, "outputPath")
    _require_mvp_path(checkpoint_path, EKS_MVP_CHECKPOINT_PREFIX, "checkpointPath")

    return {
        "broker": broker,
        "checkpointPath": checkpoint_path,
        "consumerGroup": consumer_group,
        "expectedCount": expected_count,
        "fixtureBatchId": fixture_batch_id,
        "icebergTable": fixture_slot.iceberg_table,
        "outputPath": output_path,
        "topic": topic,
    }


def validate_kafka_fixture_row_count(boundary, actual_count):
    if boundary is None:
        return
    actual = int(actual_count)
    expected = int(boundary["expectedCount"])
    if actual != expected:
        raise KafkaFixtureBoundaryError(
            "KAFKA_FIXTURE_EXPECTED_COUNT_MISMATCH "
            f"fixtureBatchId={boundary['fixtureBatchId']} expected={expected} actual={actual}"
        )


def _required(value, name):
    normalized = str(value or "").strip()
    if not normalized:
        raise KafkaFixtureBoundaryError(
            f"KAFKA_FIXTURE_BOUNDARY_INVALID {name} is required"
        )
    return normalized


def _require_equal(boundary, key, expected):
    actual = _required(boundary.get(key), f"sourceBoundary.{key}")
    if actual != expected:
        raise KafkaFixtureBoundaryError(
            "KAFKA_FIXTURE_BOUNDARY_INVALID "
            f"sourceBoundary.{key} does not match the runtime value"
        )


def _normalized_path(value):
    return value.rstrip("/")


def _paths_overlap(first, second):
    return first == second or first.startswith(f"{second}/") or second.startswith(f"{first}/")


def _require_mvp_path(value, prefix, field):
    pattern = rf"s3a://[^/]+/{re.escape(prefix)}/[^/]+"
    if not re.fullmatch(pattern, value):
        raise KafkaFixtureBoundaryError(
            f"KAFKA_FIXTURE_BOUNDARY_INVALID {field} is outside the EKS MVP fixture prefix"
        )
