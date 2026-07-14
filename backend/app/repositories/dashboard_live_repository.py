from datetime import UTC, datetime
from dataclasses import dataclass
import logging
from typing import Any

from sqlalchemy import delete, select, text
from sqlalchemy.orm import Session

from app.models.base import Base
from app.models.dashboard_live import (
    DashboardWidgetResultModel,
    DatasetFreshnessModel,
    DatasetRevisionCommitModel,
)
from app.models.etl import ETLJobModel
from app.models.catalog import CatalogDatasetModel


DEFAULT_DASHBOARD_POLL_MS = 5_000
MIN_DASHBOARD_POLL_MS = 5_000
MAX_DASHBOARD_POLL_MS = 60_000
logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ContinuousDatasetRefreshRecord:
    id: str
    continuous_config: dict[str, Any]


def recommended_dashboard_poll_ms(trigger_interval_seconds: Any) -> int:
    try:
        trigger_seconds = max(1, int(trigger_interval_seconds))
    except (TypeError, ValueError):
        trigger_seconds = 30
    return max(
        MIN_DASHBOARD_POLL_MS,
        min(MAX_DASHBOARD_POLL_MS, trigger_seconds * 500),
    )


def ensure_dashboard_live_schema(db: Session) -> None:
    """Create the additive live-dashboard tables for new and existing databases."""
    bind = db.get_bind()
    Base.metadata.create_all(
        bind=bind,
        tables=[
            DatasetFreshnessModel.__table__,
            DatasetRevisionCommitModel.__table__,
            DashboardWidgetResultModel.__table__,
        ],
    )
    if bind.dialect.name == "postgresql":
        # create_all handles fresh databases. These ALTERs keep existing local
        # volumes forward-compatible when a column is added later.
        for statement in (
            "ALTER TABLE dataset_freshness ADD COLUMN IF NOT EXISTS next_check_after_ms integer NOT NULL DEFAULT 5000",
            "ALTER TABLE dashboard_widget_results ADD COLUMN IF NOT EXISTS calculation_state jsonb NOT NULL DEFAULT '{}'::jsonb",
            "ALTER TABLE dashboard_widget_results ADD COLUMN IF NOT EXISTS calculation_mode varchar(32) NOT NULL DEFAULT 'full'",
            "ALTER TABLE dataset_revision_commits ADD COLUMN IF NOT EXISTS source_ranges jsonb NOT NULL DEFAULT '[]'::jsonb",
            "ALTER TABLE dashboard_widget_results ALTER COLUMN result_payload TYPE jsonb USING result_payload::jsonb",
            "ALTER TABLE dashboard_widget_results ALTER COLUMN calculation_state TYPE jsonb USING calculation_state::jsonb",
            "ALTER TABLE dashboard_widget_results ALTER COLUMN result_payload SET DEFAULT '{}'::jsonb",
            "ALTER TABLE dashboard_widget_results ALTER COLUMN calculation_state SET DEFAULT '{}'::jsonb",
            "CREATE INDEX IF NOT EXISTS dataset_revision_commits_dataset_revision_idx ON dataset_revision_commits (dataset_id, revision)",
            "CREATE INDEX IF NOT EXISTS dashboard_widget_results_dataset_revision_idx ON dashboard_widget_results (dataset_id, applied_revision)",
        ):
            db.execute(text(statement))
    db.commit()


class DashboardLiveRepository:
    def __init__(self, db: Session, *, ensure_schema: bool = True) -> None:
        self.db = db
        if ensure_schema:
            ensure_dashboard_live_schema(db)

    def get_freshness(self, dataset_id: str, *, for_update: bool = False) -> DatasetFreshnessModel | None:
        statement = select(DatasetFreshnessModel).where(DatasetFreshnessModel.dataset_id == dataset_id)
        if for_update:
            statement = statement.with_for_update()
        return self.db.scalars(statement).first()

    def list_freshness(self, dataset_ids: list[str]) -> dict[str, DatasetFreshnessModel]:
        if not dataset_ids:
            return {}
        statement = select(DatasetFreshnessModel).where(DatasetFreshnessModel.dataset_id.in_(dataset_ids))
        return {item.dataset_id: item for item in self.db.scalars(statement).all()}

    def continuous_job_by_dataset(self, dataset_id: str) -> ContinuousDatasetRefreshRecord | None:
        statement = (
            select(ETLJobModel.id, ETLJobModel.continuous_config)
            .where(
                ETLJobModel.dataset_id == dataset_id,
                ETLJobModel.execution_mode == "continuous",
                ETLJobModel.source_type.ilike("%kafka%"),
            )
            .order_by(ETLJobModel.updated_at.desc(), ETLJobModel.created_at.desc())
            .limit(1)
        )
        row = self.db.execute(statement).first()
        if row is None:
            return None
        return ContinuousDatasetRefreshRecord(
            id=str(row.id),
            continuous_config=dict(row.continuous_config or {}),
        )

    def commit_by_run_id(self, run_id: str) -> DatasetRevisionCommitModel | None:
        return self.db.scalars(
            select(DatasetRevisionCommitModel).where(DatasetRevisionCommitModel.run_id == run_id)
        ).first()

    def record_dataset_commit(
        self,
        *,
        dataset_id: str,
        run_id: str,
        storage_location: str,
        storage_format: str,
        materialization_mode: str,
        row_count: int,
        next_check_after_ms: int,
        committed_at: datetime | None = None,
        source_ranges: list[dict[str, Any]] | None = None,
    ) -> tuple[DatasetRevisionCommitModel, bool]:
        existing_commit = self.commit_by_run_id(run_id)
        if existing_commit is not None:
            return existing_commit, False

        freshness = self.get_freshness(dataset_id, for_update=True)
        now = committed_at or datetime.now(UTC)
        resolved_check_after_ms = max(
            MIN_DASHBOARD_POLL_MS,
            min(MAX_DASHBOARD_POLL_MS, int(next_check_after_ms or DEFAULT_DASHBOARD_POLL_MS)),
        )
        if freshness is None:
            freshness = DatasetFreshnessModel(
                dataset_id=dataset_id,
                latest_revision=0,
                next_check_after_ms=resolved_check_after_ms,
                updated_at=now,
            )
            self.db.add(freshness)
            self.db.flush()

        revision = int(freshness.latest_revision or 0) + 1
        commit = DatasetRevisionCommitModel(
            dataset_id=dataset_id,
            revision=revision,
            run_id=run_id,
            storage_location=storage_location,
            storage_format=storage_format or "parquet",
            materialization_mode=materialization_mode or "delta",
            row_count=max(0, int(row_count or 0)),
            source_ranges=source_ranges or [],
            committed_at=now,
        )
        freshness.latest_revision = revision
        freshness.latest_run_id = run_id
        freshness.next_check_after_ms = resolved_check_after_ms
        freshness.updated_at = now
        self.db.add(commit)
        self.db.add(freshness)
        self.db.flush()
        return commit, True

    def list_commits(
        self,
        dataset_id: str,
        *,
        after_revision: int = -1,
        through_revision: int | None = None,
    ) -> list[DatasetRevisionCommitModel]:
        statement = select(DatasetRevisionCommitModel).where(
            DatasetRevisionCommitModel.dataset_id == dataset_id,
            DatasetRevisionCommitModel.revision > after_revision,
        )
        if through_revision is not None:
            statement = statement.where(DatasetRevisionCommitModel.revision <= through_revision)
        return list(self.db.scalars(statement.order_by(DatasetRevisionCommitModel.revision.asc())).all())

    def get_widget_result(
        self,
        widget_id: str,
        calculation_version: str,
        *,
        for_update: bool = False,
    ) -> DashboardWidgetResultModel | None:
        statement = select(DashboardWidgetResultModel).where(
            DashboardWidgetResultModel.widget_id == widget_id,
            DashboardWidgetResultModel.calculation_version == calculation_version,
        )
        if for_update:
            statement = statement.with_for_update()
        return self.db.scalars(statement).first()

    def latest_widget_result(
        self,
        widget_id: str,
        dataset_id: str,
    ) -> DashboardWidgetResultModel | None:
        return self.db.scalars(
            select(DashboardWidgetResultModel)
            .where(
                DashboardWidgetResultModel.widget_id == widget_id,
                DashboardWidgetResultModel.dataset_id == dataset_id,
            )
            .order_by(
                DashboardWidgetResultModel.calculated_at.desc(),
                DashboardWidgetResultModel.calculation_version.desc(),
            )
            .limit(1)
        ).first()

    def save_widget_result(
        self,
        *,
        widget_id: str,
        calculation_version: str,
        dataset_id: str,
        applied_revision: int,
        result_payload: dict[str, Any],
        calculation_state: dict[str, Any],
        calculation_mode: str,
    ) -> DashboardWidgetResultModel:
        result = self.get_widget_result(widget_id, calculation_version, for_update=True)
        if result is None:
            result = DashboardWidgetResultModel(
                widget_id=widget_id,
                calculation_version=calculation_version,
                dataset_id=dataset_id,
            )
        result.dataset_id = dataset_id
        result.applied_revision = max(0, int(applied_revision or 0))
        result.result_payload = result_payload
        result.calculation_state = calculation_state
        result.calculation_mode = calculation_mode
        result.calculated_at = datetime.now(UTC)
        self.db.execute(
            delete(DashboardWidgetResultModel).where(
                DashboardWidgetResultModel.widget_id == widget_id,
                DashboardWidgetResultModel.calculation_version != calculation_version,
            )
        )
        self.db.add(result)
        self.db.flush()
        return result


def save_catalog_dataset_and_revision(
    db: Session,
    dataset: CatalogDatasetModel,
    *,
    run_id: str,
    storage_location: str,
    storage_format: str,
    materialization_mode: str,
    row_count: int,
    next_check_after_ms: int,
    source_ranges: list[dict[str, Any]] | None = None,
) -> DatasetRevisionCommitModel:
    """Commit Catalog metadata and its visible dashboard revision atomically."""
    repository = DashboardLiveRepository(db, ensure_schema=False)
    merged_dataset = db.merge(dataset)
    commit, _created = repository.record_dataset_commit(
        dataset_id=dataset.id,
        run_id=run_id,
        storage_location=storage_location,
        storage_format=storage_format,
        materialization_mode=materialization_mode,
        row_count=row_count,
        next_check_after_ms=next_check_after_ms,
        source_ranges=source_ranges,
    )
    try:
        db.commit()
    except Exception:
        db.rollback()
        raise
    db.refresh(merged_dataset)
    logger.info(
        "dashboard_dataset_revision_committed dataset_id=%s revision=%s run_id=%s row_count=%s",
        dataset.id,
        commit.revision,
        run_id,
        row_count,
    )
    return commit


def backfill_catalog_revision(
    db: Session,
    *,
    dataset_id: str,
    run_id: str,
    storage_location: str,
    storage_format: str,
    materialization_mode: str,
    row_count: int,
    next_check_after_ms: int,
    source_ranges: list[dict[str, Any]] | None = None,
) -> DatasetRevisionCommitModel:
    """Add revision metadata for a durable legacy Catalog run exactly once."""
    repository = DashboardLiveRepository(db, ensure_schema=False)
    commit, _created = repository.record_dataset_commit(
        dataset_id=dataset_id,
        run_id=run_id,
        storage_location=storage_location,
        storage_format=storage_format,
        materialization_mode=materialization_mode,
        row_count=row_count,
        next_check_after_ms=next_check_after_ms,
        source_ranges=source_ranges,
    )
    try:
        db.commit()
    except Exception:
        db.rollback()
        raise
    logger.info(
        "dashboard_dataset_revision_backfilled dataset_id=%s revision=%s run_id=%s",
        dataset_id,
        commit.revision,
        run_id,
    )
    return commit
