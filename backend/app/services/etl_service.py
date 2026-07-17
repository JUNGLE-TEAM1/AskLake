from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from fnmatch import fnmatch
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
from typing import Any, Callable
from urllib.parse import urlparse

from fastapi import status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext, require_permission
from app.core.compatibility import (
    CompatibilityPath,
    record_compatibility_path,
    record_legacy_runtime_error_projection,
)
from app.application.continuous_commands import (
    ContinuousCommandHooks,
    ContinuousCommandRequest,
    execute_continuous_command,
)
from app.application.continuous_reconciliation import (
    ContinuousReconciliationHooks,
    reconcile_continuous_runtime,
)
from app.application.continuous_publication import (
    ContinuousBatchPublicationHooks,
    ContinuousPublicationHooks,
    PublicationCatalogEvidence,
    PublicationIdentity,
    PublicationInputEvidence,
    PublicationOutputEvidence,
    execute_continuous_publication,
    reconcile_continuous_publications,
)
from app.application.airflow_execution import (
    AirflowCatalogReconciliationHooks,
    AirflowSparkExecutionHooks,
    airflow_catalog_identity as resolve_airflow_catalog_identity,
    commit_airflow_catalog_reconciliation as execute_airflow_catalog_commit,
    execute_airflow_spark_run as execute_airflow_spark_command,
    finalize_spark_execution_attempt as finalize_airflow_spark_attempt,
    persist_catalog_reconciliation_failure as record_airflow_catalog_failure,
    reconcile_airflow_catalog as execute_airflow_catalog_reconciliation,
)
from app.application.etl_job_commands import (
    EtlJobDeleteHooks,
    EtlPipelineCreateHooks,
    EtlPipelineUpdateHooks,
    create_pipeline as execute_create_pipeline,
    delete_job as execute_delete_job,
    update_pipeline as execute_update_pipeline,
)
from app.application.etl_job_queries import (
    EtlJobQueryHooks,
    get_job as hydrate_job_query,
    list_jobs as hydrate_job_list_query,
    list_job_statuses as hydrate_job_statuses_query,
)
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
from app.application.etl_record_parsing import (
    dominant_field_count,
    infer_record_parsing_type,
    preview_record_parsing,
    record_parsing_column_names,
    record_parsing_timestamp,
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
from app.application.snapshot_commands import (
    SnapshotCommandViolation,
    SnapshotExecutionPath,
    plan_snapshot_command,
)
from app.application.snapshot_reconciliation import (
    SnapshotReconciliationHooks,
    reconcile_active_airflow_runs,
)
from app.application.etl_catalog_projection import (
    append_materialization_run,
    append_unique,
    append_unique_pair,
    compact_spark_logs,
    dag_steps_from_kafka_result,
    dag_steps_from_spark_result,
    dataset_from_spark_result,
    dataset_payload_from_spark_result,
    dataset_storage_size_bytes,
    etl_dataset_lineage_graph,
    format_storage_size,
    identity_name,
    identity_profile,
    lineage_columns_by_name,
    lineage_edge,
    lineage_edges_between,
    lineage_edges_from_job_inputs,
    lineage_source_engine,
    lineage_target_engine,
    normalize_source_object_inventory,
    parse_count_value,
    parse_optional_integer,
    quality_summary_from_spark_result,
    schema_column_included,
    schema_from_job,
    source_lineage_schema,
    spark_materialization_mode,
    spark_output_sample_rows,
    spark_result_schema,
    spark_source_window_metadata,
)
from app.application.etl_pipeline_policy import (
    apply_compiled_rules,
    apply_update_request,
    canonical_rule_fingerprint,
    compile_job_rules,
    compile_pipeline_rules,
    continuous_checkpoint_initialized,
    continuous_processing_contract_changed,
    next_scheduled_run_utc,
    require_compiled_rules,
    should_run_scheduled_job,
    target_contract_issue,
    target_identity_changed,
    trino_query_run_belongs_to_actor,
    trino_sql_job_permission_roles,
    trino_sql_job_permission_summary,
    validate_create_request,
    validate_requested_permission_grants,
    validate_target_contract,
    validate_update_request,
)
from app.application.etl_run_projection import (
    airflow_run_has_materialization,
    airflow_submission_error_is_definitive,
    apply_airflow_result_to_reserved_run,
    apply_airflow_submit_job_state,
    apply_job_state_from_latest_run,
    apply_kafka_result_to_reserved_run,
    apply_kafka_run_reservation_job_state,
    bind_kafka_result_to_reservation,
    dag_steps_from_airflow_submit,
    dag_steps_from_airflow_sync,
    finalize_job_from_kafka_result,
    finalize_job_from_spark_result,
    first_problem_task,
    kafka_run_reservation,
    mark_airflow_catalog_reconciliation_failure,
    mark_airflow_submission_unknown,
    mark_airflow_success_without_catalog_reconciliation,
    record_airflow_sync_error,
    repair_incomplete_airflow_successes,
    run_from_airflow_submit,
    run_from_kafka_result,
    run_from_spark_result,
    spark_error_summary,
    spark_failed_stage,
    task_state_snapshot,
    task_title,
)
from app.application.etl_runtime_support import (
    compact_storage_text,
    dag_step,
    is_kafka_job,
    writer_mode_for_pipeline,
)
from app.application.etl_source_window import (
    build_source_s3_client,
    head_s3_object_identity,
    incremental_object_key_limit,
    listed_s3_object_identity,
    normalize_s3_etag,
    normalize_s3_version_id,
    object_last_modified,
    object_last_modified_iso,
    parse_incremental_timestamp,
    pin_listed_s3_object_identity,
    s3_object_size,
    source_identity_worker_count,
    source_object_identity_changed_error,
    source_object_identity_mismatch_fields,
    source_uses_incremental_folder_window,
)
from app.application.source_connectors import (
    list_source_assets as execute_list_source_assets,
    test_source_connector as execute_test_source_connector,
)
from app.core.config import settings
from app.core.errors import ApiError
from app.core.materialization import (
    SOURCE_WINDOW_CONTRACT_VERSION,
    SUPPORTED_SOURCE_WINDOW_CONTRACT_VERSIONS,
    active_materialization_runs,
    has_bounded_source_window,
    materialization_source_window,
)
from app.core.permission_metadata import normalize_actions, permission_grants_from_roles, resource_permissions
from app.core.s3_policy import resolve_s3_source_location, s3_source_config_fields, validate_s3_source_config
from app.domain.continuous_runtime import (
    ContinuousErrorStage,
    clear_runtime_error,
    derive_public_status,
    observation_is_current,
    observed_state_from_evidence,
    record_runtime_error,
    record_runtime_observation,
    runtime_contract_projection,
)
from app.domain.dataset_identity import catalog_relation_metadata
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
from app.models.base import Base
from app.models.identity import AuthUserModel
from app.infrastructure.runtime_io import (
    Boto3ObjectManifestAdapter,
    CallableKafkaRuntimeGateway,
    JsonFileRuntimeDocumentStore,
    SubprocessNodeBridge,
)
from app.infrastructure.source_connectors import NodeSourceConnectorGateway
from app.ports.runtime_io import (
    AirflowGateway,
    JsonDocument,
    NodeBridgePort,
    ObjectManifestPort,
    RuntimeDocumentStore,
)
from app.repositories.audit_repository import add_audit_event, safe_record_audit_event
from app.repositories import etl_repository, snapshot_status_repository
from app.repositories.catalog_repository import CatalogRepository
from app.repositories.governance_repository import blocked_principal_for_actor, locked_resource_ids
from app.repositories.dashboard_live_repository import (
    REPLAY_COMMIT_KIND,
    STREAM_COMMIT_KIND,
    DashboardLiveRepository,
    backfill_catalog_revision,
    normalize_kafka_source_ranges,
    recommended_dashboard_poll_ms,
    save_catalog_dataset_and_revision,
)
from app.repositories.sql_repository import SqlRepository
from app.repositories.permission_repository import (
    UI_MANAGED_SOURCES,
    ensure_legacy_permission_grants,
    list_permission_grants_by_resource,
    replace_permission_ui_grants,
)
from app.schemas.common import ErrorCode
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
from app.schemas.job_status import JobStatusListResponse
from app.schemas.iceberg import IcebergWriterTarget
from app.schemas.permissions import PermissionGrant
from app.services.etl import (
    api_job_operations as _etl_api_job_operations,
    api_review_operations as _etl_api_review_operations,
    snapshot_operations as _etl_snapshot_operations,
    airflow_operations as _etl_airflow_operations,
    source_runtime as _etl_source_runtime,
    continuous_maintenance as _etl_continuous_maintenance,
    continuous_session as _etl_continuous_session,
    continuous_publication as _etl_continuous_publication,
    replay_schedule as _etl_replay_schedule,
)
from app.services.etl.runtime_binding import bind_runtime
from app.services.airflow_client import AirflowDagRun, AirflowTaskInstance, build_airflow_client
from app.services.auth_service import load_active_actor_by_user_id
from app.services.governance_enforcement import require_governed_access
from app.services.trino_materialization_service import materialized_dataset_id
from app.services.trino_query_run_service import TrinoQueryRunService
from app.services.trino_sql_job_service import TrinoSqlJobService
from app.services.iceberg_writer_service import (
    IcebergWriterError,
    IcebergWriterService,
    build_iceberg_writer_target,
    writer_mode_for_source,
)
from app.services.object_storage import object_storage_runtime
from app.services.materialization_projection import (
    aggregate_materialization_runs,
    upsert_materialization_run,
)
from app.services.rule_compiler import CompiledRuleSet, compile_rule_set
from app.services.resource_permission_service import (
    merge_permission_grants,
    permission_grants_for_resource,
    permissions_for_actor_with_governance,
    permissions_for_actor_with_governance_state,
)

BACKEND_DIR = Path(__file__).resolve().parents[2]
SCRIPTS_DIR = BACKEND_DIR / "scripts"
ACTIVE_RUN_STATUSES = {"queued", "running"}
TERMINAL_RUN_STATUSES = {"success", "failed", "canceled"}
SPARK_OUTPUT_FORMAT = "parquet"
PERMISSION_REVIEW_ACTION_LABELS = {
    "view": "조회",
    "query": "쿼리 실행",
    "run": "실행",
    "manage": "관리",
    "share": "공유",
    "delete": "삭제",
}
PERMISSION_GROUP_ACTIONS = {
    "analytics": ["view", "query"],
    "data-platform": ["view", "run", "manage"],
    "ops": ["view", "run"],
}
DEFAULT_SOURCE_IDENTITY_WORKERS = 16
MAX_SOURCE_IDENTITY_WORKERS = 64
DEFAULT_SPARK_EXECUTION_LEASE_SECONDS = 1200
AIRFLOW_MISSING_RUN_FAILURE_LIMIT = 3
SPARK_REST_BRIDGE_GRACE_SECONDS = 30


def configured_spark_output_bucket() -> str:
    configured_bucket = str(os.environ.get("ASKLAKE_SPARK_OUTPUT_BUCKET") or "asklake-output").strip()
    if (
        "replace-with-" in configured_bucket.casefold()
        or re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", configured_bucket) is None
        or ".." in configured_bucket
    ):
        raise ValueError("ASKLAKE_SPARK_OUTPUT_BUCKET is invalid or still contains a deployment placeholder")
    return configured_bucket


def create_trino_sql_job(
    db: Session,
    request: CreateTrinoSqlJobRequest,
    actor: ActorContext,
) -> CreatePipelineResponse:
    if not settings.trino_enabled:
        raise ApiError(
            ErrorCode.CONFLICT,
            "Trino query runtime is not enabled",
            status.HTTP_409_CONFLICT,
            {"setting": "TRINO_ENABLED"},
        )

    sql_repository = SqlRepository(db)
    query_service = TrinoQueryRunService(sql_repository, CatalogRepository(db))
    source_run = query_service.get(request.source_run_id, actor)
    source_payload = sql_repository.get_run_payload(request.source_run_id) or {}
    if not actor.is_admin and not trino_query_run_belongs_to_actor(source_payload, actor):
        safe_record_audit_event(
            db,
            action="trino_sql_job.create.forbidden",
            actor=actor,
            api_path="/api/etl/sql-jobs",
            http_method="POST",
            metadata={"reason": "source_run_owner_mismatch"},
            result="forbidden",
            status_code=status.HTTP_403_FORBIDDEN,
            target_id=request.source_run_id,
            target_name=request.source_run_id,
            target_type="query_run",
        )
        raise ApiError(
            ErrorCode.FORBIDDEN,
            "Only the source Query Run submitter or an admin can create this SQL Job",
            status.HTTP_403_FORBIDDEN,
            {"runId": request.source_run_id},
        )
    if source_run.status != "succeeded":
        raise ApiError(
            ErrorCode.INVALID_JOB_STATE,
            "Only succeeded Trino query runs can create a SQL Job",
            status.HTTP_409_CONFLICT,
            {"runId": source_run.run_id, "status": source_run.status},
        )
    if (
        request.base_dataset_id != source_run.base_dataset_id
        or request.query.strip() != source_run.query.strip()
        or set(request.reference_dataset_ids) != set(source_run.reference_dataset_ids)
    ):
        raise ApiError(
            ErrorCode.VALIDATION_ERROR,
            "SQL Job recipe does not match the source Query Run",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )

    dataset_name = request.dataset.name.strip()
    if not dataset_name:
        raise ApiError(ErrorCode.VALIDATION_ERROR, "Dataset name is required", status.HTTP_422_UNPROCESSABLE_ENTITY)
    dataset_id = materialized_dataset_id(dataset_name)
    catalog_repository = CatalogRepository(db)
    existing_dataset = catalog_repository.get_dataset_payload(dataset_id) or catalog_repository.get_dataset_payload_by_name(dataset_name)
    existing_job = etl_repository.get_job_by_dataset_id(db, dataset_id) or etl_repository.get_job_by_target(db, dataset_name)
    if existing_dataset is not None or existing_job is not None:
        raise ApiError(
            ErrorCode.CONFLICT,
            "A Dataset or Job with this target name already exists",
            status.HTTP_409_CONFLICT,
            {"datasetId": dataset_id, "datasetName": dataset_name},
        )

    schedule_label = trino_sql_job_schedule_label(request)
    next_run_utc = trino_sql_job_next_run_utc(request)
    job_name = (request.job_name or f"{dataset_name} SQL Job").strip()
    job_id = make_job_id(f"sql-{job_name}-{dataset_id}")
    columns = list(source_run.result.columns if source_run.result else [])
    if request.target.partition_column and request.target.partition_column not in columns:
        raise ApiError(
            ErrorCode.VALIDATION_ERROR,
            "SQL Job partition column must exist in the Query Run result",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            {"partitionColumn": request.target.partition_column, "columns": columns},
        )
    schema_columns = [
        {
            "confidence": 1,
            "included": True,
            "nullable": True,
            "role": "primary" if index == 0 else "derived",
            "sourceName": column,
            "targetName": column,
            "type": "unknown",
        }
        for index, column in enumerate(columns)
    ]
    permission_roles = trino_sql_job_permission_roles(
        request.governance.access_scope,
        request.governance.owner,
        request.governance.principal_id,
    )
    permission_summary = trino_sql_job_permission_summary(
        request.governance.access_scope,
        request.governance.owner,
        request.governance.principal_id,
    )
    sql_recipe = {
        "baseDatasetId": request.base_dataset_id,
        "query": request.query,
        "referenceDatasetIds": request.reference_dataset_ids,
        "runAsUserId": actor.id,
        "sourceRunId": request.source_run_id,
        "target": {
            "datasetId": dataset_id,
            "datasetName": dataset_name,
            "description": request.dataset.description,
            "layer": request.dataset.layer,
            "partitionColumns": [request.target.partition_column] if request.target.partition_column else [],
            "tags": request.dataset.tags,
        },
        "writeMode": request.target.write_mode,
    }
    dag_steps = [
        {"id": "validate", "title": "1. SQL recipe 검증", "meta": "Trino SQL · full refresh", "status": "pending"},
        {"id": "materialize", "title": "2. Iceberg table 생성", "meta": "versioned CTAS", "status": "pending"},
        {"id": "register", "title": "3. Catalog mapping 교체", "meta": "DESCRIBE 검증 후 공개", "status": "pending"},
    ]
    job = ETLJobModel(
        id=job_id,
        name=job_name,
        owner=request.governance.owner.strip() or actor.name,
        created_by=actor.name,
        created_by_profile=identity_profile(actor.name),
        status="scheduled",
        tag="[SQL]",
        source=f"Trino SQL / {source_run.run_id}",
        target=dataset_name,
        schedule=schedule_label,
        schedule_policy={
            "mode": request.schedule.mode,
            "nextRunUtc": next_run_utc,
            "overlapPolicy": request.schedule.overlap_policy,
            "time": request.schedule.time,
            "timezone": request.schedule.timezone,
            "weekday": request.schedule.weekday,
            "writeMode": request.target.write_mode,
        },
        schedule_summary=trino_sql_job_schedule_summary(request),
        retry_policy=None,
        retry_policy_summary="Trino collector 재시도 정책",
        run_limit_summary="동시 실행 1개",
        source_config=[
            ["Base Dataset ID", request.base_dataset_id],
            ["Reference Dataset IDs", ", ".join(request.reference_dataset_ids) or "-"],
            ["Source Query Run ID", request.source_run_id],
        ],
        source_label=f"{source_run.base_dataset_id} / {source_run.run_id}",
        source_type="Trino SQL",
        job_kind="trino_sql_materialization",
        sql_recipe=sql_recipe,
        execution_mode="snapshot",
        continuous_config=None,
        schema_columns=schema_columns,
        schema_fingerprint=f"{source_run.run_id}:{'|'.join(columns)}",
        schema_sample_rows=[],
        schema_summary=f"{len(columns)}개 컬럼 · Trino Query Run 검증 완료",
        rule_summary="저장된 SQL recipe를 생성 시점 데이터에 다시 실행",
        permission_summary=permission_summary,
        permission_roles=permission_roles,
        storage_type="Iceberg",
        partition=request.target.partition_column,
        partition_columns=[request.target.partition_column] if request.target.partition_column else [],
        index_columns=[],
        compression="Snappy",
        storage_path=f"iceberg://{settings.trino_catalog}/{settings.trino_schema}/{dataset_id}",
        target_description=request.dataset.description,
        target_database=settings.trino_schema,
        target_tags=request.dataset.tags,
        target_format="Iceberg",
        target_layer=request.dataset.layer,
        target_path=None,
        rag=False,
        transform_output_columns=[[column, "unknown"] for column in columns],
        transform_steps=[],
        quality_invalid_rows=[],
        quality_rules=[],
        quality_score=None,
        quality_status="idle",
        last_run="생성 후 미실행",
        last_state="Trino SQL recipe 저장 완료",
        next_run=next_run_utc or "-",
        progress=None,
        stats={
            "averageDuration": "-",
            "currentStage": "실행 대기",
            "inputRows": "-",
            "lastSuccess": "-",
            "outputRows": "-",
            "sampleScope": "전체 SQL",
            "schemaColumns": f"{len(columns)}개",
            "sourceUnits": f"{1 + len(request.reference_dataset_ids)} datasets",
            "successRate": "-",
            "totalRuns": "0회",
        },
        dag_steps=dag_steps,
        dag_steps_by_run_id={},
        dataset_id=dataset_id,
    )
    saved_job = etl_repository.create_job(db, job)
    safe_record_audit_event(
        db,
        action="trino_sql_job.create",
        actor=actor,
        api_path="/api/etl/sql-jobs",
        http_method="POST",
        metadata={"baseDatasetId": request.base_dataset_id, "sourceRunId": request.source_run_id},
        target_id=job.id,
        target_name=job.name,
        target_type="etl_job",
    )
    return CreatePipelineResponse(
        catalog_target={
            "id": dataset_id,
            "layer": request.dataset.layer,
            "name": dataset_name,
            "status": "pending_run",
        },
        job=saved_job,
    )


def sync_active_kafka_continuous_runtimes() -> None:
    """Persist continuous worker progress without depending on UI polling."""
    import logging

    from app.core.database import SessionLocal

    active_statuses = {"starting", "running", "pausing", "stopping"}
    terminal_statuses = {"paused", "stopped", "failed"}
    with SessionLocal() as db:
        try:
            reconcile_stale_continuous_maintenance_runs(db)
        except Exception:
            db.rollback()
            logging.getLogger(__name__).exception(
                "Kafka continuous maintenance reconciliation failed before runtime synchronization"
            )
        job_ids = [
            job.id
            for job in etl_repository.list_job_models(db)
            if job.execution_mode == "continuous"
        ]
    for job_id in job_ids:
        with SessionLocal() as db:
            try:
                job = etl_repository.get_job(db, job_id)
                if job is None or job.execution_mode != "continuous":
                    continue
                runtime = etl_repository.get_kafka_continuous_runtime(db, job.id)
                recovery_state = (runtime.metrics or {}).get("publicationRecoveryPending") if runtime is not None else None
                terminal_recovery_due = (
                    runtime is not None
                    and runtime.status in terminal_statuses
                    and recovery_state is not False
                )
                if runtime is not None and (
                    runtime.status in active_statuses
                    or terminal_recovery_due
                    or recovery_state is True
                    or continuous_report_has_unacknowledged_publication(job.id, runtime)
                    or has_pending_continuous_replay_catalog(db, job.id)
                ):
                    refresh_kafka_continuous_runtime(db, job)
            except Exception:
                db.rollback()
                logging.getLogger(__name__).exception(
                    "Kafka continuous runtime synchronization failed for job_id=%s",
                    job_id,
                )


def command_job(
    db: Session,
    job_id: str,
    command: str,
    actor: ActorContext | None = None,
    *,
    execution_actor: ActorContext | None = None,
) -> JobCommandResponse:
    continuous_commands = {"startContinuous", "pauseContinuous", "resumeContinuous", "stopContinuous"}
    if command not in {"run", "retry", "pause", "cancelRun", "stopSchedule", "resumeSchedule", *continuous_commands}:
        raise ApiError(ErrorCode.VALIDATION_ERROR, f"Unsupported job command: {command}", status.HTTP_400_BAD_REQUEST)
    job = (
        etl_repository.get_job_for_update(db, job_id)
        if command in {"run", "retry", "startContinuous", "resumeContinuous"}
        else etl_repository.get_job(db, job_id)
    )
    if job is None:
        raise ApiError(ErrorCode.NOT_FOUND, f"Job not found: {job_id}", status.HTTP_404_NOT_FOUND)

    actor_context = actor or ActorContext()
    required_action = "run" if command in {"run", "retry", "startContinuous", "resumeContinuous"} else "manage"
    require_governed_access(
        db,
        actor_context,
        action=required_action,
        api_path=f"/api/etl/jobs/{job_id}/commands",
        http_method="POST",
        metadata={"command": command, "owner": job.owner},
        resource_id=job.id,
        resource_name=job.name,
        resource_type="etl_job",
    )
    try:
        require_permission(
            actor_context,
            required_action,
            owner=job.owner,
            grants=permission_grants_for_etl_job(db, job),
            resource_label="job",
        )
    except ApiError as exc:
        safe_record_audit_event(
            db,
            action="etl_job.command.forbidden",
            actor=actor_context,
            api_path=f"/api/etl/jobs/{job_id}/commands",
            http_method="POST",
            metadata={"command": command, "requiredAction": required_action, "owner": job.owner},
            result="forbidden",
            status_code=exc.status_code,
            target_id=job.id,
            target_name=job.name,
            target_type="etl_job",
        )
        raise
    if job.execution_mode == "continuous" and command not in continuous_commands:
        raise ApiError(
            ErrorCode.INVALID_JOB_STATE,
            "Continuous Jobs accept only continuous lifecycle commands.",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    if command in continuous_commands:
        return command_kafka_continuous_job(db, job, command, actor_context)
    plan = plan_snapshot_command(
        command=command,
        execution_mode=job.execution_mode or "snapshot",
        has_active_schedule=has_scheduled_execution(job),
        has_schedule_label=has_scheduled_label(job.schedule),
        job_id=job.id,
        job_kind=job.job_kind,
        status=job.status,
    )
    if isinstance(plan, SnapshotCommandViolation):
        raise ApiError(
            plan.code,
            plan.message,
            plan.http_status,
        )

    if plan.execution_path == SnapshotExecutionPath.TRINO:
        service = TrinoSqlJobService(SqlRepository(db), CatalogRepository(db))
        result = (
            service.cancel(job, execution_actor or actor_context)
            if command == "cancelRun"
            else service.submit(job, command, execution_actor or actor_context)
        )
        return JobCommandResponse(
            action={
                "cancelRun": "etl.run.cancel_requested",
                "retry": "etl.run.retry_requested",
                "run": "etl.run.requested",
            }[command],
            api_path=f"/api/etl/jobs/{job_id}/commands",
            dataset=result.dataset,
            job=with_job_permissions(db, result.job, actor_context),
            run=result.run,
            dag_steps=result.job.dag_steps,
            processing_result={
                "engine": "trino",
                "jobKind": "trino_sql_materialization",
                "writeMode": "full_refresh",
            },
        )

    run_schema = None
    dataset_schema = None
    run_model = None
    dataset_model = None
    if plan.execution_path == SnapshotExecutionPath.RUN:
        if is_kafka_job(job):
            run_id = stable_id("run", f"{job.id}:{command}:kafka:{iso_now()}")
            kafka_request = kafka_ingest_request_from_job(job, run_id)
            run_model = kafka_run_reservation(job, run_id)
            apply_kafka_run_reservation_job_state(job, command, run_model)
            etl_repository.save_command_result(db, job, run_model)
            try:
                result = bind_kafka_result_to_reservation(
                    run_kafka_ingest_request(db, kafka_request, command, job.id),
                    run_id,
                )
            except ApiError as exc:
                bridge_error = exc.details.get("bridge") if isinstance(exc.details, dict) else None
                result = kafka_failure_result(kafka_request, run_id, exc, bridge_error if isinstance(bridge_error, dict) else {})
            except Exception as exc:
                internal_error = ApiError(
                    ErrorCode.INTERNAL_ERROR,
                    "Kafka ingest failed unexpectedly",
                    status.HTTP_500_INTERNAL_SERVER_ERROR,
                    {"reason": compact_storage_text(exc, limit=1000)},
                )
                result = kafka_failure_result(kafka_request, run_id, internal_error, {})
            result["runId"] = run_id
            job = etl_repository.get_job_for_update(db, job_id)
            if job is None:
                raise ApiError(ErrorCode.NOT_FOUND, f"Job not found after Kafka ingest: {job_id}", status.HTTP_404_NOT_FOUND)
            reserved_run = etl_repository.get_run_model(db, run_id)
            if reserved_run is None or reserved_run.job_id != job.id:
                raise ApiError(
                    ErrorCode.INVALID_JOB_STATE,
                    "Kafka run reservation was not found during finalization",
                    status.HTTP_409_CONFLICT,
                    {"jobId": job.id, "runId": run_id},
                )
            etl_repository.refresh_run_for_update(db, reserved_run)
            apply_kafka_result_to_reserved_run(reserved_run, run_from_kafka_result(job, result))
            run_model = reserved_run
            run_schema = etl_repository.run_to_schema(run_model)
            finalize_job_from_kafka_result(job, command, result)
            job.dag_steps = dag_steps_from_kafka_result(job, command, run_schema.model_dump(by_alias=True), result)
        else:
            airflow_client = build_airflow_client()
            run_model = airflow_run_reservation(job, command, airflow_client)
            run_schema = etl_repository.run_to_schema(run_model)
            apply_airflow_submit_job_state(job, command, run_model)
            job.dag_steps = dag_steps_from_airflow_submit(job, command, run_schema.model_dump(by_alias=True))
            job.dag_steps_by_run_id = {**(job.dag_steps_by_run_id or {}), run_schema.run_id: job.dag_steps}
            job.stats = stats_from_runs(job, [
                run_schema,
                *[
                    previous_run
                    for previous_run in etl_repository.list_runs_for_job(db, job.id)
                    if previous_run.run_id != run_schema.run_id
                ],
            ])
            etl_repository.save_command_result(db, job, run_model)

            submitted_run, submission_error = submit_or_reconcile_airflow_job_run(
                job,
                command,
                run_model,
                airflow_client,
            )
            job = etl_repository.get_job_for_update(db, job_id)
            if job is None:
                raise ApiError(ErrorCode.NOT_FOUND, f"Job not found after Airflow submission: {job_id}", status.HTTP_404_NOT_FOUND)
            reserved_run = etl_repository.get_run_model(db, run_model.run_id)
            if reserved_run is None or reserved_run.job_id != job.id:
                raise ApiError(
                    ErrorCode.INVALID_JOB_STATE,
                    "Airflow run reservation was not found during finalization",
                    status.HTTP_409_CONFLICT,
                    {"jobId": job.id, "runId": run_model.run_id},
                )
            etl_repository.refresh_run_for_update(db, reserved_run)
            if submitted_run is not None:
                apply_airflow_result_to_reserved_run(reserved_run, submitted_run)
            else:
                mark_airflow_submission_unknown(reserved_run, submission_error)
            run_model = reserved_run
            run_schema = etl_repository.run_to_schema(run_model)
            apply_airflow_submit_job_state(job, command, run_model)
            job.dag_steps = dag_steps_from_airflow_submit(job, command, run_schema.model_dump(by_alias=True))
        job.dag_steps_by_run_id = {**(job.dag_steps_by_run_id or {}), run_schema.run_id: job.dag_steps}
        job.stats = stats_from_runs(job, [
            run_schema,
            *[
                previous_run
                for previous_run in etl_repository.list_runs_for_job(db, job.id)
                if previous_run.run_id != run_schema.run_id
            ],
        ])
    elif plan.execution_path == SnapshotExecutionPath.CANCEL:
        run_model = run_from_command(job, command)
        run_schema = etl_repository.run_to_schema(run_model)
        apply_job_command(job, command)
        job.dag_steps = dag_steps_from_command(job, command, run_schema.model_dump(by_alias=True))
        job.dag_steps_by_run_id = {**(job.dag_steps_by_run_id or {}), run_schema.run_id: job.dag_steps}
        job.stats = stats_from_runs(job, [run_schema, *etl_repository.list_runs_for_job(db, job.id)])
    else:
        apply_job_command(job, command)

    saved_job, persisted_run, dataset_schema = etl_repository.save_command_result(db, job, run_model, dataset_model)
    run_schema = persisted_run or run_schema
    if dataset_schema is None and job.dataset_id:
        dataset_schema = etl_repository.get_dataset_schema_by_id(db, job.dataset_id)

    return JobCommandResponse(
        action=plan.action,
        api_path=f"/api/etl/jobs/{job_id}/commands",
        dataset=dataset_schema,
        job=with_job_permissions(db, saved_job, actor or ActorContext()),
        run=run_schema,
        dag_steps=[JobDagStep(**step) for step in job.dag_steps] if job.dag_steps else None,
    )


def kafka_ingest_request_from_job(job: ETLJobModel, run_id: str) -> dict[str, Any]:
    compiled_rules = compile_job_rules(job)
    require_compiled_rules(compiled_rules)
    validate_target_contract(
        source_type=job.source_type or "",
        execution_mode=job.execution_mode or "snapshot",
        target_layer=job.target_layer or "BRONZE",
        target_format=job.target_format or "jsonl",
    )
    fields = job.source_config or []
    topic = (
        field_value(fields, "TOPIC / QUEUE NAME")
        or field_value(fields, "Topic")
        or field_value(fields, "topic")
        or "reviews.raw"
    )
    target = parse_kafka_target_path(job.storage_path or job.target_path, job.target, job.target_layer)
    max_messages = (
        parse_positive_integer(field_value(fields, "Batch Max Messages (per partition)"))
        or parse_positive_integer(field_value(fields, "Batch Max Messages"))
        or parse_positive_integer(field_value(fields, "Max Messages"))
        or parse_positive_integer(field_value(fields, "__Batch Max Messages"))
        or 100
    )
    timeout_ms = (
        parse_positive_integer(field_value(fields, "Timeout Ms"))
        or parse_positive_integer(field_value(fields, "Timeout Milliseconds"))
        or 10000
    )
    consumer_group_id = (
        field_value(fields, "CONSUMER GROUP ID")
        or field_value(fields, "Consumer Group ID")
        or f"asklake-{normalize_column_name(job.id)}"
    )
    offset_policy = kafka_offset_policy(field_value(fields, "Offset Policy") or field_value(fields, "offsetPolicy"))
    if not job.iceberg_target:
        dataset_id = str(job.dataset_id or make_dataset_id(job.target))
        job.dataset_id = dataset_id
        job.iceberg_target = build_iceberg_writer_target(
            job.target,
            dataset_id,
            write_mode="append",
            partition_columns=normalize_string_list(job.partition_columns),
        ).model_dump(mode="json", by_alias=True)
    canonical_rules = [
        rule.model_dump(mode="json", by_alias=True)
        for rule in compiled_rules.result.rules
    ]
    return {
        "allowEmpty": True,
        "broker": field_value(fields, "Broker / Endpoint") or field_value(fields, "Broker") or os.environ.get("ASKLAKE_KAFKA_BROKER") or "127.0.0.1:19092",
        "consumerGroupId": consumer_group_id,
        "deferOffsetCommit": True,
        "datasetId": job.dataset_id or make_dataset_id(job.target),
        "datasetName": job.target or "reviews_raw",
        "icebergTarget": job.iceberg_target,
        "jobId": job.id,
        "landingBucket": target["bucket"],
        "landingEndpoint": (
            field_value(fields, "Landing Endpoint URL")
            or field_value(fields, "Target Endpoint URL")
            or object_storage_runtime().endpoint
            or ""
        ),
        "landingPrefix": target["prefix"],
        "maxMessages": max_messages,
        "offsetPolicy": offset_policy,
        "registerCatalog": False,
        "schemaColumns": [
            SchemaColumnDraft.model_validate(column).model_dump(mode="json", by_alias=True)
            for column in (job.schema_columns or [])
        ],
        "outputSchema": [list(column) for column in compiled_rules.result.output_schema],
        "ruleContractVersion": compiled_rules.result.contract_version,
        "ruleFingerprint": canonical_rule_fingerprint(
            compiled_rules.result.contract_version,
            canonical_rules,
        ),
        "rules": [
            rule
            for rule in canonical_rules
        ],
        "runId": run_id,
        "schemaFingerprint": job.schema_fingerprint,
        "storageMode": target["storageMode"],
        "targetBucket": target["bucket"],
        "targetDescription": job.target_description or None,
        "targetFormat": job.target_format or "jsonl",
        "targetLayer": job.target_layer or "BRONZE",
        "targetPrefix": target["prefix"],
        "timeoutMs": timeout_ms,
        "topic": topic,
        "transformSteps": [
            step.model_dump(mode="json", by_alias=True)
            for step in compiled_rules.transform_steps
        ],
        "qualityRules": [
            rule.model_dump(mode="json", by_alias=True)
            for rule in compiled_rules.quality_rules
        ],
    }


def verify_spark_iceberg_result(
    job: ETLJobModel,
    run_id: str,
    result: dict[str, Any],
    *,
    expected_run_row_count: int | None = None,
    writer_service: IcebergWriterService | None = None,
) -> dict[str, Any]:
    try:
        target = IcebergWriterTarget.model_validate(job.iceberg_target)
    except Exception as exc:
        raise catalog_reconciliation_error(
            "Persisted Job does not have a valid Iceberg target.",
            {"jobId": job.id, "runId": run_id},
        ) from exc
    commit = result.get("icebergCommit")
    if not isinstance(commit, dict):
        raise catalog_reconciliation_error(
            "Successful Spark result does not include Iceberg commit evidence.",
            {"jobId": job.id, "runId": run_id, "target": target.table_uri},
        )
    if str(commit.get("jobId") or "") != job.id or str(commit.get("runId") or "") != run_id:
        raise catalog_reconciliation_error(
            "Spark Iceberg commit identity does not match the persisted Run.",
            {
                "commitJobId": commit.get("jobId"),
                "commitRunId": commit.get("runId"),
                "jobId": job.id,
                "runId": run_id,
            },
        )
    try:
        committed_target = IcebergWriterTarget.model_validate(commit.get("target"))
    except Exception as exc:
        raise catalog_reconciliation_error(
            "Spark Iceberg commit target is invalid.",
            {"jobId": job.id, "runId": run_id},
        ) from exc
    if committed_target != target or str(result.get("outputPath") or "") != target.table_uri:
        raise catalog_reconciliation_error(
            "Spark Iceberg commit target does not match the persisted Job target.",
            {
                "commitTarget": committed_target.table_uri,
                "expectedTarget": target.table_uri,
                "outputPath": result.get("outputPath"),
            },
        )
    snapshot_id = str(commit.get("snapshotId") or "").strip()
    if not snapshot_id:
        raise catalog_reconciliation_error(
            "Spark Iceberg commit does not include snapshotId.",
            {"jobId": job.id, "runId": run_id},
        )
    expected_schema_fingerprint = str(job.schema_fingerprint or "").strip()
    committed_schema_fingerprint = str(commit.get("schemaFingerprint") or "").strip()
    if expected_schema_fingerprint and committed_schema_fingerprint != expected_schema_fingerprint:
        raise catalog_reconciliation_error(
            "Spark Iceberg schema fingerprint does not match the persisted Job.",
            {"jobId": job.id, "runId": run_id},
        )
    compiled_rules = compile_job_rules(job)
    require_compiled_rules(compiled_rules)
    canonical_rules = [
        rule.model_dump(mode="json", by_alias=True)
        for rule in compiled_rules.result.rules
    ]
    expected_rule_fingerprint = canonical_rule_fingerprint(
        compiled_rules.result.contract_version,
        canonical_rules,
    )
    if str(commit.get("ruleFingerprint") or "") != expected_rule_fingerprint:
        raise catalog_reconciliation_error(
            "Spark Iceberg rule fingerprint does not match the persisted Job.",
            {"jobId": job.id, "runId": run_id},
        )
    service = writer_service or IcebergWriterService()
    try:
        evidence = service.verify_commit(
            target,
            created_table=commit.get("createdTable") is True,
            job_id=job.id,
            run_id=run_id,
            expected_snapshot_id=snapshot_id,
            schema_fingerprint=committed_schema_fingerprint or None,
            rule_fingerprint=expected_rule_fingerprint,
            source_boundary=commit.get("sourceBoundary") if isinstance(commit.get("sourceBoundary"), dict) else {},
        )
        if expected_run_row_count is not None:
            service.verify_snapshot_run_row_count(
                target,
                snapshot_id=evidence.snapshot_id,
                run_id=run_id,
                expected_row_count=expected_run_row_count,
            )
        data_file_count, storage_size_bytes = service.table_storage_metrics(
            target,
            snapshot_id=snapshot_id,
        )
    except IcebergWriterError as exc:
        if expected_run_row_count is not None:
            raise ApiError(
                exc.code,
                "Iceberg run rows could not be verified through Trino.",
                status.HTTP_502_BAD_GATEWAY,
                {
                    "jobId": job.id,
                    "runId": run_id,
                    "snapshotId": snapshot_id,
                    "target": target.table_uri,
                },
            ) from exc
        raise catalog_reconciliation_error(
            "Iceberg commit could not be verified through Trino.",
            {
                "jobId": job.id,
                "reason": exc.code,
                "runId": run_id,
                "snapshotId": snapshot_id,
                "target": target.table_uri,
            },
        ) from exc
    if parse_count_value(result.get("outputRows")) > 0 and (
        data_file_count <= 0 or storage_size_bytes <= 0
    ):
        raise catalog_reconciliation_error(
            "Iceberg commit does not expose physical data-file evidence.",
            {
                "dataFileCount": data_file_count,
                "jobId": job.id,
                "runId": run_id,
                "snapshotId": snapshot_id,
                "storageSizeBytes": storage_size_bytes,
            },
        )
    verified = evidence.model_dump(mode="json", by_alias=True)
    return {
        **result,
        "dataFileCount": data_file_count,
        "icebergCommit": verified,
        "materializationOutputPath": evidence.warehouse_location,
        "queryEngineTable": evidence.query_engine_table.model_dump(mode="json", by_alias=True),
        "queryEngineVerified": True,
        "ruleFingerprint": evidence.rule_fingerprint,
        "schemaFingerprint": evidence.schema_fingerprint,
        "storageSizeBytes": storage_size_bytes,
        "warehouseLocation": evidence.warehouse_location,
    }


def list_incremental_s3_object_inventory(
    job: ETLJobModel,
    *,
    incremental_since: str | None,
    incremental_before: str | None,
    s3_client: Any | None = None,
) -> list[dict[str, Any]]:
    validate_s3_source_config(
        job.source_type,
        job.source_config or [],
        allow_unconfigured=allows_unconfigured_s3_source(),
    )
    fields = s3_source_config_fields(job.source_config or [])
    bucket, prefix = resolve_s3_source_location(job.source_type, fields)
    if not bucket:
        raise ApiError(
            ErrorCode.VALIDATION_ERROR,
            "Incremental folder collection requires an S3 bucket or s3:// path",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    upper_bound = parse_incremental_timestamp(incremental_before, "incrementalBefore")
    if upper_bound is None:
        raise ApiError(
            ErrorCode.INVALID_JOB_STATE,
            "Incremental folder collection requires a fixed upper-bound timestamp",
            status.HTTP_409_CONFLICT,
        )
    lower_bound = parse_incremental_timestamp(incremental_since, "incrementalSince")
    file_pattern = fields.get("file pattern", "").strip()
    recursive = fields.get("recursive", "").casefold() in {"true", "1", "yes", "on"}
    listing_prefix = prefix
    if listing_prefix and not listing_prefix.endswith("/"):
        listing_prefix = f"{listing_prefix}/"
    object_limit = incremental_object_key_limit()
    client = s3_client or build_source_s3_client(job)
    continuation_token = None
    listed_inventory: dict[str, dict[str, Any]] = {}
    while True:
        request: dict[str, Any] = {"Bucket": bucket, "Prefix": listing_prefix}
        if not recursive:
            request["Delimiter"] = "/"
        if continuation_token:
            request["ContinuationToken"] = continuation_token
        try:
            response = client.list_objects_v2(**request)
        except Exception as exc:
            raise ApiError(
                "SERVICE_UNAVAILABLE",
                "Incremental source object inventory is unavailable",
                status.HTTP_503_SERVICE_UNAVAILABLE,
                {
                    "bucket": bucket,
                    "prefix": listing_prefix,
                    "reason": compact_storage_text(exc, limit=1000),
                },
            ) from exc
        for item in response.get("Contents") or []:
            key = str(item.get("Key") or "")
            modified_at = object_last_modified(item.get("LastModified"))
            file_name = key.rsplit("/", 1)[-1]
            if not key or not file_name or file_name.startswith((".", "_")) or modified_at is None:
                continue
            relative_key = key[len(listing_prefix):] if key.startswith(listing_prefix) else ""
            if not relative_key or (not recursive and "/" in relative_key):
                continue
            if lower_bound is not None and modified_at < lower_bound:
                continue
            if modified_at >= upper_bound:
                continue
            if file_pattern and not fnmatch(file_name, file_pattern):
                continue
            identity = listed_s3_object_identity(item, modified_at)
            existing_identity = listed_inventory.get(key)
            if existing_identity is not None:
                mismatch_fields = source_object_identity_mismatch_fields(existing_identity, identity)
                if mismatch_fields:
                    raise source_object_identity_changed_error(job, key, mismatch_fields)
            listed_inventory[key] = identity
            if len(listed_inventory) > object_limit:
                raise ApiError(
                    ErrorCode.VALIDATION_ERROR,
                    "Incremental source contains too many object keys for the configured checkpoint limit",
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    {"limit": object_limit},
                )
        if not response.get("IsTruncated"):
            break
        continuation_token = response.get("NextContinuationToken")
        if not continuation_token:
            raise ApiError(
                "SERVICE_UNAVAILABLE",
                "Incremental source inventory pagination did not provide a continuation token",
                status.HTTP_503_SERVICE_UNAVAILABLE,
                {"bucket": bucket, "prefix": listing_prefix},
            )
    keys = sorted(listed_inventory)
    if not keys:
        return []
    with ThreadPoolExecutor(
        max_workers=source_identity_worker_count(len(keys)),
        thread_name_prefix="asklake-s3-identity",
    ) as executor:
        return list(executor.map(
            lambda key: pin_listed_s3_object_identity(client, bucket, listed_inventory[key], job),
            keys,
        ))


def sync_airflow_run(
    db: Session,
    job: ETLJobModel,
    run: ETLRunModel,
    airflow_client: Any,
    dataset: CatalogDatasetModel | None = None,
) -> None:
    synced_at = iso_now()
    try:
        dag_run = airflow_client.get_dag_run(run.airflow_dag_run_id)
    except ApiError as exc:
        locked_job = etl_repository.get_job_for_update(db, job.id)
        if locked_job is None:
            db.rollback()
            return
        locked_run = etl_repository.get_run_model(db, run.run_id)
        if locked_run is None:
            db.rollback()
            return
        etl_repository.refresh_run_for_update(db, locked_run)
        record_airflow_sync_error(locked_run, exc, synced_at)
        etl_repository.save_job(db, locked_job)
        return

    try:
        task_instances = airflow_client.list_task_instances(run.airflow_dag_run_id)
    except ApiError as exc:
        locked_job = etl_repository.get_job_for_update(db, job.id)
        if locked_job is None:
            db.rollback()
            return
        locked_run = etl_repository.get_run_model(db, run.run_id)
        if locked_run is None:
            db.rollback()
            return
        etl_repository.refresh_run_for_update(db, locked_run)
        locked_run.sync_error = exc.message
        locked_run.last_synced_at = synced_at
        etl_repository.save_job(db, locked_job)
        return

    # Spark/Catalog execution endpoints can commit task evidence while this
    # polling request is waiting on Airflow. Refresh and lock the Run before
    # replacing the task snapshot so a stale poll cannot erase that evidence.
    locked_job = etl_repository.get_job_for_update(db, job.id)
    if locked_job is None:
        db.rollback()
        return
    locked_run = etl_repository.get_run_model(db, run.run_id)
    if locked_run is None:
        db.rollback()
        return
    job = locked_job
    run = locked_run
    etl_repository.refresh_run_for_update(db, run)
    run.status = dag_run.asklake_status
    run.airflow_dag_id = dag_run.dag_id or run.airflow_dag_id
    run.airflow_dag_run_id = dag_run.dag_run_id or run.airflow_dag_run_id
    run.airflow_run_url = airflow_client.dag_run_url(run.airflow_dag_run_id) or run.airflow_run_url
    run.airflow_state = dag_run.state
    previous_task_states = dict(run.task_states or {})
    spark_execution = previous_task_states.get("sparkExecution")
    spark_result = previous_task_states.get("sparkResult")
    catalog_result = previous_task_states.get("catalogResult")
    airflow_reservation = previous_task_states.get("airflowReservation")
    run.task_states = task_state_snapshot(task_instances)
    if isinstance(spark_execution, dict):
        run.task_states["sparkExecution"] = spark_execution
    if isinstance(spark_result, dict):
        run.task_states["sparkResult"] = spark_result
    if isinstance(catalog_result, dict):
        run.task_states["catalogResult"] = catalog_result
    if isinstance(airflow_reservation, dict):
        run.task_states["airflowReservation"] = airflow_reservation
    run.last_synced_at = synced_at
    run.sync_error = None

    if run.status in TERMINAL_RUN_STATUSES and run.ended_at == "-":
        run.ended_at = synced_at
        run.duration = format_iso_duration(run.started_at, synced_at)

    catalog_failed = isinstance(catalog_result, dict) and catalog_result.get("status") == "failed"
    catalog_committed = isinstance(catalog_result, dict) and catalog_result.get("status") == "success"

    if run.status == "failed":
        failed_task = first_problem_task(task_instances)
        spark_failed = isinstance(spark_result, dict) and bool(spark_result.get("failedStage") or spark_result.get("error"))
        if catalog_failed:
            run.failed_stage = "Catalog reconciliation"
            run.error_summary = str(catalog_result.get("error") or "Catalog reconciliation failed.")
        elif spark_failed:
            run.failed_stage = str(spark_result.get("failedStage") or "Spark ETL")
            run.error_summary = str(spark_result.get("error") or "Spark execution failed.")
        else:
            run.failed_stage = task_title(failed_task.task_id) if failed_task else "Airflow DAG Run"
            run.error_summary = f"Airflow task failed: {failed_task.task_id}" if failed_task else "Airflow DAG Run failed."
    elif run.status == "success":
        if catalog_failed:
            mark_airflow_catalog_reconciliation_failure(run, catalog_result)
        elif catalog_committed or airflow_run_has_materialization(run, dataset):
            run.failed_stage = "-"
            run.error_summary = "-"
        else:
            mark_airflow_success_without_catalog_reconciliation(run)

    run_schema = etl_repository.run_to_schema(run)
    dag_steps = dag_steps_from_airflow_sync(job, run_schema.model_dump(by_alias=True), task_instances)
    job.dag_steps_by_run_id = {
        **(job.dag_steps_by_run_id or {}),
        run.run_id: dag_steps,
    }
    job.dag_steps = dag_steps
    etl_repository.save_job(db, job)


AIRFLOW_TASK_TITLES = {
    "receive_asklake_run": "1. Airflow DAG Run 접수",
    "validate_spark_request": "2. Spark 실행 요청 검증",
    "spark_process_write": "3. Spark 처리/품질/Parquet 적재",
    "publish_run_result": "4. Spark 실행 결과 확정",
}


def execute_kafka_continuous_maintenance(
    db: Session,
    job_id: str,
    kind: str,
    config: dict[str, Any],
    actor: ActorContext,
    access_action: str = "run",
) -> ContinuousMaintenanceRun:
    job = require_continuous_job_access(db, job_id, actor, access_action, "POST", f"continuous/{kind}")
    reconcile_stale_continuous_maintenance_runs(db, job.id)
    reconcile_pending_continuous_replay_catalog(db, job)
    locked_job = etl_repository.get_job_for_update(db, job.id)
    if locked_job is None:
        raise ApiError(ErrorCode.NOT_FOUND, f"Job not found: {job.id}", status.HTTP_404_NOT_FOUND)
    job = locked_job
    reconcile_stale_continuous_maintenance_runs(db, job.id, commit=False)
    runtime = etl_repository.lock_kafka_continuous_runtime(db, job.id)
    require_continuous_maintenance_idle(db, job, runtime=runtime)
    require_no_active_continuous_maintenance(db, job.id)
    run_id = stable_id("continuous-maint", f"{job.id}:{kind}:{iso_now()}")
    started_at = iso_now()
    lease_expires_at = (datetime.now(UTC) + timedelta(seconds=continuous_maintenance_lease_seconds())).isoformat().replace("+00:00", "Z")
    persisted_config = {
        **config,
        "heartbeatAt": started_at,
        "leaseExpiresAt": lease_expires_at,
        "trustedLegacyReplayRunIds": trusted_legacy_replay_run_ids(db, job),
    }
    run = KafkaContinuousMaintenanceRunModel(
        run_id=run_id,
        job_id=job.id,
        kind=kind,
        status="running",
        requested_by=actor.name,
        config=persisted_config,
        started_at=started_at,
    )
    etl_repository.save_kafka_continuous_maintenance_run(db, run)
    try:
        result = run_kafka_continuous_maintenance(job, kind, run_id, persisted_config)
        if kind in {"compaction", "iceberg_maintenance"}:
            result = verify_continuous_iceberg_maintenance(job, run_id, result)
    except Exception as exc:
        cleanup_result: dict[str, Any] = {}
        try:
            cleanup_result = cleanup_kafka_continuous_maintenance(run_id)
        except ApiError as cleanup_error:
            cleanup_result = {"cleanupError": compact_storage_text(cleanup_error.message, limit=500)}
        run.status = "failed"
        run.ended_at = iso_now()
        recovery_state, durable_replay_result, recovery_reason = (
            recover_continuous_replay_result(job, run_id, run.result)
            if kind == "quarantine_replay"
            else ("missing", {}, None)
        )
        if (
            recovery_state == "found"
            and continuous_replay_result_is_durable(durable_replay_result)
        ):
            durable_replay_result.setdefault("catalogApplied", False)
            durable_replay_result.setdefault("countersApplied", False)
            run.last_error = "Replay Catalog materialization is pending retry after worker result recovery."
            run.result = durable_replay_result
        elif kind == "quarantine_replay" and recovery_state == "unavailable":
            run.last_error = "Replay manifest recovery is pending before the stream can restart."
            run.result = {
                **cleanup_result,
                "runId": run_id,
                "replayManifestRecovery": {
                    "state": "unavailable",
                    "reason": recovery_reason,
                },
            }
        else:
            run.last_error = exc.message if isinstance(exc, ApiError) else compact_storage_text(str(exc), limit=1000)
            run.result = cleanup_result
        etl_repository.save_kafka_continuous_maintenance_run(db, run)
        if bool(config.get("approveUnknownFields")):
            record_continuous_replay_override_audit(db, job, actor, run_id, "failed")
        if isinstance(exc, ApiError):
            raise
        raise ApiError(
            "KAFKA_CONTINUOUS_MAINTENANCE_FAILED",
            run.last_error,
            status.HTTP_502_BAD_GATEWAY,
        ) from exc
    result.pop("stdout", None)
    result.pop("stderr", None)
    run.ended_at = optional_string(result.get("endedAt")) or iso_now()
    if kind == "quarantine_replay":
        replayed_count = nonnegative_int(result.get("storedCount"), 0)
        result["catalogApplied"] = replayed_count == 0
        result["countersApplied"] = replayed_count == 0
        if replayed_count:
            # Persist the worker's durable Iceberg/manifest evidence before
            # Catalog reconciliation. A control-plane crash can then retry the
            # exact same replay without executing Spark a second time.
            run.status = "failed"
            run.last_error = "Replay Catalog materialization is pending retry."
            run.result = dict(result)
            etl_repository.save_kafka_continuous_maintenance_run(db, run)

            locked_job = etl_repository.get_job_for_update(db, job.id)
            runtime = etl_repository.lock_kafka_continuous_runtime(db, job.id)
            if locked_job is not None and runtime is not None:
                job = locked_job
                catalog_applied = materialize_continuous_replay(db, job, runtime, result)
                result["catalogApplied"] = catalog_applied
                if catalog_applied:
                    # The Catalog helper commits independently, so reacquire
                    # both fenced rows before applying counters exactly once.
                    locked_job = etl_repository.get_job_for_update(db, job.id)
                    runtime = etl_repository.lock_kafka_continuous_runtime(db, job.id)
                    if locked_job is not None and runtime is not None:
                        job = locked_job
                        apply_continuous_replay_runtime_counters(runtime, result)
                        run.status = "success"
                        run.last_error = None
                else:
                    run.last_error = runtime.last_error or run.last_error
                run.result = dict(result)
                db.add(run)
                etl_repository.save_kafka_continuous_command(db, job, runtime)
        else:
            run.status = "success"
            run.last_error = None
        if bool(config.get("approveUnknownFields")):
            record_continuous_replay_override_audit(db, job, actor, run_id, run.status)
    if run.status != "failed":
        run.status = "success"
        run.last_error = None
    run.result = result
    return etl_repository.save_kafka_continuous_maintenance_run(db, run)


def reconcile_stale_continuous_maintenance_runs(
    db: Session,
    job_id: str | None = None,
    *,
    commit: bool = True,
) -> None:
    current = datetime.now(UTC)
    for run in etl_repository.list_kafka_continuous_maintenance_run_models(db, job_id, active_only=True):
        lease_value = optional_string((run.config or {}).get("leaseExpiresAt"))
        lease_expires_at = parse_maintenance_datetime(lease_value)
        if lease_expires_at is None and run.started_at:
            started_at = parse_maintenance_datetime(run.started_at)
            lease_expires_at = (
                started_at + timedelta(seconds=continuous_maintenance_lease_seconds())
                if started_at is not None
                else current
            )
        if lease_expires_at is None or current <= lease_expires_at:
            continue
        runner = continuous_maintenance_runner_observation(run.run_id)
        runner_updated_at = runner.get("updatedAt") if runner else None
        runner_fresh = bool(
            isinstance(runner_updated_at, datetime)
            and current - runner_updated_at <= timedelta(seconds=continuous_maintenance_runner_stale_seconds())
        )
        if runner and runner_fresh:
            if runner.get("terminal"):
                terminal_grace_until = runner_updated_at + timedelta(
                    seconds=continuous_maintenance_runner_stale_seconds()
                )
                if current <= terminal_grace_until:
                    run.config = {
                        **(run.config or {}),
                        "heartbeatAt": runner_updated_at.isoformat().replace("+00:00", "Z"),
                        "leaseExpiresAt": terminal_grace_until.isoformat().replace("+00:00", "Z"),
                        "runnerState": runner.get("driverState"),
                    }
                    persist_reconciled_maintenance_run(db, run, commit=commit)
                    continue
            else:
                renewed_until = current + timedelta(seconds=continuous_maintenance_lease_seconds())
                run.config = {
                    **(run.config or {}),
                    "heartbeatAt": runner_updated_at.isoformat().replace("+00:00", "Z"),
                    "leaseExpiresAt": renewed_until.isoformat().replace("+00:00", "Z"),
                    "runnerState": runner.get("driverState"),
                }
                persist_reconciled_maintenance_run(db, run, commit=commit)
                continue
        replay_state = "missing"
        replay_result = dict(run.result or {}) if isinstance(run.result, dict) else {}
        replay_recovery_reason: str | None = None
        if run.kind == "quarantine_replay":
            replay_job_id = optional_string(getattr(run, "job_id", None)) or job_id
            replay_job = None
            if replay_job_id:
                try:
                    replay_job = etl_repository.get_job(db, replay_job_id)
                except Exception:
                    replay_job = None
            replay_state, replay_result, replay_recovery_reason = recover_continuous_replay_result(
                replay_job,
                run.run_id,
                replay_result,
            )
        if runner and runner.get("terminal"):
            run.status = "failed"
            run.ended_at = iso_now()
            if replay_state == "found" and continuous_replay_result_is_durable(replay_result):
                replay_result.setdefault("catalogApplied", False)
                replay_result.setdefault("countersApplied", False)
                run.last_error = "Replay Catalog materialization is pending retry after maintenance recovery."
                run.result = replay_result
            elif run.kind == "quarantine_replay" and replay_state == "unavailable":
                run.last_error = "Replay manifest recovery is pending before the stream can restart."
                run.result = {
                    **replay_result,
                    "replayManifestRecovery": {
                        "state": "unavailable",
                        "reason": replay_recovery_reason,
                    },
                    "runnerState": runner.get("driverState"),
                    "submissionId": runner.get("submissionId"),
                }
            else:
                run.last_error = "Continuous maintenance runner ended before control-plane finalization."
                run.result = {
                    "cleanupSkipped": True,
                    "leaseExpired": True,
                    "runnerState": runner.get("driverState"),
                    "submissionId": runner.get("submissionId"),
                }
            persist_reconciled_maintenance_run(db, run, commit=commit)
            continue
        cleanup_result: dict[str, Any] = {}
        try:
            cleanup_result = cleanup_kafka_continuous_maintenance(run.run_id)
        except ApiError as exc:
            cleanup_result = {"cleanupError": compact_storage_text(exc.message, limit=500)}
        run.status = "failed"
        run.ended_at = iso_now()
        if replay_state == "found" and continuous_replay_result_is_durable(replay_result):
            replay_result.setdefault("catalogApplied", False)
            replay_result.setdefault("countersApplied", False)
            run.last_error = "Replay Catalog materialization is pending retry after maintenance recovery."
            run.result = replay_result
        elif run.kind == "quarantine_replay" and replay_state == "unavailable":
            run.last_error = "Replay manifest recovery is pending before the stream can restart."
            run.result = {
                **replay_result,
                **cleanup_result,
                "replayManifestRecovery": {
                    "state": "unavailable",
                    "reason": replay_recovery_reason,
                },
            }
        else:
            run.last_error = "Continuous maintenance lease expired before completion."
            run.result = {"leaseExpired": True, **cleanup_result}
        persist_reconciled_maintenance_run(db, run, commit=commit)


def _apply_continuous_runtime_report(
    db: Session,
    job: ETLJobModel,
    runtime: KafkaContinuousRuntimeModel,
    payload: dict[str, Any],
    worker_status: dict[str, Any],
    *,
    forced_terminal_status: str | None,
    contract_was_initialized: bool,
) -> None:
    container_state = str(worker_status.get("containerState") or "unknown")
    previous_metrics = runtime.metrics or {}
    worker_attempt_id = optional_string(payload.get("workerAttemptId"))
    if forced_terminal_status and worker_attempt_id and not observation_is_current(
        previous_metrics,
        worker_attempt_id,
    ):
        payload = {}
        worker_attempt_id = None
    rule_metrics = payload.get("ruleMetrics") if isinstance(payload.get("ruleMetrics"), dict) else None
    last_rule_result = payload.get("lastRuleResult") if isinstance(payload.get("lastRuleResult"), dict) else None
    last_batch_evidence = payload.get("lastBatchEvidence") if isinstance(payload.get("lastBatchEvidence"), dict) else None
    previous_metrics = {
        **previous_metrics,
        **({"ruleContractVersion": optional_string(payload.get("ruleContractVersion"))} if payload.get("ruleContractVersion") else {}),
        **({"ruleFingerprint": optional_string(payload.get("ruleFingerprint"))} if payload.get("ruleFingerprint") else {}),
        **({"runtimeFingerprint": optional_string(payload.get("runtimeFingerprint"))} if payload.get("runtimeFingerprint") else {}),
        **({"ruleMetrics": rule_metrics} if rule_metrics is not None else {}),
        **({"lastRuleResult": last_rule_result} if last_rule_result is not None else {}),
        **({"lastBatchEvidence": last_batch_evidence} if last_batch_evidence is not None else {}),
    }
    reported_status = forced_terminal_status or str(payload.get("status") or runtime.status)
    if reported_status not in {"starting", "running", "pausing", "paused", "stopping", "stopped", "failed"}:
        return
    observed_state = observed_state_from_evidence(reported_status, container_state)
    if contract_was_initialized and not forced_terminal_status:
        record_legacy_runtime_error_projection(
            previous_metrics,
            runtime.last_error,
            public_status=runtime.status,
        )
        contract = runtime_contract_projection(
            previous_metrics,
            public_status=runtime.status,
            legacy_error=runtime.last_error,
        )
        runtime_status = derive_public_status(contract["desiredState"], observed_state).value
    else:
        runtime_status = reported_status
    previous_metrics = record_runtime_observation(
        previous_metrics,
        observed_state,
        default_public_status=runtime_status,
        worker_attempt_id=worker_attempt_id,
    )
    runtime.status = runtime_status
    runtime.heartbeat_at = optional_string(payload.get("heartbeatAt")) or runtime.heartbeat_at
    runtime.last_flush_at = optional_string(payload.get("lastFlushAt")) or runtime.last_flush_at
    runtime.last_batch_id = optional_string(payload.get("lastBatchId")) or runtime.last_batch_id
    if worker_attempt_id:
        previous_metrics = {**previous_metrics, "currentWorkerAttemptId": worker_attempt_id}
    metrics_available = bool(payload.get("lagAvailable"))
    if metrics_available:
        runtime.lag = optional_int(payload.get("lag"))
        runtime.metrics = {
            **previous_metrics,
            "lagAvailable": True,
            "maxPartitionLag": optional_int(payload.get("maxPartitionLag")),
            "laggingPartitionCount": nonnegative_int(payload.get("laggingPartitionCount"), 0),
            "partitionProgress": payload.get("partitionProgress") if isinstance(payload.get("partitionProgress"), dict) else {},
            "lastBatchDurationMs": optional_int(payload.get("lastBatchDurationMs")),
            "lastBatchInputRows": nonnegative_int(payload.get("lastBatchInputRows"), 0),
            "throughputRowsPerSecond": payload.get("throughputRowsPerSecond"),
            "replayedCount": max(
                nonnegative_int(payload.get("replayedCount"), 0),
                nonnegative_int(previous_metrics.get("replayedCount"), 0),
            ),
        }
    else:
        # A checkpointed worker can restart without receiving a new Spark
        # progress event. Keep the last valid Kafka observation in that idle
        # window instead of replacing it with an artificial zero/empty state.
        runtime.metrics = previous_metrics
        if runtime.lag is None and previous_metrics.get("lagAvailable"):
            runtime.lag = optional_int(previous_metrics.get("lag"))
    runtime.metrics = {
        **runtime.metrics,
        "publicationBacklogCount": nonnegative_int(payload.get("publicationBacklogCount"), 0),
        "publicationWindowLimit": nonnegative_int(payload.get("publicationWindowLimit"), 0),
        "catalogAckBatchId": optional_int(payload.get("catalogAckBatchId")),
    }
    previous_schema_state = runtime.schema_state or {}
    runtime.schema_state = {
        "schemaVersion": nonnegative_int(payload.get("schemaVersion"), nonnegative_int(previous_schema_state.get("schemaVersion"), 1)),
        "schemaFingerprint": optional_string(payload.get("schemaFingerprint")) or optional_string(previous_schema_state.get("schemaFingerprint")),
        "schemaStatus": optional_string(payload.get("schemaStatus")) or optional_string(previous_schema_state.get("schemaStatus")) or "stable",
        "schemaChanges": payload.get("schemaChanges") if isinstance(payload.get("schemaChanges"), list) else previous_schema_state.get("schemaChanges", []),
    }
    runtime.consumed_count = max(int(runtime.consumed_count or 0), nonnegative_int(payload.get("consumedCount"), 0))
    runtime.stored_count = max(int(runtime.stored_count or 0), nonnegative_int(payload.get("storedCount"), 0))
    runtime.quarantined_count = max(int(runtime.quarantined_count or 0), nonnegative_int(payload.get("quarantinedCount"), 0))
    runtime.failed_count = max(int(runtime.failed_count or 0), nonnegative_int(payload.get("failedCount"), 0))
    worker_error = optional_string(payload.get("lastError"))
    if worker_error or not str(runtime.last_error or "").startswith("Catalog materialization pending retry:"):
        runtime.last_error = worker_error
    if forced_terminal_status:
        runtime.last_error = None
    if worker_error:
        runtime.metrics = record_runtime_error(
            runtime.metrics,
            stage=ContinuousErrorStage.EXECUTION,
            code="worker_reported_failure",
            message=worker_error,
            retryable=True,
            context={"jobId": job.id, "workerAttemptId": worker_attempt_id},
        )
    elif runtime.last_error is None:
        runtime.metrics = clear_runtime_error(runtime.metrics)
    # A publication manifest is durable independently from the worker process.
    # Reconcile Catalog before liveness handling so a crash cannot strand Lake
    # data outside Catalog merely because the worker is no longer running.
    terminal_recovery = db is not None and (
        runtime_status in {"paused", "stopped", "failed"}
        or container_state in {"exited", "missing"}
        or (runtime.metrics or {}).get("publicationRecoveryPending") is True
    )
    catalog_ack_cursor = materialize_continuous_batch(
        db,
        job,
        runtime,
        payload,
        recover_completed_manifests=terminal_recovery,
    )
    heartbeat_stale = continuous_heartbeat_is_stale(runtime.heartbeat_at, job)
    if runtime_status in {"starting", "running", "pausing", "stopping"} and container_state in {"exited", "missing"}:
        mark_continuous_runtime_failed(
            job,
            runtime,
            f"Continuous worker container is {container_state} (exitCode={worker_status.get('exitCode')}).",
            continuous_failure_identity(job, runtime, worker_status, "container_exit"),
            error_stage=ContinuousErrorStage.EXECUTION,
            error_code="worker_container_exited",
            retryable=True,
        )
    elif runtime_status in {"starting", "running", "pausing", "stopping"} and heartbeat_stale:
        mark_continuous_runtime_failed(
            job,
            runtime,
            "Continuous worker heartbeat expired.",
            continuous_failure_identity(job, runtime, worker_status, "heartbeat_expired"),
            error_stage=ContinuousErrorStage.EXECUTION,
            error_code="worker_heartbeat_expired",
            retryable=True,
        )
        stop_stale_continuous_worker(job, runtime)
    if runtime.status == "running":
        job.status = "running"
        job.last_state = f"Continuous Spark streaming · {runtime.stored_count:,}건 적재"
        job.progress = {"label": "Continuous micro-batch 실행 중", "value": 66}
    elif runtime.status == "paused":
        job.status = "paused"
        job.last_state = "Continuous worker 일시정지됨"
        job.progress = None
    elif runtime.status == "stopped":
        job.status = "stopped"
        job.last_state = "Continuous worker 중지됨 · checkpoint 보존"
        job.progress = None
    elif runtime.status == "failed":
        job.status = "failed"
        job.last_state = "Continuous worker 실패"
        job.progress = None
    # Sync each report once after the terminal state is known. Calling this
    # before and after Catalog reconciliation can stage the same zero-row
    # publication twice when no intermediate Catalog commit occurs.
    sync_kafka_continuous_session(db, runtime, payload)
    etl_repository.save_kafka_continuous_command(db, job, runtime)
    if catalog_ack_cursor is not None and db is not None:
        write_continuous_catalog_ack(job.id, catalog_ack_cursor)


def mark_continuous_runtime_failed(
    job: ETLJobModel,
    runtime: KafkaContinuousRuntimeModel,
    message: str,
    failure_identity: str | None = None,
    *,
    error_stage: ContinuousErrorStage = ContinuousErrorStage.EXECUTION,
    error_code: str = "continuous_runtime_failed",
    retryable: bool = True,
) -> None:
    metrics = dict(runtime.metrics or {})
    already_counted = bool(failure_identity and metrics.get("lastFailureIdentity") == failure_identity)
    runtime.status = "failed"
    if not already_counted:
        runtime.failed_count += 1
    if failure_identity:
        metrics["lastFailureIdentity"] = failure_identity
    metrics = record_runtime_observation(
        metrics,
        "failed",
        default_public_status="failed",
    )
    runtime.metrics = record_runtime_error(
        metrics,
        stage=error_stage,
        code=error_code,
        message=message,
        retryable=retryable,
        context={"jobId": job.id, **({"failureIdentity": failure_identity} if failure_identity else {})},
    )
    runtime.last_error = message
    job.status = "failed"
    job.last_state = "Continuous worker 실패"
    job.progress = None


def materialize_continuous_replay(
    db: Session,
    job: ETLJobModel,
    runtime: KafkaContinuousRuntimeModel,
    replay_result: dict[str, Any],
) -> bool:
    replayed_count = nonnegative_int(replay_result.get("storedCount"), 0)
    if replayed_count == 0:
        return True
    dataset_id = job.dataset_id or make_dataset_id(job.target)
    metrics = runtime.metrics or {}
    schema_state = runtime.schema_state or {}
    run_id = optional_string(replay_result.get("runId")) or ""
    try:
        if not run_id:
            raise ValueError("Kafka replay is missing its durable run identity")
        target_path = parse_kafka_target_path(job.storage_path or job.target_path, job.target, job.target_layer)
        dataset_root = f"s3a://{target_path['bucket']}/{target_path['prefix'].strip('/')}"
        target = IcebergWriterTarget.model_validate(job.iceberg_target)
        source_ranges = normalize_kafka_source_ranges(
            replay_result.get("sourceRanges") if isinstance(replay_result.get("sourceRanges"), list) else None,
            required=True,
        )
        replay_manifest_path = optional_string(replay_result.get("manifestPath"))
        replay_output_path = optional_string(replay_result.get("outputPath"))
        if replay_manifest_path is None:
            raise ValueError("Kafka replay is missing its committed manifest path")
        if replay_output_path is None:
            raise ValueError("Kafka replay is missing its durable data path")
        expected_manifest_path = f"{dataset_root}/_replay-manifests/run_id={run_id}"
        if replay_output_path != target.table_uri:
            raise ValueError("Kafka replay Iceberg table does not match its persisted target")
        if canonical_storage_path(replay_manifest_path) != canonical_storage_path(expected_manifest_path):
            raise ValueError("Kafka replay manifest path does not match its run identity")
        verify_continuous_publication_storage(
            replay_output_path,
            replay_manifest_path,
            require_data_marker=False,
        )
    except ValueError as exc:
        runtime.last_error = f"Replay Catalog materialization pending retry: {compact_storage_text(str(exc), limit=500)}"
        return False
    next_check_after_ms = recommended_dashboard_poll_ms(
        (job.continuous_config or {}).get("triggerIntervalSeconds")
    )
    try:
        DashboardLiveRepository(db, ensure_schema=False).lock_dataset_publication_identity(dataset_id)
        existing = etl_repository.get_dataset_by_id_for_update(db, dataset_id)
    except Exception as exc:
        db.rollback()
        runtime.last_error = f"Replay Catalog materialization pending retry: {compact_storage_text(str(exc), limit=500)}"
        return False
    try:
        commit = replay_result.get("icebergCommit") if isinstance(replay_result.get("icebergCommit"), dict) else None
        source_boundary = replay_result.get("sourceBoundary") if isinstance(replay_result.get("sourceBoundary"), dict) else None
        committed_boundary = commit.get("sourceBoundary") if isinstance(commit, dict) and isinstance(commit.get("sourceBoundary"), dict) else None
        if not commit or not source_boundary or committed_boundary != source_boundary:
            raise ValueError("Continuous replay does not include matching Iceberg source-boundary evidence.")
        if any((
            source_boundary.get("kind") != "kafka_continuous_replay",
            str(source_boundary.get("jobId") or "") != job.id,
            str(source_boundary.get("runId") or "") != run_id,
            normalize_kafka_source_ranges(source_boundary.get("sourceRanges"), required=True) != source_ranges,
            not str(source_boundary.get("boundaryId") or "").strip(),
        )):
            raise ValueError("Continuous replay source boundary does not match the persisted Job.")
        result = {
            "endedAt": optional_string(replay_result.get("endedAt")) or iso_now(),
            "icebergCommit": commit,
            "materializationRows": replayed_count,
            "outputPath": target.table_uri,
            "outputRows": runtime.stored_count,
            "publicationManifest": replay_manifest_path,
            "quality": replay_result.get("quality") if isinstance(replay_result.get("quality"), dict) else {},
            "ruleContractVersion": optional_string(replay_result.get("ruleContractVersion")) or optional_string(metrics.get("ruleContractVersion")),
            "ruleFingerprint": optional_string(replay_result.get("ruleFingerprint")) or optional_string(metrics.get("ruleFingerprint")),
            "runId": run_id,
            "runtimeFingerprint": optional_string(metrics.get("runtimeFingerprint")),
            "schemaFingerprint": optional_string(schema_state.get("schemaFingerprint")) or optional_string(job.schema_fingerprint),
            "sourceBoundary": source_boundary,
            "sourceKind": "kafka",
            "sourceRanges": source_ranges,
            "status": "success",
            "transform": replay_result.get("transform") if isinstance(replay_result.get("transform"), dict) else {},
        }
        verified = verify_spark_iceberg_result(
            job,
            run_id,
            result,
            expected_run_row_count=replayed_count,
        )
        existing_mapping = (existing.payload or {}).get("queryEngineTable") if existing and existing.payload else None
        same_mapping = isinstance(existing_mapping, dict) and all(
            str(existing_mapping.get(key) or "") == expected
            for key, expected in (
                ("catalog", target.catalog),
                ("schema", target.namespace),
                ("table", target.table),
                ("format", "iceberg"),
            )
        )
        verified = {
            **verified,
            "materializationMode": "delta" if same_mapping else "snapshot",
            "sourceBoundary": source_boundary,
            "sourceRanges": source_ranges,
        }
        save_catalog_dataset_and_revision(
            db,
            dataset_from_spark_result(job, verified, existing),
            run_id=run_id,
            storage_location=str(verified["materializationOutputPath"]),
            storage_format="iceberg",
            materialization_mode=str(verified["materializationMode"]),
            row_count=replayed_count,
            next_check_after_ms=next_check_after_ms,
            source_ranges=source_ranges,
            commit_kind=REPLAY_COMMIT_KIND,
            manifest_location=replay_manifest_path,
        )
    except Exception as exc:  # Replay data is already durable; Catalog can retry independently.
        db.rollback()
        runtime.last_error = f"Replay Catalog materialization pending retry: {compact_storage_text(str(exc), limit=500)}"
        return False
    if str(runtime.last_error or "").startswith("Replay Catalog materialization pending retry:"):
        runtime.last_error = None
    return True




# Compatibility bindings keep the public service API and test patch points stable.
source_connector_defaults = bind_runtime(_etl_api_job_operations.IMPLEMENTATIONS['source_connector_defaults'], globals(), runtime_names=_etl_api_job_operations.RUNTIME_NAMES)
legacy_permission_grants = bind_runtime(_etl_api_job_operations.IMPLEMENTATIONS['legacy_permission_grants'], globals(), runtime_names=_etl_api_job_operations.RUNTIME_NAMES)
permission_grants_for_etl_job = bind_runtime(_etl_api_job_operations.IMPLEMENTATIONS['permission_grants_for_etl_job'], globals(), runtime_names=_etl_api_job_operations.RUNTIME_NAMES)
get_permission_options = bind_runtime(_etl_api_job_operations.IMPLEMENTATIONS['get_permission_options'], globals(), runtime_names=_etl_api_job_operations.RUNTIME_NAMES)
create_pipeline = bind_runtime(_etl_api_job_operations.IMPLEMENTATIONS['create_pipeline'], globals(), runtime_names=_etl_api_job_operations.RUNTIME_NAMES)
pipeline_create_mapping_context = bind_runtime(_etl_api_job_operations.IMPLEMENTATIONS['pipeline_create_mapping_context'], globals(), runtime_names=_etl_api_job_operations.RUNTIME_NAMES)
list_jobs = bind_runtime(_etl_api_job_operations.IMPLEMENTATIONS['list_jobs'], globals(), runtime_names=_etl_api_job_operations.RUNTIME_NAMES)
list_job_statuses = bind_runtime(_etl_api_job_operations.IMPLEMENTATIONS['list_job_statuses'], globals(), runtime_names=_etl_api_job_operations.RUNTIME_NAMES)
continuous_report_has_unacknowledged_publication = bind_runtime(_etl_api_job_operations.IMPLEMENTATIONS['continuous_report_has_unacknowledged_publication'], globals(), runtime_names=_etl_api_job_operations.RUNTIME_NAMES)
has_pending_continuous_replay_catalog = bind_runtime(_etl_api_job_operations.IMPLEMENTATIONS['has_pending_continuous_replay_catalog'], globals(), runtime_names=_etl_api_job_operations.RUNTIME_NAMES)
run_due_scheduled_jobs = bind_runtime(_etl_api_job_operations.IMPLEMENTATIONS['run_due_scheduled_jobs'], globals(), runtime_names=_etl_api_job_operations.RUNTIME_NAMES)
get_job = bind_runtime(_etl_api_job_operations.IMPLEMENTATIONS['get_job'], globals(), runtime_names=_etl_api_job_operations.RUNTIME_NAMES)
update_pipeline = bind_runtime(_etl_api_job_operations.IMPLEMENTATIONS['update_pipeline'], globals(), runtime_names=_etl_api_job_operations.RUNTIME_NAMES)
persist_requested_permission_grants = bind_runtime(_etl_api_job_operations.IMPLEMENTATIONS['persist_requested_permission_grants'], globals(), runtime_names=_etl_api_job_operations.RUNTIME_NAMES)
delete_job = bind_runtime(_etl_api_job_operations.IMPLEMENTATIONS['delete_job'], globals(), runtime_names=_etl_api_job_operations.RUNTIME_NAMES)
list_datasets = bind_runtime(_etl_api_job_operations.IMPLEMENTATIONS['list_datasets'], globals(), runtime_names=_etl_api_job_operations.RUNTIME_NAMES)
get_dataset = bind_runtime(_etl_api_job_operations.IMPLEMENTATIONS['get_dataset'], globals(), runtime_names=_etl_api_job_operations.RUNTIME_NAMES)
get_dataset_lineage = bind_runtime(_etl_api_job_operations.IMPLEMENTATIONS['get_dataset_lineage'], globals(), runtime_names=_etl_api_job_operations.RUNTIME_NAMES)
execute_query = bind_runtime(_etl_api_job_operations.IMPLEMENTATIONS['execute_query'], globals(), runtime_names=_etl_api_job_operations.RUNTIME_NAMES)
command_kafka_continuous_job = bind_runtime(_etl_api_review_operations.IMPLEMENTATIONS['command_kafka_continuous_job'], globals(), runtime_names=_etl_api_review_operations.RUNTIME_NAMES)
with_job_permissions = bind_runtime(_etl_api_review_operations.IMPLEMENTATIONS['with_job_permissions'], globals(), runtime_names=_etl_api_review_operations.RUNTIME_NAMES)
with_jobs_permissions = bind_runtime(_etl_api_review_operations.IMPLEMENTATIONS['with_jobs_permissions'], globals(), runtime_names=_etl_api_review_operations.RUNTIME_NAMES)
test_source_connector = bind_runtime(_etl_api_review_operations.IMPLEMENTATIONS['test_source_connector'], globals(), runtime_names=_etl_api_review_operations.RUNTIME_NAMES)
is_internal_data_lake_source = bind_runtime(_etl_api_review_operations.IMPLEMENTATIONS['is_internal_data_lake_source'], globals(), runtime_names=_etl_api_review_operations.RUNTIME_NAMES)
resolve_internal_data_lake_source = bind_runtime(_etl_api_review_operations.IMPLEMENTATIONS['resolve_internal_data_lake_source'], globals(), runtime_names=_etl_api_review_operations.RUNTIME_NAMES)
list_source_assets = bind_runtime(_etl_api_review_operations.IMPLEMENTATIONS['list_source_assets'], globals(), runtime_names=_etl_api_review_operations.RUNTIME_NAMES)
infer_schema = bind_runtime(_etl_api_review_operations.IMPLEMENTATIONS['infer_schema'], globals(), runtime_names=_etl_api_review_operations.RUNTIME_NAMES)
review_pipeline = bind_runtime(_etl_api_review_operations.IMPLEMENTATIONS['review_pipeline'], globals(), runtime_names=_etl_api_review_operations.RUNTIME_NAMES)
review_entry = bind_runtime(_etl_api_review_operations.IMPLEMENTATIONS['review_entry'], globals(), runtime_names=_etl_api_review_operations.RUNTIME_NAMES)
permission_review_entries = bind_runtime(_etl_api_review_operations.IMPLEMENTATIONS['permission_review_entries'], globals(), runtime_names=_etl_api_review_operations.RUNTIME_NAMES)
review_permission_issue = bind_runtime(_etl_api_review_operations.IMPLEMENTATIONS['review_permission_issue'], globals(), runtime_names=_etl_api_review_operations.RUNTIME_NAMES)
review_validation = bind_runtime(_etl_api_review_operations.IMPLEMENTATIONS['review_validation'], globals(), runtime_names=_etl_api_review_operations.RUNTIME_NAMES)
ingest_kafka_reviews = bind_runtime(_etl_snapshot_operations.IMPLEMENTATIONS['ingest_kafka_reviews'], globals(), runtime_names=_etl_snapshot_operations.RUNTIME_NAMES)
run_kafka_ingest_job = bind_runtime(_etl_snapshot_operations.IMPLEMENTATIONS['run_kafka_ingest_job'], globals(), runtime_names=_etl_snapshot_operations.RUNTIME_NAMES)
run_kafka_ingest_request = bind_runtime(_etl_snapshot_operations.IMPLEMENTATIONS['run_kafka_ingest_request'], globals(), runtime_names=_etl_snapshot_operations.RUNTIME_NAMES)
kafka_post_ingest_failure_details = bind_runtime(_etl_snapshot_operations.IMPLEMENTATIONS['kafka_post_ingest_failure_details'], globals(), runtime_names=_etl_snapshot_operations.RUNTIME_NAMES)
kafka_request_with_durable_snapshot = bind_runtime(_etl_snapshot_operations.IMPLEMENTATIONS['kafka_request_with_durable_snapshot'], globals(), runtime_names=_etl_snapshot_operations.RUNTIME_NAMES)
kafka_failure_result = bind_runtime(_etl_snapshot_operations.IMPLEMENTATIONS['kafka_failure_result'], globals(), runtime_names=_etl_snapshot_operations.RUNTIME_NAMES)
publish_kafka_snapshot_iceberg_result = bind_runtime(_etl_snapshot_operations.IMPLEMENTATIONS['publish_kafka_snapshot_iceberg_result'], globals(), runtime_names=_etl_snapshot_operations.RUNTIME_NAMES)
kafka_snapshot_source_boundary = bind_runtime(_etl_snapshot_operations.IMPLEMENTATIONS['kafka_snapshot_source_boundary'], globals(), runtime_names=_etl_snapshot_operations.RUNTIME_NAMES)
kafka_materialization_for_snapshot = bind_runtime(_etl_snapshot_operations.IMPLEMENTATIONS['kafka_materialization_for_snapshot'], globals(), runtime_names=_etl_snapshot_operations.RUNTIME_NAMES)
kafka_offset_policy = bind_runtime(_etl_snapshot_operations.IMPLEMENTATIONS['kafka_offset_policy'], globals(), runtime_names=_etl_snapshot_operations.RUNTIME_NAMES)
parse_kafka_target_path = bind_runtime(_etl_snapshot_operations.IMPLEMENTATIONS['parse_kafka_target_path'], globals(), runtime_names=_etl_snapshot_operations.RUNTIME_NAMES)
run_spark_job = bind_runtime(_etl_airflow_operations.IMPLEMENTATIONS['run_spark_job'], globals(), runtime_names=_etl_airflow_operations.RUNTIME_NAMES)
ensure_batch_iceberg_target = bind_runtime(_etl_airflow_operations.IMPLEMENTATIONS['ensure_batch_iceberg_target'], globals(), runtime_names=_etl_airflow_operations.RUNTIME_NAMES)
sync_active_airflow_snapshot_runs = bind_runtime(_etl_airflow_operations.IMPLEMENTATIONS['sync_active_airflow_snapshot_runs'], globals(), runtime_names=_etl_airflow_operations.RUNTIME_NAMES)
execute_airflow_spark_run = bind_runtime(_etl_airflow_operations.IMPLEMENTATIONS['execute_airflow_spark_run'], globals(), runtime_names=_etl_airflow_operations.RUNTIME_NAMES)
airflow_spark_execution_hooks = bind_runtime(_etl_airflow_operations.IMPLEMENTATIONS['airflow_spark_execution_hooks'], globals(), runtime_names=_etl_airflow_operations.RUNTIME_NAMES)
spark_execution_lease_is_active = bind_runtime(_etl_airflow_operations.IMPLEMENTATIONS['spark_execution_lease_is_active'], globals(), runtime_names=_etl_airflow_operations.RUNTIME_NAMES)
spark_execution_lease_seconds = bind_runtime(_etl_airflow_operations.IMPLEMENTATIONS['spark_execution_lease_seconds'], globals(), runtime_names=_etl_airflow_operations.RUNTIME_NAMES)
finalize_spark_execution_attempt = bind_runtime(_etl_airflow_operations.IMPLEMENTATIONS['finalize_spark_execution_attempt'], globals(), runtime_names=_etl_airflow_operations.RUNTIME_NAMES)
reconcile_airflow_catalog = bind_runtime(_etl_airflow_operations.IMPLEMENTATIONS['reconcile_airflow_catalog'], globals(), runtime_names=_etl_airflow_operations.RUNTIME_NAMES)
airflow_catalog_reconciliation_hooks = bind_runtime(_etl_airflow_operations.IMPLEMENTATIONS['airflow_catalog_reconciliation_hooks'], globals(), runtime_names=_etl_airflow_operations.RUNTIME_NAMES)
airflow_catalog_identity = bind_runtime(_etl_airflow_operations.IMPLEMENTATIONS['airflow_catalog_identity'], globals(), runtime_names=_etl_airflow_operations.RUNTIME_NAMES)
commit_airflow_catalog_reconciliation = bind_runtime(_etl_airflow_operations.IMPLEMENTATIONS['commit_airflow_catalog_reconciliation'], globals(), runtime_names=_etl_airflow_operations.RUNTIME_NAMES)
persist_catalog_reconciliation_failure = bind_runtime(_etl_airflow_operations.IMPLEMENTATIONS['persist_catalog_reconciliation_failure'], globals(), runtime_names=_etl_airflow_operations.RUNTIME_NAMES)
validate_catalog_output_identity = bind_runtime(_etl_airflow_operations.IMPLEMENTATIONS['validate_catalog_output_identity'], globals(), runtime_names=_etl_airflow_operations.RUNTIME_NAMES)
normalize_spark_output_storage_path = bind_runtime(_etl_airflow_operations.IMPLEMENTATIONS['normalize_spark_output_storage_path'], globals(), runtime_names=_etl_airflow_operations.RUNTIME_NAMES)
canonical_storage_path = bind_runtime(_etl_airflow_operations.IMPLEMENTATIONS['canonical_storage_path'], globals(), runtime_names=_etl_airflow_operations.RUNTIME_NAMES)
inspect_spark_output = bind_runtime(_etl_airflow_operations.IMPLEMENTATIONS['inspect_spark_output'], globals(), runtime_names=_etl_airflow_operations.RUNTIME_NAMES)
inspect_s3_spark_output = bind_runtime(_etl_airflow_operations.IMPLEMENTATIONS['inspect_s3_spark_output'], globals(), runtime_names=_etl_airflow_operations.RUNTIME_NAMES)
build_catalog_s3_client = bind_runtime(_etl_airflow_operations.IMPLEMENTATIONS['build_catalog_s3_client'], globals(), runtime_names=_etl_airflow_operations.RUNTIME_NAMES)
catalog_reconciliation_error = bind_runtime(_etl_airflow_operations.IMPLEMENTATIONS['catalog_reconciliation_error'], globals(), runtime_names=_etl_airflow_operations.RUNTIME_NAMES)
spark_result_manifest = bind_runtime(_etl_airflow_operations.IMPLEMENTATIONS['spark_result_manifest'], globals(), runtime_names=_etl_airflow_operations.RUNTIME_NAMES)
execute_airflow_run = bind_runtime(_etl_airflow_operations.IMPLEMENTATIONS['execute_airflow_run'], globals(), runtime_names=_etl_airflow_operations.RUNTIME_NAMES)
require_airflow_internal_token = bind_runtime(_etl_airflow_operations.IMPLEMENTATIONS['require_airflow_internal_token'], globals(), runtime_names=_etl_airflow_operations.RUNTIME_NAMES)
apply_spark_result_to_airflow_run = bind_runtime(_etl_airflow_operations.IMPLEMENTATIONS['apply_spark_result_to_airflow_run'], globals(), runtime_names=_etl_airflow_operations.RUNTIME_NAMES)
airflow_execution_response = bind_runtime(_etl_airflow_operations.IMPLEMENTATIONS['airflow_execution_response'], globals(), runtime_names=_etl_airflow_operations.RUNTIME_NAMES)
airflow_execution_response_from_persisted = bind_runtime(_etl_airflow_operations.IMPLEMENTATIONS['airflow_execution_response_from_persisted'], globals(), runtime_names=_etl_airflow_operations.RUNTIME_NAMES)
airflow_run_reservation = bind_runtime(_etl_airflow_operations.IMPLEMENTATIONS['airflow_run_reservation'], globals(), runtime_names=_etl_airflow_operations.RUNTIME_NAMES)
submit_airflow_job_run = bind_runtime(_etl_airflow_operations.IMPLEMENTATIONS['submit_airflow_job_run'], globals(), runtime_names=_etl_airflow_operations.RUNTIME_NAMES)
submit_or_reconcile_airflow_job_run = bind_runtime(_etl_airflow_operations.IMPLEMENTATIONS['submit_or_reconcile_airflow_job_run'], globals(), runtime_names=_etl_airflow_operations.RUNTIME_NAMES)
airflow_dag_run_conf = bind_runtime(_etl_airflow_operations.IMPLEMENTATIONS['airflow_dag_run_conf'], globals(), runtime_names=_etl_airflow_operations.RUNTIME_NAMES)
job_payload_for_spark = bind_runtime(_etl_airflow_operations.IMPLEMENTATIONS['job_payload_for_spark'], globals(), runtime_names=_etl_airflow_operations.RUNTIME_NAMES)
source_incremental_since = bind_runtime(_etl_source_runtime.IMPLEMENTATIONS['source_incremental_since'], globals(), runtime_names=_etl_source_runtime.RUNTIME_NAMES)
source_incremental_window = bind_runtime(_etl_source_runtime.IMPLEMENTATIONS['source_incremental_window'], globals(), runtime_names=_etl_source_runtime.RUNTIME_NAMES)
incremental_source_object_inventory = bind_runtime(_etl_source_runtime.IMPLEMENTATIONS['incremental_source_object_inventory'], globals(), runtime_names=_etl_source_runtime.RUNTIME_NAMES)
incremental_source_object_keys = bind_runtime(_etl_source_runtime.IMPLEMENTATIONS['incremental_source_object_keys'], globals(), runtime_names=_etl_source_runtime.RUNTIME_NAMES)
list_incremental_s3_object_keys = bind_runtime(_etl_source_runtime.IMPLEMENTATIONS['list_incremental_s3_object_keys'], globals(), runtime_names=_etl_source_runtime.RUNTIME_NAMES)
prior_incremental_source_object_keys = bind_runtime(_etl_source_runtime.IMPLEMENTATIONS['prior_incremental_source_object_keys'], globals(), runtime_names=_etl_source_runtime.RUNTIME_NAMES)
allows_unconfigured_s3_source = bind_runtime(_etl_source_runtime.IMPLEMENTATIONS['allows_unconfigured_s3_source'], globals(), runtime_names=_etl_source_runtime.RUNTIME_NAMES)
sync_airflow_runs_for_job = bind_runtime(_etl_source_runtime.IMPLEMENTATIONS['sync_airflow_runs_for_job'], globals(), runtime_names=_etl_source_runtime.RUNTIME_NAMES)
run_node_bridge = bind_runtime(_etl_source_runtime.IMPLEMENTATIONS['run_node_bridge'], globals(), runtime_names=_etl_source_runtime.RUNTIME_NAMES)
recover_spark_rest_submission = bind_runtime(_etl_source_runtime.IMPLEMENTATIONS['recover_spark_rest_submission'], globals(), runtime_names=_etl_source_runtime.RUNTIME_NAMES)
spark_rest_mode_enabled = bind_runtime(_etl_source_runtime.IMPLEMENTATIONS['spark_rest_mode_enabled'], globals(), runtime_names=_etl_source_runtime.RUNTIME_NAMES)
spark_rest_poll_timeout_ms = bind_runtime(_etl_source_runtime.IMPLEMENTATIONS['spark_rest_poll_timeout_ms'], globals(), runtime_names=_etl_source_runtime.RUNTIME_NAMES)
spark_python_bridge_timeout_seconds = bind_runtime(_etl_source_runtime.IMPLEMENTATIONS['spark_python_bridge_timeout_seconds'], globals(), runtime_names=_etl_source_runtime.RUNTIME_NAMES)
continuous_maintenance_poll_timeout_ms = bind_runtime(_etl_source_runtime.IMPLEMENTATIONS['continuous_maintenance_poll_timeout_ms'], globals(), runtime_names=_etl_source_runtime.RUNTIME_NAMES)
continuous_maintenance_bridge_timeout_seconds = bind_runtime(_etl_source_runtime.IMPLEMENTATIONS['continuous_maintenance_bridge_timeout_seconds'], globals(), runtime_names=_etl_source_runtime.RUNTIME_NAMES)
spark_rest_submission_state_file = bind_runtime(_etl_source_runtime.IMPLEMENTATIONS['spark_rest_submission_state_file'], globals(), runtime_names=_etl_source_runtime.RUNTIME_NAMES)
continuous_maintenance_state_file = bind_runtime(_etl_source_runtime.IMPLEMENTATIONS['continuous_maintenance_state_file'], globals(), runtime_names=_etl_source_runtime.RUNTIME_NAMES)
continuous_maintenance_result_file = bind_runtime(_etl_source_runtime.IMPLEMENTATIONS['continuous_maintenance_result_file'], globals(), runtime_names=_etl_source_runtime.RUNTIME_NAMES)
read_continuous_maintenance_result = bind_runtime(_etl_source_runtime.IMPLEMENTATIONS['read_continuous_maintenance_result'], globals(), runtime_names=_etl_source_runtime.RUNTIME_NAMES)
read_continuous_maintenance_result_candidate = bind_runtime(_etl_source_runtime.IMPLEMENTATIONS['read_continuous_maintenance_result_candidate'], globals(), runtime_names=_etl_source_runtime.RUNTIME_NAMES)
continuous_replay_result_is_durable = bind_runtime(_etl_source_runtime.IMPLEMENTATIONS['continuous_replay_result_is_durable'], globals(), runtime_names=_etl_source_runtime.RUNTIME_NAMES)
s3_object_is_confirmed_missing = bind_runtime(_etl_source_runtime.IMPLEMENTATIONS['s3_object_is_confirmed_missing'], globals(), runtime_names=_etl_source_runtime.RUNTIME_NAMES)
read_continuous_replay_manifest = bind_runtime(_etl_source_runtime.IMPLEMENTATIONS['read_continuous_replay_manifest'], globals(), runtime_names=_etl_source_runtime.RUNTIME_NAMES)
recover_continuous_replay_result = bind_runtime(_etl_source_runtime.IMPLEMENTATIONS['recover_continuous_replay_result'], globals(), runtime_names=_etl_source_runtime.RUNTIME_NAMES)
bounded_environment_integer = bind_runtime(_etl_source_runtime.IMPLEMENTATIONS['bounded_environment_integer'], globals(), runtime_names=_etl_source_runtime.RUNTIME_NAMES)
read_runtime_json = bind_runtime(_etl_source_runtime.IMPLEMENTATIONS['read_runtime_json'], globals(), runtime_names=_etl_source_runtime.RUNTIME_NAMES)
write_runtime_json_atomic = bind_runtime(_etl_source_runtime.IMPLEMENTATIONS['write_runtime_json_atomic'], globals(), runtime_names=_etl_source_runtime.RUNTIME_NAMES)
object_manifest_port = bind_runtime(_etl_source_runtime.IMPLEMENTATIONS['object_manifest_port'], globals(), runtime_names=_etl_source_runtime.RUNTIME_NAMES)
marker_payload = bind_runtime(_etl_source_runtime.IMPLEMENTATIONS['marker_payload'], globals(), runtime_names=_etl_source_runtime.RUNTIME_NAMES)
persisted_stream_partition_cursors = bind_runtime(_etl_source_runtime.IMPLEMENTATIONS['persisted_stream_partition_cursors'], globals(), runtime_names=_etl_source_runtime.RUNTIME_NAMES)
merge_stream_partition_cursor_metrics = bind_runtime(_etl_source_runtime.IMPLEMENTATIONS['merge_stream_partition_cursor_metrics'], globals(), runtime_names=_etl_source_runtime.RUNTIME_NAMES)
run_kafka_continuous_worker = bind_runtime(_etl_continuous_maintenance.IMPLEMENTATIONS['run_kafka_continuous_worker'], globals(), runtime_names=_etl_continuous_maintenance.RUNTIME_NAMES)
get_kafka_continuous_worker_logs = bind_runtime(_etl_continuous_maintenance.IMPLEMENTATIONS['get_kafka_continuous_worker_logs'], globals(), runtime_names=_etl_continuous_maintenance.RUNTIME_NAMES)
list_kafka_continuous_sessions = bind_runtime(_etl_continuous_maintenance.IMPLEMENTATIONS['list_kafka_continuous_sessions'], globals(), runtime_names=_etl_continuous_maintenance.RUNTIME_NAMES)
get_kafka_continuous_session = bind_runtime(_etl_continuous_maintenance.IMPLEMENTATIONS['get_kafka_continuous_session'], globals(), runtime_names=_etl_continuous_maintenance.RUNTIME_NAMES)
list_kafka_continuous_session_batches = bind_runtime(_etl_continuous_maintenance.IMPLEMENTATIONS['list_kafka_continuous_session_batches'], globals(), runtime_names=_etl_continuous_maintenance.RUNTIME_NAMES)
get_kafka_continuous_quarantine = bind_runtime(_etl_continuous_maintenance.IMPLEMENTATIONS['get_kafka_continuous_quarantine'], globals(), runtime_names=_etl_continuous_maintenance.RUNTIME_NAMES)
list_kafka_continuous_maintenance_runs = bind_runtime(_etl_continuous_maintenance.IMPLEMENTATIONS['list_kafka_continuous_maintenance_runs'], globals(), runtime_names=_etl_continuous_maintenance.RUNTIME_NAMES)
replay_kafka_continuous_quarantine = bind_runtime(_etl_continuous_maintenance.IMPLEMENTATIONS['replay_kafka_continuous_quarantine'], globals(), runtime_names=_etl_continuous_maintenance.RUNTIME_NAMES)
compact_kafka_continuous_target = bind_runtime(_etl_continuous_maintenance.IMPLEMENTATIONS['compact_kafka_continuous_target'], globals(), runtime_names=_etl_continuous_maintenance.RUNTIME_NAMES)
maintain_kafka_continuous_iceberg_target = bind_runtime(_etl_continuous_maintenance.IMPLEMENTATIONS['maintain_kafka_continuous_iceberg_target'], globals(), runtime_names=_etl_continuous_maintenance.RUNTIME_NAMES)
verify_continuous_iceberg_maintenance = bind_runtime(_etl_continuous_maintenance.IMPLEMENTATIONS['verify_continuous_iceberg_maintenance'], globals(), runtime_names=_etl_continuous_maintenance.RUNTIME_NAMES)
apply_continuous_replay_runtime_counters = bind_runtime(_etl_continuous_maintenance.IMPLEMENTATIONS['apply_continuous_replay_runtime_counters'], globals(), runtime_names=_etl_continuous_maintenance.RUNTIME_NAMES)
reconcile_pending_continuous_replay_catalog = bind_runtime(_etl_continuous_maintenance.IMPLEMENTATIONS['reconcile_pending_continuous_replay_catalog'], globals(), runtime_names=_etl_continuous_maintenance.RUNTIME_NAMES)
record_continuous_replay_override_audit = bind_runtime(_etl_continuous_maintenance.IMPLEMENTATIONS['record_continuous_replay_override_audit'], globals(), runtime_names=_etl_continuous_maintenance.RUNTIME_NAMES)
run_kafka_continuous_maintenance = bind_runtime(_etl_continuous_maintenance.IMPLEMENTATIONS['run_kafka_continuous_maintenance'], globals(), runtime_names=_etl_continuous_maintenance.RUNTIME_NAMES)
cleanup_kafka_continuous_maintenance = bind_runtime(_etl_continuous_maintenance.IMPLEMENTATIONS['cleanup_kafka_continuous_maintenance'], globals(), runtime_names=_etl_continuous_maintenance.RUNTIME_NAMES)
continuous_maintenance_lease_seconds = bind_runtime(_etl_continuous_maintenance.IMPLEMENTATIONS['continuous_maintenance_lease_seconds'], globals(), runtime_names=_etl_continuous_maintenance.RUNTIME_NAMES)
continuous_maintenance_runner_stale_seconds = bind_runtime(_etl_continuous_maintenance.IMPLEMENTATIONS['continuous_maintenance_runner_stale_seconds'], globals(), runtime_names=_etl_continuous_maintenance.RUNTIME_NAMES)
continuous_maintenance_runner_observation = bind_runtime(_etl_continuous_maintenance.IMPLEMENTATIONS['continuous_maintenance_runner_observation'], globals(), runtime_names=_etl_continuous_maintenance.RUNTIME_NAMES)
parse_maintenance_datetime = bind_runtime(_etl_continuous_maintenance.IMPLEMENTATIONS['parse_maintenance_datetime'], globals(), runtime_names=_etl_continuous_maintenance.RUNTIME_NAMES)
persist_reconciled_maintenance_run = bind_runtime(_etl_continuous_maintenance.IMPLEMENTATIONS['persist_reconciled_maintenance_run'], globals(), runtime_names=_etl_continuous_maintenance.RUNTIME_NAMES)
require_no_active_continuous_maintenance = bind_runtime(_etl_continuous_session.IMPLEMENTATIONS['require_no_active_continuous_maintenance'], globals(), runtime_names=_etl_continuous_session.RUNTIME_NAMES)
require_continuous_job_access = bind_runtime(_etl_continuous_session.IMPLEMENTATIONS['require_continuous_job_access'], globals(), runtime_names=_etl_continuous_session.RUNTIME_NAMES)
require_continuous_maintenance_idle = bind_runtime(_etl_continuous_session.IMPLEMENTATIONS['require_continuous_maintenance_idle'], globals(), runtime_names=_etl_continuous_session.RUNTIME_NAMES)
begin_kafka_continuous_session = bind_runtime(_etl_continuous_session.IMPLEMENTATIONS['begin_kafka_continuous_session'], globals(), runtime_names=_etl_continuous_session.RUNTIME_NAMES)
current_kafka_continuous_session = bind_runtime(_etl_continuous_session.IMPLEMENTATIONS['current_kafka_continuous_session'], globals(), runtime_names=_etl_continuous_session.RUNTIME_NAMES)
fail_kafka_continuous_session = bind_runtime(_etl_continuous_session.IMPLEMENTATIONS['fail_kafka_continuous_session'], globals(), runtime_names=_etl_continuous_session.RUNTIME_NAMES)
mark_kafka_continuous_session_stopping = bind_runtime(_etl_continuous_session.IMPLEMENTATIONS['mark_kafka_continuous_session_stopping'], globals(), runtime_names=_etl_continuous_session.RUNTIME_NAMES)
sync_kafka_continuous_session = bind_runtime(_etl_continuous_session.IMPLEMENTATIONS['sync_kafka_continuous_session'], globals(), runtime_names=_etl_continuous_session.RUNTIME_NAMES)
sync_kafka_continuous_batches = bind_runtime(_etl_continuous_session.IMPLEMENTATIONS['sync_kafka_continuous_batches'], globals(), runtime_names=_etl_continuous_session.RUNTIME_NAMES)
continuous_batch_dag_steps = bind_runtime(_etl_continuous_session.IMPLEMENTATIONS['continuous_batch_dag_steps'], globals(), runtime_names=_etl_continuous_session.RUNTIME_NAMES)
continuous_session_dag_steps = bind_runtime(_etl_continuous_session.IMPLEMENTATIONS['continuous_session_dag_steps'], globals(), runtime_names=_etl_continuous_session.RUNTIME_NAMES)
refresh_kafka_continuous_runtime = bind_runtime(_etl_continuous_session.IMPLEMENTATIONS['refresh_kafka_continuous_runtime'], globals(), runtime_names=_etl_continuous_session.RUNTIME_NAMES)
continuous_worker_status = bind_runtime(_etl_continuous_publication.IMPLEMENTATIONS['continuous_worker_status'], globals(), runtime_names=_etl_continuous_publication.RUNTIME_NAMES)
continuous_heartbeat_is_stale = bind_runtime(_etl_continuous_publication.IMPLEMENTATIONS['continuous_heartbeat_is_stale'], globals(), runtime_names=_etl_continuous_publication.RUNTIME_NAMES)
continuous_failure_identity = bind_runtime(_etl_continuous_publication.IMPLEMENTATIONS['continuous_failure_identity'], globals(), runtime_names=_etl_continuous_publication.RUNTIME_NAMES)
stop_stale_continuous_worker = bind_runtime(_etl_continuous_publication.IMPLEMENTATIONS['stop_stale_continuous_worker'], globals(), runtime_names=_etl_continuous_publication.RUNTIME_NAMES)
materialize_continuous_batch = bind_runtime(_etl_continuous_publication.IMPLEMENTATIONS['materialize_continuous_batch'], globals(), runtime_names=_etl_continuous_publication.RUNTIME_NAMES)
_list_continuous_stream_partition_cursors = bind_runtime(_etl_continuous_publication.IMPLEMENTATIONS['_list_continuous_stream_partition_cursors'], globals(), runtime_names=_etl_continuous_publication.RUNTIME_NAMES)
write_continuous_catalog_ack = bind_runtime(_etl_continuous_publication.IMPLEMENTATIONS['write_continuous_catalog_ack'], globals(), runtime_names=_etl_continuous_publication.RUNTIME_NAMES)
verify_continuous_publication_storage = bind_runtime(_etl_continuous_publication.IMPLEMENTATIONS['verify_continuous_publication_storage'], globals(), runtime_names=_etl_continuous_publication.RUNTIME_NAMES)
list_continuous_stream_manifest_batch_ids = bind_runtime(_etl_continuous_publication.IMPLEMENTATIONS['list_continuous_stream_manifest_batch_ids'], globals(), runtime_names=_etl_continuous_publication.RUNTIME_NAMES)
read_continuous_stream_manifest = bind_runtime(_etl_continuous_publication.IMPLEMENTATIONS['read_continuous_stream_manifest'], globals(), runtime_names=_etl_continuous_publication.RUNTIME_NAMES)
continuous_stream_publication_evidence = bind_runtime(_etl_continuous_publication.IMPLEMENTATIONS['continuous_stream_publication_evidence'], globals(), runtime_names=_etl_continuous_publication.RUNTIME_NAMES)
continuous_stream_publication_metadata = bind_runtime(_etl_continuous_publication.IMPLEMENTATIONS['continuous_stream_publication_metadata'], globals(), runtime_names=_etl_continuous_publication.RUNTIME_NAMES)
trusted_legacy_replay_run_ids = bind_runtime(_etl_continuous_publication.IMPLEMENTATIONS['trusted_legacy_replay_run_ids'], globals(), runtime_names=_etl_continuous_publication.RUNTIME_NAMES)
materialize_continuous_publication = bind_runtime(_etl_continuous_publication.IMPLEMENTATIONS['materialize_continuous_publication'], globals(), runtime_names=_etl_continuous_publication.RUNTIME_NAMES)
_prepare_continuous_publication = bind_runtime(_etl_continuous_publication.IMPLEMENTATIONS['_prepare_continuous_publication'], globals(), runtime_names=_etl_continuous_publication.RUNTIME_NAMES)
_verify_continuous_publication_output = bind_runtime(_etl_continuous_publication.IMPLEMENTATIONS['_verify_continuous_publication_output'], globals(), runtime_names=_etl_continuous_publication.RUNTIME_NAMES)
_verify_continuous_publication_manifest = bind_runtime(_etl_continuous_publication.IMPLEMENTATIONS['_verify_continuous_publication_manifest'], globals(), runtime_names=_etl_continuous_publication.RUNTIME_NAMES)
_register_continuous_publication_catalog = bind_runtime(_etl_continuous_publication.IMPLEMENTATIONS['_register_continuous_publication_catalog'], globals(), runtime_names=_etl_continuous_publication.RUNTIME_NAMES)
_publish_continuous_dashboard_revision = bind_runtime(_etl_continuous_publication.IMPLEMENTATIONS['_publish_continuous_dashboard_revision'], globals(), runtime_names=_etl_continuous_publication.RUNTIME_NAMES)
_update_continuous_publication_stats = bind_runtime(_etl_continuous_publication.IMPLEMENTATIONS['_update_continuous_publication_stats'], globals(), runtime_names=_etl_continuous_publication.RUNTIME_NAMES)
normalize_continuous_source_ranges = bind_runtime(_etl_continuous_publication.IMPLEMENTATIONS['normalize_continuous_source_ranges'], globals(), runtime_names=_etl_continuous_publication.RUNTIME_NAMES)
continuous_runtime_report_path = bind_runtime(_etl_replay_schedule.IMPLEMENTATIONS['continuous_runtime_report_path'], globals(), runtime_names=_etl_replay_schedule.RUNTIME_NAMES)
optional_string = bind_runtime(_etl_replay_schedule.IMPLEMENTATIONS['optional_string'], globals(), runtime_names=_etl_replay_schedule.RUNTIME_NAMES)
optional_int = bind_runtime(_etl_replay_schedule.IMPLEMENTATIONS['optional_int'], globals(), runtime_names=_etl_replay_schedule.RUNTIME_NAMES)
nonnegative_int = bind_runtime(_etl_replay_schedule.IMPLEMENTATIONS['nonnegative_int'], globals(), runtime_names=_etl_replay_schedule.RUNTIME_NAMES)
has_successful_run = bind_runtime(_etl_replay_schedule.IMPLEMENTATIONS['has_successful_run'], globals(), runtime_names=_etl_replay_schedule.RUNTIME_NAMES)
trino_sql_job_run_as_actor = bind_runtime(_etl_replay_schedule.IMPLEMENTATIONS['trino_sql_job_run_as_actor'], globals(), runtime_names=_etl_replay_schedule.RUNTIME_NAMES)
advance_scheduled_job_after_tick = bind_runtime(_etl_replay_schedule.IMPLEMENTATIONS['advance_scheduled_job_after_tick'], globals(), runtime_names=_etl_replay_schedule.RUNTIME_NAMES)
ensure_scheduled_job_next_run = bind_runtime(_etl_replay_schedule.IMPLEMENTATIONS['ensure_scheduled_job_next_run'], globals(), runtime_names=_etl_replay_schedule.RUNTIME_NAMES)
