from typing import Any

from sqlalchemy import Index, Integer, JSON, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class CatalogDatasetDeletionModel(TimestampMixin, Base):
    __tablename__ = "catalog_dataset_deletions"
    __table_args__ = (
        Index("ix_catalog_dataset_deletions_dataset", "dataset_id", "created_at"),
        Index("ix_catalog_dataset_deletions_status", "status", "created_at"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    dataset_id: Mapped[str] = mapped_column(String(255), nullable=False)
    dataset_name: Mapped[str] = mapped_column(String(255), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="queued")
    actor_snapshot: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
    impact_snapshot: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
    dataset_snapshot: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
    attempt_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    error_code: Mapped[str | None] = mapped_column(String(120), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
