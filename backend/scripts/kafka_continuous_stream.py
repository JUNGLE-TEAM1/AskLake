"""Long-running Kafka to Iceberg Structured Streaming worker for AskLake."""

import hashlib
import json
import os
import re
import signal
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from pyspark.sql import DataFrame, SparkSession
from pyspark.sql.functions import array, array_except, array_union, col, concat, current_timestamp, explode, from_json, get_json_object, input_file_name, lit, map_keys, min as spark_min, max as spark_max, size, transform, when
from pyspark.sql.types import BooleanType, DoubleType, LongType, MapType, StringType, StructField, StructType, TimestampType

from kafka_schema_paths import build_nested_schema_tree, expected_object_keys, json_path, split_source_path
from object_storage_runtime import configure_spark_hadoop
from snapshot_rule_runtime import SnapshotRuleExecutionError, apply_snapshot_rules, supports_snapshot_rules
from spark_job_run import (
    commit_iceberg_table,
    iceberg_source_boundary_exists,
    make_spark,
    parse_iceberg_target,
)


def json_object_env(name: str) -> dict[str, Any]:
    try:
        value = json.loads(os.environ.get(name, "{}"))
    except json.JSONDecodeError:
        return {}
    return value if isinstance(value, dict) else {}


def json_array_env(name: str) -> list[Any]:
    try:
        value = json.loads(os.environ.get(name, "[]"))
    except json.JSONDecodeError:
        return []
    return value if isinstance(value, list) else []


def canonical_hash(value: Any) -> str:
    payload = json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def bounded_int_env(name: str, default: int, *, minimum: int, maximum: int) -> int:
    try:
        value = int(os.environ.get(name, str(default)))
    except ValueError:
        value = default
    return max(minimum, min(value, maximum))


def normalize_stream_partition_cursors(value: Any) -> dict[tuple[str, int], int]:
    cursors: dict[tuple[str, int], int] = {}
    if not isinstance(value, list):
        return cursors
    for item in value:
        if not isinstance(item, dict):
            continue
        topic = str(item.get("topic") or "").strip()
        try:
            partition = int(item.get("partition"))
            next_offset = int(item.get("nextOffset"))
        except (TypeError, ValueError):
            continue
        if not topic or partition < 0 or next_offset < 0:
            continue
        key = (topic, partition)
        cursors[key] = max(cursors.get(key, 0), next_offset)
    return cursors


def stream_partition_cursor_payload(
    cursors: dict[tuple[str, int], int],
) -> list[dict[str, Any]]:
    return [
        {"topic": topic, "partition": partition, "nextOffset": next_offset}
        for (topic, partition), next_offset in sorted(cursors.items())
    ]


JOB_ID = os.environ["ASKLAKE_CONTINUOUS_JOB_ID"]
WORKER_ATTEMPT_ID = os.environ.get("ASKLAKE_CONTINUOUS_WORKER_ATTEMPT_ID")
REPORT_FILE = Path(os.environ["ASKLAKE_CONTINUOUS_REPORT_FILE"])
COMMAND_FILE = Path(os.environ["ASKLAKE_CONTINUOUS_COMMAND_FILE"])
STOP_REQUESTED = False
QUERY = None
INITIAL_COUNTS = json.loads(os.environ.get("ASKLAKE_CONTINUOUS_INITIAL_COUNTS", "{}"))
INITIAL_METRICS = json_object_env("ASKLAKE_CONTINUOUS_INITIAL_METRICS")
INITIAL_SCHEMA_STATE = json_object_env("ASKLAKE_CONTINUOUS_INITIAL_SCHEMA_STATE")
STREAM_PARTITION_CURSORS = normalize_stream_partition_cursors(
    json_array_env("ASKLAKE_CONTINUOUS_STREAM_PARTITION_CURSORS")
)
RULE_CONTRACT_VERSION = os.environ.get("ASKLAKE_CONTINUOUS_RULE_CONTRACT_VERSION", "1.0")
RULES = [rule for rule in json_array_env("ASKLAKE_CONTINUOUS_RULES") if isinstance(rule, dict)]
RULE_OUTPUT_SCHEMA = [item for item in json_array_env("ASKLAKE_CONTINUOUS_RULE_OUTPUT_SCHEMA") if isinstance(item, (list, tuple)) and len(item) >= 2]
RULE_FINGERPRINT = canonical_hash({"contractVersion": RULE_CONTRACT_VERSION, "rules": RULES})
EXPECTED_RULE_FINGERPRINT = os.environ.get("ASKLAKE_CONTINUOUS_RULE_FINGERPRINT", "")
EXPECTED_SCHEMA_FINGERPRINT = os.environ.get("ASKLAKE_CONTINUOUS_EXPECTED_SCHEMA_FINGERPRINT", "")
SCHEMA_POLICY = {
    "additiveNullable": "allow",
    "missingRequired": "quarantine",
    "incompatibleType": "quarantine",
    "unknownField": "preserve",
    **json_object_env("ASKLAKE_CONTINUOUS_SCHEMA_POLICY"),
}
COUNTERS = {
    "consumedCount": int(INITIAL_COUNTS.get("consumedCount") or 0),
    "storedCount": int(INITIAL_COUNTS.get("storedCount") or 0),
    "quarantinedCount": int(INITIAL_COUNTS.get("quarantinedCount") or 0),
    "failedCount": int(INITIAL_COUNTS.get("failedCount") or 0),
}
LAST_BATCH_ID: int | None = None
LAST_FLUSH_AT: str | None = None
LAST_BATCH_STORED_COUNT = 0
LAST_BATCH_QUARANTINED_COUNT = 0
LAST_BATCH_WRITTEN = False
PROCESSED_OFFSETS: dict[str, int] = {}
PUBLISHED_BATCHES: list[dict[str, Any]] = []
PUBLISHED_BATCH_LIMIT = bounded_int_env(
    "ASKLAKE_CONTINUOUS_PUBLICATION_WINDOW",
    100,
    minimum=1,
    maximum=1_000,
)
PUBLISHED_BACKLOG_COUNT = 0
CATALOG_ACK_BATCH_ID = -1
LATEST_DURABLE_BATCH_ID = -1
RECOVERY_SPARK: SparkSession | None = None
RECOVERY_ROOT: str | None = None
METRICS: dict[str, Any] = {
    "lag": None,
    "lagAvailable": False,
    "maxPartitionLag": None,
    "laggingPartitionCount": 0,
    "partitionProgress": {},
    "lastBatchDurationMs": None,
    "lastBatchInputRows": 0,
    "throughputRowsPerSecond": None,
    "replayedCount": 0,
    **INITIAL_METRICS,
}
SCHEMA_STATE: dict[str, Any] = {
    "schemaVersion": 1,
    "schemaFingerprint": None,
    "schemaStatus": "stable",
    "schemaChanges": [],
    **INITIAL_SCHEMA_STATE,
}
RULE_METRICS: dict[str, int] = {
    "failedBatchCount": 0,
    "qualityDroppedCount": 0,
    "qualityInvalidCount": 0,
    "qualityQuarantinedCount": 0,
    "qualitySetNullCount": 0,
    "qualityWarnCount": 0,
    "transformDroppedCount": 0,
    "transformErrorCount": 0,
    "transformQuarantinedCount": 0,
    "transformSetNullCount": 0,
    "transformWarnCount": 0,
    **(
        {
            key: int(value or 0)
            for key, value in INITIAL_METRICS.get("ruleMetrics", {}).items()
            if key in {
                "failedBatchCount",
                "qualityDroppedCount",
                "qualityInvalidCount",
                "qualityQuarantinedCount",
                "qualitySetNullCount",
                "qualityWarnCount",
                "transformDroppedCount",
                "transformErrorCount",
                "transformQuarantinedCount",
                "transformSetNullCount",
                "transformWarnCount",
            }
        }
        if isinstance(INITIAL_METRICS.get("ruleMetrics"), dict)
        else {}
    ),
}
LAST_RULE_RESULT: dict[str, Any] = (
    dict(INITIAL_METRICS.get("lastRuleResult") or {})
    if isinstance(INITIAL_METRICS.get("lastRuleResult"), dict)
    else {}
)
RUNTIME_FINGERPRINT: str | None = None
LAST_BATCH_EVIDENCE: dict[str, Any] = (
    dict(INITIAL_METRICS.get("lastBatchEvidence") or {})
    if isinstance(INITIAL_METRICS.get("lastBatchEvidence"), dict)
    else {}
)
CURRENT_BATCH_CONTEXT: dict[str, Any] = {}


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def duration_label(value: Any) -> str:
    try:
        duration_ms = max(0, int(value or 0))
    except (TypeError, ValueError):
        duration_ms = 0
    return f"{duration_ms:,}ms"


def source_ranges_label(ranges: Any) -> str:
    if not isinstance(ranges, list) or not ranges:
        return "-"
    return ", ".join(
        f"{int(item.get('partition') or 0)}:{int(item.get('startOffset') or 0)}-{int(item.get('endOffset') or 0)}"
        for item in ranges if isinstance(item, dict)
    ) or "-"


def configured_rule_count(kind: str) -> int:
    return sum(
        1 for rule in RULES
        if rule.get("kind") == kind and rule.get("enabled") is not False
    )


def dag_step(
    step_id: str,
    title: str,
    status: str,
    meta: str,
    *,
    completed_at: str | None = None,
    details: list[list[str]] | None = None,
    duration_ms: Any = None,
    logs: list[str] | None = None,
    note: str | None = None,
) -> dict[str, Any]:
    step = {
        "id": step_id,
        "title": title,
        "status": status,
        "meta": meta,
        "details": details or [],
    }
    if completed_at and status in {"success", "failed"}:
        step["completedAt"] = completed_at
    if duration_ms is not None and status in {"success", "failed"}:
        step["duration"] = duration_label(duration_ms)
    if logs:
        step["logs"] = [str(message)[:2000] for message in logs if message]
    if note:
        step["note"] = note
    return step


def build_batch_dag_steps(
    *,
    status: str,
    consumed_count: int,
    schema_accepted_count: int,
    schema_quarantined_count: int,
    stored_count: int,
    quarantined_count: int,
    source_ranges: list[dict[str, Any]],
    transform: dict[str, Any] | None = None,
    quality: dict[str, Any] | None = None,
    durations: dict[str, Any] | None = None,
    completed_at: str | None = None,
    data_path: str | None = None,
    manifest_path_value: str | None = None,
    checkpoint_path: str | None = None,
    iceberg_commit: dict[str, Any] | None = None,
    failed_stage: str | None = None,
    error: str | None = None,
    catalog_status: str = "pending",
) -> list[dict[str, Any]]:
    transform = transform or {}
    quality = quality or {}
    durations = durations or {}
    transform_count = int(transform.get("configuredStepCount") or configured_rule_count("transform"))
    quality_count = int(quality.get("configuredRuleCount") or configured_rule_count("quality"))
    order = ["source", "schema", "transform", "quality", "target", "manifest-checkpoint", "catalog"]
    failed_index = order.index(failed_stage) if failed_stage in order else -1

    def stage_status(stage: str) -> str:
        index = order.index(stage)
        if status == "failed" and failed_index >= 0:
            if index < failed_index:
                return "success"
            if index == failed_index:
                return "failed"
            return "blocked"
        if stage == "catalog":
            return catalog_status
        return "success" if status == "success" else "pending"

    def stage_error(stage: str) -> list[str] | None:
        return [error] if error and stage_status(stage) == "failed" else None

    transform_note = "설정된 변환 규칙이 없어 입력을 그대로 전달했습니다." if transform_count == 0 else None
    quality_note = "설정된 품질 규칙이 없어 입력을 그대로 전달했습니다." if quality_count == 0 else None
    completed = completed_at or now()
    iceberg_commit = iceberg_commit or {}
    iceberg_target = iceberg_commit.get("target") if isinstance(iceberg_commit.get("target"), dict) else {}
    steps = [
        dag_step(
            "source", "1. Source", stage_status("source"), f"Kafka {consumed_count:,}건 소비",
            completed_at=completed, duration_ms=durations.get("sourceDurationMs"), logs=stage_error("source"),
            details=[["입력 행", f"{consumed_count:,}"], ["Offset 범위", source_ranges_label(source_ranges)]],
        ),
        dag_step(
            "schema", "2. Schema", stage_status("schema"), f"통과 {schema_accepted_count:,} · 격리 {schema_quarantined_count:,}",
            completed_at=completed, duration_ms=durations.get("schemaDurationMs"), logs=stage_error("schema"),
            details=[["입력 행", f"{consumed_count:,}"], ["스키마 통과", f"{schema_accepted_count:,}"], ["스키마 격리", f"{schema_quarantined_count:,}"], ["Schema fingerprint", str(SCHEMA_STATE.get("schemaFingerprint") or "-")]],
        ),
        dag_step(
            "transform", "3. Transform", stage_status("transform"), "pass-through" if transform_count == 0 else f"규칙 {transform_count:,}개 적용",
            completed_at=completed, duration_ms=durations.get("transformDurationMs"), logs=stage_error("transform"), note=transform_note,
            details=[["설정 규칙", f"{transform_count:,}"], ["오류 행", f"{int(transform.get('errorCount') or 0):,}"], ["격리 행", f"{int(transform.get('quarantinedCount') or 0):,}"], ["제거 행", f"{int(transform.get('droppedCount') or 0):,}"]],
        ),
        dag_step(
            "quality", "4. Quality", stage_status("quality"), "pass-through" if quality_count == 0 else str(quality.get("summary") or f"규칙 {quality_count:,}개 평가"),
            completed_at=completed, duration_ms=durations.get("qualityDurationMs"), logs=stage_error("quality"), note=quality_note,
            details=[["설정 규칙", f"{quality_count:,}"], ["평가 행", f"{int(quality.get('evaluatedRowCount') or 0):,}"], ["위반 행", f"{int(quality.get('invalidRowCount') or 0):,}"], ["통과율", f"{float(quality.get('passRate') or 0):.1f}%"]],
        ),
        dag_step(
            "target", "5. Target", stage_status("target"), f"Iceberg {stored_count:,}건 커밋",
            completed_at=completed, duration_ms=durations.get("targetDurationMs"), logs=stage_error("target"),
            details=[
                ["출력 행", f"{stored_count:,}"],
                ["전체 격리", f"{quarantined_count:,}"],
                ["Table", str(iceberg_target.get("tableUri") or data_path or "-")],
                ["Snapshot", str(iceberg_commit.get("snapshotId") or ("변경 없음" if stored_count == 0 else "-"))],
            ],
        ),
        dag_step(
            "manifest-checkpoint", "6. Manifest / Checkpoint", stage_status("manifest-checkpoint"), "publication과 offset 근거 저장",
            completed_at=completed, duration_ms=durations.get("manifestDurationMs"), logs=stage_error("manifest-checkpoint"),
            details=[["Manifest", manifest_path_value or "-"], ["Checkpoint", checkpoint_path or "-"]],
        ),
        dag_step(
            "catalog", "7. Catalog", stage_status("catalog"), "Catalog 반영 완료" if catalog_status == "success" else "Catalog 반영 대기",
            completed_at=completed if catalog_status == "success" else None,
            details=[["상태", "반영 완료" if catalog_status == "success" else "반영 대기"]],
        ),
    ]
    return steps


def build_batch_evidence(**values: Any) -> dict[str, Any]:
    batch_id = int(values.get("batch_id") or 0)
    status = str(values.get("status") or "success")
    evidence = {
        "batchId": batch_id,
        "status": status,
        "publishedAt": values.get("completed_at"),
        "consumedCount": int(values.get("consumed_count") or 0),
        "storedCount": int(values.get("stored_count") or 0),
        "quarantinedCount": int(values.get("quarantined_count") or 0),
        "durationMs": int(values.get("duration_ms") or 0),
        "sourceRanges": values.get("source_ranges") or [],
        "sourceBoundary": values.get("source_boundary") or {},
        "runId": values.get("run_id"),
        "dataPath": values.get("data_path"),
        "icebergCommit": values.get("iceberg_commit"),
        "quarantinePath": values.get("quarantine_path"),
        "manifestPath": values.get("manifest_path_value"),
        "lastError": values.get("error"),
    }
    evidence["dagSteps"] = build_batch_dag_steps(
        status=status,
        consumed_count=evidence["consumedCount"],
        schema_accepted_count=int(values.get("schema_accepted_count") or 0),
        schema_quarantined_count=int(values.get("schema_quarantined_count") or 0),
        stored_count=evidence["storedCount"],
        quarantined_count=evidence["quarantinedCount"],
        source_ranges=evidence["sourceRanges"],
        transform=values.get("transform"),
        quality=values.get("quality"),
        durations=values.get("durations"),
        completed_at=values.get("completed_at"),
        data_path=values.get("data_path"),
        manifest_path_value=values.get("manifest_path_value"),
        checkpoint_path=values.get("checkpoint_path"),
        iceberg_commit=values.get("iceberg_commit"),
        failed_stage=values.get("failed_stage"),
        error=values.get("error"),
        catalog_status=str(values.get("catalog_status") or "pending"),
    )
    return evidence


def fail_current_batch(error: Exception) -> None:
    global LAST_BATCH_EVIDENCE
    if not CURRENT_BATCH_CONTEXT:
        return
    if (
        LAST_BATCH_EVIDENCE.get("status") == "failed"
        and int(LAST_BATCH_EVIDENCE.get("batchId") or -1) == int(CURRENT_BATCH_CONTEXT.get("batch_id") or -2)
    ):
        return
    context = {**CURRENT_BATCH_CONTEXT}
    context.update({
        "status": "failed",
        "completed_at": now(),
        "duration_ms": max(0, round((time.monotonic() - float(context.get("batch_started_at") or time.monotonic())) * 1000)),
        "error": str(error)[:2000],
        "failed_stage": str(context.get("current_stage") or "target"),
    })
    LAST_BATCH_EVIDENCE = build_batch_evidence(**context)


def catalog_ack_batch_id() -> int:
    ack_path = REPORT_FILE.with_suffix(".catalog-ack.json")
    try:
        payload = json.loads(ack_path.read_text(encoding="utf-8"))
        return int(payload.get("batchId"))
    except (OSError, TypeError, ValueError, json.JSONDecodeError):
        return -1


def apply_catalog_ack() -> None:
    global CATALOG_ACK_BATCH_ID, PUBLISHED_BACKLOG_COUNT, PUBLISHED_BATCHES
    acknowledged_batch = catalog_ack_batch_id()
    if acknowledged_batch <= CATALOG_ACK_BATCH_ID:
        return
    previous_acknowledged_batch = CATALOG_ACK_BATCH_ID
    CATALOG_ACK_BATCH_ID = acknowledged_batch
    PUBLISHED_BATCHES = [
        item for item in PUBLISHED_BATCHES
        if int(item.get("batchId") or 0) > acknowledged_batch
    ]
    acknowledged_count = max(
        0,
        min(acknowledged_batch, LATEST_DURABLE_BATCH_ID)
        - previous_acknowledged_batch,
    )
    PUBLISHED_BACKLOG_COUNT = max(0, PUBLISHED_BACKLOG_COUNT - acknowledged_count)

    # The report already holds the first bounded window of durable publications.
    # Advancing the Catalog ACK must not rescan every historical manifest: that
    # turns each micro-batch into O(total batch history) Spark jobs. Only refill
    # the slots that fell out of the in-memory window.
    if (
        RECOVERY_SPARK is not None
        and RECOVERY_ROOT
        and len(PUBLISHED_BATCHES) < PUBLISHED_BATCH_LIMIT
        and PUBLISHED_BACKLOG_COUNT > len(PUBLISHED_BATCHES)
    ):
        loaded_batch_ids = [int(item.get("batchId") or 0) for item in PUBLISHED_BATCHES]
        next_batch_id = max(
            acknowledged_batch + 1,
            (max(loaded_batch_ids) + 1) if loaded_batch_ids else acknowledged_batch + 1,
        )
        last_batch_id = min(
            LATEST_DURABLE_BATCH_ID,
            next_batch_id + (PUBLISHED_BATCH_LIMIT - len(PUBLISHED_BATCHES)) - 1,
        )
        manifest_paths: list[tuple[int, str]] = []
        for batch_id in range(next_batch_id, last_batch_id + 1):
            path = manifest_path(RECOVERY_ROOT, batch_id)
            if not output_committed(RECOVERY_SPARK, path):
                break
            manifest_paths.append((batch_id, path))
        PUBLISHED_BATCHES.extend(
            load_committed_manifests(
                RECOVERY_SPARK,
                RECOVERY_ROOT,
                manifest_paths,
            )
        )
        PUBLISHED_BATCHES = sorted(
            PUBLISHED_BATCHES,
            key=lambda item: int(item.get("batchId") or 0),
        )[:PUBLISHED_BATCH_LIMIT]


def remember_published_batch(publication: dict[str, Any]) -> None:
    global LATEST_DURABLE_BATCH_ID, PUBLISHED_BACKLOG_COUNT, PUBLISHED_BATCHES
    batch_id = int(publication.get("batchId") or 0)
    if batch_id > LATEST_DURABLE_BATCH_ID:
        LATEST_DURABLE_BATCH_ID = batch_id
        if batch_id > CATALOG_ACK_BATCH_ID:
            PUBLISHED_BACKLOG_COUNT += 1
    existing = [
        item
        for item in PUBLISHED_BATCHES
        if int(item.get("batchId") or 0) != batch_id
    ]
    if batch_id > CATALOG_ACK_BATCH_ID:
        existing.append(publication)
    PUBLISHED_BATCHES = sorted(
        existing,
        key=lambda item: int(item.get("batchId") or 0),
    )[:PUBLISHED_BATCH_LIMIT]


def report(status: str, *, batch_id: int | None = None, error: str | None = None) -> None:
    global LAST_BATCH_ID, LAST_FLUSH_AT
    if batch_id is not None:
        LAST_BATCH_ID = batch_id
        LAST_FLUSH_AT = now()
    apply_catalog_ack()
    REPORT_FILE.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "status": status,
        "workerAttemptId": WORKER_ATTEMPT_ID,
        "heartbeatAt": now(),
        "lastFlushAt": LAST_FLUSH_AT,
        "lastBatchId": str(LAST_BATCH_ID) if LAST_BATCH_ID is not None else None,
        "lastBatchStoredCount": LAST_BATCH_STORED_COUNT,
        "lastBatchQuarantinedCount": LAST_BATCH_QUARANTINED_COUNT,
        "lastBatchWritten": LAST_BATCH_WRITTEN,
        "publishedBatches": PUBLISHED_BATCHES,
        "publicationBacklogCount": PUBLISHED_BACKLOG_COUNT,
        "publicationWindowLimit": PUBLISHED_BATCH_LIMIT,
        "catalogAckBatchId": CATALOG_ACK_BATCH_ID if CATALOG_ACK_BATCH_ID >= 0 else None,
        **METRICS,
        **SCHEMA_STATE,
        **COUNTERS,
        "ruleContractVersion": RULE_CONTRACT_VERSION,
        "ruleFingerprint": RULE_FINGERPRINT,
        "runtimeFingerprint": RUNTIME_FINGERPRINT,
        "ruleMetrics": RULE_METRICS,
        "lastRuleResult": LAST_RULE_RESULT,
        "lastBatchEvidence": LAST_BATCH_EVIDENCE,
        "lastError": error,
    }
    temp_file = REPORT_FILE.with_suffix(".tmp")
    temp_file.write_text(json.dumps(payload), encoding="utf-8")
    temp_file.replace(REPORT_FILE)


def requested_action() -> str:
    try:
        raw = COMMAND_FILE.read_text(encoding="utf-8").strip()
        return str(json.loads(raw).get("action") or "") if raw else ""
    except (OSError, json.JSONDecodeError):
        return ""


def on_signal(_signum: int, _frame: Any) -> None:
    global STOP_REQUESTED
    STOP_REQUESTED = True
    if QUERY is not None:
        QUERY.stop()


def spark_type(value: str):
    normalized = str(value or "string").lower()
    if normalized in {"integer", "int", "long", "bigint"}:
        return LongType()
    if normalized in {"float", "double", "decimal"}:
        return DoubleType()
    if normalized in {"boolean", "bool"}:
        return BooleanType()
    if normalized in {"timestamp", "datetime", "date"}:
        return TimestampType()
    return StringType()


def struct_type_from_tree(tree: dict[str, Any]) -> StructType:
    return StructType([
        StructField(name, struct_type_from_tree(value) if isinstance(value, dict) else value, True)
        for name, value in tree.items()
    ])


def nested_payload_column(source_path: str):
    value = col("payload")
    for segment in split_source_path(source_path):
        value = value.getField(segment)
    return value


def raw_source_value(source_path: str):
    return get_json_object(col("raw_payload"), json_path(source_path))


def unknown_field_expressions(expected_keys_by_parent: dict[str, list[str]]):
    unknown_condition = lit(False)
    unknown_keys = None
    empty_array = array().cast("array<string>")
    for parent_path, expected_keys in expected_keys_by_parent.items():
        raw_object = from_json(
            col("raw_payload") if not parent_path else get_json_object(col("raw_payload"), json_path(parent_path)),
            MapType(StringType(), StringType()),
        )
        object_unknown_keys = array_except(map_keys(raw_object), array(*[lit(key) for key in expected_keys]))
        object_unknown_keys = when(raw_object.isNotNull(), object_unknown_keys).otherwise(empty_array)
        unknown_condition = unknown_condition | (size(object_unknown_keys) > 0)
        if parent_path:
            object_unknown_keys = transform(
                object_unknown_keys,
                lambda field: concat(lit(f"{parent_path}."), field),
            )
        unknown_keys = object_unknown_keys if unknown_keys is None else array_union(unknown_keys, object_unknown_keys)
    return unknown_condition, unknown_keys if unknown_keys is not None else empty_array


def source_schema() -> tuple[StructType, list[tuple[str, str]], list[str]]:
    columns = json.loads(os.environ.get("ASKLAKE_CONTINUOUS_SCHEMA_COLUMNS", "[]"))
    selected = [column for column in columns if column.get("included", True)]
    bindings = []
    aliases = []
    required = []
    column_contracts = []
    for column_def in selected:
        source = str(column_def.get("sourceName") or column_def.get("targetName") or "").strip()
        target = str(column_def.get("targetName") or source).strip()
        if source and target:
            source_type = str(column_def.get("sourceType") or column_def.get("type") or "string")
            target_type = str(column_def.get("type") or source_type)
            field_type = spark_type(source_type)
            bindings.append((source, field_type))
            aliases.append((source, target))
            if not bool(column_def.get("nullable", False)):
                required.append(source)
            column_contracts.append({
                "required": source in required,
                "source": source,
                "sourceType": field_type.simpleString(),
                "target": target,
                "targetType": spark_type(target_type).simpleString(),
            })
    if not bindings:
        bindings.append(("value", StringType()))
        aliases.append(("value", "value"))
        column_contracts.append({
            "required": False,
            "source": "value",
            "sourceType": "string",
            "target": "value",
            "targetType": "string",
        })
    schema_tree = build_nested_schema_tree(bindings)
    previous_fingerprint = SCHEMA_STATE.get("schemaFingerprint")
    fingerprint = canonical_hash(column_contracts)
    if previous_fingerprint and previous_fingerprint != fingerprint:
        SCHEMA_STATE["schemaVersion"] = int(SCHEMA_STATE.get("schemaVersion") or 1) + 1
        SCHEMA_STATE["schemaStatus"] = "expected_schema_changed"
        SCHEMA_STATE["schemaChanges"] = [{"kind": "configured_schema_changed", "from": previous_fingerprint, "to": fingerprint}]
    SCHEMA_STATE["schemaFingerprint"] = fingerprint
    return struct_type_from_tree(schema_tree), aliases, required


def decode_offsets(value: Any) -> dict[str, Any]:
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return {}
    return value if isinstance(value, dict) else {}


def refresh_query_metrics(query: Any) -> None:
    progress = query.lastProgress or {}
    sources = progress.get("sources") or []
    source = sources[0] if sources else {}
    latest_by_topic = decode_offsets(source.get("latestOffset"))
    latest = latest_by_topic.get(os.environ["ASKLAKE_CONTINUOUS_TOPIC"], {})
    partition_progress = {}
    for partition, processed in PROCESSED_OFFSETS.items():
        reported_latest = int(latest.get(str(partition), processed)) if isinstance(latest, dict) else processed
        latest_offset = max(reported_latest, processed)
        lag = max(latest_offset - processed, 0)
        partition_progress[str(partition)] = {"processedOffset": processed, "latestOffset": latest_offset, "lag": lag}
    lags = [item["lag"] for item in partition_progress.values()]
    duration_ms = int((progress.get("durationMs") or {}).get("triggerExecution") or progress.get("batchDuration") or 0)
    input_rows = int(progress.get("numInputRows") or 0)
    if partition_progress:
        METRICS.update({
            "lag": sum(lags),
            "lagAvailable": True,
            "maxPartitionLag": max(lags),
            "laggingPartitionCount": sum(1 for lag in lags if lag > 0),
            "partitionProgress": partition_progress,
        })
    if progress and input_rows > 0:
        METRICS.update({
            "lastBatchDurationMs": duration_ms or METRICS.get("lastBatchDurationMs"),
            "lastBatchInputRows": input_rows,
            "throughputRowsPerSecond": round(input_rows / (duration_ms / 1000), 2) if duration_ms else METRICS.get("throughputRowsPerSecond"),
        })


def configure_s3a(spark: SparkSession) -> None:
    hadoop = spark.sparkContext._jsc.hadoopConfiguration()
    configure_spark_hadoop(hadoop)


def path_exists(spark: SparkSession, output_path: str) -> bool:
    jvm = spark.sparkContext._jvm
    hadoop = spark.sparkContext._jsc.hadoopConfiguration()
    path = jvm.org.apache.hadoop.fs.Path(output_path)
    return bool(path.getFileSystem(hadoop).exists(path))


def output_committed(spark: SparkSession, output_path: str) -> bool:
    return path_exists(spark, f"{output_path.rstrip('/')}/_SUCCESS")


def delete_incomplete_output(spark: SparkSession, output_path: str) -> None:
    if not path_exists(spark, output_path) or output_committed(spark, output_path):
        return
    jvm = spark.sparkContext._jvm
    hadoop = spark.sparkContext._jsc.hadoopConfiguration()
    path = jvm.org.apache.hadoop.fs.Path(output_path)
    if not path.getFileSystem(hadoop).delete(path, True):
        raise RuntimeError(f"Could not remove incomplete publication: {output_path}")


def delete_output(spark: SparkSession, output_path: str) -> None:
    if not path_exists(spark, output_path):
        return
    jvm = spark.sparkContext._jvm
    hadoop = spark.sparkContext._jsc.hadoopConfiguration()
    path = jvm.org.apache.hadoop.fs.Path(output_path)
    if not path.getFileSystem(hadoop).delete(path, True):
        raise RuntimeError(f"Could not remove stale publication: {output_path}")


def checkpoint_contract_path(checkpoint_path: str) -> str:
    return f"{checkpoint_path.rstrip('/')}/_asklake_contract"


def continuous_runtime_contract(output_path: str, iceberg_target: dict[str, Any]) -> dict[str, Any]:
    output_schema = [
        {"name": str(item[0]), "type": str(item[1])}
        for item in RULE_OUTPUT_SCHEMA
    ]
    contract = {
        "consumerGroupId": os.environ["ASKLAKE_CONTINUOUS_CONSUMER_GROUP_ID"],
        "jobId": JOB_ID,
        "icebergTarget": iceberg_target,
        "outputPath": output_path.rstrip("/"),
        "outputSchema": output_schema,
        "ruleContractVersion": RULE_CONTRACT_VERSION,
        "ruleFingerprint": RULE_FINGERPRINT,
        "persistedSchemaFingerprint": EXPECTED_SCHEMA_FINGERPRINT or None,
        "schemaFingerprint": SCHEMA_STATE.get("schemaFingerprint"),
        "topic": os.environ["ASKLAKE_CONTINUOUS_TOPIC"],
    }
    return {**contract, "runtimeFingerprint": canonical_hash(contract)}


def ensure_checkpoint_contract(
    spark: SparkSession,
    checkpoint_path: str,
    output_path: str,
    iceberg_target: dict[str, Any],
) -> None:
    global RUNTIME_FINGERPRINT
    if EXPECTED_RULE_FINGERPRINT and EXPECTED_RULE_FINGERPRINT != RULE_FINGERPRINT:
        raise RuntimeError("Continuous rule fingerprint differs between the control plane and worker payload.")
    if not supports_snapshot_rules(RULES):
        raise RuntimeError("Continuous worker received a stateful or unsupported canonical Rule.")
    contract = continuous_runtime_contract(output_path, iceberg_target)
    RUNTIME_FINGERPRINT = str(contract["runtimeFingerprint"])
    path = checkpoint_contract_path(checkpoint_path)
    if output_committed(spark, path):
        row = spark.read.json(path).first()
        persisted = row.asDict(recursive=True) if row is not None else {}
        if str(persisted.get("runtimeFingerprint") or "") != RUNTIME_FINGERPRINT:
            raise RuntimeError(
                "Continuous checkpoint contract fingerprint mismatch; stop and copy the Job to use a new checkpoint."
            )
        return
    delete_incomplete_output(spark, path)
    frame = spark.read.json(spark.sparkContext.parallelize([json.dumps(contract)]))
    frame.write.mode("errorifexists").json(path)
    if not output_committed(spark, path):
        raise RuntimeError(f"Checkpoint contract did not produce a completion marker: {path}")


def quoted_column(name: str):
    return col(f"`{str(name).replace('`', '``')}`")


def normalized_column_name(value: str) -> str:
    return re.sub(r"[^0-9A-Za-z_]+", "_", str(value or "").strip().lower()).strip("_")


def resolve_frame_column(frame: DataFrame, name: str) -> str:
    if name in frame.columns:
        return name
    normalized = normalized_column_name(name)
    return normalized if normalized in frame.columns else ""


def select_continuous_target(frame: DataFrame) -> DataFrame:
    output_columns = []
    for item in RULE_OUTPUT_SCHEMA:
        name = str(item[0]).strip()
        resolved = resolve_frame_column(frame, name)
        if not resolved:
            raise RuntimeError(f"Continuous Rule output is missing compiled target column: {name}")
        output_columns.append(quoted_column(resolved).alias(name))
    if not output_columns:
        output_columns = [
            quoted_column(name)
            for name in frame.columns
            if name not in {"topic", "kafka_partition", "kafka_offset", "kafka_timestamp", "raw_payload", "ingested_at"}
        ]
    return frame.select(
        *output_columns,
        col("kafka_timestamp").cast("timestamp").alias("kafka_timestamp"),
        col("kafka_partition").cast("int").alias("kafka_partition"),
        col("kafka_offset").cast("long").alias("kafka_offset"),
        col("ingested_at").cast("timestamp").alias("ingested_at"),
    )


def schema_quarantine_rows(
    invalid: DataFrame,
    malformed: Any,
    required_missing: Any,
    incompatible_type: Any,
    unknown_condition: Any,
) -> DataFrame:
    return invalid.select(
        col("topic").cast("string").alias("topic"),
        col("partition").cast("int").alias("partition"),
        col("offset").cast("long").alias("offset"),
        col("kafka_timestamp").cast("timestamp").alias("kafka_timestamp"),
        col("raw_payload").cast("string").alias("raw_payload"),
        lit("").alias("event_id"),
        col("raw_payload").alias("record"),
        when(malformed, lit("malformed_json"))
        .when(required_missing, lit("missing_required"))
        .when(incompatible_type, lit("incompatible_type"))
        .when(unknown_condition, lit("unknown_field"))
        .otherwise(lit("schema_policy_rejected")).alias("reason"),
        lit("").alias("ruleId"),
        lit("schema").alias("stage"),
        lit("").alias("targetColumn"),
        lit(SCHEMA_STATE["schemaFingerprint"]).alias("schema_fingerprint"),
        lit(RULE_FINGERPRINT).alias("rule_fingerprint"),
        current_timestamp().alias("quarantined_at"),
    )


def rule_quarantine_rows(frame: DataFrame) -> DataFrame:
    return frame.select(
        col("topic").cast("string").alias("topic"),
        col("partition").cast("int").alias("partition"),
        col("offset").cast("long").alias("offset"),
        col("kafka_timestamp").cast("timestamp").alias("kafka_timestamp"),
        col("raw_payload").cast("string").alias("raw_payload"),
        col("event_id").cast("string").alias("event_id"),
        col("record").cast("string").alias("record"),
        col("reason").cast("string").alias("reason"),
        col("ruleId").cast("string").alias("ruleId"),
        col("stage").cast("string").alias("stage"),
        col("targetColumn").cast("string").alias("targetColumn"),
        lit(SCHEMA_STATE["schemaFingerprint"]).alias("schema_fingerprint"),
        lit(RULE_FINGERPRINT).alias("rule_fingerprint"),
        current_timestamp().alias("quarantined_at"),
    )


def update_rule_metrics(transform_result: dict[str, Any], quality_result: dict[str, Any], *, failed: bool = False) -> None:
    global LAST_RULE_RESULT
    mappings = {
        "qualityDroppedCount": (quality_result, "droppedCount"),
        "qualityInvalidCount": (quality_result, "invalidRowCount"),
        "qualityQuarantinedCount": (quality_result, "quarantinedCount"),
        "qualitySetNullCount": (quality_result, "setNullCount"),
        "qualityWarnCount": (quality_result, "warnCount"),
        "transformDroppedCount": (transform_result, "droppedCount"),
        "transformErrorCount": (transform_result, "errorCount"),
        "transformQuarantinedCount": (transform_result, "quarantinedCount"),
        "transformSetNullCount": (transform_result, "setNullCount"),
        "transformWarnCount": (transform_result, "warnCount"),
    }
    for metric_name, (source, source_name) in mappings.items():
        RULE_METRICS[metric_name] += int(source.get(source_name) or 0)
    if failed:
        RULE_METRICS["failedBatchCount"] += 1
    LAST_RULE_RESULT = {
        "quality": quality_result,
        "status": "failed" if failed else "success",
        "transform": transform_result,
    }


def recovered_rule_metrics(batches: list[dict[str, Any]]) -> dict[str, int]:
    totals = {key: 0 for key in RULE_METRICS if key != "failedBatchCount"}
    mappings = {
        "qualityDroppedCount": ("quality", "droppedCount"),
        "qualityInvalidCount": ("quality", "invalidRowCount"),
        "qualityQuarantinedCount": ("quality", "quarantinedCount"),
        "qualitySetNullCount": ("quality", "setNullCount"),
        "qualityWarnCount": ("quality", "warnCount"),
        "transformDroppedCount": ("transform", "droppedCount"),
        "transformErrorCount": ("transform", "errorCount"),
        "transformQuarantinedCount": ("transform", "quarantinedCount"),
        "transformSetNullCount": ("transform", "setNullCount"),
        "transformWarnCount": ("transform", "warnCount"),
    }
    for batch in batches:
        for metric_name, (section, field) in mappings.items():
            payload = batch.get(section) if isinstance(batch.get(section), dict) else {}
            totals[metric_name] += int(payload.get(field) or 0)
    return totals


def canonical_publication_signature(signature: dict[str, Any]) -> dict[str, Any]:
    return {
        "batchId": int(signature.get("batchId") or 0),
        "inputCount": int(signature.get("inputCount") or 0),
        "outputKind": str(signature.get("outputKind") or "target"),
        "ruleFingerprint": str(signature.get("ruleFingerprint") or RULE_FINGERPRINT),
        "runtimeFingerprint": str(signature.get("runtimeFingerprint") or RUNTIME_FINGERPRINT or ""),
        "schemaFingerprint": str(signature.get("schemaFingerprint") or SCHEMA_STATE.get("schemaFingerprint") or ""),
        "sourceRanges": normalized_source_ranges(signature.get("sourceRanges")),
    }


def publication_signature_path(batch_path: str) -> str:
    return f"{batch_path.rstrip('/')}/_asklake_publication"


def read_publication_signature(spark: SparkSession, batch_path: str) -> dict[str, Any] | None:
    signature_path = publication_signature_path(batch_path)
    if not output_committed(spark, signature_path):
        return None
    row = spark.read.json(signature_path).first()
    return canonical_publication_signature(row.asDict(recursive=True)) if row is not None else None


def write_publication_signature(spark: SparkSession, batch_path: str, signature: dict[str, Any]) -> None:
    signature_path = publication_signature_path(batch_path)
    frame = spark.read.json(spark.sparkContext.parallelize([json.dumps(canonical_publication_signature(signature))]))
    frame.write.mode("errorifexists").json(signature_path)
    if not output_committed(spark, signature_path):
        raise RuntimeError(f"Publication signature did not produce a completion marker: {signature_path}")


def write_batch_once(
    spark: SparkSession,
    frame: DataFrame,
    root: str,
    batch_id: int,
    signature: dict[str, Any],
) -> bool:
    batch_path = f"{root.rstrip('/')}/_batches/batch_id={batch_id}"
    if output_committed(spark, batch_path):
        if read_publication_signature(spark, batch_path) == canonical_publication_signature(signature):
            return False
        delete_output(spark, batch_path)
    delete_incomplete_output(spark, batch_path)
    frame.write.mode("errorifexists").parquet(batch_path)
    if not output_committed(spark, batch_path):
        raise RuntimeError(f"Batch publication did not produce a completion marker: {batch_path}")
    write_publication_signature(spark, batch_path, signature)
    return True


def manifest_path(root: str, batch_id: int) -> str:
    return f"{root.rstrip('/')}/_batch-manifests/batch_id={batch_id}"


def read_batch_manifest(spark: SparkSession, root: str, batch_id: int) -> dict[str, Any] | None:
    path = manifest_path(root, batch_id)
    if not output_committed(spark, path):
        return None
    return load_committed_manifest(spark, root, path, batch_id)


def load_committed_manifest(
    spark: SparkSession,
    root: str,
    path: str,
    batch_id: int,
) -> dict[str, Any]:
    return load_committed_manifests(spark, root, [(batch_id, path)])[0]


def load_committed_manifests(
    spark: SparkSession,
    root: str,
    manifest_paths: list[tuple[int, str]],
) -> list[dict[str, Any]]:
    if not manifest_paths:
        return []
    expected_paths = {batch_id: path for batch_id, path in manifest_paths}
    rows = (
        spark.read.json([path for _batch_id, path in manifest_paths])
        .withColumn("__asklake_manifest_source", input_file_name())
        .collect()
    )
    loaded: dict[int, dict[str, Any]] = {}
    for row in rows:
        manifest = row.asDict(recursive=True)
        source_path = str(manifest.pop("__asklake_manifest_source", "") or "")
        source_match = re.search(r"/batch_id=(\d+)(?:/|$)", source_path)
        source_batch_id = int(source_match.group(1)) if source_match else None
        raw_batch_id = manifest.get("batchId")
        try:
            manifest_batch_id = int(raw_batch_id) if raw_batch_id is not None else source_batch_id
        except (TypeError, ValueError):
            manifest_batch_id = None
        if manifest_batch_id is None or manifest_batch_id not in expected_paths:
            raise RuntimeError(f"Committed batch manifest has an invalid batch identity: {source_path}")
        if source_batch_id is not None and source_batch_id != manifest_batch_id:
            raise RuntimeError(f"Committed batch manifest path does not match its batch identity: {source_path}")
        if manifest_batch_id in loaded:
            raise RuntimeError(f"Committed batch manifest has multiple records: {expected_paths[manifest_batch_id]}")
        manifest.pop("batch_id", None)
        loaded[manifest_batch_id] = normalize_committed_manifest(
            spark,
            root,
            expected_paths[manifest_batch_id],
            manifest_batch_id,
            manifest,
        )
    missing = [batch_id for batch_id, _path in manifest_paths if batch_id not in loaded]
    if missing:
        raise RuntimeError(f"Committed batch manifest has no record: {expected_paths[missing[0]]}")
    return [loaded[batch_id] for batch_id, _path in manifest_paths]


def normalize_committed_manifest(
    spark: SparkSession,
    root: str,
    path: str,
    batch_id: int,
    manifest: dict[str, Any],
) -> dict[str, Any]:
    manifest.setdefault("batchId", batch_id)
    manifest.setdefault("publicationId", f"stream:{JOB_ID}:batch:{batch_id}")
    manifest.setdefault("publicationType", "stream")
    manifest.setdefault("manifestPath", path)
    iceberg_commit = manifest.get("icebergCommit") if isinstance(manifest.get("icebergCommit"), dict) else None
    if int(manifest.get("storedCount") or 0) > 0 and iceberg_commit:
        target = iceberg_commit.get("target") if isinstance(iceberg_commit.get("target"), dict) else {}
        table_uri = str(target.get("tableUri") or "").strip()
        if not table_uri or not str(iceberg_commit.get("snapshotId") or "").strip():
            raise RuntimeError(f"Batch manifest has incomplete Iceberg commit evidence: {path}")
        manifest.setdefault("dataPath", table_uri)
    elif int(manifest.get("storedCount") or 0) > 0:
        manifest.setdefault("dataPath", f"{root.rstrip('/')}/_batches/batch_id={batch_id}")
    if int(manifest.get("quarantinedCount") or 0) > 0:
        manifest.setdefault("quarantinePath", f"{root.rstrip('/')}/_quarantine/_batches/batch_id={batch_id}")
    manifest.setdefault("sourceRanges", [])
    path_evidence = (("quarantinedCount", "quarantinePath"),)
    if iceberg_commit is None:
        path_evidence = (("storedCount", "dataPath"), *path_evidence)
    for count_name, path_name in path_evidence:
        if int(manifest.get(count_name) or 0) > 0 and not output_committed(spark, str(manifest.get(path_name) or "")):
            raise RuntimeError(f"Batch manifest references an incomplete {path_name}: {path}")
    return manifest


def write_batch_manifest(spark: SparkSession, root: str, batch_id: int, manifest: dict[str, Any]) -> None:
    path = manifest_path(root, batch_id)
    if output_committed(spark, path):
        return
    delete_incomplete_output(spark, path)
    frame = spark.read.json(spark.sparkContext.parallelize([json.dumps(manifest)]))
    frame.write.mode("errorifexists").json(path)
    if not output_committed(spark, path):
        raise RuntimeError(f"Batch manifest did not produce a completion marker: {path}")


def committed_child_paths(spark: SparkSession, root: str) -> list[str]:
    if not path_exists(spark, root):
        return []
    jvm = spark.sparkContext._jvm
    hadoop = spark.sparkContext._jsc.hadoopConfiguration()
    root_path = jvm.org.apache.hadoop.fs.Path(root)
    file_system = root_path.getFileSystem(hadoop)
    paths = []
    for status in file_system.listStatus(root_path):
        child = str(status.getPath())
        if status.isDirectory() and output_committed(spark, child):
            paths.append(child)
    return sorted(paths)


def recover_published_state(
    spark: SparkSession,
    root: str,
    *,
    acknowledged_batch: int = -1,
    batch_limit: int = PUBLISHED_BATCH_LIMIT,
) -> dict[str, Any]:
    manifest_root = f"{root.rstrip('/')}/_batch-manifests"
    paths = committed_child_paths(spark, manifest_root)
    if not paths:
        return {
            "backlogCount": 0,
            "batches": [],
            "counts": {"consumedCount": 0, "storedCount": 0, "quarantinedCount": 0},
            "latest": None,
            "partitionCursors": [],
            "ruleMetrics": {},
        }
    batches: list[dict[str, Any]] = []
    counts = {"consumedCount": 0, "storedCount": 0, "quarantinedCount": 0}
    rule_metrics: dict[str, int] = {}
    latest: dict[str, Any] | None = None
    partition_cursors: dict[tuple[str, int], int] = {}
    backlog_count = 0
    manifest_paths: list[tuple[int, str]] = []
    for path in paths:
        match = re.search(r"/batch_id=(\d+)$", path.rstrip("/"))
        if not match:
            continue
        manifest_paths.append((int(match.group(1)), path))
    loaded_manifests = load_committed_manifests(
        spark,
        root,
        sorted(manifest_paths, key=lambda item: item[0]),
    )
    for batch in loaded_manifests:
        batch_id = int(batch.get("batchId") or 0)
        for key in counts:
            counts[key] += int(batch.get(key) or 0)
        for key, value in recovered_rule_metrics([batch]).items():
            rule_metrics[key] = rule_metrics.get(key, 0) + value
        for source_range in batch.get("sourceRanges") or []:
            if not isinstance(source_range, dict):
                continue
            topic = str(source_range.get("topic") or "").strip()
            try:
                partition = int(source_range.get("partition"))
                next_offset = int(source_range.get("endOffset"))
            except (TypeError, ValueError):
                continue
            if topic and partition >= 0 and next_offset >= 0:
                key = (topic, partition)
                partition_cursors[key] = max(
                    partition_cursors.get(key, 0),
                    next_offset,
                )
        if latest is None or batch_id > int(latest.get("batchId") or -1):
            latest = batch
        if batch_id <= acknowledged_batch:
            continue
        backlog_count += 1
        if len(batches) < batch_limit:
            batches.append(batch)
    batches.sort(key=lambda item: int(item.get("batchId") or 0))
    return {
        "backlogCount": backlog_count,
        "counts": counts,
        "batches": batches,
        "latest": latest,
        "partitionCursors": stream_partition_cursor_payload(partition_cursors),
        "ruleMetrics": rule_metrics,
    }


def batch_source_ranges(batch: DataFrame) -> list[dict[str, Any]]:
    rows = (batch.groupBy("topic", "partition")
        .agg(spark_min("offset").alias("start_offset"), spark_max("offset").alias("last_offset"))
        .collect())
    return sorted([
        {
            "topic": str(row["topic"]),
            "partition": int(row["partition"]),
            "startOffset": int(row["start_offset"]),
            "endOffset": int(row["last_offset"]) + 1,
        }
        for row in rows
    ], key=lambda item: (item["topic"], item["partition"]))


def retain_uncommitted_offsets(batch: DataFrame) -> DataFrame:
    unseen = lit(True)
    for (topic, partition), next_offset in STREAM_PARTITION_CURSORS.items():
        already_committed = (
            (col("topic") == lit(topic))
            & (col("partition") == lit(partition))
            & (col("offset") < lit(next_offset))
        )
        unseen = unseen & ~already_committed
    return batch.where(unseen)


def advance_worker_stream_partition_cursors(
    source_ranges: list[dict[str, Any]],
) -> None:
    for item in source_ranges:
        if not isinstance(item, dict):
            continue
        topic = str(item.get("topic") or "").strip()
        try:
            partition = int(item.get("partition"))
            next_offset = int(
                item.get("endOffset")
                if item.get("endOffset") is not None
                else item.get("nextOffset")
            )
        except (TypeError, ValueError):
            continue
        if not topic or partition < 0 or next_offset < 0:
            continue
        key = (topic, partition)
        STREAM_PARTITION_CURSORS[key] = max(
            STREAM_PARTITION_CURSORS.get(key, 0),
            next_offset,
        )


def next_publication_batch_id() -> int:
    return max(CATALOG_ACK_BATCH_ID, LATEST_DURABLE_BATCH_ID) + 1


def normalized_source_ranges(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return sorted([
        {
            "topic": str(item.get("topic") or ""),
            "partition": int(item.get("partition") or 0),
            "startOffset": int(item.get("startOffset") or 0),
            "endOffset": int(item.get("endOffset") or 0),
        }
        for item in value if isinstance(item, dict)
    ], key=lambda item: (item["topic"], item["partition"]))


def continuous_batch_source_boundary(
    batch_id: int,
    source_ranges: list[dict[str, Any]],
    checkpoint_path: str,
) -> dict[str, Any]:
    identity = {
        "batchId": int(batch_id),
        "checkpointPath": checkpoint_path.rstrip("/"),
        "consumerGroupId": os.environ["ASKLAKE_CONTINUOUS_CONSUMER_GROUP_ID"],
        "jobId": JOB_ID,
        "kind": "kafka_continuous_batch",
        "sourceRanges": normalized_source_ranges(source_ranges),
        "topic": os.environ["ASKLAKE_CONTINUOUS_TOPIC"],
    }
    boundary_id = canonical_hash(identity)
    run_id = f"continuous:{JOB_ID}:batch:{int(batch_id)}:{boundary_id[:16]}"
    return {**identity, "boundaryId": boundary_id, "runId": run_id}


def validate_manifest_retry(
    manifest: dict[str, Any],
    source_ranges: list[dict[str, Any]],
    total: int,
    *,
    source_boundary: dict[str, Any] | None = None,
    spark: SparkSession | None = None,
    iceberg_target: dict[str, Any] | None = None,
) -> None:
    persisted_ranges = normalized_source_ranges(manifest.get("sourceRanges"))
    ranges_mismatch = bool(persisted_ranges) and persisted_ranges != source_ranges
    fingerprint_mismatch = any((
        bool(manifest.get("ruleFingerprint")) and manifest.get("ruleFingerprint") != RULE_FINGERPRINT,
        bool(manifest.get("runtimeFingerprint")) and manifest.get("runtimeFingerprint") != RUNTIME_FINGERPRINT,
        bool(manifest.get("schemaFingerprint")) and manifest.get("schemaFingerprint") != (
            EXPECTED_SCHEMA_FINGERPRINT or SCHEMA_STATE.get("schemaFingerprint")
        ),
    ))
    if int(manifest.get("consumedCount") or 0) != total or ranges_mismatch or fingerprint_mismatch:
        raise RuntimeError("Existing batch manifest does not match the current Kafka offset range; checkpoint reuse is unsafe.")
    if source_boundary is not None:
        commit = manifest.get("icebergCommit") if isinstance(manifest.get("icebergCommit"), dict) else {}
        if manifest.get("sourceBoundary") != source_boundary or commit.get("sourceBoundary") != source_boundary:
            raise RuntimeError("Existing batch manifest does not match the current Iceberg source boundary.")
        if str(manifest.get("runId") or "") != str(source_boundary.get("runId") or ""):
            raise RuntimeError("Existing batch manifest has a different deterministic Continuous run identity.")
        if spark is not None and iceberg_target is not None and not iceberg_source_boundary_exists(
            spark,
            iceberg_target,
            source_boundary,
        ):
            raise RuntimeError("Existing batch manifest references an Iceberg source boundary that is not committed.")


def main() -> None:
    global CATALOG_ACK_BATCH_ID, LATEST_DURABLE_BATCH_ID, PUBLISHED_BACKLOG_COUNT, QUERY, LAST_BATCH_ID, LAST_FLUSH_AT, LAST_BATCH_STORED_COUNT, LAST_BATCH_QUARANTINED_COUNT, LAST_BATCH_WRITTEN, PUBLISHED_BATCHES, LAST_BATCH_EVIDENCE, CURRENT_BATCH_CONTEXT, RECOVERY_ROOT, RECOVERY_SPARK
    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)
    schema, aliases, required_fields = source_schema()
    expected_keys_by_parent = expected_object_keys(source for source, _target in aliases)
    output_path = os.environ["ASKLAKE_CONTINUOUS_OUTPUT_PATH"]
    checkpoint_path = os.environ["ASKLAKE_CONTINUOUS_CHECKPOINT_PATH"]
    quarantine_path = f"{output_path.rstrip('/')}/_quarantine"
    trigger_seconds = int(os.environ.get("ASKLAKE_CONTINUOUS_TRIGGER_SECONDS", "30"))
    iceberg_target = parse_iceberg_target(json_object_env("ASKLAKE_CONTINUOUS_ICEBERG_TARGET"))
    if iceberg_target is None or iceberg_target["writeMode"] != "append":
        raise RuntimeError("Continuous worker requires an append Iceberg target.")

    os.environ.setdefault("ASKLAKE_SPARK_APP_NAME", f"asklake-kafka-continuous-{JOB_ID}")
    spark = make_spark({}, iceberg_target)
    continuous_log_level = str(
        os.environ.get("ASKLAKE_CONTINUOUS_SPARK_LOG_LEVEL", "WARN")
    ).strip().upper()
    if continuous_log_level not in {
        "ALL", "DEBUG", "ERROR", "FATAL", "INFO", "OFF", "TRACE", "WARN",
    }:
        continuous_log_level = "WARN"
    spark.sparkContext.setLogLevel(continuous_log_level)
    RECOVERY_SPARK = spark
    RECOVERY_ROOT = output_path
    configure_s3a(spark)
    ensure_checkpoint_contract(spark, checkpoint_path, output_path, iceberg_target)
    CATALOG_ACK_BATCH_ID = catalog_ack_batch_id()
    recovered = recover_published_state(
        spark,
        output_path,
        acknowledged_batch=CATALOG_ACK_BATCH_ID,
        batch_limit=PUBLISHED_BATCH_LIMIT,
    )
    for key, value in recovered["counts"].items():
        COUNTERS[key] = max(COUNTERS[key], value)
    PUBLISHED_BATCHES = recovered["batches"]
    PUBLISHED_BACKLOG_COUNT = recovered["backlogCount"]
    advance_worker_stream_partition_cursors(recovered.get("partitionCursors") or [])
    latest_recovered = recovered.get("latest")
    LATEST_DURABLE_BATCH_ID = max(
        CATALOG_ACK_BATCH_ID,
        int(latest_recovered.get("batchId", -1)) if isinstance(latest_recovered, dict) else -1,
    )
    for key, value in recovered["ruleMetrics"].items():
        RULE_METRICS[key] = max(RULE_METRICS[key], value)
    if isinstance(latest_recovered, dict):
        latest = latest_recovered
        LAST_BATCH_ID = int(latest.get("batchId") or 0)
        LAST_FLUSH_AT = str(latest.get("publishedAt") or "") or None
        LAST_BATCH_STORED_COUNT = int(latest.get("storedCount") or 0)
        LAST_BATCH_QUARANTINED_COUNT = int(latest.get("quarantinedCount") or 0)
        LAST_BATCH_WRITTEN = True
        LAST_RULE_RESULT.update({
            "quality": latest.get("quality") if isinstance(latest.get("quality"), dict) else {},
            "status": "success",
            "transform": latest.get("transform") if isinstance(latest.get("transform"), dict) else {},
        })
        latest_steps = latest.get("dagSteps") if isinstance(latest.get("dagSteps"), list) else None
        if not latest_steps:
            latest_steps = build_batch_dag_steps(
                status="success",
                consumed_count=int(latest.get("consumedCount") or 0),
                schema_accepted_count=int(latest.get("schemaAcceptedCount") or latest.get("consumedCount") or 0),
                schema_quarantined_count=int(latest.get("schemaQuarantinedCount") or 0),
                stored_count=int(latest.get("storedCount") or 0),
                quarantined_count=int(latest.get("quarantinedCount") or 0),
                source_ranges=latest.get("sourceRanges") if isinstance(latest.get("sourceRanges"), list) else [],
                transform=latest.get("transform") if isinstance(latest.get("transform"), dict) else {},
                quality=latest.get("quality") if isinstance(latest.get("quality"), dict) else {},
                completed_at=str(latest.get("publishedAt") or "") or None,
                data_path=str(latest.get("dataPath") or "") or None,
                manifest_path_value=str(latest.get("manifestPath") or "") or None,
                checkpoint_path=checkpoint_path,
                iceberg_commit=latest.get("icebergCommit") if isinstance(latest.get("icebergCommit"), dict) else {},
            )
        LAST_BATCH_EVIDENCE = {**latest, "status": "success", "lastError": None, "dagSteps": latest_steps}
    source = (spark.readStream.format("kafka")
        .option("kafka.bootstrap.servers", os.environ["ASKLAKE_CONTINUOUS_BROKER"])
        .option("subscribe", os.environ["ASKLAKE_CONTINUOUS_TOPIC"])
        .option("startingOffsets", os.environ.get("ASKLAKE_CONTINUOUS_OFFSET_POLICY", "earliest"))
        .option("maxOffsetsPerTrigger", os.environ.get("ASKLAKE_CONTINUOUS_MAX_OFFSETS", "10000"))
        .option("kafka.group.id", os.environ["ASKLAKE_CONTINUOUS_CONSUMER_GROUP_ID"])
        .load())
    parsed = source.select(
        col("topic"), col("partition"), col("offset"), col("timestamp").alias("kafka_timestamp"),
        col("value").cast("string").alias("raw_payload"),
        from_json(col("value").cast("string"), schema).alias("payload"),
        from_json(col("value").cast("string"), MapType(StringType(), StringType())).alias("raw_map"),
    )

    def write_batch(batch: DataFrame, spark_batch_id: int) -> None:
        global LAST_BATCH_STORED_COUNT, LAST_BATCH_QUARANTINED_COUNT, LAST_BATCH_WRITTEN, PUBLISHED_BATCHES, LAST_BATCH_EVIDENCE, CURRENT_BATCH_CONTEXT
        if STOP_REQUESTED:
            return
        batch_started_at = time.monotonic()
        batch = retain_uncommitted_offsets(batch)
        batch.persist()
        total = batch.count()
        if total == 0:
            # Keep the last non-empty batch publication visible to the control
            # plane. Spark can invoke foreachBatch for empty microbatches while
            # the stream is idle, and those must not erase Catalog retry state.
            report("running")
            batch.unpersist()
            return
        batch_id = next_publication_batch_id()
        source_ranges = batch_source_ranges(batch)
        source_boundary = continuous_batch_source_boundary(
            batch_id,
            source_ranges,
            checkpoint_path,
        )
        run_id = str(source_boundary["runId"])
        stage_durations = {
            "sourceDurationMs": max(0, round((time.monotonic() - batch_started_at) * 1000)),
        }
        CURRENT_BATCH_CONTEXT = {
            "batch_id": batch_id,
            "batch_started_at": batch_started_at,
            "checkpoint_path": checkpoint_path,
            "consumed_count": total,
            "current_stage": "schema",
            "durations": stage_durations,
            "quarantined_count": 0,
            "schema_accepted_count": 0,
            "schema_quarantined_count": 0,
            "source_ranges": source_ranges,
            "source_boundary": source_boundary,
            "run_id": run_id,
            "stored_count": 0,
        }
        for item in source_ranges:
            PROCESSED_OFFSETS[str(item["partition"])] = int(item["endOffset"])
        published = read_batch_manifest(spark, output_path, batch_id)
        if published is not None:
            validate_manifest_retry(
                published,
                source_ranges,
                total,
                source_boundary=source_boundary,
                spark=spark,
                iceberg_target=iceberg_target,
            )
            LAST_BATCH_STORED_COUNT = int(published.get("storedCount") or 0)
            LAST_BATCH_QUARANTINED_COUNT = int(published.get("quarantinedCount") or 0)
            LAST_BATCH_WRITTEN = True
            remember_published_batch(published)
            advance_worker_stream_partition_cursors(source_ranges)
            LAST_RULE_RESULT.update({
                "quality": published.get("quality") if isinstance(published.get("quality"), dict) else {},
                "status": "success",
                "transform": published.get("transform") if isinstance(published.get("transform"), dict) else {},
            })
            dag_steps = published.get("dagSteps") if isinstance(published.get("dagSteps"), list) else build_batch_dag_steps(
                status="success",
                consumed_count=int(published.get("consumedCount") or total),
                schema_accepted_count=int(published.get("schemaAcceptedCount") or published.get("consumedCount") or total),
                schema_quarantined_count=int(published.get("schemaQuarantinedCount") or 0),
                stored_count=int(published.get("storedCount") or 0),
                quarantined_count=int(published.get("quarantinedCount") or 0),
                source_ranges=source_ranges,
                transform=published.get("transform") if isinstance(published.get("transform"), dict) else {},
                quality=published.get("quality") if isinstance(published.get("quality"), dict) else {},
                durations=stage_durations,
                completed_at=str(published.get("publishedAt") or "") or None,
                data_path=str(published.get("dataPath") or "") or None,
                manifest_path_value=str(published.get("manifestPath") or "") or None,
                checkpoint_path=checkpoint_path,
                iceberg_commit=published.get("icebergCommit") if isinstance(published.get("icebergCommit"), dict) else {},
            )
            LAST_BATCH_EVIDENCE = {**published, "status": "success", "lastError": None, "dagSteps": dag_steps}
            CURRENT_BATCH_CONTEXT = {}
            report("running", batch_id=batch_id)
            batch.unpersist()
            return
        required_missing = lit(False)
        incompatible_type = lit(False)
        for field_name, _target in aliases:
            source_value = raw_source_value(field_name)
            parsed_value_missing = nested_payload_column(field_name).isNull()
            if field_name in required_fields:
                required_missing = required_missing | source_value.isNull()
            incompatible_type = incompatible_type | (source_value.isNotNull() & parsed_value_missing)
        malformed = col("raw_map").isNull() | col("payload").isNull()
        unknown_condition, unknown_keys = unknown_field_expressions(expected_keys_by_parent)
        unknown_rows = (batch.where(col("raw_map").isNotNull())
            .select(explode(unknown_keys).alias("field"))
            .distinct().limit(100).collect())
        unknown_fields = sorted({str(row["field"]) for row in unknown_rows})
        if unknown_fields:
            SCHEMA_STATE["schemaStatus"] = "drift_detected"
            SCHEMA_STATE["schemaChanges"] = [{"kind": "additive_unknown", "field": field} for field in unknown_fields]
        pause_condition = lit(False)
        if SCHEMA_POLICY.get("missingRequired") == "pause":
            pause_condition = pause_condition | required_missing
        if SCHEMA_POLICY.get("incompatibleType") == "pause":
            pause_condition = pause_condition | incompatible_type
        if SCHEMA_POLICY.get("unknownField") == "pause" or SCHEMA_POLICY.get("additiveNullable") == "pause":
            pause_condition = pause_condition | unknown_condition
        schema_started_at = time.monotonic()
        policy_pause_count = batch.where(~malformed & pause_condition).limit(1).count()
        if policy_pause_count:
            SCHEMA_STATE["schemaStatus"] = "policy_paused"
            stage_durations["schemaDurationMs"] = max(0, round((time.monotonic() - schema_started_at) * 1000))
            CURRENT_BATCH_CONTEXT.update({
                "current_stage": "schema",
                "schema_accepted_count": max(0, total - policy_pause_count),
                "schema_quarantined_count": policy_pause_count,
            })
            LAST_BATCH_EVIDENCE = build_batch_evidence(
                **CURRENT_BATCH_CONTEXT,
                status="failed",
                completed_at=now(),
                duration_ms=max(0, round((time.monotonic() - batch_started_at) * 1000)),
                failed_stage="schema",
                error="Schema evolution policy paused the worker before target publication.",
            )
            report("failed", error="Schema evolution policy paused the worker before target publication.")
            raise RuntimeError("Schema evolution policy paused the worker before target publication.")
        invalid_condition = malformed
        if SCHEMA_POLICY.get("missingRequired") == "quarantine":
            invalid_condition = invalid_condition | required_missing
        if SCHEMA_POLICY.get("incompatibleType") == "quarantine":
            invalid_condition = invalid_condition | incompatible_type
        if SCHEMA_POLICY.get("unknownField") == "quarantine" or SCHEMA_POLICY.get("additiveNullable") == "quarantine":
            invalid_condition = invalid_condition | unknown_condition
        valid = batch.where(~invalid_condition)
        invalid = batch.where(invalid_condition)
        schema_valid_count = valid.count()
        schema_invalid_count = total - schema_valid_count
        selected = [nested_payload_column(source).alias(target) for source, target in aliases]
        projected = valid.select(
            *selected,
            col("topic"),
            col("partition").alias("kafka_partition"),
            col("offset").alias("kafka_offset"),
            col("kafka_timestamp"),
            col("raw_payload"),
            current_timestamp().alias("ingested_at"),
        )
        stage_durations["schemaDurationMs"] = max(0, round((time.monotonic() - schema_started_at) * 1000))
        CURRENT_BATCH_CONTEXT.update({
            "current_stage": "transform",
            "schema_accepted_count": schema_valid_count,
            "schema_quarantined_count": schema_invalid_count,
            "quarantined_count": schema_invalid_count,
        })
        try:
            rule_execution = apply_snapshot_rules(projected, RULES)
        except SnapshotRuleExecutionError as exc:
            stage_durations.update(exc.timings or {})
            update_rule_metrics(exc.transform or {}, exc.quality or {}, failed=True)
            CURRENT_BATCH_CONTEXT.update({
                "current_stage": exc.failed_stage,
                "transform": exc.transform or {},
                "quality": exc.quality or {},
            })
            LAST_BATCH_EVIDENCE = build_batch_evidence(
                **CURRENT_BATCH_CONTEXT,
                status="failed",
                completed_at=now(),
                duration_ms=max(0, round((time.monotonic() - batch_started_at) * 1000)),
                failed_stage=exc.failed_stage,
                error=str(exc)[:2000],
            )
            report("failed", error=str(exc)[:2000])
            batch.unpersist()
            raise
        stage_durations.update(rule_execution.get("timings") or {})
        target_started_at = time.monotonic()
        CURRENT_BATCH_CONTEXT.update({
            "current_stage": "target",
            "quality": rule_execution["quality"],
            "transform": rule_execution["transform"],
        })
        transformed = rule_execution["frame"].persist()
        target_frame = select_continuous_target(transformed).persist()
        stored_count = target_frame.count()
        rule_quarantine = rule_execution["quarantine"]
        rule_quarantine_count = rule_quarantine.count() if rule_quarantine is not None else 0
        quarantined_count = schema_invalid_count + rule_quarantine_count
        data_path = iceberg_target["tableUri"] if stored_count else None
        iceberg_commit = None
        quarantine_batch_path = f"{quarantine_path.rstrip('/')}/_batches/batch_id={batch_id}" if quarantined_count else None
        evidence_batch_path = None
        if stored_count:
            missing_partitions = [
                name for name in iceberg_target["partitionColumns"]
                if name not in target_frame.columns
            ]
            if missing_partitions:
                raise RuntimeError(
                    "Continuous Iceberg partition contract references missing output columns: "
                    + ", ".join(missing_partitions)
                )
            iceberg_frame = (
                target_frame
                .withColumn("_asklake_run_id", lit(run_id))
                .withColumn("_asklake_ingested_at", current_timestamp())
            )
            iceberg_commit = commit_iceberg_table(
                spark,
                iceberg_frame,
                iceberg_target,
                job_id=JOB_ID,
                run_id=run_id,
                partition_columns=iceberg_target["partitionColumns"],
                schema_fingerprint=EXPECTED_SCHEMA_FINGERPRINT or SCHEMA_STATE.get("schemaFingerprint"),
                rule_fingerprint=RULE_FINGERPRINT,
                source_boundary=source_boundary,
            )
            iceberg_commit.pop("_previousSnapshot", None)
        if quarantined_count:
            quarantine_frame = None
            if schema_invalid_count:
                quarantine_frame = schema_quarantine_rows(
                    invalid,
                    malformed,
                    required_missing,
                    incompatible_type,
                    unknown_condition,
                )
            if rule_quarantine is not None:
                rule_evidence = rule_quarantine_rows(rule_quarantine)
                quarantine_frame = rule_evidence if quarantine_frame is None else quarantine_frame.unionByName(rule_evidence)
            write_batch_once(
                spark,
                quarantine_frame,
                quarantine_path,
                batch_id,
                {
                    "batchId": batch_id,
                    "inputCount": quarantined_count,
                    "outputKind": "quarantine",
                    "sourceRanges": source_ranges,
                },
            )
        if unknown_fields and SCHEMA_POLICY.get("unknownField") == "preserve":
            evidence_root = f"{output_path.rstrip('/')}/_schema-evidence"
            evidence_batch_path = f"{evidence_root}/_batches/batch_id={batch_id}"
            evidence = batch.where(unknown_condition)
            evidence_count = evidence.count()
            write_batch_once(
                spark,
                evidence.select(
                    "topic", "partition", "offset", "kafka_timestamp", "raw_payload",
                    unknown_keys.alias("unknown_fields"),
                    lit(SCHEMA_STATE["schemaFingerprint"]).alias("schema_fingerprint"),
                    current_timestamp().alias("observed_at"),
                ),
                evidence_root,
                batch_id,
                {
                    "batchId": batch_id,
                    "inputCount": evidence_count,
                    "outputKind": "schema_evidence",
                    "sourceRanges": batch_source_ranges(evidence),
                },
            )
        stage_durations["targetDurationMs"] = max(0, round((time.monotonic() - target_started_at) * 1000))
        CURRENT_BATCH_CONTEXT.update({
            "current_stage": "manifest-checkpoint",
            "data_path": data_path,
            "iceberg_commit": iceberg_commit,
            "quarantine_path": quarantine_batch_path,
            "quarantined_count": quarantined_count,
            "stored_count": stored_count,
        })
        if os.environ.get("ASKLAKE_CONTINUOUS_FAIL_AFTER_DATA_WRITE_ONCE", "").lower() == "true":
            fault_marker = REPORT_FILE.with_suffix(".publish-fault-applied")
            if not fault_marker.exists():
                fault_marker.write_text(now(), encoding="utf-8")
                raise RuntimeError("Injected failure after data write and before manifest publication.")
        published_at = now()
        stage_durations["manifestDurationMs"] = 0
        batch_duration_ms = max(0, round((time.monotonic() - batch_started_at) * 1000))
        batch_dag_steps = build_batch_dag_steps(
            status="success",
            consumed_count=total,
            schema_accepted_count=schema_valid_count,
            schema_quarantined_count=schema_invalid_count,
            stored_count=stored_count,
            quarantined_count=quarantined_count,
            source_ranges=source_ranges,
            transform=rule_execution["transform"],
            quality=rule_execution["quality"],
            durations=stage_durations,
            completed_at=published_at,
            data_path=data_path,
            manifest_path_value=manifest_path(output_path, batch_id),
            checkpoint_path=checkpoint_path,
            iceberg_commit=iceberg_commit,
        )
        published_manifest = {
            "batchId": batch_id,
            "sparkBatchId": int(spark_batch_id),
            "publicationId": f"stream:{JOB_ID}:batch:{batch_id}",
            "publicationType": "stream",
            "runId": run_id,
            "publishedAt": published_at,
            "topic": os.environ["ASKLAKE_CONTINUOUS_TOPIC"],
            "sourceRanges": source_ranges,
            "sourceBoundary": source_boundary,
            "consumedCount": total,
            "storedCount": stored_count,
            "quarantinedCount": quarantined_count,
            "schemaAcceptedCount": schema_valid_count,
            "schemaQuarantinedCount": schema_invalid_count,
            "ruleQuarantinedCount": rule_quarantine_count,
            "droppedCount": int(rule_execution["transform"].get("droppedCount") or 0) + int(rule_execution["quality"].get("droppedCount") or 0),
            "warnCount": int(rule_execution["transform"].get("warnCount") or 0) + int(rule_execution["quality"].get("warnCount") or 0),
            "ruleContractVersion": RULE_CONTRACT_VERSION,
            "ruleFingerprint": RULE_FINGERPRINT,
            "runtimeFingerprint": RUNTIME_FINGERPRINT,
            "schemaFingerprint": EXPECTED_SCHEMA_FINGERPRINT or SCHEMA_STATE["schemaFingerprint"],
            "observedSchemaFingerprint": SCHEMA_STATE["schemaFingerprint"],
            "transform": rule_execution["transform"],
            "quality": rule_execution["quality"],
            "durationMs": batch_duration_ms,
            "dataPath": data_path,
            "icebergCommit": iceberg_commit,
            "quarantinePath": quarantine_batch_path,
            "schemaEvidencePath": evidence_batch_path,
            "manifestPath": manifest_path(output_path, batch_id),
            "dagSteps": batch_dag_steps,
        }
        write_batch_manifest(spark, output_path, batch_id, published_manifest)
        remember_published_batch(published_manifest)
        advance_worker_stream_partition_cursors(source_ranges)
        LAST_BATCH_STORED_COUNT = stored_count
        LAST_BATCH_QUARANTINED_COUNT = quarantined_count
        LAST_BATCH_WRITTEN = True
        LAST_BATCH_EVIDENCE = {**published_manifest, "status": "success", "lastError": None}
        CURRENT_BATCH_CONTEXT = {}
        COUNTERS["consumedCount"] += total
        COUNTERS["storedCount"] += stored_count
        COUNTERS["quarantinedCount"] += quarantined_count
        update_rule_metrics(rule_execution["transform"], rule_execution["quality"])
        report("running", batch_id=batch_id)
        target_frame.unpersist()
        transformed.unpersist()
        batch.unpersist()

    report("starting")
    QUERY = (parsed.writeStream.foreachBatch(write_batch)
        .option("checkpointLocation", checkpoint_path)
        .trigger(processingTime=f"{trigger_seconds} seconds")
        .start())
    if STOP_REQUESTED:
        QUERY.stop()
    report("running")
    while QUERY.isActive:
        QUERY.awaitTermination(5)
        if QUERY.isActive:
            refresh_query_metrics(QUERY)
            report("running")
    report("paused" if requested_action() == "pause" else "stopped")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001 - report worker failures to the control plane.
        fail_current_batch(exc)
        COUNTERS["failedCount"] += 1
        report("failed", error=str(exc)[:2000])
        raise
