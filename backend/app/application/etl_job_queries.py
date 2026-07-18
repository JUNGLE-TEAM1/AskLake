"""Job list/detail hydration use cases.

The public ``etl_service`` functions remain compatibility façades. This module
owns the read sequence: hydrate repository schemas, apply actor permissions,
and build stable list facets, lightweight status snapshots, or detail failures.
Every public GET in this module is side-effect free.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from fastapi import status
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext
from app.core.errors import ApiError
from app.repositories import etl_repository
from app.repositories import snapshot_status_repository
from app.schemas.common import ErrorCode
from app.schemas.etl import (
    JobListFacets,
    JobListResponse,
    JobRowData,
    JobRunOutcome,
    JobScheduleKind,
)
from app.schemas.job_status import JobStatusListResponse, JobStatusSnapshot


JOB_STATUSES = ("scheduled", "failed", "running", "paused", "canceled", "stopped")


@dataclass(frozen=True, slots=True)
class EtlJobQueryHooks:
    record_audit_event: Callable[..., object | None]
    schedule_kind: Callable[[str | None], JobScheduleKind]
    with_permissions: Callable[[Session, JobRowData, ActorContext], JobRowData]
    with_list_permissions: Callable[
        [Session, list[JobRowData], ActorContext],
        list[JobRowData],
    ]
    visible: Callable[[JobRowData], bool] = lambda _job: True


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
    actor_context = actor or ActorContext()
    visible_jobs = hooks.with_list_permissions(
        db,
        etl_repository.list_jobs(db),
        actor_context,
    )
    all_jobs = [
        job
        for job in visible_jobs
        if job.permissions.can_view and hooks.visible(job)
    ]
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


def list_job_statuses(
    db: Session,
    job_ids: list[str],
    actor: ActorContext | None = None,
    *,
    hooks: EtlJobQueryHooks,
) -> JobStatusListResponse:
    normalized_job_ids = list(dict.fromkeys(job_id.strip() for job_id in job_ids if job_id.strip()))
    if len(normalized_job_ids) > 100:
        raise ApiError(
            ErrorCode.VALIDATION_ERROR,
            "At most 100 Job statuses can be requested at once.",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    if not normalized_job_ids:
        return JobStatusListResponse(jobs=[])

    actor_context = actor or ActorContext()
    visible_jobs = hooks.with_list_permissions(
        db,
        snapshot_status_repository.list_jobs_by_ids(db, normalized_job_ids),
        actor_context,
    )
    jobs_by_id = {
        job.id: job
        for job in visible_jobs
        if job.permissions.can_view and hooks.visible(job)
    }
    return JobStatusListResponse(jobs=[
        JobStatusSnapshot(
            id=job.id,
            status=job.status,
            progress=job.progress,
            last_run=job.last_run,
            last_state=job.last_state,
            next_run=job.next_run,
            updated_at=job.updated_at,
            latest_run=(job.run_history or [None])[0],
            dag_steps=job.dag_steps or [],
        )
        for job_id in normalized_job_ids
        if (job := jobs_by_id.get(job_id)) is not None
    ])


def get_job(
    db: Session,
    job_id: str,
    actor: ActorContext | None = None,
    *,
    hooks: EtlJobQueryHooks,
) -> JobRowData:
    actor_context = actor or ActorContext()
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
