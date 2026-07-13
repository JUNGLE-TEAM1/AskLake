"""Finite Spark maintenance tasks for Kafka continuous targets."""

import json
import hashlib
import math
import os
import re
from datetime import datetime, timezone
from pathlib import Path

from pyspark.sql import SparkSession
from pyspark.sql import functions as F
from pyspark.sql.functions import array, array_except, array_union, col, concat, concat_ws, from_json, get_json_object, lit, map_keys, size, transform, when
from pyspark.sql.types import BooleanType, DoubleType, LongType, MapType, StringType, StructField, StructType, TimestampType
from pyspark.sql.window import Window

from kafka_schema_paths import build_nested_schema_tree, expected_object_keys, json_path, split_source_path
from object_storage_runtime import configure_spark_hadoop
from snapshot_rule_runtime import apply_snapshot_rules, supports_snapshot_rules
from spark_job_run import (
    commit_iceberg_table,
    iceberg_table_exists,
    make_spark,
    parse_iceberg_target,
    spark_iceberg_table_identifier,
)


RULE_CONTRACT_VERSION = os.environ.get("ASKLAKE_MAINTENANCE_RULE_CONTRACT_VERSION", "1.0")
RULE_FINGERPRINT = os.environ.get("ASKLAKE_MAINTENANCE_RULE_FINGERPRINT", "")
RULES = [
    rule for rule in json.loads(os.environ.get("ASKLAKE_MAINTENANCE_RULES", "[]"))
    if isinstance(rule, dict)
]
RULE_OUTPUT_SCHEMA = [
    item for item in json.loads(os.environ.get("ASKLAKE_MAINTENANCE_RULE_OUTPUT_SCHEMA", "[]"))
    if isinstance(item, (list, tuple)) and len(item) >= 2
]


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


def struct_type_from_tree(tree):
    return StructType([
        StructField(name, struct_type_from_tree(value) if isinstance(value, dict) else value, True)
        for name, value in tree.items()
    ])


def source_schema():
    columns = json.loads(os.environ.get("ASKLAKE_MAINTENANCE_SCHEMA_COLUMNS", "[]"))
    selected = [item for item in columns if item.get("included", True)]
    bindings, aliases, required = [], [], []
    for item in selected:
        source = str(item.get("sourceName") or item.get("targetName") or "").strip()
        target = str(item.get("targetName") or source).strip()
        if source and target:
            bindings.append((source, spark_type(item.get("sourceType") or item.get("type"))))
            aliases.append((source, target))
            if not bool(item.get("nullable", False)):
                required.append(source)
    return struct_type_from_tree(build_nested_schema_tree(bindings)), aliases, required


def nested_payload_column(source_path):
    value = col("payload")
    for segment in split_source_path(source_path):
        value = value.getField(segment)
    return value


def raw_source_value(source_path):
    return get_json_object(col("raw_payload"), json_path(source_path))


def unknown_field_expressions(expected_keys_by_parent):
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
            object_unknown_keys = transform(object_unknown_keys, lambda field: concat(lit(f"{parent_path}."), field))
        unknown_keys = object_unknown_keys if unknown_keys is None else array_union(unknown_keys, object_unknown_keys)
    return unknown_condition, unknown_keys if unknown_keys is not None else empty_array


def quoted_column(name):
    return col(f"`{str(name).replace('`', '``')}`")


def normalize_column_name(value):
    return re.sub(r"[^0-9A-Za-z_]+", "_", str(value or "").strip().lower()).strip("_")


def select_target(frame):
    selected = []
    for name, _type in RULE_OUTPUT_SCHEMA:
        resolved = str(name) if str(name) in frame.columns else normalize_column_name(name)
        if resolved not in frame.columns:
            raise RuntimeError(f"Continuous replay Rule output is missing compiled target column: {name}")
        selected.append(quoted_column(resolved).alias(str(name)))
    if not selected:
        selected = [
            quoted_column(name)
            for name in frame.columns
            if name not in {"topic", "partition", "offset", "kafka_timestamp", "raw_payload", "quarantined_at"}
        ]
    return frame.select(
        *selected,
        col("kafka_timestamp").cast("timestamp").alias("kafka_timestamp"),
        col("partition").cast("int").alias("kafka_partition"),
        col("offset").cast("long").alias("kafka_offset"),
        col("quarantined_at").cast("timestamp").alias("ingested_at"),
    )


def configure_s3a(spark: SparkSession):
    hadoop = spark.sparkContext._jsc.hadoopConfiguration()
    configure_spark_hadoop(hadoop)


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
    paths = completed_batch_paths(spark, path)
    if not paths:
        return None
    return spark.read.option("basePath", path).option("mergeSchema", "true").parquet(*paths)


def read_iceberg_target(spark: SparkSession, iceberg_target: dict):
    if not iceberg_table_exists(spark, iceberg_target):
        return None
    return spark.table(spark_iceberg_table_identifier(iceberg_target))


def inspect_quarantine(spark: SparkSession, output_path: str, iceberg_target: dict):
    frame = read_quarantine(spark, output_path)
    if frame is None:
        return {"records": [], "total": 0}
    target = read_iceberg_target(spark, iceberg_target)
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
            "ruleFingerprint": item.get("rule_fingerprint"),
            "ruleId": item.get("ruleId"),
            "stage": item.get("stage"),
            "targetColumn": item.get("targetColumn"),
            "quarantinedAt": str(item.get("quarantined_at") or ""),
            "replayStatus": "replayed" if bool(item.get("replayed")) else "pending",
        })
    return {"records": records, "total": total}


def replay_source_ranges(frame) -> list[dict]:
    distinct_offsets = frame.select("topic", "partition", "offset").distinct()
    grouped = (
        distinct_offsets
        .withColumn(
            "range_group",
            col("offset") - F.row_number().over(
                Window.partitionBy("topic", "partition").orderBy("offset")
            ),
        )
        .groupBy("topic", "partition", "range_group")
        .agg(
            F.min("offset").alias("start_offset"),
            F.max("offset").alias("end_offset"),
        )
        .orderBy("topic", "partition", "start_offset")
    )
    return [
        {
            "topic": str(row["topic"] or ""),
            "partition": int(row["partition"] or 0),
            "startOffset": int(row["start_offset"] or 0),
            "endOffset": int(row["end_offset"] or 0) + 1,
        }
        for row in grouped.collect()
    ]


def replay_source_boundary(run_id: str, source_ranges: list[dict]) -> dict:
    boundary = {
        "kind": "kafka_continuous_replay",
        "jobId": os.environ["ASKLAKE_MAINTENANCE_JOB_ID"],
        "runId": run_id,
        "sourceRanges": source_ranges,
    }
    boundary["boundaryId"] = hashlib.sha256(
        json.dumps(boundary, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return boundary


def replay_quarantine(spark: SparkSession, output_path: str, run_id: str, iceberg_target: dict):
    if not supports_snapshot_rules(RULES):
        raise RuntimeError("Continuous replay received a stateful or unsupported canonical Rule.")
    frame = read_quarantine(spark, output_path)
    if frame is None:
        return {"inputCount": 0, "storedCount": 0, "skippedCount": 0, "failedCount": 0}
    requested = set(json.loads(os.environ.get("ASKLAKE_MAINTENANCE_OFFSETS", "[]")))
    if requested:
        keys = [f"{partition}:{offset}" for partition, offset in (item.split(":", 1) for item in requested)]
        frame = frame.where(concat_ws(":", col("partition").cast("string"), col("offset").cast("string")).isin(keys))
    input_count = frame.count()
    schema, aliases, required = source_schema()
    expected_keys_by_parent = expected_object_keys(source for source, _target in aliases)
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
        source_value = raw_source_value(field)
        parsed_value_missing = nested_payload_column(field).isNull()
        if field in required:
            required_missing = required_missing | source_value.isNull()
        incompatible_type = incompatible_type | (source_value.isNotNull() & parsed_value_missing)
    unknown_condition, _unknown_keys = unknown_field_expressions(expected_keys_by_parent)
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
    schema_valid_count = valid.count()
    existing_target = read_iceberg_target(spark, iceberg_target)
    if existing_target is not None:
        existing = (existing_target
            .select(col("kafka_partition").alias("partition"), col("kafka_offset").alias("offset")).distinct())
        valid = valid.join(existing, ["partition", "offset"], "left_anti")
    eligible_count = valid.count()
    skipped_count = schema_valid_count - eligible_count
    source_ranges = replay_source_ranges(valid) if eligible_count else []
    projected = valid.select(
        *[nested_payload_column(source).alias(target) for source, target in aliases],
        "topic", "partition", "offset", "kafka_timestamp", "raw_payload", "quarantined_at",
    )
    rule_execution = apply_snapshot_rules(projected, RULES)
    target_frame = select_target(rule_execution["frame"])
    stored_count = target_frame.count()
    failed_count = input_count - skipped_count - stored_count
    source_boundary = replay_source_boundary(run_id, source_ranges)
    iceberg_commit = None
    if stored_count:
        target_frame = (
            target_frame
            .withColumn("_asklake_run_id", lit(run_id))
            .withColumn("_asklake_ingested_at", F.current_timestamp())
        )
        iceberg_commit = commit_iceberg_table(
            spark,
            target_frame,
            iceberg_target,
            job_id=os.environ["ASKLAKE_MAINTENANCE_JOB_ID"],
            run_id=run_id,
            partition_columns=iceberg_target.get("partitionColumns") or [],
            schema_fingerprint=os.environ.get("ASKLAKE_MAINTENANCE_SCHEMA_FINGERPRINT", ""),
            rule_fingerprint=RULE_FINGERPRINT,
            source_boundary=source_boundary,
        )
        iceberg_commit.pop("_previousSnapshot", None)
    return {
        "inputCount": input_count,
        "storedCount": stored_count,
        "skippedCount": skipped_count,
        "failedCount": failed_count,
        "outputPath": iceberg_target["tableUri"] if stored_count else None,
        "icebergCommit": iceberg_commit,
        "sourceBoundary": source_boundary,
        "sourceRanges": source_ranges,
        "appliedSchemaPolicy": policy,
        "ruleContractVersion": RULE_CONTRACT_VERSION,
        "ruleFingerprint": RULE_FINGERPRINT,
        "ruleRejectedCount": max(0, failed_count - (input_count - schema_valid_count)),
        "transform": rule_execution["transform"],
        "quality": rule_execution["quality"],
        "policyOverride": "approve_unknown_fields" if approve_unknown_fields else None,
    }


def compact(spark: SparkSession, output_path: str, run_id: str):
    if os.environ.get("ASKLAKE_MAINTENANCE_ICEBERG_TARGET"):
        raise RuntimeError(
            "KAFKA_CONTINUOUS_ICEBERG_COMPACTION_UNAVAILABLE: "
            "legacy Parquet compaction cannot mutate an Iceberg table"
        )
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


def publish_result(result: dict) -> None:
    result_file = os.environ.get("ASKLAKE_MAINTENANCE_RESULT_FILE", "").strip()
    if result_file:
        target = Path(result_file)
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(f"{target.name}.{os.getpid()}.tmp")
        temporary.write_text(f"{json.dumps(result)}\n", encoding="utf-8")
        os.replace(temporary, target)
    print(f"ASKLAKE_CONTINUOUS_MAINTENANCE_RESULT={json.dumps(result)}")


def main():
    kind = os.environ["ASKLAKE_MAINTENANCE_KIND"]
    run_id = os.environ["ASKLAKE_MAINTENANCE_RUN_ID"]
    output_path = os.environ["ASKLAKE_MAINTENANCE_OUTPUT_PATH"]
    iceberg_target = parse_iceberg_target(
        json.loads(os.environ["ASKLAKE_MAINTENANCE_ICEBERG_TARGET"])
    )
    if iceberg_target.get("writeMode") != "append":
        raise ValueError("Continuous maintenance requires an append Iceberg target.")
    spark = make_spark({}, iceberg_target)
    configure_s3a(spark)
    if kind == "inspect_quarantine":
        result = inspect_quarantine(spark, output_path, iceberg_target)
    elif kind == "quarantine_replay":
        result = replay_quarantine(spark, output_path, run_id, iceberg_target)
    elif kind == "compaction":
        result = compact(spark, output_path, run_id)
    else:
        raise ValueError(f"Unsupported maintenance kind: {kind}")
    result.update({"endedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"), "runId": run_id})
    publish_result(result)


if __name__ == "__main__":
    main()
