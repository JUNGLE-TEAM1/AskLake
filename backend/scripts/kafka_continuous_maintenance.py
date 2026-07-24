"""Finite Spark maintenance tasks for Kafka continuous targets."""

import json
import hashlib
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

from pyspark.sql import SparkSession
from pyspark.sql import functions as F
from pyspark.sql.functions import array, array_except, array_union, col, concat, concat_ws, from_json, get_json_object, lit, map_keys, size, split, struct, transform, trim, when
from pyspark.sql.types import BooleanType, DoubleType, LongType, MapType, StringType, StructField, StructType, TimestampType
from pyspark.sql.window import Window

from kafka_schema_paths import build_nested_schema_tree, expected_object_keys, json_path, split_source_path
from object_storage_runtime import configure_spark_hadoop
from snapshot_rule_runtime import apply_snapshot_rules, supports_snapshot_rules
from spark_job_run import (
    commit_iceberg_table,
    current_iceberg_snapshot,
    iceberg_table_exists,
    make_spark,
    parse_iceberg_target,
    quote_spark_identifier,
    rollback_iceberg_commit,
    spark_iceberg_catalog_name,
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
RECORD_PARSING = json.loads(os.environ.get("ASKLAKE_MAINTENANCE_RECORD_PARSING", "{}"))
RECORD_PARSING_ENABLED = RECORD_PARSING.get("enabled") is True


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


def raw_record_tokens(value_column=None):
    source_value = value_column if value_column is not None else col("raw_payload")
    return split(trim(source_value), r"\s+")


def raw_record_columns():
    columns = RECORD_PARSING.get("columns")
    if not isinstance(columns, list):
        return []
    return sorted(
        [column for column in columns if isinstance(column, dict)],
        key=lambda column: int(column.get("position") or 0),
    )


def raw_record_payload(schema, value_column=None):
    tokens = raw_record_tokens(value_column)
    columns_by_name = {
        str(column.get("name") or "").strip(): column
        for column in raw_record_columns()
        if str(column.get("name") or "").strip()
    }

    def field_value(field, parent_path=""):
        source_path = f"{parent_path}.{field.name}" if parent_path else field.name
        if isinstance(field.dataType, StructType):
            return struct(*[
                field_value(child, source_path).alias(child.name)
                for child in field.dataType.fields
            ]).cast(field.dataType)
        column_def = columns_by_name.get(source_path)
        if column_def is None:
            return lit(None).cast(field.dataType)
        return tokens.getItem(int(column_def.get("position") or 0)).cast(field.dataType)

    expected = int(RECORD_PARSING.get("expectedFieldCount") or len(raw_record_columns()))
    parsed = struct(*[
        field_value(field).alias(field.name)
        for field in schema.fields
    ]).cast(schema)
    return when(size(tokens) == lit(expected), parsed).otherwise(lit(None).cast(schema))


def raw_source_value(source_path):
    if RECORD_PARSING_ENABLED:
        column_def = next(
            (
                column for column in raw_record_columns()
                if str(column.get("name") or "").strip() == source_path
            ),
            None,
        )
        if column_def is None:
            return lit(None).cast("string")
        return raw_record_tokens().getItem(int(column_def.get("position") or 0))
    return get_json_object(col("raw_payload"), json_path(source_path))


def unknown_field_expressions(expected_keys_by_parent):
    unknown_condition = lit(False)
    unknown_keys = None
    empty_array = array().cast("array<string>")
    if RECORD_PARSING_ENABLED:
        return unknown_condition, empty_array
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


def compact_kafka_source_ranges(frame) -> list[dict[str, int | str]]:
    rows = (
        frame.select("topic", "partition", "offset")
        .distinct()
        .orderBy("topic", "partition", "offset")
        .collect()
    )
    ranges: list[dict[str, int | str]] = []
    for row in rows:
        topic = str(row["topic"])
        partition = int(row["partition"])
        offset = int(row["offset"])
        previous = ranges[-1] if ranges else None
        if (
            previous is not None
            and previous["topic"] == topic
            and previous["partition"] == partition
            and int(previous["endOffset"]) == offset
        ):
            previous["endOffset"] = offset + 1
            continue
        ranges.append({
            "topic": topic,
            "partition": partition,
            "startOffset": offset,
            "endOffset": offset + 1,
        })
    return ranges


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
    trusted_legacy_run_ids = set(json.loads(
        os.environ.get("ASKLAKE_MAINTENANCE_TRUSTED_LEGACY_REPLAY_RUN_IDS", "[]")
    ))
    for status in root_path.getFileSystem(hadoop).listStatus(root_path):
        child = str(status.getPath())
        child_name = status.getPath().getName()
        if not status.isDirectory() or not child_name.startswith("batch_id=") or not output_committed(spark, child):
            continue
        if child_name.startswith("batch_id=replay_"):
            replay_run_id = child_name.removeprefix("batch_id=replay_")
            output_root = root.rsplit("/_batches", 1)[0]
            replay_manifest = f"{output_root}/_replay-manifests/run_id={replay_run_id}"
            if not output_committed(spark, replay_manifest) and replay_run_id not in trusted_legacy_run_ids:
                continue
        paths.append(child)
    return sorted(paths)


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


def publish_replay_manifest(
    spark: SparkSession,
    replay_manifest_path: str,
    iceberg_target: dict,
    iceberg_commit: dict,
    *,
    run_id: str,
    stored_count: int,
    source_boundary: dict,
    source_ranges: list[dict],
) -> dict:
    previous_snapshot = iceberg_commit.get("_previousSnapshot")
    committed_new_snapshot = str(iceberg_commit.get("operation") or "").strip().lower() != "reuse"
    public_iceberg_commit = {
        key: value
        for key, value in iceberg_commit.items()
        if key != "_previousSnapshot"
    }
    replay_manifest = {
        "publicationId": f"replay:{run_id}",
        "publicationType": "replay",
        "runId": run_id,
        "storedCount": stored_count,
        "dataPath": iceberg_target["tableUri"],
        "icebergCommit": public_iceberg_commit,
        "sourceBoundary": source_boundary,
        "sourceRanges": source_ranges,
    }
    try:
        spark.read.json(
            spark.sparkContext.parallelize([json.dumps(replay_manifest)])
        ).write.mode("errorifexists").json(replay_manifest_path)
        if not output_committed(spark, replay_manifest_path):
            raise RuntimeError(
                f"Replay manifest did not produce a completion marker: {replay_manifest_path}"
            )
    except Exception as error:
        if committed_new_snapshot:
            try:
                rollback_iceberg_commit(spark, iceberg_target, previous_snapshot)
            except Exception as rollback_error:
                raise RuntimeError(
                    f"{error}; replay Iceberg rollback failed: {rollback_error}"
                ) from error
        raise

    iceberg_commit.pop("_previousSnapshot", None)
    return public_iceberg_commit


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
        .withColumn(
            "raw_map",
            (
                lit(None).cast(MapType(StringType(), StringType()))
                if RECORD_PARSING_ENABLED
                else from_json(col("raw_payload"), MapType(StringType(), StringType()))
            ),
        )
        .withColumn(
            "payload",
            (
                raw_record_payload(schema)
                if RECORD_PARSING_ENABLED
                else from_json(col("raw_payload"), schema)
            ),
        ))
    malformed = (
        col("payload").isNull()
        if RECORD_PARSING_ENABLED
        else (col("raw_map").isNull() | col("payload").isNull())
    )
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
    eligible_total = valid.count()
    replay_batch_limit = min(
        max(int(os.environ.get("ASKLAKE_MAINTENANCE_REPLAY_MAX_ROWS", "1000")), 1),
        10_000,
    )
    valid = valid.orderBy("topic", "partition", "offset").limit(replay_batch_limit)
    eligible_count = valid.count()
    deferred_count = max(0, eligible_total - eligible_count)
    skipped_count = schema_valid_count - eligible_total
    source_ranges = replay_source_ranges(valid) if eligible_count else []
    projected = valid.select(
        *[nested_payload_column(source).alias(target) for source, target in aliases],
        "topic", "partition", "offset", "kafka_timestamp", "raw_payload", "quarantined_at",
    )
    rule_execution = apply_snapshot_rules(projected, RULES)
    target_frame = select_target(rule_execution["frame"])
    stored_count = target_frame.count()
    failed_count = input_count - skipped_count - deferred_count - stored_count
    source_boundary = replay_source_boundary(run_id, source_ranges)
    iceberg_commit = None
    replay_manifest_path = f"{output_path.rstrip('/')}/_replay-manifests/run_id={run_id}"
    if stored_count:
        if not source_ranges:
            raise RuntimeError("Iceberg replay commit has no Kafka offset evidence.")
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
        iceberg_commit = publish_replay_manifest(
            spark,
            replay_manifest_path,
            iceberg_target,
            iceberg_commit,
            run_id=run_id,
            stored_count=stored_count,
            source_boundary=source_boundary,
            source_ranges=source_ranges,
        )
    return {
        "inputCount": input_count,
        "storedCount": stored_count,
        "skippedCount": skipped_count,
        "failedCount": failed_count,
        "deferredCount": deferred_count,
        "replayBatchLimit": replay_batch_limit,
        "outputPath": iceberg_target["tableUri"] if stored_count else None,
        "manifestPath": replay_manifest_path if stored_count else None,
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


def environment_flag(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def bounded_environment_int(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.environ.get(name, str(default)))
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if value < minimum or value > maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return value


def sql_string_literal(value: str) -> str:
    return f"'{str(value).replace(chr(39), chr(39) * 2)}'"


def sql_timestamp_literal(value: datetime) -> str:
    normalized = value.astimezone(timezone.utc).replace(tzinfo=None, microsecond=0)
    return f"TIMESTAMP {sql_string_literal(normalized.isoformat(sep=' '))}"


def iceberg_maintenance_config() -> dict:
    return {
        "rewriteDataFiles": environment_flag("ASKLAKE_MAINTENANCE_REWRITE_DATA_FILES", True),
        "targetFileSizeMb": bounded_environment_int("ASKLAKE_MAINTENANCE_TARGET_MB", 256, 128, 512),
        "expireSnapshots": environment_flag("ASKLAKE_MAINTENANCE_EXPIRE_SNAPSHOTS"),
        "snapshotRetentionHours": bounded_environment_int(
            "ASKLAKE_MAINTENANCE_SNAPSHOT_RETENTION_HOURS", 168, 24, 8760
        ),
        "retainLastSnapshots": bounded_environment_int(
            "ASKLAKE_MAINTENANCE_RETAIN_LAST_SNAPSHOTS", 10, 1, 1000
        ),
        "removeOrphanFiles": environment_flag("ASKLAKE_MAINTENANCE_REMOVE_ORPHAN_FILES"),
        "orphanRetentionHours": bounded_environment_int(
            "ASKLAKE_MAINTENANCE_ORPHAN_RETENTION_HOURS", 168, 72, 8760
        ),
    }


def iceberg_maintenance_plan(iceberg_target: dict, config: dict, now: datetime | None = None) -> list[dict]:
    timestamp = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    catalog_name = spark_iceberg_catalog_name()
    catalog = quote_spark_identifier(catalog_name)
    table_name = f"{catalog_name}.{iceberg_target['namespace']}.{iceberg_target['table']}"
    table_argument = sql_string_literal(table_name)
    plan = []
    if config.get("rewriteDataFiles"):
        target_bytes = int(config["targetFileSizeMb"]) * 1024 * 1024
        plan.append({
            "operation": "rewrite_data_files",
            "sql": (
                f"CALL {catalog}.system.rewrite_data_files("
                f"table => {table_argument}, "
                f"options => map('target-file-size-bytes', '{target_bytes}'))"
            ),
        })
    if config.get("expireSnapshots"):
        cutoff = timestamp - timedelta(hours=int(config["snapshotRetentionHours"]))
        plan.append({
            "operation": "expire_snapshots",
            "sql": (
                f"CALL {catalog}.system.expire_snapshots("
                f"table => {table_argument}, older_than => {sql_timestamp_literal(cutoff)}, "
                f"retain_last => {int(config['retainLastSnapshots'])})"
            ),
        })
    if config.get("removeOrphanFiles"):
        cutoff = timestamp - timedelta(hours=int(config["orphanRetentionHours"]))
        plan.append({
            "operation": "remove_orphan_files",
            "sql": (
                f"CALL {catalog}.system.remove_orphan_files("
                f"table => {table_argument}, older_than => {sql_timestamp_literal(cutoff)})"
            ),
        })
    if not plan:
        raise ValueError("At least one Iceberg maintenance operation must be enabled.")
    return plan


def json_safe(value):
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z") if value.tzinfo else value.isoformat()
    if isinstance(value, dict):
        return {str(key): json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(item) for item in value]
    return str(value)


def iceberg_table_stats(spark: SparkSession, iceberg_target: dict) -> dict[str, int]:
    table_identifier = spark_iceberg_table_identifier(iceberg_target)
    file_row = spark.sql(
        "SELECT COUNT(*) AS file_count, "
        "COALESCE(SUM(file_size_in_bytes), 0) AS total_bytes "
        f"FROM {table_identifier}.files"
    ).first()
    snapshot_row = spark.sql(
        f"SELECT COUNT(*) AS snapshot_count FROM {table_identifier}.snapshots"
    ).first()
    return {
        "files": int(file_row["file_count"] or 0),
        "bytes": int(file_row["total_bytes"] or 0),
        "snapshots": int(snapshot_row["snapshot_count"] or 0),
    }


def maintain_iceberg(spark: SparkSession, iceberg_target: dict, config: dict) -> dict:
    if not iceberg_table_exists(spark, iceberg_target):
        raise RuntimeError("ICEBERG_MAINTENANCE_TABLE_NOT_FOUND")
    before_snapshot = current_iceberg_snapshot(spark, iceberg_target)
    before_stats = iceberg_table_stats(spark, iceberg_target)
    operations = []
    for step in iceberg_maintenance_plan(iceberg_target, config):
        rows = spark.sql(step["sql"]).collect()
        operations.append({
            "operation": step["operation"],
            "result": [json_safe(row.asDict(recursive=True)) for row in rows],
        })
    after_snapshot = current_iceberg_snapshot(spark, iceberg_target)
    after_stats = iceberg_table_stats(spark, iceberg_target)
    return {
        "tableUri": iceberg_target["tableUri"],
        "snapshotIdBefore": before_snapshot["snapshotId"],
        "snapshotIdAfter": after_snapshot["snapshotId"],
        "inputFiles": before_stats["files"],
        "outputFiles": after_stats["files"],
        "inputBytes": before_stats["bytes"],
        "outputBytes": after_stats["bytes"],
        "snapshotCountBefore": before_stats["snapshots"],
        "snapshotCountAfter": after_stats["snapshots"],
        "operations": operations,
        **config,
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
        result = maintain_iceberg(spark, iceberg_target, {
            **iceberg_maintenance_config(),
            "rewriteDataFiles": True,
            "expireSnapshots": False,
            "removeOrphanFiles": False,
        })
    elif kind == "iceberg_maintenance":
        result = maintain_iceberg(spark, iceberg_target, iceberg_maintenance_config())
    else:
        raise ValueError(f"Unsupported maintenance kind: {kind}")
    result.update({"endedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"), "runId": run_id})
    publish_result(result)


if __name__ == "__main__":
    main()
