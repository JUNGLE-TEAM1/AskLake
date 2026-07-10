import hmac
from typing import Annotated

from fastapi import APIRouter, Depends, Header, Query, status
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext, get_actor_context
from app.core.config import Settings, get_settings
from app.core.database import get_db
from app.core.errors import ApiError
from app.schemas.common import ErrorCode
from app.schemas.text_structuring import (
    CreateTextStructuringSpecRequest,
    CreateTextStructuringVersionRequest,
    CreateTextTrainingRunRequest,
    TextModelResponse,
    TextReviewItemResponse,
    TextStructuringBatchRequest,
    TextStructuringBatchResponse,
    TextStructuringPreviewRequest,
    TextStructuringPreviewResponse,
    TextStructuringSpecResponse,
    TextStructuringSpecVersionResponse,
    TextStructuringSuggestionRequest,
    TextStructuringSuggestionResponse,
    TextTrainingRunResponse,
    UpdateTextReviewItemRequest,
)
from app.services import text_structuring_service

router = APIRouter(tags=["text-structuring"])


@router.post(
    "/text-structuring/specs",
    response_model=TextStructuringSpecResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_spec(
    request: CreateTextStructuringSpecRequest,
    db: Session = Depends(get_db),
    actor: ActorContext = Depends(get_actor_context),
) -> TextStructuringSpecResponse:
    return text_structuring_service.create_spec(db, request, actor)


@router.get("/text-structuring/specs", response_model=list[TextStructuringSpecResponse])
def list_specs(
    db: Session = Depends(get_db),
    actor: ActorContext = Depends(get_actor_context),
) -> list[TextStructuringSpecResponse]:
    return text_structuring_service.list_specs(db, actor)


@router.get("/text-structuring/specs/{spec_id}", response_model=TextStructuringSpecResponse)
def get_spec(
    spec_id: str,
    db: Session = Depends(get_db),
    actor: ActorContext = Depends(get_actor_context),
) -> TextStructuringSpecResponse:
    return text_structuring_service.get_spec(db, spec_id, actor)


@router.post(
    "/text-structuring/specs/{spec_id}/versions",
    response_model=TextStructuringSpecVersionResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_version(
    spec_id: str,
    request: CreateTextStructuringVersionRequest,
    db: Session = Depends(get_db),
    actor: ActorContext = Depends(get_actor_context),
) -> TextStructuringSpecVersionResponse:
    return text_structuring_service.create_version(db, spec_id, request, actor)


@router.post(
    "/text-structuring/specs/{spec_id}/versions/{version}/publish",
    response_model=TextStructuringSpecVersionResponse,
)
def publish_version(
    spec_id: str,
    version: int,
    db: Session = Depends(get_db),
    actor: ActorContext = Depends(get_actor_context),
) -> TextStructuringSpecVersionResponse:
    return text_structuring_service.publish_version(db, spec_id, version, actor)


@router.post("/text-structuring/suggest", response_model=TextStructuringSuggestionResponse)
def suggest_definition(
    request: TextStructuringSuggestionRequest,
    settings: Settings = Depends(get_settings),
) -> TextStructuringSuggestionResponse:
    return text_structuring_service.suggest_definition(request, settings)


@router.post("/text-structuring/preview", response_model=TextStructuringPreviewResponse)
def preview(
    request: TextStructuringPreviewRequest,
    db: Session = Depends(get_db),
    actor: ActorContext = Depends(get_actor_context),
    settings: Settings = Depends(get_settings),
) -> TextStructuringPreviewResponse:
    return text_structuring_service.preview(db, request, actor, settings)


@router.post("/internal/text-structuring/batch", response_model=TextStructuringBatchResponse)
def run_internal_batch(
    request: TextStructuringBatchRequest,
    internal_token: Annotated[str | None, Header(alias="X-AskLake-Internal-Token")] = None,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> TextStructuringBatchResponse:
    require_internal_token(settings, internal_token)
    return text_structuring_service.run_batch(db, request, settings)


@router.get(
    "/text-structuring/specs/{spec_id}/reviews",
    response_model=list[TextReviewItemResponse],
)
def list_review_items(
    spec_id: str,
    item_status: str | None = Query(default=None, alias="status"),
    limit: int = Query(default=100, ge=1, le=1000),
    db: Session = Depends(get_db),
    actor: ActorContext = Depends(get_actor_context),
) -> list[TextReviewItemResponse]:
    return text_structuring_service.list_review_items(
        db,
        spec_id,
        actor,
        item_status=item_status,
        limit=limit,
    )


@router.put("/text-structuring/reviews/{item_id}", response_model=TextReviewItemResponse)
def update_review_item(
    item_id: str,
    request: UpdateTextReviewItemRequest,
    db: Session = Depends(get_db),
    actor: ActorContext = Depends(get_actor_context),
) -> TextReviewItemResponse:
    return text_structuring_service.update_review_item(db, item_id, request, actor)


@router.post(
    "/text-structuring/training-runs",
    response_model=TextTrainingRunResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_training_run(
    request: CreateTextTrainingRunRequest,
    db: Session = Depends(get_db),
    actor: ActorContext = Depends(get_actor_context),
    settings: Settings = Depends(get_settings),
) -> TextTrainingRunResponse:
    return text_structuring_service.create_training_run(db, request, actor, settings)


@router.get("/text-structuring/specs/{spec_id}/models", response_model=list[TextModelResponse])
def list_models(
    spec_id: str,
    db: Session = Depends(get_db),
    actor: ActorContext = Depends(get_actor_context),
) -> list[TextModelResponse]:
    return text_structuring_service.list_models(db, spec_id, actor)


@router.post("/text-structuring/models/{model_id}/promote", response_model=TextModelResponse)
def promote_model(
    model_id: str,
    db: Session = Depends(get_db),
    actor: ActorContext = Depends(get_actor_context),
) -> TextModelResponse:
    return text_structuring_service.promote_model(db, model_id, actor)


def require_internal_token(settings: Settings, supplied: str | None) -> None:
    expected = settings.text_structuring_internal_token
    if expected and (not supplied or not hmac.compare_digest(expected, supplied)):
        raise ApiError(
            ErrorCode.UNAUTHORIZED,
            "Invalid internal text structuring token.",
            status.HTTP_401_UNAUTHORIZED,
        )
