"""Long-running Kafka to Parquet Structured Streaming worker for AskLake."""

import json
import os
import signal
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from pyspark.sql import DataFrame, SparkSession
from pyspark.sql.functions import col, current_timestamp, from_json
from pyspark.sql.types import BooleanType, DoubleType, LongType, StringType, StructField, StructType, TimestampType


JOB_ID = os.environ["ASKLAKE_CONTINUOUS_JOB_ID"]
REPORT_FILE = Path(os.environ["ASKLAKE_CONTINUOUS_REPORT_FILE"])
COMMAND_FILE = Path(os.environ["ASKLAKE_CONTINUOUS_COMMAND_FILE"])
STOP_REQUESTED = False
QUERY = None
COUNTERS = {"consumedCount": 0, "storedCount": 0, "quarantinedCount": 0, "failedCount": 0}
LAST_BATCH_ID: int | None = None
LAST_FLUSH_AT: str | None = None


def now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


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
        "lag": None,
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


def source_schema() -> tuple[StructType, list[tuple[str, str]]]:
    columns = json.loads(os.environ.get("ASKLAKE_CONTINUOUS_SCHEMA_COLUMNS", "[]"))
    selected = [column for column in columns if column.get("included", True)]
    fields = []
    aliases = []
    for column_def in selected:
        source = str(column_def.get("sourceName") or column_def.get("targetName") or "").strip()
        target = str(column_def.get("targetName") or source).strip()
        if source and target:
            fields.append(StructField(source, spark_type(str(column_def.get("type") or "string")), True))
            aliases.append((source, target))
    if not fields:
        fields.append(StructField("value", StringType(), True))
        aliases.append(("value", "value"))
    return StructType(fields), aliases


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


def write_batch_once(spark: SparkSession, frame: DataFrame, root: str, batch_id: int) -> None:
    # Spark retries the same batch ID after a failed checkpoint commit. A stable
    # batch directory turns that retry into an idempotent target publication.
    batch_path = f"{root.rstrip('/')}/_batches/batch_id={batch_id}"
    if not batch_output_exists(spark, batch_path):
        frame.write.mode("errorifexists").parquet(batch_path)


def main() -> None:
    global QUERY
    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)
    schema, aliases = source_schema()
    output_path = os.environ["ASKLAKE_CONTINUOUS_OUTPUT_PATH"]
    checkpoint_path = os.environ["ASKLAKE_CONTINUOUS_CHECKPOINT_PATH"]
    quarantine_path = f"{output_path.rstrip('/')}/_quarantine"
    trigger_seconds = int(os.environ.get("ASKLAKE_CONTINUOUS_TRIGGER_SECONDS", "30"))

    spark = SparkSession.builder.appName(f"asklake-kafka-continuous-{JOB_ID}").getOrCreate()
    configure_s3a(spark)
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
    )

    def write_batch(batch: DataFrame, batch_id: int) -> None:
        if STOP_REQUESTED:
            return
        total = batch.count()
        valid = batch.where(col("payload").isNotNull())
        invalid = batch.where(col("payload").isNull())
        valid_count = valid.count()
        invalid_count = total - valid_count
        if valid_count:
            selected = [col(f"payload.`{source}`").alias(target) for source, target in aliases]
            write_batch_once(
                spark,
                valid.select(*selected, col("kafka_timestamp"), col("partition").alias("kafka_partition"), col("offset").alias("kafka_offset"), current_timestamp().alias("ingested_at")),
                output_path,
                batch_id,
            )
        if invalid_count:
            write_batch_once(
                spark,
                invalid.select("topic", "partition", "offset", "kafka_timestamp", "raw_payload", current_timestamp().alias("quarantined_at")),
                quarantine_path,
                batch_id,
            )
        COUNTERS["consumedCount"] += total
        COUNTERS["storedCount"] += valid_count
        COUNTERS["quarantinedCount"] += invalid_count
        report("running", batch_id=batch_id)

    report("starting")
    QUERY = (parsed.writeStream.foreachBatch(write_batch)
        .option("checkpointLocation", checkpoint_path)
        .trigger(processingTime=f"{trigger_seconds} seconds")
        .start())
    report("running")
    while QUERY.isActive:
        QUERY.awaitTermination(5)
        if QUERY.isActive:
            report("running")
    report("paused" if requested_action() == "pause" else "stopped")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001 - report worker failures to the control plane.
        COUNTERS["failedCount"] += 1
        report("failed", error=str(exc)[:2000])
        raise
