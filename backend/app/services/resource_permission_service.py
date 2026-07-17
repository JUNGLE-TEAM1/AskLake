from typing import Any

from sqlalchemy.orm import Session

from app.core.permission_metadata import dedupe_grants
from app.core.auth_context import ActorContext, permissions_for_actor
from app.repositories.governance_repository import blocked_principal_for_actor, resource_lock_for_action
from app.repositories.permission_repository import list_permission_grants_by_resource
from app.schemas.catalog import CatalogDatasetResponse
from app.schemas.dashboard import DashboardCard
from app.schemas.etl import JobRowData
from app.schemas.permissions import PermissionGrant, ResourcePermissions


def datasets_with_persisted_permission_grants(
    db: Session,
    datasets: list[CatalogDatasetResponse],
) -> list[CatalogDatasetResponse]:
    persisted_grants = list_permission_grants_by_resource(
        db,
        [("dataset", dataset.id) for dataset in datasets],
    )
    return [
        dataset.model_copy(update={
            "permission_grants": merge_permission_grants(
                parse_permission_grants(dataset.permission_grants),
                persisted_grants.get(("dataset", dataset.id), []),
            ),
        })
        for dataset in datasets
    ]


def dataset_with_persisted_permission_grants(
    db: Session,
    dataset: CatalogDatasetResponse,
) -> CatalogDatasetResponse:
    return datasets_with_persisted_permission_grants(db, [dataset])[0]


def job_with_persisted_permission_grants(
    db: Session,
    job: JobRowData,
) -> JobRowData:
    return job.model_copy(update={
        "permission_grants": permission_grants_for_resource(
            db,
            "etl_job",
            job.id,
            parse_permission_grants(job.permission_grants),
        ),
    })


def dashboard_with_persisted_permission_grants(
    db: Session,
    dashboard: DashboardCard,
) -> DashboardCard:
    return dashboard.model_copy(update={
        "permission_grants": permission_grants_for_resource(
            db,
            "dashboard",
            dashboard.id,
            parse_permission_grants(dashboard.permission_grants),
        ),
    })


def permission_grants_for_resource(
    db: Session,
    resource_type: str,
    resource_id: str,
    fallback_grants: list[PermissionGrant],
) -> list[PermissionGrant]:
    persisted_grants = list_permission_grants_by_resource(db, [(resource_type, resource_id)])
    return merge_permission_grants(
        fallback_grants,
        persisted_grants.get((resource_type, resource_id), []),
    )


def parse_permission_grants(value: Any) -> list[PermissionGrant]:
    grants = value or []
    parsed: list[PermissionGrant] = []
    for grant in grants if isinstance(grants, list) else []:
        if isinstance(grant, PermissionGrant):
            parsed.append(grant)
        elif isinstance(grant, dict):
            parsed.append(PermissionGrant.model_validate(grant))
    return parsed


def merge_permission_grants(*grant_groups: list[PermissionGrant]) -> list[PermissionGrant]:
    payloads = [
        grant.model_dump(by_alias=True)
        for group in grant_groups
        for grant in parse_permission_grants(group)
    ]
    return parse_permission_grants(dedupe_grants(payloads))


def permissions_for_actor_with_governance(
    db: Session,
    actor: ActorContext,
    *,
    grants: list[dict[str, Any]],
    owner: str | None,
    resource_id: str,
    resource_type: str,
) -> ResourcePermissions:
    return permissions_for_actor_with_governance_state(
        actor,
        grants=grants,
        owner=owner,
        principal_blocked=blocked_principal_for_actor(db, actor) is not None,
        resource_locked=(
            resource_lock_for_action(
                db,
                action="query",
                resource_id=resource_id,
                resource_type=resource_type,
            )
            is not None
        ),
    )


def permissions_for_actor_with_governance_state(
    actor: ActorContext,
    *,
    grants: list[dict[str, Any]],
    owner: str | None,
    principal_blocked: bool,
    resource_locked: bool,
) -> ResourcePermissions:
    permissions = permissions_for_actor(
        actor,
        owner=owner,
        grants=grants,
        enforced=True,
    )
    if principal_blocked:
        return permissions.model_copy(update={
            "can_view": False,
            "can_query": False,
            "can_run": False,
            "can_manage": False,
            "can_delete": False,
            "can_share": False,
            "can_publish": False,
        })
    if not resource_locked:
        return permissions
    return permissions.model_copy(update={
        "can_query": False,
        "can_run": False,
        "can_manage": False,
        "can_delete": False,
        "can_share": False,
        "can_publish": False,
    })
