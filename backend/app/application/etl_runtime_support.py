"""Shared, side-effect-free ETL runtime helpers."""

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
from app.core.s3_policy import resolve_s3_source_location, s3_source_config_fields, validate_s3_source_config
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
from app.services.iceberg_writer_service import (
    IcebergWriterError,
    IcebergWriterService,
    build_iceberg_writer_target,
    writer_mode_for_source,
)

def is_kafka_job(job: ETLJobModel) -> bool:
    source_type = str(job.source_type or "").lower()
    if "kafka" in source_type:
        return True
    fields = job.source_config or []
    return bool(field_value(fields, "Broker / Endpoint") and (field_value(fields, "TOPIC / QUEUE NAME") or field_value(fields, "Topic")))

def writer_mode_for_pipeline(source_type: str, source_config: Any) -> str:
    default_mode = writer_mode_for_source(source_type)
    if default_mode == "append":
        return default_mode
    fields = s3_source_config_fields(source_config or [])
    incremental_folder = (
        str(source_type or "").strip().casefold().startswith(("file / s3", "data lake"))
        and fields.get("collection scope", "").casefold() == "folder"
        and fields.get("collection mode", "incremental").casefold() == "incremental"
    )
    return "append" if incremental_folder else "replace"

def compact_storage_text(value: Any, *, limit: int) -> str:
    text_value = str(value or "").replace("\r", "\n")
    lines = [line.strip() for line in text_value.splitlines() if line.strip()]
    compact = " | ".join(lines) if lines else "-"
    if len(compact) <= limit:
        return compact
    return f"{compact[: max(0, limit - 32)]} ... [truncated {len(compact)} chars]"

def dag_step(id_: str, title: str, meta: str, status_value: str, details: list[list[Any]] | None = None, logs: list[str] | None = None) -> dict[str, Any]:
    normalized_details = [
        [str(label or "-"), str(value if value is not None else "-")]
        for label, value in (details or [])
    ]
    return {
        "details": normalized_details,
        "id": id_,
        "logs": [str(line) for line in (logs or []) if line],
        "meta": str(meta or "-"),
        "status": status_value,
        "title": title,
    }
