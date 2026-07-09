from typing import Literal

from pydantic import Field

from app.schemas.common import CamelModel
from app.schemas.permissions import PermissionGrant, ResourcePermissions

AdminUserStatus = Literal["active", "invited", "disabled"]
AdminResourceType = Literal["dataset", "etl_job", "dashboard"]


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


class AdminAuditLogEntry(CamelModel):
    action: str
    actor_id: str
    api_path: str
    created_at: str
    request_id: str
    result: Literal["success", "failed"]
    target_id: str
    target_type: Literal["etl_job", "dataset", "dashboard", "ai_module", "admin_module", "ui"]


class AdminAuditLogsResponse(CamelModel):
    logs: list[AdminAuditLogEntry] = Field(default_factory=list)
