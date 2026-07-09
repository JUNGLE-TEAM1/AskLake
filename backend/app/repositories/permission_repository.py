from collections import defaultdict
from typing import Iterable
from uuid import uuid4

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.base import Base
from app.models.identity import PermissionGrantModel
from app.schemas.permissions import PermissionGrant

PermissionResourceKey = tuple[str, str]


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
    for resource_type, resource_id in keys:
        rows = db.scalars(
            select(PermissionGrantModel)
            .where(PermissionGrantModel.resource_type == resource_type)
            .where(PermissionGrantModel.resource_id == resource_id)
            .order_by(PermissionGrantModel.created_at.asc(), PermissionGrantModel.id.asc())
        )
        grouped[(resource_type, resource_id)].extend(row_to_permission_grant(row) for row in rows)
    return dict(grouped)


def seed_permission_grants_if_empty(
    db: Session,
    *,
    dataset_ids: list[str],
    job_ids: list[str],
    dashboard_ids: list[str],
) -> int:
    ensure_permission_grant_table(db)
    existing_count = db.scalar(select(func.count()).select_from(PermissionGrantModel)) or 0
    if existing_count > 0:
        return 0

    rows: list[PermissionGrantModel] = []
    if dataset_ids:
        rows.append(build_grant_row(
            resource_type="dataset",
            resource_id=dataset_ids[0],
            principal_type="group",
            principal_id="analytics",
            actions=["view", "query"],
        ))
    if job_ids:
        rows.append(build_grant_row(
            resource_type="etl_job",
            resource_id=job_ids[0],
            principal_type="group",
            principal_id="ops",
            actions=["view", "run"],
        ))
    if dashboard_ids:
        rows.append(build_grant_row(
            resource_type="dashboard",
            resource_id=dashboard_ids[0],
            principal_type="group",
            principal_id="analytics",
            actions=["view"],
        ))

    if not rows:
        return 0

    db.add_all(rows)
    db.commit()
    return len(rows)


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
        principal_type=row.principal_type,
        principal_id=row.principal_id,
        actions=row.actions or [],
        source=row.source,
    )
