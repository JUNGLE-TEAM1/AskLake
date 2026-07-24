from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import delete, func, or_, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.schema_management import metadata_schema_mutation_allowed
from app.models.base import Base
from app.models.realtime import RealtimeEventModel
from app.schemas.realtime import RealtimeEventEnvelope
from app.services.realtime_event_contract import (
    REALTIME_EVENT_SCHEMA_VERSION,
    REALTIME_SCOPE_ID,
    validate_realtime_event,
)
from app.services.realtime_metrics import realtime_metrics


REALTIME_NOTIFY_CHANNEL = "asklake_realtime_events"


def ensure_realtime_event_schema(db: Session) -> None:
    bind = db.get_bind()
    if not metadata_schema_mutation_allowed(db, "Realtime event"):
        return
    Base.metadata.create_all(bind=bind, tables=[RealtimeEventModel.__table__])
    if bind.dialect.name == "postgresql":
        for statement in (
            "CREATE INDEX IF NOT EXISTS realtime_event_log_scope_cursor_idx ON realtime_event_log (scope_id, id)",
            "CREATE INDEX IF NOT EXISTS realtime_event_log_resource_cursor_idx ON realtime_event_log (resource_type, resource_id, id)",
            "CREATE INDEX IF NOT EXISTS realtime_event_log_expiry_idx ON realtime_event_log (expires_at)",
        ):
            db.execute(text(statement))
    db.commit()


class RealtimeEventRepository:
    def __init__(self, db: Session, *, ensure_schema: bool = False) -> None:
        self.db = db
        if ensure_schema:
            ensure_realtime_event_schema(db)

    def append(
        self,
        *,
        event_type: str,
        resource_type: str,
        resource_id: str,
        aggregate_revision: int,
        correlation_id: str,
        idempotency_key: str,
        invalidations: list[str],
        payload: dict[str, Any],
        occurred_at: datetime | None = None,
        schema_version: int = REALTIME_EVENT_SCHEMA_VERSION,
    ) -> tuple[RealtimeEventEnvelope, bool]:
        validate_realtime_event(
            event_type=event_type,
            resource_type=resource_type,
            resource_id=resource_id,
            aggregate_revision=aggregate_revision,
            correlation_id=correlation_id,
            invalidations=invalidations,
            payload=payload,
            schema_version=schema_version,
        )
        normalized_idempotency_key = str(idempotency_key or "").strip()
        if not normalized_idempotency_key or len(normalized_idempotency_key) > 256:
            raise ValueError("Realtime event requires a bounded idempotency key")
        existing = self.by_idempotency_key(normalized_idempotency_key)
        if existing is not None:
            return self.to_envelope(existing), False

        now = occurred_at or datetime.now(UTC)
        model = RealtimeEventModel(
            scope_id=REALTIME_SCOPE_ID,
            event_type=event_type,
            schema_version=schema_version,
            resource_type=resource_type,
            resource_id=resource_id,
            aggregate_revision=aggregate_revision,
            correlation_id=correlation_id,
            idempotency_key=normalized_idempotency_key,
            invalidations=list(invalidations),
            payload=dict(payload),
            occurred_at=now,
            expires_at=now + timedelta(seconds=settings.realtime_event_retention_seconds),
        )
        try:
            with self.db.begin_nested():
                self.db.add(model)
                self.db.flush()
        except IntegrityError:
            existing = self.by_idempotency_key(normalized_idempotency_key)
            if existing is None:
                raise
            return self.to_envelope(existing), False

        if self.db.get_bind().dialect.name == "postgresql":
            self.db.execute(
                text("SELECT pg_notify(:channel, :payload)"),
                {"channel": REALTIME_NOTIFY_CHANNEL, "payload": str(model.id)},
            )
        realtime_metrics.increment("eventsCreated")
        return self.to_envelope(model), True

    def by_idempotency_key(self, idempotency_key: str) -> RealtimeEventModel | None:
        return self.db.scalars(
            select(RealtimeEventModel).where(
                RealtimeEventModel.idempotency_key == idempotency_key
            )
        ).first()

    def cursor_bounds(self, *, scope_id: str = REALTIME_SCOPE_ID) -> tuple[int, int]:
        now = datetime.now(UTC)
        row = self.db.execute(
            select(
                func.min(RealtimeEventModel.id),
                func.max(RealtimeEventModel.id),
            ).where(
                RealtimeEventModel.scope_id == scope_id,
                RealtimeEventModel.expires_at > now,
            )
        ).one()
        return int(row[0] or 0), int(row[1] or 0)

    def max_cursor(self, *, scope_id: str = REALTIME_SCOPE_ID) -> int:
        return self.cursor_bounds(scope_id=scope_id)[1]

    def replay(
        self,
        *,
        after_cursor: int,
        resources: set[tuple[str, str]],
        limit: int,
        through_cursor: int | None = None,
        scope_id: str = REALTIME_SCOPE_ID,
    ) -> list[RealtimeEventEnvelope]:
        if not resources:
            return []
        now = datetime.now(UTC)
        statement = select(RealtimeEventModel).where(
            RealtimeEventModel.scope_id == scope_id,
            RealtimeEventModel.id > max(0, int(after_cursor)),
            RealtimeEventModel.expires_at > now,
            or_(
                *[
                    (
                        (RealtimeEventModel.resource_type == resource_type)
                        & (RealtimeEventModel.resource_id == resource_id)
                    )
                    for resource_type, resource_id in sorted(resources)
                ]
            ),
        )
        if through_cursor is not None:
            statement = statement.where(RealtimeEventModel.id <= through_cursor)
        models = self.db.scalars(
            statement.order_by(RealtimeEventModel.id.asc()).limit(max(1, limit))
        ).all()
        return [self.to_envelope(model) for model in models]

    def dispatch_after(
        self,
        after_cursor: int,
        *,
        limit: int,
    ) -> list[RealtimeEventEnvelope]:
        now = datetime.now(UTC)
        models = self.db.scalars(
            select(RealtimeEventModel)
            .where(
                RealtimeEventModel.id > max(0, int(after_cursor)),
                RealtimeEventModel.expires_at > now,
            )
            .order_by(RealtimeEventModel.id.asc())
            .limit(max(1, limit))
        ).all()
        return [self.to_envelope(model) for model in models]

    def cleanup_expired(self, *, now: datetime | None = None) -> int:
        result = self.db.execute(
            delete(RealtimeEventModel).where(
                RealtimeEventModel.expires_at <= (now or datetime.now(UTC))
            )
        )
        return max(0, int(result.rowcount or 0))

    @staticmethod
    def to_envelope(model: RealtimeEventModel) -> RealtimeEventEnvelope:
        occurred_at = model.occurred_at
        if occurred_at.tzinfo is None:
            occurred_at = occurred_at.replace(tzinfo=UTC)
        return RealtimeEventEnvelope(
            event_id=int(model.id),
            event_type=model.event_type,
            schema_version=int(model.schema_version),
            scope_id=str(model.scope_id),
            resource_type=model.resource_type,
            resource_id=model.resource_id,
            aggregate_revision=int(model.aggregate_revision),
            occurred_at=occurred_at.isoformat(),
            correlation_id=model.correlation_id,
            invalidate=list(model.invalidations or []),
            payload=dict(model.payload or {}),
        )
