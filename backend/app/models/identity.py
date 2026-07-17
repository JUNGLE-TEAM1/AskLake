from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Index, JSON, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class AuthUserModel(TimestampMixin, Base):
    __tablename__ = "auth_users"

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True, nullable=False)
    display_name: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[str] = mapped_column(String(64), default="viewer", nullable=False)
    groups: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    password_hash: Mapped[str] = mapped_column(Text, nullable=False)
    password_salt: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(64), default="active", nullable=False)
    title: Mapped[str | None] = mapped_column(String(255), nullable=True)
    last_active_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class AuthSessionModel(TimestampMixin, Base):
    __tablename__ = "auth_sessions"

    token: Mapped[str] = mapped_column(Text, primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("auth_users.id", ondelete="CASCADE"), index=True, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    user_snapshot: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)


class PermissionGrantModel(TimestampMixin, Base):
    __tablename__ = "permission_grants"
    __table_args__ = (
        Index("ix_permission_grants_resource", "resource_type", "resource_id"),
        Index("ix_permission_grants_principal", "principal_type", "principal_id"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    resource_type: Mapped[str] = mapped_column(String(64), nullable=False)
    resource_id: Mapped[str] = mapped_column(String(255), nullable=False)
    principal_type: Mapped[str] = mapped_column(String(32), nullable=False)
    principal_id: Mapped[str] = mapped_column(String(255), nullable=False)
    actions: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    source: Mapped[str] = mapped_column(String(64), default="admin", nullable=False)
    created_by: Mapped[str | None] = mapped_column(String(255), nullable=True)


class AuditEventModel(TimestampMixin, Base):
    __tablename__ = "audit_events"
    __table_args__ = (
        Index("ix_audit_events_created_at", "created_at"),
        Index("ix_audit_events_actor", "actor_id"),
        Index("ix_audit_events_resource", "target_type", "target_id"),
        Index("ix_audit_events_result", "result"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    action: Mapped[str] = mapped_column(String(255), nullable=False)
    actor_id: Mapped[str] = mapped_column(String(255), nullable=False)
    actor_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    actor_role: Mapped[str | None] = mapped_column(String(64), nullable=True)
    actor_groups: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    api_path: Mapped[str] = mapped_column(Text, nullable=False)
    request_id: Mapped[str] = mapped_column(String(255), nullable=False)
    result: Mapped[str] = mapped_column(String(32), nullable=False)
    status_code: Mapped[int | None] = mapped_column(nullable=True)
    target_id: Mapped[str] = mapped_column(String(255), nullable=False)
    target_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    target_type: Mapped[str] = mapped_column(String(64), nullable=False)
    http_method: Mapped[str | None] = mapped_column(String(16), nullable=True)
    ip_address: Mapped[str | None] = mapped_column(String(255), nullable=True)
    user_agent: Mapped[str | None] = mapped_column(Text, nullable=True)
    metadata_: Mapped[dict[str, Any]] = mapped_column("metadata", JSON, default=dict, nullable=False)


class AiGenerationUsageModel(TimestampMixin, Base):
    __tablename__ = "ai_generation_usage"
    __table_args__ = (
        Index("ix_ai_generation_usage_created_at", "created_at"),
        Index("ix_ai_generation_usage_mode", "mode"),
        Index("ix_ai_generation_usage_model", "model"),
    )

    request_id: Mapped[str] = mapped_column(String(255), primary_key=True)
    mode: Mapped[str] = mapped_column(String(64), nullable=False)
    provider: Mapped[str] = mapped_column(String(100), nullable=False)
    model: Mapped[str] = mapped_column(String(255), nullable=False)
    input_tokens: Mapped[int] = mapped_column(default=0, nullable=False)
    output_tokens: Mapped[int] = mapped_column(default=0, nullable=False)
    total_tokens: Mapped[int] = mapped_column(default=0, nullable=False)
    estimated_cost_usd: Mapped[float] = mapped_column(Float, default=0, nullable=False)


class AiContextConsumptionModel(TimestampMixin, Base):
    """Database-backed single-use record for signed MCP context tokens."""

    __tablename__ = "ai_context_consumptions"
    __table_args__ = (
        Index("ix_ai_context_consumptions_request_id", "request_id"),
        Index("ix_ai_context_consumptions_expires_at", "expires_at"),
    )

    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    request_id: Mapped[str] = mapped_column(String(255), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class PrincipalControlModel(TimestampMixin, Base):
    __tablename__ = "principal_controls"
    __table_args__ = (
        Index("ix_principal_controls_principal", "principal_type", "principal_id", unique=True),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    principal_type: Mapped[str] = mapped_column(String(32), nullable=False)
    principal_id: Mapped[str] = mapped_column(String(255), nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="active", nullable=False)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    updated_by: Mapped[str | None] = mapped_column(String(255), nullable=True)


class ResourceLockModel(TimestampMixin, Base):
    __tablename__ = "resource_locks"
    __table_args__ = (
        Index("ix_resource_locks_resource", "resource_type", "resource_id", unique=True),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    resource_type: Mapped[str] = mapped_column(String(64), nullable=False)
    resource_id: Mapped[str] = mapped_column(String(255), nullable=False)
    locked: Mapped[bool] = mapped_column(default=False, nullable=False)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    updated_by: Mapped[str | None] = mapped_column(String(255), nullable=True)
