from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext, get_actor_context
from app.core.database import get_db
from app.repositories.catalog_repository import CatalogRepository
from app.schemas.etl import QueryRunRequest, QueryRunResponse
from app.schemas.sql import QueryAiSuggestionRequest, QueryAiSuggestionResponse
from app.services import etl_service
from app.services.query_ai_service import QueryAiService

router = APIRouter(prefix="/query", tags=["query"])


@router.post("/runs", response_model=QueryRunResponse)
def execute_query(request: QueryRunRequest, db: Session = Depends(get_db)) -> QueryRunResponse:
    return etl_service.execute_query(db, request)


@router.post("/ai-suggestions", response_model=QueryAiSuggestionResponse)
def create_query_ai_suggestion(
    request: QueryAiSuggestionRequest,
    db: Session = Depends(get_db),
    actor: ActorContext = Depends(get_actor_context),
) -> QueryAiSuggestionResponse:
    return QueryAiService(CatalogRepository(db)).create_suggestion(request, actor)
