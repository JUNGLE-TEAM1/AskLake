from uuid import uuid4

from fastapi import status

from app.core.auth_context import ActorContext
from app.core.errors import ApiError
from app.models.ai import AiConversationMessageModel, AiConversationModel
from app.repositories.ai_conversation_repository import AiConversationRepository
from app.schemas.ai import (
    AiConversationListResponse,
    AiConversationMessage,
    AiConversationResponse,
    CreateAiConversationMessageRequest,
    CreateAiConversationRequest,
    UpdateAiConversationRequest,
)
from app.schemas.common import ErrorCode
from app.schemas.sql import QueryAiSuggestionRequest
from app.services.query_ai_service import QueryAiService


class AiConversationService:
    def __init__(
        self,
        repository: AiConversationRepository,
        query_ai_service: QueryAiService,
    ) -> None:
        self.repository = repository
        self.query_ai_service = query_ai_service

    def list_conversations(self, actor: ActorContext) -> AiConversationListResponse:
        models = self.repository.list_conversations(actor_owner_key(actor))
        return AiConversationListResponse(
            items=[self._to_response(model) for model in models],
        )

    def get_conversation(
        self,
        conversation_id: str,
        actor: ActorContext,
    ) -> AiConversationResponse:
        return self._to_response(self._require_owned(conversation_id, actor))

    def create_conversation(
        self,
        request: CreateAiConversationRequest,
        actor: ActorContext,
    ) -> AiConversationResponse:
        selected_dataset_ids = normalize_dataset_ids(request.selected_dataset_ids)
        if selected_dataset_ids:
            self.query_ai_service.resolve_context_datasets(
                selected_dataset_ids,
                actor,
                api_path="/api/ai/conversations",
            )

        model = AiConversationModel(
            id=f"ai_conversation_{uuid4().hex}",
            owner_key=actor_owner_key(actor),
            owner_user_id=actor.id,
            owner_name=actor.name,
            title=normalize_title(request.title),
            selected_dataset_ids=selected_dataset_ids,
            version=1,
        )
        self.repository.add_conversation(model)
        self.repository.db.commit()
        self.repository.db.refresh(model)
        return self._to_response(model)

    def update_conversation(
        self,
        conversation_id: str,
        request: UpdateAiConversationRequest,
        actor: ActorContext,
    ) -> AiConversationResponse:
        model = self._require_owned(conversation_id, actor, for_update=True)
        self._require_version(model, request.version)

        if request.selected_dataset_ids is not None:
            selected_dataset_ids = normalize_dataset_ids(request.selected_dataset_ids)
            if selected_dataset_ids:
                self.query_ai_service.resolve_context_datasets(
                    selected_dataset_ids,
                    actor,
                    api_path=f"/api/ai/conversations/{conversation_id}",
                    http_method="PATCH",
                )
            model.selected_dataset_ids = selected_dataset_ids
        if request.title is not None:
            model.title = normalize_title(request.title)

        model.version += 1
        self.repository.db.commit()
        self.repository.db.refresh(model)
        return self._to_response(model)

    def delete_conversation(
        self,
        conversation_id: str,
        version: int,
        actor: ActorContext,
    ) -> None:
        model = self._require_owned(conversation_id, actor, for_update=True)
        self._require_version(model, version)
        self.repository.delete_conversation(model)
        self.repository.db.commit()

    def create_message(
        self,
        conversation_id: str,
        request: CreateAiConversationMessageRequest,
        actor: ActorContext,
    ) -> AiConversationResponse:
        content = request.content.strip()
        if not content:
            raise ApiError(
                ErrorCode.VALIDATION_ERROR,
                "Message content is required",
                status.HTTP_422_UNPROCESSABLE_ENTITY,
            )

        model = self._require_owned(conversation_id, actor)
        idempotent_response = self._idempotent_message_response(
            model,
            request.client_request_id,
            content,
        )
        if idempotent_response is not None:
            return idempotent_response
        self._require_version(model, request.version)

        selected_dataset_ids = normalize_dataset_ids(model.selected_dataset_ids)
        if not selected_dataset_ids:
            raise ApiError(
                ErrorCode.VALIDATION_ERROR,
                "At least one selected dataset is required",
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                {"conversationId": conversation_id},
            )

        api_path = f"/api/ai/conversations/{conversation_id}/messages"
        resolved_datasets = self.query_ai_service.resolve_context_datasets(
            selected_dataset_ids,
            actor,
            api_path=api_path,
        )
        suggestion = self.query_ai_service.create_suggestion(
            QueryAiSuggestionRequest(
                base_dataset_id=selected_dataset_ids[0],
                prompt=content,
                selected_dataset_ids=selected_dataset_ids,
            ),
            actor,
            api_path=api_path,
            resolved_datasets=resolved_datasets,
        )

        model = self._require_owned(conversation_id, actor, for_update=True)
        idempotent_response = self._idempotent_message_response(
            model,
            request.client_request_id,
            content,
        )
        if idempotent_response is not None:
            return idempotent_response
        self._require_version(model, request.version)

        context_names = [dataset.name for dataset in resolved_datasets]
        next_position = self.repository.next_message_position(conversation_id)
        user_message = AiConversationMessageModel(
            id=f"ai_message_{uuid4().hex}",
            conversation_id=conversation_id,
            role="user",
            content=content,
            context_names=context_names,
            notices=[],
            sql=None,
            position=next_position,
            client_request_id=request.client_request_id,
            metadata_={},
        )
        assistant_message = AiConversationMessageModel(
            id=f"ai_message_{uuid4().hex}",
            conversation_id=conversation_id,
            role="assistant",
            content=suggestion.body,
            context_names=context_names,
            notices=suggestion.notices,
            sql=suggestion.sql,
            position=next_position + 1,
            client_request_id=None,
            metadata_={"model": suggestion.model} if suggestion.model else {},
        )
        if next_position == 0 and model.title == "새 대화":
            model.title = title_from_question(content)
        model.version += 1
        self.repository.add_messages(user_message, assistant_message)
        self.repository.db.commit()
        self.repository.db.refresh(model)
        return self._to_response(model)

    def _require_owned(
        self,
        conversation_id: str,
        actor: ActorContext,
        *,
        for_update: bool = False,
    ) -> AiConversationModel:
        model = (
            self.repository.get_conversation_for_update(conversation_id)
            if for_update
            else self.repository.get_conversation(conversation_id)
        )
        if model is None or model.owner_key != actor_owner_key(actor):
            raise ApiError(
                ErrorCode.NOT_FOUND,
                "AI conversation not found",
                status.HTTP_404_NOT_FOUND,
                {"conversationId": conversation_id},
            )
        return model

    def _require_version(self, model: AiConversationModel, requested_version: int) -> None:
        if model.version == requested_version:
            return
        raise ApiError(
            ErrorCode.CONFLICT,
            "AI conversation was changed by another request",
            status.HTTP_409_CONFLICT,
            {
                "conversationId": model.id,
                "currentVersion": model.version,
                "requestedVersion": requested_version,
            },
        )

    def _idempotent_message_response(
        self,
        model: AiConversationModel,
        client_request_id: str,
        content: str,
    ) -> AiConversationResponse | None:
        existing = self.repository.get_message_by_client_request(
            model.id,
            client_request_id,
        )
        if existing is None:
            return None
        if existing.content == content:
            return self._to_response(model)
        raise ApiError(
            ErrorCode.CONFLICT,
            "clientRequestId was already used for another message",
            status.HTTP_409_CONFLICT,
            {
                "clientRequestId": client_request_id,
                "conversationId": model.id,
            },
        )

    def _to_response(self, model: AiConversationModel) -> AiConversationResponse:
        messages = self.repository.list_messages(model.id)
        return AiConversationResponse(
            id=model.id,
            title=model.title,
            selected_dataset_ids=list(model.selected_dataset_ids or []),
            messages=[
                AiConversationMessage(
                    id=message.id,
                    role=message.role,
                    content=message.content,
                    context_names=list(message.context_names or []),
                    notices=list(message.notices or []),
                    sql=message.sql,
                    created_at=message.created_at,
                )
                for message in messages
            ],
            version=model.version,
            created_at=model.created_at,
            updated_at=model.updated_at,
        )


def actor_owner_key(actor: ActorContext) -> str:
    if actor.id:
        return f"user:{actor.id}"
    if actor.email:
        return f"email:{actor.email.strip().casefold()}"
    return f"name:{actor.name.strip().casefold()}"


def normalize_dataset_ids(dataset_ids: list[str]) -> list[str]:
    normalized: list[str] = []
    seen: set[str] = set()
    for dataset_id in dataset_ids:
        value = str(dataset_id).strip()
        if not value:
            raise ApiError(
                ErrorCode.VALIDATION_ERROR,
                "selectedDatasetIds cannot contain an empty value",
                status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        if value in seen:
            continue
        seen.add(value)
        normalized.append(value)
    return normalized


def normalize_title(title: str) -> str:
    normalized = " ".join(title.split())
    if not normalized:
        raise ApiError(
            ErrorCode.VALIDATION_ERROR,
            "Conversation title is required",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    return normalized


def title_from_question(question: str) -> str:
    normalized = " ".join(question.split())
    return f"{normalized[:30]}..." if len(normalized) > 30 else normalized
