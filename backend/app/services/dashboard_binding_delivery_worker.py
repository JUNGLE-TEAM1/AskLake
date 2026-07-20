"""Deliver verified Dataset revisions to managed Dashboard widgets.

This worker deliberately consumes ``dataset_revision_commits`` rather than a
Job-specific success signal. Every producer that reaches the common Catalog
publication boundary (batch, Kafka continuous, and Continuous SQL) therefore
uses the same downstream delivery path.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime

from sqlalchemy import select

from app.core.auth_context import ActorContext
from app.core.database import SessionLocal
from app.models.dashboard_job_binding import DashboardBindingDeliveryModel, DashboardJobBindingModel
from app.models.dashboard_live import DatasetRevisionCommitModel
from app.models.dashboard_runtime import DashboardPage, DashboardRevision, DashboardWidget
from app.repositories.catalog_repository import CatalogRepository
from app.repositories.dashboard_job_binding_repository import DashboardJobBindingRepository
from app.repositories.dashboard_live_repository import DashboardLiveRepository
from app.repositories.dashboard_runtime_repository import DashboardRuntimeRepository
from app.schemas.dashboard import DashboardRuntimeMode
from app.services.dashboard_runtime_service import DashboardRuntimeService


logger = logging.getLogger(__name__)
_SYSTEM_ACTOR = ActorContext(id="dashboard-binding-delivery", name="Admin User", role="admin")


def process_dashboard_binding_deliveries(*, limit: int = 100) -> int:
    """Create and advance delivery rows for all published Dataset revisions."""
    _enqueue_verified_revisions(limit=limit)
    with SessionLocal() as db:
        repository = DashboardJobBindingRepository(db)
        delivery_ids = [delivery.id for delivery in repository.list_deliveries()[:limit]]
    completed = 0
    for delivery_id in delivery_ids:
        try:
            if _process_delivery(delivery_id):
                completed += 1
        except Exception:
            logger.exception("Dashboard binding delivery failed delivery_id=%s", delivery_id)
    return completed


def _enqueue_verified_revisions(*, limit: int) -> None:
    with SessionLocal() as db:
        repository = DashboardJobBindingRepository(db)
        created = 0
        for binding in repository.list_active():
            commits = db.scalars(
                select(DatasetRevisionCommitModel)
                .where(DatasetRevisionCommitModel.dataset_id == binding.output_dataset_id)
                .order_by(DatasetRevisionCommitModel.revision.asc())
            ).all()
            for commit in commits:
                if repository.get_delivery(binding.id, int(commit.revision)) is not None:
                    continue
                db.add(DashboardBindingDeliveryModel(
                    id=f"dashdelivery-{binding.id}-{int(commit.revision)}",
                    binding_id=binding.id,
                    dataset_revision=int(commit.revision),
                    mutation_type=str(commit.mutation_type or "append"),
                    status="pending",
                ))
                created += 1
                if created >= limit:
                    break
            if created >= limit:
                break
        if created:
            db.commit()


def _process_delivery(delivery_id: str) -> bool:
    with SessionLocal() as db:
        delivery = db.get(DashboardBindingDeliveryModel, delivery_id)
        if delivery is None:
            return False
        binding = db.get(DashboardJobBindingModel, delivery.binding_id)
        if binding is None or binding.mode != "managed" or not binding.enabled:
            delivery.status = "failed"
            delivery.error_code = "BINDING_INACTIVE"
            delivery.error_message = "Binding is detached or disabled."
            db.commit()
            return False
        delivery.status = "calculating"
        delivery.attempt_count += 1
        delivery.error_code = None
        delivery.error_message = None
        db.commit()

    with SessionLocal() as db:
        delivery = db.get(DashboardBindingDeliveryModel, delivery_id)
        binding = db.get(DashboardJobBindingModel, delivery.binding_id) if delivery else None
        if delivery is None or binding is None:
            return False
        try:
            widgets = _calculate_managed_widgets(db, binding, int(delivery.dataset_revision))
            errors = [widget.data_error for widget in widgets if widget.data_status == "error"]
            behind = [widget for widget in widgets if (widget.applied_revision or 0) < int(delivery.dataset_revision)]
            if errors or behind:
                delivery.status = "degraded"
                delivery.error_code = "WIDGET_CALCULATION_INCOMPLETE"
                delivery.error_message = next((error for error in errors if error), "Widget result has not reached the Dataset revision.")
                db.commit()
                return False
            delivery.status = "applied"
            delivery.applied_revision = max([int(delivery.dataset_revision), *[int(widget.applied_revision or 0) for widget in widgets]])
            delivery.calculated_at = datetime.now(UTC)
            db.commit()
            return True
        except Exception as exc:
            db.rollback()
            delivery = db.get(DashboardBindingDeliveryModel, delivery_id)
            if delivery is not None:
                delivery.status = "degraded"
                delivery.error_code = "WIDGET_CALCULATION_FAILED"
                delivery.error_message = str(exc)[:1000]
                db.commit()
            return False


def _calculate_managed_widgets(db: object, binding: DashboardJobBindingModel, revision: int):
    repository = DashboardRuntimeRepository(db)
    service = DashboardRuntimeService(
        repository,
        CatalogRepository(db),
        DashboardLiveRepository(db, ensure_schema=False),
        prepared_live_results_only=False,
    )
    results = []
    for mode in (DashboardRuntimeMode.DRAFT, DashboardRuntimeMode.PUBLISHED):
        dashboard_revision = (
            repository.get_draft_revision(binding.dashboard_id)
            if mode == DashboardRuntimeMode.DRAFT
            else repository.get_published_revision(binding.dashboard_id)
        )
        if dashboard_revision is None:
            continue
        pages = repository.list_pages(dashboard_revision.id)
        widgets = [
            widget
            for entries in repository.list_widgets_by_page_ids([page.id for page in pages]).values()
            for widget in entries
            if widget.dataset_id == binding.output_dataset_id
        ]
        if widgets:
            results.extend(service.query_widgets(binding.dashboard_id, [widget.id for widget in widgets], mode, _SYSTEM_ACTOR))
    return results
