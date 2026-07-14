from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext, get_actor_context
from app.core.database import get_db
from app.repositories.ai_conversation_repository import AiConversationRepository
from app.repositories.catalog_repository import CatalogRepository
from app.schemas.ai import (
    AiConversationListResponse,
    AiConversationResponse,
    CreateAiConversationMessageRequest,
    CreateAiConversationRequest,
    UpdateAiConversationRequest,
)
from app.services.ai_conversation_service import AiConversationService
from app.services.query_ai_service import QueryAiService

router = APIRouter(prefix="/ai/conversations", tags=["ai-conversations"])


def get_ai_conversation_service(
    db: Annotated[Session, Depends(get_db)],
) -> AiConversationService:
    catalog_repository = CatalogRepository(db)
    return AiConversationService(
        repository=AiConversationRepository(db),
        query_ai_service=QueryAiService(catalog_repository),
    )


@router.get("", response_model=AiConversationListResponse)
def list_ai_conversations(
    service: Annotated[AiConversationService, Depends(get_ai_conversation_service)],
    actor: Annotated[ActorContext, Depends(get_actor_context)],
) -> AiConversationListResponse:
    return service.list_conversations(actor)


@router.post(
    "",
    response_model=AiConversationResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_ai_conversation(
    request: CreateAiConversationRequest,
    service: Annotated[AiConversationService, Depends(get_ai_conversation_service)],
    actor: Annotated[ActorContext, Depends(get_actor_context)],
) -> AiConversationResponse:
    return service.create_conversation(request, actor)


@router.get("/{conversation_id}", response_model=AiConversationResponse)
def get_ai_conversation(
    conversation_id: str,
    service: Annotated[AiConversationService, Depends(get_ai_conversation_service)],
    actor: Annotated[ActorContext, Depends(get_actor_context)],
) -> AiConversationResponse:
    return service.get_conversation(conversation_id, actor)


@router.patch("/{conversation_id}", response_model=AiConversationResponse)
def update_ai_conversation(
    conversation_id: str,
    request: UpdateAiConversationRequest,
    service: Annotated[AiConversationService, Depends(get_ai_conversation_service)],
    actor: Annotated[ActorContext, Depends(get_actor_context)],
) -> AiConversationResponse:
    return service.update_conversation(conversation_id, request, actor)


@router.delete("/{conversation_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_ai_conversation(
    conversation_id: str,
    version: Annotated[int, Query(ge=1)],
    service: Annotated[AiConversationService, Depends(get_ai_conversation_service)],
    actor: Annotated[ActorContext, Depends(get_actor_context)],
) -> Response:
    service.delete_conversation(conversation_id, version, actor)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{conversation_id}/messages", response_model=AiConversationResponse)
def create_ai_conversation_message(
    conversation_id: str,
    request: CreateAiConversationMessageRequest,
    service: Annotated[AiConversationService, Depends(get_ai_conversation_service)],
    actor: Annotated[ActorContext, Depends(get_actor_context)],
) -> AiConversationResponse:
    return service.create_message(conversation_id, request, actor)
