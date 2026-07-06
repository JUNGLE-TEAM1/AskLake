from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, ForeignKey, Integer, JSON, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class DashboardRevision(TimestampMixin, Base):
    __tablename__ = "dashboard_revisions"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    dashboard_id: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    kind: Mapped[str] = mapped_column(String(32), index=True, nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class DashboardPage(TimestampMixin, Base):
    __tablename__ = "dashboard_pages"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    revision_id: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("dashboard_revisions.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    title: Mapped[str] = mapped_column(String(120), nullable=False)
    order_index: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class DashboardWidget(TimestampMixin, Base):
    __tablename__ = "dashboard_widgets"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    page_id: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("dashboard_pages.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    type: Mapped[str] = mapped_column(String(32), nullable=False)
    title: Mapped[str | None] = mapped_column(String(160), nullable=True)
    dataset_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    query_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    layout: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
    config: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
    data: Mapped[list[dict[str, Any]]] = mapped_column(JSON, nullable=False, default=list)
