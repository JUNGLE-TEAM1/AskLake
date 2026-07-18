"""Server-owned reconciliation for finite Airflow-backed Job runs."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.models import ETLJobModel


SessionFactory = Callable[[], Session]


@dataclass(frozen=True, slots=True)
class SnapshotReconciliationHooks:
    acquire_sync_owner: Callable[[Session], bool]
    get_job: Callable[[Session, str], ETLJobModel | None]
    list_active_job_ids: Callable[[Session], list[str]]
    on_job_error: Callable[[str, Exception], None]
    release_sync_owner: Callable[[Session], None]
    sync_job: Callable[[Session, ETLJobModel], None]


def reconcile_active_airflow_runs(
    session_factory: SessionFactory,
    *,
    hooks: SnapshotReconciliationHooks,
) -> int:
    """Synchronize each active Job once while this process owns the cycle.

    A separate database session holds the deployment-wide ownership lock. Each
    Job uses its own transaction so one broken Run cannot block the others.
    """
    with session_factory() as ownership_db:
        if not hooks.acquire_sync_owner(ownership_db):
            return 0

        try:
            with session_factory() as list_db:
                job_ids = hooks.list_active_job_ids(list_db)

            synchronized_count = 0
            for job_id in job_ids:
                with session_factory() as job_db:
                    try:
                        job = hooks.get_job(job_db, job_id)
                        if job is None or job.execution_mode == "continuous":
                            continue
                        hooks.sync_job(job_db, job)
                        synchronized_count += 1
                    except Exception as exc:  # Keep the remaining Jobs recoverable.
                        job_db.rollback()
                        hooks.on_job_error(job_id, exc)
            return synchronized_count
        finally:
            hooks.release_sync_owner(ownership_db)
