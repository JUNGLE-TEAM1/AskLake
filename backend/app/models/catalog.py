from sqlalchemy import JSON, Boolean, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class CatalogDatasetModel(TimestampMixin, Base):
    __tablename__ = "catalog_datasets"

    id: Mapped[str] = mapped_column(String(120), primary_key=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False, unique=True, index=True)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    owner: Mapped[str] = mapped_column(String(255), nullable=False)
    layer: Mapped[str] = mapped_column(String(32), nullable=False)
    status: Mapped[str] = mapped_column(String(64), nullable=False, default="available")
    freshness: Mapped[str] = mapped_column(String(64), nullable=False, default="latest")
    source: Mapped[str] = mapped_column(String(255), nullable=False)
    rows: Mapped[str] = mapped_column(String(120), nullable=False, default="0")
    size: Mapped[str] = mapped_column(String(120), nullable=False, default="Pending")
    quality: Mapped[str] = mapped_column(String(255), nullable=False, default="확인 대기")
    last_updated: Mapped[str] = mapped_column(String(64), nullable=False)
    next_refresh: Mapped[str] = mapped_column(String(255), nullable=False, default="-")
    rag: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    tags: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    schema_json: Mapped[list[list[str]]] = mapped_column(JSON, nullable=False, default=list)
    sample_rows: Mapped[list[list[str]]] = mapped_column(JSON, nullable=False, default=list)
    upstream: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    downstream: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    lineage_graph: Mapped[dict | None] = mapped_column(JSON, nullable=True)
