"""Spark micro-batch adapter for versioned AskLake Continuous SQL plans.

The module deliberately keeps planner decisions out of the Spark driver. It
only verifies the signed-by-hash plan, fixes a batch-local static snapshot set,
registers bounded temp views, and executes the precompiled Spark SQL.
"""

from __future__ import annotations

import hashlib
import json
import os
from typing import Any


PLAN_VERSION = "continuous-sql-v1"
INTERNAL_RUN_PARTITION_COLUMN = "_asklake_run_id"
RUNTIME_METADATA_COLUMNS = [
    "kafka_timestamp",
    "kafka_partition",
    "kafka_offset",
    "ingested_at",
]

_STATIC_FRAME_CACHE: dict[tuple[str, str, str], Any] = {}
_STATIC_FRAME_KEY_BY_DATASET: dict[str, tuple[str, str, str]] = {}
_VERIFIED_STATIC_KEYS: set[tuple[str, str, str, tuple[str, ...]]] = set()


def load_continuous_sql_plan() -> dict[str, Any]:
    try:
        value = json.loads(os.environ.get("ASKLAKE_CONTINUOUS_SQL_PLAN", "{}"))
    except json.JSONDecodeError as exc:
        raise RuntimeError("CONTINUOUS_SQL_PLAN_INVALID_JSON") from exc
    if not isinstance(value, dict):
        raise RuntimeError("CONTINUOUS_SQL_PLAN_INVALID")
    if not value:
        return {}
    validate_runtime_plan(value)
    return value


def report_metadata(plan: dict[str, Any]) -> dict[str, Any]:
    return {
        "continuousSqlPlanHash": plan.get("planHash") if plan else None,
        "continuousSqlRunGeneration": plan.get("runGeneration") if plan else None,
        "continuousSqlFencingTokenHash": fencing_token_hash(plan) if plan else None,
    }


def contract_metadata(plan: dict[str, Any]) -> dict[str, Any]:
    return {
        "continuousSqlPlanHash": plan.get("planHash") if plan else None,
        "continuousSqlStaticBindingPolicy": plan.get("staticBindingPolicy") if plan else None,
    }


def publication_metadata(
    plan: dict[str, Any],
    static_snapshots: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "staticSnapshots": static_snapshots,
        **report_metadata(plan),
    }


def batch_context_metadata(
    source_boundary: dict[str, Any],
    static_snapshots: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "source_boundary": source_boundary,
        "static_snapshots": static_snapshots,
        "run_id": str(source_boundary["runId"]),
    }


def prepare_batch_identity(
    spark: Any,
    plan: dict[str, Any],
    output_path: str,
    batch_id: int,
    source_ranges: list[dict[str, Any]],
    checkpoint_path: str,
    config: Any,
    job_id: str,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    static_snapshots = prepare_batch_static_bindings(spark, plan, output_path, batch_id) if plan else []
    identity = {
        "batchId": int(batch_id),
        "checkpointPath": checkpoint_path.rstrip("/"),
        "consumerGroupId": str(config.consumer_group_id),
        "jobId": job_id,
        "kind": "kafka_continuous_batch",
        "sourceRanges": source_ranges,
        "topic": str(config.topic),
    }
    if plan:
        identity.update({
            "fencingTokenHash": fencing_token_hash(plan),
            "kind": "continuous_sql_batch",
            "planHash": str(plan["planHash"]),
            "runGeneration": int(plan["runGeneration"]),
            "staticSnapshots": static_snapshots,
        })
    boundary_id = canonical_hash(identity)
    run_id = (
        f"continuous-sql:{job_id}:generation:{int(plan['runGeneration'])}:batch:{batch_id}:{boundary_id[:16]}"
        if plan else f"continuous:{job_id}:batch:{batch_id}:{boundary_id[:16]}"
    )
    return static_snapshots, {**identity, "boundaryId": boundary_id, "runId": run_id}


def enforce_output_cardinality(
    plan: dict[str, Any],
    input_count: int,
    output_count: int,
) -> None:
    if not plan:
        return
    multiplier = max(1, int(plan.get("maxOutputRowsPerInput") or 10))
    if output_count > input_count * multiplier:
        raise RuntimeError(
            "CONTINUOUS_SQL_CARDINALITY_LIMIT_EXCEEDED:"
            f"input={input_count},output={output_count},limit={multiplier}x"
        )


def validated_output_count(frame: Any, plan: dict[str, Any], input_count: int) -> int:
    output_count = int(frame.count())
    enforce_output_cardinality(plan, input_count, output_count)
    return output_count


def validate_runtime_plan(plan: dict[str, Any]) -> None:
    if str(plan.get("planVersion") or "") != PLAN_VERSION:
        raise RuntimeError("CONTINUOUS_SQL_PLAN_VERSION_UNSUPPORTED")
    plan_hash = str(plan.get("planHash") or "")
    base_plan = {
        key: value
        for key, value in plan.items()
        if key not in {"planHash", "runGeneration", "fencingToken", "staticBindings"}
    }
    if not plan_hash or canonical_hash(base_plan) != plan_hash:
        raise RuntimeError("CONTINUOUS_SQL_PLAN_HASH_MISMATCH")
    relations = plan.get("relations")
    if not isinstance(relations, list):
        raise RuntimeError("CONTINUOUS_SQL_RELATIONS_INVALID")
    modes = [str(item.get("mode") or "") for item in relations if isinstance(item, dict)]
    if modes.count("streaming") != 1 or modes.count("static") < 1:
        raise RuntimeError("CONTINUOUS_SQL_RELATION_CARDINALITY_INVALID")
    if str(plan.get("staticBindingPolicy") or "") not in {"PINNED_AT_START", "LATEST_PER_BATCH"}:
        raise RuntimeError("CONTINUOUS_SQL_STATIC_BINDING_POLICY_INVALID")
    runtime_sql = str(plan.get("runtimeSql") or "").strip()
    if not runtime_sql or ";" in runtime_sql.rstrip(";"):
        raise RuntimeError("CONTINUOUS_SQL_RUNTIME_SQL_INVALID")
    if not isinstance(plan.get("outputSchema"), list) or not plan.get("outputSchema"):
        raise RuntimeError("CONTINUOUS_SQL_OUTPUT_SCHEMA_INVALID")
    try:
        generation = int(plan.get("runGeneration"))
    except (TypeError, ValueError) as exc:
        raise RuntimeError("CONTINUOUS_SQL_RUN_GENERATION_INVALID") from exc
    if generation < 1 or not str(plan.get("fencingToken") or "").strip():
        raise RuntimeError("CONTINUOUS_SQL_FENCING_TOKEN_INVALID")


def prepare_batch_static_bindings(
    spark: Any,
    plan: dict[str, Any],
    output_path: str,
    batch_id: int,
) -> list[dict[str, Any]]:
    if not plan:
        return []
    path = binding_manifest_path(output_path, int(plan["runGeneration"]), batch_id)
    existing = read_binding_manifest(spark, path)
    if existing is not None:
        validate_binding_manifest(existing, plan, batch_id)
        return list(existing.get("staticSnapshots") or [])

    policy = str(plan["staticBindingPolicy"])
    pinned = {
        str(item.get("datasetId") or ""): str(item.get("snapshotId") or "")
        for item in plan.get("staticBindings") or []
        if isinstance(item, dict)
    }
    bindings: list[dict[str, Any]] = []
    for relation in plan["relations"]:
        if not isinstance(relation, dict) or relation.get("mode") != "static":
            continue
        dataset_id = str(relation.get("datasetId") or "")
        mapping = relation.get("queryEngineTable")
        if not dataset_id or not isinstance(mapping, dict):
            raise RuntimeError("CONTINUOUS_SQL_STATIC_RELATION_INVALID")
        snapshot_id = (
            pinned.get(dataset_id)
            if policy == "PINNED_AT_START"
            else current_static_snapshot_id(spark, mapping)
        )
        if not snapshot_id:
            raise RuntimeError(f"CONTINUOUS_SQL_STATIC_SNAPSHOT_MISSING:{dataset_id}")
        verify_static_snapshot(spark, mapping, snapshot_id)
        bindings.append({
            "datasetId": dataset_id,
            "runtimeView": str(relation.get("runtimeView") or ""),
            "schemaFingerprint": str(relation.get("schemaFingerprint") or ""),
            "snapshotId": str(snapshot_id),
        })
    manifest = {
        "batchId": int(batch_id),
        "fencingTokenHash": fencing_token_hash(plan),
        "planHash": str(plan["planHash"]),
        "runGeneration": int(plan["runGeneration"]),
        "staticBindingPolicy": policy,
        "staticSnapshots": bindings,
    }
    write_binding_manifest(spark, path, manifest)
    persisted = read_binding_manifest(spark, path)
    if persisted is None:
        raise RuntimeError("CONTINUOUS_SQL_STATIC_BINDING_NOT_DURABLE")
    validate_binding_manifest(persisted, plan, batch_id)
    return list(persisted.get("staticSnapshots") or [])


def execute_continuous_sql_batch(
    spark: Any,
    stream_frame: Any,
    plan: dict[str, Any],
    static_bindings: list[dict[str, Any]],
) -> Any:
    if not plan:
        return stream_frame
    batch_spark = getattr(stream_frame, "sparkSession", None) or spark
    bindings_by_dataset = {
        str(item.get("datasetId") or ""): item
        for item in static_bindings
        if isinstance(item, dict)
    }
    for relation in plan["relations"]:
        runtime_view = str(relation.get("runtimeView") or "")
        if not runtime_view:
            raise RuntimeError("CONTINUOUS_SQL_RUNTIME_VIEW_INVALID")
        if relation.get("mode") == "streaming":
            validate_frame_schema(stream_frame, relation)
            stream_frame.createOrReplaceTempView(runtime_view)
            continue
        binding = bindings_by_dataset.get(str(relation.get("datasetId") or ""))
        if binding is None:
            raise RuntimeError("CONTINUOUS_SQL_STATIC_BINDING_MISSING")
        static_frame = reusable_static_snapshot(
            batch_spark,
            relation,
            binding,
        )
        validate_frame_schema(static_frame, relation)
        verify_static_key_uniqueness(static_frame, relation, plan, binding)
        if relation.get("broadcastHint") is True:
            from pyspark.sql.functions import broadcast

            static_frame = broadcast(static_frame)
        static_frame.createOrReplaceTempView(runtime_view)
    result = batch_spark.sql(str(plan["runtimeSql"]))
    expected_columns = [str(item[0]) for item in plan["outputSchema"]] + RUNTIME_METADATA_COLUMNS
    actual_columns = list(result.columns)
    if actual_columns != expected_columns:
        raise RuntimeError(
            "CONTINUOUS_SQL_OUTPUT_SCHEMA_MISMATCH:"
            f"expected={expected_columns},actual={actual_columns}"
        )
    return result


def validate_frame_schema(frame: Any, relation: dict[str, Any]) -> None:
    actual = {
        normalize_identifier(field.name): normalize_type(field.dataType.simpleString())
        for field in frame.schema.fields
    }
    expected = {
        normalize_identifier(item[0]): normalize_type(item[1])
        for item in relation.get("schema") or []
        if isinstance(item, (list, tuple)) and len(item) >= 2
    }
    for column in relation.get("referencedColumns") or []:
        normalized = normalize_identifier(column)
        if normalized not in actual or normalized not in expected:
            raise RuntimeError(f"CONTINUOUS_SQL_SCHEMA_COLUMN_MISSING:{column}")
        if not compatible_types(actual[normalized], expected[normalized]):
            raise RuntimeError(f"CONTINUOUS_SQL_SCHEMA_TYPE_INCOMPATIBLE:{column}")


def verify_static_key_uniqueness(
    frame: Any,
    relation: dict[str, Any],
    plan: dict[str, Any],
    binding: dict[str, Any],
) -> None:
    aliases = {
        normalize_identifier(str(relation.get("alias") or "")),
    }
    join_keys = []
    for join in plan.get("joins") or []:
        if normalize_identifier(str(join.get("rightAlias") or "")) not in aliases:
            continue
        join_keys.extend(
            str(key.get("rightColumn") or "")
            for key in join.get("keys") or []
            if isinstance(key, dict)
        )
    unique_keys = list(dict.fromkeys(key for key in join_keys if key))
    if not unique_keys:
        raise RuntimeError("CONTINUOUS_SQL_STATIC_KEY_MISSING")
    frame_key = static_snapshot_cache_key(relation, binding)
    evict_stale_static_verifications(frame_key)
    verification_key = (*frame_key, tuple(normalize_identifier(key) for key in unique_keys))
    if verification_key in _VERIFIED_STATIC_KEYS:
        return
    duplicates = frame.groupBy(*unique_keys).count().where("count > 1").limit(1).count()
    if duplicates:
        raise RuntimeError("CONTINUOUS_SQL_STATIC_KEY_DUPLICATE")
    _VERIFIED_STATIC_KEYS.add(verification_key)


def evict_stale_static_verifications(current_key: tuple[str, str, str]) -> None:
    stale_verifications = {
        verification
        for verification in _VERIFIED_STATIC_KEYS
        if verification[0] == current_key[0] and verification[:3] != current_key
    }
    _VERIFIED_STATIC_KEYS.difference_update(stale_verifications)


def reusable_static_snapshot(
    spark: Any,
    relation: dict[str, Any],
    binding: dict[str, Any],
) -> Any:
    mapping = relation.get("queryEngineTable") or {}
    snapshot_id = str(binding.get("snapshotId") or "")
    if relation.get("cacheHint") is not True:
        return read_static_snapshot(spark, mapping, snapshot_id)

    key = static_snapshot_cache_key(relation, binding)
    cached = _STATIC_FRAME_CACHE.get(key)
    if cached is not None:
        return cached

    dataset_id = key[0]
    previous_key = _STATIC_FRAME_KEY_BY_DATASET.get(dataset_id)
    if previous_key is not None and previous_key != key:
        evict_static_snapshot(previous_key)

    frame = read_static_snapshot(spark, mapping, snapshot_id)
    cache = getattr(frame, "cache", None)
    if callable(cache):
        cached_frame = cache()
        if cached_frame is not None:
            frame = cached_frame
    _STATIC_FRAME_CACHE[key] = frame
    _STATIC_FRAME_KEY_BY_DATASET[dataset_id] = key
    return frame


def static_snapshot_cache_key(
    relation: dict[str, Any],
    binding: dict[str, Any],
) -> tuple[str, str, str]:
    dataset_id = str(relation.get("datasetId") or binding.get("datasetId") or "").strip()
    snapshot_id = str(binding.get("snapshotId") or "").strip()
    schema_fingerprint = str(
        binding.get("schemaFingerprint") or relation.get("schemaFingerprint") or ""
    ).strip()
    if not dataset_id or not snapshot_id or not schema_fingerprint:
        raise RuntimeError("CONTINUOUS_SQL_STATIC_CACHE_IDENTITY_INVALID")
    return dataset_id, snapshot_id, schema_fingerprint


def evict_static_snapshot(key: tuple[str, str, str]) -> None:
    frame = _STATIC_FRAME_CACHE.pop(key, None)
    if frame is not None:
        unpersist = getattr(frame, "unpersist", None)
        if callable(unpersist):
            try:
                unpersist(blocking=False)
            except TypeError:
                unpersist()
    if _STATIC_FRAME_KEY_BY_DATASET.get(key[0]) == key:
        _STATIC_FRAME_KEY_BY_DATASET.pop(key[0], None)
    stale_verifications = {
        verification for verification in _VERIFIED_STATIC_KEYS if verification[:3] == key
    }
    _VERIFIED_STATIC_KEYS.difference_update(stale_verifications)


def reset_static_snapshot_cache() -> None:
    for key in list(_STATIC_FRAME_CACHE):
        evict_static_snapshot(key)
    _VERIFIED_STATIC_KEYS.clear()


def continuous_output_partition_columns(
    configured_columns: list[str] | tuple[str, ...] | None,
    plan: dict[str, Any],
) -> list[str]:
    columns: list[str] = []
    for value in configured_columns or []:
        column = str(value or "").strip()
        if column and normalize_identifier(column) not in {
            normalize_identifier(existing) for existing in columns
        }:
            columns.append(column)
    if plan and normalize_identifier(INTERNAL_RUN_PARTITION_COLUMN) not in {
        normalize_identifier(existing) for existing in columns
    }:
        columns.append(INTERNAL_RUN_PARTITION_COLUMN)
    return columns


def read_static_snapshot(spark: Any, mapping: dict[str, Any], snapshot_id: str) -> Any:
    return (
        spark.read.format("iceberg")
        .option("snapshot-id", str(snapshot_id))
        .load(spark_table_identifier(mapping))
    )


def current_static_snapshot_id(spark: Any, mapping: dict[str, Any]) -> str:
    rows = spark.sql(
        "SELECT CAST(snapshot_id AS STRING) AS snapshot_id "
        f"FROM {spark_table_identifier(mapping)}.refs WHERE name = 'main' LIMIT 1"
    ).collect()
    if not rows or not str(rows[0]["snapshot_id"] or "").strip():
        raise RuntimeError("CONTINUOUS_SQL_STATIC_SNAPSHOT_MISSING")
    return str(rows[0]["snapshot_id"]).strip()


def verify_static_snapshot(spark: Any, mapping: dict[str, Any], snapshot_id: str) -> None:
    escaped = str(snapshot_id).replace("'", "''")
    rows = spark.sql(
        "SELECT CAST(snapshot_id AS STRING) AS snapshot_id "
        f"FROM {spark_table_identifier(mapping)}.snapshots "
        f"WHERE CAST(snapshot_id AS STRING) = '{escaped}' LIMIT 1"
    ).collect()
    if not rows:
        raise RuntimeError("CONTINUOUS_SQL_STATIC_SNAPSHOT_EXPIRED")


def spark_table_identifier(mapping: dict[str, Any]) -> str:
    from spark_job_run import quote_spark_identifier, spark_iceberg_catalog_name

    namespace = str(mapping.get("schema") or mapping.get("namespace") or "").strip()
    table = str(mapping.get("table") or "").strip()
    if not namespace or not table:
        raise RuntimeError("CONTINUOUS_SQL_STATIC_TABLE_INVALID")
    return ".".join(
        quote_spark_identifier(item)
        for item in (spark_iceberg_catalog_name(), namespace, table)
    )


def binding_manifest_path(output_path: str, generation: int, batch_id: int) -> str:
    return (
        f"{str(output_path).rstrip('/')}/_continuous-sql-bindings/"
        f"generation={int(generation)}/batch_id={int(batch_id)}"
    )


def read_binding_manifest(spark: Any, path: str) -> dict[str, Any] | None:
    if not path_exists(spark, f"{path.rstrip('/')}/_SUCCESS"):
        return None
    row = spark.read.json(path).first()
    return row.asDict(recursive=True) if row is not None else None


def write_binding_manifest(spark: Any, path: str, manifest: dict[str, Any]) -> None:
    frame = spark.read.json(spark.sparkContext.parallelize([json.dumps(manifest)]))
    try:
        frame.write.mode("errorifexists").json(path)
    except Exception:
        if read_binding_manifest(spark, path) is None:
            raise


def validate_binding_manifest(
    manifest: dict[str, Any],
    plan: dict[str, Any],
    batch_id: int,
) -> None:
    if any((
        int(manifest.get("batchId", -1)) != int(batch_id),
        int(manifest.get("runGeneration", -1)) != int(plan["runGeneration"]),
        str(manifest.get("planHash") or "") != str(plan["planHash"]),
        str(manifest.get("fencingTokenHash") or "") != fencing_token_hash(plan),
        str(manifest.get("staticBindingPolicy") or "") != str(plan["staticBindingPolicy"]),
    )):
        raise RuntimeError("CONTINUOUS_SQL_STATIC_BINDING_IDENTITY_MISMATCH")


def path_exists(spark: Any, path: str) -> bool:
    jvm = spark.sparkContext._jvm
    hadoop = spark.sparkContext._jsc.hadoopConfiguration()
    target = jvm.org.apache.hadoop.fs.Path(path)
    return bool(target.getFileSystem(hadoop).exists(target))


def fencing_token_hash(plan: dict[str, Any]) -> str:
    return hashlib.sha256(str(plan.get("fencingToken") or "").encode("utf-8")).hexdigest()


def canonical_hash(value: Any) -> str:
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def normalize_identifier(value: Any) -> str:
    return str(value or "").strip().strip("`\"").casefold()


def normalize_type(value: Any) -> str:
    normalized = str(value or "string").replace(" ", "").casefold()
    aliases = {
        "int": "integer",
        "long": "bigint",
        "float": "double",
        "varchar": "string",
        "text": "string",
        "bool": "boolean",
        "datetime": "timestamp",
    }
    if normalized.startswith("decimal("):
        return "decimal"
    return aliases.get(normalized, normalized)


def compatible_types(left: str, right: str) -> bool:
    if left == right:
        return True
    integral = {"tinyint", "smallint", "integer", "bigint"}
    numeric = integral | {"float", "double", "decimal", "numeric"}
    return left in numeric and right in numeric
