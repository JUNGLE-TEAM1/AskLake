"""Pipeline validation, mutation, scheduling, and actor policies."""

from datetime import UTC, datetime, timedelta
import hashlib
import json
from typing import Any, Callable
from fastapi import status
from app.core.auth_context import ActorContext, require_permission
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
from app.application.etl_schedule import (
    cron_matches,
    has_scheduled_execution,
    has_scheduled_label,
    job_schedule_kind,
    next_custom_cron_local,
    next_scheduled_run_utc_for_schedule,
    parse_cron_field,
    schedule_next_run_label,
    schedule_policy_from_request,
    schedule_timezone,
    trino_sql_job_next_run_utc,
    trino_sql_job_schedule_label,
    trino_sql_job_schedule_summary,
)
from app.application.pipeline_mapping import (
    CreatePipelineMappingContext,
    UpdatePipelineMappingContext,
    apply_append_request_to_job,
    apply_update_request_to_job,
    map_create_request_to_job,
)
from app.core.errors import ApiError
from app.domain.pipeline_contract import (
    create_request_violations,
    permission_grant_violations,
    target_contract_violation,
    update_request_violations,
)
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
from app.schemas.etl import (
    AirflowCatalogReconciliationResponse,
    CatalogDataset,
    ContinuousCompactionRequest,
    ContinuousIcebergMaintenanceRequest,
    ContinuousMaintenanceRun,
    ContinuousQuarantineResponse,
    ContinuousReplayRequest,
    ContinuousWorkerLogsResponse,
    AirflowRunExecutionResponse,
    CreatePipelineRequest,
    CreatePipelineResponse,
    CreateTrinoSqlJobRequest,
    JobCommandResponse,
    JobListResponse,
    JobDagStep,
    JobRowData,
    JobRunOutcome,
    JobScheduleKind,
    PermissionOptionGroup,
    PermissionOptionsResponse,
    PermissionOptionUser,
    KafkaContinuousBatch,
    KafkaContinuousSession,
    ReviewEntry,
    ReviewPipelineRequest,
    RecordParsingDraft,
    RecordParsingPreviewRequest,
    ReviewSchemaRow,
    ReviewSnapshot,
    ReviewValidationRow,
    KafkaReviewIngestRequest,
    KafkaReviewIngestResponse,
    QueryRunRequest,
    QueryRunResponse,
    ScheduledJobRunItem,
    ScheduledJobRunRequest,
    ScheduledJobRunResponse,
    SchemaColumnDraft,
    SchemaDraft,
    SourceAssetsRequest,
    SourceAssetsResponse,
    SourceConnectorAnalysis,
    SourceConnectorDefaults,
    SourceConnectorRequest,
    UpdatePipelineRequest,
)
from app.services.iceberg_writer_service import (
    IcebergWriterError,
    IcebergWriterService,
    build_iceberg_writer_target,
    writer_mode_for_source,
)
from app.services.rule_compiler import CompiledRuleSet, compile_rule_set

from app.application.etl_runtime_support import (
    is_kafka_job,
    writer_mode_for_pipeline,
)

def compile_pipeline_rules(
    request: CreatePipelineRequest | UpdatePipelineRequest,
    *,
    execution_mode: str | None = None,
    source_type: str | None = None,
) -> CompiledRuleSet:
    canonical_requested = request.rule_contract_version is not None or bool(request.rules)
    return compile_rule_set(
        contract_version=request.rule_contract_version,
        rules=request.rules if canonical_requested else None,
        transform_steps=request.transform_steps,
        quality_rules=request.quality_rules,
        schema_columns=request.schema_columns,
        transform_output_columns=request.transform_output_columns,
        execution_mode=execution_mode or getattr(request, "execution_mode", "snapshot"),
        source_type=source_type or getattr(request, "source_type", ""),
    )

def compile_job_rules(job: ETLJobModel) -> CompiledRuleSet:
    canonical_rules = job.rules if job.rule_contract_version is not None else None
    return compile_rule_set(
        contract_version=job.rule_contract_version,
        rules=canonical_rules,
        transform_steps=job.transform_steps or [],
        quality_rules=job.quality_rules or [],
        schema_columns=job.schema_columns or [],
        transform_output_columns=job.transform_output_columns or [],
        execution_mode=job.execution_mode or "snapshot",
        source_type=job.source_type or "",
    )

def canonical_rule_fingerprint(contract_version: str, rules: list[dict[str, Any]]) -> str:
    payload = json.dumps(
        {"contractVersion": contract_version, "rules": rules},
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()

def require_compiled_rules(compiled: CompiledRuleSet) -> None:
    if compiled.result.status == "pass":
        return
    raise ApiError(
        "RULE_COMPILATION_FAILED",
        compiled.result.issues[0].message if compiled.result.issues else "Rule compilation failed.",
        status.HTTP_400_BAD_REQUEST,
        {
            "contractVersion": compiled.result.contract_version,
            "issues": [issue.model_dump(mode="json", by_alias=True) for issue in compiled.result.issues],
            "outputSchema": compiled.result.output_schema,
        },
    )

def apply_compiled_rules(request: CreatePipelineRequest | UpdatePipelineRequest, compiled: CompiledRuleSet) -> None:
    request.rule_contract_version = "1.0"
    request.rules = compiled.result.rules
    request.transform_steps = compiled.transform_steps
    request.quality_rules = compiled.quality_rules
    request.transform_output_columns = compiled.result.output_schema

def validate_create_request(request: CreatePipelineRequest) -> None:
    violations = create_request_violations(
        request,
        normalize_column_name=normalize_column_name,
    )
    if violations:
        violation = violations[0]
        raise ApiError(
            violation.code,
            violation.message,
            status.HTTP_400_BAD_REQUEST,
            violation.details,
        )

def validate_update_request(request: UpdatePipelineRequest) -> None:
    violations = update_request_violations(request)
    if violations:
        violation = violations[0]
        raise ApiError(
            violation.code,
            violation.message,
            status.HTTP_400_BAD_REQUEST,
            violation.details,
        )

def validate_target_contract(*, source_type: str, execution_mode: str, target_layer: str, target_format: str) -> None:
    violation = target_contract_violation(
        source_type=source_type,
        execution_mode=execution_mode,
        target_layer=target_layer,
        target_format=target_format,
    )
    if violation is not None:
        raise ApiError(
            violation.code,
            violation.message,
            status.HTTP_400_BAD_REQUEST,
            violation.details,
        )

def target_contract_issue(*, source_type: str, execution_mode: str, target_layer: str, target_format: str) -> str | None:
    try:
        validate_target_contract(
            source_type=source_type,
            execution_mode=execution_mode,
            target_layer=target_layer,
            target_format=target_format,
        )
    except ApiError as exc:
        return exc.message
    return None

def validate_requested_permission_grants(grants: list[Any] | None) -> None:
    violations = permission_grant_violations(grants)
    if violations:
        violation = violations[0]
        raise ApiError(
            violation.code,
            violation.message,
            status.HTTP_400_BAD_REQUEST,
            violation.details,
        )

def target_identity_changed(job: ETLJobModel, request: UpdatePipelineRequest) -> bool:
    return any((
        str(job.target or "") != request.target_dataset,
        str(job.target_layer or "") != request.target_layer,
        str(job.target_format or "") != request.target_format,
        str(job.target_database or "asklake") != str(request.target_database or "asklake"),
        str(job.storage_type or "") != str(request.storage_type or ""),
        str(job.storage_path or "") != str(request.storage_path or ""),
    ))

def continuous_processing_contract_changed(job: ETLJobModel, request: UpdatePipelineRequest) -> bool:
    if job.execution_mode != "continuous":
        return False
    compiled_job = compile_job_rules(job)
    require_compiled_rules(compiled_job)
    current = {
        "compression": job.compression,
        "indexColumns": normalize_string_list(job.index_columns),
        "partition": job.partition,
        "partitionColumns": normalize_string_list(job.partition_columns),
        "ruleContractVersion": compiled_job.result.contract_version,
        "rules": [rule.model_dump(mode="json", by_alias=True) for rule in compiled_job.result.rules],
        "schemaColumns": [
            SchemaColumnDraft.model_validate(column).model_dump(mode="json", by_alias=True)
            for column in (job.schema_columns or [])
        ],
        "storagePath": job.storage_path,
        "storageType": job.storage_type,
        "targetDatabase": normalize_optional_text(job.target_database) or "asklake",
        "targetDataset": job.target,
        "targetFormat": job.target_format,
        "targetLayer": job.target_layer,
    }
    requested = {
        "compression": request.compression,
        "indexColumns": normalize_string_list(request.index_columns),
        "partition": request.partition,
        "partitionColumns": normalize_string_list(request.partition_columns),
        "ruleContractVersion": request.rule_contract_version,
        "rules": [rule.model_dump(mode="json", by_alias=True) for rule in request.rules],
        "schemaColumns": [column.model_dump(mode="json", by_alias=True) for column in request.schema_columns],
        "storagePath": request.storage_path,
        "storageType": request.storage_type,
        "targetDatabase": normalize_optional_text(request.target_database) or "asklake",
        "targetDataset": request.target_dataset,
        "targetFormat": request.target_format,
        "targetLayer": request.target_layer,
    }
    return json.dumps(current, ensure_ascii=False, separators=(",", ":"), sort_keys=True) != json.dumps(
        requested,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )

def continuous_checkpoint_initialized(runtime: KafkaContinuousRuntimeModel) -> bool:
    return any((
        runtime.last_batch_id is not None,
        int(runtime.consumed_count or 0) > 0,
        bool((runtime.metrics or {}).get("runtimeFingerprint")),
    ))

def apply_update_request(
    job: ETLJobModel,
    request: UpdatePipelineRequest,
    target_changed: bool,
) -> None:
    """Compatibility facade for the extracted pipeline draft mapper."""

    schedule_policy = schedule_policy_from_request(request)
    dataset_id = make_dataset_id(request.target_dataset) if target_changed else str(
        job.dataset_id or make_dataset_id(request.target_dataset)
    )
    apply_update_request_to_job(
        job,
        request,
        UpdatePipelineMappingContext(
            dataset_id=dataset_id,
            iceberg_target=build_iceberg_writer_target(
                request.target_dataset,
                dataset_id,
                write_mode=writer_mode_for_pipeline(job.source_type, job.source_config),
                partition_columns=normalize_string_list(request.partition_columns),
            ).model_dump(mode="json", by_alias=True),
            next_run=schedule_next_run_label(
                request.schedule_label,
                schedule_policy.get("nextRunUtc") or request.next_run_utc or job.next_run,
            ),
            schedule_policy=schedule_policy,
            target_changed=target_changed,
        ),
    )

def trino_sql_job_permission_roles(
    access_scope: str,
    owner: str,
    principal_id: str | None = None,
) -> list[dict[str, Any]]:
    access = ["조회", "쿼리 실행", "메타데이터", "관리"]
    if access_scope == "private":
        return []
    if access_scope == "organization":
        return [{
            "access": access,
            "checked": True,
            "name": "모든 인증 사용자",
            "principalId": "authenticated-users",
            "principalType": "public",
        }]
    normalized_principal_id = (principal_id or "").strip()
    if not normalized_principal_id:
        raise ApiError(
            "VALIDATION_ERROR",
            "Project access requires a real group principalId",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    return [{
        "access": access,
        "checked": True,
        "name": normalized_principal_id,
        "principalId": normalized_principal_id,
        "principalType": "group",
    }]

def trino_sql_job_permission_summary(
    access_scope: str,
    owner: str,
    principal_id: str | None = None,
) -> str:
    if access_scope == "organization":
        return "모든 인증 사용자 · 조직 내부"
    if access_scope == "project":
        normalized_principal_id = (principal_id or "").strip()
        if not normalized_principal_id:
            raise ApiError(
                "VALIDATION_ERROR",
                "Project access requires a real group principalId",
                status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        return f"그룹 {normalized_principal_id} · 프로젝트 멤버"
    return f"{owner.strip()} · 소유자 전용"

def trino_query_run_belongs_to_actor(payload: dict[str, Any], actor: ActorContext) -> bool:
    submitted_user_id = str(payload.get("submittedByUserId") or "").strip()
    submitted_name = str(payload.get("submittedByName") or "").strip()
    return bool(
        (actor.id and submitted_user_id and actor.id == submitted_user_id)
        or (actor.name and submitted_name and actor.name == submitted_name)
    )

def should_run_scheduled_job(job: ETLJobModel, request: ScheduledJobRunRequest) -> tuple[bool, str]:
    if request.kafka_only and not is_kafka_job(job):
        return False, "not_kafka_job"
    if job.status == "stopped":
        return False, "stopped"
    if job.status == "running":
        return False, "already_running"
    if request.force:
        return True, "forced"
    if not has_scheduled_execution(job):
        return False, "not_scheduled"

    next_run_utc = ""
    if isinstance(job.schedule_policy, dict):
        next_run_utc = str(job.schedule_policy.get("nextRunUtc") or "")
    if not next_run_utc:
        return False, "next_run_not_set"

    try:
        next_run_at = datetime.fromisoformat(next_run_utc.replace("Z", "+00:00"))
    except ValueError:
        return False, "invalid_next_run"

    if next_run_at <= datetime.now(UTC):
        return True, "due"
    return False, "not_due"

def next_scheduled_run_utc(job: ETLJobModel) -> str:
    schedule = str(job.schedule or "")
    policy = job.schedule_policy if isinstance(job.schedule_policy, dict) else {}
    return next_scheduled_run_utc_for_schedule(
        schedule,
        policy.get("timezone"),
        policy.get("startDate"),
        policy.get("endDate"),
    )
