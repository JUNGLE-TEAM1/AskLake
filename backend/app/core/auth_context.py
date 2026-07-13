from dataclasses import dataclass, field
from typing import Annotated, Any

from fastapi import Cookie, Depends, Header
from fastapi import status
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.errors import ApiError
from app.schemas.common import ErrorCode
from app.schemas.permissions import ResourcePermissions
from app.services.auth_service import SESSION_COOKIE_NAME, load_session_actor


@dataclass(frozen=True)
class ActorContext:
    name: str = "demo-user"
    role: str = "viewer"
    groups: tuple[str, ...] = field(default_factory=tuple)
    id: str | None = None
    email: str | None = None
    title: str | None = None

    @property
    def is_admin(self) -> bool:
        return self.role.casefold() == "admin"

    @property
    def principal_ids(self) -> set[tuple[str, str]]:
        principals = {("user", self.name), ("role", self.role)}
        principals.update(("group", group) for group in self.groups)
        return {(kind, value) for kind, value in principals if value}


def get_actor_context(
    actor_name: Annotated[str, Header(alias="X-AskLake-User")] = "Admin User",
    actor_role: Annotated[str, Header(alias="X-AskLake-Role")] = "admin",
    actor_groups: Annotated[str | None, Header(alias="X-AskLake-Groups")] = None,
    session_token: Annotated[str | None, Cookie(alias=SESSION_COOKIE_NAME)] = None,
    db: Annotated[Session, Depends(get_db)] = None,
) -> ActorContext:
    if session_token and db is not None:
        session_actor = load_session_actor(db, session_token)
        if session_actor is not None:
            return ActorContext(
                name=str(session_actor.get("name") or "demo-user"),
                role=str(session_actor.get("role") or "viewer"),
                groups=tuple(str(group) for group in session_actor.get("groups") or []),
                id=str(session_actor.get("id") or "") or None,
                email=str(session_actor.get("email") or "") or None,
                title=str(session_actor.get("title") or "") or None,
            )
    return ActorContext(
        name=(actor_name or "").strip() or "demo-user",
        role=(actor_role or "").strip() or "viewer",
        groups=tuple(
            group.strip()
            for group in (actor_groups or "").split(",")
            if group.strip()
        ),
    )


def can(
    actor: ActorContext,
    action: str,
    *,
    owner: str | None = None,
    grants: list[dict[str, Any]] | None = None,
) -> bool:
    normalized_action = action.strip()
    if not normalized_action:
        return False
    if actor.is_admin:
        return True
    if owner and owner == actor.name:
        return True

    for grant in grants or []:
        if not isinstance(grant, dict):
            continue
        actions = grant.get("actions") or []
        if normalized_action not in actions:
            continue
        principal_type = str(grant.get("principalType") or grant.get("principal_type") or "")
        principal_id = str(grant.get("principalId") or grant.get("principal_id") or "")
        if principal_type == "public":
            return True
        if (principal_type, principal_id) in actor.principal_ids:
            return True

    return False


def grant_payloads(grants: list[Any] | None) -> list[dict[str, Any]]:
    return [
        grant.model_dump(by_alias=True) if hasattr(grant, "model_dump") else grant
        for grant in (grants or [])
        if isinstance(grant, dict) or hasattr(grant, "model_dump")
    ]


def require_permission(
    actor: ActorContext,
    action: str,
    *,
    owner: str | None = None,
    grants: list[Any] | None = None,
    resource_label: str = "resource",
) -> None:
    if can(actor, action, owner=owner, grants=grant_payloads(grants)):
        return
    raise ApiError(
        ErrorCode.FORBIDDEN,
        f"Actor {actor.name} is not allowed to {action} this {resource_label}",
        status.HTTP_403_FORBIDDEN,
    )


def require_any_permission(
    actor: ActorContext,
    actions: list[str] | tuple[str, ...],
    *,
    owner: str | None = None,
    grants: list[Any] | None = None,
    resource_label: str = "resource",
) -> None:
    grant_payload_list = grant_payloads(grants)
    for action in actions:
        if can(actor, action, owner=owner, grants=grant_payload_list):
            return
    action_label = "/".join(actions) or "access"
    raise ApiError(
        ErrorCode.FORBIDDEN,
        f"Actor {actor.name} is not allowed to {action_label} this {resource_label}",
        status.HTTP_403_FORBIDDEN,
    )


def permissions_for_actor(
    actor: ActorContext,
    *,
    owner: str | None = None,
    grants: list[dict[str, Any]] | None = None,
    enforced: bool = False,
) -> ResourcePermissions:
    grant_payload_list = grant_payloads(grants)
    can_view = can(actor, "view", owner=owner, grants=grant_payload_list)
    can_query = can(actor, "query", owner=owner, grants=grant_payload_list)
    can_run = can(actor, "run", owner=owner, grants=grant_payload_list)
    can_manage = can(actor, "manage", owner=owner, grants=grant_payload_list)
    can_delete = can(actor, "delete", owner=owner, grants=grant_payload_list)
    can_share = can(actor, "share", owner=owner, grants=grant_payload_list)
    return ResourcePermissions(
        can_view=can_view or can_query or can_run or can_manage or can_delete or can_share,
        can_query=can_query,
        can_run=can_run,
        can_manage=can_manage,
        can_delete=can_delete,
        can_share=can_share,
        computed_for=actor.name,
        enforced=enforced,
    )
