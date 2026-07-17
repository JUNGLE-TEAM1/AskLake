"""Bounded database reads used by the ETL Job list projection."""

from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.orm import Session, aliased

from app.models import ETLRunModel, KafkaContinuousRuntimeModel


def list_continuous_runtimes(
    db: Session,
    job_ids: list[str],
) -> dict[str, KafkaContinuousRuntimeModel]:
    normalized_job_ids = list(dict.fromkeys(job_ids))
    if not normalized_job_ids:
        return {}
    runtimes = db.scalars(
        select(KafkaContinuousRuntimeModel)
        .where(KafkaContinuousRuntimeModel.job_id.in_(normalized_job_ids))
    ).all()
    return {runtime.job_id: runtime for runtime in runtimes}


def list_latest_run_models(
    db: Session,
    job_ids: list[str],
) -> dict[str, list[ETLRunModel]]:
    normalized_job_ids = list(dict.fromkeys(job_ids))
    if not normalized_job_ids:
        return {}
    ranked_runs = (
        select(
            ETLRunModel,
            func.row_number().over(
                partition_by=ETLRunModel.job_id,
                order_by=(ETLRunModel.created_at.desc(), ETLRunModel.run_id.desc()),
            ).label("job_run_rank"),
        )
        .where(ETLRunModel.job_id.in_(normalized_job_ids))
        .subquery()
    )
    latest_run = aliased(ETLRunModel, ranked_runs)
    runs = db.scalars(
        select(latest_run)
        .where(ranked_runs.c.job_run_rank == 1)
        .order_by(ranked_runs.c.created_at.desc(), ranked_runs.c.run_id.desc())
    ).all()
    grouped = {job_id: [] for job_id in normalized_job_ids}
    for run in runs:
        grouped[run.job_id].append(run)
    return grouped
