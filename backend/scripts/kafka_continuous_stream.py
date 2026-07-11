"""Long-running Kafka to Parquet Structured Streaming worker for AskLake."""

import json
import hashlib
import os
import signal
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from pyspark.sql import DataFrame, SparkSession
from pyspark.sql.functions import array, array_except, col, current_timestamp, explode, from_json, lit, map_keys, max as spark_max, size, sum as spark_sum, when
from pyspark.sql.types import BooleanType, DoubleType, LongType, MapType, StringType, StructField, StructType, TimestampType


def json_object_env(name: str) -> dict[str, Any]:
    try:
        value = json.loads(os.environ.get(name, "{}"))
    except json.JSONDecodeError:
        return {}
    return value if isinstance(value, dict) else {}


JOB_ID = os.environ["ASKLAKE_CONTINUOUS_JOB_ID"]
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


def report(status: str, *, batch_id: int | None = None, error: str | None = None) -> None:
    global LAST_BATCH_ID, LAST_FLUSH_AT
    if batch_id is not None:
        LAST_BATCH_ID = batch_id
        LAST_FLUSH_AT = now()
    REPORT_FILE.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "status": status,
        "heartbeatAt": now(),
        "lastFlushAt": LAST_FLUSH_AT,
        "lastBatchId": str(LAST_BATCH_ID) if LAST_BATCH_ID is not None else None,
        "lastBatchStoredCount": LAST_BATCH_STORED_COUNT,
        "lastBatchQuarantinedCount": LAST_BATCH_QUARANTINED_COUNT,
        "lastBatchWritten": LAST_BATCH_WRITTEN,
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


def batch_output_exists(spark: SparkSession, output_path: str) -> bool:
    jvm = spark.sparkContext._jvm
    hadoop = spark.sparkContext._jsc.hadoopConfiguration()
    path = jvm.org.apache.hadoop.fs.Path(output_path)
    return bool(path.getFileSystem(hadoop).exists(path))


def write_batch_once(spark: SparkSession, frame: DataFrame, root: str, batch_id: int) -> bool:
    # Spark retries the same batch ID after a failed checkpoint commit. A stable
    # batch directory turns that retry into an idempotent target publication.
    batch_path = f"{root.rstrip('/')}/_batches/batch_id={batch_id}"
    if batch_output_exists(spark, batch_path):
        return False
    frame.write.mode("errorifexists").parquet(batch_path)
    return True


def manifest_path(root: str, batch_id: int) -> str:
    return f"{root.rstrip('/')}/_batch-manifests/batch_id={batch_id}"


def read_batch_manifest(spark: SparkSession, root: str, batch_id: int) -> dict[str, int] | None:
    path = manifest_path(root, batch_id)
    if not batch_output_exists(spark, path):
        return None
    row = spark.read.json(path).first()
    if row is None:
        return None
    return {
        "consumedCount": int(row["consumedCount"] or 0),
        "storedCount": int(row["storedCount"] or 0),
        "quarantinedCount": int(row["quarantinedCount"] or 0),
    }


def write_batch_manifest(spark: SparkSession, root: str, batch_id: int, counts: dict[str, int]) -> None:
    spark.createDataFrame([counts]).write.mode("errorifexists").json(manifest_path(root, batch_id))


def recover_published_counts(spark: SparkSession, root: str) -> dict[str, int]:
    manifest_root = f"{root.rstrip('/')}/_batch-manifests"
    if not batch_output_exists(spark, manifest_root):
        return {"consumedCount": 0, "storedCount": 0, "quarantinedCount": 0}
    row = (spark.read.json(f"{manifest_root}/*")
        .agg(
            spark_sum("consumedCount").alias("consumedCount"),
            spark_sum("storedCount").alias("storedCount"),
            spark_sum("quarantinedCount").alias("quarantinedCount"),
        ).first())
    return {key: int(row[key] or 0) for key in ("consumedCount", "storedCount", "quarantinedCount")}


def main() -> None:
    global QUERY, LAST_BATCH_STORED_COUNT, LAST_BATCH_QUARANTINED_COUNT, LAST_BATCH_WRITTEN
    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)
    schema, aliases, required_fields = source_schema()
    output_path = os.environ["ASKLAKE_CONTINUOUS_OUTPUT_PATH"]
    checkpoint_path = os.environ["ASKLAKE_CONTINUOUS_CHECKPOINT_PATH"]
    quarantine_path = f"{output_path.rstrip('/')}/_quarantine"
    trigger_seconds = int(os.environ.get("ASKLAKE_CONTINUOUS_TRIGGER_SECONDS", "30"))

    spark = SparkSession.builder.appName(f"asklake-kafka-continuous-{JOB_ID}").getOrCreate()
    configure_s3a(spark)
    for key, value in recover_published_counts(spark, output_path).items():
        COUNTERS[key] = max(COUNTERS[key], value)
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
        global LAST_BATCH_STORED_COUNT, LAST_BATCH_QUARANTINED_COUNT, LAST_BATCH_WRITTEN
        if STOP_REQUESTED:
            return
        batch.persist()
        total = batch.count()
        if total == 0:
            # Keep the last non-empty batch publication visible to the control
            # plane. Spark can invoke foreachBatch for empty microbatches while
            # the stream is idle, and those must not erase Catalog retry state.
            report("running")
            batch.unpersist()
            return
        for row in batch.groupBy("partition").agg(spark_max("offset").alias("max_offset")).collect():
            PROCESSED_OFFSETS[str(row["partition"])] = int(row["max_offset"]) + 1
        published = read_batch_manifest(spark, output_path, batch_id)
        if published is not None:
            LAST_BATCH_STORED_COUNT = published["storedCount"]
            LAST_BATCH_QUARANTINED_COUNT = published["quarantinedCount"]
            LAST_BATCH_WRITTEN = True
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
        valid_written = False
        invalid_written = False
        if valid_count:
            selected = [col(f"payload.`{source}`").alias(target) for source, target in aliases]
            valid_written = write_batch_once(
                spark,
                valid.select(*selected, col("kafka_timestamp"), col("partition").alias("kafka_partition"), col("offset").alias("kafka_offset"), current_timestamp().alias("ingested_at")),
                output_path,
                batch_id,
            )
        if invalid_count:
            invalid_written = write_batch_once(
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
            )
        if unknown_fields and SCHEMA_POLICY.get("unknownField") == "preserve":
            write_batch_once(
                spark,
                batch.where(unknown_condition).select(
                    "topic", "partition", "offset", "kafka_timestamp", "raw_payload",
                    unknown_keys.alias("unknown_fields"),
                    lit(SCHEMA_STATE["schemaFingerprint"]).alias("schema_fingerprint"),
                    current_timestamp().alias("observed_at"),
                ),
                f"{output_path.rstrip('/')}/_schema-evidence",
                batch_id,
            )
        # The manifest is published only after both valid and quarantine paths
        # are durable. It is the accounting authority across worker restarts.
        published_counts = {
            "consumedCount": total,
            "storedCount": valid_count,
            "quarantinedCount": invalid_count,
        }
        write_batch_manifest(spark, output_path, batch_id, published_counts)
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
