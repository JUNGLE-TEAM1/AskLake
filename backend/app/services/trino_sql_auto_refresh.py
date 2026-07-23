"""Revision-driven refresh for ordinary persisted Trino SQL Jobs.

The Kafka ingestion path publishes Dataset revisions.  This reconciler turns a
new revision into one normal Trino SQL Job run; dashboards remain readers of
the last successfully published Gold Dataset.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
import logging
from typing import Any
from uuid import uuid4

from sqlalchemy import select

from app.core.config import settings
from app.core.database import SessionLocal
from app.models import DatasetFreshnessModel, ETLJobModel
from app.repositories import etl_repository
from app.repositories.catalog_repository import CatalogRepository
from app.repositories.sql_repository import SqlRepository
from app.services.trino_sql_job_service import TrinoSqlJobService


logger = logging.getLogger(__name__)
STATE_KEY = "revisionRefresh"
TERMINAL_RUN_STATUSES = {"succeeded", "failed", "cancelled"}


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
        state = _state(job)
        published_revision = int(state.get("publishedSourceRevision") or 0)
        if _processing_claim_blocks_submission(db, job, sql_repository, state):
            return
        if sql_repository.get_unfinalized_trino_job_run_payload(job.id) is not None:
            return
        if latest_revision <= published_revision:
            return

        claim_id = uuid4().hex
        run_id = f"run_sql_{uuid4().hex[:16]}"
        job.continuous_config = {
            **(job.continuous_config or {}),
            STATE_KEY: {
                **state,
                "claimId": claim_id,
                "claimedAt": datetime.now(UTC).isoformat(),
                "enabled": True,
                "lastError": None,
                "latestSourceRevision": latest_revision,
                "processingRunId": run_id,
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
                run_id=run_id,
                auto_refresh_context={
                    "claimId": claim_id,
                    "sourceDatasetId": source_dataset_id,
                    "sourceRevision": latest_revision,
                },
            )
        except Exception as exc:
            db.rollback()
            failed_job = etl_repository.get_job_for_update(db, job_id)
            if failed_job is not None:
                failed_state = _state(failed_job)
                if failed_state.get("claimId") == claim_id:
                    failed_job.continuous_config = {
                        **(failed_job.continuous_config or {}),
                        STATE_KEY: {
                            **failed_state,
                            "lastError": (
                                failed_state.get("lastError")
                                or str(getattr(exc, "message", "") or exc)
                            ),
                            "status": "failed",
                        },
                    }
                    db.add(failed_job)
                    db.commit()
            raise


def _processing_claim_blocks_submission(
    db: Any,
    job: ETLJobModel,
    sql_repository: SqlRepository,
    state: dict[str, Any],
) -> bool:
    processing_revision = int(state.get("processingSourceRevision") or 0)
    if processing_revision <= 0:
        return False

    payload = _processing_run_payload(sql_repository, job.id, processing_revision, state)
    if payload is not None:
        run_id = str(payload.get("runId") or "").strip()
        if run_id and run_id != str(state.get("processingRunId") or "").strip():
            job.continuous_config = {
                **(job.continuous_config or {}),
                STATE_KEY: {
                    **state,
                    "processingRunId": run_id,
                },
            }
            db.add(job)
            db.commit()

        run_status = str(payload.get("status") or "")
        if run_status in TERMINAL_RUN_STATUSES and payload.get("finalized") is True:
            error = payload.get("error")
            error_message = (
                str(error.get("message") or "") or None
                if isinstance(error, dict)
                else None
            )
            TrinoSqlJobService._apply_auto_refresh_result(
                job,
                payload,
                succeeded=run_status == "succeeded",
                error_message=error_message,
            )
            db.add(job)
            db.commit()
        return True

    processing_run_id = str(state.get("processingRunId") or "").strip()
    if processing_run_id:
        run = etl_repository.get_run_model(db, processing_run_id)
        if run is not None:
            if str(run.status or "") in {"failed", "cancelled"}:
                TrinoSqlJobService._apply_auto_refresh_result(
                    job,
                    {
                        "autoRefresh": {
                            "claimId": state.get("claimId"),
                            "sourceDatasetId": state.get("sourceDatasetId"),
                            "sourceRevision": processing_revision,
                        },
                        "runId": processing_run_id,
                    },
                    succeeded=False,
                    error_message=run.error_summary or "Trino SQL Job 실행 실패",
                )
                db.add(job)
                db.commit()
            return True

    if not _claim_expired(state):
        return True

    logger.warning(
        "Recovering expired revision refresh claim without durable run evidence",
        extra={
            "jobId": job.id,
            "processingRunId": processing_run_id or None,
            "sourceRevision": processing_revision,
        },
    )
    return False


def _processing_run_payload(
    sql_repository: SqlRepository,
    job_id: str,
    processing_revision: int,
    state: dict[str, Any],
) -> dict[str, Any] | None:
    processing_run_id = str(state.get("processingRunId") or "").strip()
    if processing_run_id:
        return sql_repository.get_run_payload(processing_run_id)
    return sql_repository.get_latest_trino_job_auto_refresh_run_payload(
        job_id,
        processing_revision,
    )


def _claim_expired(state: dict[str, Any], *, now: datetime | None = None) -> bool:
    claimed_at = _parse_datetime(state.get("claimedAt"))
    if claimed_at is None:
        return True
    current = now or datetime.now(UTC)
    return claimed_at <= current - timedelta(seconds=settings.continuous_sql_refresh_claim_seconds)


def _parse_datetime(value: object) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _state(job: ETLJobModel) -> dict[str, Any]:
    config = job.continuous_config if isinstance(job.continuous_config, dict) else {}
    value = config.get(STATE_KEY)
    return dict(value) if isinstance(value, dict) else {}


def _string_list(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item).strip()]
