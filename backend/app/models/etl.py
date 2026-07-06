from sqlalchemy import JSON, Boolean, Float, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class ETLJobModel(TimestampMixin, Base):
    __tablename__ = "etl_jobs"

    id: Mapped[str] = mapped_column(String(120), primary_key=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    owner: Mapped[str] = mapped_column(String(255), nullable=False)
    status: Mapped[str] = mapped_column(String(64), nullable=False, default="scheduled")
    tag: Mapped[str] = mapped_column(String(64), nullable=False, default="[생성]")
    source: Mapped[str] = mapped_column(String(255), nullable=False)
    target: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    schedule: Mapped[str] = mapped_column(String(255), nullable=False)
    source_config: Mapped[list[list[str]]] = mapped_column(JSON, nullable=False, default=list)
    source_label: Mapped[str] = mapped_column(String(255), nullable=False)
    source_type: Mapped[str] = mapped_column(String(120), nullable=False)
    schema_columns: Mapped[list[dict]] = mapped_column(JSON, nullable=False, default=list)
    schema_fingerprint: Mapped[str | None] = mapped_column(String(255), nullable=True)
    schema_sample_rows: Mapped[list[list[str]]] = mapped_column(JSON, nullable=False, default=list)
    permission_roles: Mapped[list[dict] | None] = mapped_column(JSON, nullable=True)
    storage_type: Mapped[str | None] = mapped_column(String(64), nullable=True)
    partition: Mapped[str | None] = mapped_column(String(255), nullable=True)
    compression: Mapped[str | None] = mapped_column(String(64), nullable=True)
    storage_path: Mapped[str | None] = mapped_column(String(512), nullable=True)
    target_format: Mapped[str] = mapped_column(String(120), nullable=False)
    target_layer: Mapped[str] = mapped_column(String(32), nullable=False)
    target_path: Mapped[str | None] = mapped_column(String(512), nullable=True)
    rag: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    transform_output_columns: Mapped[list[list[str]]] = mapped_column(JSON, nullable=False, default=list)
    transform_steps: Mapped[list[dict]] = mapped_column(JSON, nullable=False, default=list)
    quality_invalid_rows: Mapped[list[list[str]]] = mapped_column(JSON, nullable=False, default=list)
    quality_rules: Mapped[list[dict]] = mapped_column(JSON, nullable=False, default=list)
    quality_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    quality_status: Mapped[str | None] = mapped_column(String(32), nullable=True)
    last_run: Mapped[str] = mapped_column(String(64), nullable=False)
    last_state: Mapped[str] = mapped_column(String(255), nullable=False)
    next_run: Mapped[str] = mapped_column(String(255), nullable=False)
    progress: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    stats: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    dag_steps: Mapped[list[dict]] = mapped_column(JSON, nullable=False, default=list)
    dag_steps_by_run_id: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    dataset_id: Mapped[str | None] = mapped_column(String(120), nullable=True, index=True)


class ETLRunModel(TimestampMixin, Base):
    __tablename__ = "etl_runs"

    run_id: Mapped[str] = mapped_column(String(120), primary_key=True)
    job_id: Mapped[str] = mapped_column(String(120), ForeignKey("etl_jobs.id"), nullable=False, index=True)
    status: Mapped[str] = mapped_column(String(64), nullable=False)
    started_at: Mapped[str] = mapped_column(String(64), nullable=False)
    ended_at: Mapped[str] = mapped_column(String(64), nullable=False)
    duration: Mapped[str] = mapped_column(String(120), nullable=False)
    input_rows: Mapped[str] = mapped_column(String(120), nullable=False)
    output_rows: Mapped[str] = mapped_column(String(120), nullable=False)
    output_path: Mapped[str | None] = mapped_column(String(512), nullable=True)
    failed_stage: Mapped[str] = mapped_column(String(255), nullable=False)
    error_summary: Mapped[str] = mapped_column(String(512), nullable=False)
