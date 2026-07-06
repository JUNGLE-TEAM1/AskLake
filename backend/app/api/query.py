from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.schemas.etl import QueryRunRequest, QueryRunResponse
from app.services import etl_service

router = APIRouter(prefix="/query", tags=["query"])


@router.post("/runs", response_model=QueryRunResponse)
def execute_query(request: QueryRunRequest, db: Session = Depends(get_db)) -> QueryRunResponse:
    return etl_service.execute_query(db, request)
