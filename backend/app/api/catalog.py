from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.repositories.catalog_repository import CatalogRepository
from app.schemas.catalog import (
    CatalogDatasetListResponse,
    CatalogDatasetResponse,
    LineageGraphResponse,
)
from app.services.catalog_service import CatalogService

router = APIRouter(prefix="/catalog", tags=["catalog"])


def get_catalog_service(db: Annotated[Session, Depends(get_db)]) -> CatalogService:
    return CatalogService(CatalogRepository(db))


@router.get("/datasets", response_model=CatalogDatasetListResponse)
def list_datasets(
    service: Annotated[CatalogService, Depends(get_catalog_service)],
) -> CatalogDatasetListResponse:
    return service.list_datasets()


@router.get("/datasets/{dataset_id}", response_model=CatalogDatasetResponse)
def get_dataset(
    dataset_id: str,
    service: Annotated[CatalogService, Depends(get_catalog_service)],
) -> CatalogDatasetResponse:
    return service.get_dataset(dataset_id)


@router.get("/datasets/{dataset_id}/lineage", response_model=LineageGraphResponse)
def get_dataset_lineage(
    dataset_id: str,
    service: Annotated[CatalogService, Depends(get_catalog_service)],
) -> LineageGraphResponse:
    return service.get_dataset_lineage(dataset_id)
