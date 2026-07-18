"""Background selection loop for durable Kafka Continuous runtime reconciliation."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
import logging
from typing import Any

from app.domain.continuous_runtime import runtime_contract_projection
from app.repositories import etl_repository


@dataclass(frozen=True, slots=True)
class ContinuousRuntimeSyncHooks:
    reconcile_stale_maintenance: Callable[..., None]
    refresh_runtime: Callable[..., None]
    report_has_unacknowledged_publication: Callable[..., bool]
    has_pending_replay_catalog: Callable[..., bool]


def sync_active_kafka_continuous_jobs(hooks: ContinuousRuntimeSyncHooks) -> None:
    """Persist worker progress without depending on UI polling."""
    from app.core.database import SessionLocal

    active_statuses = {"starting", "running", "pausing", "stopping"}
    terminal_statuses = {"paused", "stopped", "failed"}
    with SessionLocal() as db:
        try:
            hooks.reconcile_stale_maintenance(db)
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
        _sync_job(job_id, active_statuses, terminal_statuses, hooks)


def _sync_job(
    job_id: str,
    active_statuses: set[str],
    terminal_statuses: set[str],
    hooks: ContinuousRuntimeSyncHooks,
) -> None:
    from app.core.database import SessionLocal

    with SessionLocal() as db:
        try:
            job = etl_repository.get_job(db, job_id)
            if job is None or job.execution_mode != "continuous":
                return
            runtime = etl_repository.get_kafka_continuous_runtime(db, job.id)
            if runtime is not None and _requires_refresh(
                db, job, runtime, active_statuses, terminal_statuses, hooks
            ):
                hooks.refresh_runtime(db, job)
        except Exception:
            db.rollback()
            logging.getLogger(__name__).exception(
                "Kafka continuous runtime synchronization failed for job_id=%s",
                job_id,
            )


def _requires_refresh(
    db: Any,
    job: Any,
    runtime: Any,
    active_statuses: set[str],
    terminal_statuses: set[str],
    hooks: ContinuousRuntimeSyncHooks,
) -> bool:
    metrics = runtime.metrics or {}
    recovery_state = metrics.get("publicationRecoveryPending")
    contract = runtime_contract_projection(
        metrics,
        public_status=runtime.status,
        legacy_error=getattr(runtime, "last_error", None),
    )
    return (
        runtime.status in active_statuses
        or contract.get("desiredState") == "running"
        or (runtime.status in terminal_statuses and recovery_state is not False)
        or recovery_state is True
        or hooks.report_has_unacknowledged_publication(job.id, runtime)
        or hooks.has_pending_replay_catalog(db, job.id)
    )
