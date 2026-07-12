from fastapi import APIRouter, Depends

from app.core.auth_context import ActorContext, get_actor_context
from app.schemas.etl import TargetDatabasesResponse
from app.services import etl_service

router = APIRouter(prefix="/target", tags=["target"])


@router.get("/databases", response_model=TargetDatabasesResponse)
def list_target_databases(_actor: ActorContext = Depends(get_actor_context)) -> TargetDatabasesResponse:
    return etl_service.list_target_databases()
