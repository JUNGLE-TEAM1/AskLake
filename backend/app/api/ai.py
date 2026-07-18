from typing import Annotated

from fastapi import APIRouter, Depends

from app.core.auth_context import ActorContext, get_actor_context
from app.schemas.ai_generation import AiSqlGenerationRequest, AiSqlGenerationResponse
from app.services.ai_generation_service import AiGenerationService


router = APIRouter(prefix="/ai", tags=["ai"])


@router.post("/generate-sql", response_model=AiSqlGenerationResponse)
def generate_sql(
    request: AiSqlGenerationRequest,
    _actor: Annotated[ActorContext, Depends(get_actor_context)],
) -> AiSqlGenerationResponse:
    return AiGenerationService().generate_sql(request)
