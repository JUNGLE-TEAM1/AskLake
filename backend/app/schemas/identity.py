from typing import Any, Literal

from pydantic import Field

from app.domain.audit import AuditTargetType
from app.schemas.common import CamelModel
from app.schemas.permissions import PermissionAction, PermissionGrant, PermissionPrincipalType, ResourcePermissions

AdminUserStatus = Literal["active", "invited", "disabled"]
AdminResourceType = Literal["dataset", "etl_job", "dashboard"]
AdminPrincipalControlType = Literal["user", "group"]
AdminPrincipalStatus = Literal["active", "blocked"]


class IdentityProfile(CamelModel):
    display_name: str
    avatar_initials: str | None = None
    email: str | None = None
    title: str | None = None


class IdentityGroup(CamelModel):
    id: str
    name: str
    description: str | None = None
    member_count: int | None = None


class PermissionSummary(CamelModel):
    can_view: int = 0
    can_query: int = 0
    can_run: int = 0
    can_manage: int = 0
    can_delete: int = 0
    can_share: int = 0


class CurrentUserResponse(CamelModel):
    id: str
    display_name: str
    email: str
    role: str
    groups: list[IdentityGroup] = Field(default_factory=list)
    profile: IdentityProfile
    permissions_summary: PermissionSummary = Field(default_factory=PermissionSummary)


class AdminUser(CurrentUserResponse):
    status: AdminUserStatus = "active"
    last_active_at: str | None = None


class AdminUsersResponse(CamelModel):
    users: list[AdminUser] = Field(default_factory=list)


class AdminGroupsResponse(CamelModel):
    groups: list[IdentityGroup] = Field(default_factory=list)


class AdminPermissionSummary(CamelModel):
    resource_type: AdminResourceType
    resource_id: str
    resource_name: str
    owner: str | None = None
    created_by: str | None = None
    grants: list[PermissionGrant] = Field(default_factory=list)
    current_actor_permissions: ResourcePermissions | None = None


class AdminPermissionsResponse(CamelModel):
    resources: list[AdminPermissionSummary] = Field(default_factory=list)


class AdminPermissionGrantRequest(CamelModel):
    resource_type: AdminResourceType
    resource_id: str
    principal_type: PermissionPrincipalType
    principal_id: str
    actions: list[PermissionAction] = Field(default_factory=list)


class AdminPermissionGrantUpdateRequest(CamelModel):
    principal_type: PermissionPrincipalType | None = None
    principal_id: str | None = None
    actions: list[PermissionAction] | None = None


class AdminAuditLogEntry(CamelModel):
    action: str
    actor_id: str
    api_path: str
    created_at: str
    request_id: str
    result: Literal["success", "failed", "forbidden"]
    target_id: str
    target_type: AuditTargetType
    actor_name: str | None = None
    actor_role: str | None = None
    actor_groups: list[str] = Field(default_factory=list)
    http_method: str | None = None
    ip_address: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    status_code: int | None = None
    target_name: str | None = None


class AdminAuditLogsResponse(CamelModel):
    logs: list[AdminAuditLogEntry] = Field(default_factory=list)


class AdminPrincipalControl(CamelModel):
    id: str
    principal_type: AdminPrincipalControlType
    principal_id: str
    status: AdminPrincipalStatus
    reason: str | None = None
    updated_by: str | None = None
    updated_at: str | None = None


class AdminResourceLock(CamelModel):
    id: str
    resource_type: AdminResourceType
    resource_id: str
    locked: bool = False
    reason: str | None = None
    updated_by: str | None = None
    updated_at: str | None = None


class AdminGovernanceControlsResponse(CamelModel):
    principal_controls: list[AdminPrincipalControl] = Field(default_factory=list)
    resource_locks: list[AdminResourceLock] = Field(default_factory=list)


class AdminPrincipalControlRequest(CamelModel):
    principal_type: AdminPrincipalControlType
    principal_id: str
    status: AdminPrincipalStatus
    reason: str | None = None


class AdminResourceLockRequest(CamelModel):
    resource_type: AdminResourceType
    resource_id: str
    locked: bool
    reason: str | None = None
