from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, Integer, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class SqlRunModel(Base):
    __tablename__ = "sql_runs"

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    dataset_id: Mapped[str] = mapped_column(Text, nullable=False)
    query: Mapped[str] = mapped_column(Text, nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
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
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
