from collections import defaultdict
from typing import Iterable
from uuid import uuid4

from fastapi import status
from sqlalchemy import select, tuple_
from sqlalchemy.orm import Session

from app.core.errors import ApiError
from app.models.base import Base
from app.models.identity import PermissionGrantModel
from app.schemas.common import ErrorCode
from app.schemas.permissions import PermissionGrant

PermissionResourceKey = tuple[str, str]
DELETED_SEED_SOURCE = "admin_seed_deleted"
LEGACY_PERMISSION_SOURCE = "legacy_permission_roles"
UI_MANAGED_SOURCES = {"permission_ui", LEGACY_PERMISSION_SOURCE}
ALLOWED_ACTIONS = {"view", "query", "run", "manage", "delete", "share"}
VIEW_DEPENDENT_ACTIONS = ALLOWED_ACTIONS - {"view"}
ALLOWED_PRINCIPAL_TYPES = {"user", "group", "role", "public"}
ALLOWED_RESOURCE_TYPES = {"dataset", "etl_job", "dashboard"}


def ensure_permission_grant_table(db: Session) -> None:
    Base.metadata.create_all(bind=db.get_bind(), tables=[PermissionGrantModel.__table__])


def list_permission_grants_by_resource(
    db: Session,
    resource_keys: Iterable[PermissionResourceKey],
) -> dict[PermissionResourceKey, list[PermissionGrant]]:
    keys = list(dict.fromkeys(resource_keys))
    if not keys:
        return {}

    ensure_permission_grant_table(db)
    grouped: dict[PermissionResourceKey, list[PermissionGrant]] = defaultdict(list)
    for key in keys:
        grouped[key]

    rows = db.scalars(
        select(PermissionGrantModel)
        .where(
            tuple_(
                PermissionGrantModel.resource_type,
                PermissionGrantModel.resource_id,
            ).in_(keys)
        )
        .where(PermissionGrantModel.source != DELETED_SEED_SOURCE)
        .order_by(
            PermissionGrantModel.resource_type.asc(),
            PermissionGrantModel.resource_id.asc(),
            PermissionGrantModel.created_at.asc(),
            PermissionGrantModel.id.asc(),
        )
    ).all()
    for row in rows:
        grouped[(row.resource_type, row.resource_id)].append(row_to_permission_grant(row))
    return dict(grouped)


def ensure_demo_permission_grants(
    db: Session,
    *,
    dataset_ids: list[str],
    job_ids: list[str],
    dashboard_ids: list[str],
) -> int:
    ensure_permission_grant_table(db)
    desired_rows: list[PermissionGrantModel] = []
    if dataset_ids:
        desired_rows.append(build_grant_row(
            resource_type="dataset",
            resource_id=dataset_ids[0],
            principal_type="group",
            principal_id="analytics",
            actions=["view", "query"],
        ))
    if job_ids:
        desired_rows.append(build_grant_row(
            resource_type="etl_job",
            resource_id=job_ids[0],
            principal_type="group",
            principal_id="ops",
            actions=["view", "run"],
        ))
    if dashboard_ids:
        desired_rows.append(build_grant_row(
            resource_type="dashboard",
            resource_id=dashboard_ids[0],
            principal_type="group",
            principal_id="analytics",
            actions=["view"],
        ))

    if not desired_rows:
        return 0

    existing_keys = {
        (
            row.resource_type,
            row.resource_id,
            row.principal_type,
            row.principal_id,
        )
        for row in db.scalars(
            select(PermissionGrantModel).where(
                PermissionGrantModel.source.in_(["admin_seed", DELETED_SEED_SOURCE])
            )
        )
    }
    rows = [
        row
        for row in desired_rows
        if (row.resource_type, row.resource_id, row.principal_type, row.principal_id) not in existing_keys
    ]
    if not rows:
        return 0
    db.add_all(rows)
    db.commit()
    return len(rows)


def create_permission_grant(
    db: Session,
    *,
    resource_type: str,
    resource_id: str,
    principal_type: str,
    principal_id: str,
    actions: list[str],
    created_by: str | None,
) -> PermissionGrantModel:
    ensure_permission_grant_table(db)
    normalized_principal_type = validate_principal_type(principal_type)
    row = PermissionGrantModel(
        id=f"grant_{uuid4().hex}",
        resource_type=validate_resource_type(resource_type),
        resource_id=validate_required(resource_id, "resourceId"),
        principal_type=normalized_principal_type,
        principal_id=validate_required(principal_id, "principalId") if normalized_principal_type != "public" else "public",
        actions=validate_actions(actions),
        source="admin",
        created_by=created_by,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def replace_permission_ui_grants(
    db: Session,
    *,
    resource_type: str,
    resource_id: str,
    grants: list[PermissionGrant],
    created_by: str | None,
) -> list[PermissionGrant]:
    """Replace grants managed by the creation UI without touching admin grants."""
    ensure_permission_grant_table(db)
    normalized_resource_type = validate_resource_type(resource_type)
    normalized_resource_id = validate_required(resource_id, "resourceId")
    existing_rows = db.scalars(
        select(PermissionGrantModel)
        .where(PermissionGrantModel.resource_type == normalized_resource_type)
        .where(PermissionGrantModel.resource_id == normalized_resource_id)
        .where(PermissionGrantModel.source.in_(UI_MANAGED_SOURCES))
    ).all()
    for row in existing_rows:
        db.delete(row)

    seen: set[tuple[str, str, tuple[str, ...]]] = set()
    rows: list[PermissionGrantModel] = []
    for grant in grants:
        principal_type = validate_principal_type(grant.principal_type)
        principal_id = "public" if principal_type == "public" else validate_required(grant.principal_id, "principalId")
        actions = validate_actions(list(grant.actions))
        key = (principal_type, principal_id, tuple(actions))
        if key in seen:
            continue
        seen.add(key)
        rows.append(PermissionGrantModel(
            id=f"grant_{uuid4().hex}",
            resource_type=normalized_resource_type,
            resource_id=normalized_resource_id,
            principal_type=principal_type,
            principal_id=principal_id,
            actions=actions,
            source="permission_ui",
            created_by=created_by,
        ))

    db.add_all(rows)
    db.commit()
    return [row_to_permission_grant(row) for row in rows]


def ensure_legacy_permission_grants(
    db: Session,
    *,
    resource_type: str,
    resource_id: str,
    grants: list[PermissionGrant],
    created_by: str | None,
) -> list[PermissionGrant]:
    """Persist legacy UI roles once so authorization reads one grant store."""
    ensure_permission_grant_table(db)
    normalized_resource_type = validate_resource_type(resource_type)
    normalized_resource_id = validate_required(resource_id, "resourceId")
    existing_rows = db.scalars(
        select(PermissionGrantModel)
        .where(PermissionGrantModel.resource_type == normalized_resource_type)
        .where(PermissionGrantModel.resource_id == normalized_resource_id)
        .where(PermissionGrantModel.source.in_(UI_MANAGED_SOURCES))
    ).all()
    if existing_rows or not grants:
        return list_permission_grants_by_resource(
            db,
            [(normalized_resource_type, normalized_resource_id)],
        ).get((normalized_resource_type, normalized_resource_id), [])

    seen: set[tuple[str, str, tuple[str, ...]]] = set()
    rows: list[PermissionGrantModel] = []
    for grant in grants:
        principal_type = validate_principal_type(grant.principal_type)
        principal_id = "public" if principal_type == "public" else validate_required(grant.principal_id, "principalId")
        actions = validate_actions(list(grant.actions))
        key = (principal_type, principal_id, tuple(actions))
        if key in seen:
            continue
        seen.add(key)
        rows.append(PermissionGrantModel(
            id=f"grant_{uuid4().hex}",
            resource_type=normalized_resource_type,
            resource_id=normalized_resource_id,
            principal_type=principal_type,
            principal_id=principal_id,
            actions=actions,
            source=LEGACY_PERMISSION_SOURCE,
            created_by=created_by,
        ))

    db.add_all(rows)
    db.commit()
    return list_permission_grants_by_resource(
        db,
        [(normalized_resource_type, normalized_resource_id)],
    ).get((normalized_resource_type, normalized_resource_id), [])


def update_permission_grant(
    db: Session,
    grant_id: str,
    *,
    principal_type: str | None = None,
    principal_id: str | None = None,
    actions: list[str] | None = None,
) -> PermissionGrantModel:
    ensure_permission_grant_table(db)
    row = get_permission_grant_or_404(db, grant_id)
    if principal_type is not None:
        normalized_principal_type = validate_principal_type(principal_type)
        if normalized_principal_type != "public" and row.principal_type == "public" and principal_id is None:
            raise ApiError(
                ErrorCode.VALIDATION_ERROR,
                "principalId is required when changing a public grant to a user, group, or role grant",
                status.HTTP_400_BAD_REQUEST,
            )
        row.principal_type = normalized_principal_type
    if principal_id is not None:
        row.principal_id = validate_required(principal_id, "principalId")
    if actions is not None:
        row.actions = validate_actions(actions)
    if row.principal_type == "public":
        row.principal_id = "public"
    db.commit()
    db.refresh(row)
    return row


def delete_permission_grant(db: Session, grant_id: str) -> PermissionGrantModel:
    ensure_permission_grant_table(db)
    row = get_permission_grant_or_404(db, grant_id)
    if row.source == "admin_seed":
        row.source = DELETED_SEED_SOURCE
    else:
        db.delete(row)
    db.commit()
    return row


def build_grant_row(
    *,
    resource_type: str,
    resource_id: str,
    principal_type: str,
    principal_id: str,
    actions: list[str],
) -> PermissionGrantModel:
    return PermissionGrantModel(
        id=f"grant_{uuid4().hex}",
        resource_type=resource_type,
        resource_id=resource_id,
        principal_type=principal_type,
        principal_id=principal_id,
        actions=actions,
        source="admin_seed",
        created_by="system",
    )


def row_to_permission_grant(row: PermissionGrantModel) -> PermissionGrant:
    return PermissionGrant(
        id=row.id,
        principal_type=row.principal_type,
        principal_id=row.principal_id,
        actions=row.actions or [],
        source=row.source,
    )


def get_permission_grant_or_404(db: Session, grant_id: str) -> PermissionGrantModel:
    row = db.get(PermissionGrantModel, grant_id)
    if row is None:
        raise ApiError(ErrorCode.NOT_FOUND, f"Permission grant {grant_id} was not found", status.HTTP_404_NOT_FOUND)
    return row


def validate_resource_type(value: str) -> str:
    normalized = value.strip()
    if normalized in ALLOWED_RESOURCE_TYPES:
        return normalized
    raise ApiError(ErrorCode.VALIDATION_ERROR, f"Unsupported resourceType: {value}", status.HTTP_400_BAD_REQUEST)


def validate_principal_type(value: str) -> str:
    normalized = value.strip()
    if normalized in ALLOWED_PRINCIPAL_TYPES:
        return normalized
    raise ApiError(ErrorCode.VALIDATION_ERROR, f"Unsupported principalType: {value}", status.HTTP_400_BAD_REQUEST)


def validate_actions(values: list[str]) -> list[str]:
    normalized_actions = {value.strip() for value in values if value.strip()}
    if normalized_actions & VIEW_DEPENDENT_ACTIONS:
        normalized_actions.add("view")
    actions = sorted(normalized_actions)
    if not actions:
        raise ApiError(ErrorCode.VALIDATION_ERROR, "At least one permission action is required", status.HTTP_400_BAD_REQUEST)
    unsupported = [action for action in actions if action not in ALLOWED_ACTIONS]
    if unsupported:
        raise ApiError(ErrorCode.VALIDATION_ERROR, f"Unsupported permission actions: {', '.join(unsupported)}", status.HTTP_400_BAD_REQUEST)
    return actions


def validate_required(value: str, label: str) -> str:
    normalized = value.strip()
    if normalized:
        return normalized
    raise ApiError(ErrorCode.VALIDATION_ERROR, f"{label} is required", status.HTTP_400_BAD_REQUEST)
