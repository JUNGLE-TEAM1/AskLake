from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext, get_actor_context
from app.core.database import get_db
from app.repositories.catalog_repository import CatalogRepository
from app.repositories.dashboard_runtime_repository import DashboardRuntimeRepository
from app.repositories.dashboard_live_repository import DashboardLiveRepository
from app.schemas.dashboard import (
    CreateDraftPageRequest,
    CreateDraftWidgetRequest,
    DashboardPageResponse,
    DashboardRuntimeResponse,
    DashboardWidgetMutationResponse,
    DeleteDraftPageResponse,
    DeleteDraftWidgetResponse,
    OkResponse,
    PublishDashboardResponse,
    SaveDraftLayoutsRequest,
    UpdateDraftPageRequest,
    UpdateDraftWidgetRequest,
)
from app.services.dashboard_runtime_service import DashboardRuntimeService

router = APIRouter(prefix="/dashboards", tags=["dashboard-runtime"])


@router.get("/{dashboard_id}/published", response_model=DashboardRuntimeResponse)
def get_published_dashboard_runtime(
    dashboard_id: str,
    include_data: bool = Query(default=True, alias="includeData"),
    actor: ActorContext = Depends(get_actor_context),
    db: Session = Depends(get_db),
) -> DashboardRuntimeResponse:
    repository = DashboardRuntimeRepository(db)
    service = DashboardRuntimeService(
        repository,
        CatalogRepository(db),
        DashboardLiveRepository(db, ensure_schema=False),
    )
    return service.get_published_runtime(dashboard_id, actor, include_data=include_data)


@router.post("/{dashboard_id}/draft/ensure", response_model=DashboardRuntimeResponse)
def ensure_draft_dashboard_runtime(
    dashboard_id: str,
    include_data: bool = Query(default=True, alias="includeData"),
    actor: ActorContext = Depends(get_actor_context),
    db: Session = Depends(get_db),
) -> DashboardRuntimeResponse:
    repository = DashboardRuntimeRepository(db)
    service = DashboardRuntimeService(repository, CatalogRepository(db))
    return service.ensure_draft_runtime(dashboard_id, actor, include_data=include_data)


@router.post("/{dashboard_id}/draft/pages", response_model=DashboardPageResponse)
def create_draft_page(
    dashboard_id: str,
    request: CreateDraftPageRequest,
    actor: ActorContext = Depends(get_actor_context),
    db: Session = Depends(get_db),
) -> DashboardPageResponse:
    repository = DashboardRuntimeRepository(db)
    service = DashboardRuntimeService(repository, CatalogRepository(db))
    return service.create_draft_page(dashboard_id, request, actor)


@router.patch("/{dashboard_id}/draft/pages/{page_id}", response_model=DashboardPageResponse)
def update_draft_page(
    dashboard_id: str,
    page_id: str,
    request: UpdateDraftPageRequest,
    actor: ActorContext = Depends(get_actor_context),
    db: Session = Depends(get_db),
) -> DashboardPageResponse:
    repository = DashboardRuntimeRepository(db)
    service = DashboardRuntimeService(repository, CatalogRepository(db))
    return service.update_draft_page(dashboard_id, page_id, request, actor)


@router.delete("/{dashboard_id}/draft/pages/{page_id}", response_model=DeleteDraftPageResponse)
def delete_draft_page(
    dashboard_id: str,
    page_id: str,
    actor: ActorContext = Depends(get_actor_context),
    db: Session = Depends(get_db),
) -> DeleteDraftPageResponse:
    repository = DashboardRuntimeRepository(db)
    service = DashboardRuntimeService(repository, CatalogRepository(db))
    return service.delete_draft_page(dashboard_id, page_id, actor)


@router.post("/{dashboard_id}/draft/pages/{page_id}/widgets", response_model=DashboardWidgetMutationResponse)
def create_draft_widget(
    dashboard_id: str,
    page_id: str,
    request: CreateDraftWidgetRequest,
    actor: ActorContext = Depends(get_actor_context),
    db: Session = Depends(get_db),
) -> DashboardWidgetMutationResponse:
    repository = DashboardRuntimeRepository(db)
    service = DashboardRuntimeService(repository, CatalogRepository(db))
    return service.create_draft_widget(dashboard_id, page_id, request, actor)


@router.patch("/{dashboard_id}/draft/widgets/{widget_id}", response_model=DashboardWidgetMutationResponse)
def update_draft_widget(
    dashboard_id: str,
    widget_id: str,
    request: UpdateDraftWidgetRequest,
    actor: ActorContext = Depends(get_actor_context),
    db: Session = Depends(get_db),
) -> DashboardWidgetMutationResponse:
    repository = DashboardRuntimeRepository(db)
    service = DashboardRuntimeService(repository, CatalogRepository(db))
    return service.update_draft_widget(dashboard_id, widget_id, request, actor)


@router.delete("/{dashboard_id}/draft/widgets/{widget_id}", response_model=DeleteDraftWidgetResponse)
def delete_draft_widget(
    dashboard_id: str,
    widget_id: str,
    actor: ActorContext = Depends(get_actor_context),
    db: Session = Depends(get_db),
) -> DeleteDraftWidgetResponse:
    repository = DashboardRuntimeRepository(db)
    service = DashboardRuntimeService(repository, CatalogRepository(db))
    return service.delete_draft_widget(dashboard_id, widget_id, actor)


@router.patch("/{dashboard_id}/draft/layouts", response_model=OkResponse)
def save_draft_layouts(
    dashboard_id: str,
    request: SaveDraftLayoutsRequest,
    actor: ActorContext = Depends(get_actor_context),
    db: Session = Depends(get_db),
) -> OkResponse:
    repository = DashboardRuntimeRepository(db)
    service = DashboardRuntimeService(repository, CatalogRepository(db))
    return service.save_draft_layouts(dashboard_id, request, actor)


@router.post("/{dashboard_id}/publish", response_model=PublishDashboardResponse)
def publish_dashboard(
    dashboard_id: str,
    actor: ActorContext = Depends(get_actor_context),
    db: Session = Depends(get_db),
) -> PublishDashboardResponse:
    repository = DashboardRuntimeRepository(db)
    service = DashboardRuntimeService(repository, CatalogRepository(db))
    return service.publish_dashboard(dashboard_id, actor)
