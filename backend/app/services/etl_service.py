from datetime import UTC, datetime, timedelta
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
from types import SimpleNamespace
from typing import Any
from urllib.parse import urlparse

from fastapi import status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext, require_permission
from app.core.config import settings
from app.core.errors import ApiError
from app.core.permission_metadata import permission_grants_from_roles, resource_permissions
from app.models import (
    CatalogDatasetModel,
    ETLJobModel,
    ETLRunModel,
    KafkaContinuousBatchModel,
    KafkaContinuousMaintenanceRunModel,
    KafkaContinuousRuntimeModel,
    KafkaContinuousSessionModel,
    KafkaSnapshotModel,
)
from app.models.base import Base
from app.models.identity import AuthUserModel
from app.repositories.audit_repository import safe_record_audit_event
from app.repositories import etl_repository
from app.repositories.permission_repository import replace_permission_ui_grants
from app.schemas.common import ErrorCode
from app.schemas.etl import (
    AirflowCatalogReconciliationResponse,
    CatalogDataset,
    ContinuousCompactionRequest,
    ContinuousMaintenanceRun,
    ContinuousQuarantineResponse,
    ContinuousReplayRequest,
    ContinuousWorkerLogsResponse,
    AirflowRunExecutionResponse,
    CreatePipelineRequest,
    CreatePipelineResponse,
    JobCommandResponse,
    JobListFacets,
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
    RecordParsingColumnDraft,
    RecordParsingDraft,
    RecordParsingInvalidRow,
    RecordParsingPreviewRequest,
    RecordParsingPreviewResponse,
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
    SourceConnectorRequest,
    UpdatePipelineRequest,
)

from app.services.airflow_client import AirflowDagRun, AirflowTaskInstance, build_airflow_client
from app.services.governance_enforcement import require_governed_access
from app.services.identity_service import DEMO_GROUPS, DEMO_USERS
from app.services.resource_permission_service import job_with_persisted_permission_grants, permission_grants_for_resource, permissions_for_actor_with_governance

BACKEND_DIR = Path(__file__).resolve().parents[2]
SCRIPTS_DIR = BACKEND_DIR / "scripts"
JOB_STATUSES = ("scheduled", "failed", "running", "paused", "canceled", "stopped")
ACTIVE_RUN_STATUSES = {"queued", "running"}
TERMINAL_RUN_STATUSES = {"success", "failed", "canceled"}
SPARK_OUTPUT_FORMAT = "parquet"
PERMISSION_GROUP_ACTIONS = {
    "analytics": ["view", "query"],
    "data-platform": ["view", "run", "manage"],
    "ops": ["view", "run"],
}


def get_permission_options(db: Session, actor: ActorContext) -> PermissionOptionsResponse:
    if actor.role != "admin":
        raise ApiError(ErrorCode.FORBIDDEN, "Admin role is required", status.HTTP_403_FORBIDDEN)
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
    validate_create_request(request)
    actor_context = actor if isinstance(actor, ActorContext) else ActorContext(name=actor)
    actor_name = actor_context.name
    created_by = identity_name(request.created_by or actor_name or request.owner)
    created_by_profile = request.created_by_profile or identity_profile(created_by)
    dataset_id = f"ds_{normalize_column_name(request.target_dataset)}"
    existing_job = etl_repository.get_job_by_dataset_id(db, dataset_id) or etl_repository.get_job_by_target(db, request.target_dataset)
    if existing_job is not None:
        if existing_job.execution_mode != request.execution_mode:
            raise ApiError(
                ErrorCode.CONFLICT,
                "Kafka execution mode cannot change on an existing target. Copy the Job to use another mode.",
                status.HTTP_409_CONFLICT,
            )
        if request.execution_mode == "continuous":
            raise ApiError(
                ErrorCode.CONFLICT,
                "Continuous Job configuration is immutable. Copy the Job to create another continuous stream.",
                status.HTTP_409_CONFLICT,
            )
        update_existing_append_job(existing_job, request, dataset_id, created_by, created_by_profile)
        saved_job = etl_repository.save_job(db, existing_job)
        saved_job = persist_requested_permission_grants(db, saved_job, request.permission_grants, created_by, actor_context)
        return CreatePipelineResponse(
            catalog_target={
                "id": dataset_id,
                "layer": request.target_layer,
                "name": request.target_dataset,
                "status": "pending_run",
            },
            job=saved_job,
        )

    dataset_schema = dataset_schema_from_request(request)
    sample_rows = dataset_sample_rows_from_request(request, dataset_schema)
    metrics = source_metrics_from_request(request, dataset_schema, sample_rows)
    job_id = make_job_id(request.id or request.job_name)
    dag_steps = initial_dag_steps(request, metrics)
    stats = initial_job_stats(metrics)
    schedule_policy = schedule_policy_from_request(request)

    job = ETLJobModel(
        id=job_id,
        name=request.job_name,
        owner=request.owner,
        created_by=created_by,
        created_by_profile=created_by_profile,
        status="scheduled",
        tag="[생성]",
        source=f"{request.source_type} / {request.source_label}",
        target=request.target_dataset,
        schedule=request.schedule_label,
        schedule_policy=schedule_policy,
        schedule_summary=request.schedule_summary,
        retry_policy=request.retry_policy.model_dump(mode="json", by_alias=True) if request.retry_policy else None,
        retry_policy_summary=request.retry_policy_summary,
        run_limit_summary=request.run_limit_summary,
        source_config=tuple_rows_to_lists(request.source_config),
        source_label=request.source_label,
        source_type=request.source_type,
        execution_mode=request.execution_mode,
        continuous_config=continuous_config_from_request(request, job_id),
        record_parsing=request.record_parsing.model_dump(mode="json", by_alias=True) if request.record_parsing else None,
        schema_columns=[column.model_dump(mode="json", by_alias=True) for column in request.schema_columns],
        schema_fingerprint=request.schema_fingerprint,
        schema_sample_rows=request.schema_sample_rows,
        schema_summary=request.schema_summary,
        rule_summary=request.rule_summary,
        permission_summary=request.permission_summary,
        permission_roles=request.permission_roles,
        storage_type=request.storage_type,
        partition=request.partition,
        partition_columns=normalize_string_list(request.partition_columns),
        index_columns=normalize_string_list(request.index_columns),
        compression=request.compression,
        storage_path=request.storage_path,
        target_description=normalize_optional_text(request.target_description),
        target_database=normalize_optional_text(request.target_database),
        target_tags=normalize_target_tags(request.target_tags),
        target_format=request.target_format,
        target_layer=request.target_layer,
        target_path=request.storage_path,
        rag=request.rag,
        transform_output_columns=tuple_rows_to_lists(request.transform_output_columns),
        transform_steps=[step.model_dump(mode="json", by_alias=True) for step in request.transform_steps],
        quality_invalid_rows=request.quality_invalid_rows,
        quality_rules=[rule.model_dump(mode="json", by_alias=True) for rule in request.quality_rules],
        quality_score=request.quality_score,
        quality_status=request.quality_status,
        last_run="생성 후 미실행",
        last_state=f"{metrics['schema_columns']}개 컬럼 추론 완료",
        next_run=schedule_next_run_label(request.schedule_label, request.schedule_summary),
        progress=None,
        stats=stats,
        dag_steps=dag_steps,
        dataset_id=dataset_id,
    )

    saved_job = etl_repository.create_job(db, job)
    if request.execution_mode == "continuous":
        etl_repository.save_kafka_continuous_runtime(db, continuous_runtime_from_job(job))
        saved_job = etl_repository.get_job_schema(db, job_id) or saved_job
    saved_job = persist_requested_permission_grants(db, saved_job, request.permission_grants, created_by, actor_context)
    return CreatePipelineResponse(
        catalog_target={
            "id": dataset_id,
            "layer": request.target_layer,
            "name": request.target_dataset,
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
    for job in etl_repository.list_job_models(db):
        refresh_kafka_continuous_runtime(db, job)
    actor_context = actor or ActorContext()
    visible_jobs = [
        with_job_permissions(db, job, actor_context)
        for job in etl_repository.list_jobs(db)
    ]
    all_jobs = [normalize_list_job(job) for job in visible_jobs if job.permissions.can_view]
    selected_statuses = set(statuses or [])
    filtered_jobs = [
        job for job in all_jobs
        if (not selected_statuses or job.status in selected_statuses)
        and (not owner or job.owner == owner)
        and (not last_run_outcome or latest_run_outcome(job) == last_run_outcome)
    ]

    if schedule_kind:
        filtered_jobs = [job for job in filtered_jobs if job_schedule_kind(job.schedule) == schedule_kind]

    return JobListResponse(
        facets=JobListFacets(
            latest_run_outcome_counts={
                outcome: sum(latest_run_outcome(job) == outcome for job in all_jobs)
                for outcome in ("success", "failed", "canceled")
            },
            owners=sorted({job.owner for job in all_jobs if job.owner}),
            status_counts={status: sum(job.status == status for job in all_jobs) for status in JOB_STATUSES},
            total=len(all_jobs),
        ),
        jobs=filtered_jobs,
    )


def normalize_list_job(job: JobRowData) -> JobRowData:
    if job.status not in {"failed", "canceled", "paused"}:
        return job
    return job.model_copy(update={"status": "scheduled"})


def latest_run_outcome(job: JobRowData) -> JobRunOutcome | None:
    latest_run = (job.run_history or [None])[0]
    if latest_run is None:
        return None
    status_value = latest_run.status if hasattr(latest_run, "status") else latest_run.get("status")
    return status_value if status_value in {"success", "failed", "canceled"} else None


def sync_active_kafka_continuous_runtimes() -> None:
    """Persist continuous worker progress without depending on UI polling."""
    from app.core.database import SessionLocal

    active_statuses = {"starting", "running", "pausing", "stopping"}
    with SessionLocal() as db:
        reconcile_stale_continuous_maintenance_runs(db)
        for job in etl_repository.list_job_models(db):
            if job.execution_mode != "continuous":
                continue
            runtime = etl_repository.get_kafka_continuous_runtime(db, job.id)
            if runtime is not None and runtime.status in active_statuses:
                refresh_kafka_continuous_runtime(db, job)


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

        response = command_job(db, job.id, "run", actor_context)
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
    actor_context = actor or ActorContext()
    job_model = etl_repository.get_job(db, job_id)
    if job_model is None:
        raise ApiError(ErrorCode.NOT_FOUND, f"Job not found: {job_id}", status.HTTP_404_NOT_FOUND)
    sync_airflow_runs_for_job(db, job_model)
    refresh_kafka_continuous_runtime(db, job_model)
    job = etl_repository.get_job_schema(db, job_id)
    if job is None:
        raise ApiError(ErrorCode.NOT_FOUND, f"Job not found: {job_id}", status.HTTP_404_NOT_FOUND)
    job_with_permissions = with_job_permissions(db, job, actor_context)
    if not job_with_permissions.permissions.can_view:
        safe_record_audit_event(
            db,
            actor=actor_context,
            action="etl_job.view.forbidden",
            result="forbidden",
            target_id=job_id,
            target_type="etl_job",
            details={"reason": "missing_view_permission"},
        )
        raise ApiError(ErrorCode.FORBIDDEN, "Job access denied", status.HTTP_403_FORBIDDEN)
    return job_with_permissions


def update_pipeline(
    db: Session,
    job_id: str,
    request: UpdatePipelineRequest,
    actor: ActorContext | None = None,
) -> JobRowData:
    job = etl_repository.get_job(db, job_id)
    if job is None:
        raise ApiError(ErrorCode.NOT_FOUND, f"Job not found: {job_id}", status.HTTP_404_NOT_FOUND)

    actor_context = actor or ActorContext()
    require_governed_access(
        db,
        actor_context,
        action="manage",
        api_path=f"/api/etl/jobs/{job_id}",
        http_method="PATCH",
        metadata={"owner": job.owner},
        resource_id=job.id,
        resource_name=job.name,
        resource_type="etl_job",
    )
    require_permission(
        actor_context,
        "manage",
        owner=job.owner,
        grants=permission_grants_for_resource(
            db,
            "etl_job",
            job.id,
            permission_grants_from_roles(job.owner, job.permission_roles, default_actions=["view", "run"]),
        ),
        resource_label="job",
    )
    if job.status == "running":
        raise ApiError(ErrorCode.CONFLICT, f"Job is running and cannot be updated: {job_id}", status.HTTP_409_CONFLICT)

    validate_update_request(request)
    target_changed = target_identity_changed(job, request)
    if target_changed and has_successful_run(db, job.id):
        raise ApiError(
            ErrorCode.VALIDATION_ERROR,
            "Target dataset, database, layer, format, storage type, and path are immutable after a successful run. Clone the job to change its destination.",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )

    apply_update_request(job, request, target_changed)
    saved_job = etl_repository.save_job(db, job)
    saved_job = persist_requested_permission_grants(
        db,
        saved_job,
        request.permission_grants,
        actor_context.name,
        actor_context,
    )
    return with_job_permissions(db, saved_job, actor_context)


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


def command_job(db: Session, job_id: str, command: str, actor: ActorContext | None = None) -> JobCommandResponse:
    job = etl_repository.get_job(db, job_id)
    if job is None:
        raise ApiError(ErrorCode.NOT_FOUND, f"Job not found: {job_id}", status.HTTP_404_NOT_FOUND)

    continuous_commands = {"startContinuous", "pauseContinuous", "resumeContinuous", "stopContinuous"}
    if command not in {"run", "retry", "pause", "cancelRun", "stopSchedule", "resumeSchedule", *continuous_commands}:
        raise ApiError(ErrorCode.VALIDATION_ERROR, f"Unsupported job command: {command}", status.HTTP_400_BAD_REQUEST)
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
            grants=permission_grants_for_resource(
                db,
                "etl_job",
                job.id,
                permission_grants_from_roles(job.owner, job.permission_roles, default_actions=["view", "run"]),
            ),
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
    if command == "run" and job.status == "running":
        raise ApiError(ErrorCode.CONFLICT, f"Job is already running: {job_id}", status.HTTP_409_CONFLICT)
    if command == "pause" and job.status != "running":
        raise ApiError(
            ErrorCode.INVALID_JOB_STATE,
            f"Job cannot be paused from status: {job.status}",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    if command == "cancelRun" and job.status != "running":
        raise ApiError(
            ErrorCode.INVALID_JOB_STATE,
            f"Current run cannot be canceled from status: {job.status}",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    if command == "stopSchedule" and not has_scheduled_execution(job):
        raise ApiError(
            ErrorCode.INVALID_JOB_STATE,
            f"Job has no schedule to stop: {job_id}",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    if command == "resumeSchedule" and (job.status != "stopped" or not has_scheduled_label(job.schedule)):
        raise ApiError(
            ErrorCode.INVALID_JOB_STATE,
            f"Job has no paused schedule to resume: {job_id}",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )

    action_by_command = {
        "cancelRun": "etl.run.cancel_requested",
        "pause": "etl.job.pause_requested",
        "retry": "etl.run.retry_requested",
        "run": "etl.run.requested",
        "stopSchedule": "etl.schedule.stop_requested",
        "resumeSchedule": "etl.schedule.resume_requested",
    }

    run_schema = None
    dataset_schema = None
    run_model = None
    dataset_model = None
    if command in {"run", "retry"}:
        if is_kafka_job(job):
            run_id = stable_id("run", f"{job.id}:{command}:kafka:{iso_now()}")
            kafka_request = kafka_ingest_request_from_job(job, run_id)
            db.commit()
            try:
                result = run_kafka_ingest_request(db, kafka_request, command, job.id)
            except ApiError as exc:
                bridge_error = exc.details.get("bridge") if isinstance(exc.details, dict) else None
                result = kafka_failure_result(kafka_request, run_id, exc, bridge_error if isinstance(bridge_error, dict) else {})
            job = etl_repository.get_job(db, job_id)
            if job is None:
                raise ApiError(ErrorCode.NOT_FOUND, f"Job not found after Kafka ingest: {job_id}", status.HTTP_404_NOT_FOUND)
            run_model = run_from_kafka_result(job, result)
            run_schema = etl_repository.run_to_schema(run_model)
            finalize_job_from_kafka_result(job, command, result)
            job.dag_steps = dag_steps_from_kafka_result(job, command, run_schema.model_dump(by_alias=True), result)
        else:
            run_model = submit_airflow_job_run(job, command)
            run_schema = etl_repository.run_to_schema(run_model)
            apply_airflow_submit_job_state(job, command, run_model)
            job.dag_steps = dag_steps_from_airflow_submit(job, command, run_schema.model_dump(by_alias=True))
        job.dag_steps_by_run_id = {**(job.dag_steps_by_run_id or {}), run_schema.run_id: job.dag_steps}
        job.stats = stats_from_runs(job, [run_schema, *etl_repository.list_runs_for_job(db, job.id)])
    elif command == "cancelRun":
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
        action=action_by_command[command],
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
    if job.execution_mode != "continuous" or not is_kafka_job(job):
        raise ApiError(
            ErrorCode.INVALID_JOB_STATE,
            "Continuous commands require a Kafka Job created with executionMode=continuous.",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )

    runtime = etl_repository.lock_kafka_continuous_runtime(db, job.id) if db is not None else etl_repository.get_kafka_continuous_runtime(db, job.id)
    if runtime is None:
        runtime = continuous_runtime_from_job(job)

    action_by_command = {
        "startContinuous": "etl.continuous.start_requested",
        "pauseContinuous": "etl.continuous.pause_requested",
        "resumeContinuous": "etl.continuous.resume_requested",
        "stopContinuous": "etl.continuous.stop_requested",
    }
    active_statuses = {"starting", "running", "pausing", "stopping"}

    if command in {"startContinuous", "resumeContinuous"}:
        if runtime.status in active_statuses:
            raise ApiError(ErrorCode.CONFLICT, f"Continuous Job is already active: {job.id}", status.HTTP_409_CONFLICT)
        conflict = etl_repository.find_conflicting_kafka_continuous_runtime(
            db,
            broker=runtime.broker,
            topic=runtime.topic,
            consumer_group_id=runtime.consumer_group_id,
            excluded_job_id=job.id,
        )
        if conflict is not None:
            raise ApiError(
                ErrorCode.CONFLICT,
                f"Continuous consumer identity is already active on Job: {conflict.job_id}",
                status.HTTP_409_CONFLICT,
                {"activeJobId": conflict.job_id, "runtimeStatus": conflict.status},
            )
        snapshot_conflict = etl_repository.find_conflicting_kafka_snapshot(
            db,
            broker=runtime.broker,
            topic=runtime.topic,
            consumer_group_id=runtime.consumer_group_id,
            excluded_job_id=job.id,
        )
        if snapshot_conflict is not None:
            raise ApiError(
                ErrorCode.CONFLICT,
                f"Kafka snapshot is already active: {snapshot_conflict.snapshot_id}",
                status.HTTP_409_CONFLICT,
                {"activeSnapshotId": snapshot_conflict.snapshot_id, "activeJobId": snapshot_conflict.job_id},
            )
        session = begin_kafka_continuous_session(db, job, runtime)
        try:
            worker_result = run_kafka_continuous_worker(job, runtime, "start")
        except ApiError as exc:
            runtime.status = "failed"
            runtime.failed_count += 1
            runtime.last_error = exc.message
            fail_kafka_continuous_session(session, exc.message, "start_failed")
            job.status = "failed"
            job.last_state = "Continuous worker 시작 실패"
            etl_repository.save_kafka_continuous_command(db, job, runtime)
            raise
        worker_attempt_id = optional_string(worker_result.get("workerAttemptId")) or optional_string(worker_result.get("containerId"))
        if session is not None:
            session.worker_attempt_id = worker_attempt_id
        runtime.status = "starting"
        runtime.metrics = {
            **(runtime.metrics or {}),
            "currentWorkerAttemptId": worker_attempt_id,
        }
        runtime.last_error = None
        job.status = "running"
        job.last_state = "Continuous Spark worker 시작 요청"
        job.progress = {"label": "Continuous worker 시작 요청", "value": 5}
    elif command == "pauseContinuous":
        if runtime.status not in {"starting", "running"}:
            raise ApiError(ErrorCode.INVALID_JOB_STATE, f"Continuous Job cannot pause from: {runtime.status}", status.HTTP_422_UNPROCESSABLE_ENTITY)
        worker_result = run_kafka_continuous_worker(job, runtime, "pause")
        runtime.status = "pausing"
        mark_kafka_continuous_session_stopping(db, runtime, "paused")
        job.status = "running"
        job.last_state = "Continuous worker 마이크로배치 종료 대기"
        job.progress = {"label": "일시정지 중", "value": 95}
    else:
        if runtime.status in {"stopped", "stopping"}:
            raise ApiError(ErrorCode.INVALID_JOB_STATE, f"Continuous Job cannot stop from: {runtime.status}", status.HTTP_422_UNPROCESSABLE_ENTITY)
        worker_result = run_kafka_continuous_worker(job, runtime, "stop")
        runtime.status = "stopping"
        mark_kafka_continuous_session_stopping(db, runtime, "stopped")
        job.status = "running"
        job.last_state = "Continuous worker 중지 요청"
        job.progress = {"label": "중지 중", "value": 95}

    saved_job = etl_repository.save_kafka_continuous_command(db, job, runtime)
    return JobCommandResponse(
        action=action_by_command[command],
        api_path=f"/api/etl/jobs/{job.id}/commands",
        job=with_job_permissions(db, saved_job, actor),
        processing_result={
            "controlPlaneOnly": False,
            "runtimeStatus": runtime.status,
            "worker": "spark_structured_streaming",
            "workerResult": worker_result,
        },
    )


def with_job_permissions(db: Session, job: JobRowData, actor: ActorContext) -> JobRowData:
    job_with_grants = job_with_persisted_permission_grants(db, job)
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
    result = run_node_bridge(
        "test-source-connector.mjs",
        "ASKLAKE_SOURCE_CONNECTOR_RESULT",
        {
            "sourceConfig": request.source_config,
            "sourceType": request.source_type,
        },
        error_marker="ASKLAKE_SOURCE_CONNECTOR_ERROR",
        timeout_seconds=120,
    )
    return SourceConnectorAnalysis.model_validate(result)


def list_source_assets(request: SourceAssetsRequest) -> SourceAssetsResponse:
    result = run_node_bridge(
        "list-source-assets.mjs",
        "ASKLAKE_SOURCE_ASSETS_RESULT",
        {
            "prefix": request.prefix,
            "sourceConfig": request.source_config,
            "sourceType": request.source_type,
        },
        error_marker="ASKLAKE_SOURCE_ASSETS_ERROR",
        timeout_seconds=120,
    )
    return SourceAssetsResponse.model_validate(result)


def infer_schema(request: SourceConnectorRequest) -> SchemaDraft:
    analysis = test_source_connector(request)
    if analysis.draft_patch.schema_ is None:
        return SchemaDraft(columns=[], sample_rows=[], summary="스키마 없음")
    return analysis.draft_patch.schema_


def preview_record_parsing(request: RecordParsingPreviewRequest) -> RecordParsingPreviewResponse:
    raw_rows = [
        (line_number, line.strip())
        for line_number, line in enumerate(request.raw_lines, start=1)
        if line.strip()
    ]
    if request.record_parsing.delimiter_kind != "whitespace":
        raise ApiError(
            ErrorCode.VALIDATION_ERROR,
            "Only whitespace record parsing is supported.",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    if not raw_rows:
        empty_parsing = request.record_parsing.model_copy(update={"expected_field_count": 0, "columns": []})
        return RecordParsingPreviewResponse(
            can_apply=False,
            columns=[],
            sample_rows=[],
            record_parsing=empty_parsing,
            total_rows=0,
            valid_rows=0,
            invalid_rows=[],
        )

    tokenized_rows = [(line_number, re.split(r"\s+", line), line) for line_number, line in raw_rows]
    header_tokens: list[str] = []
    if request.record_parsing.header and tokenized_rows:
        _, header_tokens, _ = tokenized_rows.pop(0)

    configured_columns = sorted(request.record_parsing.columns, key=lambda column: column.position)
    expected_field_count = request.record_parsing.expected_field_count
    if expected_field_count == 0 and configured_columns:
        expected_field_count = len(configured_columns)
    if expected_field_count == 0:
        expected_field_count = dominant_field_count([tokens for _, tokens, _ in tokenized_rows])

    column_names = record_parsing_column_names(header_tokens, configured_columns, expected_field_count)
    valid_token_rows = [tokens for _, tokens, _ in tokenized_rows if len(tokens) == expected_field_count]
    invalid_records = [
        RecordParsingInvalidRow(
            line_number=line_number,
            expected_field_count=expected_field_count,
            actual_field_count=len(tokens),
            raw_preview=raw_line[:200],
        )
        for line_number, tokens, raw_line in tokenized_rows
        if len(tokens) != expected_field_count
    ]
    inferred_types = [
        infer_record_parsing_type([row[index] for row in valid_token_rows if index < len(row)])
        for index in range(expected_field_count)
    ]
    record_columns = [
        RecordParsingColumnDraft(
            position=index,
            name=column_names[index],
            inferred_type=(configured_columns[index].inferred_type if index < len(configured_columns) else inferred_types[index]),
        )
        for index in range(expected_field_count)
    ]
    schema_columns = [
        SchemaColumnDraft(
            confidence=90,
            nullable=False,
            source_name=column.name,
            target_name=column.name,
            type=column.inferred_type,
        )
        for column in record_columns
    ]
    unique_names = len(set(column_names)) == len(column_names) and all(column_names)
    normalized = request.record_parsing.model_copy(update={
        "enabled": True,
        "expected_field_count": expected_field_count,
        "columns": record_columns,
    })
    return RecordParsingPreviewResponse(
        can_apply=bool(expected_field_count and tokenized_rows and not invalid_records and unique_names),
        columns=schema_columns,
        sample_rows=valid_token_rows[:100],
        record_parsing=normalized,
        total_rows=len(tokenized_rows),
        valid_rows=len(valid_token_rows),
        invalid_rows=invalid_records[:20],
    )


def dominant_field_count(rows: list[list[str]]) -> int:
    counts: dict[int, int] = {}
    for row in rows:
        counts[len(row)] = counts.get(len(row), 0) + 1
    if not counts:
        return 0
    highest = max(counts.values())
    winners = [field_count for field_count, count in counts.items() if count == highest]
    return winners[0] if len(winners) == 1 else 0


def record_parsing_column_names(
    header_tokens: list[str],
    configured_columns: list[RecordParsingColumnDraft],
    expected_field_count: int,
) -> list[str]:
    names: list[str] = []
    for index in range(expected_field_count):
        raw_name = (
            configured_columns[index].name
            if index < len(configured_columns)
            else header_tokens[index] if index < len(header_tokens) else f"field_{index + 1}"
        )
        names.append(normalize_column_name(raw_name) or f"field_{index + 1}")
    return names


def infer_record_parsing_type(values: list[str]) -> str:
    non_empty = [value.strip() for value in values if value.strip()]
    if not non_empty:
        return "String"
    if all(re.fullmatch(r"-?\d+", value) for value in non_empty):
        return "Integer"
    if all(re.fullmatch(r"-?\d+(?:\.\d+)?", value) for value in non_empty):
        return "Float"
    if all(value.lower() in {"true", "false"} for value in non_empty):
        return "Boolean"
    if all(record_parsing_timestamp(value) for value in non_empty):
        return "Timestamp"
    return "String"


def record_parsing_timestamp(value: str) -> bool:
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
        return "T" in value or ":" in value
    except ValueError:
        return False


def review_pipeline(request: ReviewPipelineRequest) -> ReviewSnapshot:
    source_ready = request.source_connection_status == "success"
    if source_ready and request.source_type != "SQL Result":
        try:
            source_ready = test_source_connector(
                SourceConnectorRequest(source_type=request.source_type, source_config=request.source_config)
            ).status == "success"
        except Exception:
            source_ready = False

    included_columns = [column for column in request.schema_columns if column.included and column.target_name.strip()]
    output_columns = request.transform_output_columns or [
        (column.target_name, column.type) for column in included_columns
    ]
    schema_ready = bool(included_columns)
    record_parsing_ready = not (request.record_parsing and request.record_parsing.enabled) or (
        request.record_parsing.expected_field_count > 0
        and len(request.record_parsing.columns) == request.record_parsing.expected_field_count
        and len({normalize_column_name(column.name) for column in request.record_parsing.columns}) == len(request.record_parsing.columns)
    )
    processing_ready = bool(request.rule_summary.strip())
    continuous_rules_supported = request.execution_mode != "continuous" or (
        not any(step.enabled for step in request.transform_steps)
        and not any(rule.enabled for rule in request.quality_rules)
    )
    schedule_ready = bool(request.schedule_label.strip())
    retry_ready = bool(request.retry_policy_summary.strip())
    permission_ready = bool(request.permission_summary.strip() and request.target_dataset.strip() and request.owner.strip())
    can_create = source_ready and schema_ready and record_parsing_ready and continuous_rules_supported and bool(request.source_type.strip()) and bool(request.source_label.strip()) and bool(request.target_dataset.strip()) and bool(request.owner.strip())

    source_type = "PostgreSQL" if request.source_type == "Database" else request.source_type
    source_display = " · ".join(value for value in [source_type, request.source_label] if value.strip())

    return ReviewSnapshot(
        basic_information=[
            review_entry("작업 ID", request.id),
            review_entry("작업명", request.job_name),
            review_entry("소스", source_display),
            review_entry("실행 방식", "실시간 스트림" if request.execution_mode == "continuous" else "Snapshot batch"),
            review_entry("대상 데이터셋", request.target_dataset),
            review_entry("설명", request.target_description),
        ],
        can_create=can_create,
        destination=[
            review_entry("저장 경로", request.storage_path),
            review_entry("데이터베이스", request.target_database or "asklake"),
            review_entry("테이블 이름", request.target_dataset),
            review_entry("형식", request.target_format),
            review_entry("계층", request.target_layer),
            review_entry("파티션", request.partition or "없음"),
        ],
        permission=[
            review_entry("담당자", request.owner),
            review_entry("요약", request.permission_summary),
        ],
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
            review_validation("소스 연결", source_ready, "완료", "확인 필요"),
            *([review_validation("레코드 구조화", record_parsing_ready, "확정됨", "구조화 규칙 확인 필요")] if request.record_parsing and request.record_parsing.enabled else []),
            review_validation("스키마", schema_ready, "확정됨", "추론 필요"),
            review_validation("처리 테스트", processing_ready, "통과", "확인 필요"),
            *([review_validation("Continuous 규칙", continuous_rules_supported, "지원 범위 확인", "Continuous에서는 transform/quality rule을 제거하세요")] if request.execution_mode == "continuous" else []),
            review_validation("스트림 제어" if request.execution_mode == "continuous" else "스케줄", schedule_ready, "시작/중지로 제어" if request.execution_mode == "continuous" else "유효함", "확인 필요"),
            review_validation("실패 재시도", retry_ready, "유효함", "확인 필요"),
            review_validation("권한/타겟", permission_ready, "유효함", "확인 필요"),
        ],
    )


def review_entry(label: str, value: str | None) -> ReviewEntry:
    return ReviewEntry(label=label, value=(value or "").strip() or "미설정")


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
    try:
        result = run_node_bridge(
            "ingest-kafka-reviews.mjs",
            "ASKLAKE_KAFKA_REVIEW_INGEST_RESULT",
            request_with_snapshot,
            error_marker="ASKLAKE_KAFKA_REVIEW_INGEST_ERROR",
            timeout_seconds=max(30, int(request["timeoutMs"] / 1000) + 30),
        )
    except ApiError as exc:
        etl_repository.update_kafka_snapshot(db, snapshot_record, "failed", exc.message)
        raise
    etl_repository.update_kafka_snapshot(db, snapshot_record, "success")
    result["command"] = command
    return result


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
        "consumedCount": int(bridge_error.get("consumedCount") or 0),
        "endedAt": bridge_error.get("endedAt") or iso_now(),
        "error": bridge_error.get("message") or error.message,
        "failedCount": int(bridge_error.get("failedCount") or 0),
        "failedStage": bridge_error.get("failedStage") or "Kafka ingest",
        "runId": bridge_error.get("runId") or run_id,
        "snapshot": bridge_error.get("snapshot"),
        "startedAt": bridge_error.get("startedAt") or iso_now(),
        "status": "failed",
        "storedCount": 0,
        "targetLayer": request.get("targetLayer") or "BRONZE",
        "topic": bridge_error.get("topic") or request.get("topic"),
        "transform": bridge_error.get("transform"),
        "quality": bridge_error.get("quality"),
    }


def kafka_ingest_request_from_job(job: ETLJobModel, run_id: str) -> dict[str, Any]:
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
    return {
        "allowEmpty": True,
        "broker": field_value(fields, "Broker / Endpoint") or field_value(fields, "Broker") or "127.0.0.1:19092",
        "consumerGroupId": consumer_group_id,
        "datasetId": job.dataset_id or f"ds_{normalize_column_name(job.target)}",
        "datasetName": job.target or "reviews_raw",
        "landingBucket": target["bucket"],
        "landingEndpoint": (
            field_value(fields, "Landing Endpoint URL")
            or field_value(fields, "Target Endpoint URL")
            or os.environ.get("MINIO_ENDPOINT_IN_DOCKER")
            or os.environ.get("MINIO_ENDPOINT")
            or "http://127.0.0.1:19000"
        ),
        "landingPrefix": target["prefix"],
        "maxMessages": max_messages,
        "offsetPolicy": offset_policy,
        "registerCatalog": True,
        "runId": run_id,
        "storageMode": target["storageMode"],
        "targetBucket": target["bucket"],
        "targetDescription": job.target_description or None,
        "targetFormat": job.target_format or "jsonl",
        "targetLayer": job.target_layer or "BRONZE",
        "targetPrefix": target["prefix"],
        "timeoutMs": timeout_ms,
        "topic": topic,
        "transformSteps": job.transform_steps or [],
        "qualityRules": job.quality_rules or [],
    }


def kafka_offset_policy(value: str) -> str:
    normalized = str(value or "").strip().lower()
    if "latest" in normalized or "new" in normalized:
        return "latest"
    return "earliest"


def parse_kafka_target_path(storage_path: str | None, target_dataset: str, target_layer: str | None) -> dict[str, str]:
    default_prefix = f"{normalize_column_name(target_dataset or 'reviews_raw')}/{str(target_layer or 'BRONZE').lower()}"
    if storage_path:
        match = re.match(r"^s3a?://([^/]+)(?:/(.*))?$", storage_path.strip())
        if match:
            prefix = (match.group(2) or default_prefix).strip("/") or default_prefix
            if prefix == "kafka-landing" or prefix.startswith("kafka-landing/"):
                return {"bucket": "asklake-output", "prefix": default_prefix, "storageMode": "s3"}
            return {
                "bucket": match.group(1),
                "prefix": prefix,
                "storageMode": "s3",
            }
    return {"bucket": "asklake-output", "prefix": default_prefix, "storageMode": "s3"}


def is_kafka_job(job: ETLJobModel) -> bool:
    source_type = str(job.source_type or "").lower()
    if "kafka" in source_type:
        return True
    fields = job.source_config or []
    return bool(field_value(fields, "Broker / Endpoint") and (field_value(fields, "TOPIC / QUEUE NAME") or field_value(fields, "Topic")))


def run_spark_job(job: ETLJobModel, command: str, run_id: str) -> dict[str, Any]:
    return run_node_bridge(
        "run-spark-job-once.mjs",
        "ASKLAKE_SPARK_RUN_RESULT",
        {
            "command": command,
            "job": job_payload_for_spark(job),
            "runId": run_id,
        },
        error_marker="ASKLAKE_SPARK_RUN_ERROR",
        timeout_seconds=900,
    )


def execute_airflow_spark_run(
    db: Session,
    *,
    job_id: str,
    run_id: str,
    command: str,
) -> dict[str, Any]:
    job = etl_repository.get_job(db, job_id)
    if job is None:
        raise ApiError(ErrorCode.NOT_FOUND, f"Job not found: {job_id}", status.HTTP_404_NOT_FOUND)
    run = etl_repository.get_run_model(db, run_id)
    if run is None or run.job_id != job.id or run.airflow_dag_run_id != run_id:
        raise ApiError(
            "AIRFLOW_RUN_MISMATCH",
            "Airflow Spark execution does not match a persisted AskLake Run.",
            status.HTTP_409_CONFLICT,
            {"jobId": job_id, "runId": run_id},
        )

    existing_result = (run.task_states or {}).get("sparkResult")
    if isinstance(existing_result, dict) and existing_result.get("status") == "success":
        return existing_result

    result = run_spark_job(job, command, run_id)
    manifest = spark_result_manifest(result, run_id)
    run.input_rows = format_rows(manifest.get("inputRows"))
    run.output_rows = format_rows(manifest.get("outputRows"))
    run.output_path = manifest.get("outputPath") or run.output_path
    run.duration = format_duration_ms(manifest.get("durationMs"))
    run.ended_at = str(manifest.get("endedAt") or run.ended_at)
    run.failed_stage = "-" if manifest.get("status") == "success" else spark_failed_stage(manifest)
    run.error_summary = "-" if manifest.get("status") == "success" else spark_error_summary(manifest)
    run.task_states = {**(run.task_states or {}), "sparkResult": manifest}
    if manifest.get("status") == "success" and manifest.get("outputPath"):
        job.target_path = str(manifest["outputPath"])
    db.commit()
    return manifest


def reconcile_airflow_catalog(
    db: Session,
    *,
    job_id: str,
    run_id: str,
) -> AirflowCatalogReconciliationResponse:
    job, run = airflow_catalog_identity(db, job_id, run_id)
    dataset_id = str(job.dataset_id or "").strip()
    if not dataset_id:
        error = catalog_reconciliation_error(
            "Persisted Job does not have a target dataset id.",
            {"jobId": job_id, "runId": run_id},
        )
        persist_catalog_reconciliation_failure(db, run_id, dataset_id, error.message)
        raise error

    task_states = dict(run.task_states or {})
    catalog_result = task_states.get("catalogResult")
    if (
        isinstance(catalog_result, dict)
        and catalog_result.get("status") == "success"
        and str(catalog_result.get("runId") or "") == run_id
        and str(catalog_result.get("datasetId") or "") == dataset_id
    ):
        dataset = etl_repository.get_dataset_schema_by_id(db, dataset_id)
        if dataset is not None:
            return AirflowCatalogReconciliationResponse(
                dataset=dataset,
                reconciled_at=str(catalog_result.get("reconciledAt") or iso_now()),
                run_id=run_id,
            )

    spark_result = task_states.get("sparkResult")
    if not isinstance(spark_result, dict) or spark_result.get("status") != "success":
        raise ApiError(
            "SPARK_RESULT_NOT_READY",
            "A persisted successful Spark result is required before Catalog reconciliation.",
            status.HTTP_409_CONFLICT,
            {"jobId": job_id, "runId": run_id},
        )
    if str(spark_result.get("runId") or run_id) != run_id:
        raise ApiError(
            "AIRFLOW_RUN_MISMATCH",
            "Persisted Spark result does not match the requested Airflow Run.",
            status.HTTP_409_CONFLICT,
            {"jobId": job_id, "runId": run_id, "sparkRunId": spark_result.get("runId")},
        )

    output_path = str(spark_result.get("outputPath") or "").strip()
    try:
        validate_catalog_output_identity(job, run_id, output_path)
        physical = inspect_spark_output(output_path)
        enriched_result = {
            **spark_result,
            "parquetObjectCount": physical["parquetObjectCount"],
            "storageSizeBytes": physical["storageSizeBytes"],
        }
        return commit_airflow_catalog_reconciliation(
            db,
            job_id=job_id,
            run_id=run_id,
            result=enriched_result,
            retry_on_create_conflict=True,
        )
    except ApiError as exc:
        if str(exc.code) == "CATALOG_RECONCILIATION_FAILED":
            persist_catalog_reconciliation_failure(db, run_id, dataset_id, exc.message)
        raise
    except Exception as exc:
        message = compact_storage_text(exc, limit=1800)
        persist_catalog_reconciliation_failure(db, run_id, dataset_id, message)
        raise catalog_reconciliation_error(
            "Catalog reconciliation failed.",
            {"jobId": job_id, "runId": run_id, "reason": message},
        ) from exc


def airflow_catalog_identity(db: Session, job_id: str, run_id: str) -> tuple[ETLJobModel, ETLRunModel]:
    job = etl_repository.get_job(db, job_id)
    if job is None:
        raise ApiError(ErrorCode.NOT_FOUND, f"Job not found: {job_id}", status.HTTP_404_NOT_FOUND)
    run = etl_repository.get_run_model(db, run_id)
    if run is None or run.job_id != job.id or run.airflow_dag_run_id != run_id:
        raise ApiError(
            "AIRFLOW_RUN_MISMATCH",
            "Catalog reconciliation does not match a persisted AskLake Run.",
            status.HTTP_409_CONFLICT,
            {"jobId": job_id, "runId": run_id},
        )
    return job, run


def commit_airflow_catalog_reconciliation(
    db: Session,
    *,
    job_id: str,
    run_id: str,
    result: dict[str, Any],
    retry_on_create_conflict: bool,
) -> AirflowCatalogReconciliationResponse:
    job, run = airflow_catalog_identity(db, job_id, run_id)
    dataset_id = str(job.dataset_id or "").strip()
    existing_dataset = etl_repository.get_dataset_by_id_for_update(db, dataset_id)
    name_match = etl_repository.get_dataset_by_name(db, job.target)
    if name_match is not None and name_match.id != dataset_id:
        raise catalog_reconciliation_error(
            "Target dataset name is already owned by another dataset id.",
            {"datasetId": dataset_id, "existingDatasetId": name_match.id, "runId": run_id},
        )

    reconciled_at = iso_now()
    dataset_model = dataset_from_spark_result(job, result, existing_dataset)
    catalog_result = {
        "datasetId": dataset_id,
        "parquetObjectCount": parse_count_value(result.get("parquetObjectCount")),
        "reconciledAt": reconciled_at,
        "runId": run_id,
        "status": "success",
        "storageLocation": result.get("outputPath"),
        "storageSizeBytes": parse_count_value(result.get("storageSizeBytes")),
    }
    run.task_states = {
        **(run.task_states or {}),
        "sparkResult": result,
        "catalogResult": catalog_result,
    }

    try:
        _, _, dataset = etl_repository.save_command_result(db, job, run, dataset_model)
    except IntegrityError:
        db.rollback()
        if retry_on_create_conflict:
            return commit_airflow_catalog_reconciliation(
                db,
                job_id=job_id,
                run_id=run_id,
                result=result,
                retry_on_create_conflict=False,
            )
        raise

    if dataset is None:
        raise RuntimeError("Catalog reconciliation committed without a dataset response.")
    return AirflowCatalogReconciliationResponse(
        dataset=dataset,
        reconciled_at=reconciled_at,
        run_id=run_id,
    )


def persist_catalog_reconciliation_failure(db: Session, run_id: str, dataset_id: str, message: str) -> None:
    try:
        db.rollback()
        run = etl_repository.get_run_model(db, run_id)
        if run is None:
            return
        failed_at = iso_now()
        compact_message = compact_storage_text(message, limit=1800)
        run.task_states = {
            **(run.task_states or {}),
            "catalogResult": {
                "datasetId": dataset_id,
                "error": compact_message,
                "failedAt": failed_at,
                "runId": run_id,
                "status": "failed",
            },
        }
        run.failed_stage = "Catalog reconciliation"
        run.error_summary = compact_message
        db.add(run)
        db.commit()
    except Exception:
        db.rollback()


def validate_catalog_output_identity(job: ETLJobModel, run_id: str, output_path: str) -> None:
    if not output_path or output_path == "-":
        raise catalog_reconciliation_error(
            "Successful Spark result does not include an output path.",
            {"jobId": job.id, "runId": run_id},
        )
    configured_root = str(job.storage_path or "").strip()
    if not configured_root:
        return
    expected = canonical_storage_path(f"{configured_root.rstrip('/')}/{run_id}")
    actual = canonical_storage_path(output_path)
    if actual != expected:
        raise catalog_reconciliation_error(
            "Spark output path does not match the persisted Job destination.",
            {"expected": expected, "outputPath": actual, "runId": run_id},
        )


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

    endpoint = os.environ.get("S3_ENDPOINT") or os.environ.get("MINIO_ENDPOINT")
    access_key = os.environ.get("AWS_ACCESS_KEY_ID") or os.environ.get("MINIO_ACCESS_KEY")
    secret_key = os.environ.get("AWS_SECRET_ACCESS_KEY") or os.environ.get("MINIO_SECRET_KEY")
    region = os.environ.get("AWS_REGION") or os.environ.get("MINIO_REGION") or "us-east-1"
    force_path_style = str(os.environ.get("S3_FORCE_PATH_STYLE") or "true").lower() != "false"
    kwargs: dict[str, Any] = {
        "config": Config(s3={"addressing_style": "path" if force_path_style else "auto"}),
        "region_name": region,
    }
    if endpoint:
        kwargs["endpoint_url"] = endpoint
    if access_key:
        kwargs["aws_access_key_id"] = access_key
    if secret_key:
        kwargs["aws_secret_access_key"] = secret_key
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
            "inputRows",
            "outputPath",
            "outputRows",
            "quality",
            "schema",
            "sourcePath",
            "sparkExitCode",
            "startedAt",
            "status",
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

    dataset_id = job.dataset_id or f"ds_{normalize_column_name(job.target)}"
    job.dataset_id = dataset_id
    existing_dataset = etl_repository.get_dataset_by_id(db, dataset_id)
    if airflow_run_has_materialization(run, existing_dataset):
        return airflow_execution_response_from_persisted(job, run, existing_dataset)

    try:
        result = run_spark_job(job, command, run_id)
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
    dataset_model = None
    if result.get("status") == "success":
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
        input_rows=parse_count_value(result.get("inputRows")),
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
    return AirflowRunExecutionResponse(
        status="success",
        job_id=job.id,
        run_id=run.run_id,
        dataset_id=dataset.id,
        input_rows=parse_count_value(run.input_rows),
        output_rows=parse_count_value(run.output_rows),
        output_path=str(run.output_path or payload.get("storageLocation") or "-"),
        schema=schema,
    )


def submit_airflow_job_run(job: ETLJobModel, command: str) -> ETLRunModel:
    submitted_at = iso_now()
    run_id = stable_id("run", f"{job.id}:{command}:airflow:{submitted_at}")
    airflow_client = build_airflow_client()
    dag_run = airflow_client.trigger_dag_run(
        dag_run_id=run_id,
        conf=airflow_dag_run_conf(job, command, run_id, submitted_at),
        note=f"AskLake {command} command for {job.id}",
    )
    if not dag_run.dag_run_id:
        raise ApiError(
            "AIRFLOW_BAD_RESPONSE",
            "Airflow DAG Run response did not include dag_run_id.",
            status.HTTP_502_BAD_GATEWAY,
            {"dagId": airflow_client.config.dag_id, "runId": run_id},
        )
    return run_from_airflow_submit(
        job,
        command,
        run_id,
        submitted_at,
        dag_run,
        airflow_client.dag_run_url(dag_run.dag_run_id),
    )


def airflow_dag_run_conf(job: ETLJobModel, command: str, run_id: str, submitted_at: str) -> dict[str, Any]:
    return {
        "command": command,
        "executionMode": "spark",
        "jobId": job.id,
        "runId": run_id,
        "submittedAt": submitted_at,
    }


def job_payload_for_spark(job: ETLJobModel) -> dict[str, Any]:
    return {
        "id": job.id,
        "name": job.name,
        "owner": job.owner,
        "partition": job.partition,
        "qualityInvalidRows": job.quality_invalid_rows or [],
        "qualityRules": job.quality_rules or [],
        "qualityScore": job.quality_score,
        "qualityStatus": job.quality_status,
        "rag": job.rag,
        "recordParsing": job.record_parsing or None,
        "schedule": job.schedule,
        "schemaColumns": job.schema_columns or [],
        "schemaSampleRows": job.schema_sample_rows or [],
        "source": job.source,
        "sourceConfig": job.source_config or [],
        "sourceLabel": job.source_label,
        "sourceType": job.source_type,
        "stats": job.stats or {},
        "target": job.target,
        "targetDescription": job.target_description,
        "targetFormat": job.target_format,
        "targetLayer": job.target_layer,
        "targetPath": job.target_path,
        "targetTags": job.target_tags or [],
        "storagePath": job.storage_path,
        "storageType": job.storage_type,
        "partition": job.partition,
        "partitionColumns": job.partition_columns or [],
        "indexColumns": job.index_columns or [],
        "compression": job.compression,
        "transformOutputColumns": job.transform_output_columns or [],
        "transformSteps": job.transform_steps or [],
    }


def run_from_airflow_submit(
    job: ETLJobModel,
    command: str,
    run_id: str,
    submitted_at: str,
    dag_run: AirflowDagRun,
    airflow_run_url: str | None,
) -> ETLRunModel:
    return ETLRunModel(
        run_id=run_id,
        job_id=job.id,
        status=dag_run.asklake_status,
        started_at=submitted_at,
        ended_at="-",
        duration="-",
        input_rows="-",
        output_rows="-",
        output_path=job.target_path,
        failed_stage="-",
        error_summary="-",
        airflow_dag_id=dag_run.dag_id,
        airflow_dag_run_id=dag_run.dag_run_id,
        airflow_run_url=airflow_run_url,
        airflow_state=dag_run.state,
        task_states=None,
        last_synced_at=submitted_at,
        sync_error=None,
    )


def run_from_spark_result(job: ETLJobModel, result: dict[str, Any]) -> ETLRunModel:
    success = result.get("status") == "success"
    return ETLRunModel(
        run_id=str(result.get("runId") or stable_id("run", f"{job.id}:spark:{iso_now()}")),
        job_id=job.id,
        status="success" if success else "failed",
        started_at=str(result.get("startedAt") or iso_now()),
        ended_at=str(result.get("endedAt") or iso_now()),
        duration=format_duration_ms(result.get("durationMs")),
        input_rows=format_rows(result.get("inputRows")),
        output_rows=format_rows(result.get("outputRows")),
        output_path=result.get("outputPath") or "-",
        failed_stage="-" if success else spark_failed_stage(result),
        error_summary="-" if success else spark_error_summary(result),
    )


def run_from_kafka_result(job: ETLJobModel, result: dict[str, Any]) -> ETLRunModel:
    success = result.get("status") == "success"
    started_at = str(result.get("startedAt") or iso_now())
    ended_at = str(result.get("endedAt") or iso_now())
    return ETLRunModel(
        run_id=str(result.get("runId") or stable_id("run", f"{job.id}:kafka:{iso_now()}")),
        job_id=job.id,
        status="success" if success else "failed",
        started_at=started_at,
        ended_at=ended_at,
        duration=format_iso_duration(started_at, ended_at),
        input_rows=format_rows(result.get("consumedCount")),
        output_rows=format_rows(result.get("storedCount")),
        output_path=result.get("storageLocation") or "-",
        failed_stage="-" if success else str(result.get("failedStage") or "Kafka ingest"),
        error_summary="-" if success else str(result.get("error") or "Kafka ingest failed."),
        task_states={
            "kafkaSnapshot": result.get("snapshot"),
            "transform": result.get("transform"),
            "quality": result.get("quality"),
        } if result.get("snapshot") else None,
    )


def apply_airflow_submit_job_state(job: ETLJobModel, command: str, run: ETLRunModel) -> None:
    action_label = "재실행" if command == "retry" else "실행"
    state_label = run.airflow_state or run.status
    job.last_run = run.started_at
    job.last_state = f"Airflow {action_label} 접수 · {state_label}"
    job.next_run = "-"
    if run.status == "failed":
        job.progress = None
        job.status = "failed"
        return
    if run.status == "success":
        job.progress = None
        job.status = "scheduled"
        return
    job.progress = {
        "label": f"Airflow DAG Run {state_label}",
        "value": 10 if run.status == "queued" else 20,
    }
    job.status = "running"


def sync_airflow_runs_for_job(db: Session, job: ETLJobModel) -> None:
    runs = etl_repository.list_run_models_for_job(db, job.id)
    dataset_id = job.dataset_id or f"ds_{normalize_column_name(job.target)}"
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
        for run in active_runs:
            run.sync_error = sync_error
            run.last_synced_at = synced_at
        job.last_state = f"Airflow 상태 동기화 실패 · {sync_error}"
        etl_repository.save_job(db, job)
        return

    for run in active_runs:
        sync_airflow_run(db, job, run, airflow_client, dataset)

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
        task_instances = airflow_client.list_task_instances(run.airflow_dag_run_id)
    except ApiError as exc:
        run.sync_error = exc.message
        run.last_synced_at = synced_at
        return

    # Spark/Catalog execution endpoints can commit task evidence while this
    # polling request is waiting on Airflow. Refresh and lock the Run before
    # replacing the task snapshot so a stale poll cannot erase that evidence.
    etl_repository.refresh_run_for_update(db, run)
    run.status = dag_run.asklake_status
    run.airflow_dag_id = dag_run.dag_id or run.airflow_dag_id
    run.airflow_dag_run_id = dag_run.dag_run_id or run.airflow_dag_run_id
    run.airflow_run_url = airflow_client.dag_run_url(run.airflow_dag_run_id) or run.airflow_run_url
    run.airflow_state = dag_run.state
    spark_result = (run.task_states or {}).get("sparkResult")
    catalog_result = (run.task_states or {}).get("catalogResult")
    run.task_states = task_state_snapshot(task_instances)
    if isinstance(spark_result, dict):
        run.task_states["sparkResult"] = spark_result
    if isinstance(catalog_result, dict):
        run.task_states["catalogResult"] = catalog_result
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


def repair_incomplete_airflow_successes(
    runs: list[ETLRunModel],
    dataset: CatalogDatasetModel | None,
) -> bool:
    repaired = False
    for run in runs:
        if run.status != "success" or not run.airflow_dag_run_id:
            continue
        catalog_result = (run.task_states or {}).get("catalogResult")
        if isinstance(catalog_result, dict) and catalog_result.get("status") == "failed":
            mark_airflow_catalog_reconciliation_failure(run, catalog_result)
            repaired = True
        elif (
            not (isinstance(catalog_result, dict) and catalog_result.get("status") == "success")
            and not airflow_run_has_materialization(run, dataset)
        ):
            mark_airflow_success_without_catalog_reconciliation(run)
            repaired = True
    return repaired


def airflow_run_has_materialization(
    run: ETLRunModel,
    dataset: CatalogDatasetModel | None,
) -> bool:
    if dataset is None or not isinstance(dataset.payload, dict):
        return False
    materialization_runs = dataset.payload.get("materializationRuns")
    if not isinstance(materialization_runs, list):
        return False
    return any(
        isinstance(item, dict)
        and str(item.get("runId") or "") == run.run_id
        and item.get("status") == "success"
        for item in materialization_runs
    )


def mark_airflow_catalog_reconciliation_failure(run: ETLRunModel, catalog_result: dict[str, Any]) -> None:
    run.status = "failed"
    run.failed_stage = "Catalog reconciliation"
    run.error_summary = str(catalog_result.get("error") or "Catalog reconciliation failed.")


def mark_airflow_success_without_catalog_reconciliation(run: ETLRunModel) -> None:
    run.status = "failed"
    run.failed_stage = "Catalog reconciliation"
    run.error_summary = "Airflow completed without a successful Catalog reconciliation."


def apply_job_state_from_latest_run(job: ETLJobModel, latest_run: ETLRunModel) -> None:
    job.last_run = latest_run.ended_at if latest_run.status in TERMINAL_RUN_STATUSES else latest_run.started_at
    job.next_run = "-" if job.schedule in {"수동 실행", "manual"} else job.schedule

    if latest_run.status == "success":
        job.status = "scheduled"
        job.progress = None
        job.last_state = "최근 실행 성공 · 다음 실행 대기"
        return
    if latest_run.status == "failed":
        job.status = "failed"
        job.progress = None
        job.last_state = f"최근 실행 실패 · {latest_run.failed_stage}"
        return
    if latest_run.status == "canceled":
        job.status = "canceled"
        job.progress = None
        job.last_state = "최근 실행 취소"
        return

    state_label = latest_run.airflow_state or latest_run.status
    job.status = "running"
    job.progress = {
        "label": f"Airflow DAG Run {state_label}",
        "value": 10 if latest_run.status == "queued" else 55,
    }
    job.last_state = f"Airflow 실행 중 · {state_label}"
    job.next_run = "-"


AIRFLOW_TASK_TITLES = {
    "receive_asklake_run": "1. Airflow DAG Run 접수",
    "validate_spark_request": "2. Spark 실행 요청 검증",
    "spark_process_write": "3. Spark 처리/품질/Parquet 적재",
    "publish_run_result": "4. Spark 실행 결과 확정",
}


def task_state_snapshot(task_instances: list[AirflowTaskInstance]) -> dict[str, dict[str, Any]]:
    return {
        task.task_id: {
            "airflowState": task.state,
            "dagId": task.dag_id,
            "dagRunId": task.dag_run_id,
            "status": task.asklake_status,
            "taskId": task.task_id,
        }
        for task in task_instances
        if task.task_id
    }


def first_problem_task(task_instances: list[AirflowTaskInstance]) -> AirflowTaskInstance | None:
    for task in task_instances:
        if task.asklake_status in {"failed", "blocked"}:
            return task
    return None


def task_title(task_id: str) -> str:
    if task_id in AIRFLOW_TASK_TITLES:
        return AIRFLOW_TASK_TITLES[task_id]
    return str(task_id or "Airflow task").replace("_", " ").strip().title()


def dag_steps_from_airflow_submit(job: ETLJobModel, command: str, run: dict[str, Any]) -> list[dict[str, Any]]:
    action_label = "재실행" if command == "retry" else "실행"
    state_label = str(run.get("airflowState") or run.get("status") or "queued")
    return [
        dag_step("airflow-submit", "Airflow DAG Run 접수", state_label, "running", [
            ["Job", job.name],
            ["Run ID", run.get("runId", "-")],
            ["DAG Run ID", run.get("airflowDagRunId", "-")],
        ], [f"AskLake {action_label} 명령이 Airflow에 접수되었습니다."]),
        *[
            dag_step(task_id, title, "대기", "pending", [
                ["Airflow task", task_id],
            ], ["Airflow Task Instance 상태 polling 대기 중입니다."])
            for task_id, title in AIRFLOW_TASK_TITLES.items()
        ],
    ]


def dag_steps_from_airflow_sync(
    job: ETLJobModel,
    run: dict[str, Any],
    task_instances: list[AirflowTaskInstance],
) -> list[dict[str, Any]]:
    task_by_id = {task.task_id: task for task in task_instances if task.task_id}
    run_status = str(run.get("status") or "running")
    run_state = str(run.get("airflowState") or run_status)
    submit_status = "success" if run_status in TERMINAL_RUN_STATUSES else "running"
    if run_status == "failed":
        submit_status = "failed"

    steps = [
        dag_step("airflow-submit", "Airflow DAG Run 상태", run_state, submit_status, [
            ["Job", job.name],
            ["Run ID", run.get("runId", "-")],
            ["DAG Run ID", run.get("airflowDagRunId", "-")],
            ["Airflow state", run_state],
        ], [f"Airflow DAG Run 상태: {run_state}"]),
    ]

    for task_id, title in AIRFLOW_TASK_TITLES.items():
        task = task_by_id.get(task_id)
        status_value = task.asklake_status if task else "pending"
        airflow_state = task.state if task and task.state else "not_started"
        logs = [f"Airflow Task Instance state: {airflow_state}"]
        if task and task.raw.get("try_number") is not None:
            logs.append(f"try_number={task.raw.get('try_number')}")
        steps.append(dag_step(task_id, title, airflow_state, status_value, [
            ["Airflow task", task_id],
            ["Airflow state", airflow_state],
        ], logs))

    extra_tasks = [
        task for task in task_instances
        if task.task_id and task.task_id not in AIRFLOW_TASK_TITLES
    ]
    for task in extra_tasks:
        steps.append(dag_step(task.task_id, task_title(task.task_id), task.state or "-", task.asklake_status, [
            ["Airflow task", task.task_id],
            ["Airflow state", task.state or "-"],
        ], [f"Airflow Task Instance state: {task.state or '-'}"]))

    return steps


def finalize_job_from_spark_result(job: ETLJobModel, command: str, result: dict[str, Any]) -> None:
    success = result.get("status") == "success"
    job.last_run = str(result.get("endedAt") or iso_now())
    job.last_state = (
        f"{'재실행' if command == 'retry' else '실행'} 완료 · Spark Parquet 적재"
        if success
        else f"Spark 실행 실패 · {spark_error_summary(result, limit=180)}"
    )
    job.next_run = schedule_next_run_label(job.schedule, job.next_run)
    job.progress = None
    job.status = "scheduled"
    job.target_path = result.get("outputPath") or job.target_path


def spark_failed_stage(result: dict[str, Any]) -> str:
    return compact_storage_text(result.get("failedStage") or "Spark ETL", limit=500)


def spark_error_summary(result: dict[str, Any], *, limit: int = 1800) -> str:
    return compact_storage_text(result.get("error") or result.get("stderr") or result.get("stdout") or "Spark job failed.", limit=limit)


def compact_storage_text(value: Any, *, limit: int) -> str:
    text_value = str(value or "").replace("\r", "\n")
    lines = [line.strip() for line in text_value.splitlines() if line.strip()]
    compact = " | ".join(lines) if lines else "-"
    if len(compact) <= limit:
        return compact
    return f"{compact[: max(0, limit - 32)]} ... [truncated {len(compact)} chars]"


def finalize_job_from_kafka_result(job: ETLJobModel, command: str, result: dict[str, Any]) -> None:
    success = result.get("status") == "success"
    stored_count = int(result.get("storedCount") or 0)
    failed_count = int(result.get("failedCount") or 0)
    snapshot_id = str((result.get("snapshot") or {}).get("snapshotId") or "-")
    job.last_run = str(result.get("endedAt") or iso_now())
    job.last_state = (
        f"{'재실행' if command == 'retry' else '실행'} 완료 · Kafka snapshot {snapshot_id} · {stored_count:,}건 target 저장"
        if success
        else f"Kafka 실행 실패 · {result.get('error') or '원인 확인 필요'}"
    )
    job.next_run = schedule_next_run_label(job.schedule, job.next_run)
    job.progress = None
    job.status = "scheduled" if success else "failed"
    job.target_path = result.get("storageLocation") or job.target_path
    job.stats = {
        **(job.stats or {}),
        "currentStage": "Kafka snapshot target 저장 완료" if success else "Kafka snapshot target 저장 실패",
        "inputRows": format_rows(result.get("consumedCount")),
        "lastSuccess": str(result.get("endedAt") or iso_now()) if success else job.stats.get("lastSuccess", "-"),
        "outputPath": result.get("storageLocation") or job.target_path,
        "outputRows": format_rows(result.get("storedCount")),
        "sampleScope": f"{result.get('topic') or 'Kafka'} batch",
        "sourceUnits": "Kafka topic",
        "successRate": "100%" if success and failed_count == 0 else "확인 필요",
    }


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
    schema = result.get("schema")
    schema_json = [
        [str(field.get("name") or "-"), str(field.get("type") or "string")]
        for field in schema
    ] if isinstance(schema, list) and schema else schema_from_job(job)
    dataset_id = str(job.dataset_id or f"ds_{normalize_column_name(job.target)}")
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
        downstream=["SQL 분석", "RAG 인덱싱"] if job.rag else ["SQL 분석"],
    )


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
    materialization_runs = append_materialization_run(
        previous_payload.get("materializationRuns") if previous_payload else [],
        {
            "createdAt": last_updated,
            "jobId": job.id,
            "rowCount": parse_count_value(result.get("materializationRows", result.get("outputRows"))),
            "runId": str(result.get("runId") or ""),
            "sourceKind": result.get("sourceKind") or ("sql" if job.source_type == "SQL Result" else "etl"),
            "sourceLabel": job.name or job.source or job.source_label or job.id,
            "status": "success" if result.get("status") == "success" else "failed",
            "storageLocation": str(result.get("materializationOutputPath") or output_path),
            "storageSizeBytes": storage_size_bytes,
            **({"sourceRanges": result["sourceRanges"]} if isinstance(result.get("sourceRanges"), list) and result["sourceRanges"] else {}),
            **({"publicationManifest": str(result["publicationManifest"])} if result.get("publicationManifest") else {}),
        },
    )
    aggregate = aggregate_materialization_runs(materialization_runs)
    return {
        "description": target_dataset_description(job),
        "downstream": ["SQL 분석", "RAG 인덱싱"] if job.rag else ["SQL 분석"],
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
        "rows": format_rows(aggregate["rowCount"]),
        "sampleRows": sample_rows,
        "schema": schema_json,
        "size": format_storage_size(aggregate["storageSizeBytes"]) if aggregate["storageSizeBytes"] > 0 else display_size,
        "source": job.name,
        "sourceRunId": aggregate["latestRunId"] or result.get("runId"),
        "status": "available",
        "storageFormat": SPARK_OUTPUT_FORMAT,
        "storageLocation": output_path,
        "storageSizeBytes": aggregate["storageSizeBytes"],
        "partition": partition,
        "partitionColumns": partition_columns,
        "indexColumns": index_columns,
        "tags": target_dataset_tags(job),
        "upstream": [job.source_label, job.name],
    }


def update_existing_append_job(
    job: ETLJobModel,
    request: CreatePipelineRequest,
    dataset_id: str,
    created_by: str,
    created_by_profile: dict[str, Any],
) -> None:
    dataset_schema = dataset_schema_from_request(request)
    sample_rows = dataset_sample_rows_from_request(request, dataset_schema)
    metrics = source_metrics_from_request(request, dataset_schema, sample_rows)
    job.name = request.job_name or job.name
    job.owner = request.owner
    job.created_by = job.created_by or created_by
    job.created_by_profile = job.created_by_profile or created_by_profile
    job.tag = "[append]"
    job.source = f"{request.source_type} / {request.source_label}"
    job.target = request.target_dataset
    job.schedule = request.schedule_label
    job.schedule_policy = schedule_policy_from_request(request)
    job.schedule_summary = request.schedule_summary
    job.retry_policy = request.retry_policy.model_dump(mode="json", by_alias=True) if request.retry_policy else None
    job.retry_policy_summary = request.retry_policy_summary
    job.run_limit_summary = request.run_limit_summary
    job.source_config = tuple_rows_to_lists(request.source_config)
    job.source_label = request.source_label
    job.source_type = request.source_type
    job.execution_mode = request.execution_mode
    job.continuous_config = continuous_config_from_request(request, job.id)
    job.record_parsing = request.record_parsing.model_dump(mode="json", by_alias=True) if request.record_parsing else None
    job.schema_columns = [column.model_dump(mode="json", by_alias=True) for column in request.schema_columns]
    job.schema_fingerprint = request.schema_fingerprint
    job.schema_sample_rows = request.schema_sample_rows
    job.schema_summary = request.schema_summary
    job.rule_summary = request.rule_summary
    job.permission_summary = request.permission_summary
    job.permission_roles = request.permission_roles
    job.storage_type = request.storage_type
    job.partition = request.partition
    job.partition_columns = normalize_string_list(request.partition_columns)
    job.index_columns = normalize_string_list(request.index_columns)
    job.compression = request.compression
    job.storage_path = request.storage_path
    job.target_description = normalize_optional_text(request.target_description)
    job.target_database = normalize_optional_text(request.target_database)
    job.target_tags = normalize_target_tags(request.target_tags)
    job.target_format = request.target_format
    job.target_layer = request.target_layer
    job.target_path = request.storage_path
    job.rag = request.rag
    job.transform_output_columns = tuple_rows_to_lists(request.transform_output_columns)
    job.transform_steps = [step.model_dump(mode="json", by_alias=True) for step in request.transform_steps]
    job.quality_invalid_rows = request.quality_invalid_rows
    job.quality_rules = [rule.model_dump(mode="json", by_alias=True) for rule in request.quality_rules]
    job.quality_score = request.quality_score
    job.quality_status = request.quality_status
    job.last_run = "append draft updated"
    job.last_state = f"{metrics['schema_columns']}개 컬럼 · 기존 데이터셋 append 대기"
    job.next_run = schedule_next_run_label(request.schedule_label, request.schedule_summary)
    job.progress = None
    job.stats = initial_job_stats(metrics)
    job.dag_steps = initial_dag_steps(request, metrics)
    job.dataset_id = dataset_id


def append_materialization_run(previous_runs: Any, next_run: dict[str, Any]) -> list[dict[str, Any]]:
    runs = [run for run in previous_runs if isinstance(run, dict)] if isinstance(previous_runs, list) else []
    run_id = str(next_run.get("runId") or "")
    if not run_id:
        return runs
    return [next_run, *[run for run in runs if str(run.get("runId") or "") != run_id]]


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


def aggregate_materialization_runs(runs: list[dict[str, Any]]) -> dict[str, Any]:
    active_runs = [run for run in runs if run.get("status") == "success"]
    latest_run = active_runs[0] if active_runs else None
    return {
        "latestRunId": latest_run.get("runId") if latest_run else None,
        "lastUpdated": latest_run.get("createdAt") if latest_run else None,
        "rowCount": sum(parse_count_value(run.get("rowCount")) for run in active_runs),
        "storageSizeBytes": sum(parse_count_value(run.get("storageSizeBytes")) for run in active_runs),
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
        ], ["이전 단계 실패로 Parquet 적재가 수행되지 않았습니다." if failed else f"Parquet 출력 완료: {output_path}"]),
        dag_step("catalog", "7. 카탈로그 데이터셋 갱신", job.target, "blocked" if failed else "success", [
            ["데이터셋", job.target],
            ["레이어", job.target_layer],
        ], ["실행 실패로 카탈로그 데이터셋을 갱신하지 않았습니다." if failed else "실행 성공 후 카탈로그 데이터셋을 갱신했습니다."]),
    ]


def dag_steps_from_kafka_result(job: ETLJobModel, command: str, run: dict[str, Any], result: dict[str, Any]) -> list[dict[str, Any]]:
    failed = result.get("status") != "success"
    failed_stage = str(result.get("failedStage") or "").lower()
    consume_failed = failed and failed_stage in {"kafka ingest", "consume", "source"}
    transform_failed = failed and failed_stage == "transform"
    quality_failed = failed and failed_stage == "quality"
    topic = str(result.get("topic") or field_value(job.source_config or [], "TOPIC / QUEUE NAME") or "-")
    broker = str(result.get("broker") or field_value(job.source_config or [], "Broker / Endpoint") or "-")
    storage_location = str(result.get("storageLocation") or run.get("outputPath") or "-")
    dataset_id = str(result.get("datasetId") or job.dataset_id or f"ds_{normalize_column_name(job.target)}")
    consumer_group_id = str(result.get("consumerGroupId") or field_value(job.source_config or [], "CONSUMER GROUP ID") or "-")
    snapshot = result.get("snapshot") or {}
    transform = result.get("transform") or {}
    quality = result.get("quality") or {}
    snapshot_ranges = ", ".join(
        f"p{item.get('partition')}:{item.get('startOffset')}~{item.get('endOffset')}"
        for item in snapshot.get("partitions", [])
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
        dag_step("transform", "3. 변환 규칙 적용", f"{transform.get('appliedStepCount', 0)}개 규칙", "failed" if transform_failed else "blocked" if failed else "success", [
            ["Configured", str(transform.get("configuredStepCount", 0))],
            ["Applied", str(transform.get("appliedStepCount", 0))],
            ["Transform errors", str(transform.get("errorCount", 0))],
        ], [f"변환 규칙 적용 실패: {run.get('errorSummary')}" if transform_failed else "이전 단계 실패로 변환이 수행되지 않았습니다." if failed else "Kafka snapshot 레코드에 변환 규칙을 적용했습니다."]),
        dag_step("quality", "4. 품질 검증", str(quality.get("summary") or "규칙 없음"), "failed" if quality_failed else "blocked" if failed else "success", [
            ["Configured", str(quality.get("configuredRuleCount", 0))],
            ["Invalid", str(quality.get("invalidRowCount", 0))],
            ["Quarantined", str(quality.get("quarantinedCount", 0))],
            ["Dropped", str(quality.get("droppedCount", 0))],
        ], [f"품질 검증 실패: {run.get('errorSummary')}" if quality_failed else "이전 단계 실패로 품질 검증이 수행되지 않았습니다." if failed else str(quality.get("summary") or "품질 규칙 없음")]),
        dag_step("target", "5. Direct target 저장", storage_location, "blocked" if failed else "success", [
            ["Storage", str(result.get("storageMode") or "s3")],
            ["Format", str(result.get("storageFormat") or "jsonl")],
            ["Layer", str(result.get("targetLayer") or job.target_layer)],
            ["Stored", format_rows(result.get("storedCount"))],
        ], ["이전 단계 실패로 target 저장이 수행되지 않았습니다." if failed else f"Kafka snapshot 결과를 target에 저장했습니다: {storage_location}"]),
        dag_step("catalog", "6. 카탈로그 갱신", dataset_id, "blocked" if failed else "success", [
            ["Dataset", dataset_id],
            ["Run ID", run.get("runId", "-")],
        ], ["이전 단계 실패로 카탈로그 갱신이 중단되었습니다." if failed else "Catalog materialization run이 Kafka sourceKind로 갱신되었습니다."]),
    ]


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


def run_node_bridge(script_name: str, success_marker: str, payload: dict[str, Any], *, error_marker: str, timeout_seconds: int) -> dict[str, Any]:
    script_path = SCRIPTS_DIR / script_name
    result = subprocess.run(
        ["node", str(script_path)],
        cwd=str(BACKEND_DIR),
        input=json.dumps(payload, ensure_ascii=False),
        text=True,
        capture_output=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout_seconds,
    )
    stdout = result.stdout or ""
    stderr = result.stderr or ""
    if result.returncode != 0:
        error_payload = marker_payload(stdout, error_marker) or {}
        raise ApiError(
            error_payload.get("code") or "BACKEND_BRIDGE_FAILED",
            error_payload.get("message") or (stderr.strip() or f"{script_name} failed."),
            int(error_payload.get("status") or status.HTTP_502_BAD_GATEWAY),
            {"bridge": error_payload, "stderr": stderr[-4000:], "stdout": stdout[-4000:]},
        )
    payload_result = marker_payload(stdout, success_marker)
    if payload_result is None:
        raise ApiError(
            "BACKEND_BRIDGE_BAD_RESPONSE",
            f"{script_name} did not return {success_marker}.",
            status.HTTP_502_BAD_GATEWAY,
            {"stderr": stderr[-4000:], "stdout": stdout[-4000:]},
        )
    if isinstance(payload_result, dict):
        payload_result.setdefault("stdout", stdout)
        payload_result.setdefault("stderr", stderr)
    return payload_result


def marker_payload(output: str, marker: str) -> dict[str, Any] | None:
    prefix = f"{marker}="
    for line in reversed(str(output or "").splitlines()):
        if line.startswith(prefix):
            return json.loads(line[len(prefix):])
    return None


def run_kafka_continuous_worker(
    job: ETLJobModel,
    runtime: KafkaContinuousRuntimeModel,
    action: str,
    options: dict[str, Any] | None = None,
) -> dict[str, Any]:
    config = job.continuous_config or {}
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
            "jobId": job.id,
            "maxOffsetsPerTrigger": config.get("maxOffsetsPerTrigger", 10000),
            "outputPath": output_path,
            "schemaColumns": job.schema_columns or [],
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
    require_continuous_maintenance_idle(db, job)
    reconcile_stale_continuous_maintenance_runs(db, job.id)
    etl_repository.lock_kafka_continuous_runtime(db, job.id)
    require_no_active_continuous_maintenance(db, job.id)
    result = run_kafka_continuous_maintenance(job, "inspect_quarantine", stable_id("inspect", iso_now()), {"limit": limit})
    return ContinuousQuarantineResponse(job_id=job.id, records=result.get("records") or [], total=int(result.get("total") or 0))


def list_kafka_continuous_maintenance_runs(
    db: Session,
    job_id: str,
    actor: ActorContext,
) -> list[ContinuousMaintenanceRun]:
    require_continuous_job_access(db, job_id, actor, "view", "GET", "continuous/maintenance-runs")
    reconcile_stale_continuous_maintenance_runs(db, job_id)
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
    return execute_kafka_continuous_maintenance(db, job_id, "compaction", request.model_dump(mode="json", by_alias=True), actor)


def execute_kafka_continuous_maintenance(
    db: Session,
    job_id: str,
    kind: str,
    config: dict[str, Any],
    actor: ActorContext,
    access_action: str = "run",
) -> ContinuousMaintenanceRun:
    job = require_continuous_job_access(db, job_id, actor, access_action, "POST", f"continuous/{kind}")
    require_continuous_maintenance_idle(db, job)
    reconcile_stale_continuous_maintenance_runs(db, job.id)
    etl_repository.lock_kafka_continuous_runtime(db, job.id)
    require_no_active_continuous_maintenance(db, job.id)
    run_id = stable_id("continuous-maint", f"{job.id}:{kind}:{iso_now()}")
    started_at = iso_now()
    lease_expires_at = (datetime.now(UTC) + timedelta(seconds=continuous_maintenance_lease_seconds())).isoformat().replace("+00:00", "Z")
    persisted_config = {
        **config,
        "heartbeatAt": started_at,
        "leaseExpiresAt": lease_expires_at,
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
    except Exception as exc:
        cleanup_result: dict[str, Any] = {}
        try:
            cleanup_result = cleanup_kafka_continuous_maintenance(run_id)
        except ApiError as cleanup_error:
            cleanup_result = {"cleanupError": compact_storage_text(cleanup_error.message, limit=500)}
        run.status = "failed"
        run.ended_at = iso_now()
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
    run.status = "success"
    run.result = result
    run.ended_at = optional_string(result.get("endedAt")) or iso_now()
    if kind == "quarantine_replay":
        runtime = etl_repository.get_kafka_continuous_runtime(db, job.id)
        if runtime is not None:
            replayed_count = nonnegative_int(result.get("storedCount"), 0)
            runtime.stored_count = int(runtime.stored_count or 0) + replayed_count
            runtime.metrics = {
                **(runtime.metrics or {}),
                "replayedCount": nonnegative_int((runtime.metrics or {}).get("replayedCount"), 0) + replayed_count,
            }
            if replayed_count:
                materialize_continuous_replay(db, job, runtime, result)
            etl_repository.save_kafka_continuous_command(db, job, runtime)
        if bool(config.get("approveUnknownFields")):
            record_continuous_replay_override_audit(db, job, actor, run_id, "success")
    return etl_repository.save_kafka_continuous_maintenance_run(db, run)


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
    target = parse_kafka_target_path(job.storage_path or job.target_path, job.target, job.target_layer)
    output_path = f"s3a://{target['bucket']}/{target['prefix'].strip('/')}"
    return run_node_bridge(
        "manage-kafka-continuous-maintenance.mjs",
        "ASKLAKE_KAFKA_MAINTENANCE_RESULT",
        {
            "action": "run",
            "kind": kind,
            "runId": run_id,
            "outputPath": output_path,
            "schemaColumns": job.schema_columns or [],
            "schemaEvolutionPolicy": (job.continuous_config or {}).get("schemaEvolutionPolicy") or {},
            **config,
        },
        error_marker="ASKLAKE_KAFKA_MAINTENANCE_ERROR",
        timeout_seconds=600,
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


def reconcile_stale_continuous_maintenance_runs(db: Session, job_id: str | None = None) -> None:
    current = datetime.now(UTC)
    for run in etl_repository.list_kafka_continuous_maintenance_run_models(db, job_id, active_only=True):
        lease_value = optional_string((run.config or {}).get("leaseExpiresAt"))
        try:
            lease_expires_at = datetime.fromisoformat(lease_value.replace("Z", "+00:00")) if lease_value else None
        except ValueError:
            lease_expires_at = None
        if lease_expires_at is None and run.started_at:
            try:
                lease_expires_at = datetime.fromisoformat(run.started_at.replace("Z", "+00:00")) + timedelta(seconds=continuous_maintenance_lease_seconds())
            except ValueError:
                lease_expires_at = current
        if lease_expires_at is None or current <= lease_expires_at:
            continue
        cleanup_result: dict[str, Any] = {}
        try:
            cleanup_result = cleanup_kafka_continuous_maintenance(run.run_id)
        except ApiError as exc:
            cleanup_result = {"cleanupError": compact_storage_text(exc.message, limit=500)}
        run.status = "failed"
        run.ended_at = iso_now()
        run.last_error = "Continuous maintenance lease expired before completion."
        run.result = {"leaseExpired": True, **cleanup_result}
        etl_repository.save_kafka_continuous_maintenance_run(db, run)


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


def require_continuous_maintenance_idle(db: Session, job: ETLJobModel) -> None:
    runtime = etl_repository.get_kafka_continuous_runtime(db, job.id)
    if runtime is not None and runtime.status not in {"paused", "stopped"}:
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
    db.add(session)


def sync_kafka_continuous_batches(
    db: Session,
    runtime: KafkaContinuousRuntimeModel,
    session: KafkaContinuousSessionModel,
    payload: dict[str, Any],
) -> None:
    publications = payload.get("publishedBatches")
    if not isinstance(publications, list):
        return
    baseline_batch_id = optional_int((session.baseline_counts or {}).get("lastBatchId"))
    latest_batch_id = optional_int(payload.get("lastBatchId"))
    latest_duration_ms = optional_int((runtime.metrics or {}).get("lastBatchDurationMs"))
    for publication in publications:
        if not isinstance(publication, dict):
            continue
        batch_id = optional_int(publication.get("batchId"))
        if batch_id is None or (baseline_batch_id is not None and batch_id <= baseline_batch_id):
            continue
        batch = KafkaContinuousBatchModel(
            id=f"{session.session_id}:{batch_id}",
            job_id=session.job_id,
            session_id=session.session_id,
            batch_id=batch_id,
            published_at=optional_string(publication.get("publishedAt")),
            consumed_count=nonnegative_int(publication.get("consumedCount"), 0),
            stored_count=nonnegative_int(publication.get("storedCount"), 0),
            quarantined_count=nonnegative_int(publication.get("quarantinedCount"), 0),
            duration_ms=latest_duration_ms if batch_id == latest_batch_id and latest_duration_ms is not None else optional_int(publication.get("durationMs")),
            source_ranges=publication.get("sourceRanges") if isinstance(publication.get("sourceRanges"), list) else [],
            data_path=optional_string(publication.get("dataPath")),
            quarantine_path=optional_string(publication.get("quarantinePath")),
            manifest_path=optional_string(publication.get("manifestPath")),
        )
        etl_repository.stage_kafka_continuous_batch(db, batch)


def refresh_kafka_continuous_runtime(db: Session, job: ETLJobModel) -> None:
    if job.execution_mode != "continuous":
        return
    runtime = etl_repository.lock_kafka_continuous_runtime(db, job.id) if db is not None else etl_repository.get_kafka_continuous_runtime(db, job.id)
    if runtime is None:
        return
    report_path = continuous_runtime_report_path(job.id)
    worker_status = continuous_worker_status(job, runtime)
    container_state = str(worker_status.get("containerState") or "unknown")
    requested_action = optional_string(worker_status.get("requestedAction"))
    requested_terminal_status = "paused" if requested_action == "pause" else "stopped" if requested_action == "stop" else None
    forced_terminal_status = None
    if (runtime.status in {"pausing", "stopping"} or requested_terminal_status) and container_state in {"exited", "missing"}:
        # Pause and stop intentionally terminate the worker after persisting its
        # checkpoint. Reconcile a final report when one exists, but keep the
        # requested terminal transition authoritative over its stale status.
        forced_terminal_status = requested_terminal_status or ("paused" if runtime.status == "pausing" else "stopped")
    if not report_path.exists():
        if forced_terminal_status:
            runtime.status = forced_terminal_status
            runtime.last_error = None
            if runtime.status == "paused":
                job.status = "paused"
                job.last_state = "Continuous worker 일시정지됨"
            else:
                job.status = "stopped"
                job.last_state = "Continuous worker 중지됨 · checkpoint 보존"
            job.progress = None
            sync_kafka_continuous_session(db, runtime)
            etl_repository.save_kafka_continuous_command(db, job, runtime)
            return
        if runtime.status in {"starting", "running", "pausing", "stopping"} and container_state in {"exited", "missing"}:
            mark_continuous_runtime_failed(job, runtime, f"Continuous worker container is {container_state} without a runtime report.")
            sync_kafka_continuous_session(db, runtime)
            etl_repository.save_kafka_continuous_command(db, job, runtime)
        return
    try:
        payload = json.loads(report_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return
    previous_metrics = runtime.metrics or {}
    worker_attempt_id = optional_string(payload.get("workerAttemptId"))
    expected_worker_attempt_id = optional_string(previous_metrics.get("currentWorkerAttemptId"))
    if worker_attempt_id and expected_worker_attempt_id and worker_attempt_id != expected_worker_attempt_id:
        if not forced_terminal_status:
            return
        payload = {}
        worker_attempt_id = None
    runtime_status = forced_terminal_status or str(payload.get("status") or runtime.status)
    if runtime_status not in {"starting", "running", "pausing", "paused", "stopping", "stopped", "failed"}:
        return
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
    # A publication manifest is durable independently from the worker process.
    # Reconcile it before liveness handling so a crash cannot strand Lake data
    # outside Catalog merely because the worker is no longer running.
    sync_kafka_continuous_session(db, runtime, payload)
    catalog_ack_cursor = materialize_continuous_batch(db, job, runtime, payload)
    heartbeat_stale = continuous_heartbeat_is_stale(runtime.heartbeat_at, job)
    if runtime_status in {"starting", "running", "pausing", "stopping"} and container_state in {"exited", "missing"}:
        mark_continuous_runtime_failed(
            job,
            runtime,
            f"Continuous worker container is {container_state} (exitCode={worker_status.get('exitCode')}).",
            continuous_failure_identity(job, runtime, worker_status, "container_exit"),
        )
    elif runtime_status in {"starting", "running", "pausing", "stopping"} and heartbeat_stale:
        mark_continuous_runtime_failed(
            job,
            runtime,
            "Continuous worker heartbeat expired.",
            continuous_failure_identity(job, runtime, worker_status, "heartbeat_expired"),
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
) -> None:
    metrics = dict(runtime.metrics or {})
    already_counted = bool(failure_identity and metrics.get("lastFailureIdentity") == failure_identity)
    runtime.status = "failed"
    if not already_counted:
        runtime.failed_count += 1
    if failure_identity:
        metrics["lastFailureIdentity"] = failure_identity
    runtime.metrics = metrics
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
) -> int | None:
    publications = report.get("publishedBatches") if isinstance(report.get("publishedBatches"), list) else []
    if not publications:
        batch_id = optional_string(report.get("lastBatchId"))
        if batch_id and bool(report.get("lastBatchWritten")):
            publications = [{
                "batchId": batch_id,
                "storedCount": nonnegative_int(report.get("lastBatchStoredCount"), 0),
                "publishedAt": runtime.last_flush_at or runtime.heartbeat_at,
            }]
    normalized = [
        item for item in publications
        if isinstance(item, dict) and optional_int(item.get("batchId")) is not None and int(item["batchId"]) >= 0
    ]
    normalized.sort(key=lambda item: nonnegative_int(item.get("batchId"), 0))
    metrics = dict(runtime.metrics or {})
    cursor = optional_int(metrics.get("catalogBatchCursor"))
    for publication in normalized:
        publication_batch_id = nonnegative_int(publication.get("batchId"), 0)
        if cursor is not None and publication_batch_id <= cursor:
            continue
        if not materialize_continuous_publication(db, job, runtime, publication):
            break
        cursor = publication_batch_id
        metrics["catalogBatchCursor"] = cursor
        runtime.metrics = metrics
    return cursor


def write_continuous_catalog_ack(job_id: str, batch_id: int) -> None:
    ack_path = continuous_runtime_report_path(job_id).with_suffix(".catalog-ack.json")
    try:
        ack_path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = ack_path.with_suffix(".tmp")
        temp_path.write_text(json.dumps({"batchId": batch_id, "acknowledgedAt": iso_now()}), encoding="utf-8")
        temp_path.replace(ack_path)
    except OSError:
        # Catalog remains the authority; a missed ack only makes the next
        # report include already-idempotent publications again.
        pass


def materialize_continuous_publication(
    db: Session,
    job: ETLJobModel,
    runtime: KafkaContinuousRuntimeModel,
    publication: dict[str, Any],
) -> bool:
    batch_id = str(publication["batchId"])
    if nonnegative_int(publication.get("storedCount"), 0) == 0:
        return True
    run_id = f"continuous:{job.id}:batch:{batch_id}"
    existing = etl_repository.get_dataset_by_id(db, job.dataset_id or f"ds_{normalize_column_name(job.target)}")
    existing_runs = (existing.payload or {}).get("materializationRuns") if existing and existing.payload else []
    if any(str(item.get("runId") or "") == run_id for item in existing_runs if isinstance(item, dict)):
        return True
    target = parse_kafka_target_path(job.storage_path or job.target_path, job.target, job.target_layer)
    output_path = f"s3a://{target['bucket']}/{target['prefix'].strip('/')}/_batches"
    result = {
        "endedAt": optional_string(publication.get("publishedAt")) or runtime.last_flush_at or runtime.heartbeat_at or iso_now(),
        "outputPath": output_path,
        "outputRows": runtime.stored_count,
        "materializationRows": nonnegative_int(publication.get("storedCount"), 0),
        "materializationOutputPath": optional_string(publication.get("dataPath")) or f"{output_path}/batch_id={batch_id}",
        "publicationManifest": optional_string(publication.get("manifestPath")),
        "runId": run_id,
        "sourceRanges": publication.get("sourceRanges") if isinstance(publication.get("sourceRanges"), list) else [],
        "sourceKind": "kafka",
        "status": "success",
    }
    try:
        dataset = dataset_from_spark_result(job, result, existing)
        etl_repository.save_dataset(db, dataset)
    except Exception as exc:  # Catalog metadata must not roll back a committed streaming checkpoint.
        runtime.last_error = f"Catalog materialization pending retry: {compact_storage_text(str(exc), limit=500)}"
        return False
    else:
        if str(runtime.last_error or "").startswith("Catalog materialization pending retry:"):
            runtime.last_error = None
        job.stats = {
            **(job.stats or {}),
            "inputRows": format_rows(runtime.consumed_count),
            "lastSuccess": runtime.last_flush_at or runtime.heartbeat_at or "-",
            "outputPath": output_path,
            "outputRows": format_rows(runtime.stored_count),
            "sampleScope": f"{runtime.topic} continuous micro-batch",
            "sourceUnits": "Kafka topic",
            "successRate": "100%" if runtime.failed_count == 0 else "확인 필요",
        }
        return True


def materialize_continuous_replay(
    db: Session,
    job: ETLJobModel,
    runtime: KafkaContinuousRuntimeModel,
    replay_result: dict[str, Any],
) -> None:
    replayed_count = nonnegative_int(replay_result.get("storedCount"), 0)
    if replayed_count == 0:
        return
    existing = etl_repository.get_dataset_by_id(db, job.dataset_id or f"ds_{normalize_column_name(job.target)}")
    target = parse_kafka_target_path(job.storage_path or job.target_path, job.target, job.target_layer)
    target_root = f"s3a://{target['bucket']}/{target['prefix'].strip('/')}/_batches"
    result = {
        "endedAt": optional_string(replay_result.get("endedAt")) or iso_now(),
        "outputPath": target_root,
        "outputRows": runtime.stored_count,
        "materializationRows": replayed_count,
        "materializationOutputPath": replay_result.get("outputPath") or target_root,
        "runId": replay_result.get("runId"),
        "sourceKind": "kafka",
        "status": "success",
    }
    try:
        etl_repository.save_dataset(db, dataset_from_spark_result(job, result, existing))
    except Exception as exc:  # Replay data is already durable; Catalog can retry independently.
        runtime.last_error = f"Replay Catalog materialization pending retry: {compact_storage_text(str(exc), limit=500)}"


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


def validate_create_request(request: CreatePipelineRequest) -> None:
    validate_requested_permission_grants(request.permission_grants)
    missing = []
    if not request.job_name:
        missing.append("jobName")
    if not request.source_type:
        missing.append("sourceType")
    if not request.source_label:
        missing.append("sourceLabel")
    if not request.target_dataset:
        missing.append("targetDataset")
    if not request.target_layer:
        missing.append("targetLayer")
    if not request.owner:
        missing.append("owner")
    if request.execution_mode == "continuous":
        if "kafka" not in request.source_type.lower():
            missing.append("continuousKafkaSource")
        if request.target_format.lower() != "parquet":
            missing.append("continuousTargetFormat=parquet")
        if any(step.enabled for step in request.transform_steps) or any(rule.enabled for rule in request.quality_rules):
            missing.append("continuousTransformAndQualityRules=unsupported")
    if request.record_parsing and request.record_parsing.enabled:
        parsing_names = [normalize_column_name(column.name) for column in request.record_parsing.columns]
        if request.source_type != "File / S3":
            missing.append("recordParsingSource=File / S3")
        if request.record_parsing.expected_field_count <= 0:
            missing.append("recordParsing.expectedFieldCount")
        if len(request.record_parsing.columns) != request.record_parsing.expected_field_count:
            missing.append("recordParsing.columns")
        if any(not name for name in parsing_names) or len(set(parsing_names)) != len(parsing_names):
            missing.append("recordParsing.columns[uniqueName]")
    if not request.schema_columns:
        missing.append("schemaColumns")
    elif not any(column.included and column.target_name.strip() for column in request.schema_columns):
        missing.append("schemaColumns[included]")
    if missing:
        raise ApiError(
            ErrorCode.VALIDATION_ERROR,
            f"Missing required fields: {', '.join(missing)}",
            status.HTTP_400_BAD_REQUEST,
        )


def validate_update_request(request: UpdatePipelineRequest) -> None:
    validate_requested_permission_grants(request.permission_grants)
    missing = []
    if not request.job_name:
        missing.append("jobName")
    if not request.target_dataset:
        missing.append("targetDataset")
    if not request.target_layer:
        missing.append("targetLayer")
    if not request.owner:
        missing.append("owner")
    if not request.schema_columns:
        missing.append("schemaColumns")
    elif not any(column.included and column.target_name.strip() for column in request.schema_columns):
        missing.append("schemaColumns[included]")
    if missing:
        raise ApiError(
            ErrorCode.VALIDATION_ERROR,
            f"Missing required fields: {', '.join(missing)}",
            status.HTTP_400_BAD_REQUEST,
        )


def validate_requested_permission_grants(grants: list[Any] | None) -> None:
    for grant in grants or []:
        principal_type = str(getattr(grant, "principal_type", "") or "").strip()
        principal_id = str(getattr(grant, "principal_id", "") or "").strip()
        actions = list(getattr(grant, "actions", []) or [])
        if principal_type != "public" and not principal_id:
            raise ApiError(
                ErrorCode.VALIDATION_ERROR,
                "permissionGrants principalId is required",
                status.HTTP_400_BAD_REQUEST,
            )
        if not actions:
            raise ApiError(
                ErrorCode.VALIDATION_ERROR,
                "permissionGrants actions must include at least one action",
                status.HTTP_400_BAD_REQUEST,
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


def has_successful_run(db: Session, job_id: str) -> bool:
    return any(run.status == "success" for run in etl_repository.list_runs_for_job(db, job_id))


def apply_update_request(job: ETLJobModel, request: UpdatePipelineRequest, target_changed: bool) -> None:
    job.name = request.job_name
    job.owner = request.owner
    job.target = request.target_dataset
    job.schedule = request.schedule_label
    job.schedule_policy = schedule_policy_from_request(request)
    job.schedule_summary = request.schedule_summary
    job.retry_policy = request.retry_policy.model_dump(mode="json", by_alias=True) if request.retry_policy else None
    job.retry_policy_summary = request.retry_policy_summary
    job.run_limit_summary = request.run_limit_summary
    job.schema_columns = [column.model_dump(mode="json", by_alias=True) for column in request.schema_columns]
    job.schema_fingerprint = request.schema_fingerprint
    job.schema_sample_rows = request.schema_sample_rows
    job.schema_summary = request.schema_summary
    job.rule_summary = request.rule_summary
    job.permission_summary = request.permission_summary
    job.permission_roles = request.permission_roles
    job.storage_type = request.storage_type
    job.partition = request.partition
    job.partition_columns = normalize_string_list(request.partition_columns)
    job.index_columns = normalize_string_list(request.index_columns)
    job.compression = request.compression
    job.storage_path = request.storage_path
    job.target_path = request.storage_path
    job.target_database = normalize_optional_text(request.target_database)
    job.target_description = normalize_optional_text(request.target_description)
    job.target_tags = normalize_target_tags(request.target_tags)
    job.target_format = request.target_format
    job.target_layer = request.target_layer
    job.rag = request.rag
    job.transform_output_columns = tuple_rows_to_lists(request.transform_output_columns)
    job.transform_steps = [step.model_dump(mode="json", by_alias=True) for step in request.transform_steps]
    job.quality_invalid_rows = request.quality_invalid_rows
    job.quality_rules = [rule.model_dump(mode="json", by_alias=True) for rule in request.quality_rules]
    job.quality_score = request.quality_score
    job.quality_status = request.quality_status
    job.last_state = "설정 수정됨"
    job.next_run = schedule_next_run_label(request.schedule_label, request.next_run_utc or job.next_run)
    job.stats = {
        **(job.stats or {}),
        "currentStage": "설정 수정됨",
        "schemaColumns": f"{len(dataset_schema_from_request(request)):,}개",
    }
    if target_changed:
        job.dataset_id = f"ds_{normalize_column_name(request.target_dataset)}"


def schedule_next_run_label(schedule_label: str | None, fallback: str | None = None) -> str:
    schedule = str(schedule_label or "").strip()
    fallback_label = str(fallback or "").strip()
    if not schedule or not has_scheduled_label(schedule):
        return "-"
    if "1회" in schedule or "예약" in schedule:
        return fallback_label if fallback_label and fallback_label != "-" else re.sub(r"\s*(예약\s*)?1회 실행\s*$", "", schedule).strip()
    return fallback_label if fallback_label and fallback_label != "-" else schedule


def has_scheduled_label(schedule_label: str | None) -> bool:
    schedule = str(schedule_label or "").strip().lower()
    if not schedule or schedule == "-":
        return False
    return not any(token in schedule for token in ["manual", "수동", "스케줄 없음", "건너뛰기"])


def job_schedule_kind(schedule_label: str | None) -> JobScheduleKind:
    schedule = str(schedule_label or "").strip().lower()
    if not schedule or schedule == "-" or any(token in schedule for token in ["manual", "수동", "스케줄 없음", "건너뛰기"]):
        return "none"
    if any(token in schedule for token in ["실시간", "realtime", "real-time", "stream", "kafka"]):
        return "realtime"
    if any(token in schedule for token in ["매일", "daily"]):
        return "daily"
    if any(token in schedule for token in ["매주", "weekly"]):
        return "weekly"
    if any(token in schedule for token in ["매월", "monthly"]):
        return "monthly"
    return "other"


def schedule_policy_from_request(request: CreatePipelineRequest | UpdatePipelineRequest) -> dict[str, Any]:
    watermark_policy = request.watermark_policy
    if hasattr(watermark_policy, "model_dump"):
        watermark_policy = watermark_policy.model_dump(mode="json", by_alias=True)
    return {
        "endDate": request.end_date,
        "nextRunUtc": request.next_run_utc,
        "overlapPolicy": request.overlap_policy or ("skip_if_running" if has_scheduled_label(request.schedule_label) else None),
        "startDate": request.start_date,
        "timezone": request.timezone,
        "watermarkPolicy": watermark_policy,
    }


def has_scheduled_execution(job: ETLJobModel) -> bool:
    return job.status != "stopped" and has_scheduled_label(job.schedule)


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


def advance_scheduled_job_after_tick(db: Session, job_id: str) -> None:
    job = etl_repository.get_job(db, job_id)
    if job is None or not isinstance(job.schedule_policy, dict):
        return

    next_run_utc = next_scheduled_run_utc(job)
    if not next_run_utc:
        return

    job.schedule_policy = {
        **job.schedule_policy,
        "nextRunUtc": next_run_utc,
    }
    job.next_run = next_run_utc
    etl_repository.save_job(db, job)


def next_scheduled_run_utc(job: ETLJobModel) -> str:
    schedule = str(job.schedule or "")
    current = ""
    if isinstance(job.schedule_policy, dict):
        current = str(job.schedule_policy.get("nextRunUtc") or "")
    try:
        base = datetime.fromisoformat(current.replace("Z", "+00:00")) if current else datetime.now(UTC)
    except ValueError:
        base = datetime.now(UTC)

    now = datetime.now(UTC)
    if schedule.startswith("매시간"):
        minute_match = re.search(r"매시간\s+(\d{1,2})분", schedule)
        minute = max(0, min(59, int(minute_match.group(1)) if minute_match else base.minute))
        candidate = base.replace(minute=minute, second=0, microsecond=0)
        while candidate <= now:
            candidate += timedelta(hours=1)
        return candidate.isoformat().replace("+00:00", "Z")

    if schedule.startswith("매일"):
        time_match = re.search(r"매일\s+(\d{1,2}):(\d{2})", schedule)
        hour = max(0, min(23, int(time_match.group(1)) if time_match else base.hour))
        minute = max(0, min(59, int(time_match.group(2)) if time_match else base.minute))
        candidate = base.replace(hour=hour, minute=minute, second=0, microsecond=0)
        while candidate <= now:
            candidate += timedelta(days=1)
        return candidate.isoformat().replace("+00:00", "Z")

    if schedule.startswith("매주"):
        candidate = base.replace(second=0, microsecond=0)
        while candidate <= now:
            candidate += timedelta(days=7)
        return candidate.isoformat().replace("+00:00", "Z")

    return ""


def apply_job_command(job: ETLJobModel, command: str) -> None:
    if command in {"run", "retry"}:
        now = iso_now()
        job.last_run = now
        job.last_state = "Spark 재실행 중" if command == "retry" else "Spark 실행 중"
        job.next_run = "-"
        job.progress = {"label": "Spark ETL 실행 중", "value": 66}
        job.status = "running"
        return
    if command == "pause":
        job.last_run = iso_now()
        job.last_state = "사용자 일시정지"
        job.next_run = "재개 대기"
        job.progress = job.progress or {"label": "일시정지됨", "value": 50}
        job.status = "paused"
        return
    if command == "stopSchedule":
        if job.status == "running" and job_schedule_kind(job.schedule) == "realtime":
            job.last_run = iso_now()
        job.last_state = "실시간 수집 중지" if job_schedule_kind(job.schedule) == "realtime" else "스케줄 일시중지"
        job.next_run = "-"
        job.progress = None
        job.status = "stopped"
        return
    if command == "resumeSchedule":
        policy_next_run = (job.schedule_policy or {}).get("nextRunUtc")
        job.last_state = "실시간 수집 재개됨" if job_schedule_kind(job.schedule) == "realtime" else "스케줄 재개됨"
        job.next_run = schedule_next_run_label(job.schedule, policy_next_run)
        job.progress = None
        job.status = "scheduled"
        return

    job.last_run = iso_now()
    job.last_state = "취소됨"
    job.next_run = schedule_next_run_label(job.schedule, job.next_run)
    job.progress = None
    job.status = "scheduled"


def run_from_command(job: ETLJobModel, command: str) -> ETLRunModel:
    now = iso_now()
    run_id = stable_id("run", f"{job.id}:{command}:{now}")
    input_rows = job.stats.get("inputRows") or job.stats.get("input_rows") or "0"
    if command in {"cancelRun", "stopSchedule"}:
        realtime_stop = command == "stopSchedule"
        return ETLRunModel(
            run_id=run_id,
            job_id=job.id,
            status="canceled",
            started_at=now,
            ended_at=now,
            duration="수집 중지" if realtime_stop else "-",
            input_rows=input_rows,
            output_rows="0",
            output_path=None,
            failed_stage="실시간 수집 중지" if realtime_stop else "실행 취소",
            error_summary="사용자 요청으로 실시간 수집 중지" if realtime_stop else "사용자 취소",
        )
    return ETLRunModel(
        run_id=run_id,
        job_id=job.id,
        status="running",
        started_at=now,
        ended_at="-",
        duration="실행 중",
        input_rows=input_rows,
        output_rows="0",
        output_path="-",
        failed_stage="-",
        error_summary="-",
    )


def source_metrics_from_request(request: CreatePipelineRequest, schema: list[tuple[str, str]], sample_rows: list[list[str]]) -> dict[str, Any]:
    sample_rows_count = len(sample_rows)
    schema_columns = len(schema)
    row_limit = parse_positive_integer(field_value(request.source_config, "__Sample Row Limit"))
    requested_bytes = parse_positive_integer(field_value(request.source_config, "__Sample Requested Bytes"))
    source_units = parse_positive_integer(field_value(request.source_config, "__Source Unit Count"))
    sample_scope = field_value(request.source_config, "__Schema Sample Scope Label") or "현재 샘플"
    unit_label = source_unit_label(request.source_type)
    row_label = "문서" if request.source_type == "MongoDB" else "행"
    dataset_rows = (
        f"샘플 {sample_rows_count:,}{row_label}"
        if sample_rows_count > 0
        else f"{source_units:,}개 {unit_label} 감지"
        if source_units > 0
        else "샘플 없음"
    )
    dataset_size = (
        format_bytes(requested_bytes)
        if requested_bytes > 0
        else f"최대 {row_limit:,}{row_label} 샘플"
        if row_limit > 0
        else f"{source_units:,}개 {unit_label}"
        if source_units > 0
        else "확인 대기"
    )
    return {
        "dataset_rows": dataset_rows,
        "dataset_size": dataset_size,
        "row_label": row_label,
        "sample_rows": sample_rows_count,
        "sample_scope": sample_scope,
        "schema_columns": schema_columns,
        "source_units": source_units,
        "unit_label": unit_label,
    }


def initial_job_stats(metrics: dict[str, Any]) -> dict[str, str]:
    return {
        "averageDuration": "-",
        "currentStage": "생성 완료 · 실행 전",
        "inputRows": f"{metrics['sample_rows']:,} 샘플 {metrics['row_label']}" if metrics["sample_rows"] > 0 else "-",
        "lastSuccess": "-",
        "outputRows": "0",
        "sampleScope": metrics["sample_scope"],
        "schemaColumns": f"{metrics['schema_columns']:,}개",
        "sourceUnits": f"{metrics['source_units']:,}개 {metrics['unit_label']}" if metrics["source_units"] > 0 else "-",
        "successRate": "-",
        "totalRuns": "0회",
    }


def initial_dag_steps(request: CreatePipelineRequest, metrics: dict[str, Any]) -> list[dict[str, str]]:
    return [
        {"id": "source", "meta": f"{request.source_type} / {request.source_label}", "status": "success", "title": "1. 소스 연결"},
        {"id": "schema", "meta": f"{metrics['schema_columns']:,}개 컬럼 · {metrics['sample_scope']}", "status": "success" if metrics["schema_columns"] > 0 else "pending", "title": "2. 스키마 추론"},
        {"id": "create", "meta": request.target_dataset, "status": "success", "title": "3. Job 생성"},
        {"id": "transform", "meta": f"{len(request.transform_steps)}개 규칙", "status": "pending", "title": "4. 처리 규칙 대기"},
        {"id": "quality", "meta": f"{len(request.quality_rules)}개 검사", "status": "pending", "title": "5. 품질 검증 대기"},
        {"id": "run", "meta": "아직 실행되지 않음", "status": "pending", "title": "6. 실행 대기"},
    ]


def dag_steps_from_command(job: ETLJobModel, command: str, run: dict[str, Any]) -> list[dict[str, str]]:
    if command in {"cancelRun", "stopSchedule"}:
        return [
            {"id": "source", "meta": job.source, "status": "blocked", "title": "1. 소스 연결"},
            {"id": "schema", "meta": job.stats.get("schemaColumns", "-"), "status": "blocked", "title": "2. 스키마 확인"},
            {"id": "read", "meta": run.get("inputRows", "0"), "status": "blocked", "title": "3. 소스 읽기"},
            {"id": "transform", "meta": f"{len(job.transform_steps)}개 규칙", "status": "blocked", "title": "4. 처리 규칙"},
            {"id": "quality", "meta": f"{len(job.quality_rules)}개 검사", "status": "pending", "title": "5. 품질 검증"},
            {"id": "target", "meta": job.target, "status": "pending", "title": "6. Lake 적재"},
        ]
    return [
        {"id": "source", "meta": job.source, "status": "success", "title": "1. 소스 연결"},
        {"id": "schema", "meta": job.stats.get("schemaColumns", "-"), "status": "success", "title": "2. 스키마 확인"},
        {"id": "read", "meta": run.get("inputRows", "0"), "status": "running", "title": "3. Spark 소스 읽기"},
        {"id": "transform", "meta": f"{len(job.transform_steps)}개 규칙", "status": "pending", "title": "4. 처리 규칙 적용"},
        {"id": "quality", "meta": f"{len(job.quality_rules)}개 검사", "status": "pending", "title": "5. 품질 검증"},
        {"id": "write", "meta": run.get("outputPath", "-"), "status": "pending", "title": "6. Parquet 적재"},
        {"id": "catalog", "meta": job.target, "status": "pending", "title": "7. 카탈로그 데이터셋 갱신"},
    ]


def stats_from_runs(job: ETLJobModel, runs: list[Any]) -> dict[str, Any]:
    total_runs = len(runs)
    success_runs = len([run for run in runs if run.status == "success"])
    latest_run = runs[0] if runs else None
    return {
        **(job.stats or {}),
        "averageDuration": latest_run.duration if latest_run else "-",
        "currentStage": job.last_state,
        "lastSuccess": next((run.ended_at for run in runs if run.status == "success"), "-"),
        "outputPath": latest_run.output_path if latest_run else job.stats.get("outputPath", "-"),
        "outputRows": latest_run.output_rows if latest_run else job.stats.get("outputRows", "0"),
        "successRate": f"{round((success_runs / total_runs) * 100)}%" if total_runs else "-",
        "totalRuns": f"{total_runs:,}회",
    }


def dataset_schema_from_request(request: CreatePipelineRequest | UpdatePipelineRequest) -> list[tuple[str, str]]:
    if request.transform_output_columns:
        return [(name, type_ or "string") for name, type_ in request.transform_output_columns if name]
    return [
        (column.target_name, (column.type or "string").lower())
        for column in request.schema_columns
        if column.included and column.target_name.strip()
    ]


def dataset_sample_rows_from_request(request: CreatePipelineRequest, schema: list[tuple[str, str]]) -> list[list[str]]:
    if not request.schema_sample_rows:
        return []
    columns = [(column, index) for index, column in enumerate(request.schema_columns) if column.included and column.target_name.strip()]
    source_index_by_output_name = {
        name: index
        for column, index in columns
        for name in [column.target_name, column.source_name]
        if name
    }
    if not columns:
        return [[str(row[index] if index < len(row) else "-") for index, _ in enumerate(schema)] for row in request.schema_sample_rows]
    return [
        [str(row[source_index_by_output_name[name]] if name in source_index_by_output_name and source_index_by_output_name[name] < len(row) else "") for name, _ in schema]
        for row in request.schema_sample_rows
    ]


def quality_summary_from_request(request: CreatePipelineRequest) -> str:
    if request.quality_score is not None:
        return f"품질 점수 {request.quality_score:.1f}% · 상태 {quality_status_label(request.quality_status)}"
    return request.rule_summary or "확인 대기"


def quality_status_label(status_value: str | None) -> str:
    return {"pass": "통과", "warn": "주의", "fail": "실패"}.get(str(status_value or "checked").lower(), "확인됨")


def field_value(fields: list[tuple[str, str]], label: str) -> str:
    for field_label, value in fields:
        if field_label == label:
            return str(value).strip()
    return ""


def kafka_field_value(fields: list[tuple[str, str]], *labels: str) -> str:
    for label in labels:
        value = field_value(fields, label)
        if value:
            return value
    return ""


def continuous_config_from_request(request: CreatePipelineRequest, job_id: str) -> dict[str, Any] | None:
    if request.execution_mode != "continuous":
        return None
    config = request.continuous_config
    base_path = (request.storage_path or f"s3a://asklake-output/{normalize_column_name(request.target_dataset)}/").rstrip("/")
    return {
        "initialOffsetPolicy": config.initial_offset_policy if config else "earliest",
        "triggerIntervalSeconds": config.trigger_interval_seconds if config else 30,
        "maxOffsetsPerTrigger": config.max_offsets_per_trigger if config else 10000,
        "schemaEvolutionPolicy": config.schema_evolution_policy.model_dump(mode="json", by_alias=True) if config else {
            "additiveNullable": "allow",
            "missingRequired": "quarantine",
            "incompatibleType": "quarantine",
            "unknownField": "preserve",
        },
        "checkpointPath": f"{base_path}/_checkpoints/{job_id}",
    }


def continuous_runtime_from_job(job: ETLJobModel) -> KafkaContinuousRuntimeModel:
    fields = job.source_config or []
    broker = kafka_field_value(fields, "Broker / Endpoint", "BROKER / ENDPOINT") or "127.0.0.1:19092"
    topic = kafka_field_value(fields, "TOPIC / QUEUE NAME", "Topic") or "reviews.raw"
    consumer_group_id = kafka_field_value(fields, "Consumer Group ID", "CONSUMER GROUP ID") or f"asklake-stream-{job.id.lower()}"
    config = job.continuous_config or {}
    checkpoint_path = str(config.get("checkpointPath") or f"s3a://asklake-output/{normalize_column_name(job.target)}/_checkpoints/{job.id}")
    return KafkaContinuousRuntimeModel(
        job_id=job.id,
        broker=broker,
        topic=topic,
        consumer_group_id=consumer_group_id,
        target_identity=str(job.storage_path or job.target_path or job.target),
        checkpoint_path=checkpoint_path,
        status="stopped",
    )


def source_unit_label(source_type: str) -> str:
    if source_type == "MongoDB":
        return "컬렉션"
    if source_type == "PostgreSQL":
        return "테이블"
    if source_type in ("Stream / Kafka", "Kafka JSON"):
        return "파티션"
    return "오브젝트"


def make_job_id(value: str) -> str:
    return f"JOB-{stable_id('job', f'{value}:{iso_now()}')[-8:].upper()}"


def stable_id(prefix: str, value: str) -> str:
    digest = hashlib.sha1(value.encode("utf-8")).hexdigest()[:12]
    return f"{prefix}_{digest}"


def normalize_column_name(value: str) -> str:
    normalized = re.sub(r"[^a-zA-Z0-9_]+", "_", value.strip().lower())
    normalized = re.sub(r"_+", "_", normalized).strip("_")
    return normalized or "dataset"


def fallback_lineage_graph(dataset: CatalogDatasetModel) -> dict[str, Any]:
    current_node = lineage_node(dataset.id, dataset.name, dataset.layer, dataset.schema_json or [], "ICEBERG")
    upstream_nodes = [
        lineage_node(
            normalize_lineage_id(f"{dataset.id}-{item}"),
            item,
            "SOURCE" if index == 0 else "BRONZE",
            dataset.schema_json or [],
            "SOURCE" if index == 0 else "ICEBERG",
        )
        for index, item in enumerate(dataset.upstream or [])
    ]
    edges = []
    for upstream_node in upstream_nodes:
        for source_column, target_column in zip(upstream_node["columns"], current_node["columns"], strict=False):
            edges.append({
                "fromColumnId": source_column["id"],
                "fromDatasetId": upstream_node["id"],
                "toColumnId": target_column["id"],
                "toDatasetId": current_node["id"],
            })
    return {
        "datasetId": dataset.id,
        "datasets": [*upstream_nodes, current_node],
        "edges": edges,
    }


def lineage_node(dataset_id: str, name: str, layer: str, schema: list[list[str]], engine: str) -> dict[str, Any]:
    return {
        "columns": [
            {
                "id": normalize_lineage_id(f"{dataset_id}-{column_name}"),
                "name": str(column_name),
                "type": str(column_type or "string"),
            }
            for column_name, column_type in schema
            if column_name
        ],
        "engine": engine,
        "id": dataset_id,
        "layer": layer,
        "name": name,
    }


def normalize_lineage_id(value: str) -> str:
    normalized = re.sub(r"[^a-zA-Z0-9]+", "-", value.strip().lower())
    return normalized.strip("-") or "lineage"


def tuple_rows_to_lists(rows: list[tuple[str, str]]) -> list[list[str]]:
    return [[str(key), str(value)] for key, value in rows]


def normalize_string_list(values: list[str] | None) -> list[str]:
    seen: set[str] = set()
    normalized: list[str] = []
    for value in values or []:
        item = str(value).strip()
        if not item or item in seen:
            continue
        seen.add(item)
        normalized.append(item)
    return normalized


def normalize_target_tags(values: list[str] | None) -> list[str]:
    normalized = []
    for value in normalize_string_list(values):
        normalized.append(value if value.startswith("#") else f"#{value}")
    return normalized


def normalize_optional_text(value: str | None) -> str | None:
    text = str(value).strip() if value is not None else ""
    return text or None


def target_dataset_description(job: ETLJobModel) -> str:
    return (
        normalize_optional_text(job.target_description)
        or f"{job.source_type} 소스 {job.source_label} 실행 결과 데이터셋"
    )


def target_dataset_tags(job: ETLJobModel) -> list[str]:
    return normalize_target_tags(job.target_tags) or ["#생성", f"#{str(job.target_layer).lower()}"]


def parse_positive_integer(value: str) -> int:
    try:
        parsed = int(float(value))
    except (TypeError, ValueError):
        return 0
    return parsed if parsed > 0 else 0


def format_bytes(value: int) -> str:
    units = ["B", "KB", "MB", "GB", "TB"]
    size = float(value)
    unit = 0
    while size >= 1024 and unit < len(units) - 1:
        size /= 1024
        unit += 1
    return f"{size:.1f} {units[unit]}" if unit > 0 else f"{int(size)} {units[unit]}"


def format_rows(value: Any) -> str:
    try:
        parsed = int(float(value))
    except (TypeError, ValueError):
        return str(value or "0")
    return f"{parsed:,}\ud589"


def format_duration_ms(value: Any) -> str:
    try:
        ms = int(float(value))
    except (TypeError, ValueError):
        return "-"
    if ms < 1000:
        return f"{ms}ms"
    seconds = round(ms / 1000)
    if seconds < 60:
        return f"{seconds}\ucd08"
    minutes, rest = divmod(seconds, 60)
    return f"{minutes}\ubd84 {rest}\ucd08"


def format_iso_duration(started_at: str, ended_at: str) -> str:
    try:
        start = datetime.fromisoformat(started_at.replace("Z", "+00:00"))
        end = datetime.fromisoformat(ended_at.replace("Z", "+00:00"))
    except ValueError:
        return "-"
    return format_duration_ms(max(0, int((end - start).total_seconds() * 1000)))


def iso_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")
