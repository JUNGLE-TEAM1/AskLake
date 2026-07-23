from typing import Any

from sqlalchemy import and_, func, or_, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.sql import SqlRunModel
from app.repositories.sql_repository_schema import ensure_sql_schema, string_or_none
from app.repositories.sql_repository_types import TrinoSubmissionReservation


class SqlRunRepository:
    db: Session

    def get_run_payload(self, run_id: str) -> dict[str, Any] | None:
        ensure_sql_schema(self.db)
        model = self.db.get(SqlRunModel, run_id)
        return model.payload if model else None

    def save_run_payload(
        self,
        payload: dict[str, Any],
        *,
        commit: bool = True,
    ) -> dict[str, Any]:
        ensure_sql_schema(self.db)
        run_id = str(payload["runId"])
        dataset_id = str(payload.get("datasetId") or payload.get("baseDatasetId") or "")
        if not dataset_id:
            raise ValueError("SQL run payload requires datasetId or baseDatasetId")
        query = str(payload["query"])
        model = self.db.get(SqlRunModel, run_id)

        if model is None:
            model = SqlRunModel(id=run_id, dataset_id=dataset_id, query=query, payload=payload)
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
        if commit:
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

    def list_trino_run_payloads(
        self,
        *,
        actor_id: str | None = None,
        actor_name: str | None = None,
        limit: int = 20,
    ) -> list[dict[str, Any]]:
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
        if actor_name and not actor_id:
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

    def get_unfinalized_trino_job_run_payload(self, job_id: str) -> dict[str, Any] | None:
        """Return any Job run whose publication/finalization boundary is incomplete."""

        ensure_sql_schema(self.db)
        model = self.db.scalar(
            select(SqlRunModel)
            .where(
                SqlRunModel.payload["engine"].as_string() == "trino-job-materialization",
                SqlRunModel.payload["jobId"].as_string() == job_id,
                or_(
                    SqlRunModel.payload["status"].as_string().in_(["queued", "running"]),
                    SqlRunModel.payload["finalized"].as_boolean().is_not(True),
                ),
            )
            .order_by(SqlRunModel.created_at.desc(), SqlRunModel.id.desc())
        )
        return dict(model.payload or {}) if model is not None else None

    def get_latest_trino_job_auto_refresh_run_payload(
        self,
        job_id: str,
        source_revision: int,
    ) -> dict[str, Any] | None:
        """Return durable evidence for one Job/source-revision refresh claim."""

        ensure_sql_schema(self.db)
        model = self.db.scalar(
            select(SqlRunModel)
            .where(
                SqlRunModel.payload["engine"].as_string() == "trino-job-materialization",
                SqlRunModel.payload["jobId"].as_string() == job_id,
                SqlRunModel.payload["autoRefresh"]["sourceRevision"].as_integer() == source_revision,
            )
            .order_by(SqlRunModel.created_at.desc(), SqlRunModel.id.desc())
        )
        return dict(model.payload or {}) if model is not None else None
