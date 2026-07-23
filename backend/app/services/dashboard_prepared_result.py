"""Render a previously prepared live Dashboard result without physical reads."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from app.models.dashboard_runtime import DashboardWidget as DashboardWidgetModel
from app.schemas.dashboard import (
    DashboardRuntimeWidget,
    DashboardRuntimeWidgetType,
    DashboardWidgetLayout,
)
from app.services.dashboard_realtime_bridge import dashboard_datetime_to_iso


def prepared_live_widget_response(
    live_repository: Any,
    widget: DashboardWidgetModel,
    config: dict[str, Any],
    calculation_version: str,
    saved_payload: dict[str, Any] | None,
    saved_revision: int | None,
    saved_calculated_at: datetime | None,
) -> DashboardRuntimeWidget:
    live_repository.db.commit()
    payload = saved_payload or {}
    return DashboardRuntimeWidget(
        id=widget.id,
        page_id=widget.page_id,
        type=DashboardRuntimeWidgetType(widget.type),
        title=widget.title,
        layout=DashboardWidgetLayout(**widget.layout),
        config=dict(payload.get("config") or config),
        data=list(payload.get("data") or []),
        dataset_id=widget.dataset_id,
        query_id=widget.query_id,
        applied_revision=saved_revision,
        calculation_version=calculation_version,
        calculated_at=dashboard_datetime_to_iso(saved_calculated_at),
        live_refresh=True,
        data_status="ready" if saved_payload is not None else "pending",
    )
