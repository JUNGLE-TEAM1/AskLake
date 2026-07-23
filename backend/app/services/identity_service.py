from datetime import datetime
from typing import Any

from fastapi import status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext
from app.core.config import settings
from app.core.errors import ApiError
from app.core.permission_metadata import dedupe_grants
from app.domain.audit import AuditTargetType
from app.models.identity import AuthUserModel
from app.repositories.audit_repository import list_audit_events, record_audit_event
from app.repositories.catalog_repository import CatalogRepository, dataset_model_to_payload
from app.repositories.dashboard_card_repository import list_dashboard_cards
from app.repositories.etl_repository import list_jobs
from app.repositories.governance_repository import (
    list_principal_controls,
    list_resource_locks,
    set_principal_control,
    set_resource_lock,
)
from app.repositories.permission_repository import (
    create_permission_grant,
    delete_permission_grant,
    list_permission_grants_by_resource,
    ensure_demo_permission_grants,
    update_permission_grant,
)
from app.services.resource_permission_service import permissions_for_actor_with_governance
from app.services.auth_service import AuthService
from app.schemas.common import ErrorCode
from app.schemas.identity import (
    AdminAuditLogsResponse,
    AdminGovernanceControlsResponse,
    AdminGroupsResponse,
    AdminPermissionGrantRequest,
    AdminPermissionGrantUpdateRequest,
    AdminPermissionSummary,
    AdminPermissionsResponse,
    AdminPrincipalControl,
    AdminPrincipalControlRequest,
    AdminResourceLock,
    AdminResourceLockRequest,
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
        member_count=0,
    ),
    "analytics": IdentityGroup(
        id="analytics",
        name="Analytics Team",
        description="SQL and dashboard analysts",
        member_count=1,
    ),
    "ops": IdentityGroup(
        id="ops",
        name="Operations Team",
        description="ETL job operators",
        member_count=0,
    ),
}

DEMO_USERS = {
    "Admin User": {
        "id": "admin-user",
        "display_name": "Admin User",
        "email": "admin.user@asklake.local",
        "role": "admin",
        "groups": [],
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
        AuthService(self.db)
        users = [
            self._admin_user_response(user)
            for user in self.db.scalars(
                select(AuthUserModel).order_by(AuthUserModel.display_name.asc(), AuthUserModel.id.asc())
            )
        ]
        return AdminUsersResponse(users=users)

    def list_admin_groups(self, actor: ActorContext) -> AdminGroupsResponse:
        self._require_admin(actor)
        AuthService(self.db)
        member_counts: dict[str, int] = {}
        for user in self.db.scalars(select(AuthUserModel)):
            for group_id in set(user.groups or []):
                member_counts[group_id] = member_counts.get(group_id, 0) + 1
        group_ids = set(member_counts)
        if settings.allows_header_auth_fallback:
            group_ids.update(DEMO_GROUPS)
        return AdminGroupsResponse(groups=[
            IdentityGroup(
                id=group_id,
                name=DEMO_GROUPS[group_id].name if group_id in DEMO_GROUPS else group_id,
                description=DEMO_GROUPS[group_id].description if group_id in DEMO_GROUPS else None,
                member_count=member_counts.get(group_id, 0),
            )
            for group_id in sorted(group_ids)
        ])

    def list_admin_permissions(self, actor: ActorContext) -> AdminPermissionsResponse:
        self._require_admin(actor)
        resources: list[AdminPermissionSummary] = []
        resources.extend(self._dataset_permission_summaries(actor))
        resources.extend(self._job_permission_summaries(actor))
        resources.extend(self._dashboard_permission_summaries(actor))
        return AdminPermissionsResponse(resources=resources)

    def create_admin_permission_grant(
        self,
        actor: ActorContext,
        request: AdminPermissionGrantRequest,
    ) -> AdminPermissionsResponse:
        self._require_admin(actor)
        self._require_resource_exists(request.resource_type, request.resource_id)
        grant = create_permission_grant(
            self.db,
            resource_type=request.resource_type,
            resource_id=request.resource_id,
            principal_type=request.principal_type,
            principal_id=request.principal_id,
            actions=list(request.actions),
            created_by=actor.name,
        )
        self._record_audit_event(
            self.db,
            action="admin.permission_grant.created",
            actor=actor,
            api_path="/api/admin/permissions",
            http_method="POST",
            metadata={
                "actions": list(request.actions),
                "grantId": grant.id,
                "principalId": request.principal_id,
                "principalType": request.principal_type,
            },
            status_code=201,
            target_id=request.resource_id,
            target_type=AuditTargetType(request.resource_type),
        )
        return self.list_admin_permissions(actor)

    def update_admin_permission_grant(
        self,
        actor: ActorContext,
        grant_id: str,
        request: AdminPermissionGrantUpdateRequest,
    ) -> AdminPermissionsResponse:
        self._require_admin(actor)
        grant = update_permission_grant(
            self.db,
            grant_id,
            principal_type=request.principal_type,
            principal_id=request.principal_id,
            actions=list(request.actions) if request.actions is not None else None,
        )
        self._record_audit_event(
            self.db,
            action="admin.permission_grant.updated",
            actor=actor,
            api_path=f"/api/admin/permissions/{grant_id}",
            http_method="PATCH",
            metadata={
                "actions": list(request.actions) if request.actions is not None else None,
                "grantId": grant.id,
                "principalId": grant.principal_id,
                "principalType": grant.principal_type,
            },
            target_id=grant.resource_id,
            target_type=AuditTargetType(grant.resource_type),
        )
        return self.list_admin_permissions(actor)

    def delete_admin_permission_grant(
        self,
        actor: ActorContext,
        grant_id: str,
    ) -> AdminPermissionsResponse:
        self._require_admin(actor)
        grant = delete_permission_grant(self.db, grant_id)
        self._record_audit_event(
            self.db,
            action="admin.permission_grant.deleted",
            actor=actor,
            api_path=f"/api/admin/permissions/{grant_id}",
            http_method="DELETE",
            metadata={
                "actions": grant.actions or [],
                "grantId": grant.id,
                "principalId": grant.principal_id,
                "principalType": grant.principal_type,
            },
            target_id=grant.resource_id,
            target_type=AuditTargetType(grant.resource_type),
        )
        return self.list_admin_permissions(actor)

    def list_admin_governance_controls(self, actor: ActorContext) -> AdminGovernanceControlsResponse:
        self._require_admin(actor)
        return AdminGovernanceControlsResponse(
            principal_controls=[
                principal_control_response(row)
                for row in list_principal_controls(self.db)
            ],
            resource_locks=[
                resource_lock_response(row)
                for row in list_resource_locks(self.db)
            ],
        )

    def update_admin_principal_control(
        self,
        actor: ActorContext,
        request: AdminPrincipalControlRequest,
    ) -> AdminGovernanceControlsResponse:
        self._require_admin(actor)
        row = set_principal_control(
            self.db,
            principal_type=request.principal_type,
            principal_id=request.principal_id,
            reason=request.reason,
            status_value=request.status,
            updated_by=actor.name,
        )
        self._record_audit_event(
            self.db,
            action="admin.principal_control.updated",
            actor=actor,
            api_path="/api/admin/governance/principals",
            http_method="PATCH",
            metadata={
                "principalId": row.principal_id,
                "principalType": row.principal_type,
                "reason": row.reason,
                "status": row.status,
            },
            target_id=row.principal_id,
            target_type=AuditTargetType(row.principal_type),
        )
        return self.list_admin_governance_controls(actor)

    def update_admin_resource_lock(
        self,
        actor: ActorContext,
        request: AdminResourceLockRequest,
    ) -> AdminGovernanceControlsResponse:
        self._require_admin(actor)
        self._require_resource_exists(request.resource_type, request.resource_id)
        row = set_resource_lock(
            self.db,
            locked=request.locked,
            reason=request.reason,
            resource_id=request.resource_id,
            resource_type=request.resource_type,
            updated_by=actor.name,
        )
        self._record_audit_event(
            self.db,
            action="admin.resource_lock.updated",
            actor=actor,
            api_path="/api/admin/governance/resource-locks",
            http_method="PATCH",
            metadata={
                "locked": row.locked,
                "reason": row.reason,
                "resourceId": row.resource_id,
                "resourceType": row.resource_type,
            },
            target_id=row.resource_id,
            target_type=AuditTargetType(row.resource_type),
        )
        return self.list_admin_governance_controls(actor)

    def _require_resource_exists(self, resource_type: str, resource_id: str) -> None:
        if resource_type == "dataset":
            exists = any(model.id == resource_id for model in CatalogRepository(self.db).list_dataset_models())
        elif resource_type == "etl_job":
            exists = any(job.id == resource_id for job in list_jobs(self.db))
        elif resource_type == "dashboard":
            exists = any(dashboard.id == resource_id for dashboard in list_dashboard_cards(self.db))
        else:
            exists = False
        if exists:
            return
        raise ApiError(
            ErrorCode.NOT_FOUND,
            f"Permission resource {resource_type}:{resource_id} was not found",
            status.HTTP_404_NOT_FOUND,
        )

    def list_admin_audit_logs(
        self,
        actor: ActorContext,
        *,
        actor_id: str | None = None,
        from_at: datetime | None = None,
        limit: int = 100,
        query: str | None = None,
        resource_type: AuditTargetType | None = None,
        result: str | None = None,
        to_at: datetime | None = None,
    ) -> AdminAuditLogsResponse:
        self._require_admin(actor)
        return AdminAuditLogsResponse(
            logs=list_audit_events(
                self.db,
                actor_id=actor_id,
                from_at=from_at,
                limit=limit,
                query=query,
                resource_type=resource_type,
                result=result,
                to_at=to_at,
            )
        )

    def _require_admin(self, actor: ActorContext) -> None:
        if actor.is_admin:
            return
        raise ApiError(
            ErrorCode.FORBIDDEN,
            "Admin role is required to access this endpoint",
            status.HTTP_403_FORBIDDEN,
        )

    def _record_audit_event(self, *args: Any, **kwargs: Any) -> None:
        try:
            record_audit_event(*args, **kwargs)
        except Exception:
            self.db.rollback()

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

    def _admin_user_response(self, user: AuthUserModel) -> AdminUser:
        user_actor = ActorContext(
            id=user.id,
            email=user.email,
            name=user.display_name,
            role=user.role,
            groups=tuple(str(group_id) for group_id in user.groups or []),
            title=user.title,
        )
        user_payload = {
            "display_name": user.display_name,
            "email": user.email,
            "groups": list(user.groups or []),
            "title": user.title,
        }
        current = CurrentUserResponse(
            id=user.id,
            display_name=user.display_name,
            email=user.email,
            role=user.role,
            groups=self._groups_for_user(list(user.groups or [])),
            profile=self._profile_for_user(user_payload),
            permissions_summary=self._permission_summary(user_actor),
        )
        return AdminUser(
            **current.model_dump(),
            status=user.status if user.status in {"active", "invited", "disabled"} else "disabled",
            last_active_at=user.last_active_at.isoformat() if user.last_active_at else None,
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
        self._ensure_permission_grants_seeded()
        resources: list[AdminPermissionSummary] = []
        resources.extend(self._dataset_permission_summaries(actor))
        resources.extend(self._job_permission_summaries(actor))
        resources.extend(self._dashboard_permission_summaries(actor))
        return resources

    def _dataset_permission_summaries(self, actor: ActorContext) -> list[AdminPermissionSummary]:
        repository = CatalogRepository(self.db)
        summaries = []
        models = repository.list_dataset_models()
        persisted_grants = list_permission_grants_by_resource(
            self.db,
            [("dataset", model.id) for model in models],
        )
        for model in models:
            payload = dataset_model_to_payload(model)
            owner = str(payload.get("owner") or "")
            resource_id = str(payload.get("id") or model.id)
            grants = merge_grants(
                parse_grants(payload.get("permissionGrants")),
                persisted_grants.get(("dataset", resource_id), []),
            )
            summaries.append(
                AdminPermissionSummary(
                    resource_type="dataset",
                    resource_id=resource_id,
                    resource_name=str(payload.get("name") or model.id),
                    owner=owner,
                    created_by=string_or_none(payload.get("createdBy")),
                    grants=grants,
                    current_actor_permissions=permissions_for_actor_with_governance(
                        self.db,
                        actor,
                        owner=owner,
                        grants=[grant.model_dump(by_alias=True) for grant in grants],
                        resource_id=resource_id,
                        resource_type="dataset",
                    ),
                )
            )
        return summaries

    def _job_permission_summaries(self, actor: ActorContext) -> list[AdminPermissionSummary]:
        summaries = []
        jobs = list_jobs(self.db)
        persisted_grants = list_permission_grants_by_resource(
            self.db,
            [("etl_job", job.id) for job in jobs],
        )
        for job in jobs:
            grants = merge_grants(
                parse_grants(job.permission_grants),
                persisted_grants.get(("etl_job", job.id), []),
            )
            summaries.append(
                AdminPermissionSummary(
                    resource_type="etl_job",
                    resource_id=job.id,
                    resource_name=job.name,
                    owner=job.owner,
                    created_by=job.created_by,
                    grants=grants,
                    current_actor_permissions=permissions_for_actor_with_governance(
                        self.db,
                        actor,
                        owner=job.owner,
                        grants=[grant.model_dump(by_alias=True) for grant in grants],
                        resource_id=job.id,
                        resource_type="etl_job",
                    ),
                )
            )
        return summaries

    def _dashboard_permission_summaries(self, actor: ActorContext) -> list[AdminPermissionSummary]:
        summaries = []
        dashboards = list_dashboard_cards(self.db)
        persisted_grants = list_permission_grants_by_resource(
            self.db,
            [("dashboard", dashboard.id) for dashboard in dashboards],
        )
        for dashboard in dashboards:
            grants = merge_grants(
                parse_grants(dashboard.permission_grants),
                persisted_grants.get(("dashboard", dashboard.id), []),
            )
            summaries.append(
                AdminPermissionSummary(
                    resource_type="dashboard",
                    resource_id=dashboard.id,
                    resource_name=dashboard.name,
                    owner=dashboard.owner,
                    created_by=dashboard.created_by,
                    grants=grants,
                    current_actor_permissions=permissions_for_actor_with_governance(
                        self.db,
                        actor,
                        owner=dashboard.owner,
                        grants=[grant.model_dump(by_alias=True) for grant in grants],
                        resource_id=dashboard.id,
                        resource_type="dashboard",
                    ),
                )
            )
        return summaries

    def _ensure_permission_grants_seeded(self) -> None:
        if not settings.allows_header_auth_fallback:
            return
        repository = CatalogRepository(self.db)
        ensure_demo_permission_grants(
            self.db,
            dataset_ids=[model.id for model in repository.list_dataset_models()],
            job_ids=[job.id for job in list_jobs(self.db)],
            dashboard_ids=[dashboard.id for dashboard in list_dashboard_cards(self.db)],
        )


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


def merge_grants(*grant_groups: list[PermissionGrant]) -> list[PermissionGrant]:
    payloads = [
        grant.model_dump(by_alias=True)
        for group in grant_groups
        for grant in group
    ]
    return parse_grants(dedupe_grants(payloads))


def principal_control_response(row: Any) -> AdminPrincipalControl:
    return AdminPrincipalControl(
        id=row.id,
        principal_type=row.principal_type,
        principal_id=row.principal_id,
        status=row.status,
        reason=row.reason,
        updated_by=row.updated_by,
        updated_at=datetime_to_iso(row.updated_at),
    )


def resource_lock_response(row: Any) -> AdminResourceLock:
    return AdminResourceLock(
        id=row.id,
        resource_type=row.resource_type,
        resource_id=row.resource_id,
        locked=bool(row.locked),
        reason=row.reason,
        updated_by=row.updated_by,
        updated_at=datetime_to_iso(row.updated_at),
    )


def datetime_to_iso(value: Any) -> str | None:
    if value is None:
        return None
    if hasattr(value, "isoformat"):
        return value.isoformat().replace("+00:00", "Z")
    return str(value)


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
