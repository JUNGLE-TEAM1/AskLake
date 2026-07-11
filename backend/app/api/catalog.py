from typing import Annotated, Any

from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext, get_actor_context
from app.core.database import get_db
from app.repositories.catalog_repository import CatalogRepository
from app.repositories.sql_repository import SqlRepository
from app.schemas.catalog import (
    CatalogDatasetListResponse,
    CatalogDatasetResponse,
    CreateDerivedDatasetRequest,
    CreateDerivedDatasetResponse,
    DeleteMaterializationRunResponse,
    LineageGraphResponse,
)
from app.services.catalog_service import CatalogService
from app.services import etl_service
from app.services.lake_storage_service import LocalLakeStorageService

router = APIRouter(prefix="/catalog", tags=["catalog"])


def get_catalog_service(db: Annotated[Session, Depends(get_db)]) -> CatalogService:
    return CatalogService(
        lake_storage=LocalLakeStorageService(),
        repository=CatalogRepository(db),
        sql_repository=SqlRepository(db),
    )


@router.get("/datasets", response_model=CatalogDatasetListResponse)
def list_datasets(
    service: Annotated[CatalogService, Depends(get_catalog_service)],
    actor: Annotated[ActorContext, Depends(get_actor_context)],
) -> CatalogDatasetListResponse:
    return service.list_datasets(actor)


@router.get("/models")
def list_model_artifacts(
    actor: Annotated[ActorContext, Depends(get_actor_context)],
) -> list[dict[str, Any]]:
    # Resolve the actor before returning registry metadata so this endpoint follows the normal session path.
    _ = actor
    return etl_service.list_text_structuring_models()


@router.get("/datasets/{dataset_id}", response_model=CatalogDatasetResponse)
def get_dataset(
    dataset_id: str,
    service: Annotated[CatalogService, Depends(get_catalog_service)],
    actor: Annotated[ActorContext, Depends(get_actor_context)],
) -> CatalogDatasetResponse:
    return service.get_dataset(dataset_id, actor)


@router.get("/datasets/{dataset_id}/lineage", response_model=LineageGraphResponse)
def get_dataset_lineage(
    dataset_id: str,
    service: Annotated[CatalogService, Depends(get_catalog_service)],
    actor: Annotated[ActorContext, Depends(get_actor_context)],
) -> LineageGraphResponse:
    return service.get_dataset_lineage(dataset_id, actor)


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
