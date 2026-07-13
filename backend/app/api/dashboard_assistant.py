from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.auth_context import ActorContext, get_actor_context
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
    db: Session = Depends(get_db),
    actor: ActorContext = Depends(get_actor_context),
) -> DashboardAssistantResponse:
    service = DashboardAssistantService(
        DashboardRuntimeRepository(db),
        CatalogRepository(db),
        settings,
    )
    if request.dashboard_id:
        DashboardRuntimeService(
            DashboardRuntimeRepository(db),
            CatalogRepository(db),
        ).require_assistant_access(request.dashboard_id, actor)
    return service.generate_response(request, actor)
