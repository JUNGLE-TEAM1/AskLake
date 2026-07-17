"""Job list/detail hydration use cases.

The public ``etl_service`` functions remain compatibility façades. This module
owns the read sequence: refresh runtime evidence, hydrate repository schemas,
apply actor permissions, and build stable list facets or detail failures.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from fastapi import status
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext
from app.core.errors import ApiError
from app.models import ETLJobModel
from app.repositories import etl_repository
from app.schemas.common import ErrorCode
from app.schemas.etl import (
    JobListFacets,
    JobListResponse,
    JobRowData,
    JobRunOutcome,
    JobScheduleKind,
)


JOB_STATUSES = ("scheduled", "failed", "running", "paused", "canceled", "stopped")


@dataclass(frozen=True, slots=True)
class EtlJobQueryHooks:
    record_audit_event: Callable[..., object | None]
    refresh_continuous_runtime: Callable[[Session, ETLJobModel], None]
    schedule_kind: Callable[[str | None], JobScheduleKind]
    sync_airflow_runs: Callable[[Session, ETLJobModel], None]
    with_permissions: Callable[[Session, JobRowData, ActorContext], JobRowData]


def list_jobs(
    db: Session,
    actor: ActorContext | None = None,
    last_run_outcome: JobRunOutcome | None = None,
    owner: str | None = None,
    statuses: list[str] | None = None,
    schedule_kind: JobScheduleKind | None = None,
    *,
    hooks: EtlJobQueryHooks,
) -> JobListResponse:
    for job in etl_repository.list_job_models(db):
        hooks.refresh_continuous_runtime(db, job)

    actor_context = actor or ActorContext()
    visible_jobs = [
        hooks.with_permissions(db, job, actor_context)
        for job in etl_repository.list_jobs(db)
    ]
    all_jobs = [job for job in visible_jobs if job.permissions.can_view]
    selected_statuses = set(statuses or [])
    filtered_jobs = [
        job
        for job in all_jobs
        if (not selected_statuses or job.status in selected_statuses)
        and (not owner or job.owner == owner)
        and (not last_run_outcome or _latest_run_outcome(job) == last_run_outcome)
    ]

    if schedule_kind:
        filtered_jobs = [
            job for job in filtered_jobs if hooks.schedule_kind(job.schedule) == schedule_kind
        ]

    return JobListResponse(
        facets=JobListFacets(
            latest_run_outcome_counts={
                outcome: sum(_latest_run_outcome(job) == outcome for job in all_jobs)
                for outcome in ("success", "failed", "canceled")
            },
            owners=sorted({job.owner for job in all_jobs if job.owner}),
            status_counts={
                job_status: sum(job.status == job_status for job in all_jobs)
                for job_status in JOB_STATUSES
            },
            total=len(all_jobs),
        ),
        jobs=filtered_jobs,
    )


def get_job(
    db: Session,
    job_id: str,
    actor: ActorContext | None = None,
    *,
    hooks: EtlJobQueryHooks,
) -> JobRowData:
    actor_context = actor or ActorContext()
    job_model = etl_repository.get_job(db, job_id)
    if job_model is None:
        raise ApiError(ErrorCode.NOT_FOUND, f"Job not found: {job_id}", status.HTTP_404_NOT_FOUND)

    hooks.sync_airflow_runs(db, job_model)
    hooks.refresh_continuous_runtime(db, job_model)
    job = etl_repository.get_job_schema(db, job_id)
    if job is None:
        raise ApiError(ErrorCode.NOT_FOUND, f"Job not found: {job_id}", status.HTTP_404_NOT_FOUND)

    job_with_permissions = hooks.with_permissions(db, job, actor_context)
    if not job_with_permissions.permissions.can_view:
        hooks.record_audit_event(
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


def _latest_run_outcome(job: JobRowData) -> JobRunOutcome | None:
    latest_run = (job.run_history or [None])[0]
    if latest_run is None:
        return None
    status_value = latest_run.status if hasattr(latest_run, "status") else latest_run.get("status")
    return status_value if status_value in {"success", "failed", "canceled"} else None
