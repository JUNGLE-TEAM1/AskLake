from typing import Any

from sqlalchemy import inspect, select
from sqlalchemy.orm import Session

from app.models.sql import SqlRunModel, SqlRunResultPageModel

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

    def save_result_page(
        self,
        *,
        run_id: str,
        page_index: int,
        columns: list[str],
        rows: list[list[object]],
        byte_size: int,
    ) -> None:
        ensure_sql_schema(self.db)
        page_id = f"{run_id}:{page_index}"
        model = self.db.get(SqlRunResultPageModel, page_id)
        if model is None:
            self.db.add(SqlRunResultPageModel(
                id=page_id,
                run_id=run_id,
                page_index=page_index,
                columns=columns,
                rows=rows,
                byte_size=byte_size,
            ))
        else:
            model.columns = columns
            model.rows = rows
            model.byte_size = byte_size
        self.db.commit()

    def get_result_page(self, run_id: str, page_index: int) -> SqlRunResultPageModel | None:
        ensure_sql_schema(self.db)
        return self.db.scalar(select(SqlRunResultPageModel).where(
            SqlRunResultPageModel.run_id == run_id,
            SqlRunResultPageModel.page_index == page_index,
        ))

    def count_result_pages(self, run_id: str) -> int:
        ensure_sql_schema(self.db)
        return len(self.db.scalars(select(SqlRunResultPageModel.id).where(
            SqlRunResultPageModel.run_id == run_id,
        )).all())

    def total_result_bytes(self, run_id: str) -> int:
        ensure_sql_schema(self.db)
        rows = self.db.scalars(select(SqlRunResultPageModel.byte_size).where(
            SqlRunResultPageModel.run_id == run_id,
        )).all()
        return sum(int(value or 0) for value in rows)

    def count_active_trino_runs_for_actor(self, actor_id: str) -> int:
        ensure_sql_schema(self.db)
        models = self.db.scalars(select(SqlRunModel).where(SqlRunModel.payload["engine"].astext == "trino")).all()
        return sum(
            1
            for model in models
            if str((model.payload or {}).get("submittedByUserId") or (model.payload or {}).get("submittedByName") or "") == actor_id
            and str((model.payload or {}).get("status") or "") in {"queued", "running"}
        )


def ensure_sql_schema(db: Session) -> None:
    bind = db.get_bind()
    bind_key = id(bind)
    if bind_key in _schema_ready_bind_ids:
        return

    with bind.begin() as connection:
        inspector = inspect(connection)
        if "sql_runs" not in inspector.get_table_names():
            SqlRunModel.__table__.create(bind=connection)
        if "sql_run_result_pages" not in inspector.get_table_names():
            SqlRunResultPageModel.__table__.create(bind=connection)

    _schema_ready_bind_ids.add(bind_key)
