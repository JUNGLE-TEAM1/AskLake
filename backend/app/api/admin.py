from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext, get_actor_context
from app.core.database import get_db
from app.domain.audit import AuditTargetType
from app.schemas.identity import (
    AdminAuditLogsResponse,
    AdminGovernanceControlsResponse,
    AdminGroupsResponse,
    AdminPermissionGrantRequest,
    AdminPermissionGrantUpdateRequest,
    AdminPermissionsResponse,
    AdminPrincipalControlRequest,
    AdminResourceLockRequest,
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


@router.post("/permissions", response_model=AdminPermissionsResponse, status_code=201)
def create_admin_permission_grant(
    request: AdminPermissionGrantRequest,
    service: Annotated[IdentityService, Depends(get_identity_service)],
    actor: Annotated[ActorContext, Depends(get_actor_context)],
) -> AdminPermissionsResponse:
    return service.create_admin_permission_grant(actor, request)


@router.patch("/permissions/{grant_id}", response_model=AdminPermissionsResponse)
def update_admin_permission_grant(
    grant_id: str,
    request: AdminPermissionGrantUpdateRequest,
    service: Annotated[IdentityService, Depends(get_identity_service)],
    actor: Annotated[ActorContext, Depends(get_actor_context)],
) -> AdminPermissionsResponse:
    return service.update_admin_permission_grant(actor, grant_id, request)


@router.delete("/permissions/{grant_id}", response_model=AdminPermissionsResponse)
def delete_admin_permission_grant(
    grant_id: str,
    service: Annotated[IdentityService, Depends(get_identity_service)],
    actor: Annotated[ActorContext, Depends(get_actor_context)],
) -> AdminPermissionsResponse:
    return service.delete_admin_permission_grant(actor, grant_id)


@router.get("/governance-controls", response_model=AdminGovernanceControlsResponse)
def list_admin_governance_controls(
    service: Annotated[IdentityService, Depends(get_identity_service)],
    actor: Annotated[ActorContext, Depends(get_actor_context)],
) -> AdminGovernanceControlsResponse:
    return service.list_admin_governance_controls(actor)


@router.patch("/governance/principals", response_model=AdminGovernanceControlsResponse)
def update_admin_principal_control(
    request: AdminPrincipalControlRequest,
    service: Annotated[IdentityService, Depends(get_identity_service)],
    actor: Annotated[ActorContext, Depends(get_actor_context)],
) -> AdminGovernanceControlsResponse:
    return service.update_admin_principal_control(actor, request)


@router.patch("/governance/resource-locks", response_model=AdminGovernanceControlsResponse)
def update_admin_resource_lock(
    request: AdminResourceLockRequest,
    service: Annotated[IdentityService, Depends(get_identity_service)],
    actor: Annotated[ActorContext, Depends(get_actor_context)],
) -> AdminGovernanceControlsResponse:
    return service.update_admin_resource_lock(actor, request)


@router.get("/audit-logs", response_model=AdminAuditLogsResponse)
def list_admin_audit_logs(
    service: Annotated[IdentityService, Depends(get_identity_service)],
    actor: Annotated[ActorContext, Depends(get_actor_context)],
    actor_id: Annotated[str | None, Query(alias="actorId")] = None,
    from_at: Annotated[datetime | None, Query(alias="from")] = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
    q: Annotated[str | None, Query()] = None,
    resource_type: Annotated[AuditTargetType | None, Query(alias="resourceType")] = None,
    result: Annotated[str | None, Query()] = None,
    to_at: Annotated[datetime | None, Query(alias="to")] = None,
) -> AdminAuditLogsResponse:
    return service.list_admin_audit_logs(
        actor,
        actor_id=actor_id,
        from_at=from_at,
        limit=limit,
        query=q,
        resource_type=resource_type,
        result=result,
        to_at=to_at,
    )
