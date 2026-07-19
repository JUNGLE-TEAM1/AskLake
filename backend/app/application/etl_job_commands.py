"""ETL Job write commands with explicit transaction ownership.

The public ``etl_service`` functions remain compatibility façades. This module
owns the delete sequence: authorize before inspecting workload evidence, reject
active work, delete dependent rows, record the audit event, and commit or roll
back the transaction.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from fastapi import status
from sqlalchemy import delete
from sqlalchemy.orm import Session

from app.application.pipeline_mapping import CreatePipelineMappingContext
from app.core.auth_context import ActorContext
from app.core.errors import ApiError
from app.domain.audit import AuditTargetType
from app.models import (
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
from app.repositories import etl_repository
from app.schemas.common import ErrorCode
from app.schemas.etl import (
    CreatePipelineRequest,
    CreatePipelineResponse,
    JobRowData,
    UpdatePipelineRequest,
)


DELETE_BLOCKING_RUN_STATUSES = frozenset({"queued", "running"})
DELETE_BLOCKING_RUNTIME_STATUSES = frozenset({"starting", "running", "pausing", "stopping"})
DELETE_BLOCKING_SESSION_STATUSES = frozenset({"starting", "running", "stopping"})
UPDATE_BLOCKING_RUNTIME_STATUSES = frozenset({"starting", "running", "pausing", "stopping"})


@dataclass(frozen=True, slots=True)
class EtlJobDeleteHooks:
    add_audit_event: Callable[..., object | None]
    permission_grants_for_job: Callable[[Session, ETLJobModel], list[Any]]
    reconcile_stale_maintenance_runs: Callable[..., object | None]
    record_audit_event: Callable[..., object | None]
    require_governed_access: Callable[..., object | None]
    require_permission: Callable[..., object | None]


@dataclass(frozen=True, slots=True)
class EtlPipelineCreateHooks:
    apply_append_request_to_job: Callable[
        [ETLJobModel, CreatePipelineRequest, CreatePipelineMappingContext],
        None,
    ]
    apply_compiled_rules: Callable[..., None]
    build_mapping_context: Callable[..., CreatePipelineMappingContext]
    compile_pipeline_rules: Callable[..., Any]
    continuous_runtime_from_job: Callable[[ETLJobModel], KafkaContinuousRuntimeModel]
    identity_name: Callable[[str | None], str]
    identity_profile: Callable[[str], dict[str, Any]]
    is_internal_data_lake_source: Callable[[str | None], bool]
    make_dataset_id: Callable[[str], str]
    make_job_id: Callable[[str], str]
    map_create_request_to_job: Callable[
        [CreatePipelineRequest, CreatePipelineMappingContext],
        ETLJobModel,
    ]
    persist_permission_grants: Callable[..., JobRowData]
    require_compiled_rules: Callable[[Any], None]
    resolve_internal_data_lake_source: Callable[..., object]
    validate_create_request: Callable[[CreatePipelineRequest], None]


@dataclass(frozen=True, slots=True)
class EtlPipelineUpdateHooks:
    apply_compiled_rules: Callable[..., None]
    apply_update_request: Callable[[ETLJobModel, UpdatePipelineRequest, bool], None]
    compile_pipeline_rules: Callable[..., Any]
    continuous_checkpoint_initialized: Callable[[KafkaContinuousRuntimeModel], bool]
    continuous_processing_contract_changed: Callable[[ETLJobModel, UpdatePipelineRequest], bool]
    has_successful_run: Callable[[Session, str], bool]
    permission_grants_for_job: Callable[[Session, ETLJobModel], list[Any]]
    persist_permission_grants: Callable[..., JobRowData]
    require_compiled_rules: Callable[[Any], None]
    require_governed_access: Callable[..., object | None]
    require_permission: Callable[..., object | None]
    target_identity_changed: Callable[[ETLJobModel, UpdatePipelineRequest], bool]
    validate_target_contract: Callable[..., None]
    validate_update_request: Callable[[UpdatePipelineRequest], None]
    with_permissions: Callable[[Session, JobRowData, ActorContext], JobRowData]


def create_pipeline(
    db: Session,
    request: CreatePipelineRequest,
    actor: ActorContext | str = "demo-user",
    *,
    hooks: EtlPipelineCreateHooks,
) -> CreatePipelineResponse:
    actor_context = _prepare_create_request(db, request, actor, hooks)
    actor_name = actor_context.name
    created_by = hooks.identity_name(request.created_by or actor_name or request.owner)
    created_by_profile = request.created_by_profile or hooks.identity_profile(created_by)
    existing_job = etl_repository.get_job_by_target(db, request.target_dataset)
    dataset_id = (
        str(existing_job.dataset_id)
        if existing_job is not None and existing_job.dataset_id
        else hooks.make_dataset_id(request.target_dataset)
    )
    if existing_job is not None:
        return _append_pipeline(
            db,
            request,
            existing_job,
            actor_context,
            dataset_id,
            created_by,
            created_by_profile,
            hooks,
        )
    return _create_pipeline(
        db,
        request,
        actor_context,
        dataset_id,
        created_by,
        created_by_profile,
        hooks,
    )


def _prepare_create_request(
    db: Session,
    request: CreatePipelineRequest,
    actor: ActorContext | str,
    hooks: EtlPipelineCreateHooks,
) -> ActorContext:
    compiled_rules = hooks.compile_pipeline_rules(request)
    hooks.require_compiled_rules(compiled_rules)
    hooks.apply_compiled_rules(request, compiled_rules)
    hooks.validate_create_request(request)
    actor_context = actor if isinstance(actor, ActorContext) else ActorContext(name=actor)
    if hooks.is_internal_data_lake_source(request.source_type):
        hooks.resolve_internal_data_lake_source(db, request.source_config, actor=actor_context)
    return actor_context


def _append_pipeline(
    db: Session,
    request: CreatePipelineRequest,
    existing_job: ETLJobModel,
    actor: ActorContext,
    dataset_id: str,
    created_by: str,
    created_by_profile: dict[str, Any],
    hooks: EtlPipelineCreateHooks,
) -> CreatePipelineResponse:
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
    append_context = hooks.build_mapping_context(
        request,
        dataset_id=dataset_id,
        job_id=existing_job.id,
        created_by=created_by,
        created_by_profile=created_by_profile,
    )
    hooks.apply_append_request_to_job(existing_job, request, append_context)
    saved_job = etl_repository.save_job(db, existing_job)
    saved_job = hooks.persist_permission_grants(
        db,
        saved_job,
        request.permission_grants,
        created_by,
        actor,
    )
    return _create_response(request, dataset_id, saved_job)


def _create_pipeline(
    db: Session,
    request: CreatePipelineRequest,
    actor: ActorContext,
    dataset_id: str,
    created_by: str,
    created_by_profile: dict[str, Any],
    hooks: EtlPipelineCreateHooks,
) -> CreatePipelineResponse:
    job_id = hooks.make_job_id(request.id or request.job_name)
    job = hooks.map_create_request_to_job(
        request,
        hooks.build_mapping_context(
            request,
            dataset_id=dataset_id,
            job_id=job_id,
            created_by=created_by,
            created_by_profile=created_by_profile,
        ),
    )
    saved_job = etl_repository.create_job(db, job)
    if request.execution_mode == "continuous":
        etl_repository.save_kafka_continuous_runtime(db, hooks.continuous_runtime_from_job(job))
        saved_job = etl_repository.get_job_schema(db, job_id) or saved_job
    saved_job = hooks.persist_permission_grants(
        db,
        saved_job,
        request.permission_grants,
        created_by,
        actor,
    )
    return _create_response(request, dataset_id, saved_job)


def _create_response(
    request: CreatePipelineRequest,
    dataset_id: str,
    saved_job: JobRowData,
) -> CreatePipelineResponse:
    return CreatePipelineResponse(
        catalog_target={
            "id": dataset_id,
            "layer": request.target_layer,
            "name": request.target_dataset,
            "status": "pending_run",
        },
        job=saved_job,
    )


def update_pipeline(
    db: Session,
    job_id: str,
    request: UpdatePipelineRequest,
    actor: ActorContext | None = None,
    *,
    hooks: EtlPipelineUpdateHooks,
) -> JobRowData:
    job = etl_repository.get_job(db, job_id)
    if job is None:
        raise ApiError(ErrorCode.NOT_FOUND, f"Job not found: {job_id}", status.HTTP_404_NOT_FOUND)

    actor_context = actor or ActorContext()
    _authorize_update(db, job, job_id, actor_context, hooks)
    _prepare_update_request(job, request, hooks)
    target_changed = _validate_update_mutability(db, job, job_id, request, hooks)
    hooks.apply_update_request(job, request, target_changed)
    saved_job = etl_repository.save_job(db, job)
    saved_job = hooks.persist_permission_grants(
        db,
        saved_job,
        request.permission_grants,
        actor_context.name,
        actor_context,
    )
    return hooks.with_permissions(db, saved_job, actor_context)


def _authorize_update(
    db: Session,
    job: ETLJobModel,
    requested_job_id: str,
    actor: ActorContext,
    hooks: EtlPipelineUpdateHooks,
) -> None:
    hooks.require_governed_access(
        db,
        actor,
        action="manage",
        api_path=f"/api/etl/jobs/{requested_job_id}",
        http_method="PATCH",
        metadata={"owner": job.owner},
        resource_id=job.id,
        resource_name=job.name,
        resource_type="etl_job",
    )
    hooks.require_permission(
        actor,
        "manage",
        owner=job.owner,
        grants=hooks.permission_grants_for_job(db, job),
        resource_label="job",
    )


def _prepare_update_request(
    job: ETLJobModel,
    request: UpdatePipelineRequest,
    hooks: EtlPipelineUpdateHooks,
) -> None:
    compiled_rules = hooks.compile_pipeline_rules(
        request,
        execution_mode=job.execution_mode or "snapshot",
        source_type=job.source_type or "",
    )
    hooks.require_compiled_rules(compiled_rules)
    hooks.apply_compiled_rules(request, compiled_rules)
    hooks.validate_update_request(request)
    hooks.validate_target_contract(
        source_type=job.source_type or "",
        execution_mode=job.execution_mode or "snapshot",
        target_layer=request.target_layer,
        target_format=request.target_format,
    )


def _validate_update_mutability(
    db: Session,
    job: ETLJobModel,
    requested_job_id: str,
    request: UpdatePipelineRequest,
    hooks: EtlPipelineUpdateHooks,
) -> bool:
    runtime = (
        etl_repository.get_kafka_continuous_runtime(db, job.id)
        if job.execution_mode == "continuous"
        else None
    )
    continuous_contract_changed = hooks.continuous_processing_contract_changed(job, request)
    if (
        runtime is not None
        and continuous_contract_changed
        and runtime.status in UPDATE_BLOCKING_RUNTIME_STATUSES
    ):
        raise ApiError(
            "CONTINUOUS_IMMUTABLE_CONFIG_ACTIVE",
            "Stop the Continuous worker before changing schema, Rules, or target configuration.",
            status.HTTP_409_CONFLICT,
        )
    if job.status == "running":
        raise ApiError(
            ErrorCode.CONFLICT,
            f"Job is running and cannot be updated: {requested_job_id}",
            status.HTTP_409_CONFLICT,
        )
    if (
        runtime is not None
        and continuous_contract_changed
        and hooks.continuous_checkpoint_initialized(runtime)
    ):
        raise ApiError(
            "CONTINUOUS_CHECKPOINT_CONTRACT_IMMUTABLE",
            "This Continuous checkpoint already has a schema and Rule contract. Copy the Job to use a new checkpoint.",
            status.HTTP_409_CONFLICT,
        )
    target_changed = hooks.target_identity_changed(job, request)
    if target_changed and hooks.has_successful_run(db, job.id):
        raise ApiError(
            ErrorCode.VALIDATION_ERROR,
            "Target dataset, database, layer, format, storage type, and path are immutable after a successful run. Clone the job to change its destination.",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    return target_changed


def delete_job(
    db: Session,
    job_id: str,
    actor: ActorContext | None = None,
    *,
    hooks: EtlJobDeleteHooks,
) -> str:
    job = etl_repository.get_job_for_update(db, job_id)
    if job is None:
        raise ApiError(ErrorCode.NOT_FOUND, f"Job not found: {job_id}", status.HTTP_404_NOT_FOUND)

    actor_context = _authorize_delete(db, job, job_id, actor, hooks)
    _require_idle_job(db, job, job_id, hooks)
    _persist_delete(db, job, job_id, actor_context, hooks)
    return job_id


def _authorize_delete(
    db: Session,
    job: ETLJobModel,
    requested_job_id: str,
    actor: ActorContext | None,
    hooks: EtlJobDeleteHooks,
) -> ActorContext:
    actor_context = actor or ActorContext()
    hooks.require_governed_access(
        db,
        actor_context,
        action="delete",
        api_path=f"/api/etl/jobs/{requested_job_id}",
        http_method="DELETE",
        metadata={"owner": job.owner},
        resource_id=job.id,
        resource_name=job.name,
        resource_type="etl_job",
    )
    try:
        hooks.require_permission(
            actor_context,
            "delete",
            owner=job.owner,
            grants=hooks.permission_grants_for_job(db, job),
            resource_label="job",
        )
    except ApiError as exc:
        hooks.record_audit_event(
            db,
            action="etl_job.delete.forbidden",
            actor=actor_context,
            api_path=f"/api/etl/jobs/{requested_job_id}",
            http_method="DELETE",
            metadata={"owner": job.owner, "requiredAction": "delete"},
            result="forbidden",
            status_code=exc.status_code,
            target_id=job.id,
            target_name=job.name,
            target_type=AuditTargetType.ETL_JOB,
        )
        raise
    return actor_context


def _require_idle_job(
    db: Session,
    job: ETLJobModel,
    requested_job_id: str,
    hooks: EtlJobDeleteHooks,
) -> None:
    active_runs = [
        run
        for run in etl_repository.list_run_models_for_job(db, job.id)
        if run.status in DELETE_BLOCKING_RUN_STATUSES
    ]
    if active_runs:
        raise ApiError(
            ErrorCode.CONFLICT,
            f"Job has an active run and cannot be deleted: {requested_job_id}",
            status.HTTP_409_CONFLICT,
            {"runId": active_runs[0].run_id, "runStatus": active_runs[0].status},
        )

    runtime = etl_repository.get_kafka_continuous_runtime(db, job.id)
    if runtime is not None and runtime.status in DELETE_BLOCKING_RUNTIME_STATUSES:
        raise ApiError(
            ErrorCode.CONFLICT,
            f"Continuous Job is active and cannot be deleted: {requested_job_id}",
            status.HTTP_409_CONFLICT,
            {"runtimeStatus": runtime.status},
        )
    active_sessions = [
        session
        for session in etl_repository.list_kafka_continuous_sessions(db, job.id)
        if session.status in DELETE_BLOCKING_SESSION_STATUSES
    ]
    if active_sessions:
        raise ApiError(
            ErrorCode.CONFLICT,
            f"Continuous Job has an active session and cannot be deleted: {requested_job_id}",
            status.HTTP_409_CONFLICT,
            {"sessionId": active_sessions[0].session_id, "sessionStatus": active_sessions[0].status},
        )

    hooks.reconcile_stale_maintenance_runs(db, job.id, commit=False)
    active_maintenance = etl_repository.list_kafka_continuous_maintenance_run_models(
        db,
        job.id,
        active_only=True,
    )
    if active_maintenance:
        raise ApiError(
            ErrorCode.CONFLICT,
            f"Continuous maintenance is active and the Job cannot be deleted: {requested_job_id}",
            status.HTTP_409_CONFLICT,
            {
                "maintenanceRunId": active_maintenance[0].run_id,
                "maintenanceStatus": active_maintenance[0].status,
            },
        )


def _persist_delete(
    db: Session,
    job: ETLJobModel,
    requested_job_id: str,
    actor: ActorContext,
    hooks: EtlJobDeleteHooks,
) -> None:
    job_name = job.name
    job_owner = job.owner

    db.execute(delete(KafkaContinuousBatchModel).where(KafkaContinuousBatchModel.job_id == job.id))
    db.execute(delete(KafkaContinuousSessionModel).where(KafkaContinuousSessionModel.job_id == job.id))
    db.execute(delete(KafkaContinuousMaintenanceRunModel).where(KafkaContinuousMaintenanceRunModel.job_id == job.id))
    db.execute(delete(KafkaContinuousRuntimeModel).where(KafkaContinuousRuntimeModel.job_id == job.id))
    db.execute(delete(ETLRunModel).where(ETLRunModel.job_id == job.id))
    db.execute(delete(KafkaSnapshotModel).where(KafkaSnapshotModel.job_id == job.id))
    db.execute(delete(PermissionGrantModel).where(
        PermissionGrantModel.resource_type == "etl_job",
        PermissionGrantModel.resource_id == job.id,
    ))
    db.execute(delete(ResourceLockModel).where(
        ResourceLockModel.resource_type == "etl_job",
        ResourceLockModel.resource_id == job.id,
    ))
    db.delete(job)
    hooks.add_audit_event(
        db,
        actor=actor,
        action="etl_job.deleted",
        api_path=f"/api/etl/jobs/{requested_job_id}",
        http_method="DELETE",
        metadata={"owner": job_owner},
        result="success",
        status_code=status.HTTP_200_OK,
        target_id=requested_job_id,
        target_name=job_name,
        target_type=AuditTargetType.ETL_JOB,
    )
    try:
        db.commit()
    except Exception:
        db.rollback()
        raise
