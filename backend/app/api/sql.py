from typing import Annotated

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext, get_actor_context
from app.core.database import get_db
from app.core.config import settings
from app.core.errors import ApiError
from app.repositories.catalog_repository import CatalogRepository
from app.repositories.sql_repository import SqlRepository
from app.schemas.sql import (
    QueryAiSuggestionRequest,
    QueryAiSuggestionResponse,
    QueryRunRequest,
    QueryRunResponse,
)
from app.schemas.common import ErrorCode
from app.schemas.trino import QueryRunSubmitRequest, TrinoQueryRunResponse, TrinoQueryRunResultPage
from app.services.query_ai_service import QueryAiService
from app.services.sql_service import SqlService
from app.services.trino_query_run_service import TrinoQueryRunService

router = APIRouter(prefix="/query", tags=["query"])


def get_sql_service(db: Annotated[Session, Depends(get_db)]) -> SqlService:
    return SqlService(
        repository=SqlRepository(db),
        catalog_repository=CatalogRepository(db),
    )


def get_query_ai_service(db: Annotated[Session, Depends(get_db)]) -> QueryAiService:
    return QueryAiService(
        catalog_repository=CatalogRepository(db),
    )


def get_trino_query_run_service(db: Annotated[Session, Depends(get_db)]) -> TrinoQueryRunService:
    return TrinoQueryRunService(
        repository=SqlRepository(db),
        catalog_repository=CatalogRepository(db),
    )


@router.post("/runs", response_model=QueryRunResponse | TrinoQueryRunResponse)
def create_query_run(
    request: QueryRunSubmitRequest,
    service: Annotated[SqlService, Depends(get_sql_service)],
    trino_service: Annotated[TrinoQueryRunService, Depends(get_trino_query_run_service)],
    actor: Annotated[ActorContext, Depends(get_actor_context)],
    response: Response,
) -> QueryRunResponse | TrinoQueryRunResponse:
    if settings.trino_enabled:
        try:
            trino_request = request.trino_request()
        except ValueError as exc:
            raise ApiError(ErrorCode.VALIDATION_ERROR, str(exc), status.HTTP_422_UNPROCESSABLE_ENTITY) from exc
        response.status_code = status.HTTP_202_ACCEPTED
        return trino_service.submit(trino_request, actor)

    if not request.dataset_id:
        raise ApiError(ErrorCode.VALIDATION_ERROR, "datasetId is required while DuckDB compatibility mode is active", status.HTTP_422_UNPROCESSABLE_ENTITY)
    return service.create_query_run(QueryRunRequest.model_validate(request.model_dump(by_alias=True)), actor)


@router.get("/runs/{run_id}", response_model=QueryRunResponse | TrinoQueryRunResponse)
def get_query_run(
    run_id: str,
    service: Annotated[SqlService, Depends(get_sql_service)],
    trino_service: Annotated[TrinoQueryRunService, Depends(get_trino_query_run_service)],
    actor: Annotated[ActorContext, Depends(get_actor_context)],
) -> QueryRunResponse | TrinoQueryRunResponse:
    if run_id.startswith("trino_"):
        return trino_service.refresh(run_id, actor)
    return service.get_query_run(run_id)


@router.get("/runs/{run_id}/results", response_model=TrinoQueryRunResultPage)
def get_trino_query_run_results(
    run_id: str,
    trino_service: Annotated[TrinoQueryRunService, Depends(get_trino_query_run_service)],
    actor: Annotated[ActorContext, Depends(get_actor_context)],
    cursor: str | None = None,
) -> TrinoQueryRunResultPage:
    return trino_service.get_result_page(run_id, cursor, actor)


@router.post("/runs/{run_id}/cancel", response_model=TrinoQueryRunResponse)
def cancel_trino_query_run(
    run_id: str,
    trino_service: Annotated[TrinoQueryRunService, Depends(get_trino_query_run_service)],
    actor: Annotated[ActorContext, Depends(get_actor_context)],
) -> TrinoQueryRunResponse:
    return trino_service.cancel(run_id, actor)


@router.post("/ai-suggestions", response_model=QueryAiSuggestionResponse)
def create_query_ai_suggestion(
    request: QueryAiSuggestionRequest,
    service: Annotated[QueryAiService, Depends(get_query_ai_service)],
    actor: Annotated[ActorContext, Depends(get_actor_context)],
) -> QueryAiSuggestionResponse:
    return service.create_suggestion(request, actor)
