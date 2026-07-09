from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, ForeignKey, Index, JSON, String, Text
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
