from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.repositories.dashboard_runtime_repository import DashboardRuntimeRepository
from app.schemas.dashboard import DashboardRuntimeResponse
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
