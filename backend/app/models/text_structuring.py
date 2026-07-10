from sqlalchemy import JSON, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class TextStructuringSpecModel(TimestampMixin, Base):
    __tablename__ = "text_structuring_specs"

    id: Mapped[str] = mapped_column(String(120), primary_key=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    owner: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    created_by: Mapped[str | None] = mapped_column(String(255), nullable=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="draft")
    active_version: Mapped[int | None] = mapped_column(Integer, nullable=True)


class TextStructuringSpecVersionModel(TimestampMixin, Base):
    __tablename__ = "text_structuring_spec_versions"
    __table_args__ = (UniqueConstraint("spec_id", "version", name="uq_text_structuring_spec_version"),)

    id: Mapped[str] = mapped_column(String(160), primary_key=True)
    spec_id: Mapped[str] = mapped_column(
        String(120),
        ForeignKey("text_structuring_specs.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    fingerprint: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="draft")
    definition: Mapped[dict] = mapped_column(JSON, nullable=False)
    compiled_schema: Mapped[dict] = mapped_column(JSON, nullable=False)
    prompt_version: Mapped[str] = mapped_column(String(64), nullable=False, default="text-structuring-v2")
    published_at: Mapped[str | None] = mapped_column(String(64), nullable=True)


class TextStructuringReviewItemModel(TimestampMixin, Base):
    __tablename__ = "text_structuring_review_items"

    id: Mapped[str] = mapped_column(String(160), primary_key=True)
    spec_id: Mapped[str] = mapped_column(String(120), nullable=False, index=True)
    spec_version: Mapped[int] = mapped_column(Integer, nullable=False)
    run_id: Mapped[str | None] = mapped_column(String(120), nullable=True, index=True)
    job_id: Mapped[str | None] = mapped_column(String(120), nullable=True, index=True)
    source_row_id: Mapped[str] = mapped_column(String(160), nullable=False, index=True)
    source_hash: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    input_snapshot: Mapped[dict] = mapped_column(JSON, nullable=False)
    prediction: Mapped[dict] = mapped_column(JSON, nullable=False)
    correction: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    reasons: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    route: Mapped[str] = mapped_column(String(64), nullable=False)
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending")


class TextStructuringTrainingRunModel(TimestampMixin, Base):
    __tablename__ = "text_structuring_training_runs"

    id: Mapped[str] = mapped_column(String(160), primary_key=True)
    spec_id: Mapped[str] = mapped_column(String(120), nullable=False, index=True)
    spec_version: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="queued")
    task_fields: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    training_rows: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    label_manifest_uri: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    model_id: Mapped[str | None] = mapped_column(String(160), nullable=True, index=True)
    metrics: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)


class TextStructuringModelModel(TimestampMixin, Base):
    __tablename__ = "text_structuring_models"

    id: Mapped[str] = mapped_column(String(160), primary_key=True)
    spec_id: Mapped[str] = mapped_column(String(120), nullable=False, index=True)
    spec_version: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="candidate")
    provider: Mapped[str] = mapped_column(String(64), nullable=False)
    model_name: Mapped[str] = mapped_column(String(255), nullable=False)
    artifact_uri: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    task_fields: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    metrics: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)


class TextStructuringEvaluationModel(TimestampMixin, Base):
    __tablename__ = "text_structuring_evaluations"

    id: Mapped[str] = mapped_column(String(160), primary_key=True)
    spec_id: Mapped[str] = mapped_column(String(120), nullable=False, index=True)
    spec_version: Mapped[int] = mapped_column(Integer, nullable=False)
    run_id: Mapped[str | None] = mapped_column(String(120), nullable=True, index=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending")
    holdout_manifest_uri: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    metrics: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
