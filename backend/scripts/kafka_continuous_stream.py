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
from snapshot_rule_runtime import SnapshotRuleExecutionError, apply_snapshot_rules, supports_snapshot_rules


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
REPORT_FILE = Path(os.environ["ASKLAKE_CONTINUOUS_REPORT_FILE"])
COMMAND_FILE = Path(os.environ["ASKLAKE_CONTINUOUS_COMMAND_FILE"])
STOP_REQUESTED = False
QUERY = None
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


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def apply_catalog_ack() -> None:
    global PUBLISHED_BATCHES
    ack_path = REPORT_FILE.with_suffix(".catalog-ack.json")
    try:
        payload = json.loads(ack_path.read_text(encoding="utf-8"))
        acknowledged_batch = int(payload.get("batchId"))
    except (OSError, TypeError, ValueError, json.JSONDecodeError):
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
        **METRICS,
        **SCHEMA_STATE,
        **COUNTERS,
        "ruleContractVersion": RULE_CONTRACT_VERSION,
        "ruleFingerprint": RULE_FINGERPRINT,
        "runtimeFingerprint": RUNTIME_FINGERPRINT,
        "ruleMetrics": RULE_METRICS,
        "lastRuleResult": LAST_RULE_RESULT,
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
    endpoint = os.environ.get("MINIO_ENDPOINT", "")
    if not endpoint:
        return
    hadoop = spark.sparkContext._jsc.hadoopConfiguration()
    hadoop.set("fs.s3a.endpoint", endpoint)
    hadoop.set("fs.s3a.access.key", os.environ.get("MINIO_ACCESS_KEY", ""))
    hadoop.set("fs.s3a.secret.key", os.environ.get("MINIO_SECRET_KEY", ""))
    hadoop.set("fs.s3a.path.style.access", "true")
    hadoop.set("fs.s3a.connection.ssl.enabled", "false")


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
    global QUERY, LAST_BATCH_ID, LAST_FLUSH_AT, LAST_BATCH_STORED_COUNT, LAST_BATCH_QUARANTINED_COUNT, LAST_BATCH_WRITTEN, PUBLISHED_BATCHES
    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)
    schema, aliases, required_fields = source_schema()
    expected_keys_by_parent = expected_object_keys(source for source, _target in aliases)
    output_path = os.environ["ASKLAKE_CONTINUOUS_OUTPUT_PATH"]
    checkpoint_path = os.environ["ASKLAKE_CONTINUOUS_CHECKPOINT_PATH"]
    quarantine_path = f"{output_path.rstrip('/')}/_quarantine"
    trigger_seconds = int(os.environ.get("ASKLAKE_CONTINUOUS_TRIGGER_SECONDS", "30"))

    spark = SparkSession.builder.appName(f"asklake-kafka-continuous-{JOB_ID}").getOrCreate()
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

    def write_batch(batch: DataFrame, batch_id: int) -> None:
        global LAST_BATCH_STORED_COUNT, LAST_BATCH_QUARANTINED_COUNT, LAST_BATCH_WRITTEN, PUBLISHED_BATCHES
        if STOP_REQUESTED:
            return
        batch_started_at = time.monotonic()
        batch.persist()
        total = batch.count()
        if total == 0:
            # Keep the last non-empty batch publication visible to the control
            # plane. Spark can invoke foreachBatch for empty microbatches while
            # the stream is idle, and those must not erase Catalog retry state.
            report("running")
            batch.unpersist()
            return
        source_ranges = batch_source_ranges(batch)
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
        if batch.where(~malformed & pause_condition).limit(1).count():
            SCHEMA_STATE["schemaStatus"] = "policy_paused"
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
        try:
            rule_execution = apply_snapshot_rules(projected, RULES)
        except SnapshotRuleExecutionError as exc:
            update_rule_metrics(exc.transform or {}, exc.quality or {}, failed=True)
            report("failed", error=str(exc)[:2000])
            batch.unpersist()
            raise
        transformed = rule_execution["frame"].persist()
        target_frame = select_continuous_target(transformed).persist()
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
        if os.environ.get("ASKLAKE_CONTINUOUS_FAIL_AFTER_DATA_WRITE_ONCE", "").lower() == "true":
            fault_marker = REPORT_FILE.with_suffix(".publish-fault-applied")
            if not fault_marker.exists():
                fault_marker.write_text(now(), encoding="utf-8")
                raise RuntimeError("Injected failure after data write and before manifest publication.")
        published_at = now()
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
            "durationMs": max(0, round((time.monotonic() - batch_started_at) * 1000)),
            "dataPath": data_path,
            "quarantinePath": quarantine_batch_path,
            "schemaEvidencePath": evidence_batch_path,
            "manifestPath": manifest_path(output_path, batch_id),
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
        COUNTERS["failedCount"] += 1
        report("failed", error=str(exc)[:2000])
        raise
