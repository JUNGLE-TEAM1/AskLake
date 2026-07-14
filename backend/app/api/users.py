from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext, get_actor_context
from app.core.database import get_db
from app.schemas.identity import CurrentUserResponse
from app.services.identity_service import IdentityService

router = APIRouter(prefix="/users", tags=["identity"])


def get_identity_service(db: Annotated[Session, Depends(get_db)]) -> IdentityService:
    return IdentityService(db)


@router.get("/me", response_model=CurrentUserResponse)
def get_current_user(
    service: Annotated[IdentityService, Depends(get_identity_service)],
    actor: Annotated[ActorContext, Depends(get_actor_context)],
) -> CurrentUserResponse:
    return service.get_current_user(actor)
