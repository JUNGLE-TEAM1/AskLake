from typing import Annotated

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext, get_actor_context
from app.core.database import get_db
from app.schemas.dashboard import DashboardJobBinding, DashboardJobBindingCreateRequest, DashboardJobBindingList, DashboardJobKind
from app.services.dashboard_job_binding_service import DashboardJobBindingService


router = APIRouter(prefix="/dashboard-job-bindings", tags=["dashboard-job-bindings"])


def get_service(db: Annotated[Session, Depends(get_db)]) -> DashboardJobBindingService:
    return DashboardJobBindingService(db)


@router.post("", response_model=DashboardJobBinding, status_code=status.HTTP_201_CREATED)
def create_binding(request: DashboardJobBindingCreateRequest, service: Annotated[DashboardJobBindingService, Depends(get_service)], actor: Annotated[ActorContext, Depends(get_actor_context)]) -> DashboardJobBinding:
    return service.create(request, actor)


@router.get("", response_model=DashboardJobBindingList)
def list_bindings(service: Annotated[DashboardJobBindingService, Depends(get_service)], actor: Annotated[ActorContext, Depends(get_actor_context)], job_id: str | None = Query(default=None, alias="jobId"), job_kind: DashboardJobKind | None = Query(default=None, alias="jobKind"), dashboard_id: str | None = Query(default=None, alias="dashboardId")) -> DashboardJobBindingList:
    return service.list(actor, job_id=job_id, job_kind=job_kind, dashboard_id=dashboard_id)


@router.get("/{binding_id}", response_model=DashboardJobBinding)
def get_binding(binding_id: str, service: Annotated[DashboardJobBindingService, Depends(get_service)], actor: Annotated[ActorContext, Depends(get_actor_context)]) -> DashboardJobBinding:
    return service.get(binding_id, actor)


@router.post("/{binding_id}/detach", response_model=DashboardJobBinding)
def detach_binding(binding_id: str, service: Annotated[DashboardJobBindingService, Depends(get_service)], actor: Annotated[ActorContext, Depends(get_actor_context)]) -> DashboardJobBinding:
    return service.detach(binding_id, actor)


@router.post("/{binding_id}/deliveries/{dataset_revision}/retry", response_model=DashboardJobBinding)
def retry_binding_delivery(binding_id: str, dataset_revision: int, service: Annotated[DashboardJobBindingService, Depends(get_service)], actor: Annotated[ActorContext, Depends(get_actor_context)]) -> DashboardJobBinding:
    return service.retry(binding_id, dataset_revision, actor)
