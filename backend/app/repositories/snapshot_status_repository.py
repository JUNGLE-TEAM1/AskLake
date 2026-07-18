"""Database reads and cycle ownership for Snapshot status reconciliation."""

from sqlalchemy import or_, select, text
from sqlalchemy.orm import Session

from app.models import ETLJobModel, ETLRunModel
from app.repositories import etl_job_list_repository, etl_repository
from app.schemas.etl import JobRowData


SNAPSHOT_AIRFLOW_SYNC_LOCK_ID = 0x41534B4C


def list_jobs_by_ids(db: Session, job_ids: list[str]) -> list[JobRowData]:
    etl_repository.ensure_schema(db)
    normalized_job_ids = list(dict.fromkeys(job_ids))
    if not normalized_job_ids:
        return []
    jobs = db.scalars(
        select(ETLJobModel).where(ETLJobModel.id.in_(normalized_job_ids))
    ).all()
    continuous_runtime_by_job_id = etl_job_list_repository.list_continuous_runtimes(
        db,
        [job.id for job in jobs if job.execution_mode == "continuous"],
    )
    run_models_by_job_id = etl_job_list_repository.list_latest_run_models(db, normalized_job_ids)
    return [
        etl_repository.job_to_schema(
            db,
            job,
            continuous_runtime=continuous_runtime_by_job_id.get(job.id),
            related_loaded=True,
            run_history=[
                etl_repository.run_to_schema(run)
                for run in run_models_by_job_id.get(job.id, [])
            ],
        )
        for job in jobs
    ]


def list_active_airflow_job_ids(db: Session) -> list[str]:
    """Return finite Jobs that still have a queued/running Airflow Run."""
    etl_repository.ensure_schema(db)
    statement = (
        select(ETLRunModel.job_id)
        .join(ETLJobModel, ETLJobModel.id == ETLRunModel.job_id)
        .where(
            or_(
                ETLJobModel.execution_mode.is_(None),
                ETLJobModel.execution_mode != "continuous",
            ),
            ETLRunModel.status.in_(["queued", "running"]),
            ETLRunModel.airflow_dag_run_id.is_not(None),
        )
        .distinct()
        .order_by(ETLRunModel.job_id)
    )
    return list(db.scalars(statement).all())


def try_acquire_snapshot_airflow_sync(db: Session) -> bool:
    """Let one PostgreSQL-backed API process own the current sync cycle."""
    if db.get_bind().dialect.name != "postgresql":
        return True
    return bool(db.scalar(
        text("SELECT pg_try_advisory_lock(:lock_id)"),
        {"lock_id": SNAPSHOT_AIRFLOW_SYNC_LOCK_ID},
    ))


def release_snapshot_airflow_sync(db: Session) -> None:
    if db.get_bind().dialect.name != "postgresql":
        return
    db.execute(
        text("SELECT pg_advisory_unlock(:lock_id)"),
        {"lock_id": SNAPSHOT_AIRFLOW_SYNC_LOCK_ID},
    )
