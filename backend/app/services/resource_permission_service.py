from typing import Any

from sqlalchemy.orm import Session

from app.core.permission_metadata import dedupe_grants
from app.repositories.permission_repository import list_permission_grants_by_resource
from app.schemas.catalog import CatalogDatasetResponse
from app.schemas.permissions import PermissionGrant


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
        for grant in group
    ]
    return parse_permission_grants(dedupe_grants(payloads))
