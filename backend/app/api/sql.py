from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext, get_actor_context
from app.core.database import get_db
from app.repositories.catalog_repository import CatalogRepository
from app.repositories.sql_repository import SqlRepository
from app.schemas.sql import (
    DEFAULT_QUERY_PAGE_LIMIT,
    MAX_QUERY_PAGE_LIMIT,
    QueryAiSuggestionRequest,
    QueryAiSuggestionResponse,
    QueryRunRequest,
    QueryRunResponse,
)
from app.services.query_ai_service import QueryAiService
from app.services.sql_service import SqlService

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


@router.post("/runs", response_model=QueryRunResponse)
def create_query_run(
    request: QueryRunRequest,
    service: Annotated[SqlService, Depends(get_sql_service)],
    actor: Annotated[ActorContext, Depends(get_actor_context)],
) -> QueryRunResponse:
    return service.create_query_run(request, actor)


@router.get("/runs/{run_id}", response_model=QueryRunResponse)
def get_query_run(
    run_id: str,
    service: Annotated[SqlService, Depends(get_sql_service)],
    actor: Annotated[ActorContext, Depends(get_actor_context)],
    limit: Annotated[int, Query(ge=1, le=MAX_QUERY_PAGE_LIMIT)] = DEFAULT_QUERY_PAGE_LIMIT,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> QueryRunResponse:
    return service.get_query_run(run_id, actor=actor, limit=limit, offset=offset)


@router.post("/ai-suggestions", response_model=QueryAiSuggestionResponse)
def create_query_ai_suggestion(
    request: QueryAiSuggestionRequest,
    service: Annotated[QueryAiService, Depends(get_query_ai_service)],
    actor: Annotated[ActorContext, Depends(get_actor_context)],
) -> QueryAiSuggestionResponse:
    return service.create_suggestion(request, actor)
