from typing import Any

from sqlalchemy import ForeignKey, Index, Integer, JSON, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class AiConversationModel(TimestampMixin, Base):
    __tablename__ = "ai_conversations"
    __table_args__ = (
        Index("ix_ai_conversations_owner_updated", "owner_key", "updated_at"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    owner_key: Mapped[str] = mapped_column(String(512), nullable=False)
    owner_user_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    owner_name: Mapped[str] = mapped_column(String(255), nullable=False)
    title: Mapped[str] = mapped_column(String(120), default="새 대화", nullable=False)
    selected_dataset_ids: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)


class AiConversationMessageModel(TimestampMixin, Base):
    __tablename__ = "ai_conversation_messages"
    __table_args__ = (
        UniqueConstraint(
            "conversation_id",
            "position",
            name="uq_ai_conversation_messages_position",
        ),
        UniqueConstraint(
            "conversation_id",
            "client_request_id",
            name="uq_ai_conversation_messages_client_request",
        ),
        Index(
            "ix_ai_conversation_messages_conversation_position",
            "conversation_id",
            "position",
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    conversation_id: Mapped[str] = mapped_column(
        ForeignKey("ai_conversations.id", ondelete="CASCADE"),
        nullable=False,
    )
    role: Mapped[str] = mapped_column(String(32), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    context_names: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    notices: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    sql: Mapped[str | None] = mapped_column(Text, nullable=True)
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    client_request_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    metadata_: Mapped[dict[str, Any]] = mapped_column("metadata", JSON, default=dict, nullable=False)
