from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from app.models.sql import SqlRunModel
from app.repositories.sql_repository_schema import ensure_sql_schema, string_or_none
from app.repositories.sql_repository_types import TrinoCollectorClaim


class TrinoCollectorRepository:
    db: Session

    def claim_next_trino_run(self, worker_id: str, lease_seconds: int) -> TrinoCollectorClaim | None:
        """Claim one active run. Expired leases are intentionally recoverable."""
        ensure_sql_schema(self.db)
        now = datetime.now(timezone.utc)
        statement = (
            select(SqlRunModel)
            .where(
                SqlRunModel.payload["engine"].astext.in_([
                    "trino",
                    "trino-materialization",
                    "trino-job-materialization",
                ]),
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

    def renew_trino_collector_lease(
        self,
        run_id: str,
        worker_id: str,
        generation: int,
        lease_seconds: int,
    ) -> bool:
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

    def save_collector_run_payload(
        self,
        payload: dict[str, Any],
        *,
        worker_id: str,
        generation: int,
    ) -> bool:
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

    def schedule_collector_retry(
        self,
        run_id: str,
        *,
        worker_id: str,
        generation: int,
    ) -> tuple[int, datetime] | None:
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
