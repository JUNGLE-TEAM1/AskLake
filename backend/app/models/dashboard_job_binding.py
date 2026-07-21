from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class DashboardJobBindingModel(TimestampMixin, Base):
    """The single managed Dataset binding for a Dashboard.

    Job references are intentionally polymorphic: ETL and Continuous SQL jobs
    have separate durable tables, while a Dashboard binding is a common
    downstream product capability.
    """

    __tablename__ = "dashboard_job_bindings"
    __table_args__ = (
        UniqueConstraint("dashboard_id", name="uq_dashboard_job_bindings_dashboard"),
        Index("ix_dashboard_job_bindings_job", "job_kind", "job_id"),
        Index("ix_dashboard_job_bindings_dataset", "output_dataset_id", "mode"),
    )

    id: Mapped[str] = mapped_column(String(120), primary_key=True)
    dashboard_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    job_id: Mapped[str] = mapped_column(String(160), nullable=False)
    job_kind: Mapped[str] = mapped_column(String(32), nullable=False)
    output_dataset_id: Mapped[str] = mapped_column(String(160), nullable=False)
    mode: Mapped[str] = mapped_column(String(32), nullable=False, default="managed")
    enabled: Mapped[bool] = mapped_column(default=True, nullable=False)
    created_by: Mapped[str] = mapped_column(String(255), nullable=False)
    detached_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class DashboardBindingDeliveryModel(TimestampMixin, Base):
    __tablename__ = "dashboard_binding_deliveries"
    __table_args__ = (
        UniqueConstraint("binding_id", "dataset_revision", name="uq_dashboard_binding_delivery_revision"),
        Index("ix_dashboard_binding_deliveries_status", "status", "updated_at"),
    )

    id: Mapped[str] = mapped_column(String(160), primary_key=True)
    binding_id: Mapped[str] = mapped_column(
        String(120), ForeignKey("dashboard_job_bindings.id", ondelete="CASCADE"), nullable=False, index=True
    )
    dataset_revision: Mapped[int] = mapped_column(BigInteger, nullable=False)
    mutation_type: Mapped[str] = mapped_column(String(32), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending")
    applied_revision: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    calculated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    attempt_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    error_code: Mapped[str | None] = mapped_column(String(120), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
