from fastapi import APIRouter, Depends, status
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext, get_actor_context
from app.core.database import get_db
from app.core.errors import ApiError
from app.repositories.catalog_repository import CatalogRepository
from app.repositories.dashboard_live_repository import (
    DEFAULT_DASHBOARD_POLL_MS,
    DashboardLiveRepository,
    recommended_dashboard_poll_ms,
)
from app.repositories.dashboard_runtime_repository import DashboardRuntimeRepository
from app.schemas.catalog import CatalogDatasetResponse
from app.schemas.common import ErrorCode
from app.schemas.dashboard import (
    DashboardWidgetQueryRequest,
    DashboardWidgetQueryResponse,
    DatasetFreshnessQueryRequest,
    DatasetFreshnessQueryResponse,
    DatasetFreshnessResponse,
)
from app.services.dashboard_dataset_access import require_dashboard_dataset_query_access
from app.services.dashboard_runtime_service import DashboardRuntimeService
from app.services.resource_permission_service import dataset_with_persisted_permission_grants


router = APIRouter(tags=["dashboard-live"])


def dataset_freshness_response(
    db: Session,
    dataset_id: str,
    actor: ActorContext,
    *,
    api_path: str,
    http_method: str,
    catalog_repository: CatalogRepository,
    live_repository: DashboardLiveRepository,
) -> DatasetFreshnessResponse:
    payload = catalog_repository.get_dataset_payload(dataset_id)
    if payload is None:
        raise ApiError(
            ErrorCode.NOT_FOUND,
            "Dataset not found.",
            status.HTTP_404_NOT_FOUND,
            {"datasetId": dataset_id},
        )
    try:
        dataset = dataset_with_persisted_permission_grants(
            db,
            CatalogDatasetResponse.model_validate(payload),
        )
    except ValidationError as exc:
        raise ApiError(
            ErrorCode.SERVICE_UNAVAILABLE,
            "Dataset metadata is unavailable.",
            status.HTTP_503_SERVICE_UNAVAILABLE,
            {"datasetId": dataset_id},
        ) from exc
    require_dashboard_dataset_query_access(
        db,
        actor,
        dataset,
        api_path=api_path,
        http_method=http_method,
    )

    freshness = live_repository.get_freshness(dataset_id)
    continuous_job = live_repository.continuous_job_by_dataset(dataset_id)
    is_continuous = continuous_job is not None
    next_check_after_ms = (
        recommended_dashboard_poll_ms(
            (continuous_job.continuous_config or {}).get("triggerIntervalSeconds")
        )
        if continuous_job is not None
        else int(freshness.next_check_after_ms) if freshness is not None
        else DEFAULT_DASHBOARD_POLL_MS
    )
    return DatasetFreshnessResponse(
        dataset_id=dataset_id,
        is_continuous=is_continuous,
        latest_revision=int(freshness.latest_revision or 0) if freshness is not None else 0,
        updated_at=(
            freshness.updated_at.isoformat()
            if freshness is not None and freshness.updated_at is not None
            else None
        ),
        next_check_after_ms=next_check_after_ms,
        binding_epoch=int(freshness.binding_epoch or 0) if freshness is not None else 0,
        active_serving_engine=(freshness.active_serving_engine if freshness is not None else None),
        active_serving_version_id=(
            freshness.active_serving_version_id if freshness is not None else None
        ),
        active_archive_snapshot_id=(
            freshness.active_archive_snapshot_id if freshness is not None else None
        ),
        latest_source_boundary=(
            dict(freshness.latest_source_boundary or {})
            if freshness is not None and freshness.latest_source_boundary is not None
            else None
        ),
        latest_checksum=(freshness.latest_checksum if freshness is not None else None),
        latest_mutation_type=(
            freshness.latest_mutation_type if freshness is not None else None
        ),
    )


@router.get("/datasets/{dataset_id}/freshness", response_model=DatasetFreshnessResponse)
def get_dataset_freshness(
    dataset_id: str,
    actor: ActorContext = Depends(get_actor_context),
    db: Session = Depends(get_db),
) -> DatasetFreshnessResponse:
    return dataset_freshness_response(
        db,
        dataset_id,
        actor,
        api_path=f"/api/datasets/{dataset_id}/freshness",
        http_method="GET",
        catalog_repository=CatalogRepository(db),
        live_repository=DashboardLiveRepository(db, ensure_schema=False),
    )


@router.post("/datasets/freshness/query", response_model=DatasetFreshnessQueryResponse)
def query_dataset_freshness(
    request: DatasetFreshnessQueryRequest,
    actor: ActorContext = Depends(get_actor_context),
    db: Session = Depends(get_db),
) -> DatasetFreshnessQueryResponse:
    catalog_repository = CatalogRepository(db)
    live_repository = DashboardLiveRepository(db, ensure_schema=False)
    dataset_ids = list(dict.fromkeys(request.dataset_ids))
    datasets: list[DatasetFreshnessResponse] = []
    for dataset_id in dataset_ids:
        try:
            datasets.append(dataset_freshness_response(
                db,
                dataset_id,
                actor,
                api_path="/api/datasets/freshness/query",
                http_method="POST",
                catalog_repository=catalog_repository,
                live_repository=live_repository,
            ))
        except ApiError:
            # One removed, malformed, or newly forbidden dataset must not stop
            # unrelated widgets in the same dashboard from refreshing. The
            # omitted dataset is retried on its next normal polling interval.
            continue
    return DatasetFreshnessQueryResponse(datasets=datasets)


@router.post("/dashboards/{dashboard_id}/widgets/query", response_model=DashboardWidgetQueryResponse)
def query_published_dashboard_widgets(
    dashboard_id: str,
    request: DashboardWidgetQueryRequest,
    actor: ActorContext = Depends(get_actor_context),
    db: Session = Depends(get_db),
) -> DashboardWidgetQueryResponse:
    live_repository = DashboardLiveRepository(db, ensure_schema=False)
    service = DashboardRuntimeService(
        DashboardRuntimeRepository(db),
        CatalogRepository(db),
        live_repository,
        # The published runtime GET is intentionally read-only and can return
        # pending while a result is absent. This explicit widget-query action
        # is the bounded calculation path that must materialize that result.
        prepared_live_results_only=False,
    )
    return DashboardWidgetQueryResponse(
        widgets=service.query_widgets(
            dashboard_id,
            request.widget_ids,
            request.mode,
            actor,
        )
    )
