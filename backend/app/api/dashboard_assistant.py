from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext, get_actor_context
from app.core.config import settings
from app.core.database import get_db
from app.repositories.catalog_repository import CatalogRepository
from app.repositories.dashboard_runtime_repository import DashboardRuntimeRepository
from app.schemas.dashboard import (
    DashboardAssistantRequest,
    DashboardAssistantResponse,
)
from app.services.dashboard_assistant_service import DashboardAssistantService
from app.services.dashboard_runtime_service import DashboardRuntimeService

router = APIRouter(prefix="/dashboards", tags=["dashboard-assistant"])


@router.post("/assistant", response_model=DashboardAssistantResponse)
def request_dashboard_assistant(
    request: DashboardAssistantRequest,
    actor: ActorContext = Depends(get_actor_context),
    db: Session = Depends(get_db),
) -> DashboardAssistantResponse:
    runtime_repository = DashboardRuntimeRepository(db)
    if request.dashboard_id:
        DashboardRuntimeService(
            runtime_repository,
            CatalogRepository(db),
        ).require_assistant_access(request.dashboard_id, actor)
    service = DashboardAssistantService(
        runtime_repository,
        CatalogRepository(db),
        settings,
    )
    return service.generate_response(request, actor)
