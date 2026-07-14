from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, JSON, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class CatalogDatasetModel(TimestampMixin, Base):
    __tablename__ = "catalog_datasets"

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    payload: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    name: Mapped[str | None] = mapped_column(String(255), unique=True, index=True)
    description: Mapped[str | None] = mapped_column(Text, default="")
    owner: Mapped[str | None] = mapped_column(String(255))
    layer: Mapped[str | None] = mapped_column(String(32))
    status: Mapped[str | None] = mapped_column(String(64), default="available")
    freshness: Mapped[str | None] = mapped_column(String(64), default="latest")
    source: Mapped[str | None] = mapped_column(String(255))
    rows: Mapped[str | None] = mapped_column(String(120), default="0")
    size: Mapped[str | None] = mapped_column(String(120), default="Pending")
    quality: Mapped[str | None] = mapped_column(String(255), default="확인 대기")
    last_updated: Mapped[str | None] = mapped_column(String(64))
    next_refresh: Mapped[str | None] = mapped_column(String(255), default="-")
    rag: Mapped[bool | None] = mapped_column(Boolean, default=False)
    tags: Mapped[list[str] | None] = mapped_column(JSON, default=list)
    schema_json: Mapped[list[list[str]] | None] = mapped_column(JSON, default=list)
    sample_rows: Mapped[list[list[str]] | None] = mapped_column(JSON, default=list)
    upstream: Mapped[list[str] | None] = mapped_column(JSON, default=list)
    downstream: Mapped[list[str] | None] = mapped_column(JSON, default=list)
    lineage_graph: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)


class CatalogDatasetPreferenceModel(TimestampMixin, Base):
    __tablename__ = "catalog_dataset_preferences"
    __table_args__ = (
        Index(
            "ix_catalog_dataset_preferences_actor_pinned_at",
            "actor_key",
            "pinned_at",
        ),
    )

    actor_key: Mapped[str] = mapped_column(String(512), primary_key=True)
    dataset_id: Mapped[str] = mapped_column(
        ForeignKey("catalog_datasets.id", ondelete="CASCADE"),
        primary_key=True,
    )
    pinned: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    pinned_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
