from datetime import datetime
from typing import Any

from sqlalchemy import BigInteger, DateTime, Index, Integer, JSON, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


JSON_DOCUMENT = JSON().with_variant(JSONB, "postgresql")
CURSOR_TYPE = BigInteger().with_variant(Integer, "sqlite")


class RealtimeEventModel(Base):
    __tablename__ = "realtime_event_log"
    __table_args__ = (
        UniqueConstraint("idempotency_key", name="realtime_event_log_idempotency_key_uq"),
        Index("realtime_event_log_scope_cursor_idx", "scope_id", "id"),
        Index("realtime_event_log_resource_cursor_idx", "resource_type", "resource_id", "id"),
        Index("realtime_event_log_expiry_idx", "expires_at"),
    )

    id: Mapped[int] = mapped_column(CURSOR_TYPE, primary_key=True, autoincrement=True)
    scope_id: Mapped[str] = mapped_column(String(64), nullable=False, default="deployment")
    event_type: Mapped[str] = mapped_column(String(96), nullable=False)
    schema_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    resource_type: Mapped[str] = mapped_column(String(64), nullable=False)
    resource_id: Mapped[str] = mapped_column(String(160), nullable=False)
    aggregate_revision: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    correlation_id: Mapped[str] = mapped_column(String(160), nullable=False)
    idempotency_key: Mapped[str] = mapped_column(String(256), nullable=False)
    invalidations: Mapped[list[str]] = mapped_column(JSON_DOCUMENT, nullable=False, default=list)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON_DOCUMENT, nullable=False, default=dict)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
