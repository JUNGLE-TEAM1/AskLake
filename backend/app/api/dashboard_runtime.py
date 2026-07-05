from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.repositories.dashboard_runtime_repository import DashboardRuntimeRepository
from app.schemas.dashboard import (
    CreateDraftPageRequest,
    CreateDraftWidgetRequest,
    DashboardPageResponse,
    DashboardRuntimeResponse,
    DashboardWidgetMutationResponse,
    DeleteDraftPageResponse,
    DeleteDraftWidgetResponse,
    UpdateDraftPageRequest,
    UpdateDraftWidgetRequest,
)
from app.services.dashboard_runtime_service import DashboardRuntimeService

router = APIRouter(prefix="/dashboards", tags=["dashboard-runtime"])


@router.get("/{dashboard_id}/published", response_model=DashboardRuntimeResponse)
def get_published_dashboard_runtime(dashboard_id: str, db: Session = Depends(get_db)) -> DashboardRuntimeResponse:
    repository = DashboardRuntimeRepository(db)
    service = DashboardRuntimeService(repository)
    return service.get_published_runtime(dashboard_id)


@router.post("/{dashboard_id}/draft/ensure", response_model=DashboardRuntimeResponse)
def ensure_draft_dashboard_runtime(dashboard_id: str, db: Session = Depends(get_db)) -> DashboardRuntimeResponse:
    repository = DashboardRuntimeRepository(db)
    service = DashboardRuntimeService(repository)
    return service.ensure_draft_runtime(dashboard_id)


@router.post("/{dashboard_id}/draft/pages", response_model=DashboardPageResponse)
def create_draft_page(
    dashboard_id: str,
    request: CreateDraftPageRequest,
    db: Session = Depends(get_db),
) -> DashboardPageResponse:
    repository = DashboardRuntimeRepository(db)
    service = DashboardRuntimeService(repository)
    return service.create_draft_page(dashboard_id, request)


@router.patch("/{dashboard_id}/draft/pages/{page_id}", response_model=DashboardPageResponse)
def update_draft_page(
    dashboard_id: str,
    page_id: str,
    request: UpdateDraftPageRequest,
    db: Session = Depends(get_db),
) -> DashboardPageResponse:
    repository = DashboardRuntimeRepository(db)
    service = DashboardRuntimeService(repository)
    return service.update_draft_page(dashboard_id, page_id, request)


@router.delete("/{dashboard_id}/draft/pages/{page_id}", response_model=DeleteDraftPageResponse)
def delete_draft_page(
    dashboard_id: str,
    page_id: str,
    db: Session = Depends(get_db),
) -> DeleteDraftPageResponse:
    repository = DashboardRuntimeRepository(db)
    service = DashboardRuntimeService(repository)
    return service.delete_draft_page(dashboard_id, page_id)


@router.post("/{dashboard_id}/draft/pages/{page_id}/widgets", response_model=DashboardWidgetMutationResponse)
def create_draft_widget(
    dashboard_id: str,
    page_id: str,
    request: CreateDraftWidgetRequest,
    db: Session = Depends(get_db),
) -> DashboardWidgetMutationResponse:
    repository = DashboardRuntimeRepository(db)
    service = DashboardRuntimeService(repository)
    return service.create_draft_widget(dashboard_id, page_id, request)


@router.patch("/{dashboard_id}/draft/widgets/{widget_id}", response_model=DashboardWidgetMutationResponse)
def update_draft_widget(
    dashboard_id: str,
    widget_id: str,
    request: UpdateDraftWidgetRequest,
    db: Session = Depends(get_db),
) -> DashboardWidgetMutationResponse:
    repository = DashboardRuntimeRepository(db)
    service = DashboardRuntimeService(repository)
    return service.update_draft_widget(dashboard_id, widget_id, request)


@router.delete("/{dashboard_id}/draft/widgets/{widget_id}", response_model=DeleteDraftWidgetResponse)
def delete_draft_widget(
    dashboard_id: str,
    widget_id: str,
    db: Session = Depends(get_db),
) -> DeleteDraftWidgetResponse:
    repository = DashboardRuntimeRepository(db)
    service = DashboardRuntimeService(repository)
    return service.delete_draft_widget(dashboard_id, widget_id)
