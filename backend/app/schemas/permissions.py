from typing import Literal

from pydantic import Field

from app.schemas.common import CamelModel

PermissionAction = Literal["view", "query", "run", "manage", "delete", "share", "publish"]
PermissionPrincipalType = Literal["user", "group", "role", "public"]


class PermissionGrant(CamelModel):
    id: str | None = None
    actions: list[PermissionAction] = Field(default_factory=list)
    principal_id: str
    principal_name: str | None = None
    principal_type: PermissionPrincipalType
    source: str = "metadata"


class ResourcePermissions(CamelModel):
    can_view: bool = True
    can_query: bool = False
    can_run: bool = False
    can_manage: bool = False
    can_delete: bool = False
    can_share: bool = False
    can_publish: bool = False
    computed_for: str = "system"
    enforced: bool = False
