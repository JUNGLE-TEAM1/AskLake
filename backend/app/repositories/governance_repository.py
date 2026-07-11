from typing import Any
from uuid import uuid4

from fastapi import status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.errors import ApiError
from app.models.base import Base
from app.models.identity import PrincipalControlModel, ResourceLockModel
from app.schemas.common import ErrorCode

ALLOWED_PRINCIPAL_CONTROL_TYPES = {"user", "group"}
ALLOWED_PRINCIPAL_STATUSES = {"active", "blocked"}
ALLOWED_RESOURCE_LOCK_TYPES = {"dataset", "etl_job", "dashboard"}
LOCKED_ACTIONS = {"query", "run", "manage", "delete", "share"}


def ensure_governance_tables(db: Session) -> None:
    Base.metadata.create_all(bind=db.get_bind(), tables=[PrincipalControlModel.__table__, ResourceLockModel.__table__])


def list_principal_controls(db: Session) -> list[PrincipalControlModel]:
    ensure_governance_tables(db)
    return list(db.scalars(select(PrincipalControlModel).order_by(PrincipalControlModel.principal_type.asc(), PrincipalControlModel.principal_id.asc())))


def list_resource_locks(db: Session) -> list[ResourceLockModel]:
    ensure_governance_tables(db)
    return list(db.scalars(select(ResourceLockModel).order_by(ResourceLockModel.resource_type.asc(), ResourceLockModel.resource_id.asc())))


def set_principal_control(
    db: Session,
    *,
    principal_type: str,
    principal_id: str,
    reason: str | None,
    status_value: str,
    updated_by: str | None,
) -> PrincipalControlModel:
    ensure_governance_tables(db)
    normalized_type = validate_principal_type(principal_type)
    normalized_id = validate_required(principal_id, "principalId")
    normalized_status = validate_principal_status(status_value)
    row = db.scalar(
        select(PrincipalControlModel)
        .where(PrincipalControlModel.principal_type == normalized_type)
        .where(PrincipalControlModel.principal_id == normalized_id)
    )
    if row is None:
        row = PrincipalControlModel(
            id=f"principal_control_{uuid4().hex}",
            principal_type=normalized_type,
            principal_id=normalized_id,
            status=normalized_status,
        )
        db.add(row)
    row.status = normalized_status
    row.reason = normalize_optional(reason)
    row.updated_by = updated_by
    db.commit()
    db.refresh(row)
    return row


def set_resource_lock(
    db: Session,
    *,
    locked: bool,
    reason: str | None,
    resource_id: str,
    resource_type: str,
    updated_by: str | None,
) -> ResourceLockModel:
    ensure_governance_tables(db)
    normalized_type = validate_resource_type(resource_type)
    normalized_id = validate_required(resource_id, "resourceId")
    row = db.scalar(
        select(ResourceLockModel)
        .where(ResourceLockModel.resource_type == normalized_type)
        .where(ResourceLockModel.resource_id == normalized_id)
    )
    if row is None:
        row = ResourceLockModel(
            id=f"resource_lock_{uuid4().hex}",
            resource_type=normalized_type,
            resource_id=normalized_id,
            locked=locked,
        )
        db.add(row)
    row.locked = locked
    row.reason = normalize_optional(reason)
    row.updated_by = updated_by
    db.commit()
    db.refresh(row)
    return row


def blocked_principal_for_actor(db: Session, actor: Any) -> PrincipalControlModel | None:
    ensure_governance_tables(db)
    candidates: list[tuple[str, str]] = []
    for value in {actor.id, actor.email, actor.name}:
        if value:
            candidates.append(("user", value))
    candidates.extend(("group", group) for group in actor.groups if group)
    for principal_type, principal_id in candidates:
        row = db.scalar(
            select(PrincipalControlModel)
            .where(PrincipalControlModel.principal_type == principal_type)
            .where(PrincipalControlModel.principal_id == principal_id)
            .where(PrincipalControlModel.status == "blocked")
        )
        if row is not None:
            return row
    return None


def resource_lock_for_action(db: Session, *, action: str, resource_id: str, resource_type: str) -> ResourceLockModel | None:
    if action not in LOCKED_ACTIONS:
        return None
    ensure_governance_tables(db)
    return db.scalar(
        select(ResourceLockModel)
        .where(ResourceLockModel.resource_type == validate_resource_type(resource_type))
        .where(ResourceLockModel.resource_id == validate_required(resource_id, "resourceId"))
        .where(ResourceLockModel.locked.is_(True))
    )


def require_actor_not_blocked(db: Session, actor: Any) -> None:
    row = blocked_principal_for_actor(db, actor)
    if row is None:
        return
    raise ApiError(
        ErrorCode.FORBIDDEN,
        "이 리소스에 접근할 권한이 없습니다.",
        status.HTTP_403_FORBIDDEN,
        {"principalType": row.principal_type, "principalId": row.principal_id},
    )


def require_resource_not_locked(db: Session, *, action: str, resource_id: str, resource_type: str) -> None:
    row = resource_lock_for_action(db, action=action, resource_id=resource_id, resource_type=resource_type)
    if row is None:
        return
    raise ApiError(
        ErrorCode.FORBIDDEN,
        "현재 이 리소스는 관리 정책에 따라 변경할 수 없습니다.",
        status.HTTP_403_FORBIDDEN,
        {"resourceType": row.resource_type, "resourceId": row.resource_id},
    )


def validate_principal_type(value: str) -> str:
    normalized = value.strip()
    if normalized in ALLOWED_PRINCIPAL_CONTROL_TYPES:
        return normalized
    raise ApiError(ErrorCode.VALIDATION_ERROR, f"Unsupported principalType: {value}", status.HTTP_400_BAD_REQUEST)


def validate_principal_status(value: str) -> str:
    normalized = value.strip()
    if normalized in ALLOWED_PRINCIPAL_STATUSES:
        return normalized
    raise ApiError(ErrorCode.VALIDATION_ERROR, f"Unsupported principal status: {value}", status.HTTP_400_BAD_REQUEST)


def validate_resource_type(value: str) -> str:
    normalized = value.strip()
    if normalized in ALLOWED_RESOURCE_LOCK_TYPES:
        return normalized
    raise ApiError(ErrorCode.VALIDATION_ERROR, f"Unsupported resourceType: {value}", status.HTTP_400_BAD_REQUEST)


def validate_required(value: str, label: str) -> str:
    normalized = value.strip()
    if normalized:
        return normalized
    raise ApiError(ErrorCode.VALIDATION_ERROR, f"{label} is required", status.HTTP_400_BAD_REQUEST)


def normalize_optional(value: Any) -> str | None:
    if value is None:
        return None
    normalized = str(value).strip()
    return normalized or None
