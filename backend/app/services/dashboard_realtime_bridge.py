from __future__ import annotations

from datetime import datetime

from sqlalchemy.orm import Session

from app.core.config import settings
from app.repositories.realtime_event_repository import RealtimeEventRepository
from app.schemas.dashboard import (
    DashboardRuntimeMode,
    DashboardRuntimeWidgetType,
    DashboardWidgetLayout,
)


DASHBOARD_LEGACY_COLOR_MAP = {
    "blue": "#2563eb",
    "green": "#10b981",
    "orange": "#f97316",
    "pink": "#db2777",
    "purple": "#8b5cf6",
    "red": "#ef4444",
    "yellow": "#f59e0b",
}


def append_dataset_revision_event(
    db: Session,
    dataset_id: str,
    revision: int,
    run_id: str,
    commit_kind: str,
    occurred_at: datetime,
) -> None:
    if not settings.realtime_events_enabled:
        return
    RealtimeEventRepository(db).append(
        event_type="dataset.revision.committed",
        resource_type="dataset",
        resource_id=dataset_id,
        aggregate_revision=revision,
        correlation_id=run_id,
        idempotency_key=f"dataset:{dataset_id}:revision:{revision}",
        invalidations=[
            f"dataset:{dataset_id}:freshness",
            f"dashboard-widgets-by-dataset:{dataset_id}",
        ],
        payload={"runId": run_id, "commitKind": commit_kind},
        occurred_at=occurred_at,
    )


def append_dashboard_published_event(
    db: Session,
    dashboard_id: str,
    published_revision_id: str,
    revision: int,
    occurred_at: datetime,
) -> None:
    if not settings.realtime_events_enabled:
        return
    RealtimeEventRepository(db).append(
        event_type="dashboard.published",
        resource_type="dashboard",
        resource_id=dashboard_id,
        aggregate_revision=revision,
        correlation_id=published_revision_id,
        idempotency_key=f"dashboard:{dashboard_id}:published:{published_revision_id}",
        invalidations=[f"dashboard:{dashboard_id}:published"],
        payload={"publishedRevisionId": published_revision_id},
        occurred_at=occurred_at,
    )


def published_snapshot_event_cursor(db: Session, mode: DashboardRuntimeMode) -> int:
    if mode != DashboardRuntimeMode.PUBLISHED:
        return 0
    return RealtimeEventRepository(db).max_cursor()


def default_dashboard_widget_layout() -> DashboardWidgetLayout:
    return DashboardWidgetLayout(x=0, y=0, w=4, h=3, min_w=2, min_h=2)


def dashboard_widget_type_enum(
    value: DashboardRuntimeWidgetType | str,
) -> DashboardRuntimeWidgetType:
    return value if isinstance(value, DashboardRuntimeWidgetType) else DashboardRuntimeWidgetType(value)


def dashboard_datetime_to_iso(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None
