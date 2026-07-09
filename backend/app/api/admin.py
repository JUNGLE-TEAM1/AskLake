from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext, get_actor_context
from app.core.database import get_db
from app.schemas.identity import (
    AdminAuditLogsResponse,
    AdminGroupsResponse,
    AdminPermissionsResponse,
    AdminUsersResponse,
)
from app.services.identity_service import IdentityService

router = APIRouter(prefix="/admin", tags=["admin"])


def get_identity_service(db: Annotated[Session, Depends(get_db)]) -> IdentityService:
    return IdentityService(db)


@router.get("/users", response_model=AdminUsersResponse)
def list_admin_users(
    service: Annotated[IdentityService, Depends(get_identity_service)],
    actor: Annotated[ActorContext, Depends(get_actor_context)],
) -> AdminUsersResponse:
    return service.list_admin_users(actor)


@router.get("/groups", response_model=AdminGroupsResponse)
def list_admin_groups(
    service: Annotated[IdentityService, Depends(get_identity_service)],
    actor: Annotated[ActorContext, Depends(get_actor_context)],
) -> AdminGroupsResponse:
    return service.list_admin_groups(actor)


@router.get("/permissions", response_model=AdminPermissionsResponse)
def list_admin_permissions(
    service: Annotated[IdentityService, Depends(get_identity_service)],
    actor: Annotated[ActorContext, Depends(get_actor_context)],
) -> AdminPermissionsResponse:
    return service.list_admin_permissions(actor)


@router.get("/audit-logs", response_model=AdminAuditLogsResponse)
def list_admin_audit_logs(
    service: Annotated[IdentityService, Depends(get_identity_service)],
    actor: Annotated[ActorContext, Depends(get_actor_context)],
) -> AdminAuditLogsResponse:
    return service.list_admin_audit_logs(actor)
