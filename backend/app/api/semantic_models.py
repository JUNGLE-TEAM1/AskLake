from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext, get_actor_context
from app.core.database import get_db
from app.repositories.permission_repository import replace_permission_ui_grants
from app.schemas.permissions import PermissionGrant
from app.schemas.semantic import (
    SemanticDimensionInput,
    SemanticModelCreate,
    SemanticModelPatch,
    SemanticModelResponse,
    SemanticPublishResponse,
    SemanticRelationshipInput,
    SemanticValidationResponse,
    SemanticMetricInput,
    SemanticVocabularyInput,
)
from app.services.semantic_model_service import SemanticModelService

router = APIRouter(prefix="/semantic-models", tags=["semantic-models"])


@router.get("", response_model=list[SemanticModelResponse])
def list_semantic_models(db: Session = Depends(get_db), actor: ActorContext = Depends(get_actor_context)) -> list[SemanticModelResponse]:
    return SemanticModelService(db).list_models(actor)


@router.post("", response_model=SemanticModelResponse, status_code=201)
def create_semantic_model(request: SemanticModelCreate, db: Session = Depends(get_db), actor: ActorContext = Depends(get_actor_context)) -> SemanticModelResponse:
    return SemanticModelService(db).create(request, actor)


@router.get("/{model_id}", response_model=SemanticModelResponse)
def get_semantic_model(model_id: str, db: Session = Depends(get_db), actor: ActorContext = Depends(get_actor_context)) -> SemanticModelResponse:
    return SemanticModelService(db).get(model_id, actor)


@router.patch("/{model_id}", response_model=SemanticModelResponse)
def update_semantic_model(model_id: str, request: SemanticModelPatch, db: Session = Depends(get_db), actor: ActorContext = Depends(get_actor_context)) -> SemanticModelResponse:
    return SemanticModelService(db).update(model_id, request, actor)


@router.put("/{model_id}/datasets", response_model=SemanticModelResponse)
def replace_semantic_datasets(model_id: str, request: list[Any], db: Session = Depends(get_db), actor: ActorContext = Depends(get_actor_context)) -> SemanticModelResponse:
    items = [item if isinstance(item, dict) else {} for item in request]
    parsed = SemanticModelCreate.model_validate({"name": "snapshot", "datasets": items})
    return SemanticModelService(db).replace_collection(model_id, "datasets", parsed.datasets, actor)


@router.put("/{model_id}/metrics", response_model=SemanticModelResponse)
def replace_semantic_metrics(model_id: str, request: list[SemanticMetricInput], db: Session = Depends(get_db), actor: ActorContext = Depends(get_actor_context)) -> SemanticModelResponse:
    return SemanticModelService(db).replace_collection(model_id, "metrics", request, actor)


@router.put("/{model_id}/dimensions", response_model=SemanticModelResponse)
def replace_semantic_dimensions(model_id: str, request: list[SemanticDimensionInput], db: Session = Depends(get_db), actor: ActorContext = Depends(get_actor_context)) -> SemanticModelResponse:
    return SemanticModelService(db).replace_collection(model_id, "dimensions", request, actor)


@router.put("/{model_id}/relationships", response_model=SemanticModelResponse)
def replace_semantic_relationships(model_id: str, request: list[SemanticRelationshipInput], db: Session = Depends(get_db), actor: ActorContext = Depends(get_actor_context)) -> SemanticModelResponse:
    return SemanticModelService(db).replace_collection(model_id, "relationships", request, actor)


@router.put("/{model_id}/vocabulary", response_model=SemanticModelResponse)
def replace_semantic_vocabulary(model_id: str, request: list[SemanticVocabularyInput], db: Session = Depends(get_db), actor: ActorContext = Depends(get_actor_context)) -> SemanticModelResponse:
    return SemanticModelService(db).replace_collection(model_id, "vocabulary", request, actor)


@router.put("/{model_id}/permissions", response_model=SemanticModelResponse)
def replace_semantic_permissions(model_id: str, request: list[PermissionGrant], db: Session = Depends(get_db), actor: ActorContext = Depends(get_actor_context)) -> SemanticModelResponse:
    service = SemanticModelService(db)
    model = service._model(model_id)
    service._require(model, actor, "manage")
    model.grants = [grant.model_dump(by_alias=True) for grant in request]
    replace_permission_ui_grants(db, resource_type="semantic_model", resource_id=model_id, grants=request, created_by=actor.name)
    db.commit()
    return service.get(model_id, actor, enforce=False)


@router.post("/{model_id}/validate", response_model=SemanticValidationResponse)
def validate_semantic_model(model_id: str, db: Session = Depends(get_db), actor: ActorContext = Depends(get_actor_context)) -> SemanticValidationResponse:
    return SemanticModelService(db).validate(model_id, actor)


@router.post("/{model_id}/publish", response_model=SemanticPublishResponse)
def publish_semantic_model(model_id: str, db: Session = Depends(get_db), actor: ActorContext = Depends(get_actor_context)) -> SemanticPublishResponse:
    return SemanticModelService(db).publish(model_id, actor)


@router.get("/{model_id}/versions", response_model=list[dict[str, Any]])
def list_semantic_model_versions(model_id: str, db: Session = Depends(get_db), actor: ActorContext = Depends(get_actor_context)) -> list[dict[str, Any]]:
    return SemanticModelService(db).versions(model_id, actor)


@router.post("/{model_id}/rollback", response_model=SemanticModelResponse)
def rollback_semantic_model(model_id: str, version: int, db: Session = Depends(get_db), actor: ActorContext = Depends(get_actor_context)) -> SemanticModelResponse:
    return SemanticModelService(db).rollback(model_id, version, actor)
