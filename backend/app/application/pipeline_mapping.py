"""Mapping boundary between ETL API drafts and persisted Job models.

This module deliberately has no repository or runtime side effects.  The
application service computes runtime-specific values (schedule, writer target,
metrics) and supplies them through mapping contexts.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.models import ETLJobModel
from app.schemas.etl import CreatePipelineRequest, UpdatePipelineRequest


@dataclass(frozen=True, slots=True)
class CreatePipelineMappingContext:
    continuous_config: dict[str, Any] | None
    created_by: str
    created_by_profile: dict[str, Any]
    dag_steps: list[dict[str, Any]]
    dataset_id: str
    iceberg_target: dict[str, Any]
    job_id: str
    metrics: dict[str, Any]
    next_run: str
    schedule_policy: dict[str, Any]
    stats: dict[str, Any]


@dataclass(frozen=True, slots=True)
class UpdatePipelineMappingContext:
    dataset_id: str
    iceberg_target: dict[str, Any]
    next_run: str
    schedule_policy: dict[str, Any]
    target_changed: bool


def map_create_request_to_job(
    request: CreatePipelineRequest,
    context: CreatePipelineMappingContext,
) -> ETLJobModel:
    """Create the persisted Job aggregate without touching a repository."""

    return ETLJobModel(
        id=context.job_id,
        name=request.job_name,
        owner=request.owner,
        created_by=context.created_by,
        created_by_profile=context.created_by_profile,
        status="scheduled",
        tag="[생성]",
        source=f"{request.source_type} / {request.source_label}",
        target=request.target_dataset,
        schedule=request.schedule_label,
        schedule_policy=context.schedule_policy,
        schedule_summary=request.schedule_summary,
        retry_policy=_dump(request.retry_policy) if request.retry_policy else None,
        retry_policy_summary=request.retry_policy_summary,
        run_limit_summary=request.run_limit_summary,
        source_config=_row_lists(request.source_config),
        source_label=request.source_label,
        source_type=request.source_type,
        execution_mode=request.execution_mode,
        continuous_config=context.continuous_config,
        record_parsing=_dump(request.record_parsing) if request.record_parsing else None,
        schema_columns=[_dump(column) for column in request.schema_columns],
        schema_fingerprint=request.schema_fingerprint,
        schema_sample_rows=request.schema_sample_rows,
        schema_summary=request.schema_summary,
        rule_summary=request.rule_summary,
        rule_contract_version=request.rule_contract_version,
        rules=[_dump(rule) for rule in request.rules],
        permission_summary=request.permission_summary,
        permission_roles=request.permission_roles,
        storage_type=request.storage_type,
        partition=request.partition,
        partition_columns=_string_list(request.partition_columns),
        index_columns=_string_list(request.index_columns),
        compression=request.compression,
        storage_path=request.storage_path,
        iceberg_target=context.iceberg_target,
        target_description=_optional_text(request.target_description),
        target_database=_optional_text(request.target_database),
        target_tags=_target_tags(request.target_tags),
        target_format=request.target_format,
        target_layer=request.target_layer,
        target_path=request.storage_path,
        rag=request.rag,
        transform_output_columns=_row_lists(request.transform_output_columns),
        transform_steps=[_dump(step) for step in request.transform_steps],
        quality_invalid_rows=request.quality_invalid_rows,
        quality_rules=[_dump(rule) for rule in request.quality_rules],
        quality_score=request.quality_score,
        quality_status=request.quality_status,
        last_run="생성 후 미실행",
        last_state=f"{context.metrics['schema_columns']}개 컬럼 추론 완료",
        next_run=context.next_run,
        progress=None,
        stats=context.stats,
        dag_steps=context.dag_steps,
        dataset_id=context.dataset_id,
    )


def apply_append_request_to_job(
    job: ETLJobModel,
    request: CreatePipelineRequest,
    context: CreatePipelineMappingContext,
) -> None:
    """Apply a create-on-existing-target request while preserving identity."""

    job.name = request.job_name or job.name
    job.owner = request.owner
    job.created_by = job.created_by or context.created_by
    job.created_by_profile = job.created_by_profile or context.created_by_profile
    job.tag = "[append]"
    job.source = f"{request.source_type} / {request.source_label}"
    job.target = request.target_dataset
    job.schedule = request.schedule_label
    job.schedule_policy = context.schedule_policy
    job.schedule_summary = request.schedule_summary
    job.retry_policy = _dump(request.retry_policy) if request.retry_policy else None
    job.retry_policy_summary = request.retry_policy_summary
    job.run_limit_summary = request.run_limit_summary
    job.source_config = _row_lists(request.source_config)
    job.source_label = request.source_label
    job.source_type = request.source_type
    job.execution_mode = request.execution_mode
    job.continuous_config = context.continuous_config
    job.record_parsing = _dump(request.record_parsing) if request.record_parsing else None
    job.schema_columns = [_dump(column) for column in request.schema_columns]
    job.schema_fingerprint = request.schema_fingerprint
    job.schema_sample_rows = request.schema_sample_rows
    job.schema_summary = request.schema_summary
    job.rule_summary = request.rule_summary
    job.rule_contract_version = request.rule_contract_version
    job.rules = [_dump(rule) for rule in request.rules]
    job.permission_summary = request.permission_summary
    job.permission_roles = request.permission_roles
    job.storage_type = request.storage_type
    job.partition = request.partition
    job.partition_columns = _string_list(request.partition_columns)
    job.index_columns = _string_list(request.index_columns)
    job.compression = request.compression
    job.storage_path = request.storage_path
    job.iceberg_target = context.iceberg_target
    job.target_description = _optional_text(request.target_description)
    job.target_database = _optional_text(request.target_database)
    job.target_tags = _target_tags(request.target_tags)
    job.target_format = request.target_format
    job.target_layer = request.target_layer
    job.target_path = request.storage_path
    job.rag = request.rag
    job.transform_output_columns = _row_lists(request.transform_output_columns)
    job.transform_steps = [_dump(step) for step in request.transform_steps]
    job.quality_invalid_rows = request.quality_invalid_rows
    job.quality_rules = [_dump(rule) for rule in request.quality_rules]
    job.quality_score = request.quality_score
    job.quality_status = request.quality_status
    job.last_run = "append draft updated"
    job.last_state = f"{context.metrics['schema_columns']}개 컬럼 · 기존 데이터셋 append 대기"
    job.next_run = context.next_run
    job.progress = None
    job.stats = context.stats
    job.dag_steps = context.dag_steps
    job.dataset_id = context.dataset_id


def apply_update_request_to_job(
    job: ETLJobModel,
    request: UpdatePipelineRequest,
    context: UpdatePipelineMappingContext,
) -> None:
    """Apply an editable draft without changing immutable source identity."""

    job.name = request.job_name
    job.owner = request.owner
    job.target = request.target_dataset
    job.schedule = request.schedule_label
    job.schedule_policy = context.schedule_policy
    job.schedule_summary = request.schedule_summary
    job.retry_policy = _dump(request.retry_policy) if request.retry_policy else None
    job.retry_policy_summary = request.retry_policy_summary
    job.run_limit_summary = request.run_limit_summary
    job.schema_columns = [_dump(column) for column in request.schema_columns]
    job.schema_fingerprint = request.schema_fingerprint
    job.schema_sample_rows = request.schema_sample_rows
    job.schema_summary = request.schema_summary
    job.rule_summary = request.rule_summary
    job.rule_contract_version = request.rule_contract_version
    job.rules = [_dump(rule) for rule in request.rules]
    job.permission_summary = request.permission_summary
    job.permission_roles = request.permission_roles
    job.storage_type = request.storage_type
    job.partition = request.partition
    job.partition_columns = _string_list(request.partition_columns)
    job.index_columns = _string_list(request.index_columns)
    job.compression = request.compression
    job.storage_path = request.storage_path
    job.target_path = request.storage_path
    job.target_database = _optional_text(request.target_database)
    job.target_description = _optional_text(request.target_description)
    job.target_tags = _target_tags(request.target_tags)
    job.target_format = request.target_format
    job.target_layer = request.target_layer
    job.rag = request.rag
    job.transform_output_columns = _row_lists(request.transform_output_columns)
    job.transform_steps = [_dump(step) for step in request.transform_steps]
    job.quality_invalid_rows = request.quality_invalid_rows
    job.quality_rules = [_dump(rule) for rule in request.quality_rules]
    job.quality_score = request.quality_score
    job.quality_status = request.quality_status
    job.last_state = "설정 수정됨"
    job.next_run = context.next_run
    job.stats = {
        **(job.stats or {}),
        "currentStage": "설정 수정됨",
        "schemaColumns": f"{len(_dataset_schema(request)):,}개",
    }
    if context.target_changed:
        job.dataset_id = context.dataset_id
    job.iceberg_target = context.iceberg_target


def _dataset_schema(request: UpdatePipelineRequest) -> list[tuple[str, str]]:
    return [
        (column.target_name, column.type)
        for column in request.schema_columns
        if column.included and column.target_name.strip()
    ]


def _dump(value: Any) -> dict[str, Any]:
    return value.model_dump(mode="json", by_alias=True)


def _row_lists(rows: Any) -> list[list[str]]:
    return [[str(key), str(value)] for key, value in rows or []]


def _string_list(values: list[str] | None) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values or []:
        item = str(value).strip()
        if item and item not in seen:
            seen.add(item)
            result.append(item)
    return result


def _target_tags(values: list[str] | None) -> list[str]:
    return [value if value.startswith("#") else f"#{value}" for value in _string_list(values)]


def _optional_text(value: str | None) -> str | None:
    text = str(value).strip() if value is not None else ""
    return text or None
