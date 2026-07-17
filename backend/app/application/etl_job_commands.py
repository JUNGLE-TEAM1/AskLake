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

from app.core.auth_context import ActorContext
from app.core.errors import ApiError
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


DELETE_BLOCKING_RUN_STATUSES = frozenset({"queued", "running"})
DELETE_BLOCKING_RUNTIME_STATUSES = frozenset({"starting", "running", "pausing", "stopping"})
DELETE_BLOCKING_SESSION_STATUSES = frozenset({"starting", "running", "stopping"})


@dataclass(frozen=True, slots=True)
class EtlJobDeleteHooks:
    add_audit_event: Callable[..., object | None]
    permission_grants_for_job: Callable[[Session, ETLJobModel], list[Any]]
    reconcile_stale_maintenance_runs: Callable[..., object | None]
    record_audit_event: Callable[..., object | None]
    require_governed_access: Callable[..., object | None]
    require_permission: Callable[..., object | None]


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
            target_type="etl_job",
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
        target_type="etl_job",
    )
    try:
        db.commit()
    except Exception:
        db.rollback()
        raise
