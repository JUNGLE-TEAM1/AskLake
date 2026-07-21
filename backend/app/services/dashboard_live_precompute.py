"""Prepare Dashboard results as soon as Continuous SQL publishes a Kafka delta."""

from __future__ import annotations

import logging
import os

from sqlalchemy import select

from app.core.auth_context import ActorContext
from app.core.database import SessionLocal
from app.models.continuous_sql import ContinuousSqlJobModel
from app.models.dashboard_runtime import DashboardPage, DashboardRevision, DashboardWidget
from app.repositories.catalog_repository import CatalogRepository
from app.repositories.dashboard_live_repository import DashboardLiveRepository
from app.repositories.dashboard_runtime_repository import DashboardRuntimeRepository
from app.schemas.dashboard import DashboardRuntimeMode
from app.services.dashboard_runtime_service import DashboardRuntimeService


logger = logging.getLogger(__name__)
_SYSTEM_ACTOR = ActorContext(
    id="continuous-dashboard-precompute",
    name="Admin User",
    role="admin",
)


def precompute_continuous_sql_dashboards() -> int:
    """Advance published widgets over pending Continuous SQL delta revisions.

    Continuous SQL already writes one Iceberg delta per Kafka offset range. The
    Dashboard runtime stores the first calculation as its baseline aggregate
    state and merges later revisions into that state. Running the calculation
    here keeps browser refreshes on the prepared-result read path.
    """
    with SessionLocal() as db:
        targets = _published_continuous_sql_widgets(db)

    completed = 0
    for dashboard_id, widget_ids in targets.items():
        try:
            completed += _advance_dashboard(dashboard_id, widget_ids)
        except Exception:
            logger.exception(
                "Continuous SQL Dashboard precompute failed dashboard_id=%s",
                dashboard_id,
            )
    return completed


def _published_continuous_sql_widgets(db: object) -> dict[str, list[str]]:
    rows = db.execute(
        select(
            DashboardRevision.dashboard_id,
            DashboardWidget.id,
        )
        .join(DashboardPage, DashboardPage.revision_id == DashboardRevision.id)
        .join(DashboardWidget, DashboardWidget.page_id == DashboardPage.id)
        .join(
            ContinuousSqlJobModel,
            ContinuousSqlJobModel.output_dataset_id == DashboardWidget.dataset_id,
        )
        .where(DashboardRevision.kind == DashboardRuntimeMode.PUBLISHED.value)
        .order_by(DashboardRevision.dashboard_id, DashboardWidget.id)
    ).all()
    targets: dict[str, list[str]] = {}
    for dashboard_id, widget_id in rows:
        targets.setdefault(str(dashboard_id), []).append(str(widget_id))
    return {
        dashboard_id: list(dict.fromkeys(widget_ids))
        for dashboard_id, widget_ids in targets.items()
    }


def _advance_dashboard(dashboard_id: str, candidate_widget_ids: list[str]) -> int:
    """Catch a Dashboard up without rescanning its accumulated Iceberg table."""
    completed = 0
    for _ in range(_max_revisions_per_cycle()):
        with SessionLocal() as db:
            repository = DashboardRuntimeRepository(db)
            revision = repository.get_published_revision(dashboard_id)
            if revision is None:
                return completed
            pages = repository.list_pages(revision.id)
            current_ids = {
                widget.id
                for widgets in repository.list_widgets_by_page_ids(
                    [page.id for page in pages]
                ).values()
                for widget in widgets
            }
            widget_ids = [
                widget_id for widget_id in candidate_widget_ids if widget_id in current_ids
            ]
            if not widget_ids:
                return completed

            live_repository = DashboardLiveRepository(db, ensure_schema=False)
            service = DashboardRuntimeService(
                repository,
                CatalogRepository(db),
                live_repository,
                prepared_live_results_only=False,
            )
            widgets = service.query_widgets(
                dashboard_id,
                widget_ids,
                DashboardRuntimeMode.PUBLISHED,
                _SYSTEM_ACTOR,
            )
            pending = False
            for widget in widgets:
                if not widget.dataset_id:
                    continue
                freshness = live_repository.get_freshness(widget.dataset_id)
                latest_revision = int(freshness.latest_revision or 0) if freshness else 0
                applied_revision = int(widget.applied_revision or 0)
                pending = pending or applied_revision < latest_revision
                completed += 1
            if not pending:
                return completed
    return completed


def _max_revisions_per_cycle() -> int:
    try:
        return max(
            1,
            min(100, int(os.environ.get("DASHBOARD_PRECOMPUTE_MAX_REVISIONS", "16"))),
        )
    except ValueError:
        return 16
