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


class RealtimeParityCheckModel(Base):
    __tablename__ = "realtime_parity_checks"
    __table_args__ = (
        Index("realtime_parity_checks_dataset_created_idx", "dataset_id", "created_at"),
        Index("realtime_parity_checks_status_idx", "status", "created_at"),
    )

    id: Mapped[str] = mapped_column(String(160), primary_key=True)
    dataset_id: Mapped[str] = mapped_column(String(120), nullable=False)
    pipeline_version_id: Mapped[str] = mapped_column(String(160), nullable=False)
    hot_binding_version_id: Mapped[str] = mapped_column(String(160), nullable=False)
    archive_binding_version_id: Mapped[str] = mapped_column(String(160), nullable=False)
    source_boundary: Mapped[dict[str, Any]] = mapped_column(JSON_DOCUMENT, nullable=False)
    dimension_version_ids: Mapped[dict[str, str]] = mapped_column(JSON_DOCUMENT, nullable=False)
    hot_evidence: Mapped[dict[str, Any]] = mapped_column(JSON_DOCUMENT, nullable=False)
    archive_evidence: Mapped[dict[str, Any]] = mapped_column(JSON_DOCUMENT, nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    mismatch_fields: Mapped[list[str]] = mapped_column(JSON_DOCUMENT, nullable=False, default=list)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class RealtimeRecoveryOperationModel(Base):
    __tablename__ = "realtime_recovery_operations"
    __table_args__ = (
        UniqueConstraint("idempotency_key", name="realtime_recovery_operations_idempotency_uq"),
        Index("realtime_recovery_operations_dataset_created_idx", "dataset_id", "created_at"),
        Index("realtime_recovery_operations_status_idx", "operation_kind", "status", "updated_at"),
    )

    id: Mapped[str] = mapped_column(String(160), primary_key=True)
    idempotency_key: Mapped[str] = mapped_column(String(256), nullable=False)
    dataset_id: Mapped[str] = mapped_column(String(120), nullable=False)
    operation_kind: Mapped[str] = mapped_column(String(32), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    parity_check_id: Mapped[str] = mapped_column(String(160), nullable=False)
    expected_binding_epoch: Mapped[int] = mapped_column(BigInteger, nullable=False)
    previous_binding_version_id: Mapped[str | None] = mapped_column(String(160), nullable=True)
    target_binding_version_id: Mapped[str] = mapped_column(String(160), nullable=False)
    target_engine: Mapped[str] = mapped_column(String(32), nullable=False)
    pipeline_version_id: Mapped[str] = mapped_column(String(160), nullable=False)
    target_binding: Mapped[dict[str, Any]] = mapped_column(JSON_DOCUMENT, nullable=False)
    source_boundary: Mapped[dict[str, Any]] = mapped_column(JSON_DOCUMENT, nullable=False)
    dimension_version_ids: Mapped[dict[str, str]] = mapped_column(JSON_DOCUMENT, nullable=False)
    tail_start_offsets: Mapped[list[dict[str, Any]]] = mapped_column(JSON_DOCUMENT, nullable=False)
    gate_evidence: Mapped[dict[str, Any]] = mapped_column(JSON_DOCUMENT, nullable=False, default=dict)
    attempt_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    result_binding_epoch: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    result_revision: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    result_event_cursor: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    requested_by: Mapped[str] = mapped_column(String(255), nullable=False)
    reason: Mapped[str] = mapped_column(String(2000), nullable=False)
    correlation_id: Mapped[str] = mapped_column(String(160), nullable=False)
    last_error_code: Mapped[str | None] = mapped_column(String(120), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class RealtimeRoutingAssignmentModel(Base):
    """ORM projection of the sticky assignment table created by migration 0012."""

    __tablename__ = "realtime_routing_assignments"

    scope_id: Mapped[str] = mapped_column(String(64), primary_key=True, default="deployment")
    resource_type: Mapped[str] = mapped_column(String(32), primary_key=True)
    resource_id: Mapped[str] = mapped_column(String(160), primary_key=True)
    desired_engine: Mapped[str] = mapped_column(String(32), nullable=False)
    pipeline_version_id: Mapped[str | None] = mapped_column(String(160), nullable=True)
    binding_epoch: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    sticky_bucket: Mapped[int | None] = mapped_column(Integer, nullable=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending")
    assignment_reason: Mapped[str] = mapped_column(String(255), nullable=False)
    assigned_by: Mapped[str] = mapped_column(String(255), nullable=False)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
