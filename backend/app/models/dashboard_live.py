from datetime import datetime
from typing import Any

from sqlalchemy import BigInteger, DateTime, Index, Integer, JSON, String, UniqueConstraint, func, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


JSON_DOCUMENT = JSON().with_variant(JSONB, "postgresql")


class DatasetFreshnessModel(Base):
    __tablename__ = "dataset_freshness"

    dataset_id: Mapped[str] = mapped_column(String(120), primary_key=True)
    latest_revision: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    latest_run_id: Mapped[str | None] = mapped_column(String(160), nullable=True)
    next_check_after_ms: Mapped[int] = mapped_column(Integer, nullable=False, default=1_000)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )


class DatasetRevisionCommitModel(Base):
    __tablename__ = "dataset_revision_commits"
    __table_args__ = (
        UniqueConstraint("run_id", name="dataset_revision_commits_run_id_uq"),
        Index("dataset_revision_commits_dataset_revision_idx", "dataset_id", "revision"),
        Index(
            "dataset_revision_commits_source_fingerprint_uq",
            "dataset_id",
            "commit_kind",
            "source_fingerprint",
            unique=True,
            postgresql_where=text("source_fingerprint IS NOT NULL"),
            sqlite_where=text("source_fingerprint IS NOT NULL"),
        ),
    )

    dataset_id: Mapped[str] = mapped_column(String(120), primary_key=True)
    revision: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    run_id: Mapped[str] = mapped_column(String(160), nullable=False)
    storage_location: Mapped[str] = mapped_column(String(2048), nullable=False)
    storage_format: Mapped[str] = mapped_column(String(32), nullable=False, default="parquet")
    materialization_mode: Mapped[str] = mapped_column(String(32), nullable=False, default="delta")
    commit_kind: Mapped[str] = mapped_column(String(32), nullable=False, default="legacy")
    row_count: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    source_ranges: Mapped[list[dict[str, Any]]] = mapped_column(JSON_DOCUMENT, nullable=False, default=list)
    source_fingerprint: Mapped[str | None] = mapped_column(String(64), nullable=True)
    manifest_location: Mapped[str | None] = mapped_column(String(2048), nullable=True)
    committed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )


class DatasetKafkaPartitionCursorModel(Base):
    __tablename__ = "dataset_kafka_partition_cursors"

    dataset_id: Mapped[str] = mapped_column(String(120), primary_key=True)
    commit_kind: Mapped[str] = mapped_column(String(32), primary_key=True)
    topic: Mapped[str] = mapped_column(String(512), primary_key=True)
    partition: Mapped[int] = mapped_column(Integer, primary_key=True)
    next_offset: Mapped[int] = mapped_column(BigInteger, nullable=False)
    updated_revision: Mapped[int] = mapped_column(BigInteger, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )


class DashboardWidgetResultModel(Base):
    __tablename__ = "dashboard_widget_results"
    __table_args__ = (
        Index("dashboard_widget_results_dataset_revision_idx", "dataset_id", "applied_revision"),
    )

    widget_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    calculation_version: Mapped[str] = mapped_column(String(64), primary_key=True)
    dataset_id: Mapped[str] = mapped_column(String(120), nullable=False, index=True)
    applied_revision: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    result_payload: Mapped[dict[str, Any]] = mapped_column(JSON_DOCUMENT, nullable=False, default=dict)
    calculation_state: Mapped[dict[str, Any]] = mapped_column(JSON_DOCUMENT, nullable=False, default=dict)
    calculation_mode: Mapped[str] = mapped_column(String(32), nullable=False, default="full")
    calculated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
