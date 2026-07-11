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
from pyspark.sql.functions import array, array_except, col, current_timestamp, explode, from_json, lit, map_keys, min as spark_min, max as spark_max, size, when
from pyspark.sql.types import BooleanType, DoubleType, LongType, MapType, StringType, StructField, StructType, TimestampType


def json_object_env(name: str) -> dict[str, Any]:
    try:
        value = json.loads(os.environ.get(name, "{}"))
    except json.JSONDecodeError:
        return {}
    return value if isinstance(value, dict) else {}


JOB_ID = os.environ["ASKLAKE_CONTINUOUS_JOB_ID"]
WORKER_ATTEMPT_ID = os.environ.get("ASKLAKE_CONTINUOUS_WORKER_ATTEMPT_ID")
REPORT_FILE = Path(os.environ["ASKLAKE_CONTINUOUS_REPORT_FILE"])
COMMAND_FILE = Path(os.environ["ASKLAKE_CONTINUOUS_COMMAND_FILE"])
STOP_REQUESTED = False
QUERY = None
INITIAL_COUNTS = json.loads(os.environ.get("ASKLAKE_CONTINUOUS_INITIAL_COUNTS", "{}"))
INITIAL_METRICS = json_object_env("ASKLAKE_CONTINUOUS_INITIAL_METRICS")
INITIAL_SCHEMA_STATE = json_object_env("ASKLAKE_CONTINUOUS_INITIAL_SCHEMA_STATE")
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


def source_schema() -> tuple[StructType, list[tuple[str, str]], list[str]]:
    columns = json.loads(os.environ.get("ASKLAKE_CONTINUOUS_SCHEMA_COLUMNS", "[]"))
    selected = [column for column in columns if column.get("included", True)]
    fields = []
    aliases = []
    required = []
    for column_def in selected:
        source = str(column_def.get("sourceName") or column_def.get("targetName") or "").strip()
        target = str(column_def.get("targetName") or source).strip()
        if source and target:
            fields.append(StructField(source, spark_type(str(column_def.get("type") or "string")), True))
            aliases.append((source, target))
            if not bool(column_def.get("nullable", False)):
                required.append(source)
    if not fields:
        fields.append(StructField("value", StringType(), True))
        aliases.append(("value", "value"))
    fingerprint_payload = [{"name": field.name, "type": field.dataType.simpleString(), "required": field.name in required} for field in fields]
    previous_fingerprint = SCHEMA_STATE.get("schemaFingerprint")
    fingerprint = hashlib.sha256(json.dumps(fingerprint_payload, sort_keys=True).encode("utf-8")).hexdigest()
    if previous_fingerprint and previous_fingerprint != fingerprint:
        SCHEMA_STATE["schemaVersion"] = int(SCHEMA_STATE.get("schemaVersion") or 1) + 1
        SCHEMA_STATE["schemaStatus"] = "expected_schema_changed"
        SCHEMA_STATE["schemaChanges"] = [{"kind": "configured_schema_changed", "from": previous_fingerprint, "to": fingerprint}]
    SCHEMA_STATE["schemaFingerprint"] = fingerprint
    return StructType(fields), aliases, required


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


def canonical_publication_signature(signature: dict[str, Any]) -> dict[str, Any]:
    return {
        "batchId": int(signature.get("batchId") or 0),
        "inputCount": int(signature.get("inputCount") or 0),
        "outputKind": str(signature.get("outputKind") or "target"),
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
    if int(manifest.get("consumedCount") or 0) != total or ranges_mismatch:
        raise RuntimeError("Existing batch manifest does not match the current Kafka offset range; checkpoint reuse is unsafe.")


def main() -> None:
    global QUERY, LAST_BATCH_ID, LAST_FLUSH_AT, LAST_BATCH_STORED_COUNT, LAST_BATCH_QUARANTINED_COUNT, LAST_BATCH_WRITTEN, PUBLISHED_BATCHES
    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)
    schema, aliases, required_fields = source_schema()
    output_path = os.environ["ASKLAKE_CONTINUOUS_OUTPUT_PATH"]
    checkpoint_path = os.environ["ASKLAKE_CONTINUOUS_CHECKPOINT_PATH"]
    quarantine_path = f"{output_path.rstrip('/')}/_quarantine"
    trigger_seconds = int(os.environ.get("ASKLAKE_CONTINUOUS_TRIGGER_SECONDS", "30"))

    spark = SparkSession.builder.appName(f"asklake-kafka-continuous-{JOB_ID}").getOrCreate()
    configure_s3a(spark)
    recovered = recover_published_state(spark, output_path)
    for key, value in recovered["counts"].items():
        COUNTERS[key] = max(COUNTERS[key], value)
    PUBLISHED_BATCHES = recovered["batches"]
    if PUBLISHED_BATCHES:
        latest = PUBLISHED_BATCHES[-1]
        LAST_BATCH_ID = int(latest.get("batchId") or 0)
        LAST_FLUSH_AT = str(latest.get("publishedAt") or "") or None
        LAST_BATCH_STORED_COUNT = int(latest.get("storedCount") or 0)
        LAST_BATCH_QUARANTINED_COUNT = int(latest.get("quarantinedCount") or 0)
        LAST_BATCH_WRITTEN = True
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
                [item for item in PUBLISHED_BATCHES if int(item.get("batchId") or -1) != batch_id] + [published],
                key=lambda item: int(item.get("batchId") or 0),
            )
            report("running", batch_id=batch_id)
            batch.unpersist()
            return
        required_missing = lit(False)
        incompatible_type = lit(False)
        for field_name, _target in aliases:
            source_value = col("raw_map").getItem(field_name)
            parsed_value_missing = col(f"payload.`{field_name}`").isNull()
            if field_name in required_fields:
                required_missing = required_missing | source_value.isNull()
            incompatible_type = incompatible_type | (source_value.isNotNull() & parsed_value_missing)
        malformed = col("raw_map").isNull() | col("payload").isNull()
        expected_keys = array(*[lit(source) for source, _target in aliases])
        unknown_keys = array_except(map_keys(col("raw_map")), expected_keys)
        unknown_condition = col("raw_map").isNotNull() & (size(unknown_keys) > 0)
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
        valid_count = valid.count()
        invalid_count = total - valid_count
        data_path = f"{output_path.rstrip('/')}/_batches/batch_id={batch_id}" if valid_count else None
        quarantine_batch_path = f"{quarantine_path.rstrip('/')}/_batches/batch_id={batch_id}" if invalid_count else None
        evidence_batch_path = None
        if valid_count:
            selected = [col(f"payload.`{source}`").alias(target) for source, target in aliases]
            write_batch_once(
                spark,
                valid.select(*selected, col("kafka_timestamp"), col("partition").alias("kafka_partition"), col("offset").alias("kafka_offset"), current_timestamp().alias("ingested_at")),
                output_path,
                batch_id,
                {
                    "batchId": batch_id,
                    "inputCount": valid_count,
                    "outputKind": "target",
                    "sourceRanges": batch_source_ranges(valid),
                },
            )
        if invalid_count:
            write_batch_once(
                spark,
                invalid.select(
                    "topic", "partition", "offset", "kafka_timestamp", "raw_payload",
                    when(malformed, lit("malformed_json"))
                    .when(required_missing, lit("missing_required"))
                    .when(incompatible_type, lit("incompatible_type"))
                    .when(unknown_condition, lit("unknown_field"))
                    .otherwise(lit("schema_policy_rejected")).alias("reason"),
                    lit(SCHEMA_STATE["schemaFingerprint"]).alias("schema_fingerprint"),
                    current_timestamp().alias("quarantined_at"),
                ),
                quarantine_path,
                batch_id,
                {
                    "batchId": batch_id,
                    "inputCount": invalid_count,
                    "outputKind": "quarantine",
                    "sourceRanges": batch_source_ranges(invalid),
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
            "storedCount": valid_count,
            "quarantinedCount": invalid_count,
            "durationMs": max(0, round((time.monotonic() - batch_started_at) * 1000)),
            "dataPath": data_path,
            "quarantinePath": quarantine_batch_path,
            "schemaEvidencePath": evidence_batch_path,
            "manifestPath": manifest_path(output_path, batch_id),
        }
        write_batch_manifest(spark, output_path, batch_id, published_manifest)
        PUBLISHED_BATCHES = sorted(
            [item for item in PUBLISHED_BATCHES if int(item.get("batchId") or -1) != batch_id] + [published_manifest],
            key=lambda item: int(item.get("batchId") or 0),
        )
        LAST_BATCH_STORED_COUNT = valid_count
        LAST_BATCH_QUARANTINED_COUNT = invalid_count
        LAST_BATCH_WRITTEN = True
        COUNTERS["consumedCount"] += total
        COUNTERS["storedCount"] += valid_count
        COUNTERS["quarantinedCount"] += invalid_count
        report("running", batch_id=batch_id)
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
