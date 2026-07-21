"""Revision-driven refresh for ordinary persisted Trino SQL Jobs.

The Kafka ingestion path publishes Dataset revisions.  This reconciler turns a
new revision into one normal Trino SQL Job run; dashboards remain readers of
the last successfully published Gold Dataset.
"""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import select

from app.core.database import SessionLocal
from app.models import DatasetFreshnessModel, ETLJobModel
from app.repositories import etl_repository
from app.repositories.catalog_repository import CatalogRepository
from app.repositories.sql_repository import SqlRepository
from app.services.trino_sql_job_service import TrinoSqlJobService


logger = logging.getLogger(__name__)
STATE_KEY = "revisionRefresh"


def sync_revision_driven_trino_sql_jobs() -> None:
    """Submit at most one refresh per eligible SQL Job and worker cycle."""

    with SessionLocal() as db:
        job_ids = list(
            db.scalars(
                select(ETLJobModel.id)
                .where(ETLJobModel.job_kind == "trino_sql_materialization")
                .order_by(ETLJobModel.created_at.asc())
            ).all()
        )

    for job_id in job_ids:
        try:
            _sync_job(job_id)
        except Exception:
            logger.exception("Revision-driven Trino SQL refresh failed", extra={"jobId": job_id})


def _sync_job(job_id: str) -> None:
    with SessionLocal() as db:
        job = etl_repository.get_job_for_update(db, job_id)
        if job is None:
            return
        recipe = job.sql_recipe if isinstance(job.sql_recipe, dict) else {}
        base_dataset_id = str(recipe.get("baseDatasetId") or "").strip()
        reference_ids = _string_list(recipe.get("referenceDatasetIds"))
        if not base_dataset_id or not str(recipe.get("query") or "").strip() or not reference_ids:
            return

        catalog = CatalogRepository(db)
        datasets = [catalog.get_dataset_model(dataset_id) for dataset_id in [base_dataset_id, *reference_ids]]
        if any(item is None for item in datasets):
            return
        streaming = [item for item in datasets if item is not None and item.relation_mode == "streaming"]
        static = [item for item in datasets if item is not None and item.relation_mode == "static"]
        if len(streaming) != 1 or len(static) != len(datasets) - 1:
            return
        source_dataset_id = streaming[0].id

        freshness = db.get(DatasetFreshnessModel, source_dataset_id)
        latest_revision = int(freshness.latest_revision if freshness is not None else 0)
        if latest_revision <= 0:
            return

        sql_repository = SqlRepository(db)
        if sql_repository.get_active_trino_job_run_payload(job.id) is not None:
            return

        state = _state(job)
        published_revision = int(state.get("publishedSourceRevision") or 0)
        if latest_revision <= published_revision:
            return

        job.continuous_config = {
            **(job.continuous_config or {}),
            STATE_KEY: {
                **state,
                "enabled": True,
                "lastError": None,
                "latestSourceRevision": latest_revision,
                "processingSourceRevision": latest_revision,
                "publishedSourceRevision": published_revision,
                "sourceDatasetId": source_dataset_id,
                "status": "running",
            },
        }
        db.add(job)
        db.commit()

        try:
            from app.services.etl_service import trino_sql_job_run_as_actor

            actor = trino_sql_job_run_as_actor(db, job)
            TrinoSqlJobService(sql_repository, catalog).submit(
                job,
                "revisionRefresh",
                actor,
                auto_refresh_context={
                    "sourceDatasetId": source_dataset_id,
                    "sourceRevision": latest_revision,
                },
            )
        except Exception as exc:
            db.rollback()
            failed_job = etl_repository.get_job_for_update(db, job_id)
            if failed_job is not None:
                failed_state = _state(failed_job)
                failed_job.continuous_config = {
                    **(failed_job.continuous_config or {}),
                    STATE_KEY: {
                        **failed_state,
                        "lastError": str(exc),
                        "processingSourceRevision": None,
                        "status": "failed",
                    },
                }
                db.add(failed_job)
                db.commit()
            raise


def _state(job: ETLJobModel) -> dict[str, Any]:
    config = job.continuous_config if isinstance(job.continuous_config, dict) else {}
    value = config.get(STATE_KEY)
    return dict(value) if isinstance(value, dict) else {}


def _string_list(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item).strip()]
