from __future__ import annotations

from typing import TYPE_CHECKING

from app.core.auth_context import ActorContext, require_permission
from app.schemas.catalog import (
    CatalogDatasetFilterValue,
    CatalogDatasetFilterValuesRequest,
    CatalogDatasetFilterValuesResponse,
)
from app.services.dashboard_physical_data import DashboardDatasetQuerySession
from app.services.governance_enforcement import require_governed_access

if TYPE_CHECKING:
    from app.services.catalog_service import CatalogService


def query_catalog_dataset_filter_values(
    service: CatalogService,
    dataset_id: str,
    request: CatalogDatasetFilterValuesRequest,
    actor: ActorContext | None = None,
) -> CatalogDatasetFilterValuesResponse:
    from app.services.catalog_service import dataset_for_latest_successful_materialization

    actor_context = actor or ActorContext()
    dataset = service.get_dataset(dataset_id, actor_context)
    api_path = f"/api/catalog/datasets/{dataset_id}/filter-values/query"
    require_governed_access(
        service.repository.db,
        actor_context,
        action="query",
        api_path=api_path,
        http_method="POST",
        metadata={"column": request.column, "owner": dataset.owner},
        resource_id=dataset.id,
        resource_name=dataset.name,
        resource_type="dataset",
    )
    require_permission(
        actor_context,
        "query",
        owner=dataset.owner,
        grants=dataset.permission_grants,
        resource_label="dataset",
    )
    session = DashboardDatasetQuerySession(
        dataset_for_latest_successful_materialization(dataset)
    )
    try:
        result = session.read_filter_values(
            request.column,
            context_filters=[
                item.model_dump(by_alias=True, exclude_none=True, mode="json")
                for item in request.context_filters
            ],
            search=request.search,
            limit=request.limit,
        )
    finally:
        session.close()
    return CatalogDatasetFilterValuesResponse(
        column=request.column,
        dataset_id=dataset.id,
        truncated=bool(result["truncated"]),
        values=[
            CatalogDatasetFilterValue(label=str(value), value=value)
            for value in result["values"]
        ],
    )
