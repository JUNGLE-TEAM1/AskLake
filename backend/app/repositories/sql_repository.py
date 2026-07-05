from typing import Any

from sqlalchemy.orm import Session

from app.models.sql import SqlRunModel


class SqlRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def get_run_payload(self, run_id: str) -> dict[str, Any] | None:
        model = self.db.get(SqlRunModel, run_id)
        return model.payload if model else None

    def save_run_payload(self, payload: dict[str, Any]) -> dict[str, Any]:
        run_id = str(payload["runId"])
        dataset_id = str(payload["datasetId"])
        query = str(payload["query"])
        model = self.db.get(SqlRunModel, run_id)

        if model is None:
            self.db.add(
                SqlRunModel(
                    id=run_id,
                    dataset_id=dataset_id,
                    query=query,
                    payload=payload,
                )
            )
        else:
            model.dataset_id = dataset_id
            model.query = query
            model.payload = payload

        self.db.flush()
        return payload
