from datetime import datetime, timezone
from typing import Any

from fastapi import status
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext, permissions_for_actor
from app.core.errors import ApiError
from app.repositories.catalog_repository import CatalogRepository, dataset_model_to_payload
from app.repositories.dashboard_card_repository import list_dashboard_cards
from app.repositories.etl_repository import list_jobs
from app.schemas.common import ErrorCode
from app.schemas.identity import (
    AdminAuditLogEntry,
    AdminAuditLogsResponse,
    AdminGroupsResponse,
    AdminPermissionSummary,
    AdminPermissionsResponse,
    AdminUser,
    AdminUsersResponse,
    CurrentUserResponse,
    IdentityGroup,
    IdentityProfile,
    PermissionSummary,
)
from app.schemas.permissions import PermissionGrant

DEMO_GROUPS = {
    "data-platform": IdentityGroup(
        id="data-platform",
        name="Data Platform Team",
        description="Lake platform administrators",
        member_count=2,
    ),
    "analytics": IdentityGroup(
        id="analytics",
        name="Analytics Team",
        description="SQL and dashboard analysts",
        member_count=3,
    ),
    "ops": IdentityGroup(
        id="ops",
        name="Operations Team",
        description="ETL job operators",
        member_count=2,
    ),
}

DEMO_USERS = {
    "Admin User": {
        "id": "admin-user",
        "display_name": "Admin User",
        "email": "admin.user@asklake.local",
        "role": "admin",
        "groups": ["data-platform", "analytics", "ops"],
        "title": "Platform Admin",
        "last_active_at": "2026-07-09T06:30:00.000Z",
    },
    "demo-user": {
        "id": "demo-user",
        "display_name": "Demo User",
        "email": "demo.user@asklake.local",
        "role": "viewer",
        "groups": ["analytics"],
        "title": "Data Viewer",
        "last_active_at": "2026-07-09T05:45:00.000Z",
    },
}


class IdentityService:
    def __init__(self, db: Session) -> None:
        self.db = db

    def get_current_user(self, actor: ActorContext) -> CurrentUserResponse:
        summary = self._permission_summary(actor)
        return self._current_user_response(actor, summary)

    def list_admin_users(self, actor: ActorContext) -> AdminUsersResponse:
        self._require_admin(actor)
        users = [
            self._admin_user_response(user_name)
            for user_name in sorted(DEMO_USERS)
        ]
        return AdminUsersResponse(users=users)

    def list_admin_groups(self, actor: ActorContext) -> AdminGroupsResponse:
        self._require_admin(actor)
        return AdminGroupsResponse(groups=list(DEMO_GROUPS.values()))

    def list_admin_permissions(self, actor: ActorContext) -> AdminPermissionsResponse:
        self._require_admin(actor)
        resources: list[AdminPermissionSummary] = []
        resources.extend(self._dataset_permission_summaries(actor))
        resources.extend(self._job_permission_summaries(actor))
        resources.extend(self._dashboard_permission_summaries(actor))
        return AdminPermissionsResponse(resources=resources)

    def list_admin_audit_logs(self, actor: ActorContext) -> AdminAuditLogsResponse:
        self._require_admin(actor)
        now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        return AdminAuditLogsResponse(
            logs=[
                AdminAuditLogEntry(
                    action="admin.console.opened",
                    actor_id=actor.name,
                    api_path="/api/admin/audit-logs",
                    created_at=now,
                    request_id="req_demo_admin_audit_001",
                    result="success",
                    target_id="admin-console",
                    target_type="admin_module",
                ),
                AdminAuditLogEntry(
                    action="identity.profile.opened",
                    actor_id=actor.name,
                    api_path="/api/users/me",
                    created_at=now,
                    request_id="req_demo_identity_001",
                    result="success",
                    target_id=actor.name,
                    target_type="ui",
                ),
            ]
        )

    def _require_admin(self, actor: ActorContext) -> None:
        if actor.is_admin:
            return
        raise ApiError(
            ErrorCode.FORBIDDEN,
            "Admin role is required to access this endpoint",
            status.HTTP_403_FORBIDDEN,
        )

    def _current_user_response(self, actor: ActorContext, summary: PermissionSummary) -> CurrentUserResponse:
        user = self._user_record(actor.name, actor.role, actor.groups)
        if actor.id:
            user["id"] = actor.id
        if actor.email:
            user["email"] = actor.email
        if actor.title:
            user["title"] = actor.title
        groups = self._groups_for_user(user["groups"])
        profile = self._profile_for_user(user)
        return CurrentUserResponse(
            id=str(user["id"]),
            display_name=str(user["display_name"]),
            email=str(user["email"]),
            role=str(user["role"]),
            groups=groups,
            profile=profile,
            permissions_summary=summary,
        )

    def _admin_user_response(self, user_name: str) -> AdminUser:
        user = self._user_record(user_name)
        user_actor = ActorContext(
            name=user_name,
            role=str(user["role"]),
            groups=tuple(str(group_id) for group_id in user["groups"]),
        )
        current = CurrentUserResponse(
            id=str(user["id"]),
            display_name=str(user["display_name"]),
            email=str(user["email"]),
            role=str(user["role"]),
            groups=self._groups_for_user(user["groups"]),
            profile=self._profile_for_user(user),
            permissions_summary=self._permission_summary(user_actor),
        )
        return AdminUser(
            **current.model_dump(),
            status="active",
            last_active_at=str(user.get("last_active_at") or ""),
        )

    def _user_record(
        self,
        actor_name: str,
        role: str | None = None,
        groups: tuple[str, ...] | None = None,
    ) -> dict[str, Any]:
        user = DEMO_USERS.get(actor_name)
        if user:
            return dict(user)
        display_name = actor_name.strip() or "Demo User"
        group_ids = list(groups or ())
        return {
            "id": slugify(display_name),
            "display_name": display_name,
            "email": f"{slugify(display_name)}@asklake.local",
            "role": role or "viewer",
            "groups": group_ids,
            "title": "AskLake User",
            "last_active_at": None,
        }

    def _groups_for_user(self, group_ids: list[str]) -> list[IdentityGroup]:
        return [
            DEMO_GROUPS.get(group_id) or IdentityGroup(id=group_id, name=group_id)
            for group_id in group_ids
        ]

    def _profile_for_user(self, user: dict[str, Any]) -> IdentityProfile:
        display_name = str(user["display_name"])
        return IdentityProfile(
            display_name=display_name,
            avatar_initials=initials(display_name),
            email=str(user["email"]),
            title=str(user.get("title") or "AskLake User"),
        )

    def _permission_summary(self, actor: ActorContext) -> PermissionSummary:
        summary = PermissionSummary()
        for resource in self._permission_resources(actor):
            permissions = resource.current_actor_permissions
            if permissions is None:
                continue
            summary.can_view += int(permissions.can_view)
            summary.can_query += int(permissions.can_query)
            summary.can_run += int(permissions.can_run)
            summary.can_manage += int(permissions.can_manage)
            summary.can_delete += int(permissions.can_delete)
            summary.can_share += int(permissions.can_share)
        return summary

    def _permission_resources(self, actor: ActorContext) -> list[AdminPermissionSummary]:
        resources: list[AdminPermissionSummary] = []
        resources.extend(self._dataset_permission_summaries(actor))
        resources.extend(self._job_permission_summaries(actor))
        resources.extend(self._dashboard_permission_summaries(actor))
        return resources

    def _dataset_permission_summaries(self, actor: ActorContext) -> list[AdminPermissionSummary]:
        repository = CatalogRepository(self.db)
        summaries = []
        for model in repository.list_dataset_models():
            payload = dataset_model_to_payload(model)
            owner = str(payload.get("owner") or "")
            grants = parse_grants(payload.get("permissionGrants"))
            summaries.append(
                AdminPermissionSummary(
                    resource_type="dataset",
                    resource_id=str(payload.get("id") or model.id),
                    resource_name=str(payload.get("name") or model.id),
                    owner=owner,
                    created_by=string_or_none(payload.get("createdBy")),
                    grants=grants,
                    current_actor_permissions=permissions_for_actor(
                        actor,
                        owner=owner,
                        grants=[grant.model_dump(by_alias=True) for grant in grants],
                        enforced=True,
                    ),
                )
            )
        return summaries

    def _job_permission_summaries(self, actor: ActorContext) -> list[AdminPermissionSummary]:
        summaries = []
        for job in list_jobs(self.db):
            grants = parse_grants(job.permission_grants)
            summaries.append(
                AdminPermissionSummary(
                    resource_type="etl_job",
                    resource_id=job.id,
                    resource_name=job.name,
                    owner=job.owner,
                    created_by=job.created_by,
                    grants=grants,
                    current_actor_permissions=permissions_for_actor(
                        actor,
                        owner=job.owner,
                        grants=[grant.model_dump(by_alias=True) for grant in grants],
                        enforced=True,
                    ),
                )
            )
        return summaries

    def _dashboard_permission_summaries(self, actor: ActorContext) -> list[AdminPermissionSummary]:
        summaries = []
        for dashboard in list_dashboard_cards(self.db):
            grants = parse_grants(dashboard.permission_grants)
            summaries.append(
                AdminPermissionSummary(
                    resource_type="dashboard",
                    resource_id=dashboard.id,
                    resource_name=dashboard.name,
                    owner=dashboard.owner,
                    created_by=dashboard.created_by,
                    grants=grants,
                    current_actor_permissions=permissions_for_actor(
                        actor,
                        owner=dashboard.owner,
                        grants=[grant.model_dump(by_alias=True) for grant in grants],
                        enforced=True,
                    ),
                )
            )
        return summaries


def parse_grants(value: Any) -> list[PermissionGrant]:
    grants = value or []
    parsed: list[PermissionGrant] = []
    for grant in grants if isinstance(grants, list) else []:
        if isinstance(grant, PermissionGrant):
            parsed.append(grant)
            continue
        if isinstance(grant, dict):
            parsed.append(PermissionGrant.model_validate(grant))
    return parsed


def string_or_none(value: Any) -> str | None:
    return str(value) if value is not None else None


def slugify(value: str) -> str:
    normalized = "".join(character.lower() if character.isalnum() else "-" for character in value)
    return "-".join(part for part in normalized.split("-") if part) or "demo-user"


def initials(value: str) -> str:
    words = [word for word in value.replace("_", " ").replace("-", " ").split() if word]
    if not words:
        return "DU"
    return "".join(word[0].upper() for word in words[:2])
