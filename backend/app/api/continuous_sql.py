from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext, get_actor_context
from app.core.database import get_db
from app.schemas.continuous_sql import (
    ContinuousSqlBatch,
    ContinuousSqlCommandRequest,
    ContinuousSqlCommandResponse,
    ContinuousSqlCreateRequest,
    ContinuousSqlJob,
    ContinuousSqlJobList,
    ContinuousSqlPlanRequest,
    ContinuousSqlPlanResponse,
)
from app.services.continuous_sql_service import ContinuousSqlService


router = APIRouter(prefix="/query/continuous-jobs", tags=["continuous-sql"])


def get_continuous_sql_service(
    db: Annotated[Session, Depends(get_db)],
) -> ContinuousSqlService:
    return ContinuousSqlService(db)


@router.post("/validate", response_model=ContinuousSqlPlanResponse)
def validate_continuous_sql(
    request: ContinuousSqlPlanRequest,
    service: Annotated[ContinuousSqlService, Depends(get_continuous_sql_service)],
    actor: Annotated[ActorContext, Depends(get_actor_context)],
) -> ContinuousSqlPlanResponse:
    return service.validate(request, actor)


@router.post("", response_model=ContinuousSqlJob, status_code=status.HTTP_201_CREATED)
def create_continuous_sql_job(
    request: ContinuousSqlCreateRequest,
    service: Annotated[ContinuousSqlService, Depends(get_continuous_sql_service)],
    actor: Annotated[ActorContext, Depends(get_actor_context)],
    response: Response,
) -> ContinuousSqlJob:
    job = service.create(request, actor)
    if request.client_request_id and service.repository.job_by_client_request(actor.name, request.client_request_id) is not None:
        # The representation is identical for an idempotent replay. Keep 201
        # for the first call; callers can safely treat both as success.
        response.headers["Idempotency-Key"] = request.client_request_id
    return job


@router.get("", response_model=ContinuousSqlJobList)
def list_continuous_sql_jobs(
    service: Annotated[ContinuousSqlService, Depends(get_continuous_sql_service)],
    actor: Annotated[ActorContext, Depends(get_actor_context)],
) -> ContinuousSqlJobList:
    return service.list(actor)


@router.get("/{job_id}", response_model=ContinuousSqlJob)
def get_continuous_sql_job(
    job_id: str,
    service: Annotated[ContinuousSqlService, Depends(get_continuous_sql_service)],
    actor: Annotated[ActorContext, Depends(get_actor_context)],
) -> ContinuousSqlJob:
    return service.get(job_id, actor)


@router.post("/{job_id}/commands", response_model=ContinuousSqlCommandResponse)
def command_continuous_sql_job(
    job_id: str,
    request: ContinuousSqlCommandRequest,
    service: Annotated[ContinuousSqlService, Depends(get_continuous_sql_service)],
    actor: Annotated[ActorContext, Depends(get_actor_context)],
) -> ContinuousSqlCommandResponse:
    return service.command(job_id, request, actor)


@router.get("/{job_id}/batches", response_model=list[ContinuousSqlBatch])
def list_continuous_sql_batches(
    job_id: str,
    service: Annotated[ContinuousSqlService, Depends(get_continuous_sql_service)],
    actor: Annotated[ActorContext, Depends(get_actor_context)],
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
) -> list[ContinuousSqlBatch]:
    return service.list_batches(job_id, actor, limit=limit)
