"""Long-running Kafka to Parquet Structured Streaming worker for AskLake."""

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
from pyspark.sql.functions import array, array_except, array_union, col, concat, current_timestamp, explode, from_json, get_json_object, lit, map_keys, min as spark_min, max as spark_max, size, transform, when
from pyspark.sql.types import BooleanType, DoubleType, LongType, MapType, StringType, StructField, StructType, TimestampType

from kafka_schema_paths import build_nested_schema_tree, expected_object_keys, json_path, split_source_path
from object_storage_runtime import configure_spark_hadoop
from snapshot_rule_runtime import SnapshotRuleExecutionError, apply_snapshot_rules, supports_snapshot_rules


def load_manifest_environment() -> None:
    manifest_file = os.environ.get("ASKLAKE_CONTINUOUS_MANIFEST_FILE", "").strip()
    if not manifest_file:
        return
    try:
        payload = json.loads(Path(manifest_file).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError("Continuous manifest is unreadable.") from exc
    environment = payload.get("environment") if isinstance(payload, dict) else None
    if not isinstance(environment, dict):
        raise RuntimeError("Continuous manifest environment is invalid.")
    for name, value in environment.items():
        environment_name = str(name)
        if not environment_name.startswith("ASKLAKE_") and environment_name not in {
            "AWS_REGION",
            "HOME",
            "S3_FORCE_PATH_STYLE",
        }:
            raise RuntimeError(f"Continuous manifest contains an unsupported environment name: {name}")
        os.environ[environment_name] = str(value)


load_manifest_environment()


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


JOB_ID = os.environ["ASKLAKE_CONTINUOUS_JOB_ID"]
WORKER_ATTEMPT_ID = os.environ.get("ASKLAKE_CONTINUOUS_WORKER_ATTEMPT_ID")
REPORT_LOCATION = os.environ["ASKLAKE_CONTINUOUS_REPORT_FILE"]
COMMAND_LOCATION = os.environ.get("ASKLAKE_CONTINUOUS_COMMAND_FILE", "")
STOP_REQUESTED = False
QUERY = None
SPARK_SESSION = None
INITIAL_COUNTS = json.loads(os.environ.get("ASKLAKE_CONTINUOUS_INITIAL_COUNTS", "{}"))
INITIAL_METRICS = json_object_env("ASKLAKE_CONTINUOUS_INITIAL_METRICS")
INITIAL_SCHEMA_STATE = json_object_env("ASKLAKE_CONTINUOUS_INITIAL_SCHEMA_STATE")
RULE_CONTRACT_VERSION = os.environ.get("ASKLAKE_CONTINUOUS_RULE_CONTRACT_VERSION", "1.0")
RULES = [rule for rule in json_array_env("ASKLAKE_CONTINUOUS_RULES") if isinstance(rule, dict)]
RULE_OUTPUT_SCHEMA = [item for item in json_array_env("ASKLAKE_CONTINUOUS_RULE_OUTPUT_SCHEMA") if isinstance(item, (list, tuple)) and len(item) >= 2]
RULE_FINGERPRINT = canonical_hash({"contractVersion": RULE_CONTRACT_VERSION, "rules": RULES})
EXPECTED_RULE_FINGERPRINT = os.environ.get("ASKLAKE_CONTINUOUS_RULE_FINGERPRINT", "")
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


def remote_runtime_location(value: str) -> bool:
    return bool(re.match(r"^s3a?://", str(value or ""), re.IGNORECASE))


def runtime_location_with_suffix(value: str, suffix: str) -> str:
    return re.sub(r"(?:\.[^./]+)?$", suffix, str(value))


def runtime_path(value: str):
    if SPARK_SESSION is None:
        raise RuntimeError("Spark session is not ready for remote runtime state.")
    jvm = SPARK_SESSION.sparkContext._jvm
    hadoop = SPARK_SESSION.sparkContext._jsc.hadoopConfiguration()
    target = jvm.org.apache.hadoop.fs.Path(value)
    return jvm, target, target.getFileSystem(hadoop)


def runtime_text_exists(value: str) -> bool:
    if not value:
        return False
    if not remote_runtime_location(value):
        return Path(value).exists()
    _jvm, target, file_system = runtime_path(value)
    return bool(file_system.exists(target))


def read_runtime_text(value: str) -> str:
    if not remote_runtime_location(value):
        return Path(value).read_text(encoding="utf-8")
    jvm, target, file_system = runtime_path(value)
    stream = file_system.open(target)
    reader = jvm.java.io.BufferedReader(
        jvm.java.io.InputStreamReader(stream, jvm.java.nio.charset.StandardCharsets.UTF_8)
    )
    lines = []
    try:
        while True:
            line = reader.readLine()
            if line is None:
                break
            lines.append(str(line))
    finally:
        reader.close()
    return "\n".join(lines)


def write_runtime_text(value: str, payload: str) -> None:
    if not remote_runtime_location(value):
        target = Path(value)
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(f"{target.name}.{os.getpid()}.{time.time_ns()}.tmp")
        temporary.write_text(payload, encoding="utf-8")
        temporary.replace(target)
        return
    jvm, target, file_system = runtime_path(value)
    temporary = jvm.org.apache.hadoop.fs.Path(f"{value}.{os.getpid()}.{time.time_ns()}.tmp")
    writer = jvm.java.io.OutputStreamWriter(
        file_system.create(temporary, True),
        jvm.java.nio.charset.StandardCharsets.UTF_8,
    )
    try:
        writer.write(payload)
    finally:
        writer.close()
    if file_system.exists(target) and not file_system.delete(target, False):
        file_system.delete(temporary, False)
        raise RuntimeError(f"Could not replace remote runtime state: {value}")
    if not file_system.rename(temporary, target):
        file_system.delete(temporary, False)
        raise RuntimeError(f"Could not publish remote runtime state: {value}")


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
            "target", "5. Target", stage_status("target"), f"Parquet {stored_count:,}건 적재",
            completed_at=completed, duration_ms=durations.get("targetDurationMs"), logs=stage_error("target"),
            details=[["출력 행", f"{stored_count:,}"], ["전체 격리", f"{quarantined_count:,}"], ["저장 경로", data_path or "-"]],
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
        "dataPath": values.get("data_path"),
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


def apply_catalog_ack() -> None:
    global PUBLISHED_BATCHES
    ack_path = runtime_location_with_suffix(REPORT_LOCATION, ".catalog-ack.json")
    try:
        if not runtime_text_exists(ack_path):
            return
        payload = json.loads(read_runtime_text(ack_path))
        acknowledged_batch = int(payload.get("batchId"))
    except Exception:  # noqa: BLE001 - acknowledgement is best-effort control-plane state.
        return
    PUBLISHED_BATCHES = [
        item for item in PUBLISHED_BATCHES
        if int(item.get("batchId") or 0) > acknowledged_batch
    ]


def report(status: str, *, batch_id: int | None = None, error: str | None = None) -> None:
    global LAST_BATCH_ID, LAST_FLUSH_AT
    if batch_id is not None:
        LAST_BATCH_ID = batch_id
        LAST_FLUSH_AT = now()
    apply_catalog_ack()
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
    write_runtime_text(REPORT_LOCATION, json.dumps(payload))


def requested_action() -> str:
    if not COMMAND_LOCATION:
        return ""
    try:
        raw = read_runtime_text(COMMAND_LOCATION).strip()
        return str(json.loads(raw).get("action") or "") if raw else ""
    except (OSError, json.JSONDecodeError):
        return ""


def on_signal(_signum: int, _frame: Any) -> None:
    global STOP_REQUESTED
    STOP_REQUESTED = True


def test_batch_delay(stage: str) -> None:
    if os.environ.get("ASKLAKE_CONTINUOUS_TEST_MODE", "").lower() != "true":
        return
    if os.environ.get("ASKLAKE_CONTINUOUS_TEST_BATCH_DELAY_STAGE", "batch_started") != stage:
        return
    try:
        delay_ms = max(0, min(int(os.environ.get("ASKLAKE_CONTINUOUS_TEST_BATCH_DELAY_MS", "0")), 60_000))
    except ValueError:
        delay_ms = 0
    if delay_ms:
        time.sleep(delay_ms / 1000)


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


def continuous_runtime_contract(output_path: str) -> dict[str, Any]:
    output_schema = [
        {"name": str(item[0]), "type": str(item[1])}
        for item in RULE_OUTPUT_SCHEMA
    ]
    contract = {
        "consumerGroupId": os.environ["ASKLAKE_CONTINUOUS_CONSUMER_GROUP_ID"],
        "jobId": JOB_ID,
        "outputPath": output_path.rstrip("/"),
        "outputSchema": output_schema,
        "ruleContractVersion": RULE_CONTRACT_VERSION,
        "ruleFingerprint": RULE_FINGERPRINT,
        "schemaFingerprint": SCHEMA_STATE.get("schemaFingerprint"),
        "topic": os.environ["ASKLAKE_CONTINUOUS_TOPIC"],
    }
    return {**contract, "runtimeFingerprint": canonical_hash(contract)}


def ensure_checkpoint_contract(spark: SparkSession, checkpoint_path: str, output_path: str) -> None:
    global RUNTIME_FINGERPRINT
    if EXPECTED_RULE_FINGERPRINT and EXPECTED_RULE_FINGERPRINT != RULE_FINGERPRINT:
        raise RuntimeError("Continuous rule fingerprint differs between the control plane and worker payload.")
    if not supports_snapshot_rules(RULES):
        raise RuntimeError("Continuous worker received a stateful or unsupported canonical Rule.")
    contract = continuous_runtime_contract(output_path)
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
    row = spark.read.json(path).first()
    if row is None:
        raise RuntimeError(f"Committed batch manifest has no record: {path}")
    manifest = row.asDict(recursive=True)
    manifest.setdefault("batchId", batch_id)
    manifest.setdefault("publicationId", f"stream:{JOB_ID}:batch:{batch_id}")
    manifest.setdefault("publicationType", "stream")
    manifest.setdefault("manifestPath", path)
    if int(manifest.get("storedCount") or 0) > 0:
        manifest.setdefault("dataPath", f"{root.rstrip('/')}/_batches/batch_id={batch_id}")
    if int(manifest.get("quarantinedCount") or 0) > 0:
        manifest.setdefault("quarantinePath", f"{root.rstrip('/')}/_quarantine/_batches/batch_id={batch_id}")
    manifest.setdefault("sourceRanges", [])
    for count_name, path_name in (("storedCount", "dataPath"), ("quarantinedCount", "quarantinePath")):
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


def recover_published_state(spark: SparkSession, root: str) -> dict[str, Any]:
    manifest_root = f"{root.rstrip('/')}/_batch-manifests"
    paths = committed_child_paths(spark, manifest_root)
    if not paths:
        return {"counts": {"consumedCount": 0, "storedCount": 0, "quarantinedCount": 0}, "batches": []}
    batches = []
    for path in paths:
        match = re.search(r"/batch_id=(\d+)$", path.rstrip("/"))
        if not match:
            continue
        batches.append(load_committed_manifest(spark, root, path, int(match.group(1))))
    batches.sort(key=lambda item: int(item.get("batchId") or 0))
    counts = {
        key: sum(int(batch.get(key) or 0) for batch in batches)
        for key in ("consumedCount", "storedCount", "quarantinedCount")
    }
    return {
        "counts": counts,
        "batches": batches,
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


def validate_manifest_retry(manifest: dict[str, Any], source_ranges: list[dict[str, Any]], total: int) -> None:
    persisted_ranges = normalized_source_ranges(manifest.get("sourceRanges"))
    ranges_mismatch = bool(persisted_ranges) and persisted_ranges != source_ranges
    fingerprint_mismatch = any((
        bool(manifest.get("ruleFingerprint")) and manifest.get("ruleFingerprint") != RULE_FINGERPRINT,
        bool(manifest.get("runtimeFingerprint")) and manifest.get("runtimeFingerprint") != RUNTIME_FINGERPRINT,
        bool(manifest.get("schemaFingerprint")) and manifest.get("schemaFingerprint") != SCHEMA_STATE.get("schemaFingerprint"),
    ))
    if int(manifest.get("consumedCount") or 0) != total or ranges_mismatch or fingerprint_mismatch:
        raise RuntimeError("Existing batch manifest does not match the current Kafka offset range; checkpoint reuse is unsafe.")


def main() -> None:
    global QUERY, SPARK_SESSION, LAST_BATCH_ID, LAST_FLUSH_AT, LAST_BATCH_STORED_COUNT, LAST_BATCH_QUARANTINED_COUNT, LAST_BATCH_WRITTEN, PUBLISHED_BATCHES, LAST_BATCH_EVIDENCE, CURRENT_BATCH_CONTEXT
    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)
    schema, aliases, required_fields = source_schema()
    expected_keys_by_parent = expected_object_keys(source for source, _target in aliases)
    output_path = os.environ["ASKLAKE_CONTINUOUS_OUTPUT_PATH"]
    checkpoint_path = os.environ["ASKLAKE_CONTINUOUS_CHECKPOINT_PATH"]
    quarantine_path = f"{output_path.rstrip('/')}/_quarantine"
    trigger_seconds = int(os.environ.get("ASKLAKE_CONTINUOUS_TRIGGER_SECONDS", "30"))

    spark = SparkSession.builder.appName(f"asklake-kafka-continuous-{JOB_ID}").getOrCreate()
    SPARK_SESSION = spark
    configure_s3a(spark)
    ensure_checkpoint_contract(spark, checkpoint_path, output_path)
    recovered = recover_published_state(spark, output_path)
    for key, value in recovered["counts"].items():
        COUNTERS[key] = max(COUNTERS[key], value)
    PUBLISHED_BATCHES = recovered["batches"]
    for key, value in recovered_rule_metrics(PUBLISHED_BATCHES).items():
        RULE_METRICS[key] = max(RULE_METRICS[key], value)
    if PUBLISHED_BATCHES:
        latest = PUBLISHED_BATCHES[-1]
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
            )
        LAST_BATCH_EVIDENCE = {**latest, "status": "success", "lastError": None, "dagSteps": latest_steps}
    source_builder = (spark.readStream.format("kafka")
        .option("kafka.bootstrap.servers", os.environ["ASKLAKE_CONTINUOUS_BROKER"])
        .option("subscribe", os.environ["ASKLAKE_CONTINUOUS_TOPIC"])
        .option("startingOffsets", os.environ.get("ASKLAKE_CONTINUOUS_OFFSET_POLICY", "earliest"))
        .option("maxOffsetsPerTrigger", os.environ.get("ASKLAKE_CONTINUOUS_MAX_OFFSETS", "10000"))
        .option("kafka.group.id", os.environ["ASKLAKE_CONTINUOUS_CONSUMER_GROUP_ID"]))
    kafka_security_options = {
        "kafka.security.protocol": os.environ.get("ASKLAKE_CONTINUOUS_KAFKA_SECURITY_PROTOCOL"),
        "kafka.sasl.mechanism": os.environ.get("ASKLAKE_CONTINUOUS_KAFKA_SASL_MECHANISM"),
        "kafka.sasl.jaas.config": os.environ.get("ASKLAKE_CONTINUOUS_KAFKA_SASL_JAAS_CONFIG"),
        "kafka.sasl.client.callback.handler.class": os.environ.get("ASKLAKE_CONTINUOUS_KAFKA_SASL_CALLBACK_HANDLER_CLASS"),
    }
    for option_name, option_value in kafka_security_options.items():
        if option_value:
            source_builder = source_builder.option(option_name, option_value)
    source = source_builder.load()
    parsed = source.select(
        col("topic"), col("partition"), col("offset"), col("timestamp").alias("kafka_timestamp"),
        col("value").cast("string").alias("raw_payload"),
        from_json(col("value").cast("string"), schema).alias("payload"),
        from_json(col("value").cast("string"), MapType(StringType(), StringType())).alias("raw_map"),
    )

    def write_batch(batch: DataFrame, batch_id: int) -> None:
        persisted_frames = [batch.persist()]
        try:
            write_persisted_batch(batch, batch_id, persisted_frames)
        finally:
            for frame in reversed(persisted_frames):
                try:
                    frame.unpersist()
                except Exception:  # noqa: BLE001 - cleanup must not mask the batch result.
                    pass

    def write_persisted_batch(batch: DataFrame, batch_id: int, persisted_frames: list[DataFrame]) -> None:
        global LAST_BATCH_STORED_COUNT, LAST_BATCH_QUARANTINED_COUNT, LAST_BATCH_WRITTEN, PUBLISHED_BATCHES, LAST_BATCH_EVIDENCE, CURRENT_BATCH_CONTEXT
        batch_started_at = time.monotonic()
        total = batch.count()
        test_batch_delay("batch_started")
        if total == 0:
            # Keep the last non-empty batch publication visible to the control
            # plane. Spark can invoke foreachBatch for empty microbatches while
            # the stream is idle, and those must not erase Catalog retry state.
            report("running")
            return
        source_ranges = batch_source_ranges(batch)
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
            "stored_count": 0,
        }
        for item in source_ranges:
            PROCESSED_OFFSETS[str(item["partition"])] = int(item["endOffset"])
        published = read_batch_manifest(spark, output_path, batch_id)
        if published is not None:
            validate_manifest_retry(published, source_ranges, total)
            LAST_BATCH_STORED_COUNT = int(published.get("storedCount") or 0)
            LAST_BATCH_QUARANTINED_COUNT = int(published.get("quarantinedCount") or 0)
            LAST_BATCH_WRITTEN = True
            PUBLISHED_BATCHES = sorted(
                [
                    item for item in PUBLISHED_BATCHES
                    if (int(item["batchId"]) if item.get("batchId") is not None else -1) != batch_id
                ] + [published],
                key=lambda item: int(item.get("batchId") or 0),
            )
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
            )
            LAST_BATCH_EVIDENCE = {**published, "status": "success", "lastError": None, "dagSteps": dag_steps}
            CURRENT_BATCH_CONTEXT = {}
            report("running", batch_id=batch_id)
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
            raise
        stage_durations.update(rule_execution.get("timings") or {})
        target_started_at = time.monotonic()
        CURRENT_BATCH_CONTEXT.update({
            "current_stage": "target",
            "quality": rule_execution["quality"],
            "transform": rule_execution["transform"],
        })
        transformed = rule_execution["frame"].persist()
        persisted_frames.append(transformed)
        target_frame = select_continuous_target(transformed).persist()
        persisted_frames.append(target_frame)
        stored_count = target_frame.count()
        rule_quarantine = rule_execution["quarantine"]
        rule_quarantine_count = rule_quarantine.count() if rule_quarantine is not None else 0
        quarantined_count = schema_invalid_count + rule_quarantine_count
        data_path = f"{output_path.rstrip('/')}/_batches/batch_id={batch_id}" if stored_count else None
        quarantine_batch_path = f"{quarantine_path.rstrip('/')}/_batches/batch_id={batch_id}" if quarantined_count else None
        evidence_batch_path = None
        if stored_count:
            write_batch_once(
                spark,
                target_frame,
                output_path,
                batch_id,
                {
                    "batchId": batch_id,
                    "inputCount": stored_count,
                    "outputKind": "target",
                    "sourceRanges": source_ranges,
                },
            )
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
        test_batch_delay("after_data_write")
        stage_durations["targetDurationMs"] = max(0, round((time.monotonic() - target_started_at) * 1000))
        CURRENT_BATCH_CONTEXT.update({
            "current_stage": "manifest-checkpoint",
            "data_path": data_path,
            "quarantine_path": quarantine_batch_path,
            "quarantined_count": quarantined_count,
            "stored_count": stored_count,
        })
        if os.environ.get("ASKLAKE_CONTINUOUS_FAIL_AFTER_DATA_WRITE_ONCE", "").lower() == "true":
            fault_marker = runtime_location_with_suffix(REPORT_LOCATION, ".publish-fault-applied")
            if not runtime_text_exists(fault_marker):
                write_runtime_text(fault_marker, now())
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
        )
        published_manifest = {
            "batchId": batch_id,
            "publicationId": f"stream:{JOB_ID}:batch:{batch_id}",
            "publicationType": "stream",
            "publishedAt": published_at,
            "topic": os.environ["ASKLAKE_CONTINUOUS_TOPIC"],
            "sourceRanges": source_ranges,
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
            "schemaFingerprint": SCHEMA_STATE["schemaFingerprint"],
            "transform": rule_execution["transform"],
            "quality": rule_execution["quality"],
            "durationMs": batch_duration_ms,
            "dataPath": data_path,
            "quarantinePath": quarantine_batch_path,
            "schemaEvidencePath": evidence_batch_path,
            "manifestPath": manifest_path(output_path, batch_id),
            "dagSteps": batch_dag_steps,
        }
        write_batch_manifest(spark, output_path, batch_id, published_manifest)
        PUBLISHED_BATCHES = sorted(
            [
                item for item in PUBLISHED_BATCHES
                if (int(item["batchId"]) if item.get("batchId") is not None else -1) != batch_id
            ] + [published_manifest],
            key=lambda item: int(item.get("batchId") or 0),
        )
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

    report("starting")
    QUERY = (parsed.writeStream.foreachBatch(write_batch)
        .option("checkpointLocation", checkpoint_path)
        .trigger(processingTime=f"{trigger_seconds} seconds")
        .start())
    if STOP_REQUESTED:
        QUERY.stop()
    else:
        report("running")
    while QUERY.isActive:
        QUERY.awaitTermination(5)
        if STOP_REQUESTED and QUERY.isActive:
            # Run outside the signal handler. Spark's graceful stop waits for an
            # in-flight foreachBatch callback instead of allowing it to return
            # successfully without publishing its source range.
            QUERY.stop()
            break
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
        try:
            report("failed", error=str(exc)[:2000])
        except Exception:  # noqa: BLE001 - preserve the original worker failure.
            print(json.dumps({"status": "failed", "lastError": str(exc)[:2000]}), flush=True)
        raise
