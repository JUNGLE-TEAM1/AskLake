"""Finite Spark maintenance tasks for Kafka continuous targets."""

import json
import math
import os
from datetime import datetime, timezone

from pyspark.sql import SparkSession
from pyspark.sql.functions import array, array_except, col, concat_ws, from_json, lit, map_keys, size
from pyspark.sql.types import BooleanType, DoubleType, LongType, MapType, StringType, StructField, StructType, TimestampType


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


def source_schema():
    columns = json.loads(os.environ.get("ASKLAKE_MAINTENANCE_SCHEMA_COLUMNS", "[]"))
    selected = [item for item in columns if item.get("included", True)]
    fields, aliases, required = [], [], []
    for item in selected:
        source = str(item.get("sourceName") or item.get("targetName") or "").strip()
        target = str(item.get("targetName") or source).strip()
        if source and target:
            fields.append(StructField(source, spark_type(item.get("type")), True))
            aliases.append((source, target))
            if not bool(item.get("nullable", False)):
                required.append(source)
    return StructType(fields), aliases, required


def configure_s3a(spark: SparkSession):
    hadoop = spark.sparkContext._jsc.hadoopConfiguration()
    hadoop.set("fs.s3a.endpoint", os.environ.get("MINIO_ENDPOINT", "http://minio:9000"))
    hadoop.set("fs.s3a.access.key", os.environ.get("MINIO_ACCESS_KEY", ""))
    hadoop.set("fs.s3a.secret.key", os.environ.get("MINIO_SECRET_KEY", ""))
    hadoop.set("fs.s3a.path.style.access", "true")
    hadoop.set("fs.s3a.connection.ssl.enabled", "false")


def output_exists(spark: SparkSession, path: str) -> bool:
    jvm = spark.sparkContext._jvm
    hadoop = spark.sparkContext._jsc.hadoopConfiguration()
    target = jvm.org.apache.hadoop.fs.Path(path)
    return bool(target.getFileSystem(hadoop).exists(target))


def output_committed(spark: SparkSession, path: str) -> bool:
    return output_exists(spark, f"{path.rstrip('/')}/_SUCCESS")


def completed_batch_paths(spark: SparkSession, root: str) -> list[str]:
    if not output_exists(spark, root):
        return []
    jvm = spark.sparkContext._jvm
    hadoop = spark.sparkContext._jsc.hadoopConfiguration()
    root_path = jvm.org.apache.hadoop.fs.Path(root)
    paths = []
    for status in root_path.getFileSystem(hadoop).listStatus(root_path):
        child = str(status.getPath())
        if status.isDirectory() and status.getPath().getName().startswith("batch_id=") and output_committed(spark, child):
            paths.append(child)
    return sorted(paths)


def read_completed_batches(spark: SparkSession, root: str):
    paths = completed_batch_paths(spark, root)
    if not paths:
        return None
    return spark.read.option("basePath", root).parquet(*paths)


def parquet_file_stats(spark: SparkSession, path: str) -> dict[str, int]:
    if not output_exists(spark, path):
        return {"count": 0, "bytes": 0}
    jvm = spark.sparkContext._jvm
    hadoop = spark.sparkContext._jsc.hadoopConfiguration()
    root = jvm.org.apache.hadoop.fs.Path(path)
    iterator = root.getFileSystem(hadoop).listFiles(root, True)
    count, total_bytes = 0, 0
    while iterator.hasNext():
        status = iterator.next()
        if status.getPath().getName().endswith(".parquet"):
            count += 1
            total_bytes += int(status.getLen())
    return {"count": count, "bytes": total_bytes}


def parquet_paths_stats(spark: SparkSession, paths: list[str]) -> dict[str, int]:
    result = {"count": 0, "bytes": 0}
    for path in paths:
        current = parquet_file_stats(spark, path)
        result["count"] += current["count"]
        result["bytes"] += current["bytes"]
    return result


def read_quarantine(spark: SparkSession, output_path: str):
    path = f"{output_path.rstrip('/')}/_quarantine/_batches"
    return read_completed_batches(spark, path)


def inspect_quarantine(spark: SparkSession, output_path: str):
    frame = read_quarantine(spark, output_path)
    if frame is None:
        return {"records": [], "total": 0}
    target_path = f"{output_path.rstrip('/')}/_batches"
    target = read_completed_batches(spark, target_path)
    if target is not None:
        target_offsets = (target
            .select(col("kafka_partition").alias("partition"), col("kafka_offset").alias("offset"))
            .distinct().withColumn("replayed", lit(True)))
        frame = frame.join(target_offsets, ["partition", "offset"], "left")
    else:
        frame = frame.withColumn("replayed", lit(False))
    limit = min(max(int(os.environ.get("ASKLAKE_MAINTENANCE_LIMIT", "100")), 1), 500)
    total = frame.count()
    records = []
    for row in frame.orderBy(col("quarantined_at").desc()).limit(limit).collect():
        item = row.asDict(recursive=True)
        records.append({
            "topic": str(item.get("topic") or ""),
            "partition": int(item.get("partition") or 0),
            "offset": int(item.get("offset") or 0),
            "rawPayload": str(item.get("raw_payload") or ""),
            "reason": str(item.get("reason") or "malformed_json"),
            "schemaFingerprint": item.get("schema_fingerprint"),
            "quarantinedAt": str(item.get("quarantined_at") or ""),
            "replayStatus": "replayed" if bool(item.get("replayed")) else "pending",
        })
    return {"records": records, "total": total}


def replay_quarantine(spark: SparkSession, output_path: str, run_id: str):
    frame = read_quarantine(spark, output_path)
    if frame is None:
        return {"inputCount": 0, "storedCount": 0, "skippedCount": 0, "failedCount": 0}
    requested = set(json.loads(os.environ.get("ASKLAKE_MAINTENANCE_OFFSETS", "[]")))
    if requested:
        keys = [f"{partition}:{offset}" for partition, offset in (item.split(":", 1) for item in requested)]
        frame = frame.where(concat_ws(":", col("partition").cast("string"), col("offset").cast("string")).isin(keys))
    input_count = frame.count()
    schema, aliases, required = source_schema()
    policy = {
        "additiveNullable": "allow",
        "missingRequired": "quarantine",
        "incompatibleType": "quarantine",
        "unknownField": "preserve",
        **json.loads(os.environ.get("ASKLAKE_MAINTENANCE_SCHEMA_POLICY", "{}")),
    }
    approve_unknown_fields = os.environ.get("ASKLAKE_MAINTENANCE_APPROVE_UNKNOWN_FIELDS", "false").lower() == "true"
    if approve_unknown_fields:
        policy["additiveNullable"] = "allow"
        policy["unknownField"] = "ignore"
    parsed = (frame
        .withColumn("raw_map", from_json(col("raw_payload"), MapType(StringType(), StringType())))
        .withColumn("payload", from_json(col("raw_payload"), schema)))
    malformed = col("raw_map").isNull() | col("payload").isNull()
    required_missing = lit(False)
    incompatible_type = lit(False)
    for field, _target in aliases:
        source_value = col("raw_map").getItem(field)
        parsed_value_missing = col(f"payload.`{field}`").isNull()
        if field in required:
            required_missing = required_missing | source_value.isNull()
        incompatible_type = incompatible_type | (source_value.isNotNull() & parsed_value_missing)
    expected_keys = array(*[lit(source) for source, _target in aliases])
    unknown_condition = col("raw_map").isNotNull() & (size(array_except(map_keys(col("raw_map")), expected_keys)) > 0)
    pause_condition = lit(False)
    if policy.get("missingRequired") == "pause":
        pause_condition = pause_condition | required_missing
    if policy.get("incompatibleType") == "pause":
        pause_condition = pause_condition | incompatible_type
    if policy.get("unknownField") == "pause" or policy.get("additiveNullable") == "pause":
        pause_condition = pause_condition | unknown_condition
    if parsed.where(~malformed & pause_condition).limit(1).count():
        raise RuntimeError("Current schema evolution policy paused quarantine replay.")
    invalid_condition = malformed
    if policy.get("missingRequired") in {"quarantine", "pause"}:
        invalid_condition = invalid_condition | required_missing
    if policy.get("incompatibleType") in {"quarantine", "pause"}:
        invalid_condition = invalid_condition | incompatible_type
    if policy.get("unknownField") in {"quarantine", "pause"} or policy.get("additiveNullable") in {"quarantine", "pause"}:
        invalid_condition = invalid_condition | unknown_condition
    valid = parsed.where(~invalid_condition)
    failed_count = input_count - valid.count()
    target_root = f"{output_path.rstrip('/')}/_batches"
    existing_target = read_completed_batches(spark, target_root)
    if existing_target is not None:
        existing = (existing_target
            .select(col("kafka_partition").alias("partition"), col("kafka_offset").alias("offset")).distinct())
        valid = valid.join(existing, ["partition", "offset"], "left_anti")
    stored_count = valid.count()
    skipped_count = input_count - failed_count - stored_count
    replay_path = f"{target_root}/batch_id=replay_{run_id}"
    if stored_count:
        selected = [col(f"payload.`{source}`").alias(target) for source, target in aliases]
        valid.select(
            *selected,
            col("kafka_timestamp"),
            col("partition").alias("kafka_partition"),
            col("offset").alias("kafka_offset"),
            col("quarantined_at").alias("ingested_at"),
        ).write.mode("errorifexists").parquet(replay_path)
    return {
        "inputCount": input_count,
        "storedCount": stored_count,
        "skippedCount": skipped_count,
        "failedCount": failed_count,
        "outputPath": replay_path if stored_count else None,
        "appliedSchemaPolicy": policy,
        "policyOverride": "approve_unknown_fields" if approve_unknown_fields else None,
    }


def compact(spark: SparkSession, output_path: str, run_id: str):
    source_path = f"{output_path.rstrip('/')}/_batches"
    frame = read_completed_batches(spark, source_path)
    if frame is None:
        return {"inputRows": 0, "inputFiles": 0, "outputFiles": 0, "outputPath": None}
    input_rows = frame.count()
    input_stats = parquet_paths_stats(spark, completed_batch_paths(spark, source_path))
    target_mb = min(max(int(os.environ.get("ASKLAKE_MAINTENANCE_TARGET_MB", "256")), 128), 512)
    target_bytes = target_mb * 1024 * 1024
    partitions = max(1, math.ceil(input_stats["bytes"] / target_bytes))
    destination = f"{output_path.rstrip('/')}/_compactions/run_id={run_id}"
    source_partitions = frame.rdd.getNumPartitions()
    compacted = frame.coalesce(partitions) if partitions <= source_partitions else frame.repartition(partitions)
    compacted.write.mode("errorifexists").parquet(destination)
    output_stats = parquet_file_stats(spark, destination)
    return {
        "inputRows": input_rows,
        "inputFiles": input_stats["count"],
        "inputBytes": input_stats["bytes"],
        "averageInputFileSizeBytes": round(input_stats["bytes"] / input_stats["count"]) if input_stats["count"] else 0,
        "outputFiles": output_stats["count"],
        "outputBytes": output_stats["bytes"],
        "averageOutputFileSizeBytes": round(output_stats["bytes"] / output_stats["count"]) if output_stats["count"] else 0,
        "outputPath": destination,
        "targetFileSizeMb": target_mb,
        "sourcePartitions": source_partitions,
        "targetPartitions": partitions,
        "sourceDeleted": False,
    }


def main():
    kind = os.environ["ASKLAKE_MAINTENANCE_KIND"]
    run_id = os.environ["ASKLAKE_MAINTENANCE_RUN_ID"]
    output_path = os.environ["ASKLAKE_MAINTENANCE_OUTPUT_PATH"]
    spark = SparkSession.builder.appName(f"asklake-{kind}-{run_id}").getOrCreate()
    configure_s3a(spark)
    if kind == "inspect_quarantine":
        result = inspect_quarantine(spark, output_path)
    elif kind == "quarantine_replay":
        result = replay_quarantine(spark, output_path, run_id)
    elif kind == "compaction":
        result = compact(spark, output_path, run_id)
    else:
        raise ValueError(f"Unsupported maintenance kind: {kind}")
    result.update({"endedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"), "runId": run_id})
    print(f"ASKLAKE_CONTINUOUS_MAINTENANCE_RESULT={json.dumps(result)}")


if __name__ == "__main__":
    main()
