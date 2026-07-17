from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from fnmatch import fnmatch
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
from types import SimpleNamespace
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
from app.repositories import etl_repository
from app.repositories.catalog_repository import CatalogRepository
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
from app.repositories.permission_repository import ensure_legacy_permission_grants, replace_permission_ui_grants
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
from app.schemas.iceberg import IcebergWriterTarget
from app.schemas.permissions import PermissionGrant
from app.services.airflow_client import AirflowDagRun, AirflowTaskInstance, build_airflow_client
from app.services.auth_service import load_active_actor_by_user_id
from app.services.governance_enforcement import require_governed_access
from app.services.trino_materialization_service import materialized_dataset_id
from app.services.trino_query_run_service import TrinoQueryRunService
from app.services.trino_sql_job_service import TrinoSqlJobService
from app.services.identity_service import DEMO_GROUPS, DEMO_USERS
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
from app.services.resource_permission_service import permission_grants_for_resource, permissions_for_actor_with_governance

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
LEGACY_PERMISSION_GROUP_IDS = {
    alias.casefold(): group.id
    for group in DEMO_GROUPS.values()
    for alias in (group.id, group.name, group.name.removesuffix(" Team"))
}
DEFAULT_SOURCE_IDENTITY_WORKERS = 16
MAX_SOURCE_IDENTITY_WORKERS = 64
DEFAULT_SPARK_EXECUTION_LEASE_SECONDS = 1200
AIRFLOW_MISSING_RUN_FAILURE_LIMIT = 3
SPARK_REST_BRIDGE_GRACE_SECONDS = 30


def source_connector_defaults() -> SourceConnectorDefaults:
    return SourceConnectorDefaults(
        kafka_broker=os.environ.get("ASKLAKE_KAFKA_BROKER") or "127.0.0.1:19092",
        kafka_topic=(
            os.environ.get("ASKLAKE_SOURCE_DEFAULT_KAFKA_TOPIC")
            or os.environ.get("ASKLAKE_KAFKA_TOPIC")
            or "asklake-source-events"
        ),
        s3_bucket=(
            os.environ.get("ASKLAKE_SOURCE_DEFAULT_S3_BUCKET")
            or os.environ.get("ASKLAKE_RAW_BUCKET")
            or ""
        ),
        s3_prefix=os.environ.get("ASKLAKE_SOURCE_DEFAULT_S3_PREFIX") or "",
    )


def legacy_permission_grants(roles: list[dict[str, Any]] | None) -> list[PermissionGrant]:
    grants: list[PermissionGrant] = []
    for role in roles or []:
        if not isinstance(role, dict) or role.get("checked") is False:
            continue
        name = str(role.get("name") or "").strip()
        if not name:
            continue
        group_id = LEGACY_PERMISSION_GROUP_IDS.get(name.casefold())
        grants.append(PermissionGrant(
            actions=normalize_actions(role.get("access")) or ["view"],
            principal_id=group_id or name,
            principal_type="group" if group_id else "role",
            source="legacy_permission_roles",
        ))
    if grants:
        record_compatibility_path(
            CompatibilityPath.ETL_LEGACY_PERMISSION_ROLES,
            reason="legacy permissionRoles are being projected into persisted grants",
            context={"grantCount": len(grants)},
        )
    return grants


def permission_grants_for_etl_job(
    db: Session,
    job: ETLJobModel | JobRowData,
) -> list[PermissionGrant]:
    ensure_legacy_permission_grants(
        db,
        resource_type="etl_job",
        resource_id=job.id,
        grants=legacy_permission_grants(job.permission_roles),
        created_by=job.owner,
    )
    return permission_grants_for_resource(db, "etl_job", job.id, [])


def get_permission_options(
    db: Session,
    actor: ActorContext,
    job_id: str | None = None,
) -> PermissionOptionsResponse:
    if job_id:
        job = etl_repository.get_job(db, job_id)
        if job is None:
            raise ApiError(ErrorCode.NOT_FOUND, f"Job not found: {job_id}", status.HTTP_404_NOT_FOUND)
        is_creator = actor.name == job.created_by
        is_owner = actor.name == job.owner
        if not actor.is_admin and not is_creator and not is_owner:
            require_permission(
                actor,
                "manage",
                owner=job.owner,
                grants=permission_grants_for_etl_job(db, job),
                resource_label="job permissions",
            )
    Base.metadata.create_all(bind=db.get_bind(), tables=[AuthUserModel.__table__])
    stored_users = list(db.scalars(select(AuthUserModel).order_by(AuthUserModel.display_name.asc())).all())
    users = stored_users or [
        SimpleNamespace(
            id=value["id"],
            display_name=value["display_name"],
            email=value["email"],
            role=value["role"],
        )
        for value in DEMO_USERS.values()
    ]
    return PermissionOptionsResponse(
        groups=[
            PermissionOptionGroup(
                id=group.id,
                name=group.name,
                description=group.description,
                actions=PERMISSION_GROUP_ACTIONS.get(group.id, ["view", "run"]),
            )
            for group in DEMO_GROUPS.values()
        ],
        users=[
            PermissionOptionUser(
                id=user.id,
                name=user.display_name,
                email=user.email,
                initials="".join(part[0] for part in user.display_name.split()[:2]).upper() or user.display_name[:2].upper(),
                role=user.role,
            )
            for user in users
        ],
    )


def create_pipeline(
    db: Session,
    request: CreatePipelineRequest,
    actor: ActorContext | str = "demo-user",
) -> CreatePipelineResponse:
    return execute_create_pipeline(
        db,
        request,
        actor,
        hooks=EtlPipelineCreateHooks(
            apply_append_request_to_job=apply_append_request_to_job,
            apply_compiled_rules=apply_compiled_rules,
            build_mapping_context=pipeline_create_mapping_context,
            compile_pipeline_rules=compile_pipeline_rules,
            continuous_runtime_from_job=continuous_runtime_from_job,
            identity_name=identity_name,
            identity_profile=identity_profile,
            is_internal_data_lake_source=is_internal_data_lake_source,
            make_dataset_id=make_dataset_id,
            make_job_id=make_job_id,
            map_create_request_to_job=map_create_request_to_job,
            persist_permission_grants=persist_requested_permission_grants,
            require_compiled_rules=require_compiled_rules,
            resolve_internal_data_lake_source=resolve_internal_data_lake_source,
            validate_create_request=validate_create_request,
        ),
    )


def pipeline_create_mapping_context(
    request: CreatePipelineRequest,
    *,
    dataset_id: str,
    job_id: str,
    created_by: str,
    created_by_profile: dict[str, Any],
) -> CreatePipelineMappingContext:
    dataset_schema = dataset_schema_from_request(request)
    sample_rows = dataset_sample_rows_from_request(request, dataset_schema)
    metrics = source_metrics_from_request(request, dataset_schema, sample_rows)
    schedule_policy = schedule_policy_from_request(request)
    return CreatePipelineMappingContext(
        continuous_config=continuous_config_from_request(request, job_id),
        created_by=created_by,
        created_by_profile=created_by_profile,
        dag_steps=initial_dag_steps(request, metrics),
        dataset_id=dataset_id,
        iceberg_target=build_iceberg_writer_target(
            request.target_dataset,
            dataset_id,
            write_mode=writer_mode_for_pipeline(request.source_type, request.source_config),
            partition_columns=normalize_string_list(request.partition_columns),
        ).model_dump(mode="json", by_alias=True),
        job_id=job_id,
        metrics=metrics,
        next_run=schedule_next_run_label(
            request.schedule_label,
            schedule_policy.get("nextRunUtc"),
        ),
        schedule_policy=schedule_policy,
        stats=initial_job_stats(metrics),
    )


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
        permission_summary=request.governance.permission_summary,
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


def list_jobs(
    db: Session,
    actor: ActorContext | None = None,
    last_run_outcome: JobRunOutcome | None = None,
    owner: str | None = None,
    statuses: list[str] | None = None,
    schedule_kind: JobScheduleKind | None = None,
) -> JobListResponse:
    return hydrate_job_list_query(
        db,
        actor,
        last_run_outcome=last_run_outcome,
        owner=owner,
        statuses=statuses,
        schedule_kind=schedule_kind,
        hooks=EtlJobQueryHooks(
            record_audit_event=safe_record_audit_event,
            refresh_continuous_runtime=refresh_kafka_continuous_runtime,
            schedule_kind=job_schedule_kind,
            sync_airflow_runs=sync_airflow_runs_for_job,
            with_permissions=with_job_permissions,
        ),
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


def continuous_report_has_unacknowledged_publication(
    job_id: str,
    runtime: KafkaContinuousRuntimeModel,
    *,
    document_store: RuntimeDocumentStore | None = None,
) -> bool:
    report_path = continuous_runtime_report_path(job_id)
    document = read_runtime_json(report_path, document_store=document_store)
    if not document.found:
        return False
    report = document.value or {}
    publications = report.get("publishedBatches")
    cursor = nonnegative_int((runtime.metrics or {}).get("catalogBatchCursor"), -1)
    if not isinstance(publications, list) or not publications:
        return (
            report.get("lastBatchWritten") is True
            and nonnegative_int(report.get("lastBatchId"), -1) > cursor
        )
    if any(
        isinstance(publication, dict)
        and nonnegative_int(publication.get("batchId"), -1) > cursor
        for publication in publications
    ):
        return True
    return (
        report.get("lastBatchWritten") is True
        and nonnegative_int(report.get("lastBatchId"), -1) > cursor
    )


def has_pending_continuous_replay_catalog(
    db: Session,
    job_or_id: ETLJobModel | str,
) -> bool:
    job = job_or_id if not isinstance(job_or_id, str) else None
    job_id = job_or_id if isinstance(job_or_id, str) else job_or_id.id
    maintenance_runs = etl_repository.list_kafka_continuous_maintenance_run_models(
        db,
        job_id,
        active_only=False,
    )
    for run in maintenance_runs:
        if run.kind != "quarantine_replay" or run.status not in {"failed", "success"}:
            continue
        result = dict(run.result or {}) if isinstance(run.result, dict) else {}
        if result.get("catalogApplied") is True and result.get("countersApplied") is True:
            continue
        if continuous_replay_result_is_durable(result):
            return True
        if job is None:
            try:
                job = etl_repository.get_job(db, job_id)
            except Exception:
                job = None
        recovery_state, recovered, _reason = recover_continuous_replay_result(
            job,
            run.run_id,
            result,
        )
        if recovery_state == "unavailable":
            return True
        if recovery_state == "found" and continuous_replay_result_is_durable(recovered):
            return True
    return False


def run_due_scheduled_jobs(
    db: Session,
    request: ScheduledJobRunRequest,
    actor: ActorContext | None = None,
) -> ScheduledJobRunResponse:
    jobs = etl_repository.list_job_models(db)
    if request.job_id:
        jobs = [job for job in jobs if job.id == request.job_id]
    items: list[ScheduledJobRunItem] = []
    actor_context = actor or ActorContext(name="scheduler", role="admin")

    for job in jobs:
        ensure_scheduled_job_next_run(db, job)
        should_run, reason = should_run_scheduled_job(job, request)
        if not should_run:
            items.append(ScheduledJobRunItem(
                job_id=job.id,
                job_name=job.name,
                reason=reason,
                schedule=job.schedule,
                triggered=False,
            ))
            continue

        command_kwargs: dict[str, ActorContext] = {}
        if getattr(job, "job_kind", None) == "trino_sql_materialization":
            command_kwargs["execution_actor"] = trino_sql_job_run_as_actor(db, job)
        response = command_job(
            db,
            job.id,
            "run",
            actor_context,
            **command_kwargs,
        )
        if reason == "due":
            advance_scheduled_job_after_tick(db, job.id)
        items.append(ScheduledJobRunItem(
            job_id=job.id,
            job_name=job.name,
            reason=reason,
            response=response,
            schedule=job.schedule,
            triggered=True,
        ))

    return ScheduledJobRunResponse(
        checked_count=len(items),
        items=items,
        triggered_count=sum(1 for item in items if item.triggered),
    )


def get_job(db: Session, job_id: str, actor: ActorContext | None = None) -> JobRowData:
    return hydrate_job_query(
        db,
        job_id,
        actor,
        hooks=EtlJobQueryHooks(
            record_audit_event=safe_record_audit_event,
            refresh_continuous_runtime=refresh_kafka_continuous_runtime,
            schedule_kind=job_schedule_kind,
            sync_airflow_runs=sync_airflow_runs_for_job,
            with_permissions=with_job_permissions,
        ),
    )


def update_pipeline(
    db: Session,
    job_id: str,
    request: UpdatePipelineRequest,
    actor: ActorContext | None = None,
) -> JobRowData:
    return execute_update_pipeline(
        db,
        job_id,
        request,
        actor,
        hooks=EtlPipelineUpdateHooks(
            apply_compiled_rules=apply_compiled_rules,
            apply_update_request=apply_update_request,
            compile_pipeline_rules=compile_pipeline_rules,
            continuous_checkpoint_initialized=continuous_checkpoint_initialized,
            continuous_processing_contract_changed=continuous_processing_contract_changed,
            has_successful_run=has_successful_run,
            permission_grants_for_job=permission_grants_for_etl_job,
            persist_permission_grants=persist_requested_permission_grants,
            require_compiled_rules=require_compiled_rules,
            require_governed_access=require_governed_access,
            require_permission=require_permission,
            target_identity_changed=target_identity_changed,
            validate_target_contract=validate_target_contract,
            validate_update_request=validate_update_request,
            with_permissions=with_job_permissions,
        ),
    )


def persist_requested_permission_grants(
    db: Session,
    job: JobRowData,
    grants: list[Any] | None,
    created_by: str,
    actor: ActorContext,
) -> JobRowData:
    if grants is None:
        return job
    replace_permission_ui_grants(
        db,
        resource_type="etl_job",
        resource_id=job.id,
        grants=grants,
        created_by=created_by,
    )
    refreshed_job = etl_repository.get_job_schema(db, job.id) or job
    return with_job_permissions(db, refreshed_job, actor)


def delete_job(db: Session, job_id: str, actor: ActorContext | None = None) -> str:
    return execute_delete_job(
        db,
        job_id,
        actor,
        hooks=EtlJobDeleteHooks(
            add_audit_event=add_audit_event,
            permission_grants_for_job=permission_grants_for_etl_job,
            reconcile_stale_maintenance_runs=reconcile_stale_continuous_maintenance_runs,
            record_audit_event=safe_record_audit_event,
            require_governed_access=require_governed_access,
            require_permission=require_permission,
        ),
    )


def list_datasets(db: Session) -> list[CatalogDataset]:
    return etl_repository.list_datasets(db)


def get_dataset(db: Session, dataset_id: str) -> CatalogDataset:
    dataset = etl_repository.get_dataset_schema_by_id(db, dataset_id)
    if dataset is None:
        raise ApiError(ErrorCode.NOT_FOUND, f"Dataset not found: {dataset_id}", status.HTTP_404_NOT_FOUND)
    return dataset


def get_dataset_lineage(db: Session, dataset_id: str) -> dict[str, Any]:
    dataset = etl_repository.get_dataset_by_id(db, dataset_id)
    if dataset is None:
        raise ApiError(ErrorCode.NOT_FOUND, f"Dataset not found: {dataset_id}", status.HTTP_404_NOT_FOUND)
    payload_lineage = dataset.payload.get("lineageGraph") if dataset.payload else None
    if isinstance(payload_lineage, dict):
        return payload_lineage
    return dataset.lineage_graph or fallback_lineage_graph(dataset)


def execute_query(db: Session, request: QueryRunRequest) -> QueryRunResponse:
    dataset = etl_repository.get_dataset_by_id(db, request.dataset_id)
    if dataset is None:
        raise ApiError(ErrorCode.NOT_FOUND, f"Dataset not found: {request.dataset_id}", status.HTTP_404_NOT_FOUND)

    columns = [column[0] for column in (dataset.schema_json or [])[:6] if column]
    if not columns and dataset.sample_rows:
        columns = [f"col_{index + 1}" for index in range(len(dataset.sample_rows[0]))]
    width = max(len(columns), 1)
    rows = [[str(cell) for cell in row[:width]] for row in (dataset.sample_rows or [])]
    return QueryRunResponse(
        columns=columns,
        dataset_id=dataset.id,
        dataset_name=dataset.name,
        executed_at=iso_now(),
        query=request.query,
        row_count=len(rows),
        rows=rows,
        run_id=stable_id("sql", f"{dataset.id}:{request.query}:{iso_now()}"),
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


def command_kafka_continuous_job(
    db: Session,
    job: ETLJobModel,
    command: str,
    actor: ActorContext,
) -> JobCommandResponse:
    return execute_continuous_command(
        db,
        job,
        ContinuousCommandRequest(command=command, job_id=job.id),
        actor,
        worker=CallableKafkaRuntimeGateway(run_kafka_continuous_worker),
        hooks=ContinuousCommandHooks(
            is_kafka_job=is_kafka_job,
            runtime_from_job=continuous_runtime_from_job,
            reconcile_stale_maintenance=reconcile_stale_continuous_maintenance_runs,
            require_no_active_maintenance=require_no_active_continuous_maintenance,
            reconcile_pending_replay=reconcile_pending_continuous_replay_catalog,
            has_pending_replay=has_pending_continuous_replay_catalog,
            begin_session=begin_kafka_continuous_session,
            persisted_partition_cursors=persisted_stream_partition_cursors,
            fail_session=fail_kafka_continuous_session,
            mark_session_stopping=mark_kafka_continuous_session_stopping,
            with_permissions=with_job_permissions,
        ),
    )


def with_job_permissions(db: Session, job: JobRowData, actor: ActorContext) -> JobRowData:
    job_with_grants = job.model_copy(update={
        "permission_grants": permission_grants_for_etl_job(db, job),
    })
    grant_payloads = [
        grant.model_dump(by_alias=True) if hasattr(grant, "model_dump") else grant
        for grant in job_with_grants.permission_grants
    ]
    return job_with_grants.model_copy(update={
        "permissions": permissions_for_actor_with_governance(
            db,
            actor,
            owner=job_with_grants.owner,
            grants=grant_payloads,
            resource_id=job_with_grants.id,
            resource_type="etl_job",
        ),
    })


def test_source_connector(request: SourceConnectorRequest) -> SourceConnectorAnalysis:
    return execute_test_source_connector(
        request,
        gateway=NodeSourceConnectorGateway(),
    )


def is_internal_data_lake_source(source_type: str | None) -> bool:
    return str(source_type or "").strip().casefold() == "data lake"


def resolve_internal_data_lake_source(
    db: Session,
    source_config: Any,
    *,
    actor: ActorContext | None = None,
) -> dict[str, Any]:
    dataset_id = field_value(source_config or [], "Source Dataset ID").strip()
    if not dataset_id:
        raise ApiError(
            ErrorCode.VALIDATION_ERROR,
            "Data Lake source requires Source Dataset ID.",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    payload = CatalogRepository(db).get_dataset_payload(dataset_id)
    if payload is None:
        raise ApiError(ErrorCode.NOT_FOUND, f"Dataset not found: {dataset_id}", status.HTTP_404_NOT_FOUND)
    if str(payload.get("status") or "").strip().casefold() != "available":
        raise ApiError(
            ErrorCode.INVALID_JOB_STATE,
            "Data Lake source dataset is not available.",
            status.HTTP_409_CONFLICT,
            {"datasetId": dataset_id, "datasetStatus": payload.get("status")},
        )

    query_engine_table = payload.get("queryEngineTable")
    query_engine_status = str(payload.get("queryEngineStatus") or "").strip().casefold()
    if (
        not isinstance(query_engine_table, dict)
        or str(query_engine_table.get("format") or "").strip().casefold() != "iceberg"
        or query_engine_status != "available"
        or not str(query_engine_table.get("schema") or "").strip()
        or not str(query_engine_table.get("table") or "").strip()
    ):
        raise ApiError(
            ErrorCode.INVALID_JOB_STATE,
            "Data Lake source dataset requires an available Iceberg table.",
            status.HTTP_409_CONFLICT,
            {"datasetId": dataset_id, "queryEngineStatus": query_engine_status or "unavailable"},
        )

    if actor is not None:
        fallback_grants = payload.get("permissionGrants") if isinstance(payload.get("permissionGrants"), list) else []
        grants = permission_grants_for_resource(db, "dataset", dataset_id, fallback_grants)
        grant_payloads = [grant.model_dump(mode="json", by_alias=True) for grant in grants]
        permissions = permissions_for_actor_with_governance(
            db,
            actor,
            owner=str(payload.get("owner") or "") or None,
            grants=grant_payloads,
            resource_id=dataset_id,
            resource_type="dataset",
        )
        if not permissions.can_view:
            raise ApiError(
                ErrorCode.FORBIDDEN,
                f"Actor {actor.name} is not allowed to view this dataset",
                status.HTTP_403_FORBIDDEN,
                {"datasetId": dataset_id},
            )

    return {
        "catalog": str(query_engine_table.get("catalog") or "iceberg"),
        "format": "iceberg",
        "namespace": str(query_engine_table["schema"]),
        "table": str(query_engine_table["table"]),
    }


def list_source_assets(request: SourceAssetsRequest) -> SourceAssetsResponse:
    return execute_list_source_assets(
        request,
        gateway=NodeSourceConnectorGateway(),
    )


def infer_schema(request: SourceConnectorRequest) -> SchemaDraft:
    analysis = test_source_connector(request)
    if analysis.draft_patch.schema_ is None:
        return SchemaDraft(columns=[], sample_rows=[], summary="스키마 없음")
    return analysis.draft_patch.schema_


def review_pipeline(
    request: ReviewPipelineRequest,
    *,
    db: Session | None = None,
    actor: ActorContext | None = None,
) -> ReviewSnapshot:
    source_ready = request.source_connection_status == "success"
    if source_ready and is_internal_data_lake_source(request.source_type):
        try:
            if db is None or actor is None:
                source_ready = False
            else:
                resolve_internal_data_lake_source(db, request.source_config, actor=actor)
        except Exception:
            source_ready = False
    elif source_ready and request.source_type != "SQL Result":
        try:
            source_ready = test_source_connector(
                SourceConnectorRequest(source_type=request.source_type, source_config=request.source_config)
            ).status == "success"
        except Exception:
            source_ready = False

    included_columns = [column for column in request.schema_columns if column.included and column.target_name.strip()]
    compiled_rules = compile_pipeline_rules(request)
    output_columns = compiled_rules.result.output_schema
    schema_ready = bool(included_columns)
    rules_ready = compiled_rules.result.status == "pass"
    enabled_rule_count = sum(1 for rule in compiled_rules.result.rules if rule.enabled)
    rule_ready_value = "pass-through" if enabled_rule_count == 0 else f"{enabled_rule_count}개 규칙 compile 완료"
    rule_warning_value = compiled_rules.result.issues[0].message if compiled_rules.result.issues else "규칙 확인 필요"
    record_parsing_ready = not (request.record_parsing and request.record_parsing.enabled) or (
        request.record_parsing.expected_field_count > 0
        and len(request.record_parsing.columns) == request.record_parsing.expected_field_count
        and len({normalize_column_name(column.name) for column in request.record_parsing.columns}) == len(request.record_parsing.columns)
    )
    target_issue = target_contract_issue(
        source_type=request.source_type,
        execution_mode=request.execution_mode,
        target_layer=request.target_layer,
        target_format=request.target_format,
    )
    target_ready = target_issue is None and bool(
        request.target_dataset.strip()
        and str(request.target_layer).strip()
        and request.target_format.strip()
    )
    permission_issue = review_permission_issue(request)
    permission_ready = permission_issue is None
    can_create = (
        source_ready
        and schema_ready
        and rules_ready
        and record_parsing_ready
        and target_ready
        and permission_ready
        and bool(request.source_type.strip())
        and bool(request.source_label.strip())
        and bool(request.target_dataset.strip())
        and bool(request.owner.strip())
    )

    source_type = "PostgreSQL" if request.source_type == "Database" else request.source_type
    source_display = " · ".join(value for value in [source_type, request.source_label] if value.strip())

    return ReviewSnapshot(
        basic_information=[
            review_entry("소스", source_display),
            review_entry("처리 방식", "실시간 스트리밍" if request.execution_mode == "continuous" else "배치 처리"),
            review_entry("출력 데이터셋 이름", request.target_dataset),
            review_entry("설명", request.target_description),
        ],
        can_create=can_create,
        destination=[
            review_entry("저장 경로", request.storage_path),
            review_entry("데이터베이스", request.target_database or "asklake"),
            review_entry("형식", request.target_format),
            review_entry("파티션", request.partition or "없음"),
        ],
        permission=permission_review_entries(request),
        rule_compilation=compiled_rules.result,
        schema=[
            ReviewSchemaRow(
                column_name=name,
                nullable=("예" if column.nullable else "아니요") if (column := next((item for item in included_columns if item.target_name == name or item.source_name == name), None)) else "생성",
                transform=(f"원본.{column.source_name}" if column and column.source_name == name else f"{column.source_name} -> {name}" if column else "변환 출력"),
                type=type_ or "string",
            )
            for name, type_ in output_columns
        ],
        validation=[
            review_validation("소스 데이터", source_ready, "연결됨", "연결 확인 필요"),
            *([review_validation("레코드 구조화", record_parsing_ready, "확정됨", "구조화 규칙 확인 필요")] if request.record_parsing and request.record_parsing.enabled else []),
            review_validation("출력 스키마", schema_ready, "확정됨", "필드 선택 필요"),
            review_validation("처리 규칙", rules_ready, rule_ready_value, rule_warning_value),
            review_validation("접근 권한", permission_ready, "설정됨", permission_issue or "권한 확인 필요"),
            review_validation("저장 위치", target_ready, "설정됨", target_issue or "출력 데이터셋 이름 확인 필요"),
        ],
    )


def review_entry(label: str, value: str | None) -> ReviewEntry:
    return ReviewEntry(label=label, value=(value or "").strip() or "미설정")


def permission_review_entries(request: ReviewPipelineRequest) -> list[ReviewEntry]:
    grants = request.permission_grants or []
    public_view = any(
        str(grant.principal_type) == "public" and "view" in grant.actions
        for grant in grants
    )
    entries = [
        review_entry("담당자", f"{request.owner} · 모든 작업 가능"),
        review_entry("로그인한 모든 사용자", "조회 가능" if public_view else "조회 불가"),
    ]
    principal_labels = {
        "group": "그룹",
        "user": "사용자",
        "role": "역할",
        "public": "모든 사용자",
    }

    for grant in grants:
        principal_type = str(grant.principal_type)
        if principal_type == "public":
            continue
        label = principal_labels.get(principal_type, principal_type)
        principal = grant.principal_name or grant.principal_id
        actions = " · ".join(
            PERMISSION_REVIEW_ACTION_LABELS.get(str(action), str(action))
            for action in grant.actions
        ) or "권한 없음"
        entries.append(review_entry(f"{principal} ({label})", actions))

    return entries


def review_permission_issue(request: ReviewPipelineRequest) -> str | None:
    if not request.owner.strip():
        return "담당자 확인 필요"
    for grant in request.permission_grants or []:
        principal_type = str(grant.principal_type)
        if principal_type != "public" and not grant.principal_id.strip():
            return "권한 대상 확인 필요"
        if not grant.actions:
            return "허용 작업 확인 필요"
    return None


def review_validation(label: str, ready: bool, ready_value: str, warning_value: str) -> ReviewValidationRow:
    return ReviewValidationRow(label=label, status="ready" if ready else "warning", value=ready_value if ready else warning_value)


def ingest_kafka_reviews(db: Session, request: KafkaReviewIngestRequest) -> KafkaReviewIngestResponse:
    result = run_kafka_ingest_request(db, request.model_dump(by_alias=True, exclude_none=True), "ingest", None)
    return KafkaReviewIngestResponse.model_validate(result)


def run_kafka_ingest_job(db: Session, job: ETLJobModel, command: str, run_id: str) -> dict[str, Any]:
    request = kafka_ingest_request_from_job(job, run_id)
    return run_kafka_ingest_request(db, request, command, job.id)


def run_kafka_ingest_request(db: Session, request: dict[str, Any], command: str, job_id: str | None) -> dict[str, Any]:
    snapshot_record, request_with_snapshot = kafka_request_with_durable_snapshot(db, request, job_id)
    result: dict[str, Any] | None = None
    ingest_timeout_seconds = max(
        30,
        int(request["timeoutMs"] / 1000) + 30,
        900 if request_with_snapshot.get("icebergTarget") else 0,
    )
    try:
        result = run_node_bridge(
            "ingest-kafka-reviews.mjs",
            "ASKLAKE_KAFKA_REVIEW_INGEST_RESULT",
            request_with_snapshot,
            error_marker="ASKLAKE_KAFKA_REVIEW_INGEST_ERROR",
            timeout_seconds=ingest_timeout_seconds,
        )
        if job_id:
            job = etl_repository.get_job(db, job_id)
            if job is None:
                raise ApiError(ErrorCode.NOT_FOUND, f"Job not found during Kafka ingest: {job_id}", status.HTTP_404_NOT_FOUND)
            if parse_count_value(result.get("storedCount")) > 0:
                result = publish_kafka_snapshot_iceberg_result(db, job, result)
            if (
                os.environ.get("ASKLAKE_ENABLE_KAFKA_TEST_HOOKS") == "true"
                and os.environ.get("ASKLAKE_KAFKA_SNAPSHOT_FAIL_BEFORE_OFFSET_COMMIT") == "true"
            ):
                raise ApiError(
                    "KAFKA_OFFSET_COMMIT_TEST_FAILURE",
                    "Test-only failure before Kafka Snapshot offset commit.",
                    status.HTTP_502_BAD_GATEWAY,
                )
            offset_result = run_node_bridge(
                "ingest-kafka-reviews.mjs",
                "ASKLAKE_KAFKA_REVIEW_INGEST_RESULT",
                {
                    "broker": request_with_snapshot.get("broker"),
                    "commitOnly": True,
                    "consumerGroupId": request_with_snapshot.get("consumerGroupId"),
                    "landingEndpoint": request_with_snapshot.get("landingEndpoint"),
                    "metadata": result,
                    "runId": result.get("runId"),
                    "snapshot": result.get("snapshot"),
                    "storageMode": request_with_snapshot.get("storageMode"),
                    "targetBucket": request_with_snapshot.get("targetBucket"),
                    "targetFormat": request_with_snapshot.get("targetFormat"),
                    "targetLayer": request_with_snapshot.get("targetLayer"),
                    "targetPrefix": request_with_snapshot.get("targetPrefix"),
                    "topic": request_with_snapshot.get("topic"),
                },
                error_marker="ASKLAKE_KAFKA_REVIEW_INGEST_ERROR",
                timeout_seconds=max(30, int(request["timeoutMs"] / 1000) + 30),
            )
            result["offsetCommit"] = offset_result.get("offsetCommit")
            result["metadataUpdate"] = offset_result.get("metadataUpdate")
    except ApiError as exc:
        etl_repository.update_kafka_snapshot(db, snapshot_record, "failed", exc.message)
        if result is not None:
            exc.details = {
                **(exc.details or {}),
                "bridge": kafka_post_ingest_failure_details(result, exc.message),
            }
        raise
    except Exception as exc:
        message = compact_storage_text(exc, limit=1000)
        etl_repository.update_kafka_snapshot(
            db,
            snapshot_record,
            "failed",
            message,
        )
        raise ApiError(
            ErrorCode.INTERNAL_ERROR,
            "Kafka Snapshot finalization failed unexpectedly",
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            {
                **(
                    {"bridge": kafka_post_ingest_failure_details(result, message)}
                    if result is not None
                    else {}
                ),
                "reason": message,
            },
        ) from exc
    etl_repository.update_kafka_snapshot(db, snapshot_record, "success")
    result["command"] = command
    return result


def kafka_post_ingest_failure_details(result: dict[str, Any], message: str) -> dict[str, Any]:
    return {
        "catalogDataset": result.get("catalogDataset"),
        "consumedCount": parse_count_value(result.get("consumedCount")),
        "endedAt": result.get("endedAt") or iso_now(),
        "failedCount": parse_count_value(result.get("failedCount")),
        "failedStage": "offset commit" if result.get("queryEngineVerified") is True else "catalog",
        "icebergCommit": result.get("icebergCommit"),
        "message": message,
        "offsetCommit": result.get("offsetCommit") or {"status": "pending"},
        "quality": result.get("quality"),
        "queryEngineTable": result.get("queryEngineTable"),
        "queryEngineVerified": result.get("queryEngineVerified") is True,
        "runId": result.get("runId"),
        "snapshot": result.get("snapshot"),
        "startedAt": result.get("startedAt") or iso_now(),
        "storageFormat": result.get("storageFormat"),
        "storageLocation": result.get("storageLocation") or result.get("warehouseLocation"),
        "storedCount": parse_count_value(result.get("storedCount")),
        "topic": result.get("topic"),
        "transform": result.get("transform"),
    }


def kafka_request_with_durable_snapshot(
    db: Session,
    request: dict[str, Any],
    job_id: str | None,
) -> tuple[KafkaSnapshotModel, dict[str, Any]]:
    topic = str(request.get("topic") or "reviews.raw")
    consumer_group_id = str(request.get("consumerGroupId") or "")
    broker = str(request.get("broker") or "")
    continuous_conflict = etl_repository.find_conflicting_kafka_continuous_runtime(
        db,
        broker=broker,
        topic=topic,
        consumer_group_id=consumer_group_id,
        excluded_job_id=job_id or "",
    )
    if continuous_conflict is not None:
        raise ApiError(
            ErrorCode.CONFLICT,
            f"Continuous Kafka worker is already active on Job: {continuous_conflict.job_id}",
            status.HTTP_409_CONFLICT,
            {"activeJobId": continuous_conflict.job_id, "runtimeStatus": continuous_conflict.status},
        )
    existing = etl_repository.get_active_kafka_snapshot(db, topic, consumer_group_id, job_id)
    if existing is None:
        capture_request = {**request, "snapshotOnly": True}
        captured = run_node_bridge(
            "ingest-kafka-reviews.mjs",
            "ASKLAKE_KAFKA_REVIEW_INGEST_RESULT",
            capture_request,
            error_marker="ASKLAKE_KAFKA_REVIEW_INGEST_ERROR",
            timeout_seconds=max(30, int(request["timeoutMs"] / 1000) + 30),
        )
        snapshot = captured.get("snapshot")
        if not isinstance(snapshot, dict):
            raise ApiError("KAFKA_SNAPSHOT_BAD_RESPONSE", "Kafka snapshot capture did not return a snapshot.", status.HTTP_502_BAD_GATEWAY)
        snapshot["broker"] = broker
        existing = KafkaSnapshotModel(
            snapshot_id=str(snapshot["snapshotId"]),
            job_id=job_id,
            topic=topic,
            consumer_group_id=consumer_group_id,
            status="running",
            snapshot=snapshot,
        )
        existing = etl_repository.save_kafka_snapshot(db, existing)
    return existing, {**request, "snapshot": existing.snapshot}


def kafka_failure_result(request: dict[str, Any], run_id: str, error: ApiError, bridge_error: dict[str, Any]) -> dict[str, Any]:
    return {
        "broker": bridge_error.get("broker") or request.get("broker"),
        "catalogDataset": bridge_error.get("catalogDataset"),
        "consumedCount": int(bridge_error.get("consumedCount") or 0),
        "endedAt": bridge_error.get("endedAt") or iso_now(),
        "error": bridge_error.get("message") or error.message,
        "failedCount": int(bridge_error.get("failedCount") or 0),
        "failedStage": bridge_error.get("failedStage") or "Kafka ingest",
        "icebergCommit": bridge_error.get("icebergCommit"),
        "offsetCommit": bridge_error.get("offsetCommit"),
        "queryEngineTable": bridge_error.get("queryEngineTable"),
        "queryEngineVerified": bridge_error.get("queryEngineVerified") is True,
        "runId": bridge_error.get("runId") or run_id,
        "snapshot": bridge_error.get("snapshot"),
        "startedAt": bridge_error.get("startedAt") or iso_now(),
        "status": "failed",
        "storageFormat": bridge_error.get("storageFormat"),
        "storageLocation": bridge_error.get("storageLocation"),
        "storedCount": int(bridge_error.get("storedCount") or 0),
        "targetLayer": request.get("targetLayer") or "BRONZE",
        "topic": bridge_error.get("topic") or request.get("topic"),
        "transform": bridge_error.get("transform"),
        "quality": bridge_error.get("quality"),
    }


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


def publish_kafka_snapshot_iceberg_result(
    db: Session,
    job: ETLJobModel,
    result: dict[str, Any],
) -> dict[str, Any]:
    run_id = str(result.get("runId") or "").strip()
    snapshot = result.get("snapshot")
    if not run_id or not isinstance(snapshot, dict):
        raise catalog_reconciliation_error(
            "Kafka Snapshot Iceberg result identity is incomplete.",
            {"jobId": job.id, "runId": run_id},
        )
    expected_boundary = kafka_snapshot_source_boundary(snapshot)
    commit = result.get("icebergCommit")
    committed_boundary = commit.get("sourceBoundary") if isinstance(commit, dict) else None
    if committed_boundary != expected_boundary:
        raise catalog_reconciliation_error(
            "Kafka Snapshot Iceberg source boundary does not match the persisted snapshot.",
            {"jobId": job.id, "runId": run_id, "snapshotId": snapshot.get("snapshotId")},
        )
    verified = verify_spark_iceberg_result(job, run_id, result)
    dataset_id = str(job.dataset_id or make_dataset_id(job.target))
    existing = etl_repository.get_dataset_by_id_for_update(db, dataset_id)
    previous_payload = existing.payload if existing and isinstance(existing.payload, dict) else {}
    previous_run = kafka_materialization_for_snapshot(
        previous_payload.get("materializationRuns"),
        str(snapshot.get("snapshotId") or ""),
    )
    existing_mapping = previous_payload.get("queryEngineTable")
    target = IcebergWriterTarget.model_validate(job.iceberg_target)
    same_mapping = isinstance(existing_mapping, dict) and all(
        str(existing_mapping.get(key) or "") == expected
        for key, expected in (
            ("catalog", target.catalog),
            ("schema", target.namespace),
            ("table", target.table),
            ("format", "iceberg"),
        )
    )
    materialization_mode = (
        str(previous_run.get("materializationMode") or "delta")
        if previous_run
        else "delta" if same_mapping else "snapshot"
    )
    verified = {
        **verified,
        "kafkaSnapshot": snapshot,
        "materializationMode": materialization_mode,
        "materializationRows": parse_count_value(result.get("storedCount")),
        "sourceBoundary": expected_boundary,
        "sourceKind": "kafka",
        "sourceRanges": expected_boundary["partitions"],
        "storageLocation": verified.get("warehouseLocation"),
        "storedCount": parse_count_value(result.get("storedCount")),
    }
    dataset = dataset_from_spark_result(job, verified, existing)
    saved_dataset = etl_repository.save_dataset(db, dataset)
    return {
        **verified,
        "catalogDataset": {
            "id": saved_dataset.id,
            "layer": saved_dataset.layer,
            "materializationRuns": len(saved_dataset.materialization_runs),
            "name": saved_dataset.name,
            "rows": saved_dataset.rows,
            "storageLocation": saved_dataset.storage_location,
        },
    }


def kafka_snapshot_source_boundary(snapshot: dict[str, Any]) -> dict[str, Any]:
    partitions = snapshot.get("partitions") if isinstance(snapshot.get("partitions"), list) else []
    return {
        "capturedAt": str(snapshot.get("capturedAt") or ""),
        "consumerGroupId": str(snapshot.get("consumerGroupId") or ""),
        "kind": "kafka_snapshot",
        "partitions": [
            {
                "endOffset": str(partition.get("endOffset") or ""),
                "partition": int(partition.get("partition") or 0),
                "startOffset": str(partition.get("startOffset") or ""),
            }
            for partition in partitions
            if isinstance(partition, dict)
        ],
        "snapshotId": str(snapshot.get("snapshotId") or ""),
        "topic": str(snapshot.get("topic") or ""),
    }


def kafka_materialization_for_snapshot(previous_runs: Any, snapshot_id: str) -> dict[str, Any] | None:
    if not snapshot_id or not isinstance(previous_runs, list):
        return None
    return next(
        (
            run
            for run in previous_runs
            if isinstance(run, dict)
            and str((run.get("kafkaSnapshot") or {}).get("snapshotId") or "") == snapshot_id
        ),
        None,
    )


def kafka_offset_policy(value: str) -> str:
    normalized = str(value or "").strip().lower()
    if "latest" in normalized or "new" in normalized:
        return "latest"
    return "earliest"


def parse_kafka_target_path(storage_path: str | None, target_dataset: str, target_layer: str | None) -> dict[str, str]:
    default_prefix = f"{dataset_storage_key(target_dataset or 'reviews_raw')}/{str(target_layer or 'BRONZE').lower()}"
    default_bucket = os.environ.get("ASKLAKE_SPARK_OUTPUT_BUCKET") or "asklake-output"
    if storage_path:
        match = re.match(r"^s3a?://([^/]+)(?:/(.*))?$", storage_path.strip())
        if match:
            prefix = (match.group(2) or default_prefix).strip("/") or default_prefix
            if prefix == "kafka-landing" or prefix.startswith("kafka-landing/"):
                return {"bucket": default_bucket, "prefix": default_prefix, "storageMode": "s3"}
            return {
                "bucket": match.group(1),
                "prefix": prefix,
                "storageMode": "s3",
            }
    return {"bucket": default_bucket, "prefix": default_prefix, "storageMode": "s3"}


def run_spark_job(db: Session, job: ETLJobModel, command: str, run_id: str) -> dict[str, Any]:
    ensure_batch_iceberg_target(db, job)
    rest_mode = spark_rest_mode_enabled()
    poll_timeout_ms = spark_rest_poll_timeout_ms()
    state_file = spark_rest_submission_state_file(run_id)
    incremental_since, incremental_before = source_incremental_window(db, job, run_id)
    source_window_rebaseline = source_uses_incremental_folder_window(job) and incremental_since is None
    source_object_inventory = incremental_source_object_inventory(
        db,
        job,
        incremental_since=incremental_since,
        incremental_before=incremental_before,
    )
    source_object_keys = (
        [str(item["key"]) for item in source_object_inventory]
        if source_object_inventory is not None
        else None
    )
    source_iceberg_table = (
        resolve_internal_data_lake_source(db, job.source_config)
        if is_internal_data_lake_source(job.source_type)
        else None
    )
    result = run_node_bridge(
        "run-spark-job-once.mjs",
        "ASKLAKE_SPARK_RUN_RESULT",
        {
            "command": command,
            "job": job_payload_for_spark(
                job,
                incremental_since,
                incremental_before,
                source_object_keys,
                source_object_inventory,
                source_window_rebaseline=source_window_rebaseline,
                source_iceberg_table=source_iceberg_table,
            ),
            "runId": run_id,
        },
        error_marker="ASKLAKE_SPARK_RUN_ERROR",
        timeout_seconds=spark_python_bridge_timeout_seconds(poll_timeout_ms) if rest_mode else 900,
        timeout_recovery=(lambda: recover_spark_rest_submission(state_file)) if rest_mode else None,
    )
    if source_object_inventory is not None:
        source_collection = result.get("sourceCollection")
        result["sourceCollection"] = {
            **(source_collection if isinstance(source_collection, dict) else {}),
            "objectKeys": source_object_keys,
            "objectInventory": source_object_inventory,
        }
    return result


def ensure_batch_iceberg_target(db: Session, job: ETLJobModel) -> None:
    if is_kafka_job(job):
        return
    expected_write_mode = writer_mode_for_pipeline(job.source_type, job.source_config)
    if job.iceberg_target:
        existing_target = IcebergWriterTarget.model_validate(job.iceberg_target)
        if existing_target.write_mode == expected_write_mode:
            return
    dataset_id = str(job.dataset_id or make_dataset_id(job.target))
    job.dataset_id = dataset_id
    job.iceberg_target = build_iceberg_writer_target(
        job.target,
        dataset_id,
        write_mode=expected_write_mode,
        partition_columns=normalize_string_list(job.partition_columns),
    ).model_dump(mode="json", by_alias=True)
    db.add(job)
    db.commit()


def execute_airflow_spark_run(
    db: Session,
    *,
    job_id: str,
    run_id: str,
    command: str,
) -> dict[str, Any]:
    return execute_airflow_spark_command(
        db,
        job_id=job_id,
        run_id=run_id,
        command=command,
        hooks=airflow_spark_execution_hooks(),
    )


def airflow_spark_execution_hooks() -> AirflowSparkExecutionHooks:
    return AirflowSparkExecutionHooks(
        compact_storage_text=compact_storage_text,
        format_duration_ms=format_duration_ms,
        format_rows=format_rows,
        iso_now=iso_now,
        make_attempt_id=lambda run_id: stable_id(
            "spark-attempt",
            f"{run_id}:{iso_now()}:{secrets.token_hex(8)}",
        ),
        run_spark_job=run_spark_job,
        spark_error_summary=spark_error_summary,
        spark_execution_lease_is_active=spark_execution_lease_is_active,
        spark_failed_stage=spark_failed_stage,
        spark_result_manifest=spark_result_manifest,
    )


def spark_execution_lease_is_active(value: Any) -> bool:
    if not isinstance(value, dict) or value.get("status") != "running":
        return False
    try:
        started_at = parse_incremental_timestamp(str(value.get("startedAt") or ""), "sparkExecution.startedAt")
    except ApiError:
        return False
    if started_at is None:
        return False
    return datetime.now(UTC) < started_at + timedelta(seconds=spark_execution_lease_seconds())


def spark_execution_lease_seconds() -> int:
    try:
        run_timeout = max(1, int(os.environ.get("ASKLAKE_SPARK_RUN_TIMEOUT_SECONDS") or "900"))
    except ValueError:
        run_timeout = 900
    try:
        configured = int(
            os.environ.get("ASKLAKE_SPARK_EXECUTION_LEASE_SECONDS")
            or DEFAULT_SPARK_EXECUTION_LEASE_SECONDS
        )
    except ValueError:
        configured = DEFAULT_SPARK_EXECUTION_LEASE_SECONDS
    return max(run_timeout + 60, configured)


def finalize_spark_execution_attempt(
    db: Session,
    *,
    job_id: str,
    run_id: str,
    attempt_id: str,
    error: str,
) -> None:
    finalize_airflow_spark_attempt(
        db,
        job_id=job_id,
        run_id=run_id,
        attempt_id=attempt_id,
        error=error,
        hooks=airflow_spark_execution_hooks(),
    )


def reconcile_airflow_catalog(
    db: Session,
    *,
    job_id: str,
    run_id: str,
) -> AirflowCatalogReconciliationResponse:
    return execute_airflow_catalog_reconciliation(
        db,
        job_id=job_id,
        run_id=run_id,
        hooks=airflow_catalog_reconciliation_hooks(),
    )


def airflow_catalog_reconciliation_hooks() -> AirflowCatalogReconciliationHooks:
    return AirflowCatalogReconciliationHooks(
        catalog_reconciliation_error=catalog_reconciliation_error,
        compact_storage_text=compact_storage_text,
        dataset_from_spark_result=dataset_from_spark_result,
        inspect_spark_output=inspect_spark_output,
        is_kafka_job=is_kafka_job,
        iso_now=iso_now,
        optional_string=optional_string,
        parse_count_value=parse_count_value,
        validate_catalog_output_identity=validate_catalog_output_identity,
        verify_spark_iceberg_result=verify_spark_iceberg_result,
    )


def airflow_catalog_identity(db: Session, job_id: str, run_id: str) -> tuple[ETLJobModel, ETLRunModel]:
    return resolve_airflow_catalog_identity(db, job_id, run_id)


def commit_airflow_catalog_reconciliation(
    db: Session,
    *,
    job_id: str,
    run_id: str,
    result: dict[str, Any],
    retry_on_create_conflict: bool,
) -> AirflowCatalogReconciliationResponse:
    return execute_airflow_catalog_commit(
        db,
        job_id=job_id,
        run_id=run_id,
        result=result,
        retry_on_create_conflict=retry_on_create_conflict,
        hooks=airflow_catalog_reconciliation_hooks(),
    )


def persist_catalog_reconciliation_failure(db: Session, run_id: str, dataset_id: str, message: str) -> None:
    record_airflow_catalog_failure(
        db,
        run_id,
        dataset_id,
        message,
        hooks=airflow_catalog_reconciliation_hooks(),
    )


def validate_catalog_output_identity(job: ETLJobModel, run_id: str, output_path: str) -> None:
    if not output_path or output_path == "-":
        raise catalog_reconciliation_error(
            "Successful Spark result does not include an output path.",
            {"jobId": job.id, "runId": run_id},
        )
    configured_root = normalize_spark_output_storage_path(job.storage_path)
    if not configured_root:
        return
    expected = canonical_storage_path(f"{configured_root.rstrip('/')}/{run_id}")
    actual = canonical_storage_path(output_path)
    if actual != expected:
        raise catalog_reconciliation_error(
            "Spark output path does not match the persisted Job destination.",
            {"expected": expected, "outputPath": actual, "runId": run_id},
        )


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


def normalize_spark_output_storage_path(value: str | None) -> str:
    configured_root = str(value or "").strip()
    if not re.match(r"^s3a?://", configured_root, re.IGNORECASE):
        return configured_root
    configured_bucket = str(os.environ.get("ASKLAKE_SPARK_OUTPUT_BUCKET") or "asklake-output").strip()
    if not configured_bucket or configured_bucket.lower() == "asklake-output":
        return configured_root
    parsed = urlparse(re.sub(r"^s3a://", "s3://", configured_root, flags=re.IGNORECASE))
    if parsed.netloc.lower() != "asklake-output":
        return configured_root
    suffix = f"/{parsed.path.lstrip('/')}" if parsed.path else ""
    return f"s3a://{configured_bucket}{suffix}"


def canonical_storage_path(value: str) -> str:
    text_value = str(value or "").strip()
    if re.match(r"^s3a?://", text_value, re.IGNORECASE):
        return re.sub(r"^s3://", "s3a://", text_value, flags=re.IGNORECASE).rstrip("/")
    return str(Path(text_value).expanduser().resolve()).rstrip("/")


def inspect_spark_output(output_path: str, *, s3_client: Any | None = None) -> dict[str, int]:
    if re.match(r"^s3a?://", output_path, re.IGNORECASE):
        return inspect_s3_spark_output(output_path, s3_client=s3_client)
    path = Path(output_path)
    if not path.exists():
        raise catalog_reconciliation_error(
            "Spark output path does not exist.",
            {"outputPath": output_path},
        )
    files = [path] if path.is_file() else [item for item in path.rglob("*") if item.is_file()]
    parquet_files = [item for item in files if item.name.lower().endswith(".parquet")]
    storage_size_bytes = sum(item.stat().st_size for item in files)
    if not parquet_files or storage_size_bytes <= 0:
        raise catalog_reconciliation_error(
            "Spark output does not contain a non-empty Parquet result.",
            {"outputPath": output_path},
        )
    return {
        "parquetObjectCount": len(parquet_files),
        "storageSizeBytes": storage_size_bytes,
    }


def inspect_s3_spark_output(output_path: str, *, s3_client: Any | None = None) -> dict[str, int]:
    parsed = urlparse(re.sub(r"^s3a://", "s3://", output_path, flags=re.IGNORECASE))
    bucket = parsed.netloc
    key = parsed.path.lstrip("/").rstrip("/")
    if not bucket or not key:
        raise catalog_reconciliation_error(
            "Spark S3 output path is invalid.",
            {"outputPath": output_path},
        )
    client = s3_client or build_catalog_s3_client()
    prefix = f"{key}/"
    continuation_token = None
    parquet_count = 0
    storage_size_bytes = 0
    try:
        while True:
            request = {"Bucket": bucket, "Prefix": prefix}
            if continuation_token:
                request["ContinuationToken"] = continuation_token
            response = client.list_objects_v2(**request)
            for item in response.get("Contents") or []:
                object_key = str(item.get("Key") or "")
                storage_size_bytes += max(int(item.get("Size") or 0), 0)
                if object_key.lower().endswith(".parquet"):
                    parquet_count += 1
            if not response.get("IsTruncated"):
                break
            continuation_token = response.get("NextContinuationToken")
            if not continuation_token:
                break
    except ApiError:
        raise
    except Exception as exc:
        raise catalog_reconciliation_error(
            "Spark S3 output could not be inspected.",
            {"bucket": bucket, "prefix": prefix, "reason": compact_storage_text(exc, limit=1000)},
        ) from exc
    if parquet_count <= 0 or storage_size_bytes <= 0:
        raise catalog_reconciliation_error(
            "Spark S3 output does not contain a non-empty Parquet result.",
            {"bucket": bucket, "prefix": prefix},
        )
    return {
        "parquetObjectCount": parquet_count,
        "storageSizeBytes": storage_size_bytes,
    }


def build_catalog_s3_client() -> Any:
    try:
        import boto3
        from botocore.config import Config
    except ImportError as exc:
        raise catalog_reconciliation_error(
            "Python S3 client dependency is not installed.",
        ) from exc

    runtime = object_storage_runtime()
    kwargs = runtime.boto3_kwargs()
    kwargs["config"] = Config(
        s3={"addressing_style": "path" if runtime.force_path_style else "auto"},
    )
    return boto3.client("s3", **kwargs)


def catalog_reconciliation_error(message: str, details: dict[str, Any] | None = None) -> ApiError:
    return ApiError(
        "CATALOG_RECONCILIATION_FAILED",
        message,
        status.HTTP_500_INTERNAL_SERVER_ERROR,
        details,
    )


def spark_result_manifest(result: dict[str, Any], run_id: str) -> dict[str, Any]:
    manifest = {
        key: result.get(key)
        for key in (
            "durationMs",
            "endedAt",
            "error",
            "failedStage",
            "format",
            "inputBytes",
            "inputFileCount",
            "inputRows",
            "outputFileCount",
            "icebergCommit",
            "outputPath",
            "outputRows",
            "quality",
            "schema",
            "sourceCollection",
            "sourcePath",
            "sparkExitCode",
            "startedAt",
            "status",
            "warehouseLocation",
        )
        if result.get(key) is not None
    }
    manifest["runId"] = str(result.get("runId") or run_id)
    if manifest.get("error"):
        manifest["error"] = compact_storage_text(manifest["error"], limit=1800)
    return manifest


def execute_airflow_run(
    db: Session,
    job_id: str,
    run_id: str,
    command: str,
    airflow_token: str | None,
) -> AirflowRunExecutionResponse:
    require_airflow_internal_token(airflow_token)
    job = etl_repository.get_job(db, job_id)
    run = etl_repository.get_run(db, run_id)
    if job is None:
        raise ApiError(ErrorCode.NOT_FOUND, f"Job not found: {job_id}", status.HTTP_404_NOT_FOUND)
    if run is None or run.job_id != job_id:
        raise ApiError(ErrorCode.NOT_FOUND, f"Run not found for job: {run_id}", status.HTTP_404_NOT_FOUND)
    if not run.airflow_dag_run_id:
        raise ApiError(
            ErrorCode.INVALID_JOB_STATE,
            f"Run is not owned by Airflow: {run_id}",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )

    dataset_id = job.dataset_id or make_dataset_id(job.target)
    job.dataset_id = dataset_id
    existing_dataset = etl_repository.get_dataset_by_id(db, dataset_id)
    if airflow_run_has_materialization(run, existing_dataset):
        return airflow_execution_response_from_persisted(job, run, existing_dataset)

    try:
        result = run_spark_job(db, job, command, run_id)
    except ApiError as exc:
        now = iso_now()
        result = {
            "endedAt": now,
            "error": exc.message,
            "failedStage": "Spark ETL bridge",
            "inputRows": 0,
            "outputPath": "-",
            "outputRows": 0,
            "runId": run_id,
            "startedAt": now,
            "status": "failed",
        }

    spark_run = run_from_spark_result(job, result)
    apply_spark_result_to_airflow_run(run, spark_run)
    run.task_states = {
        **(run.task_states or {}),
        "sparkResult": spark_result_manifest(result, run_id),
    }
    dataset_model = None
    if result.get("status") == "success":
        # Do not hold the dataset lock while Spark is running. Re-read and
        # lock immediately before merging the new materialization history.
        existing_dataset = etl_repository.get_dataset_by_id_for_update(db, dataset_id)
        dataset_model = dataset_from_spark_result(job, result, existing_dataset)
        job.target_path = result.get("outputPath") or job.target_path
        job.last_state = "Spark 적재 및 카탈로그 등록 완료 · Airflow 종료 확인 중"
        job.progress = {"label": "Airflow 종료 확인 중", "value": 95}
        job.status = "running"
    else:
        finalize_job_from_spark_result(job, command, result)

    run_schema = etl_repository.run_to_schema(run)
    other_runs = [item for item in etl_repository.list_runs_for_job(db, job.id) if item.run_id != run.run_id]
    job.stats = stats_from_runs(job, [run_schema, *other_runs])
    etl_repository.save_command_result(db, job, run, dataset_model)
    return airflow_execution_response(job, result, dataset_model.id if dataset_model else None)


def require_airflow_internal_token(provided_token: str | None) -> None:
    expected_token = str(settings.airflow_internal_token or "")
    if not expected_token:
        raise ApiError(
            "AIRFLOW_INTERNAL_TOKEN_MISSING",
            "AIRFLOW_INTERNAL_TOKEN is not configured on the AskLake backend.",
            status.HTTP_503_SERVICE_UNAVAILABLE,
        )
    if not provided_token or not secrets.compare_digest(expected_token, provided_token):
        raise ApiError(
            ErrorCode.FORBIDDEN,
            "Airflow worker authentication failed.",
            status.HTTP_403_FORBIDDEN,
        )


def apply_spark_result_to_airflow_run(run: ETLRunModel, spark_run: ETLRunModel) -> None:
    run.duration = spark_run.duration
    run.ended_at = spark_run.ended_at
    run.error_summary = spark_run.error_summary
    run.failed_stage = spark_run.failed_stage
    run.input_rows = spark_run.input_rows
    run.output_path = spark_run.output_path
    run.output_rows = spark_run.output_rows
    # Airflow remains the orchestration source of truth until the DAG reaches a terminal state.
    run.status = "running" if spark_run.status == "success" else "failed"


def airflow_execution_response(
    job: ETLJobModel,
    result: dict[str, Any],
    dataset_id: str | None,
) -> AirflowRunExecutionResponse:
    return AirflowRunExecutionResponse(
        status="success" if result.get("status") == "success" else "failed",
        job_id=job.id,
        run_id=str(result.get("runId") or ""),
        dataset_id=dataset_id,
        input_bytes=parse_count_value(result.get("inputBytes")),
        input_file_count=parse_count_value(result.get("inputFileCount")),
        input_rows=parse_count_value(result.get("inputRows")),
        output_file_count=parse_count_value(result.get("outputFileCount")),
        output_rows=parse_count_value(result.get("outputRows")),
        output_path=str(result.get("outputPath") or "-"),
        duration_ms=parse_optional_integer(result.get("durationMs")),
        schema=result.get("schema") if isinstance(result.get("schema"), list) else [],
        quality=result.get("quality") if isinstance(result.get("quality"), dict) else None,
        failed_stage=str(result.get("failedStage") or "") or None,
        error=spark_error_summary(result) if result.get("status") != "success" else None,
    )


def airflow_execution_response_from_persisted(
    job: ETLJobModel,
    run: ETLRunModel,
    dataset: CatalogDatasetModel,
) -> AirflowRunExecutionResponse:
    payload = dataset.payload or {}
    schema_payload = payload.get("schema") if isinstance(payload.get("schema"), list) else []
    schema = [
        {"name": str(item[0]), "type": str(item[1])}
        for item in schema_payload
        if isinstance(item, list) and len(item) >= 2
    ]
    spark_result = (run.task_states or {}).get("sparkResult")
    if not isinstance(spark_result, dict):
        spark_result = {}
    return AirflowRunExecutionResponse(
        status="success",
        job_id=job.id,
        run_id=run.run_id,
        dataset_id=dataset.id,
        input_bytes=parse_count_value(spark_result.get("inputBytes")),
        input_file_count=parse_count_value(spark_result.get("inputFileCount")),
        input_rows=parse_count_value(run.input_rows),
        output_file_count=parse_count_value(spark_result.get("outputFileCount")),
        output_rows=parse_count_value(run.output_rows),
        output_path=str(run.output_path or payload.get("storageLocation") or "-"),
        schema=schema,
    )


def airflow_run_reservation(
    job: ETLJobModel,
    command: str,
    airflow_client: AirflowGateway,
) -> ETLRunModel:
    submitted_at = iso_now()
    run_id = stable_id("run", f"{job.id}:{command}:airflow:{submitted_at}")
    reserved_dag_run = AirflowDagRun(
        dag_id=airflow_client.config.dag_id,
        dag_run_id=run_id,
        state="queued",
        asklake_status="queued",
        conf=airflow_dag_run_conf(job, command, run_id, submitted_at),
        raw={"reservation": True},
    )
    reserved = run_from_airflow_submit(
        job,
        command,
        run_id,
        submitted_at,
        reserved_dag_run,
        airflow_client.dag_run_url(run_id),
    )
    reserved.task_states = {
        "airflowReservation": {
            "reservedAt": submitted_at,
            "status": "queued",
        },
    }
    return reserved


def submit_airflow_job_run(
    job: ETLJobModel,
    command: str,
    *,
    run_id: str | None = None,
    submitted_at: str | None = None,
    airflow_client: AirflowGateway | None = None,
) -> ETLRunModel:
    submitted_at = submitted_at or iso_now()
    run_id = run_id or stable_id("run", f"{job.id}:{command}:airflow:{submitted_at}")
    airflow_client = airflow_client or build_airflow_client()
    dag_run = airflow_client.trigger_dag_run(
        dag_run_id=run_id,
        conf=airflow_dag_run_conf(job, command, run_id, submitted_at),
        note=f"AskLake {command} command for {job.id}",
    )
    if not dag_run.dag_run_id or dag_run.dag_run_id != run_id:
        raise ApiError(
            "AIRFLOW_RUN_MISMATCH",
            "Airflow DAG Run response did not match the reserved run.",
            status.HTTP_502_BAD_GATEWAY,
            {
                "dagId": airflow_client.config.dag_id,
                "expectedRunId": run_id,
                "responseRunId": dag_run.dag_run_id or None,
            },
        )
    return run_from_airflow_submit(
        job,
        command,
        run_id,
        submitted_at,
        dag_run,
        airflow_client.dag_run_url(dag_run.dag_run_id),
    )


def submit_or_reconcile_airflow_job_run(
    job: ETLJobModel,
    command: str,
    reserved_run: ETLRunModel,
    airflow_client: Any,
) -> tuple[ETLRunModel | None, Exception | None]:
    try:
        return submit_airflow_job_run(
            job,
            command,
            run_id=reserved_run.run_id,
            submitted_at=reserved_run.started_at,
            airflow_client=airflow_client,
        ), None
    except Exception as trigger_error:
        try:
            dag_run = airflow_client.get_dag_run(reserved_run.run_id)
        except Exception:
            return None, trigger_error
        if not dag_run.dag_run_id or dag_run.dag_run_id != reserved_run.run_id:
            return None, ApiError(
                "AIRFLOW_RUN_MISMATCH",
                "Airflow reconciliation did not match the reserved run.",
                status.HTTP_502_BAD_GATEWAY,
                {
                    "expectedRunId": reserved_run.run_id,
                    "responseRunId": dag_run.dag_run_id or None,
                },
            )
        return run_from_airflow_submit(
            job,
            command,
            reserved_run.run_id,
            reserved_run.started_at,
            dag_run,
            airflow_client.dag_run_url(dag_run.dag_run_id),
        ), None


def airflow_dag_run_conf(job: ETLJobModel, command: str, run_id: str, submitted_at: str) -> dict[str, Any]:
    return {
        "command": command,
        "executionMode": "spark",
        "jobId": job.id,
        "runId": run_id,
        "submittedAt": submitted_at,
    }


def job_payload_for_spark(
    job: ETLJobModel,
    incremental_since: str | None = None,
    incremental_before: str | None = None,
    source_object_keys: list[str] | None = None,
    source_object_inventory: list[dict[str, Any]] | None = None,
    *,
    source_window_rebaseline: bool = False,
    source_iceberg_table: dict[str, Any] | None = None,
) -> dict[str, Any]:
    compiled_rules = compile_job_rules(job)
    require_compiled_rules(compiled_rules)
    canonical_rules = [
        rule.model_dump(mode="json", by_alias=True)
        for rule in compiled_rules.result.rules
    ]
    return {
        "id": job.id,
        "name": job.name,
        "owner": job.owner,
        "partition": job.partition,
        "qualityInvalidRows": job.quality_invalid_rows or [],
        "qualityRules": [
            rule.model_dump(mode="json", by_alias=True)
            for rule in compiled_rules.quality_rules
        ],
        "qualityScore": job.quality_score,
        "qualityStatus": job.quality_status,
        "rag": job.rag,
        "ruleContractVersion": compiled_rules.result.contract_version,
        "ruleOutputSchema": compiled_rules.result.output_schema,
        "rules": canonical_rules,
        "ruleFingerprint": canonical_rule_fingerprint(
            compiled_rules.result.contract_version,
            canonical_rules,
        ),
        "recordParsing": job.record_parsing or None,
        "schedule": job.schedule,
        "schemaColumns": job.schema_columns or [],
        "schemaFingerprint": job.schema_fingerprint,
        "schemaSampleRows": job.schema_sample_rows or [],
        "source": job.source,
        "sourceConfig": job.source_config or [],
        "sourceIncrementalBefore": incremental_before,
        "sourceIncrementalSince": incremental_since,
        "sourceObjectKeys": source_object_keys,
        "sourceObjectInventory": source_object_inventory,
        "sourceWindowContractVersion": SOURCE_WINDOW_CONTRACT_VERSION if source_uses_incremental_folder_window(job) else None,
        "sourceWindowRebaseline": source_window_rebaseline,
        "sourceLabel": job.source_label,
        "sourceIcebergTable": source_iceberg_table,
        "sourceType": job.source_type,
        "stats": job.stats or {},
        "target": job.target,
        "targetDescription": job.target_description,
        "targetFormat": job.target_format,
        "targetLayer": job.target_layer,
        "targetPath": job.target_path,
        "targetTags": job.target_tags or [],
        "storagePath": job.storage_path,
        "icebergTarget": job.iceberg_target,
        "storageType": job.storage_type,
        "partition": job.partition,
        "partitionColumns": job.partition_columns or [],
        "indexColumns": job.index_columns or [],
        "compression": job.compression,
        "transformOutputColumns": compiled_rules.result.output_schema,
        "transformSteps": [
            step.model_dump(mode="json", by_alias=True)
            for step in compiled_rules.transform_steps
        ],
    }


def source_incremental_since(db: Session, job: ETLJobModel, current_run_id: str) -> str | None:
    if not source_uses_incremental_folder_window(job):
        return None
    successful_runs = [
        run
        for run in etl_repository.list_run_models_for_job(db, job.id)
        if run.run_id != current_run_id
        and run.status == "success"
        and str(run.started_at or "").strip() not in {"", "-"}
    ]
    if not successful_runs:
        return None
    latest_successful_run = max(successful_runs, key=lambda run: str(run.started_at))
    dataset_id = str(getattr(job, "dataset_id", "") or "").strip()
    dataset = etl_repository.get_dataset_by_id(db, dataset_id) if dataset_id else None
    payload = dataset.payload if dataset is not None and isinstance(dataset.payload, dict) else {}
    materialization_runs = payload.get("materializationRuns")
    matching_run = next((
        run
        for run in materialization_runs
        if isinstance(run, dict) and str(run.get("runId") or "") == str(latest_successful_run.run_id)
    ), None) if isinstance(materialization_runs, list) else None
    if matching_run is None or not has_bounded_source_window(matching_run):
        return None
    window = materialization_source_window(matching_run) or {}
    object_keys = window.get("objectKeys") if "objectKeys" in window else window.get("object_keys")
    if not isinstance(object_keys, list):
        return None
    return str(window.get("upperBound") or window.get("upper_bound") or "").strip() or None


def source_incremental_window(
    db: Session,
    job: ETLJobModel,
    current_run_id: str,
) -> tuple[str | None, str | None]:
    if not source_uses_incremental_folder_window(job):
        return None, None
    lower_bound = source_incremental_since(db, job, current_run_id)
    current_run = etl_repository.get_run_model(db, current_run_id)
    upper_bound = (
        str(current_run.started_at)
        if current_run and str(current_run.started_at or "").strip() not in {"", "-"}
        else None
    )
    return lower_bound, upper_bound


def incremental_source_object_inventory(
    db: Session,
    job: ETLJobModel,
    *,
    incremental_since: str | None,
    incremental_before: str | None,
    s3_client: Any | None = None,
) -> list[dict[str, Any]] | None:
    if not source_uses_incremental_folder_window(job):
        return None
    inventory = list_incremental_s3_object_inventory(
        job,
        incremental_since=incremental_since,
        incremental_before=incremental_before,
        s3_client=s3_client,
    )
    current_keys = [str(item["key"]) for item in inventory]
    if incremental_since:
        previous_keys = prior_incremental_source_object_keys(db, job)
        duplicate_keys = sorted(set(current_keys).intersection(previous_keys))
        if duplicate_keys:
            raise ApiError(
                "SOURCE_OBJECT_KEY_REPLACED",
                "Incremental folder collection accepts new object keys only; replace the dataset with a full run after modifying an existing key.",
                status.HTTP_409_CONFLICT,
                {
                    "duplicateObjectKeys": duplicate_keys[:20],
                    "duplicateObjectCount": len(duplicate_keys),
                    "jobId": job.id,
                },
            )
    return inventory


def incremental_source_object_keys(
    db: Session,
    job: ETLJobModel,
    *,
    incremental_since: str | None,
    incremental_before: str | None,
    s3_client: Any | None = None,
) -> list[str] | None:
    inventory = incremental_source_object_inventory(
        db,
        job,
        incremental_since=incremental_since,
        incremental_before=incremental_before,
        s3_client=s3_client,
    )
    return [str(item["key"]) for item in inventory] if inventory is not None else None


def list_incremental_s3_object_keys(
    job: ETLJobModel,
    *,
    incremental_since: str | None,
    incremental_before: str | None,
    s3_client: Any | None = None,
) -> list[str]:
    return [
        str(item["key"])
        for item in list_incremental_s3_object_inventory(
            job,
            incremental_since=incremental_since,
            incremental_before=incremental_before,
            s3_client=s3_client,
        )
    ]


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


def prior_incremental_source_object_keys(db: Session, job: ETLJobModel) -> set[str]:
    dataset_id = str(getattr(job, "dataset_id", "") or "").strip()
    dataset = etl_repository.get_dataset_by_id(db, dataset_id) if dataset_id else None
    payload = dataset.payload if dataset is not None and isinstance(dataset.payload, dict) else {}
    runs = payload.get("materializationRuns")
    active_runs = active_materialization_runs(
        run for run in runs if isinstance(run, dict)
    ) if isinstance(runs, list) else []
    return {
        str(key)
        for run in active_runs
        for window in [materialization_source_window(run) or {}]
        for key in (window.get("objectKeys") or window.get("object_keys") or [])
        if str(key).strip()
    }


def allows_unconfigured_s3_source() -> bool:
    return str(getattr(settings, "app_env", "local") or "local").strip().casefold() in {
        "dev",
        "development",
        "local",
        "test",
    }


def sync_airflow_runs_for_job(db: Session, job: ETLJobModel) -> None:
    runs = etl_repository.list_run_models_for_job(db, job.id)
    dataset_id = job.dataset_id or make_dataset_id(job.target)
    dataset = etl_repository.get_dataset_by_id(db, dataset_id)
    repaired_success = repair_incomplete_airflow_successes(runs, dataset)
    active_runs = [
        run
        for run in runs
        if run.status in ACTIVE_RUN_STATUSES and run.airflow_dag_run_id
    ]
    if not active_runs:
        if repaired_success and runs:
            apply_job_state_from_latest_run(job, runs[0])
            job.stats = stats_from_runs(job, [etl_repository.run_to_schema(run) for run in runs])
            etl_repository.save_job(db, job)
        return

    try:
        airflow_client = build_airflow_client()
    except ApiError as exc:
        sync_error = exc.message
        synced_at = iso_now()
        locked_job = etl_repository.get_job_for_update(db, job.id)
        if locked_job is None:
            db.rollback()
            return
        for active_run in sorted(active_runs, key=lambda item: item.run_id):
            locked_run = etl_repository.get_run_model(db, active_run.run_id)
            if locked_run is None:
                continue
            etl_repository.refresh_run_for_update(db, locked_run)
            locked_run.sync_error = sync_error
            locked_run.last_synced_at = synced_at
        job = locked_job
        job.last_state = f"Airflow 상태 동기화 실패 · {sync_error}"
        etl_repository.save_job(db, job)
        return

    for run in active_runs:
        sync_airflow_run(db, job, run, airflow_client, dataset)

    job = etl_repository.get_job_for_update(db, job.id)
    if job is None:
        db.rollback()
        return
    runs = etl_repository.list_run_models_for_job(db, job.id)
    latest_run = runs[0]
    apply_job_state_from_latest_run(job, latest_run)
    job.stats = stats_from_runs(job, [etl_repository.run_to_schema(run) for run in runs])
    etl_repository.save_job(db, job)


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


def run_node_bridge(
    script_name: str,
    success_marker: str,
    payload: dict[str, Any],
    *,
    error_marker: str,
    timeout_seconds: int,
    timeout_recovery: Callable[[], dict[str, Any]] | None = None,
    bridge: NodeBridgePort | None = None,
) -> dict[str, Any]:
    runtime_bridge = bridge or SubprocessNodeBridge(
        backend_dir=BACKEND_DIR,
        scripts_dir=SCRIPTS_DIR,
    )
    return runtime_bridge.execute(
        script_name,
        success_marker,
        payload,
        error_marker=error_marker,
        timeout_seconds=timeout_seconds,
        timeout_recovery=timeout_recovery,
    )


def recover_spark_rest_submission(
    state_file: Path,
    *,
    bridge: NodeBridgePort | None = None,
) -> dict[str, Any]:
    try:
        return run_node_bridge(
            "spark-rest-client.mjs",
            "ASKLAKE_SPARK_REST_RECOVERY",
            {
                "operation": "kill-state",
                "restUrl": os.environ.get("ASKLAKE_SPARK_REST_URL") or "http://spark-master:6066",
                "stateFile": str(state_file),
            },
            error_marker="ASKLAKE_SPARK_REST_ERROR",
            timeout_seconds=10,
            bridge=bridge,
        )
    except ApiError as exc:
        raise RuntimeError(exc.message) from exc


def spark_rest_mode_enabled() -> bool:
    return str(os.environ.get("ASKLAKE_SPARK_RUNNER") or "").strip().lower() == "rest"


def spark_rest_poll_timeout_ms() -> int:
    timeout_seconds = bounded_environment_integer(
        "ASKLAKE_SPARK_RUN_TIMEOUT_SECONDS",
        default=7200,
        minimum=1,
        maximum=24 * 60 * 60,
    )
    return timeout_seconds * 1000


def spark_python_bridge_timeout_seconds(poll_timeout_ms: int) -> int:
    poll_timeout_seconds = (max(1000, int(poll_timeout_ms)) + 999) // 1000
    return poll_timeout_seconds + (2 * SPARK_REST_BRIDGE_GRACE_SECONDS)


def continuous_maintenance_poll_timeout_ms() -> int:
    return bounded_environment_integer(
        "ASKLAKE_CONTINUOUS_MAINTENANCE_TIMEOUT_MS",
        default=540_000,
        minimum=1000,
        maximum=24 * 60 * 60 * 1000,
    )


def continuous_maintenance_bridge_timeout_seconds(poll_timeout_ms: int) -> int:
    poll_timeout_seconds = (max(1000, int(poll_timeout_ms)) + 999) // 1000
    return poll_timeout_seconds + SPARK_REST_BRIDGE_GRACE_SECONDS


def spark_rest_submission_state_file(run_id: str) -> Path:
    report_dir = Path(os.environ.get("ASKLAKE_SPARK_REPORT_DIR") or BACKEND_DIR / "tmp" / "spark-runs")
    if not report_dir.is_absolute():
        report_dir = BACKEND_DIR / report_dir
    safe_run_id = re.sub(r"[^a-zA-Z0-9_.-]+", "-", str(run_id)).strip("-") or "run"
    return (report_dir.resolve() / f"{safe_run_id.lower()}.spark-rest-state.json")


def continuous_maintenance_state_file(run_id: str) -> Path:
    report_dir = Path(os.environ.get("ASKLAKE_SPARK_REPORT_DIR") or BACKEND_DIR / "tmp" / "spark-runs")
    if not report_dir.is_absolute():
        report_dir = BACKEND_DIR / report_dir
    safe_run_id = re.sub(r"[^a-zA-Z0-9_.-]+", "-", str(run_id)).strip("-") or "run"
    return (report_dir.resolve() / f"kafka-continuous-maintenance-{safe_run_id.lower()}.state.json")


def continuous_maintenance_result_file(run_id: str) -> Path:
    state_path = continuous_maintenance_state_file(run_id)
    return state_path.with_name(state_path.name.replace(".state.json", ".result.json"))


def read_continuous_maintenance_result(run_id: str) -> dict[str, Any] | None:
    result = read_continuous_maintenance_result_candidate(run_id)
    if result is None:
        return None
    result_run_id = optional_string(result.get("runId"))
    if result_run_id is not None and result_run_id != run_id:
        return None
    return result


def read_continuous_maintenance_result_candidate(run_id: str) -> dict[str, Any] | None:
    result_path = continuous_maintenance_result_file(run_id)
    document = read_runtime_json(result_path)
    return dict(document.value) if document.found and document.value is not None else None


def continuous_replay_result_is_durable(result: dict[str, Any]) -> bool:
    return bool(
        nonnegative_int(result.get("storedCount"), 0) > 0
        and optional_string(result.get("outputPath"))
        and optional_string(result.get("manifestPath"))
    )


def s3_object_is_confirmed_missing(exc: Exception) -> bool:
    response = getattr(exc, "response", None)
    if not isinstance(response, dict):
        return False
    error = response.get("Error") if isinstance(response.get("Error"), dict) else {}
    metadata = (
        response.get("ResponseMetadata")
        if isinstance(response.get("ResponseMetadata"), dict)
        else {}
    )
    code = str(error.get("Code") or "").strip().casefold()
    http_status = optional_int(metadata.get("HTTPStatusCode"))
    return http_status == 404 or code in {"404", "nosuchkey", "notfound"}


def read_continuous_replay_manifest(
    job: ETLJobModel,
    run_id: str,
    *,
    manifest_port: ObjectManifestPort | None = None,
) -> tuple[str, dict[str, Any] | None, str | None]:
    """Read exact replay evidence from S3.

    ``missing`` is returned only when S3 confirms that ``_SUCCESS`` does not
    exist. Access, parsing, and identity failures are ``unavailable`` so a
    stream restart cannot overtake a replay whose Iceberg commit may exist.
    """
    target = parse_kafka_target_path(
        job.storage_path or job.target_path,
        job.target,
        job.target_layer,
    )
    bucket = target["bucket"]
    target_prefix = target["prefix"].strip("/")
    manifest_key = f"{target_prefix}/_replay-manifests/run_id={run_id}"
    manifest_path = f"s3a://{bucket}/{manifest_key}"
    try:
        iceberg_target = IcebergWriterTarget.model_validate(job.iceberg_target)
        store = manifest_port or object_manifest_port()
        try:
            store.ensure_exists(bucket, f"{manifest_key}/_SUCCESS")
        except Exception as exc:
            if s3_object_is_confirmed_missing(exc):
                return "missing", None, None
            raise
        candidate_keys = sorted(
            item.key
            for item in store.list_entries(bucket, f"{manifest_key}/")
            if item.key.rsplit("/", 1)[-1].startswith("part-")
        )
        if not candidate_keys:
            raise ValueError("Replay manifest completion marker has no payload.")
        manifest_line = ""
        for candidate_key in candidate_keys:
            text_content = store.read_text(bucket, candidate_key)
            manifest_line = next((line for line in text_content.splitlines() if line.strip()), "")
            if manifest_line:
                break
        if not manifest_line:
            raise ValueError("Replay manifest payload is empty.")
        manifest = json.loads(manifest_line)
        if not isinstance(manifest, dict):
            raise ValueError("Replay manifest payload is not an object.")
        source_ranges = normalize_kafka_source_ranges(
            manifest.get("sourceRanges") if isinstance(manifest.get("sourceRanges"), list) else None,
            required=True,
        )
        source_boundary = (
            manifest.get("sourceBoundary")
            if isinstance(manifest.get("sourceBoundary"), dict)
            else None
        )
        iceberg_commit = (
            manifest.get("icebergCommit")
            if isinstance(manifest.get("icebergCommit"), dict)
            else None
        )
        committed_boundary = (
            iceberg_commit.get("sourceBoundary")
            if isinstance(iceberg_commit, dict)
            and isinstance(iceberg_commit.get("sourceBoundary"), dict)
            else None
        )
        data_path = optional_string(manifest.get("dataPath"))
        if any((
            optional_string(manifest.get("publicationId")) != f"replay:{run_id}",
            optional_string(manifest.get("publicationType")) != "replay",
            optional_string(manifest.get("runId")) != run_id,
            nonnegative_int(manifest.get("storedCount"), 0) <= 0,
            data_path is None,
            data_path != iceberg_target.table_uri,
            source_boundary is None,
            source_boundary.get("kind") != "kafka_continuous_replay" if source_boundary else True,
            str(source_boundary.get("jobId") or "") != job.id if source_boundary else True,
            str(source_boundary.get("runId") or "") != run_id if source_boundary else True,
            normalize_kafka_source_ranges(
                source_boundary.get("sourceRanges") if source_boundary else None,
                required=True,
            ) != source_ranges,
            iceberg_commit is None,
            committed_boundary != source_boundary,
        )):
            raise ValueError("Replay manifest identity does not match the requested run.")
        return "found", {
            **manifest,
            "manifestPath": manifest_path,
            "outputPath": data_path,
            "runId": run_id,
            "sourceRanges": source_ranges,
        }, None
    except Exception as exc:
        return "unavailable", None, compact_storage_text(str(exc), limit=500)


def recover_continuous_replay_result(
    job: ETLJobModel | None,
    run_id: str,
    current_result: Any = None,
) -> tuple[str, dict[str, Any], str | None]:
    current = dict(current_result or {}) if isinstance(current_result, dict) else {}
    current_run_id = optional_string(current.get("runId"))
    if current_run_id is not None and current_run_id != run_id:
        return "unavailable", current, "Stored replay result has a different run identity."
    current["runId"] = run_id
    if continuous_replay_result_is_durable(current):
        return "found", current, None

    local_result = read_continuous_maintenance_result_candidate(run_id)
    if isinstance(local_result, dict):
        local_run_id = optional_string(local_result.get("runId"))
        if local_run_id is not None and local_run_id != run_id:
            return "unavailable", current, "Local replay result has a different run identity."
        recovered = {**local_result, "runId": run_id}
        if continuous_replay_result_is_durable(recovered):
            for key in ("catalogApplied", "countersApplied"):
                if key in current:
                    recovered[key] = current[key]
            return "found", recovered, None

    if job is None:
        return "unavailable", current, "Replay Job metadata is unavailable."
    state, manifest_result, reason = read_continuous_replay_manifest(job, run_id)
    if state != "found" or manifest_result is None:
        return state, current, reason
    for key in ("catalogApplied", "countersApplied"):
        if key in current:
            manifest_result[key] = current[key]
    return "found", manifest_result, None


def bounded_environment_integer(name: str, *, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.environ.get(name) or default)
    except (TypeError, ValueError):
        return default
    return value if minimum <= value <= maximum else default


def read_runtime_json(
    path: Path,
    *,
    document_store: RuntimeDocumentStore | None = None,
) -> JsonDocument:
    store = document_store or JsonFileRuntimeDocumentStore()
    return store.read_json(path)


def write_runtime_json_atomic(
    path: Path,
    payload: dict[str, Any],
    *,
    document_store: RuntimeDocumentStore | None = None,
) -> None:
    store = document_store or JsonFileRuntimeDocumentStore()
    store.write_json_atomic(path, payload)


def object_manifest_port(client: Any | None = None) -> ObjectManifestPort:
    return Boto3ObjectManifestAdapter(client or build_catalog_s3_client())


def marker_payload(output: str, marker: str) -> dict[str, Any] | None:
    prefix = f"{marker}="
    for line in reversed(str(output or "").splitlines()):
        if line.startswith(prefix):
            return json.loads(line[len(prefix):])
    return None


def persisted_stream_partition_cursors(
    db: Session | None,
    job: ETLJobModel,
    runtime: KafkaContinuousRuntimeModel,
) -> list[dict[str, Any]]:
    if db is None or not callable(getattr(db, "scalars", None)):
        cursors = (runtime.metrics or {}).get("streamPartitionCursors")
        return [dict(item) for item in cursors if isinstance(item, dict)] if isinstance(cursors, list) else []
    dataset_id = job.dataset_id or make_dataset_id(job.target)
    return DashboardLiveRepository(
        db,
        ensure_schema=False,
    ).list_stream_partition_cursors(dataset_id, topic=runtime.topic)


def merge_stream_partition_cursor_metrics(
    current: Any,
    source_ranges: Any,
) -> list[dict[str, Any]]:
    merged: dict[tuple[str, int], int] = {}
    candidates: list[tuple[dict[str, Any], str]] = []
    if isinstance(current, list):
        candidates.extend((item, "nextOffset") for item in current if isinstance(item, dict))
    if isinstance(source_ranges, list):
        candidates.extend((item, "endOffset") for item in source_ranges if isinstance(item, dict))
    for item, offset_key in candidates:
        topic = str(item.get("topic") or "").strip()
        try:
            partition = int(item.get("partition"))
            next_offset = int(item.get(offset_key))
        except (TypeError, ValueError):
            continue
        if not topic or partition < 0 or next_offset < 0:
            continue
        key = (topic, partition)
        merged[key] = max(merged.get(key, 0), next_offset)
    return [
        {"topic": topic, "partition": partition, "nextOffset": next_offset}
        for (topic, partition), next_offset in sorted(merged.items())
    ]


def run_kafka_continuous_worker(
    job: ETLJobModel,
    runtime: KafkaContinuousRuntimeModel,
    action: str,
    options: dict[str, Any] | None = None,
) -> dict[str, Any]:
    config = job.continuous_config or {}
    compiled_rules = compile_job_rules(job)
    require_compiled_rules(compiled_rules)
    canonical_rules = [
        rule.model_dump(mode="json", by_alias=True)
        for rule in compiled_rules.result.rules
    ]
    if not isinstance(job.iceberg_target, dict):
        raise ApiError(
            ErrorCode.INVALID_JOB_STATE,
            "Continuous Job does not have an Iceberg target; copy the Job to create a new Continuous checkpoint.",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    rule_fingerprint = canonical_rule_fingerprint(compiled_rules.result.contract_version, canonical_rules)
    target = parse_kafka_target_path(job.storage_path or job.target_path, job.target, job.target_layer)
    output_path = f"s3a://{target['bucket']}/{target['prefix'].strip('/')}"
    return run_node_bridge(
        "manage-kafka-continuous.mjs",
        "ASKLAKE_KAFKA_CONTINUOUS_RESULT",
        {
            "action": action,
            "broker": runtime.broker,
            "checkpointPath": runtime.checkpoint_path,
            "consumerGroupId": runtime.consumer_group_id,
            "initialOffsetPolicy": config.get("initialOffsetPolicy", "earliest"),
            "initialCounts": {
                "consumedCount": runtime.consumed_count,
                "storedCount": runtime.stored_count,
                "quarantinedCount": runtime.quarantined_count,
                "failedCount": runtime.failed_count,
            },
            "initialMetrics": {
                "lag": runtime.lag,
                **(runtime.metrics or {}),
            },
            "initialSchemaState": runtime.schema_state or {},
            "streamPartitionCursors": (
                (runtime.metrics or {}).get("streamPartitionCursors")
                if isinstance((runtime.metrics or {}).get("streamPartitionCursors"), list)
                else []
            ),
            "icebergTarget": job.iceberg_target,
            "jobId": job.id,
            "maxOffsetsPerTrigger": config.get("maxOffsetsPerTrigger", 10000),
            "outputPath": output_path,
            "ruleContractVersion": compiled_rules.result.contract_version,
            "ruleFingerprint": rule_fingerprint,
            "ruleOutputSchema": compiled_rules.result.output_schema,
            "rules": canonical_rules,
            "recordParsing": job.record_parsing or None,
            "schemaColumns": job.schema_columns or [],
            "schemaFingerprint": job.schema_fingerprint or "",
            "schemaEvolutionPolicy": config.get("schemaEvolutionPolicy") or {},
            "topic": runtime.topic,
            "triggerIntervalSeconds": config.get("triggerIntervalSeconds", 30),
            **(options or {}),
        },
        error_marker="ASKLAKE_KAFKA_CONTINUOUS_ERROR",
        timeout_seconds=90 if action == "start" else 20,
    )


def get_kafka_continuous_worker_logs(
    db: Session,
    job_id: str,
    actor: ActorContext,
    tail: int,
) -> ContinuousWorkerLogsResponse:
    job = require_continuous_job_access(db, job_id, actor, "view", "GET", "continuous/logs")
    runtime = etl_repository.get_kafka_continuous_runtime(db, job.id)
    if runtime is None:
        raise ApiError(ErrorCode.NOT_FOUND, f"Continuous runtime not found: {job_id}", status.HTTP_404_NOT_FOUND)
    result = run_kafka_continuous_worker(job, runtime, "logs", {"tail": min(max(tail, 1), 1000)})
    return ContinuousWorkerLogsResponse(
        job_id=job.id,
        container_state=str(result.get("containerState") or "unknown"),
        lines=[str(line) for line in (result.get("lines") or [])],
        truncated=bool(result.get("truncated")),
    )


def list_kafka_continuous_sessions(
    db: Session,
    job_id: str,
    actor: ActorContext,
) -> list[KafkaContinuousSession]:
    job = require_continuous_job_access(db, job_id, actor, "view", "GET", "continuous/sessions")
    refresh_kafka_continuous_runtime(db, job)
    return etl_repository.list_kafka_continuous_sessions(db, job.id)


def get_kafka_continuous_session(
    db: Session,
    job_id: str,
    session_id: str,
    actor: ActorContext,
) -> KafkaContinuousSession:
    job = require_continuous_job_access(db, job_id, actor, "view", "GET", f"continuous/sessions/{session_id}")
    refresh_kafka_continuous_runtime(db, job)
    session = etl_repository.get_kafka_continuous_session(db, session_id)
    if session is None or session.job_id != job.id:
        raise ApiError(ErrorCode.NOT_FOUND, f"Continuous session not found: {session_id}", status.HTTP_404_NOT_FOUND)
    return etl_repository.continuous_session_to_schema(session)


def list_kafka_continuous_session_batches(
    db: Session,
    job_id: str,
    session_id: str,
    actor: ActorContext,
    limit: int,
) -> list[KafkaContinuousBatch]:
    job = require_continuous_job_access(db, job_id, actor, "view", "GET", f"continuous/sessions/{session_id}/batches")
    refresh_kafka_continuous_runtime(db, job)
    session = etl_repository.get_kafka_continuous_session(db, session_id)
    if session is None or session.job_id != job.id:
        raise ApiError(ErrorCode.NOT_FOUND, f"Continuous session not found: {session_id}", status.HTTP_404_NOT_FOUND)
    return etl_repository.list_kafka_continuous_batches(db, session_id, min(max(limit, 1), 500))


def get_kafka_continuous_quarantine(
    db: Session,
    job_id: str,
    actor: ActorContext,
    limit: int,
) -> ContinuousQuarantineResponse:
    job = require_continuous_job_access(db, job_id, actor, "view", "GET", "continuous/quarantine")
    locked_job = etl_repository.get_job_for_update(db, job.id)
    if locked_job is None:
        raise ApiError(ErrorCode.NOT_FOUND, f"Job not found: {job.id}", status.HTTP_404_NOT_FOUND)
    job = locked_job
    reconcile_stale_continuous_maintenance_runs(db, job.id, commit=False)
    runtime = etl_repository.lock_kafka_continuous_runtime(db, job.id)
    require_continuous_maintenance_idle(db, job, runtime=runtime)
    require_no_active_continuous_maintenance(db, job.id)
    result = run_kafka_continuous_maintenance(
        job,
        "inspect_quarantine",
        stable_id("inspect", iso_now()),
        {
            "limit": limit,
            "trustedLegacyReplayRunIds": trusted_legacy_replay_run_ids(db, job),
        },
    )
    return ContinuousQuarantineResponse(job_id=job.id, records=result.get("records") or [], total=int(result.get("total") or 0))


def list_kafka_continuous_maintenance_runs(
    db: Session,
    job_id: str,
    actor: ActorContext,
) -> list[ContinuousMaintenanceRun]:
    job = require_continuous_job_access(db, job_id, actor, "view", "GET", "continuous/maintenance-runs")
    reconcile_stale_continuous_maintenance_runs(db, job_id)
    reconcile_pending_continuous_replay_catalog(db, job)
    return etl_repository.list_kafka_continuous_maintenance_runs(db, job_id)


def replay_kafka_continuous_quarantine(
    db: Session,
    job_id: str,
    request: ContinuousReplayRequest,
    actor: ActorContext,
) -> ContinuousMaintenanceRun:
    config = request.model_dump(mode="json", by_alias=True)
    return execute_kafka_continuous_maintenance(
        db,
        job_id,
        "quarantine_replay",
        config,
        actor,
        access_action="manage" if request.approve_unknown_fields else "run",
    )


def compact_kafka_continuous_target(
    db: Session,
    job_id: str,
    request: ContinuousCompactionRequest,
    actor: ActorContext,
) -> ContinuousMaintenanceRun:
    return execute_kafka_continuous_maintenance(
        db,
        job_id,
        "compaction",
        request.model_dump(mode="json", by_alias=True),
        actor,
    )


def maintain_kafka_continuous_iceberg_target(
    db: Session,
    job_id: str,
    request: ContinuousIcebergMaintenanceRequest,
    actor: ActorContext,
) -> ContinuousMaintenanceRun:
    return execute_kafka_continuous_maintenance(
        db,
        job_id,
        "iceberg_maintenance",
        request.model_dump(mode="json", by_alias=True),
        actor,
        access_action="manage" if request.expire_snapshots or request.remove_orphan_files else "run",
    )


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


def verify_continuous_iceberg_maintenance(
    job: ETLJobModel,
    run_id: str,
    result: dict[str, Any],
    *,
    writer_service: IcebergWriterService | None = None,
) -> dict[str, Any]:
    try:
        target = IcebergWriterTarget.model_validate(job.iceberg_target)
        if str(result.get("tableUri") or "") != target.table_uri:
            raise IcebergWriterError("ICEBERG_MAINTENANCE_TARGET_MISMATCH")
        snapshot_id = str(result.get("snapshotIdAfter") or "").strip()
        if not snapshot_id:
            raise IcebergWriterError("ICEBERG_MAINTENANCE_SNAPSHOT_MISSING")
        service = writer_service or IcebergWriterService()
        evidence = service.verify_commit(
            target,
            created_table=False,
            job_id=job.id,
            run_id=run_id,
            expected_snapshot_id=snapshot_id,
        )
        data_file_count, storage_size_bytes = service.table_storage_metrics(
            target,
            snapshot_id=snapshot_id,
        )
    except (IcebergWriterError, ValueError) as exc:
        code = exc.code if isinstance(exc, IcebergWriterError) else "ICEBERG_MAINTENANCE_VERIFICATION_FAILED"
        raise ApiError(
            code,
            "Iceberg maintenance could not be verified through Trino.",
            status.HTTP_502_BAD_GATEWAY,
            {"jobId": job.id, "maintenanceRunId": run_id},
        ) from exc
    return {
        **result,
        "dataFileCount": data_file_count,
        "icebergSnapshotId": evidence.snapshot_id,
        "queryEngineTable": evidence.query_engine_table.model_dump(mode="json", by_alias=True),
        "queryEngineVerified": True,
        "storageSizeBytes": storage_size_bytes,
        "warehouseLocation": evidence.warehouse_location,
    }


def apply_continuous_replay_runtime_counters(
    runtime: KafkaContinuousRuntimeModel,
    result: dict[str, Any],
) -> None:
    if result.get("countersApplied") is True:
        return
    replayed_count = nonnegative_int(result.get("storedCount"), 0)
    runtime.stored_count = int(runtime.stored_count or 0) + replayed_count
    runtime.metrics = {
        **(runtime.metrics or {}),
        "replayedCount": nonnegative_int((runtime.metrics or {}).get("replayedCount"), 0) + replayed_count,
    }
    result["countersApplied"] = True


def reconcile_pending_continuous_replay_catalog(
    db: Session,
    job: ETLJobModel,
) -> None:
    maintenance_runs = etl_repository.list_kafka_continuous_maintenance_run_models(
        db,
        job.id,
        active_only=False,
    )
    for run in reversed(maintenance_runs):
        if run.kind != "quarantine_replay" or run.status not in {"failed", "success"}:
            continue
        result = dict(run.result or {})
        if result.get("catalogApplied") is True and result.get("countersApplied") is True:
            continue
        recovery_state, result, recovery_reason = recover_continuous_replay_result(
            job,
            run.run_id,
            result,
        )
        if recovery_state == "missing":
            if isinstance(run.result, dict) and "replayManifestRecovery" in run.result:
                result.pop("replayManifestRecovery", None)
                run.result = dict(result)
                db.add(run)
            continue
        if recovery_state == "unavailable":
            result["replayManifestRecovery"] = {
                "state": "unavailable",
                "reason": recovery_reason,
            }
            run.result = dict(result)
            run.last_error = "Replay manifest recovery is pending before the stream can restart."
            db.add(run)
            continue
        if not continuous_replay_result_is_durable(result):
            continue
        result.pop("replayManifestRecovery", None)
        result.setdefault("catalogApplied", False)
        result.setdefault("countersApplied", False)
        run.result = dict(result)
        locked_job = etl_repository.get_job_for_update(db, job.id)
        runtime = etl_repository.lock_kafka_continuous_runtime(db, job.id)
        if locked_job is None or runtime is None:
            return
        job = locked_job
        if result.get("catalogApplied") is not True:
            if not materialize_continuous_replay(db, job, runtime, result):
                continue
            result["catalogApplied"] = True
        # Catalog reconciliation commits independently. Fence the counter
        # update again and persist countersApplied with the runtime atomically.
        locked_job = etl_repository.get_job_for_update(db, job.id)
        runtime = etl_repository.lock_kafka_continuous_runtime(db, job.id)
        if locked_job is None or runtime is None:
            return
        job = locked_job
        apply_continuous_replay_runtime_counters(runtime, result)
        run.status = "success"
        run.result = dict(result)
        run.last_error = None
        db.add(run)
        etl_repository.save_kafka_continuous_command(db, job, runtime)


def record_continuous_replay_override_audit(
    db: Session,
    job: ETLJobModel,
    actor: ActorContext,
    run_id: str,
    result: str,
) -> None:
    safe_record_audit_event(
        db,
        action="etl_job.continuous_replay.unknown_fields_approved",
        actor=actor,
        api_path=f"/api/etl/jobs/{job.id}/continuous/quarantine/replays",
        http_method="POST",
        metadata={"maintenanceRunId": run_id, "policyOverride": "approve_unknown_fields"},
        result=result,
        status_code=status.HTTP_200_OK if result == "success" else status.HTTP_502_BAD_GATEWAY,
        target_id=job.id,
        target_name=job.name,
        target_type="etl_job",
    )


def run_kafka_continuous_maintenance(
    job: ETLJobModel,
    kind: str,
    run_id: str,
    config: dict[str, Any],
) -> dict[str, Any]:
    if not isinstance(job.iceberg_target, dict):
        raise ApiError(
            ErrorCode.INVALID_JOB_STATE,
            "Continuous Job does not have an Iceberg target; copy the Job to create a new Continuous checkpoint.",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    compiled_rules = compile_job_rules(job)
    require_compiled_rules(compiled_rules)
    canonical_rules = [
        rule.model_dump(mode="json", by_alias=True)
        for rule in compiled_rules.result.rules
    ]
    target = parse_kafka_target_path(job.storage_path or job.target_path, job.target, job.target_layer)
    output_path = f"s3a://{target['bucket']}/{target['prefix'].strip('/')}"
    rest_mode = spark_rest_mode_enabled()
    poll_timeout_ms = continuous_maintenance_poll_timeout_ms()
    state_file = continuous_maintenance_state_file(run_id)
    return run_node_bridge(
        "manage-kafka-continuous-maintenance.mjs",
        "ASKLAKE_KAFKA_MAINTENANCE_RESULT",
        {
            "action": "run",
            "icebergTarget": job.iceberg_target,
            "jobId": job.id,
            "kind": kind,
            "runId": run_id,
            "outputPath": output_path,
            "ruleContractVersion": compiled_rules.result.contract_version,
            "ruleFingerprint": canonical_rule_fingerprint(compiled_rules.result.contract_version, canonical_rules),
            "ruleOutputSchema": compiled_rules.result.output_schema,
            "rules": canonical_rules,
            "schemaColumns": job.schema_columns or [],
            "schemaFingerprint": job.schema_fingerprint,
            "schemaEvolutionPolicy": (job.continuous_config or {}).get("schemaEvolutionPolicy") or {},
            **config,
        },
        error_marker="ASKLAKE_KAFKA_MAINTENANCE_ERROR",
        timeout_seconds=(
            continuous_maintenance_bridge_timeout_seconds(poll_timeout_ms)
            if rest_mode
            else 600
        ),
        timeout_recovery=(lambda: recover_spark_rest_submission(state_file)) if rest_mode else None,
    )


def cleanup_kafka_continuous_maintenance(run_id: str) -> dict[str, Any]:
    return run_node_bridge(
        "manage-kafka-continuous-maintenance.mjs",
        "ASKLAKE_KAFKA_MAINTENANCE_RESULT",
        {"action": "cleanup", "runId": run_id},
        error_marker="ASKLAKE_KAFKA_MAINTENANCE_ERROR",
        timeout_seconds=20,
    )


def continuous_maintenance_lease_seconds() -> int:
    try:
        configured = int(os.environ.get("ASKLAKE_CONTINUOUS_MAINTENANCE_LEASE_SECONDS") or 900)
    except ValueError:
        configured = 900
    return max(120, min(configured, 86_400))


def continuous_maintenance_runner_stale_seconds() -> int:
    return bounded_environment_integer(
        "ASKLAKE_CONTINUOUS_MAINTENANCE_RUNNER_STALE_SECONDS",
        default=30,
        minimum=10,
        maximum=3600,
    )


def continuous_maintenance_runner_observation(run_id: str) -> dict[str, Any] | None:
    state_file = continuous_maintenance_state_file(run_id)
    document = read_runtime_json(state_file)
    if not document.found or document.value is None:
        return None
    state = document.value
    if (
        not isinstance(state, dict)
        or state.get("runner") != "rest"
        or str(state.get("runId") or "") != str(run_id)
        or not str(state.get("submissionId") or "").strip()
    ):
        return None
    updated_at = parse_maintenance_datetime(state.get("updatedAt"))
    driver_state = str(state.get("driverState") or "UNKNOWN").strip().upper() or "UNKNOWN"
    terminal = driver_state in {"ERROR", "FAILED", "FINISHED", "KILLED"}
    return {
        "driverState": driver_state,
        "submissionId": str(state.get("submissionId") or "").strip(),
        "terminal": terminal,
        "updatedAt": updated_at,
    }


def parse_maintenance_datetime(value: Any) -> datetime | None:
    normalized = optional_string(value)
    if not normalized:
        return None
    try:
        parsed = datetime.fromisoformat(normalized.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=UTC)


def persist_reconciled_maintenance_run(
    db: Session,
    run: KafkaContinuousMaintenanceRunModel,
    *,
    commit: bool,
) -> None:
    if commit:
        etl_repository.save_kafka_continuous_maintenance_run(db, run)
        return
    db.add(run)
    db.flush()


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


def require_no_active_continuous_maintenance(db: Session, job_id: str) -> None:
    active_runs = etl_repository.list_kafka_continuous_maintenance_run_models(db, job_id, active_only=True)
    if active_runs:
        raise ApiError(
            ErrorCode.CONFLICT,
            f"Continuous maintenance is already active: {active_runs[0].run_id}",
            status.HTTP_409_CONFLICT,
            {"activeRunId": active_runs[0].run_id, "kind": active_runs[0].kind},
        )


def require_continuous_job_access(
    db: Session,
    job_id: str,
    actor: ActorContext,
    action: str,
    http_method: str,
    suffix: str,
) -> ETLJobModel:
    job = etl_repository.get_job(db, job_id)
    if job is None:
        raise ApiError(ErrorCode.NOT_FOUND, f"Job not found: {job_id}", status.HTTP_404_NOT_FOUND)
    if job.execution_mode != "continuous" or not is_kafka_job(job):
        raise ApiError(ErrorCode.INVALID_JOB_STATE, "Continuous operation requires a continuous Kafka Job.", status.HTTP_422_UNPROCESSABLE_ENTITY)
    require_governed_access(
        db,
        actor,
        action=action,
        api_path=f"/api/etl/jobs/{job_id}/{suffix}",
        http_method=http_method,
        metadata={"owner": job.owner},
        resource_id=job.id,
        resource_name=job.name,
        resource_type="etl_job",
    )
    return job


def require_continuous_maintenance_idle(
    db: Session,
    job: ETLJobModel,
    *,
    runtime: KafkaContinuousRuntimeModel | None = None,
) -> None:
    runtime = runtime or etl_repository.get_kafka_continuous_runtime(db, job.id)
    if runtime is None:
        raise ApiError(
            ErrorCode.INVALID_JOB_STATE,
            "Continuous maintenance requires an initialized runtime.",
            status.HTTP_409_CONFLICT,
        )
    if runtime.status not in {"paused", "stopped"}:
        raise ApiError(
            ErrorCode.CONFLICT,
            "Pause or stop the Continuous worker before Lake maintenance.",
            status.HTTP_409_CONFLICT,
            {"runtimeStatus": runtime.status},
        )


def begin_kafka_continuous_session(
    db: Session | None,
    job: ETLJobModel,
    runtime: KafkaContinuousRuntimeModel,
) -> KafkaContinuousSessionModel | None:
    session_id = f"SESSION-{job.id}-{secrets.token_hex(6)}"
    baseline_counts = {
        "consumedCount": int(runtime.consumed_count or 0),
        "storedCount": int(runtime.stored_count or 0),
        "quarantinedCount": int(runtime.quarantined_count or 0),
        "failedCount": int(runtime.failed_count or 0),
        "lastBatchId": runtime.last_batch_id,
    }
    runtime.metrics = {
        **(runtime.metrics or {}),
        "currentSessionId": session_id,
        "currentSessionEndReason": None,
    }
    if db is None:
        return None
    session = KafkaContinuousSessionModel(
        session_id=session_id,
        job_id=job.id,
        status="starting",
        started_at=iso_now(),
        checkpoint_path=runtime.checkpoint_path,
        baseline_counts=baseline_counts,
    )
    etl_repository.stage_kafka_continuous_session(db, session)
    return session


def current_kafka_continuous_session(
    db: Session | None,
    runtime: KafkaContinuousRuntimeModel,
) -> KafkaContinuousSessionModel | None:
    if db is None:
        return None
    session_id = optional_string((runtime.metrics or {}).get("currentSessionId"))
    if session_id:
        session = etl_repository.get_kafka_continuous_session(db, session_id)
        if session is not None and session.job_id == runtime.job_id:
            return session
    return etl_repository.get_latest_active_kafka_continuous_session(db, runtime.job_id)


def fail_kafka_continuous_session(
    session: KafkaContinuousSessionModel | None,
    message: str,
    reason: str,
) -> None:
    if session is None:
        return
    session.status = "failed"
    session.ended_at = session.ended_at or iso_now()
    session.end_reason = reason
    session.failed_count = max(int(session.failed_count or 0), 1)
    session.last_error = message


def mark_kafka_continuous_session_stopping(
    db: Session | None,
    runtime: KafkaContinuousRuntimeModel,
    reason: str,
) -> None:
    runtime.metrics = {
        **(runtime.metrics or {}),
        "currentSessionEndReason": reason,
    }
    session = current_kafka_continuous_session(db, runtime)
    if session is not None and session.status not in {"stopped", "failed"}:
        session.status = "stopping"
        session.end_reason = reason


def sync_kafka_continuous_session(
    db: Session | None,
    runtime: KafkaContinuousRuntimeModel,
    payload: dict[str, Any] | None = None,
) -> None:
    session = current_kafka_continuous_session(db, runtime)
    if session is None or db is None:
        return
    if session.status in {"stopped", "failed"} and session.ended_at:
        sync_kafka_continuous_batches(db, runtime, session, payload or {})
        session.dag_steps = continuous_session_dag_steps(session, runtime, payload or {})
        db.add(session)
        return
    metrics = runtime.metrics or {}
    worker_attempt_id = optional_string((payload or {}).get("workerAttemptId")) or optional_string(metrics.get("currentWorkerAttemptId"))
    if worker_attempt_id:
        session.worker_attempt_id = worker_attempt_id
    baseline = session.baseline_counts or {}
    session.consumed_count = max(0, int(runtime.consumed_count or 0) - nonnegative_int(baseline.get("consumedCount"), 0))
    session.stored_count = max(0, int(runtime.stored_count or 0) - nonnegative_int(baseline.get("storedCount"), 0))
    session.quarantined_count = max(0, int(runtime.quarantined_count or 0) - nonnegative_int(baseline.get("quarantinedCount"), 0))
    session.failed_count = max(0, int(runtime.failed_count or 0) - nonnegative_int(baseline.get("failedCount"), 0))
    session.last_batch_id = runtime.last_batch_id or session.last_batch_id
    session.last_flush_at = runtime.last_flush_at or session.last_flush_at
    session.lag = runtime.lag
    session.last_error = runtime.last_error
    status_map = {
        "starting": "starting",
        "running": "running",
        "pausing": "stopping",
        "stopping": "stopping",
        "paused": "stopped",
        "stopped": "stopped",
        "failed": "failed",
    }
    session.status = status_map.get(runtime.status, session.status)
    if session.status in {"stopped", "failed"}:
        session.ended_at = session.ended_at or iso_now()
        session.end_reason = optional_string(metrics.get("currentSessionEndReason")) or ("worker_failed" if session.status == "failed" else "worker_stopped")
    sync_kafka_continuous_batches(db, runtime, session, payload or {})
    session.dag_steps = continuous_session_dag_steps(session, runtime, payload or {})
    db.add(session)


def sync_kafka_continuous_batches(
    db: Session,
    runtime: KafkaContinuousRuntimeModel,
    session: KafkaContinuousSessionModel,
    payload: dict[str, Any],
) -> None:
    publications = payload.get("publishedBatches")
    publications = publications if isinstance(publications, list) else []
    candidates: dict[int, dict[str, Any]] = {}
    for publication in publications:
        if not isinstance(publication, dict):
            continue
        publication_batch_id = optional_int(publication.get("batchId"))
        if publication_batch_id is not None:
            candidates[publication_batch_id] = {**publication, "status": "success"}
    last_evidence = payload.get("lastBatchEvidence")
    if not isinstance(last_evidence, dict):
        last_evidence = (runtime.metrics or {}).get("lastBatchEvidence")
    if isinstance(last_evidence, dict):
        evidence_batch_id = optional_int(last_evidence.get("batchId"))
        if evidence_batch_id is not None:
            candidates[evidence_batch_id] = last_evidence
    if not candidates:
        return
    baseline_batch_id = optional_int((session.baseline_counts or {}).get("lastBatchId"))
    latest_batch_id = optional_int(payload.get("lastBatchId"))
    latest_duration_ms = optional_int((runtime.metrics or {}).get("lastBatchDurationMs"))
    catalog_cursor = optional_int((runtime.metrics or {}).get("catalogBatchCursor"))
    for batch_id, publication in sorted(candidates.items()):
        if batch_id is None or (baseline_batch_id is not None and batch_id <= baseline_batch_id):
            continue
        status = str(publication.get("status") or "success")
        if status not in {"running", "success", "failed"}:
            status = "success"
        catalog_applied = status == "success" and catalog_cursor is not None and batch_id <= catalog_cursor
        dag_steps = continuous_batch_dag_steps(publication, status=status, catalog_applied=catalog_applied)
        iceberg_commit = publication.get("icebergCommit") if isinstance(publication.get("icebergCommit"), dict) else {}
        iceberg_target = iceberg_commit.get("target") if isinstance(iceberg_commit.get("target"), dict) else {}
        batch = KafkaContinuousBatchModel(
            id=f"{session.session_id}:{batch_id}",
            job_id=session.job_id,
            session_id=session.session_id,
            batch_id=batch_id,
            status=status,
            published_at=optional_string(publication.get("publishedAt")),
            consumed_count=nonnegative_int(publication.get("consumedCount"), 0),
            stored_count=nonnegative_int(publication.get("storedCount"), 0),
            quarantined_count=nonnegative_int(publication.get("quarantinedCount"), 0),
            duration_ms=latest_duration_ms if batch_id == latest_batch_id and latest_duration_ms is not None else optional_int(publication.get("durationMs")),
            source_ranges=publication.get("sourceRanges") if isinstance(publication.get("sourceRanges"), list) else [],
            source_boundary=publication.get("sourceBoundary") if isinstance(publication.get("sourceBoundary"), dict) else {},
            data_path=optional_string(publication.get("dataPath")),
            iceberg_snapshot_id=optional_string(iceberg_commit.get("snapshotId")),
            iceberg_table_uri=optional_string(iceberg_target.get("tableUri")),
            quarantine_path=optional_string(publication.get("quarantinePath")),
            manifest_path=optional_string(publication.get("manifestPath")),
            last_error=optional_string(publication.get("lastError")),
            dag_steps=dag_steps,
        )
        etl_repository.stage_kafka_continuous_batch(db, batch)


def continuous_batch_dag_steps(
    publication: dict[str, Any],
    *,
    status: str,
    catalog_applied: bool,
) -> list[dict[str, Any]]:
    raw_steps = publication.get("dagSteps")
    if isinstance(raw_steps, list) and raw_steps:
        steps = [dict(step) for step in raw_steps if isinstance(step, dict)]
    else:
        consumed_count = nonnegative_int(publication.get("consumedCount"), 0)
        stored_count = nonnegative_int(publication.get("storedCount"), 0)
        quarantined_count = nonnegative_int(publication.get("quarantinedCount"), 0)
        iceberg_commit = publication.get("icebergCommit") if isinstance(publication.get("icebergCommit"), dict) else {}
        iceberg_target = iceberg_commit.get("target") if isinstance(iceberg_commit.get("target"), dict) else {}
        failed_stage = optional_string(publication.get("failedStage"))
        order = ["source", "schema", "transform", "quality", "target", "manifest-checkpoint", "catalog"]
        failed_index = order.index(failed_stage) if failed_stage in order else -1

        def fallback_status(stage: str) -> str:
            index = order.index(stage)
            if status == "failed" and failed_index >= 0:
                if index < failed_index:
                    return "success"
                if index == failed_index:
                    return "failed"
                return "blocked"
            if stage == "catalog":
                return "success" if catalog_applied else "pending"
            return "success" if status == "success" else "pending"

        steps = [
            {"id": "source", "title": "1. Source", "status": fallback_status("source"), "meta": f"Kafka {consumed_count:,}건 소비", "details": [["입력 행", f"{consumed_count:,}"]]},
            {"id": "schema", "title": "2. Schema", "status": fallback_status("schema"), "meta": "스키마 검증 완료", "details": []},
            {"id": "transform", "title": "3. Transform", "status": fallback_status("transform"), "meta": "규칙 실행 결과", "details": []},
            {"id": "quality", "title": "4. Quality", "status": fallback_status("quality"), "meta": "품질 검사 결과", "details": []},
            {"id": "target", "title": "5. Target", "status": fallback_status("target"), "meta": f"Iceberg {stored_count:,}건 커밋", "details": [["출력 행", f"{stored_count:,}"], ["격리 행", f"{quarantined_count:,}"], ["Table", str(iceberg_target.get("tableUri") or "-")], ["Snapshot", str(iceberg_commit.get("snapshotId") or "-")]]},
            {"id": "manifest-checkpoint", "title": "6. Manifest / Checkpoint", "status": fallback_status("manifest-checkpoint"), "meta": "publication과 offset 근거 저장", "details": [["Manifest", optional_string(publication.get("manifestPath")) or "-"]]},
            {"id": "catalog", "title": "7. Catalog", "status": fallback_status("catalog"), "meta": "Catalog 반영 완료" if catalog_applied else "Catalog 반영 대기", "details": []},
        ]
    completed_at = optional_string(publication.get("publishedAt"))
    patched = []
    for step in steps:
        next_step = dict(step)
        if next_step.get("id") == "catalog" and status == "success":
            next_step["status"] = "success" if catalog_applied else "pending"
            next_step["meta"] = "Catalog 반영 완료" if catalog_applied else "Catalog 반영 대기"
            next_step["details"] = [["상태", "반영 완료" if catalog_applied else "반영 대기"]]
            if catalog_applied and completed_at:
                next_step["completedAt"] = completed_at
            elif not catalog_applied:
                next_step.pop("completedAt", None)
        patched.append(next_step)
    return patched


def continuous_session_dag_steps(
    session: KafkaContinuousSessionModel,
    runtime: KafkaContinuousRuntimeModel,
    payload: dict[str, Any],
) -> list[dict[str, Any]]:
    evidence = payload.get("lastBatchEvidence")
    if not isinstance(evidence, dict):
        evidence = (runtime.metrics or {}).get("lastBatchEvidence")
    if not isinstance(evidence, dict):
        publications = payload.get("publishedBatches")
        evidence = next((item for item in reversed(publications) if isinstance(item, dict)), None) if isinstance(publications, list) else None
    baseline_batch_id = optional_int((session.baseline_counts or {}).get("lastBatchId"))
    evidence_batch_id = optional_int(evidence.get("batchId")) if isinstance(evidence, dict) else None
    if baseline_batch_id is not None and evidence_batch_id is not None and evidence_batch_id <= baseline_batch_id:
        evidence = None
    if not isinstance(evidence, dict):
        source_status = "running" if session.status in {"starting", "running", "stopping"} else "failed" if session.status == "failed" else "success"
        source_logs = [session.last_error] if session.last_error and source_status == "failed" else []
        return [
            {"id": "source", "title": "1. Source", "status": source_status, "meta": "Kafka worker 연결 및 소비 대기", "details": [["세션 소비", f"{session.consumed_count:,}"]], "logs": source_logs},
            {"id": "schema", "title": "2. Schema", "status": "blocked" if source_status == "failed" else "pending", "meta": "첫 batch 대기", "details": []},
            {"id": "transform", "title": "3. Transform", "status": "blocked" if source_status == "failed" else "pending", "meta": "첫 batch 대기", "details": []},
            {"id": "quality", "title": "4. Quality", "status": "blocked" if source_status == "failed" else "pending", "meta": "첫 batch 대기", "details": []},
            {"id": "target", "title": "5. Target", "status": "blocked" if source_status == "failed" else "pending", "meta": "첫 batch 대기", "details": []},
            {"id": "manifest-checkpoint", "title": "6. Manifest / Checkpoint", "status": "blocked" if source_status == "failed" else "pending", "meta": "첫 batch 대기", "details": [["Checkpoint", session.checkpoint_path]]},
            {"id": "catalog", "title": "7. Catalog", "status": "blocked" if source_status == "failed" else "pending", "meta": "첫 batch 대기", "details": []},
        ]
    batch_id = optional_int(evidence.get("batchId"))
    catalog_cursor = optional_int((runtime.metrics or {}).get("catalogBatchCursor"))
    evidence_status = str(evidence.get("status") or "success")
    steps = continuous_batch_dag_steps(
        evidence,
        status=evidence_status,
        catalog_applied=evidence_status == "success" and batch_id is not None and catalog_cursor is not None and batch_id <= catalog_cursor,
    )
    for step in steps:
        if step.get("id") == "source":
            step["meta"] = f"세션 누적 {session.consumed_count:,}건 소비"
            step["details"] = [["세션 소비", f"{session.consumed_count:,}"], ["Kafka Lag", "-" if session.lag is None else f"{session.lag:,}"]]
            if session.status in {"starting", "running", "stopping"} and evidence_status != "failed":
                step["status"] = "running"
                step.pop("completedAt", None)
                step.pop("duration", None)
        elif step.get("id") == "target":
            step["meta"] = f"세션 누적 {session.stored_count:,}건 적재 · 격리 {session.quarantined_count:,}"
        elif step.get("id") == "manifest-checkpoint":
            details = [item for item in step.get("details", []) if isinstance(item, list) and item and item[0] != "Checkpoint"]
            step["details"] = [*details, ["Checkpoint", session.checkpoint_path]]
    if session.status == "failed" and evidence_status != "failed":
        for index, step in enumerate(steps):
            if index == 0:
                step.update({"status": "failed", "meta": "Kafka worker 실행 실패", "logs": [session.last_error or "Continuous worker failed"]})
            else:
                step["status"] = "blocked"
                step.pop("completedAt", None)
                step.pop("duration", None)
    return steps


def refresh_kafka_continuous_runtime(db: Session, job: ETLJobModel) -> None:
    reconcile_continuous_runtime(
        db,
        job,
        worker=CallableKafkaRuntimeGateway(run_kafka_continuous_worker),
        hooks=ContinuousReconciliationHooks(
            reconcile_stale_maintenance=reconcile_stale_continuous_maintenance_runs,
            reconcile_pending_replay=reconcile_pending_continuous_replay_catalog,
            report_path=continuous_runtime_report_path,
            read_report=lambda path: read_runtime_json(path),
            worker_status=continuous_worker_status,
            materialize_batch=materialize_continuous_batch,
            sync_session=sync_kafka_continuous_session,
            write_ack=write_continuous_catalog_ack,
            mark_failed=mark_continuous_runtime_failed,
            apply_report=_apply_continuous_runtime_report,
        ),
    )


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


def continuous_worker_status(job: ETLJobModel, runtime: KafkaContinuousRuntimeModel) -> dict[str, Any]:
    try:
        return run_kafka_continuous_worker(job, runtime, "status")
    except ApiError as exc:
        return {"containerState": "unknown", "error": exc.message}


def continuous_heartbeat_is_stale(heartbeat_at: str | None, job: ETLJobModel) -> bool:
    if not heartbeat_at:
        return False
    try:
        heartbeat = datetime.fromisoformat(heartbeat_at.replace("Z", "+00:00"))
    except ValueError:
        return True
    trigger_seconds = int((job.continuous_config or {}).get("triggerIntervalSeconds") or 30)
    timeout_seconds = int(os.environ.get("ASKLAKE_CONTINUOUS_HEARTBEAT_TIMEOUT_SECONDS") or max(90, trigger_seconds * 3))
    return datetime.now(UTC) - heartbeat > timedelta(seconds=timeout_seconds)


def continuous_failure_identity(
    job: ETLJobModel,
    runtime: KafkaContinuousRuntimeModel,
    worker_status: dict[str, Any],
    reason: str,
) -> str:
    worker_attempt = (
        optional_string(worker_status.get("workerAttemptId"))
        or optional_string(worker_status.get("containerId"))
        or optional_string((runtime.metrics or {}).get("currentWorkerAttemptId"))
        or optional_string(worker_status.get("containerName"))
        or job.id
    )
    return f"{worker_attempt}:{reason}"


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


def stop_stale_continuous_worker(job: ETLJobModel, runtime: KafkaContinuousRuntimeModel) -> None:
    try:
        run_kafka_continuous_worker(job, runtime, "terminate")
    except ApiError:
        # The runtime is already failed; cleanup must not hide the liveness cause.
        pass


def materialize_continuous_batch(
    db: Session,
    job: ETLJobModel,
    runtime: KafkaContinuousRuntimeModel,
    report: dict[str, Any],
    *,
    recover_completed_manifests: bool = False,
) -> int | None:
    return reconcile_continuous_publications(
        db,
        job,
        runtime,
        report,
        recover_completed_manifests=recover_completed_manifests,
        hooks=ContinuousBatchPublicationHooks(
            list_manifest_batch_ids=list_continuous_stream_manifest_batch_ids,
            read_manifest=read_continuous_stream_manifest,
            publish_one=materialize_continuous_publication,
            dataset_id=lambda current_job: current_job.dataset_id or make_dataset_id(current_job.target),
            list_partition_cursors=_list_continuous_stream_partition_cursors,
            merge_partition_cursors=merge_stream_partition_cursor_metrics,
        ),
    )


def _list_continuous_stream_partition_cursors(
    db: Session,
    dataset_id: str,
    topic: str,
) -> list[dict[str, Any]] | None:
    repository = DashboardLiveRepository(db, ensure_schema=False)
    list_cursors = getattr(repository, "list_stream_partition_cursors", None)
    if not callable(list_cursors):
        return None
    return list_cursors(dataset_id, topic=topic)


def write_continuous_catalog_ack(
    job_id: str,
    batch_id: int,
    *,
    document_store: RuntimeDocumentStore | None = None,
) -> None:
    ack_path = continuous_runtime_report_path(job_id).with_suffix(".catalog-ack.json")
    try:
        write_runtime_json_atomic(
            ack_path,
            {"batchId": batch_id, "acknowledgedAt": iso_now()},
            document_store=document_store,
        )
    except OSError:
        # Catalog remains the authority; a missed ack only makes the next
        # report include already-idempotent publications again.
        pass


def verify_continuous_publication_storage(
    data_path: str | None,
    manifest_path_value: str,
    *,
    require_data_marker: bool = True,
    manifest_port: ObjectManifestPort | None = None,
) -> None:
    paths = [("manifest", manifest_path_value)]
    if require_data_marker and data_path:
        paths.insert(0, ("data", data_path))
    object_store: ObjectManifestPort | None = manifest_port
    if any(re.match(r"^s3a?://", path, re.IGNORECASE) for _label, path in paths):
        object_store = object_store or object_manifest_port()
    for label, path in paths:
        try:
            if re.match(r"^s3a?://", path, re.IGNORECASE):
                parsed = urlparse(re.sub(r"^s3a://", "s3://", path, flags=re.IGNORECASE))
                bucket = parsed.netloc.strip()
                key = parsed.path.lstrip("/").rstrip("/")
                if not bucket or not key or object_store is None:
                    raise ValueError(f"Kafka publication {label} path is invalid")
                object_store.ensure_exists(bucket, f"{key}/_SUCCESS")
            elif not (Path(path) / "_SUCCESS").is_file():
                raise ValueError(f"Kafka publication {label} completion marker is missing")
        except ValueError:
            raise
        except Exception as exc:
            raise ValueError(
                f"Kafka publication {label} completion marker could not be verified: "
                f"{compact_storage_text(str(exc), limit=300)}"
            ) from exc


def list_continuous_stream_manifest_batch_ids(
    job: ETLJobModel,
    *,
    after_batch_id: int,
    through_batch_id: int | None,
    manifest_port: ObjectManifestPort | None = None,
) -> list[int] | None:
    """List completed stream manifests after the cursor, optionally through an upper bound."""
    target = parse_kafka_target_path(job.storage_path or job.target_path, job.target, job.target_layer)
    bucket = target["bucket"]
    target_prefix = target["prefix"].strip("/")
    manifest_prefix = f"{target_prefix}/_batch-manifests/"
    try:
        store = manifest_port or object_manifest_port()
        batch_ids: set[int] = set()
        for item in store.list_entries(bucket, manifest_prefix):
            match = re.search(
                r"(?:^|/)_batch-manifests/batch_id=(\d+)/_SUCCESS$",
                item.key,
            )
            if not match:
                continue
            batch_id = int(match.group(1))
            if after_batch_id < batch_id and (
                through_batch_id is None
                or batch_id <= through_batch_id
            ):
                batch_ids.add(batch_id)
        return sorted(batch_ids)
    except Exception:
        return None


def read_continuous_stream_manifest(
    job: ETLJobModel,
    batch_id: str,
    *,
    manifest_port: ObjectManifestPort | None = None,
) -> dict[str, Any] | None:
    """Recover a committed publication when the local worker report is incomplete."""
    target = parse_kafka_target_path(job.storage_path or job.target_path, job.target, job.target_layer)
    bucket = target["bucket"]
    target_prefix = target["prefix"].strip("/")
    manifest_key = f"{target_prefix}/_batch-manifests/batch_id={batch_id}"
    try:
        store = manifest_port or object_manifest_port()
        store.ensure_exists(bucket, f"{manifest_key}/_SUCCESS")
        candidate_keys = sorted(
            (
                item.key,
                item.size,
            )
            for item in store.list_entries(bucket, f"{manifest_key}/")
            if item.key.rsplit("/", 1)[-1].startswith("part-")
        )
        if not candidate_keys:
            return None
        for candidate_key, candidate_size in candidate_keys:
            # Spark JSON output can contain zero-byte task files before the
            # single part that owns the manifest row. Reading only the first
            # lexicographic part strands a durable batch outside Catalog.
            if candidate_size == 0:
                continue
            text_content = store.read_text(bucket, candidate_key)
            manifest_line = next((line for line in text_content.splitlines() if line.strip()), "")
            if not manifest_line:
                continue
            manifest = json.loads(manifest_line)
            if not isinstance(manifest, dict) or optional_string(manifest.get("batchId")) != batch_id:
                return None
            manifest["manifestPath"] = f"s3a://{bucket}/{manifest_key}"
            if nonnegative_int(manifest.get("storedCount"), 0) > 0:
                manifest.setdefault(
                    "dataPath",
                    f"s3a://{bucket}/{target_prefix}/_batches/batch_id={batch_id}",
                )
            return manifest
        return None
    except Exception:
        return None


def continuous_stream_publication_evidence(
    job: ETLJobModel,
    batch_id: str,
    publication: dict[str, Any],
    *,
    require_data: bool = True,
) -> tuple[str | None, str, list[dict[str, Any]], str]:
    evidence = continuous_stream_publication_metadata(
        job,
        batch_id,
        publication,
        require_data=require_data,
    )
    data_path, manifest_path_value, _source_ranges, _target_root = evidence
    # Iceberg data files do not expose a Spark `_SUCCESS` directory at the
    # table URI. The manifest marker is verified here; the exact snapshot is
    # verified through Trino by verify_spark_iceberg_result.
    verify_continuous_publication_storage(
        data_path,
        manifest_path_value,
        require_data_marker=False,
    )
    return evidence


def continuous_stream_publication_metadata(
    job: ETLJobModel,
    batch_id: str,
    publication: dict[str, Any],
    *,
    require_data: bool = True,
) -> tuple[str | None, str, list[dict[str, Any]], str]:
    target = parse_kafka_target_path(job.storage_path or job.target_path, job.target, job.target_layer)
    target_root = f"s3a://{target['bucket']}/{target['prefix'].strip('/')}"
    iceberg_target = IcebergWriterTarget.model_validate(job.iceberg_target)
    expected_data_path = iceberg_target.table_uri
    expected_manifest_path = f"{target_root}/_batch-manifests/batch_id={batch_id}"
    data_path = optional_string(publication.get("dataPath"))
    manifest_path_value = optional_string(publication.get("manifestPath"))
    source_ranges = normalize_kafka_source_ranges(
        publication.get("sourceRanges") if isinstance(publication.get("sourceRanges"), list) else None,
        required=True,
    )
    if require_data and data_path is None:
        raise ValueError("Kafka publication is missing its durable data path")
    if manifest_path_value is None:
        raise ValueError("Kafka publication is missing its committed manifest path")
    if data_path is not None and canonical_storage_path(data_path) != canonical_storage_path(expected_data_path):
        raise ValueError("Kafka publication data path does not match its batch identity")
    if canonical_storage_path(manifest_path_value) != canonical_storage_path(expected_manifest_path):
        raise ValueError("Kafka publication manifest path does not match its batch identity")
    return data_path, manifest_path_value, source_ranges, target_root


def trusted_legacy_replay_run_ids(
    db: Session,
    job: ETLJobModel,
) -> list[str]:
    dataset_id = job.dataset_id or make_dataset_id(job.target)
    dataset = etl_repository.get_dataset_by_id(db, dataset_id)
    runs = ((dataset.payload or {}).get("materializationRuns") or []) if dataset is not None else []
    trusted: set[str] = set()
    for run in runs:
        if not isinstance(run, dict) or str(run.get("status") or "").strip().lower() != "success":
            continue
        if optional_string(run.get("publicationManifest")):
            continue
        storage_location = optional_string(run.get("storageLocation"))
        if storage_location is None:
            continue
        match = re.search(r"/batch_id=replay_([^/]+)$", canonical_storage_path(storage_location))
        if match:
            trusted.add(match.group(1))
    return sorted(trusted)


def materialize_continuous_publication(
    db: Session,
    job: ETLJobModel,
    runtime: KafkaContinuousRuntimeModel,
    publication: dict[str, Any],
) -> bool:
    return execute_continuous_publication(
        db,
        job,
        runtime,
        publication,
        hooks=ContinuousPublicationHooks(
            prepare=_prepare_continuous_publication,
            verify_output=_verify_continuous_publication_output,
            verify_manifest=_verify_continuous_publication_manifest,
            register_catalog=_register_continuous_publication_catalog,
            publish_dashboard=_publish_continuous_dashboard_revision,
            update_job_stats=_update_continuous_publication_stats,
            compact_error=lambda value: compact_storage_text(str(value), limit=500),
        ),
    )


def _prepare_continuous_publication(
    job: ETLJobModel,
    _runtime: KafkaContinuousRuntimeModel,
    publication: dict[str, Any],
    identity: PublicationIdentity,
) -> PublicationInputEvidence:
    data_path, manifest_path_value, source_ranges, _target_root = continuous_stream_publication_metadata(
        job,
        str(identity.batch_id),
        publication,
        require_data=nonnegative_int(publication.get("storedCount"), 0) > 0,
    )
    return PublicationInputEvidence(
        data_path=data_path,
        manifest_path=manifest_path_value,
        source_ranges=source_ranges,
    )


def _verify_continuous_publication_output(
    job: ETLJobModel,
    runtime: KafkaContinuousRuntimeModel,
    publication: dict[str, Any],
    identity: PublicationIdentity,
    inputs: PublicationInputEvidence,
) -> PublicationOutputEvidence:
    if inputs.data_path is None:
        raise ValueError("Kafka publication is missing its durable data path")
    target = IcebergWriterTarget.model_validate(job.iceberg_target)
    commit = publication.get("icebergCommit") if isinstance(publication.get("icebergCommit"), dict) else None
    source_boundary = publication.get("sourceBoundary") if isinstance(publication.get("sourceBoundary"), dict) else None
    committed_boundary = (
        commit.get("sourceBoundary")
        if isinstance(commit, dict) and isinstance(commit.get("sourceBoundary"), dict)
        else None
    )
    if not commit or not source_boundary or committed_boundary != source_boundary:
        raise ValueError("Continuous publication does not include matching Iceberg source-boundary evidence.")
    if any((
        source_boundary.get("kind") != "kafka_continuous_batch",
        str(source_boundary.get("jobId") or "") != job.id,
        optional_int(source_boundary.get("batchId")) != identity.batch_id,
        str(source_boundary.get("runId") or "") != identity.run_id,
        str(source_boundary.get("checkpointPath") or "").rstrip("/") != str(runtime.checkpoint_path or "").rstrip("/"),
        str(source_boundary.get("consumerGroupId") or "") != runtime.consumer_group_id,
        str(source_boundary.get("topic") or "") != runtime.topic,
        normalize_kafka_source_ranges(source_boundary.get("sourceRanges"), required=True) != inputs.source_ranges,
        not str(source_boundary.get("boundaryId") or "").strip(),
    )):
        raise ValueError("Continuous publication source boundary does not match the persisted runtime.")
    stored_count = nonnegative_int(publication.get("storedCount"), 0)
    result = {
        "endedAt": optional_string(publication.get("publishedAt")) or runtime.last_flush_at or runtime.heartbeat_at or iso_now(),
        "icebergCommit": commit,
        "materializationRows": stored_count,
        "outputPath": target.table_uri,
        "outputRows": runtime.stored_count,
        "publicationManifest": inputs.manifest_path,
        "quality": publication.get("quality") if isinstance(publication.get("quality"), dict) else {},
        "ruleContractVersion": optional_string(publication.get("ruleContractVersion")),
        "ruleFingerprint": optional_string(publication.get("ruleFingerprint")),
        "runId": identity.run_id,
        "runtimeFingerprint": optional_string(publication.get("runtimeFingerprint")),
        "schemaFingerprint": optional_string(publication.get("schemaFingerprint")),
        "sourceBoundary": source_boundary,
        "sourceKind": "kafka",
        "sourceRanges": inputs.source_ranges,
        "status": "success",
        "transform": publication.get("transform") if isinstance(publication.get("transform"), dict) else {},
    }
    verified = verify_spark_iceberg_result(
        job,
        identity.run_id,
        result,
        expected_run_row_count=stored_count,
    )
    return PublicationOutputEvidence(
        target_uri=target.table_uri,
        verified_result={**verified, "sourceBoundary": source_boundary},
    )


def _verify_continuous_publication_manifest(
    _job: ETLJobModel,
    _publication: dict[str, Any],
    inputs: PublicationInputEvidence,
) -> None:
    verify_continuous_publication_storage(
        inputs.data_path,
        inputs.manifest_path,
        require_data_marker=False,
    )


def _register_continuous_publication_catalog(
    db: Session,
    job: ETLJobModel,
    _runtime: KafkaContinuousRuntimeModel,
    publication: dict[str, Any],
    identity: PublicationIdentity,
    _inputs: PublicationInputEvidence,
    output: PublicationOutputEvidence | None,
) -> PublicationCatalogEvidence:
    dataset_id = job.dataset_id or make_dataset_id(job.target)
    if output is None:
        return PublicationCatalogEvidence(
            dataset_id=dataset_id,
            materialization_mode="delta",
            catalog_created=False,
            catalog_skipped=True,
        )
    live_repository = DashboardLiveRepository(db, ensure_schema=False)
    live_repository.lock_dataset_publication_identity(dataset_id)
    existing = etl_repository.get_dataset_by_id_for_update(db, dataset_id)
    existing_runs = (
        ((existing.payload or {}).get("materializationRuns") or [])
        if existing and existing.payload
        else []
    )
    existing_run = next(
        (
            item
            for item in existing_runs
            if isinstance(item, dict) and str(item.get("runId") or "") == identity.run_id
        ),
        None,
    )
    target = IcebergWriterTarget.model_validate(job.iceberg_target)
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
    computed_mode = "delta" if same_mapping else "snapshot"
    existing_mode = str((existing_run or {}).get("materializationMode") or "").strip().lower()
    materialization_mode = existing_mode if existing_mode in {"delta", "snapshot"} else computed_mode
    verified = {
        **output.verified_result,
        "materializationMode": materialization_mode,
    }
    catalog_created = existing_run is None
    if catalog_created:
        etl_repository.save_dataset(
            db,
            dataset_from_spark_result(job, verified, existing),
        )
    else:
        # Release the publication identity lock before Dashboard publication.
        db.commit()
    return PublicationCatalogEvidence(
        dataset_id=dataset_id,
        materialization_mode=materialization_mode,
        catalog_created=catalog_created,
    )


def _publish_continuous_dashboard_revision(
    db: Session,
    job: ETLJobModel,
    _runtime: KafkaContinuousRuntimeModel,
    publication: dict[str, Any],
    identity: PublicationIdentity,
    inputs: PublicationInputEvidence,
    output: PublicationOutputEvidence | None,
    catalog: PublicationCatalogEvidence,
) -> None:
    live_repository = DashboardLiveRepository(db, ensure_schema=False)
    live_repository.lock_dataset_publication_identity(catalog.dataset_id)
    if output is None:
        live_repository.record_stream_progress(catalog.dataset_id, inputs.source_ranges)
        db.commit()
        return
    dataset = etl_repository.get_dataset_by_id_for_update(db, catalog.dataset_id)
    if dataset is None:
        raise ValueError("Catalog dataset is missing after Continuous materialization.")
    existing_runs = ((dataset.payload or {}).get("materializationRuns") or []) if dataset.payload else []
    existing_run = next(
        (
            item
            for item in existing_runs
            if isinstance(item, dict) and str(item.get("runId") or "") == identity.run_id
        ),
        None,
    )
    if existing_run is None:
        raise ValueError("Catalog materialization run is missing before Dashboard publication.")
    next_check_after_ms = recommended_dashboard_poll_ms(
        (job.continuous_config or {}).get("triggerIntervalSeconds")
    )
    existing_commit = live_repository.commit_by_run_id(identity.run_id)
    if existing_commit is None and not catalog.catalog_created:
        # A Catalog run that predates the staged workflow becomes a safe full
        # Dashboard baseline before later stream deltas are applied.
        backfill_catalog_revision(
            db,
            dataset_id=dataset.id,
            run_id=identity.run_id,
            storage_location=str(output.verified_result["materializationOutputPath"]),
            storage_format="iceberg",
            materialization_mode="snapshot",
            row_count=nonnegative_int(existing_run.get("rowCount"), nonnegative_int(publication.get("storedCount"), 0)),
            next_check_after_ms=next_check_after_ms,
            source_ranges=inputs.source_ranges,
            manifest_location=inputs.manifest_path,
        )
        return
    existing_commit_kind = str(
        existing_commit.get("commit_kind")
        if isinstance(existing_commit, dict)
        else getattr(existing_commit, "commit_kind", "")
    )
    if existing_commit is None or existing_commit_kind == STREAM_COMMIT_KIND:
        live_repository.record_dataset_commit(
            dataset_id=dataset.id,
            run_id=identity.run_id,
            storage_location=str(output.verified_result["materializationOutputPath"]),
            storage_format="iceberg",
            materialization_mode=catalog.materialization_mode,
            row_count=nonnegative_int(publication.get("storedCount"), 0),
            next_check_after_ms=next_check_after_ms,
            source_ranges=inputs.source_ranges,
            commit_kind=STREAM_COMMIT_KIND,
            manifest_location=inputs.manifest_path,
        )
    db.commit()


def _update_continuous_publication_stats(
    job: ETLJobModel,
    runtime: KafkaContinuousRuntimeModel,
    output: PublicationOutputEvidence | None,
) -> None:
    if output is None:
        return
    job.stats = {
        **(job.stats or {}),
        "inputRows": format_rows(runtime.consumed_count),
        "lastSuccess": runtime.last_flush_at or runtime.heartbeat_at or "-",
        "outputPath": output.target_uri,
        "outputRows": format_rows(runtime.stored_count),
        "icebergSnapshotId": str(output.verified_result.get("icebergCommit", {}).get("snapshotId") or ""),
        "sampleScope": f"{runtime.topic} continuous micro-batch",
        "sourceUnits": "Kafka topic",
        "successRate": "100%" if runtime.failed_count == 0 else "확인 필요",
    }


def normalize_continuous_source_ranges(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return sorted(
        [
            {
                "endOffset": int(item.get("endOffset") or 0),
                "partition": int(item.get("partition") or 0),
                "startOffset": int(item.get("startOffset") or 0),
                "topic": str(item.get("topic") or ""),
            }
            for item in value
            if isinstance(item, dict)
        ],
        key=lambda item: (item["topic"], item["partition"]),
    )


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


def continuous_runtime_report_path(job_id: str) -> Path:
    safe_job_id = re.sub(r"[^a-z0-9_.-]+", "-", job_id.lower()).strip("-") or "job"
    report_dir = Path(os.environ.get("ASKLAKE_SPARK_REPORT_DIR") or BACKEND_DIR / "tmp" / "spark-runs")
    return report_dir / f"kafka-continuous-{safe_job_id}.json"


def optional_string(value: Any) -> str | None:
    text = str(value or "").strip()
    return text or None


def optional_int(value: Any) -> int | None:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def nonnegative_int(value: Any, fallback: int) -> int:
    parsed = optional_int(value)
    return parsed if parsed is not None and parsed >= 0 else fallback


def has_successful_run(db: Session, job_id: str) -> bool:
    return any(run.status == "success" for run in etl_repository.list_runs_for_job(db, job_id))


def trino_sql_job_run_as_actor(db: Session, job: ETLJobModel) -> ActorContext:
    recipe = job.sql_recipe if isinstance(job.sql_recipe, dict) else {}
    legacy_run_as = recipe.get("runAs") if isinstance(recipe.get("runAs"), dict) else {}
    user_id = str(recipe.get("runAsUserId") or legacy_run_as.get("id") or "").strip()
    if user_id:
        current_actor = load_active_actor_by_user_id(db, user_id)
        if current_actor is None:
            if settings.allows_header_auth_fallback:
                # Header-auth development may not have a durable AuthUser row.
                # Preserve only the submitted identity key; never reuse a
                # persisted role/group snapshot as execution authority.
                return ActorContext(
                    name=str(job.created_by or job.owner),
                    role="viewer",
                    groups=(),
                    id=user_id,
                )
            raise ApiError(
                ErrorCode.FORBIDDEN,
                "SQL Job execution principal is inactive or blocked",
                status.HTTP_403_FORBIDDEN,
                {"userId": user_id},
            )
        return ActorContext(
            name=str(current_actor.get("name") or job.created_by or job.owner),
            role=str(current_actor.get("role") or "viewer"),
            groups=tuple(str(group) for group in current_actor.get("groups") or []),
            id=str(current_actor.get("id") or "") or None,
            email=str(current_actor.get("email") or "") or None,
            title=str(current_actor.get("title") or "") or None,
        )

    if not settings.allows_header_auth_fallback:
        raise ApiError(
            ErrorCode.FORBIDDEN,
            "SQL Job execution principal is unavailable",
            status.HTTP_403_FORBIDDEN,
        )

    # Header-auth development predates durable auth user ids. Keep legacy jobs
    # usable at least privilege without trusting their identity snapshot.
    return ActorContext(
        name=str(job.created_by or job.owner),
        role="viewer",
        groups=(),
        id=None,
    )


def advance_scheduled_job_after_tick(db: Session, job_id: str) -> None:
    job = etl_repository.get_job(db, job_id)
    if job is None or not isinstance(job.schedule_policy, dict):
        return

    next_run_utc = next_scheduled_run_utc(job)
    if not next_run_utc:
        job.schedule_policy = {**job.schedule_policy, "nextRunUtc": ""}
        job.next_run = "-"
        job.status = "stopped"
        job.last_state = "스케줄 종료"
        etl_repository.save_job(db, job)
        return

    job.schedule_policy = {
        **job.schedule_policy,
        "nextRunUtc": next_run_utc,
    }
    job.next_run = next_run_utc
    etl_repository.save_job(db, job)


def ensure_scheduled_job_next_run(db: Session, job: ETLJobModel) -> None:
    if not has_scheduled_execution(job):
        return
    policy = dict(job.schedule_policy) if isinstance(job.schedule_policy, dict) else {}
    current_next_run = str(policy.get("nextRunUtc") or "").strip()
    if current_next_run:
        return
    next_run_utc = next_scheduled_run_utc(job)
    if not next_run_utc:
        job.schedule_policy = {**policy, "nextRunUtc": ""}
        job.next_run = "-"
        job.status = "stopped"
        job.last_state = "스케줄 종료"
        etl_repository.save_job(db, job)
        return
    job.schedule_policy = {**policy, "nextRunUtc": next_run_utc}
    job.next_run = next_run_utc
    etl_repository.save_job(db, job)
