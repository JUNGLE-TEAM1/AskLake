from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.schemas.etl import CatalogDataset
from app.services import etl_service

router = APIRouter(prefix="/catalog", tags=["catalog"])


@router.get("/datasets", response_model=list[CatalogDataset])
def list_datasets(db: Session = Depends(get_db)) -> list[CatalogDataset]:
    return etl_service.list_datasets(db)


@router.get("/datasets/{dataset_id}", response_model=CatalogDataset)
def get_dataset(dataset_id: str, db: Session = Depends(get_db)) -> CatalogDataset:
    return etl_service.get_dataset(db, dataset_id)
