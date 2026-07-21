from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import ETLRunModel


MAX_HISTORY_SCAN_LIMIT = 100


def list_recent_run_models_for_job(
    db: Session,
    job_id: str,
    *,
    limit: int = MAX_HISTORY_SCAN_LIMIT,
) -> list[ETLRunModel]:
    bounded_limit = max(1, min(int(limit), MAX_HISTORY_SCAN_LIMIT))
    return db.scalars(
        select(ETLRunModel)
        .where(ETLRunModel.job_id == job_id)
        .order_by(ETLRunModel.created_at.desc())
        .limit(bounded_limit)
    ).all()
