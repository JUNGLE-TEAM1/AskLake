from typing import Any

from fastapi import status
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext
from app.core.errors import ApiError
from app.repositories.audit_repository import safe_record_audit_event
from app.repositories.governance_repository import require_actor_not_blocked, require_resource_not_locked


def require_governed_access(
    db: Session,
    actor: ActorContext,
    *,
    action: str,
    api_path: str,
    http_method: str,
    metadata: dict[str, Any] | None = None,
    resource_id: str,
    resource_name: str | None = None,
    resource_type: str,
) -> None:
    try:
        require_actor_not_blocked(db, actor)
        require_resource_not_locked(db, action=action, resource_id=resource_id, resource_type=resource_type)
    except ApiError as exc:
        details = exc.details if isinstance(exc.details, dict) else {}
        safe_record_audit_event(
            db,
            action=f"{resource_type}.{action}.governance_forbidden",
            actor=actor,
            api_path=api_path,
            http_method=http_method,
            metadata={**(metadata or {}), **details},
            result="forbidden",
            status_code=exc.status_code or status.HTTP_403_FORBIDDEN,
            target_id=resource_id,
            target_name=resource_name,
            target_type=resource_type,
        )
        raise
