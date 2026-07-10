from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import and_, delete, inspect, or_, select, text
from sqlalchemy.orm import Session

from app.models.sql import SqlRunModel, SqlRunResultPageModel

_schema_ready_bind_ids: set[int] = set()


@dataclass(frozen=True)
class TrinoCollectorClaim:
    generation: int
    next_uri: str
    recovered: bool
    run_id: str


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
            model = SqlRunModel(
                id=run_id,
                dataset_id=dataset_id,
                query=query,
                payload=payload,
            )
            self.db.add(model)
        else:
            model.dataset_id = dataset_id
            model.query = query
            model.payload = payload

        if payload.get("engine") == "trino":
            model.collector_next_uri = string_or_none(payload.get("trinoNextUri"))
            if str(payload.get("status") or "") in {"succeeded", "failed", "cancelled"} or not model.collector_next_uri:
                model.collector_owner = None
                model.collector_lease_expires_at = None

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
                row_count=len(rows),
                storage_backend="postgres",
            ))
        else:
            model.columns = columns
            model.rows = rows
            model.byte_size = byte_size
            model.row_count = len(rows)
            model.storage_backend = "postgres"
        self.db.commit()

    def save_result_page_metadata(
        self,
        *,
        run_id: str,
        page_index: int,
        columns: list[str],
        object_key: str,
        row_count: int,
        compressed_bytes: int,
        checksum: str,
        source_next_uri: str | None = None,
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
                rows=[],
                byte_size=compressed_bytes,
                storage_backend="minio",
                object_key=object_key,
                row_count=row_count,
                checksum=checksum,
                source_next_uri=source_next_uri,
            ))
        else:
            model.columns = columns
            model.rows = []
            model.byte_size = compressed_bytes
            model.storage_backend = "minio"
            model.object_key = object_key
            model.row_count = row_count
            model.checksum = checksum
            model.source_next_uri = source_next_uri
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

    def total_result_rows(self, run_id: str) -> int:
        ensure_sql_schema(self.db)
        values = self.db.scalars(select(SqlRunResultPageModel.row_count).where(
            SqlRunResultPageModel.run_id == run_id,
        )).all()
        return sum(int(value or 0) for value in values)

    def get_result_page_by_source_uri(self, run_id: str, source_next_uri: str) -> SqlRunResultPageModel | None:
        ensure_sql_schema(self.db)
        return self.db.scalar(select(SqlRunResultPageModel).where(
            SqlRunResultPageModel.run_id == run_id,
            SqlRunResultPageModel.source_next_uri == source_next_uri,
        ))

    def total_result_bytes(self, run_id: str) -> int:
        ensure_sql_schema(self.db)
        rows = self.db.scalars(select(SqlRunResultPageModel.byte_size).where(
            SqlRunResultPageModel.run_id == run_id,
        )).all()
        return sum(int(value or 0) for value in rows)

    def list_result_pages(self, run_id: str) -> list[SqlRunResultPageModel]:
        ensure_sql_schema(self.db)
        return list(self.db.scalars(select(SqlRunResultPageModel).where(
            SqlRunResultPageModel.run_id == run_id,
        ).order_by(SqlRunResultPageModel.page_index.asc())).all())

    def delete_result_pages(self, run_id: str) -> int:
        ensure_sql_schema(self.db)
        result = self.db.execute(delete(SqlRunResultPageModel).where(
            SqlRunResultPageModel.run_id == run_id,
        ))
        self.db.commit()
        return int(result.rowcount or 0)

    def list_trino_run_payloads(self, *, actor_id: str | None = None, actor_name: str | None = None, limit: int = 20) -> list[dict[str, Any]]:
        ensure_sql_schema(self.db)
        conditions = [SqlRunModel.payload["engine"].astext == "trino"]
        if actor_id:
            actor_condition = SqlRunModel.payload["submittedByUserId"].astext == actor_id
            if actor_name:
                actor_condition = or_(
                    actor_condition,
                    and_(
                        SqlRunModel.payload["submittedByUserId"].astext.is_(None),
                        SqlRunModel.payload["submittedByName"].astext == actor_name,
                    ),
                )
            conditions.append(actor_condition)
        if actor_name:
            if not actor_id:
                conditions.append(SqlRunModel.payload["submittedByName"].astext == actor_name)
        models = self.db.scalars(
            select(SqlRunModel)
            .where(*conditions)
            .order_by(SqlRunModel.created_at.desc(), SqlRunModel.id.desc())
            .limit(max(1, min(limit, 50)))
        ).all()
        return [model.payload for model in models]

    def claim_next_trino_run(self, worker_id: str, lease_seconds: int) -> TrinoCollectorClaim | None:
        """Claim one active run. Expired leases are intentionally recoverable."""
        ensure_sql_schema(self.db)
        now = datetime.now(timezone.utc)
        statement = (
            select(SqlRunModel)
            .where(
                SqlRunModel.collector_next_uri.is_not(None),
                or_(
                    SqlRunModel.collector_lease_expires_at.is_(None),
                    SqlRunModel.collector_lease_expires_at < now,
                ),
                or_(
                    SqlRunModel.collector_next_attempt_at.is_(None),
                    SqlRunModel.collector_next_attempt_at <= now,
                ),
            )
            .order_by(SqlRunModel.created_at.asc())
            .with_for_update(skip_locked=True)
        )
        model = self.db.scalar(statement)
        if model is None:
            self.db.rollback()
            return None
        payload = model.payload or {}
        if payload.get("engine") != "trino" or str(payload.get("status") or "") not in {"queued", "running"}:
            self.db.rollback()
            return None
        next_uri = string_or_none(model.collector_next_uri)
        if not next_uri:
            self.db.rollback()
            return None
        recovered = model.collector_lease_expires_at is not None
        model.collector_owner = worker_id
        model.collector_lease_expires_at = now + timedelta(seconds=lease_seconds)
        model.collector_next_attempt_at = None
        self.db.commit()
        return TrinoCollectorClaim(generation=model.collector_generation, next_uri=next_uri, recovered=recovered, run_id=model.id)

    def renew_trino_collector_lease(self, run_id: str, worker_id: str, generation: int, lease_seconds: int) -> bool:
        ensure_sql_schema(self.db)
        model = self._fresh_run_model(run_id)
        if model is None or model.collector_owner != worker_id or model.collector_generation != generation:
            return False
        model.collector_lease_expires_at = datetime.now(timezone.utc) + timedelta(seconds=lease_seconds)
        self.db.commit()
        return True

    def release_trino_collector_lease(self, run_id: str, worker_id: str, generation: int) -> None:
        ensure_sql_schema(self.db)
        model = self._fresh_run_model(run_id)
        if model is None or model.collector_owner != worker_id or model.collector_generation != generation:
            return
        model.collector_owner = None
        model.collector_lease_expires_at = None
        self.db.commit()

    def save_collector_run_payload(self, payload: dict[str, Any], *, worker_id: str, generation: int) -> bool:
        """Persist collector progress only while the exact lease generation remains active."""
        ensure_sql_schema(self.db)
        model = self._fresh_run_model(str(payload["runId"]))
        if (
            model is None
            or model.collector_owner != worker_id
            or model.collector_generation != generation
            or str((model.payload or {}).get("status") or "") not in {"queued", "running"}
        ):
            self.db.rollback()
            return False
        model.payload = payload
        model.dataset_id = str(payload.get("datasetId") or payload.get("baseDatasetId") or model.dataset_id)
        model.query = str(payload.get("query") or model.query)
        model.collector_next_uri = string_or_none(payload.get("trinoNextUri"))
        model.collector_attempt_count = 0
        model.collector_next_attempt_at = None
        if str(payload.get("status") or "") in {"succeeded", "failed", "cancelled"} or not model.collector_next_uri:
            model.collector_owner = None
            model.collector_lease_expires_at = None
        self.db.commit()
        return True

    def schedule_collector_retry(self, run_id: str, *, worker_id: str, generation: int) -> tuple[int, datetime] | None:
        ensure_sql_schema(self.db)
        model = self._fresh_run_model(run_id)
        if model is None or model.collector_owner != worker_id or model.collector_generation != generation:
            self.db.rollback()
            return None
        attempt = int(model.collector_attempt_count or 0) + 1
        backoff_seconds = (5, 15, 60, 300)[min(attempt - 1, 3)]
        next_attempt_at = datetime.now(timezone.utc) + timedelta(seconds=backoff_seconds)
        model.collector_attempt_count = attempt
        model.collector_next_attempt_at = next_attempt_at
        model.collector_owner = None
        model.collector_lease_expires_at = None
        self.db.commit()
        return attempt, next_attempt_at

    def cancel_trino_run_payload(self, payload: dict[str, Any]) -> bool:
        """Fence an in-flight collector before the caller cancels Trino and removes objects."""
        ensure_sql_schema(self.db)
        model = self._fresh_run_model(str(payload["runId"]))
        if model is None or str((model.payload or {}).get("status") or "") not in {"queued", "running"}:
            self.db.rollback()
            return False
        model.payload = payload
        model.collector_generation = int(model.collector_generation or 0) + 1
        model.collector_owner = None
        model.collector_lease_expires_at = None
        model.collector_next_uri = None
        model.collector_next_attempt_at = None
        self.db.commit()
        return True

    def _fresh_run_model(self, run_id: str) -> SqlRunModel | None:
        return self.db.scalar(
            select(SqlRunModel)
            .where(SqlRunModel.id == run_id)
            .execution_options(populate_existing=True)
        )

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
        else:
            existing_run_columns = {column["name"] for column in inspector.get_columns("sql_runs")}
            run_column_defs = {
                "collector_owner": "TEXT",
                "collector_lease_expires_at": "TIMESTAMP WITH TIME ZONE",
                "collector_next_uri": "TEXT",
                "collector_generation": "INTEGER NOT NULL DEFAULT 0",
                "collector_attempt_count": "INTEGER NOT NULL DEFAULT 0",
                "collector_next_attempt_at": "TIMESTAMP WITH TIME ZONE",
            }
            for column_name, column_type in run_column_defs.items():
                if column_name not in existing_run_columns:
                    connection.execute(text(f"ALTER TABLE sql_runs ADD COLUMN {column_name} {column_type}"))
        if "sql_run_result_pages" not in inspector.get_table_names():
            SqlRunResultPageModel.__table__.create(bind=connection)
        else:
            existing_columns = {column["name"] for column in inspector.get_columns("sql_run_result_pages")}
            column_defs = {
                "storage_backend": "TEXT",
                "object_key": "TEXT",
                "row_count": "INTEGER",
                "checksum": "TEXT",
                "source_next_uri": "TEXT",
            }
            for column_name, column_type in column_defs.items():
                if column_name not in existing_columns:
                    connection.execute(text(f"ALTER TABLE sql_run_result_pages ADD COLUMN {column_name} {column_type}"))
        connection.execute(text("CREATE INDEX IF NOT EXISTS ix_sql_runs_collector_claim ON sql_runs (collector_next_uri, collector_lease_expires_at, collector_next_attempt_at)"))
        connection.execute(text("CREATE INDEX IF NOT EXISTS ix_sql_run_result_pages_source_uri ON sql_run_result_pages (run_id, source_next_uri)"))

    _schema_ready_bind_ids.add(bind_key)


def string_or_none(value: object) -> str | None:
    normalized = str(value or "").strip()
    return normalized or None
