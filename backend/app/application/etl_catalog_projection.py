"""Materialization, Catalog, lineage, and DAG projections."""

from pathlib import Path
import re
from typing import Any, Callable
from app.application.etl_job_projection import (
    apply_job_command,
    continuous_config_from_request,
    continuous_runtime_from_job,
    dag_steps_from_command,
    dataset_sample_rows_from_request,
    dataset_schema_from_request,
    dataset_storage_key,
    fallback_lineage_graph,
    field_value,
    format_bytes,
    format_duration_ms,
    format_iso_duration,
    format_rows,
    initial_dag_steps,
    initial_job_stats,
    iso_now,
    kafka_field_value,
    lineage_node,
    make_dataset_id,
    make_job_id,
    normalize_column_name,
    normalize_lineage_id,
    normalize_optional_text,
    normalize_string_list,
    normalize_target_tags,
    parse_positive_integer,
    quality_status_label,
    quality_summary_from_request,
    run_from_command,
    source_metrics_from_request,
    source_unit_label,
    stable_id,
    stats_from_runs,
    target_dataset_description,
    target_dataset_tags,
    tuple_rows_to_lists,
)
from app.core.errors import ApiError
from app.core.materialization import (
    SOURCE_WINDOW_CONTRACT_VERSION,
    SUPPORTED_SOURCE_WINDOW_CONTRACT_VERSIONS,
    active_materialization_runs,
    has_bounded_source_window,
    materialization_source_window,
)
from app.core.permission_metadata import normalize_actions, permission_grants_from_roles, resource_permissions
from app.domain.dataset_identity import catalog_relation_metadata
from app.models import (
    CatalogDatasetModel,
    ETLJobModel,
    ETLRunModel,
    KafkaContinuousBatchModel,
    KafkaContinuousMaintenanceRunModel,
    KafkaContinuousRuntimeModel,
    KafkaContinuousSessionModel,
    KafkaSnapshotModel,
    PermissionGrantModel,
    ResourceLockModel,
)
from app.services.materialization_projection import (
    aggregate_materialization_runs,
    upsert_materialization_run,
)

from app.application.etl_runtime_support import dag_step, is_kafka_job
from app.application.etl_source_window import (
    normalize_s3_etag,
    normalize_s3_version_id,
    object_last_modified_iso,
    s3_object_size,
)

SPARK_OUTPUT_FORMAT = "parquet"

def spark_output_sample_rows(result: dict[str, Any], schema_json: list[list[str]]) -> list[list[str]]:
    rows = result.get("sampleRows")
    if not isinstance(rows, list):
        return []
    columns = [str(column[0]) for column in schema_json if column]
    normalized_rows: list[list[str]] = []
    for row in rows[:20]:
        if isinstance(row, dict):
            normalized_rows.append([str(row.get(column) if row.get(column) is not None else "") for column in columns])
        elif isinstance(row, (list, tuple)):
            normalized_rows.append([str(value if value is not None else "") for value in row])
    return normalized_rows

def dataset_from_spark_result(job: ETLJobModel, result: dict[str, Any], existing_dataset: CatalogDatasetModel | None = None) -> CatalogDatasetModel:
    now = str(result.get("endedAt") or iso_now())
    schema_json = spark_result_schema(result.get("schema")) or schema_from_job(job)
    dataset_id = str(job.dataset_id or make_dataset_id(job.target))
    previous_payload = existing_dataset.payload if existing_dataset and existing_dataset.payload else None
    dataset_payload = dataset_payload_from_spark_result(job, result, dataset_id, schema_json, now, previous_payload)
    storage_size_bytes = int(dataset_payload.get("storageSizeBytes") or 0)
    display_size = format_storage_size(storage_size_bytes) if storage_size_bytes > 0 else "Pending"
    target_description = target_dataset_description(job)
    target_tags = target_dataset_tags(job)
    sample_rows = spark_output_sample_rows(result, schema_json)
    return CatalogDatasetModel(
        id=dataset_id,
        payload=dataset_payload,
        name=job.target,
        description=target_description,
        owner=job.owner,
        layer=job.target_layer,
        status="available",
        freshness="latest",
        source=job.name,
        rows=format_rows(result.get("outputRows")),
        size=display_size,
        quality=quality_summary_from_spark_result(job, result),
        last_updated=now,
        next_refresh=job.schedule,
        rag=job.rag,
        tags=target_tags,
        schema_json=schema_json,
        sample_rows=sample_rows,
        upstream=[job.source_label, job.name],
        downstream=dataset_payload["downstream"],
    )

def spark_result_schema(value: Any) -> list[list[str]]:
    if not isinstance(value, list):
        return []
    normalized: list[list[str]] = []
    for field in value:
        if isinstance(field, dict):
            name = str(field.get("name") or "").strip()
            type_value = str(field.get("type") or "string").strip() or "string"
        elif isinstance(field, (list, tuple)) and field:
            name = str(field[0] or "").strip()
            type_value = str(field[1] if len(field) > 1 else "string").strip() or "string"
        else:
            continue
        if name and not name.startswith("_asklake_"):
            normalized.append([name, type_value])
    return normalized


def _spark_materialization_run(
    job: ETLJobModel,
    result: dict[str, Any],
    last_updated: str,
    output_path: str,
    storage_size_bytes: int,
    run_storage_format: str,
    iceberg_commit: dict[str, Any],
) -> dict[str, Any]:
    return {
        "createdAt": last_updated,
        **({"icebergCommittedAt": str(iceberg_commit.get("committedAt") or "")} if iceberg_commit.get("committedAt") else {}),
        "jobId": job.id,
        "materializationMode": spark_materialization_mode(job, result),
        "rowCount": parse_count_value(result.get("materializationRows", result.get("outputRows"))),
        "runId": str(result.get("runId") or ""),
        "sourceKind": result.get("sourceKind") or ("sql" if job.source_type == "SQL Result" else "etl"),
        "sourceLabel": job.name or job.source or job.source_label or job.id,
        "status": "success" if result.get("status") == "success" else "failed",
        "storageFormat": run_storage_format,
        "storageLocation": str(result.get("materializationOutputPath") or output_path),
        "storageSizeBytes": storage_size_bytes,
        **spark_source_window_metadata(result),
        **({"sourceBoundary": result["sourceBoundary"]} if isinstance(result.get("sourceBoundary"), dict) and result["sourceBoundary"] else {}),
        **({"sourceRanges": result["sourceRanges"]} if isinstance(result.get("sourceRanges"), list) and result["sourceRanges"] else {}),
        **({"kafkaSnapshot": result["kafkaSnapshot"]} if isinstance(result.get("kafkaSnapshot"), dict) else {}),
        **({"publicationManifest": str(result["publicationManifest"])} if result.get("publicationManifest") else {}),
        **({"ruleContractVersion": str(result["ruleContractVersion"])} if result.get("ruleContractVersion") else {}),
        **({"ruleFingerprint": str(result["ruleFingerprint"])} if result.get("ruleFingerprint") else {}),
        **({"runtimeFingerprint": str(result["runtimeFingerprint"])} if result.get("runtimeFingerprint") else {}),
        **({"schemaFingerprint": str(result["schemaFingerprint"])} if result.get("schemaFingerprint") else {}),
        **({"icebergSnapshotId": str(iceberg_commit.get("snapshotId") or "")} if isinstance(result.get("icebergCommit"), dict) else {}),
        **({"queryEngineTable": result["queryEngineTable"]} if isinstance(result.get("queryEngineTable"), dict) else {}),
        **({"transform": result["transform"]} if isinstance(result.get("transform"), dict) else {}),
        **({"quality": result["quality"]} if isinstance(result.get("quality"), dict) else {}),
    }


def dataset_payload_from_spark_result(
    job: ETLJobModel,
    result: dict[str, Any],
    dataset_id: str,
    schema_json: list[list[str]],
    last_updated: str,
    previous_payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    output_path = str(result.get("outputPath") or "-")
    storage_size_bytes = parse_count_value(result.get("storageSizeBytes")) or dataset_storage_size_bytes(output_path)
    display_size = format_storage_size(storage_size_bytes) if storage_size_bytes > 0 else "Pending"
    lineage_graph = etl_dataset_lineage_graph(job, dataset_id, schema_json)
    sample_rows = spark_output_sample_rows(result, schema_json)
    partition_columns = normalize_string_list(job.partition_columns)
    index_columns = normalize_string_list(job.index_columns)
    partition = "/".join(partition_columns) if partition_columns else normalize_optional_text(job.partition)
    iceberg_commit = result.get("icebergCommit") if isinstance(result.get("icebergCommit"), dict) else {}
    query_engine_table = result.get("queryEngineTable")
    query_engine_available = (
        result.get("queryEngineVerified") is True
        and isinstance(query_engine_table, dict)
        and all(str(query_engine_table.get(key) or "").strip() for key in ("catalog", "schema", "table", "format"))
    )
    run_storage_format = "iceberg" if query_engine_available else SPARK_OUTPUT_FORMAT
    materialization_runs = append_materialization_run(
        previous_payload.get("materializationRuns") if previous_payload else [],
        _spark_materialization_run(
            job,
            result,
            last_updated,
            output_path,
            storage_size_bytes,
            run_storage_format,
            iceberg_commit,
        ),
    )
    aggregate = aggregate_materialization_runs(materialization_runs)
    storage_format = "iceberg" if query_engine_available else SPARK_OUTPUT_FORMAT
    storage_location = str(result.get("warehouseLocation") or output_path)
    current_storage_size_bytes = storage_size_bytes if query_engine_available else aggregate["storageSizeBytes"]
    downstream = (["SQL 분석"] if query_engine_available else []) + (["RAG 인덱싱"] if job.rag else [])
    result_run_id = str(result.get("runId") or "")
    if previous_payload and aggregate["latestRunId"] != result_run_id:
        return {
            **previous_payload,
            "lastUpdated": aggregate["lastUpdated"] or previous_payload.get("lastUpdated") or last_updated,
            "materializationRuns": materialization_runs,
            "rows": format_rows(aggregate["rowCount"]),
            "size": previous_payload.get("size", display_size),
            "sourceRunId": aggregate["latestRunId"],
            "storageSizeBytes": previous_payload.get("storageSizeBytes", current_storage_size_bytes),
        }
    return {
        "description": target_dataset_description(job),
        "downstream": downstream,
        "freshness": "latest",
        "id": dataset_id,
        "layer": job.target_layer,
        "lastUpdated": aggregate["lastUpdated"] or last_updated,
        "lineageGraph": lineage_graph,
        "materializationRuns": materialization_runs,
        "name": job.target,
        "nextRefresh": job.schedule,
        "owner": job.owner,
        "createdBy": job.created_by or job.owner,
        "createdByProfile": job.created_by_profile or identity_profile(job.created_by or job.owner),
        "permissionGrants": permission_grants_from_roles(job.owner, job.permission_roles, default_actions=["view", "query"]),
        "permissions": resource_permissions(can_query=True),
        "quality": quality_summary_from_spark_result(job, result),
        "rag": job.rag,
        **catalog_relation_metadata(aggregate["rowCount"], format_rows(aggregate["rowCount"]), job.execution_mode == "continuous" and is_kafka_job(job), job.schema_fingerprint),
        "sampleRows": sample_rows,
        "schema": schema_json,
        "size": format_storage_size(current_storage_size_bytes) if current_storage_size_bytes > 0 else display_size,
        "source": job.name,
        "sourceRunId": aggregate["latestRunId"] or result.get("runId"),
        "status": "available",
        "storageFormat": storage_format,
        "storageLocation": storage_location,
        "storageSizeBytes": current_storage_size_bytes,
        "queryEngineStatus": "available" if query_engine_available else "unavailable",
        "partition": partition,
        "partitionColumns": partition_columns,
        "indexColumns": index_columns,
        "tags": target_dataset_tags(job),
        "upstream": [job.source_label, job.name],
        **(
            {"icebergSnapshotId": str(iceberg_commit.get("snapshotId") or "")}
            if query_engine_available
            else {}
        ),
        **({"queryEngineTable": query_engine_table} if query_engine_available else {}),
    }

def append_materialization_run(previous_runs: Any, next_run: dict[str, Any]) -> list[dict[str, Any]]:
    return upsert_materialization_run(previous_runs, next_run)

def spark_materialization_mode(job: ETLJobModel, result: dict[str, Any]) -> str:
    mode_values = [
        result.get("materializationMode"),
        result.get("materialization_mode"),
        result.get("spark_materialization_mode"),
    ]
    raw_mode = next((value for value in mode_values if str(value or "").strip()), None)
    has_explicit_mode = raw_mode is not None
    explicit_mode = str(raw_mode or "").strip().casefold()
    if explicit_mode in {"snapshot", "delta"}:
        return explicit_mode
    if has_explicit_mode:
        return "snapshot"
    if str(result.get("sourceKind") or "").strip().casefold() == "kafka":
        return "delta"
    source_collection = result.get("sourceCollection")
    if not isinstance(source_collection, dict):
        return "snapshot"
    is_incremental_folder = (
        str(source_collection.get("scope") or "").strip().casefold() == "folder"
        and str(source_collection.get("mode") or "incremental").strip().casefold() == "incremental"
    )
    if not is_incremental_folder:
        return "snapshot"
    rebaseline = bool(source_collection.get("rebaseline"))
    lower_bound = str(source_collection.get("incrementalSince") or "").strip()
    return "delta" if lower_bound and not rebaseline else "snapshot"

def spark_source_window_metadata(result: dict[str, Any]) -> dict[str, Any]:
    source_collection = result.get("sourceCollection")
    if not isinstance(source_collection, dict):
        return {}
    try:
        version = int(source_collection.get("windowContractVersion"))
    except (TypeError, ValueError):
        return {}
    upper_bound = str(source_collection.get("incrementalBefore") or "").strip()
    if version not in SUPPORTED_SOURCE_WINDOW_CONTRACT_VERSIONS or not upper_bound:
        return {}
    object_keys = source_collection.get("objectKeys")
    normalized_keys = (
        sorted({str(key) for key in object_keys if str(key).strip()})
        if isinstance(object_keys, list)
        else None
    )
    source_window: dict[str, Any] = {
        "contractVersion": version,
        "lowerBound": str(source_collection.get("incrementalSince") or "").strip() or None,
        **({"objectKeys": normalized_keys} if normalized_keys is not None else {}),
        "rebaseline": bool(source_collection.get("rebaseline")),
        "upperBound": upper_bound,
    }
    if version >= SOURCE_WINDOW_CONTRACT_VERSION:
        object_inventory = normalize_source_object_inventory(source_collection.get("objectInventory"))
        if object_inventory is None:
            return {}
        inventory_keys = [str(item["key"]) for item in object_inventory]
        if normalized_keys is None or inventory_keys != normalized_keys:
            return {}
        source_window["objectInventory"] = object_inventory
    return {
        "sourceWindow": source_window,
    }

def normalize_source_object_inventory(value: Any) -> list[dict[str, Any]] | None:
    if not isinstance(value, list):
        return None
    inventory_by_key: dict[str, dict[str, Any]] = {}
    for item in value:
        if not isinstance(item, dict):
            return None
        key = str(item.get("key") or item.get("Key") or "").strip()
        e_tag = normalize_s3_etag(item.get("eTag") or item.get("ETag") or item.get("etag"))
        last_modified = object_last_modified_iso(item.get("lastModified") or item.get("LastModified"))
        if not key or not e_tag or not last_modified:
            return None
        try:
            size = s3_object_size(item.get("size") if "size" in item else item.get("Size"))
        except ApiError:
            return None
        normalized = {
            "key": key,
            "eTag": e_tag,
            "versionId": normalize_s3_version_id(item.get("versionId") or item.get("VersionId")),
            "lastModified": last_modified,
            "size": size,
        }
        if key in inventory_by_key and inventory_by_key[key] != normalized:
            return None
        inventory_by_key[key] = normalized
    return [inventory_by_key[key] for key in sorted(inventory_by_key)]

def identity_name(value: str | None) -> str:
    return (value or "").strip() or "demo-user"

def identity_profile(name: str) -> dict[str, str]:
    display_name = identity_name(name)
    words = [word for word in display_name.replace("_", " ").replace("-", " ").split(" ") if word]
    initials = "".join(word[0].upper() for word in words[:2]) or display_name[:2].upper()
    return {
        "avatarInitials": initials[:2],
        "displayName": display_name,
    }

def parse_count_value(value: Any) -> int:
    if isinstance(value, bool) or value is None:
        return 0
    if isinstance(value, int):
        return max(value, 0)
    if isinstance(value, float):
        return max(int(value), 0)
    digits = re.sub(r"[^0-9]", "", str(value))
    return int(digits) if digits else 0

def parse_optional_integer(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None

def etl_dataset_lineage_graph(job: ETLJobModel, dataset_id: str, schema_json: list[list[str]]) -> dict[str, Any]:
    source_node_id = normalize_lineage_id(f"{dataset_id}-{job.source_label or job.source_type or 'source'}")
    source_schema = source_lineage_schema(job, schema_json)
    source_node = lineage_node(
        source_node_id,
        job.source_label or job.source_type or "Source",
        "SOURCE",
        source_schema,
        lineage_source_engine(job),
    )
    job_node = lineage_node(normalize_lineage_id(job.id), job.name, "PROCESS", schema_json, "SPARK")
    target_node = lineage_node(
        dataset_id,
        job.target,
        job.target_layer or "RAW",
        schema_json,
        lineage_target_engine(job),
    )
    return {
        "datasetId": dataset_id,
        "datasets": [source_node, job_node, target_node],
        "edges": [
            *lineage_edges_from_job_inputs(job, source_node, job_node),
            *lineage_edges_between(job_node, target_node),
        ],
    }

def source_lineage_schema(job: ETLJobModel, target_schema: list[list[str]]) -> list[list[str]]:
    type_by_name: dict[str, str] = {
        str(name): str(type_ or "string")
        for name, type_ in target_schema
        if name
    }
    for column in job.schema_columns or []:
        if not isinstance(column, dict):
            continue
        type_value = str(column.get("type") or "string")
        for name in (column.get("sourceName"), column.get("targetName")):
            if name:
                type_by_name.setdefault(str(name), type_value)

    transform_outputs = {
        str(step.get("output") or "").strip()
        for step in job.transform_steps or []
        if isinstance(step, dict) and step.get("enabled", True) is not False
    }
    source_names: list[str] = []
    for step in job.transform_steps or []:
        if not isinstance(step, dict) or step.get("enabled", True) is False:
            continue
        append_unique(source_names, str(step.get("input") or "").strip())

    for column in job.schema_columns or []:
        if not isinstance(column, dict) or not schema_column_included(column):
            continue
        source_name = str(column.get("sourceName") or "").strip()
        target_name = str(column.get("targetName") or source_name).strip()
        if not source_name or source_name.startswith("__text_analysis.") or target_name in transform_outputs:
            continue
        append_unique(source_names, source_name)

    if not source_names:
        source_names = [str(name) for name, _ in target_schema if name and not str(name).startswith("_asklake_")]
    return [[name, type_by_name.get(name, "string")] for name in source_names]

def lineage_target_engine(_job: ETLJobModel) -> str:
    return SPARK_OUTPUT_FORMAT.upper()

def lineage_source_engine(job: ETLJobModel) -> str:
    source_label = str(getattr(job, "source_label", "") or "").lower().split("?", 1)[0]
    for suffix, engine in (
        (".parquet", "PARQUET"),
        (".jsonl", "JSONL"),
        (".ndjson", "JSONL"),
        (".json", "JSON"),
        (".csv", "CSV"),
        (".avro", "AVRO"),
        (".xlsx", "XLSX"),
    ):
        if source_label.endswith(suffix):
            return engine

    source_type = str(getattr(job, "source_type", "") or "").strip()
    return source_type.upper() or "SOURCE"

def lineage_edges_from_job_inputs(
    job: ETLJobModel,
    source_node: dict[str, Any],
    job_node: dict[str, Any],
) -> list[dict[str, str]]:
    source_columns = lineage_columns_by_name(source_node)
    job_columns = lineage_columns_by_name(job_node)
    pairs: list[tuple[str, str]] = []

    for step in job.transform_steps or []:
        if not isinstance(step, dict) or step.get("enabled", True) is False:
            continue
        append_unique_pair(
            pairs,
            str(step.get("input") or "").strip(),
            str(step.get("output") or "").strip(),
        )

    for column in job.schema_columns or []:
        if not isinstance(column, dict) or not schema_column_included(column):
            continue
        source_name = str(column.get("sourceName") or "").strip()
        target_name = str(column.get("targetName") or source_name).strip()
        if source_name.startswith("__text_analysis."):
            continue
        append_unique_pair(pairs, source_name, target_name)

    for name in source_columns:
        if name in job_columns:
            append_unique_pair(pairs, name, name)

    return [
        lineage_edge(source_node, source_columns[source_name], job_node, job_columns[target_name])
        for source_name, target_name in pairs
        if source_name in source_columns and target_name in job_columns
    ]

def lineage_edges_between(source_node: dict[str, Any], target_node: dict[str, Any]) -> list[dict[str, str]]:
    source_columns = lineage_columns_by_name(source_node)
    target_columns = lineage_columns_by_name(target_node)
    return [
        lineage_edge(source_node, source_columns[name], target_node, target_column)
        for name, target_column in target_columns.items()
        if name in source_columns
    ]

def lineage_columns_by_name(node: dict[str, Any]) -> dict[str, dict[str, Any]]:
    columns = node.get("columns") if isinstance(node.get("columns"), list) else []
    return {
        str(column.get("name")): column
        for column in columns
        if isinstance(column, dict) and column.get("name")
    }

def lineage_edge(
    source_node: dict[str, Any],
    source_column: dict[str, Any],
    target_node: dict[str, Any],
    target_column: dict[str, Any],
) -> dict[str, str]:
    return {
        "fromColumnId": str(source_column.get("id")),
        "fromDatasetId": str(source_node.get("id")),
        "toColumnId": str(target_column.get("id")),
        "toDatasetId": str(target_node.get("id")),
    }

def append_unique(values: list[str], value: str) -> None:
    if value and value not in values:
        values.append(value)

def append_unique_pair(values: list[tuple[str, str]], source: str, target: str) -> None:
    pair = (source, target)
    if source and target and pair not in values:
        values.append(pair)

def dataset_storage_size_bytes(output_path: str) -> int:
    path = Path(output_path)
    if not path.exists():
        return 0
    if path.is_file():
        return path.stat().st_size
    total = 0
    for item in path.rglob("*"):
        if item.is_file():
            total += item.stat().st_size
    return total

def format_storage_size(size_bytes: int) -> str:
    if size_bytes < 1024:
        return f"{size_bytes}B"
    units = ["KB", "MB", "GB", "TB"]
    size = float(size_bytes)
    for unit in units:
        size /= 1024
        if size < 1024:
            return f"{size:.1f}{unit}"
    return f"{size:.1f}PB"

def dag_steps_from_spark_result(job: ETLJobModel, command: str, run: dict[str, Any], result: dict[str, Any]) -> list[dict[str, Any]]:
    failed = result.get("status") != "success"
    failed_stage = str(result.get("failedStage") or "").lower()
    read_failed = failed and ("read" in failed_stage or "source" in failed_stage or not failed_stage)
    transform_failed = failed and "transform" in failed_stage
    quality_failed = failed and "quality" in failed_stage
    transform_meta = f"{len(job.transform_steps or [])}개 규칙"
    quality_meta = f"{len(job.quality_rules or [])}개 검사"
    source_path = str(result.get("sourcePath") or job.source)
    output_path = str(result.get("outputPath") or run.get("outputPath") or "-")
    input_file_count = result.get("inputFileCount")
    input_bytes = result.get("inputBytes")
    output_file_count = result.get("outputFileCount")
    spark_logs = compact_spark_logs(result)
    quality_result = result.get("quality") if isinstance(result.get("quality"), dict) else {}
    quality_summary = str(quality_result.get("summary") or "-")

    return [
        dag_step("source", "1. 소스 연결", job.source, "success", [
            ["소스", job.source],
            ["소스 경로", source_path],
        ], [f"{job.source_type} 커넥터 설정 확인 완료."]),
        dag_step("schema", "2. 스키마 확인", job.stats.get("schemaColumns", "-"), "success", [
            ["스키마", job.stats.get("schemaColumns", "-")],
            ["샘플 범위", job.stats.get("sampleScope", "-")],
        ], ["생성 시 확정된 스키마를 Spark 실행 계약에 사용했습니다."]),
        dag_step("read", "3. Spark 소스 읽기", run.get("inputRows", "0"), "failed" if read_failed else "success", [
            ["입력 행", run.get("inputRows", "0")],
            ["입력 파일", str(input_file_count) if input_file_count is not None else "-"],
            ["입력 용량", format_storage_size(int(input_bytes)) if isinstance(input_bytes, (int, float)) and input_bytes >= 0 else "-"],
            ["Spark source", source_path],
        ], [f"Spark 소스 읽기 실패: {run.get('errorSummary')}" if read_failed else f"Spark가 {run.get('inputRows', '0')}을 읽었습니다.", *spark_logs]),
        dag_step("transform", "4. 처리 규칙 적용", transform_meta, "failed" if transform_failed else "blocked" if read_failed else "success", [
            ["처리 규칙", transform_meta],
        ], [f"처리 규칙 적용 실패: {run.get('errorSummary')}" if transform_failed else "소스 읽기 실패로 처리 규칙 적용이 중단되었습니다." if read_failed else "처리 규칙 적용 완료."]),
        dag_step("quality", "5. 품질 검증", quality_meta, "failed" if quality_failed else "blocked" if read_failed or transform_failed else "success", [
            ["품질 검사", quality_meta],
            ["품질 결과", quality_summary],
        ], [f"품질 검증 실패: {run.get('errorSummary')}" if quality_failed else "이전 단계 실패로 품질 검증이 실행되지 않았습니다." if read_failed or transform_failed else quality_summary if quality_summary != "-" else "품질 검증 완료."]),
        dag_step("write", "6. Parquet 적재", output_path, "blocked" if failed else "success", [
            ["출력 경로", output_path],
            ["출력 행", run.get("outputRows", "0")],
            ["Parquet 파일", str(output_file_count) if output_file_count is not None else "-"],
        ], ["이전 단계 실패로 Parquet 적재가 수행되지 않았습니다." if failed else f"Parquet 출력 완료: {output_path}"]),
        dag_step("catalog", "7. 카탈로그 데이터셋 갱신", job.target, "blocked" if failed else "success", [
            ["데이터셋", job.target],
            ["레이어", job.target_layer],
        ], ["실행 실패로 카탈로그 데이터셋을 갱신하지 않았습니다." if failed else "실행 성공 후 카탈로그 데이터셋을 갱신했습니다."]),
    ]

def _kafka_dag_statuses(result: dict[str, Any], stored_count: int) -> dict[str, Any]:
    failed = result.get("status") != "success"
    failed_stage = str(result.get("failedStage") or "").lower()
    consume_failed = failed and failed_stage in {"kafka ingest", "consume", "source"}
    transform_failed = failed and failed_stage == "transform"
    quality_failed = failed and failed_stage == "quality"
    target_failed = failed and any(value in failed_stage for value in ("iceberg", "spark", "storage", "target", "write"))
    catalog_failed = failed and failed_stage == "catalog"
    offset_failed = failed and "offset" in failed_stage
    iceberg_commit = result.get("icebergCommit") if isinstance(result.get("icebergCommit"), dict) else {}
    catalog_dataset = result.get("catalogDataset") if isinstance(result.get("catalogDataset"), dict) else {}
    offset_commit = result.get("offsetCommit") if isinstance(result.get("offsetCommit"), dict) else {}
    no_new_rows = stored_count == 0 and not any((consume_failed, transform_failed, quality_failed, target_failed))
    target_committed = bool(str(iceberg_commit.get("snapshotId") or "").strip())
    catalog_committed = bool(catalog_dataset.get("id"))
    target_status = "success" if target_committed or no_new_rows else "failed" if target_failed else "blocked" if failed else "success"
    catalog_status = "success" if catalog_committed or no_new_rows else "failed" if catalog_failed else "blocked" if target_status != "success" or failed else "success"
    offset_status = "success" if offset_commit.get("status") == "success" else "failed" if offset_failed else "blocked" if failed else "success"
    return {
        "catalog_failed": catalog_failed,
        "catalog_status": catalog_status,
        "consume_failed": consume_failed,
        "no_new_rows": no_new_rows,
        "offset_failed": offset_failed,
        "offset_status": offset_status,
        "quality_failed": quality_failed,
        "target_failed": target_failed,
        "target_status": target_status,
        "transform_failed": transform_failed,
    }


def dag_steps_from_kafka_result(job: ETLJobModel, command: str, run: dict[str, Any], result: dict[str, Any]) -> list[dict[str, Any]]:
    topic = str(result.get("topic") or field_value(job.source_config or [], "TOPIC / QUEUE NAME") or "-")
    broker = str(result.get("broker") or field_value(job.source_config or [], "Broker / Endpoint") or "-")
    storage_location = str(result.get("storageLocation") or run.get("outputPath") or "-")
    dataset_id = str(result.get("datasetId") or job.dataset_id or make_dataset_id(job.target))
    consumer_group_id = str(result.get("consumerGroupId") or field_value(job.source_config or [], "CONSUMER GROUP ID") or "-")
    snapshot = result.get("snapshot") if isinstance(result.get("snapshot"), dict) else {}
    transform = result.get("transform") if isinstance(result.get("transform"), dict) else {}
    quality = result.get("quality") if isinstance(result.get("quality"), dict) else {}
    iceberg_commit = result.get("icebergCommit") if isinstance(result.get("icebergCommit"), dict) else {}
    catalog_dataset = result.get("catalogDataset") if isinstance(result.get("catalogDataset"), dict) else {}
    offset_commit = result.get("offsetCommit") if isinstance(result.get("offsetCommit"), dict) else {}
    stored_count = parse_count_value(result.get("storedCount"))
    statuses = _kafka_dag_statuses(result, stored_count)
    catalog_failed = statuses["catalog_failed"]
    catalog_status = statuses["catalog_status"]
    consume_failed = statuses["consume_failed"]
    no_new_rows = statuses["no_new_rows"]
    offset_failed = statuses["offset_failed"]
    offset_status = statuses["offset_status"]
    quality_failed = statuses["quality_failed"]
    target_failed = statuses["target_failed"]
    target_status = statuses["target_status"]
    transform_failed = statuses["transform_failed"]
    snapshot_ranges = ", ".join(
        f"p{item.get('partition')}:{item.get('startOffset')}~{item.get('endOffset')}"
        for item in snapshot.get("partitions", [])
        if isinstance(item, dict)
    ) or "-"
    return [
        dag_step("source", "1. Kafka 소스 연결", topic, "failed" if consume_failed else "success", [
            ["Broker", broker],
            ["Topic", topic],
        ], [f"Kafka topic {topic} batch consume 요청을 실행했습니다."]),
        dag_step("consume", "2. 메시지 batch consume", format_rows(result.get("consumedCount")), "failed" if consume_failed else "success", [
            ["Consumer group", consumer_group_id],
            ["Snapshot", str(snapshot.get("snapshotId") or "-")],
            ["Offset ranges", snapshot_ranges],
            ["Consumed", format_rows(result.get("consumedCount"))],
            ["Failed", format_rows(result.get("failedCount"))],
        ], [f"Kafka consume 실패: {run.get('errorSummary')}" if consume_failed else "Kafka 메시지를 batch 단위로 읽었습니다."]),
        dag_step("transform", "3. 변환 규칙 적용", f"{transform.get('appliedStepCount', 0)}개 규칙", "failed" if transform_failed else "blocked" if consume_failed else "success", [
            ["Configured", str(transform.get("configuredStepCount", 0))],
            ["Applied", str(transform.get("appliedStepCount", 0))],
            ["Transform errors", str(transform.get("errorCount", 0))],
        ], [f"변환 규칙 적용 실패: {run.get('errorSummary')}" if transform_failed else "Kafka consume 실패로 변환이 수행되지 않았습니다." if consume_failed else "Kafka snapshot 레코드에 변환 규칙을 적용했습니다."]),
        dag_step("quality", "4. 품질 검증", str(quality.get("summary") or "규칙 없음"), "failed" if quality_failed else "blocked" if consume_failed or transform_failed else "success", [
            ["Configured", str(quality.get("configuredRuleCount", 0))],
            ["Invalid", str(quality.get("invalidRowCount", 0))],
            ["Quarantined", str(quality.get("quarantinedCount", 0))],
            ["Dropped", str(quality.get("droppedCount", 0))],
        ], [f"품질 검증 실패: {run.get('errorSummary')}" if quality_failed else "이전 단계 실패로 품질 검증이 수행되지 않았습니다." if consume_failed or transform_failed else str(quality.get("summary") or "품질 규칙 없음")]),
        dag_step("target", "5. Iceberg target 커밋", storage_location, target_status, [
            ["Table", str((iceberg_commit.get("target") or {}).get("tableUri") or result.get("outputPath") or "-")],
            ["Format", "Iceberg (Parquet)"],
            ["Layer", str(result.get("targetLayer") or job.target_layer)],
            ["Snapshot", str(iceberg_commit.get("snapshotId") or ("변경 없음" if no_new_rows else "-"))],
            ["Stored", format_rows(result.get("storedCount"))],
        ], [
            f"Iceberg target 커밋 실패: {run.get('errorSummary')}" if target_failed
            else "새 offset 범위가 없어 Iceberg snapshot을 변경하지 않았습니다." if no_new_rows
            else "이전 단계 실패로 Iceberg target 커밋이 수행되지 않았습니다." if target_status == "blocked"
            else f"Kafka snapshot 결과를 Iceberg table에 커밋했습니다: {storage_location}"
        ]),
        dag_step("catalog", "6. Trino 검증 및 카탈로그 갱신", dataset_id, catalog_status, [
            ["Dataset", dataset_id],
            ["Run ID", run.get("runId", "-")],
            ["Trino", "verified" if result.get("queryEngineVerified") is True else "변경 없음" if no_new_rows else "pending"],
        ], [
            f"Trino/Catalog 검증 실패: {run.get('errorSummary')}" if catalog_failed
            else "새 Iceberg snapshot이 없어 기존 카탈로그 매핑을 유지했습니다." if no_new_rows
            else "이전 단계 실패로 Trino/Catalog 검증이 중단되었습니다." if catalog_status == "blocked"
            else "Iceberg snapshot을 Trino로 검증하고 Catalog materialization을 갱신했습니다."
        ]),
        dag_step("offset", "7. Kafka offset 확정", str(snapshot.get("snapshotId") or "-"), offset_status, [
            ["Consumer group", consumer_group_id],
            ["Offset ranges", snapshot_ranges],
            ["Commit status", str(offset_commit.get("status") or "pending")],
        ], [
            f"Kafka offset 확정 실패: {run.get('errorSummary')}" if offset_failed
            else "이전 단계 실패로 Kafka offset을 확정하지 않았습니다." if offset_status == "blocked"
            else "Iceberg와 Catalog 검증 완료 후 Kafka consumer offset을 확정했습니다."
        ]),
    ]

def compact_spark_logs(result: dict[str, Any]) -> list[str]:
    lines = "\n".join(str(result.get(key) or "") for key in ["error", "stderr", "stdout"]).splitlines()
    return [line for line in lines if line.strip()][-80:]

def schema_from_job(job: ETLJobModel) -> list[list[str]]:
    return [
        [str(column.get("targetName") or column.get("sourceName") or f"column_{index + 1}"), str(column.get("type") or "string")]
        for index, column in enumerate(job.schema_columns or [])
        if schema_column_included(column)
    ]

def schema_column_included(column: Any) -> bool:
    if not isinstance(column, dict):
        return True
    value = column.get("included", True)
    if isinstance(value, str):
        return value.strip().lower() not in {"false", "0", "no", "off"}
    return value is not False

def quality_summary_from_spark_result(job: ETLJobModel, result: dict[str, Any]) -> str:
    quality = result.get("quality") if isinstance(result.get("quality"), dict) else None
    if quality:
        if quality.get("summary"):
            return str(quality["summary"])
        if quality.get("score") is not None:
            return f"품질 점수 {quality.get('score')}% · 상태 {quality_status_label(str(quality.get('status') or job.quality_status))}"
    return f"품질 점수 {job.quality_score if job.quality_score is not None else '-'}% · 상태 {quality_status_label(job.quality_status)}"
