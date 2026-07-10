from typing import Any

from sqlalchemy import inspect
from sqlalchemy.orm import Session

from app.models.sql import SqlRunModel

_schema_ready_bind_ids: set[int] = set()


class SqlRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def get_run_payload(self, run_id: str) -> dict[str, Any] | None:
        ensure_sql_schema(self.db)
        model = self.db.get(SqlRunModel, run_id)
        return model.payload if model else None

    def save_run_payload(self, payload: dict[str, Any]) -> dict[str, Any]:
        ensure_sql_schema(self.db)
        run_id = str(payload["runId"])
        dataset_id = str(payload.get("datasetId") or payload.get("baseDatasetId") or "")
        if not dataset_id:
            raise ValueError("SQL run payload requires datasetId or baseDatasetId")
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
        self.db.commit()
        return payload


def ensure_sql_schema(db: Session) -> None:
    bind = db.get_bind()
    bind_key = id(bind)
    if bind_key in _schema_ready_bind_ids:
        return

    with bind.begin() as connection:
        inspector = inspect(connection)
        if "sql_runs" not in inspector.get_table_names():
            SqlRunModel.__table__.create(bind=connection)

    _schema_ready_bind_ids.add(bind_key)
