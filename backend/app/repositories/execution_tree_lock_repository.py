"""Cross-Job tree lock checks used by standalone ETL write paths."""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi import status
from sqlalchemy import inspect, select
from sqlalchemy.orm import Session

from app.core.errors import ApiError
from app.models.continuous_sql import ContinuousSqlTreeJobLockModel
from app.models.etl import ETLJobModel


def lock_etl_job_row(db: Session, job_id: str) -> None:
    if not isinstance(db, Session):
        return
    db.scalars(
        select(ETLJobModel.id)
        .where(ETLJobModel.id == job_id)
        .with_for_update()
    ).first()


def require_standalone_job_unlocked(
    db: Session,
    job_id: str,
    *,
    action: str,
) -> None:
    if not isinstance(db, Session):
        return
    bind = db.get_bind()
    if bind.dialect.name == "sqlite" and not inspect(bind).has_table(
        ContinuousSqlTreeJobLockModel.__tablename__
    ):
        # Narrow compatibility for unit/legacy SQLite fixtures that create a
        # selected table subset. Deployed PostgreSQL must run Alembic first.
        return
    lock = db.scalars(
        select(ContinuousSqlTreeJobLockModel)
        .where(ContinuousSqlTreeJobLockModel.job_id == job_id)
        .with_for_update()
    ).first()
    if lock is None or not lock.active:
        return
    expires_at = lock.lease_expires_at
    now = datetime.now(UTC) if expires_at.tzinfo is not None else datetime.now(UTC).replace(tzinfo=None)
    if expires_at <= now:
        return
    raise ApiError(
        "CONTINUOUS_SQL_DEPENDENCY_CONFLICT",
        "Job is owned by an active SQL execution tree.",
        status.HTTP_409_CONFLICT,
        {
            "jobId": job_id,
            "action": action,
            "ownerSqlJobId": lock.owner_sql_job_id,
            "treeRunId": lock.tree_run_id,
            "lockGeneration": int(lock.generation),
        },
    )


def require_tree_owned_job(
    db: Session,
    job_id: str,
    *,
    tree_run_id: str,
    fencing_token: str,
    action: str,
) -> None:
    """Allow an internal child command only for the current tree owner.

    The public ETL command path remains a standalone path by default.  A SQL
    parent can opt into this narrow bypass only after it presents the durable
    tree identity and the current fencing token; an expired, replaced, or
    released lock must fail closed just like a standalone command.
    """
    if not isinstance(db, Session):
        return
    bind = db.get_bind()
    if bind.dialect.name == "sqlite" and not inspect(bind).has_table(
        ContinuousSqlTreeJobLockModel.__tablename__
    ):
        raise ApiError(
            "CONTINUOUS_SQL_DEPENDENCY_UNAVAILABLE",
            "SQL execution tree locking is not available for this database.",
            status.HTTP_409_CONFLICT,
            {"jobId": job_id, "action": action},
        )
    lock = db.scalars(
        select(ContinuousSqlTreeJobLockModel)
        .where(ContinuousSqlTreeJobLockModel.job_id == job_id)
        .with_for_update()
    ).first()
    expires_at = lock.lease_expires_at if lock is not None else None
    now = (
        datetime.now(UTC)
        if expires_at is not None and expires_at.tzinfo is not None
        else datetime.now(UTC).replace(tzinfo=None)
    )
    if (
        lock is None
        or not lock.active
        or lock.tree_run_id != tree_run_id
        or lock.fencing_token != fencing_token
        or expires_at is None
        or expires_at <= now
    ):
        raise ApiError(
            "CONTINUOUS_SQL_DEPENDENCY_CONFLICT",
            "Job is not owned by the current SQL execution tree.",
            status.HTTP_409_CONFLICT,
            {
                "jobId": job_id,
                "action": action,
                "treeRunId": tree_run_id,
            },
        )
