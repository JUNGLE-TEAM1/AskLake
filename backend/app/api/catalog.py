from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.schemas.etl import CatalogDataset, CreateDerivedDatasetRequest
from app.services import etl_service

router = APIRouter(prefix="/catalog", tags=["catalog"])


@router.get("/datasets", response_model=list[CatalogDataset])
def list_datasets(db: Session = Depends(get_db)) -> list[CatalogDataset]:
    return etl_service.list_datasets(db)


@router.post("/derived-datasets", response_model=CatalogDataset, status_code=201)
def create_derived_dataset(request: CreateDerivedDatasetRequest, db: Session = Depends(get_db)) -> CatalogDataset:
    return etl_service.create_derived_dataset(db, request)


@router.get("/datasets/{dataset_id}", response_model=CatalogDataset)
def get_dataset(dataset_id: str, db: Session = Depends(get_db)) -> CatalogDataset:
    return etl_service.get_dataset(db, dataset_id)


@router.get("/datasets/{dataset_id}/lineage", response_model=dict)
def get_dataset_lineage(dataset_id: str, db: Session = Depends(get_db)) -> dict:
    return etl_service.get_dataset_lineage(db, dataset_id)
