from fastapi import status

from app.core.errors import ApiError
from app.repositories.catalog_repository import CatalogRepository
from app.schemas.catalog import (
    CatalogDatasetListResponse,
    CatalogDatasetResponse,
    CreateDerivedDatasetRequest,
    LineageGraphResponse,
)
from app.schemas.common import CursorPageMeta, ErrorCode


class CatalogService:
    def __init__(self, repository: CatalogRepository) -> None:
        self.repository = repository

    def list_datasets(self) -> CatalogDatasetListResponse:
        datasets = [
            CatalogDatasetResponse.model_validate(model.payload)
            for model in self.repository.list_dataset_models()
        ]
        return CatalogDatasetListResponse(
            datasets=datasets,
            page=CursorPageMeta(cursor=None, has_next=False),
        )

    def get_dataset(self, dataset_id: str) -> CatalogDatasetResponse:
        payload = self.repository.get_dataset_payload(dataset_id)
        if payload is None:
            raise ApiError(ErrorCode.NOT_FOUND, "Dataset not found", status.HTTP_404_NOT_FOUND)
        return CatalogDatasetResponse.model_validate(payload)

    def get_dataset_lineage(self, dataset_id: str) -> LineageGraphResponse:
        lineage_payload = self.repository.get_lineage_payload(dataset_id)
        if lineage_payload is None:
            raise ApiError(ErrorCode.NOT_FOUND, "Dataset lineage not found", status.HTTP_404_NOT_FOUND)
        return LineageGraphResponse.model_validate(lineage_payload)

    def create_derived_dataset(self, _: CreateDerivedDatasetRequest) -> CatalogDatasetResponse:
        raise NotImplementedError(
            "Derived dataset persistence will be implemented in the Pair2 derived dataset API PR."
        )
