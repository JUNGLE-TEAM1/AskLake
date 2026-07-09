from dataclasses import dataclass, field
from typing import Annotated, Any

from fastapi import Header


@dataclass(frozen=True)
class ActorContext:
    name: str = "demo-user"
    role: str = "viewer"
    groups: tuple[str, ...] = field(default_factory=tuple)

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
) -> ActorContext:
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


def permissions_for_actor(
    actor: ActorContext,
    *,
    owner: str | None = None,
    grants: list[dict[str, Any]] | None = None,
    enforced: bool = False,
) -> dict[str, Any]:
    return {
        "canView": can(actor, "view", owner=owner, grants=grants),
        "canQuery": can(actor, "query", owner=owner, grants=grants),
        "canRun": can(actor, "run", owner=owner, grants=grants),
        "canManage": can(actor, "manage", owner=owner, grants=grants),
        "canDelete": can(actor, "delete", owner=owner, grants=grants),
        "canShare": can(actor, "share", owner=owner, grants=grants),
        "computedFor": actor.name,
        "enforced": enforced,
    }
