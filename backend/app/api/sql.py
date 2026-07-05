from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.repositories.catalog_repository import CatalogRepository
from app.repositories.sql_repository import SqlRepository
from app.schemas.sql import QueryRunRequest, QueryRunResponse
from app.services.sql_service import SqlService

router = APIRouter(prefix="/query", tags=["query"])


def get_sql_service(db: Annotated[Session, Depends(get_db)]) -> SqlService:
    return SqlService(
        repository=SqlRepository(db),
        catalog_repository=CatalogRepository(db),
    )


@router.post("/runs", response_model=QueryRunResponse)
def create_query_run(
    request: QueryRunRequest,
    service: Annotated[SqlService, Depends(get_sql_service)],
) -> QueryRunResponse:
    return service.create_query_run(request)
