from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.catalog import CatalogDatasetModel


class CatalogRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def list_dataset_models(self) -> list[CatalogDatasetModel]:
        result = self.db.execute(
            select(CatalogDatasetModel).order_by(
                CatalogDatasetModel.updated_at.desc(),
                CatalogDatasetModel.id.asc(),
            )
        )
        return list(result.scalars().all())

    def get_dataset_model(self, dataset_id: str) -> CatalogDatasetModel | None:
        return self.db.get(CatalogDatasetModel, dataset_id)

    def get_dataset_payload(self, dataset_id: str) -> dict[str, Any] | None:
        model = self.get_dataset_model(dataset_id)
        return model.payload if model else None

    def get_lineage_payload(self, dataset_id: str) -> dict[str, Any] | None:
        payload = self.get_dataset_payload(dataset_id)
        lineage_graph = payload.get("lineageGraph") if payload else None
        return lineage_graph if isinstance(lineage_graph, dict) else None

    def save_dataset_payload(self, payload: dict[str, Any]) -> dict[str, Any]:
        dataset_id = str(payload["id"])
        model = self.get_dataset_model(dataset_id)

        if model is None:
            self.db.add(CatalogDatasetModel(id=dataset_id, payload=payload))
        else:
            model.payload = payload

        self.db.flush()
        return payload
