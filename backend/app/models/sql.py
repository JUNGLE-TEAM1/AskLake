from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, Integer, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class SqlRunModel(Base):
    __tablename__ = "sql_runs"
    __table_args__ = (UniqueConstraint("actor_key", "client_request_id", name="uq_sql_run_actor_client_request"),)

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    dataset_id: Mapped[str] = mapped_column(Text, nullable=False)
    query: Mapped[str] = mapped_column(Text, nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    actor_key: Mapped[str | None] = mapped_column(Text, nullable=True, index=True)
    client_request_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    request_fingerprint: Mapped[str | None] = mapped_column(Text, nullable=True)
    collector_owner: Mapped[str | None] = mapped_column(Text, nullable=True, index=True)
    collector_lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, index=True)
    collector_next_uri: Mapped[str | None] = mapped_column(Text, nullable=True)
    collector_generation: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    collector_attempt_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    collector_next_attempt_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )


class SqlRunResultPageModel(Base):
    __tablename__ = "sql_run_result_pages"
    __table_args__ = (UniqueConstraint("run_id", "page_index", name="uq_sql_run_result_page"),)

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    run_id: Mapped[str] = mapped_column(Text, index=True, nullable=False)
    page_index: Mapped[int] = mapped_column(Integer, nullable=False)
    columns: Mapped[list[str]] = mapped_column(JSONB, default=list, nullable=False)
    rows: Mapped[list[list[object]]] = mapped_column(JSONB, default=list, nullable=False)
    byte_size: Mapped[int] = mapped_column(Integer, nullable=False)
    storage_backend: Mapped[str | None] = mapped_column(Text, nullable=True)
    object_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    row_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    checksum: Mapped[str | None] = mapped_column(Text, nullable=True)
    source_next_uri: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
