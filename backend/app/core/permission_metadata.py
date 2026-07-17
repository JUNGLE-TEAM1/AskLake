from typing import Any

ACTION_LABELS = {
    "관리": "manage",
    "메타데이터": "view",
    "조회": "view",
    "쿼리 실행": "query",
}


def permission_grants_from_roles(
    owner: str | None,
    roles: list[dict[str, Any]] | None = None,
    *,
    default_actions: list[str] | None = None,
) -> list[dict[str, Any]]:
    actions = default_actions or ["view"]
    grants: list[dict[str, Any]] = []
    owner_name = (owner or "").strip()
    if owner_name:
        grants.append({
            "actions": actions,
            "principalId": owner_name,
            "principalType": "user",
            "source": "owner",
        })

    for role in roles or []:
        if not isinstance(role, dict) or role.get("checked") is False:
            continue
        principal_id = str(role.get("principalId") or role.get("principal_id") or role.get("name") or "").strip()
        principal_type = str(role.get("principalType") or role.get("principal_type") or "role").strip()
        if not principal_id or principal_type not in {"user", "group", "role", "public"}:
            continue
        role_actions = normalize_actions(role.get("access"))
        grants.append({
            "actions": role_actions or actions,
            "principalId": principal_id,
            "principalType": principal_type,
            "source": "permissionRoles",
        })

    return dedupe_grants(grants)


def resource_permissions(
    *,
    actor: str = "system",
    can_query: bool = False,
    can_run: bool = False,
    can_manage: bool = False,
    can_delete: bool = False,
    can_share: bool = False,
) -> dict[str, Any]:
    return {
        "canView": True,
        "canQuery": can_query,
        "canRun": can_run,
        "canManage": can_manage,
        "canDelete": can_delete,
        "canShare": can_share,
        "canPublish": False,
        "computedFor": actor or "system",
        "enforced": False,
    }


def normalize_actions(value: Any) -> list[str]:
    raw_actions = value if isinstance(value, list) else []
    actions = [ACTION_LABELS.get(str(action), str(action)) for action in raw_actions]
    return sorted({action for action in actions if action in {"view", "query", "run", "manage", "delete", "share", "publish"}})


def dedupe_grants(grants: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[tuple[str, str, tuple[str, ...]]] = set()
    unique_grants: list[dict[str, Any]] = []
    for grant in grants:
        actions = tuple(sorted(str(action) for action in grant.get("actions", [])))
        key = (str(grant.get("principalType")), str(grant.get("principalId")), actions)
        if key in seen:
            continue
        seen.add(key)
        unique_grants.append(grant)
    return unique_grants
