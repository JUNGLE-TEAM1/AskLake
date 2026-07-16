from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from sqlalchemy import and_, delete, func, inspect, or_, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.sql import SqlRunModel, SqlRunResultPageModel

_schema_ready_bind_ids: set[int] = set()


@dataclass(frozen=True)
class TrinoCollectorClaim:
    engine: str
    generation: int
    next_uri: str
    recovered: bool
    run_id: str


@dataclass(frozen=True)
class TrinoSubmissionReservation:
    outcome: Literal["created", "existing", "conflict", "limit"]
    payload: dict[str, Any] | None = None


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

        model.actor_key = string_or_none(payload.get("actorKey")) or model.actor_key
        model.client_request_id = string_or_none(payload.get("clientRequestId")) or model.client_request_id
        model.request_fingerprint = string_or_none(payload.get("requestFingerprint")) or model.request_fingerprint

        if payload.get("engine") in {"trino", "trino-materialization", "trino-job-materialization"}:
            model.collector_next_uri = string_or_none(payload.get("trinoNextUri"))
            if str(payload.get("status") or "") in {"succeeded", "failed", "cancelled"} or not model.collector_next_uri:
                model.collector_owner = None
                model.collector_lease_expires_at = None

        self.db.flush()
        self.db.commit()
        return payload

    def reserve_trino_submission(
        self,
        payload: dict[str, Any],
        *,
        actor_key: str,
        client_request_id: str | None,
        request_fingerprint: str,
        max_active_runs: int,
    ) -> TrinoSubmissionReservation:
        """Atomically reserve an actor slot before submitting work to Trino."""
        ensure_sql_schema(self.db)
        if self.db.get_bind().dialect.name == "postgresql":
            self.db.execute(
                text("SELECT pg_advisory_xact_lock(hashtextextended(:actor_key, 0))"),
                {"actor_key": actor_key},
            )

        if client_request_id:
            existing = self.db.scalar(
                select(SqlRunModel)
                .where(SqlRunModel.actor_key == actor_key)
                .where(SqlRunModel.client_request_id == client_request_id)
                .with_for_update()
            )
            if existing is not None:
                if existing.request_fingerprint != request_fingerprint:
                    self.db.rollback()
                    return TrinoSubmissionReservation(outcome="conflict")
                existing_payload = dict(existing.payload or {})
                self.db.rollback()
                return TrinoSubmissionReservation(outcome="existing", payload=existing_payload)

        active_count = int(self.db.scalar(
            select(func.count())
            .select_from(SqlRunModel)
            .where(
                or_(
                    SqlRunModel.actor_key == actor_key,
                    and_(
                        SqlRunModel.actor_key.is_(None),
                        or_(
                            SqlRunModel.payload["submittedByUserId"].astext == actor_key,
                            SqlRunModel.payload["submittedByName"].astext == actor_key,
                        ),
                    ),
                ),
                SqlRunModel.payload["engine"].astext == "trino",
                SqlRunModel.payload["status"].astext.in_(["queued", "running"]),
            )
        ) or 0)
        if active_count >= max_active_runs:
            self.db.rollback()
            return TrinoSubmissionReservation(outcome="limit")

        reserved_payload = dict(payload)
        reserved_payload.update({
            "actorKey": actor_key,
            "clientRequestId": client_request_id,
            "requestFingerprint": request_fingerprint,
        })
        model = SqlRunModel(
            id=str(reserved_payload["runId"]),
            dataset_id=str(reserved_payload["baseDatasetId"]),
            query=str(reserved_payload["query"]),
            payload=reserved_payload,
            actor_key=actor_key,
            client_request_id=client_request_id,
            request_fingerprint=request_fingerprint,
        )
        self.db.add(model)
        try:
            self.db.commit()
        except IntegrityError:
            self.db.rollback()
            if not client_request_id:
                raise
            existing = self.db.scalar(
                select(SqlRunModel)
                .where(SqlRunModel.actor_key == actor_key)
                .where(SqlRunModel.client_request_id == client_request_id)
            )
            if existing is None or existing.request_fingerprint != request_fingerprint:
                return TrinoSubmissionReservation(outcome="conflict")
            return TrinoSubmissionReservation(outcome="existing", payload=dict(existing.payload or {}))
        return TrinoSubmissionReservation(outcome="created", payload=reserved_payload)

    def save_result_page(
        self,
        *,
        run_id: str,
        page_index: int,
        columns: list[str],
        rows: list[list[object]],
        byte_size: int,
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
                rows=rows,
                byte_size=byte_size,
                row_count=len(rows),
                storage_backend="postgres",
                source_next_uri=source_next_uri,
            ))
        else:
            model.columns = columns
            model.rows = rows
            model.byte_size = byte_size
            model.row_count = len(rows)
            model.storage_backend = "postgres"
            model.object_key = None
            model.checksum = None
            model.source_next_uri = source_next_uri
        self.db.commit()

    def save_result_page_if_owned(
        self,
        *,
        run_id: str,
        worker_id: str,
        generation: int,
        page_index: int,
        columns: list[str],
        rows: list[list[object]],
        byte_size: int,
        source_next_uri: str,
    ) -> Literal["saved", "duplicate", "fenced"]:
        """Atomically save an inline preview page while the collector lease is valid."""
        ensure_sql_schema(self.db)
        run = self.db.scalar(select(SqlRunModel).where(SqlRunModel.id == run_id).with_for_update())
        now = datetime.now(timezone.utc)
        if (
            run is None
            or run.collector_owner != worker_id
            or run.collector_generation != generation
            or run.collector_lease_expires_at is None
            or run.collector_lease_expires_at <= now
        ):
            self.db.rollback()
            return "fenced"
        duplicate = self.db.scalar(
            select(SqlRunResultPageModel)
            .where(SqlRunResultPageModel.run_id == run_id)
            .where(SqlRunResultPageModel.source_next_uri == source_next_uri)
        )
        if duplicate is not None:
            self.db.rollback()
            return "duplicate"
        self.db.add(SqlRunResultPageModel(
            id=f"{run_id}:{page_index}",
            run_id=run_id,
            page_index=page_index,
            columns=columns,
            rows=rows,
            byte_size=byte_size,
            storage_backend="postgres",
            row_count=len(rows),
            source_next_uri=source_next_uri,
        ))
        try:
            self.db.commit()
        except IntegrityError:
            self.db.rollback()
            return "duplicate"
        return "saved"

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
                storage_backend="s3",
                object_key=object_key,
                row_count=row_count,
                checksum=checksum,
                source_next_uri=source_next_uri,
            ))
        else:
            model.columns = columns
            model.rows = []
            model.byte_size = compressed_bytes
            model.storage_backend = "s3"
            model.object_key = object_key
            model.row_count = row_count
            model.checksum = checksum
            model.source_next_uri = source_next_uri
        self.db.commit()

    def save_result_page_metadata_if_owned(
        self,
        *,
        run_id: str,
        worker_id: str,
        generation: int,
        page_index: int,
        columns: list[str],
        object_key: str,
        row_count: int,
        compressed_bytes: int,
        checksum: str,
        source_next_uri: str,
    ) -> Literal["saved", "duplicate", "fenced"]:
        ensure_sql_schema(self.db)
        run = self.db.scalar(select(SqlRunModel).where(SqlRunModel.id == run_id).with_for_update())
        now = datetime.now(timezone.utc)
        if (
            run is None
            or run.collector_owner != worker_id
            or run.collector_generation != generation
            or run.collector_lease_expires_at is None
            or run.collector_lease_expires_at <= now
        ):
            self.db.rollback()
            return "fenced"
        duplicate = self.db.scalar(
            select(SqlRunResultPageModel)
            .where(SqlRunResultPageModel.run_id == run_id)
            .where(SqlRunResultPageModel.source_next_uri == source_next_uri)
        )
        if duplicate is not None:
            self.db.rollback()
            return "duplicate"
        self.db.add(SqlRunResultPageModel(
            id=f"{run_id}:{page_index}",
            run_id=run_id,
            page_index=page_index,
            columns=columns,
            rows=[],
            byte_size=compressed_bytes,
            storage_backend="s3",
            object_key=object_key,
            row_count=row_count,
            checksum=checksum,
            source_next_uri=source_next_uri,
        ))
        try:
            self.db.commit()
        except IntegrityError:
            self.db.rollback()
            return "duplicate"
        return "saved"

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

    def get_latest_full_result_run_payload(self, source_run_id: str) -> dict[str, Any] | None:
        ensure_sql_schema(self.db)
        model = self.db.scalar(
            select(SqlRunModel)
            .where(
                SqlRunModel.payload["engine"].astext == "trino",
                SqlRunModel.payload["mode"].astext == "run",
                SqlRunModel.payload["sourceRunId"].astext == source_run_id,
            )
            .order_by(SqlRunModel.created_at.desc(), SqlRunModel.id.desc())
        )
        return dict(model.payload or {}) if model is not None else None

    def list_terminal_trino_run_payload_batch(
        self,
        *,
        after_run_id: str | None = None,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        ensure_sql_schema(self.db)
        conditions = [
            SqlRunModel.payload["engine"].astext == "trino",
            SqlRunModel.payload["status"].astext.in_(["succeeded", "failed", "cancelled"]),
        ]
        if after_run_id:
            conditions.append(SqlRunModel.id > after_run_id)
        models = self.db.scalars(
            select(SqlRunModel)
            .where(*conditions)
            .order_by(SqlRunModel.id.asc())
            .limit(max(1, min(limit, 500)))
        ).all()
        payloads: list[dict[str, Any]] = []
        for model in models:
            payload = dict(model.payload or {})
            payload.setdefault("runId", model.id)
            payloads.append(payload)
        return payloads

    def claim_next_trino_run(self, worker_id: str, lease_seconds: int) -> TrinoCollectorClaim | None:
        """Claim one active run. Expired leases are intentionally recoverable."""
        ensure_sql_schema(self.db)
        now = datetime.now(timezone.utc)
        statement = (
            select(SqlRunModel)
            .where(
                SqlRunModel.payload["engine"].astext.in_(["trino", "trino-materialization", "trino-job-materialization"]),
                or_(
                    and_(
                        SqlRunModel.collector_next_uri.is_not(None),
                        SqlRunModel.payload["status"].astext.in_(["queued", "running"]),
                    ),
                    and_(
                        SqlRunModel.payload["engine"].astext == "trino-job-materialization",
                        SqlRunModel.payload["status"].astext.in_(["succeeded", "failed", "cancelled"]),
                        or_(
                            SqlRunModel.payload["finalized"].astext.is_(None),
                            SqlRunModel.payload["finalized"].astext != "true",
                        ),
                    ),
                ),
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
        next_uri = string_or_none(model.collector_next_uri)
        terminal_sql_job = (
            payload.get("engine") == "trino-job-materialization"
            and str(payload.get("status") or "") in {"succeeded", "failed", "cancelled"}
            and payload.get("finalized") is not True
        )
        if not next_uri and not terminal_sql_job:
            self.db.rollback()
            return None
        recovered = model.collector_lease_expires_at is not None
        model.collector_generation = int(model.collector_generation or 0) + 1
        model.collector_owner = worker_id
        model.collector_lease_expires_at = now + timedelta(seconds=lease_seconds)
        model.collector_next_attempt_at = None
        self.db.commit()
        return TrinoCollectorClaim(
            engine=str(payload.get("engine") or ""),
            generation=model.collector_generation,
            next_uri=next_uri or "",
            recovered=recovered,
            run_id=model.id,
        )

    def get_active_trino_job_run_payload(self, job_id: str) -> dict[str, Any] | None:
        ensure_sql_schema(self.db)
        model = self.db.scalar(
            select(SqlRunModel)
            .where(
                SqlRunModel.payload["engine"].astext == "trino-job-materialization",
                SqlRunModel.payload["jobId"].astext == job_id,
                SqlRunModel.payload["status"].astext.in_(["queued", "running"]),
            )
            .order_by(SqlRunModel.created_at.desc(), SqlRunModel.id.desc())
        )
        return dict(model.payload or {}) if model is not None else None

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
                "actor_key": "TEXT",
                "client_request_id": "TEXT",
                "request_fingerprint": "TEXT",
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
        connection.execute(text("CREATE INDEX IF NOT EXISTS ix_sql_runs_actor_key ON sql_runs (actor_key)"))
        connection.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS uq_sql_run_actor_client_request ON sql_runs (actor_key, client_request_id) WHERE client_request_id IS NOT NULL"))
        connection.execute(text("CREATE INDEX IF NOT EXISTS ix_sql_run_result_pages_source_uri ON sql_run_result_pages (run_id, source_next_uri)"))

    _schema_ready_bind_ids.add(bind_key)


def string_or_none(value: object) -> str | None:
    normalized = str(value or "").strip()
    return normalized or None
