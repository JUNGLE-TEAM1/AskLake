from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from sqlalchemy import String, and_, cast, or_, select
from sqlalchemy.orm import Session

from app.models.base import Base
from app.models.identity import AuditEventModel
from app.schemas.identity import AdminAuditLogEntry

ALLOWED_AUDIT_RESULTS = {"success", "failed", "forbidden"}
ALLOWED_AUDIT_TARGET_TYPES = {"etl_job", "dataset", "dashboard", "query_run", "ai_module", "admin_module", "ui", "auth", "user", "group"}


def ensure_audit_event_table(db: Session) -> None:
    Base.metadata.create_all(bind=db.get_bind(), tables=[AuditEventModel.__table__])


def record_audit_event(
    db: Session,
    *,
    action: str,
    actor: Any,
    api_path: str,
    target_id: str,
    target_type: str,
    result: str = "success",
    http_method: str | None = None,
    metadata: dict[str, Any] | None = None,
    request_id: str | None = None,
    status_code: int | None = None,
    target_name: str | None = None,
) -> AuditEventModel:
    ensure_audit_event_table(db)
    row = AuditEventModel(
        id=f"audit_{uuid4().hex}",
        action=action.strip() or "audit.event",
        actor_id=actor.id or actor.email or actor.name,
        actor_name=actor.name,
        actor_role=actor.role,
        actor_groups=list(actor.groups),
        api_path=api_path,
        request_id=request_id or f"req_{uuid4().hex}",
        result=normalize_result(result),
        status_code=status_code,
        target_id=target_id,
        target_name=target_name,
        target_type=normalize_target_type(target_type),
        http_method=http_method,
        metadata_=metadata or {},
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def safe_record_audit_event(db: Session, **kwargs: Any) -> AuditEventModel | None:
    try:
        return record_audit_event(db, **kwargs)
    except Exception:
        db.rollback()
        return None


def list_audit_events(
    db: Session,
    *,
    actor_id: str | None = None,
    from_at: datetime | None = None,
    limit: int = 100,
    query: str | None = None,
    resource_type: str | None = None,
    result: str | None = None,
    to_at: datetime | None = None,
) -> list[AdminAuditLogEntry]:
    ensure_audit_event_table(db)
    conditions = []
    if actor_id:
        like_actor = f"%{actor_id.strip()}%"
        conditions.append(or_(AuditEventModel.actor_id.ilike(like_actor), AuditEventModel.actor_name.ilike(like_actor)))
    if resource_type:
        conditions.append(AuditEventModel.target_type == normalize_target_type(resource_type))
    if result:
        conditions.append(AuditEventModel.result == normalize_result(result))
    if from_at:
        conditions.append(AuditEventModel.created_at >= normalize_datetime(from_at))
    if to_at:
        conditions.append(AuditEventModel.created_at <= normalize_datetime(to_at))
    if query:
        pattern = f"%{query.strip()}%"
        conditions.append(or_(
            AuditEventModel.action.ilike(pattern),
            AuditEventModel.actor_id.ilike(pattern),
            AuditEventModel.actor_name.ilike(pattern),
            AuditEventModel.api_path.ilike(pattern),
            cast(AuditEventModel.metadata_, String).ilike(pattern),
            AuditEventModel.target_id.ilike(pattern),
            AuditEventModel.target_name.ilike(pattern),
        ))

    statement = select(AuditEventModel).order_by(AuditEventModel.created_at.desc(), AuditEventModel.id.desc()).limit(max(1, min(limit, 500)))
    if conditions:
        statement = statement.where(and_(*conditions))
    return [row_to_admin_audit_log(row) for row in db.scalars(statement)]


def row_to_admin_audit_log(row: AuditEventModel) -> AdminAuditLogEntry:
    return AdminAuditLogEntry(
        action=row.action,
        actor_id=row.actor_id,
        actor_name=row.actor_name,
        actor_role=row.actor_role,
        actor_groups=row.actor_groups or [],
        api_path=row.api_path,
        created_at=to_iso_z(row.created_at),
        http_method=row.http_method,
        ip_address=row.ip_address,
        metadata=row.metadata_ or {},
        request_id=row.request_id,
        result=normalize_result(row.result),
        status_code=row.status_code,
        target_id=row.target_id,
        target_name=row.target_name,
        target_type=normalize_target_type(row.target_type),
    )


def normalize_result(value: str) -> str:
    normalized = value.strip().lower()
    return normalized if normalized in ALLOWED_AUDIT_RESULTS else "failed"


def normalize_target_type(value: str) -> str:
    normalized = value.strip()
    return normalized if normalized in ALLOWED_AUDIT_TARGET_TYPES else "ui"


def normalize_datetime(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


def to_iso_z(value: datetime) -> str:
    normalized = normalize_datetime(value).astimezone(timezone.utc)
    return normalized.isoformat().replace("+00:00", "Z")
