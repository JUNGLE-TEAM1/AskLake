from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Depends, Query, status
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext, get_actor_context
from app.core.database import get_db
from app.repositories.catalog_repository import CatalogRepository
from app.repositories.sql_repository import SqlRepository
from app.schemas.catalog import (
    CatalogDatasetFilterValuesRequest,
    CatalogDatasetFilterValuesResponse,
    CatalogDatasetDeletionAcceptedResponse,
    CatalogDatasetDeletionImpact,
    CatalogDatasetDeletionStatusResponse,
    CatalogDatasetListResponse,
    CatalogDatasetRowsResponse,
    CatalogDatasetResponse,
    CreateDerivedDatasetRequest,
    CreateDerivedDatasetResponse,
    DeleteMaterializationRunResponse,
    LineageGraphResponse,
    VerifyCatalogUniqueKeyRequest,
    VerifyCatalogUniqueKeyResponse,
)
from app.application.catalog_dataset_deletion import (
    CatalogDatasetDeletionService,
    process_catalog_dataset_deletion_by_id,
)
from app.schemas.trino import TrinoMaterializationRunResponse
from app.services.catalog_service import CatalogService
from app.services.catalog_filter_values_service import query_catalog_dataset_filter_values
from app.services.lake_storage_service import LocalLakeStorageService
from app.services.trino_materialization_service import TrinoMaterializationService

router = APIRouter(prefix="/catalog", tags=["catalog"])


def get_catalog_service(db: Annotated[Session, Depends(get_db)]) -> CatalogService:
    return CatalogService(
        lake_storage=LocalLakeStorageService(),
        repository=CatalogRepository(db),
        sql_repository=SqlRepository(db),
    )


def get_trino_materialization_service(db: Annotated[Session, Depends(get_db)]) -> TrinoMaterializationService:
    return TrinoMaterializationService(SqlRepository(db), CatalogRepository(db))


def get_catalog_dataset_deletion_service(
    db: Annotated[Session, Depends(get_db)],
) -> CatalogDatasetDeletionService:
    return CatalogDatasetDeletionService(db)


@router.get("/datasets", response_model=CatalogDatasetListResponse)
def list_datasets(
    service: Annotated[CatalogService, Depends(get_catalog_service)],
    actor: Annotated[ActorContext, Depends(get_actor_context)],
) -> CatalogDatasetListResponse:
    return service.list_datasets(actor)


@router.get("/datasets/{dataset_id}", response_model=CatalogDatasetResponse)
def get_dataset(
    dataset_id: str,
    service: Annotated[CatalogService, Depends(get_catalog_service)],
    actor: Annotated[ActorContext, Depends(get_actor_context)],
) -> CatalogDatasetResponse:
    return service.get_dataset(dataset_id, actor)


@router.get(
    "/datasets/{dataset_id}/deletion-impact",
    response_model=CatalogDatasetDeletionImpact,
)
def get_dataset_deletion_impact(
    dataset_id: str,
    service: Annotated[CatalogDatasetDeletionService, Depends(get_catalog_dataset_deletion_service)],
    actor: Annotated[ActorContext, Depends(get_actor_context)],
) -> CatalogDatasetDeletionImpact:
    return service.impact(dataset_id, actor)


@router.delete(
    "/datasets/{dataset_id}",
    response_model=CatalogDatasetDeletionAcceptedResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
def delete_dataset(
    dataset_id: str,
    background_tasks: BackgroundTasks,
    service: Annotated[CatalogDatasetDeletionService, Depends(get_catalog_dataset_deletion_service)],
    actor: Annotated[ActorContext, Depends(get_actor_context)],
    confirm_name: Annotated[str, Query(alias="confirmName", min_length=1, max_length=255)],
) -> CatalogDatasetDeletionAcceptedResponse:
    response = service.request(dataset_id, actor, confirm_name=confirm_name)
    background_tasks.add_task(process_catalog_dataset_deletion_by_id, response.deletion_id)
    return response


@router.get(
    "/dataset-deletions/{deletion_id}",
    response_model=CatalogDatasetDeletionStatusResponse,
)
def get_dataset_deletion_status(
    deletion_id: str,
    service: Annotated[CatalogDatasetDeletionService, Depends(get_catalog_dataset_deletion_service)],
    actor: Annotated[ActorContext, Depends(get_actor_context)],
) -> CatalogDatasetDeletionStatusResponse:
    return service.status(deletion_id, actor)


@router.get("/datasets/{dataset_id}/rows", response_model=CatalogDatasetRowsResponse)
def get_dataset_rows(
    dataset_id: str,
    service: Annotated[CatalogService, Depends(get_catalog_service)],
    actor: Annotated[ActorContext, Depends(get_actor_context)],
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> CatalogDatasetRowsResponse:
    return service.get_dataset_rows(dataset_id, actor, limit=limit, offset=offset)


@router.post(
    "/datasets/{dataset_id}/filter-values/query",
    response_model=CatalogDatasetFilterValuesResponse,
)
def query_dataset_filter_values(
    dataset_id: str,
    request: CatalogDatasetFilterValuesRequest,
    service: Annotated[CatalogService, Depends(get_catalog_service)],
    actor: Annotated[ActorContext, Depends(get_actor_context)],
) -> CatalogDatasetFilterValuesResponse:
    return query_catalog_dataset_filter_values(service, dataset_id, request, actor)


@router.get("/datasets/{dataset_id}/lineage", response_model=LineageGraphResponse)
def get_dataset_lineage(
    dataset_id: str,
    service: Annotated[CatalogService, Depends(get_catalog_service)],
    actor: Annotated[ActorContext, Depends(get_actor_context)],
) -> LineageGraphResponse:
    return service.get_dataset_lineage(dataset_id, actor)


@router.post(
    "/datasets/{dataset_id}/unique-keys/verify-and-register",
    response_model=VerifyCatalogUniqueKeyResponse,
)
def verify_and_register_dataset_unique_key(
    dataset_id: str,
    request: VerifyCatalogUniqueKeyRequest,
    service: Annotated[CatalogService, Depends(get_catalog_service)],
    actor: Annotated[ActorContext, Depends(get_actor_context)],
) -> VerifyCatalogUniqueKeyResponse:
    return service.verify_and_register_unique_key(dataset_id, request, actor)


@router.delete(
    "/datasets/{dataset_id}/materialization-runs/{run_id}",
    response_model=DeleteMaterializationRunResponse,
)
def delete_materialization_run(
    dataset_id: str,
    run_id: str,
    service: Annotated[CatalogService, Depends(get_catalog_service)],
    actor: Annotated[ActorContext, Depends(get_actor_context)],
) -> DeleteMaterializationRunResponse:
    return service.delete_materialization_run(dataset_id, run_id, actor)


@router.post(
    "/derived-datasets",
    response_model=CreateDerivedDatasetResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_derived_dataset(
    request: CreateDerivedDatasetRequest,
    service: Annotated[CatalogService, Depends(get_catalog_service)],
    actor: Annotated[ActorContext, Depends(get_actor_context)],
) -> CatalogDatasetResponse:
    return service.create_derived_dataset(request, actor)


@router.post("/trino-runs/{run_id}/materializations", response_model=TrinoMaterializationRunResponse, status_code=status.HTTP_202_ACCEPTED)
def create_trino_materialization(
    run_id: str,
    request: CreateDerivedDatasetRequest,
    service: Annotated[TrinoMaterializationService, Depends(get_trino_materialization_service)],
    actor: Annotated[ActorContext, Depends(get_actor_context)],
) -> TrinoMaterializationRunResponse:
    return service.submit(run_id, request, actor)


@router.get("/trino-materializations/{materialization_id}", response_model=TrinoMaterializationRunResponse)
def get_trino_materialization(
    materialization_id: str,
    service: Annotated[TrinoMaterializationService, Depends(get_trino_materialization_service)],
    actor: Annotated[ActorContext, Depends(get_actor_context)],
) -> TrinoMaterializationRunResponse:
    return service.refresh(materialization_id, actor)
