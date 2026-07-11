from fastapi import APIRouter

from app.schemas.etl import TargetDatabasesResponse
from app.services import etl_service

router = APIRouter(prefix="/target", tags=["target"])


@router.get("/databases", response_model=TargetDatabasesResponse)
def list_target_databases() -> TargetDatabasesResponse:
    return etl_service.list_target_databases()
