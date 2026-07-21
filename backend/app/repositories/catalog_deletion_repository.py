from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.errors import ApiError
from app.models.base import Base
from app.models.catalog_deletion import CatalogDatasetDeletionModel


ACTIVE_DELETION_STATUSES = {"queued", "validating", "purging", "metadata_cleanup"}
_schema_ready_bind_ids: set[int] = set()


def ensure_catalog_deletion_schema(db: Session) -> None:
    bind_key = id(db.get_bind())
    if bind_key in _schema_ready_bind_ids:
        return
    Base.metadata.create_all(bind=db.get_bind(), tables=[CatalogDatasetDeletionModel.__table__])
    _schema_ready_bind_ids.add(bind_key)


def ensure_catalog_publication_allowed(
    db: Session,
    dataset_id: str,
    *,
    publication_created_at: datetime | None = None,
) -> None:
    receipt = CatalogDeletionRepository(db).latest_for_dataset(dataset_id)
    if receipt is not None and publication_created_after_deletion(publication_created_at, receipt.created_at):
        return
    if receipt is not None:
        raise ApiError(
            "DATASET_DELETION_FENCED",
            "Dataset publication is blocked because deletion has already been requested.",
            409,
            {"datasetId": dataset_id},
        )


def publication_created_after_deletion(
    publication_created_at: datetime | None,
    deletion_created_at: datetime | None,
) -> bool:
    if publication_created_at is None or deletion_created_at is None:
        return False
    return normalize_timestamp(publication_created_at) > normalize_timestamp(deletion_created_at)


def normalize_timestamp(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


class CatalogDeletionRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def get(self, deletion_id: str) -> CatalogDatasetDeletionModel | None:
        ensure_catalog_deletion_schema(self.db)
        return self.db.get(CatalogDatasetDeletionModel, deletion_id)

    def latest_for_dataset(self, dataset_id: str) -> CatalogDatasetDeletionModel | None:
        ensure_catalog_deletion_schema(self.db)
        return self.db.scalar(
            select(CatalogDatasetDeletionModel)
            .where(CatalogDatasetDeletionModel.dataset_id == dataset_id)
            .order_by(CatalogDatasetDeletionModel.created_at.desc(), CatalogDatasetDeletionModel.id.desc())
            .limit(1)
        )

    def has_fence(self, dataset_id: str) -> bool:
        ensure_catalog_deletion_schema(self.db)
        return self.db.scalar(
            select(CatalogDatasetDeletionModel.id)
            .where(CatalogDatasetDeletionModel.dataset_id == dataset_id)
            .limit(1)
        ) is not None

    def create_or_retry(
        self,
        *,
        actor_snapshot: dict[str, object],
        dataset_id: str,
        dataset_name: str,
        dataset_snapshot: dict[str, object],
        impact_snapshot: dict[str, object],
    ) -> CatalogDatasetDeletionModel:
        existing = self.latest_for_dataset(dataset_id)
        if existing is not None and existing.status == "failed":
            existing.status = "queued"
            existing.actor_snapshot = actor_snapshot
            existing.dataset_snapshot = dataset_snapshot
            existing.impact_snapshot = impact_snapshot
            existing.error_code = None
            existing.error_message = None
            self.db.flush()
            self.db.commit()
            self.db.refresh(existing)
            return existing

        row = CatalogDatasetDeletionModel(
            id=f"catalog_delete_{uuid4().hex}",
            actor_snapshot=actor_snapshot,
            dataset_id=dataset_id,
            dataset_name=dataset_name,
            dataset_snapshot=dataset_snapshot,
            impact_snapshot=impact_snapshot,
            status="queued",
        )
        self.db.add(row)
        self.db.flush()
        self.db.commit()
        self.db.refresh(row)
        return row

    def claim_next(self) -> CatalogDatasetDeletionModel | None:
        ensure_catalog_deletion_schema(self.db)
        row = self.db.scalar(
            select(CatalogDatasetDeletionModel)
            .where(CatalogDatasetDeletionModel.status == "queued")
            .order_by(CatalogDatasetDeletionModel.created_at.asc(), CatalogDatasetDeletionModel.id.asc())
            .with_for_update(skip_locked=True)
            .limit(1)
        )
        if row is None:
            return None
        row.status = "validating"
        row.attempt_count += 1
        self.db.flush()
        return row

    def claim(self, deletion_id: str) -> CatalogDatasetDeletionModel | None:
        ensure_catalog_deletion_schema(self.db)
        row = self.db.scalar(
            select(CatalogDatasetDeletionModel)
            .where(
                CatalogDatasetDeletionModel.id == deletion_id,
                CatalogDatasetDeletionModel.status == "queued",
            )
            .with_for_update(skip_locked=True)
        )
        if row is None:
            return None
        row.status = "validating"
        row.attempt_count += 1
        self.db.flush()
        return row

    def update_status(
        self,
        row: CatalogDatasetDeletionModel,
        status: str,
        *,
        error_code: str | None = None,
        error_message: str | None = None,
        commit: bool = True,
    ) -> None:
        row.status = status
        row.error_code = error_code
        row.error_message = error_message
        self.db.flush()
        if commit:
            self.db.commit()
