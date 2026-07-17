from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, DateTime, Index, Integer, JSON, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class SemanticModelModel(TimestampMixin, Base):
    __tablename__ = "semantic_models"
    __table_args__ = (Index("ix_semantic_models_owner", "owner"),)

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    owner: Mapped[str] = mapped_column(String(255), nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="draft", nullable=False)
    published_version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    grants: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list, nullable=False)


class SemanticModelVersionModel(TimestampMixin, Base):
    __tablename__ = "semantic_model_versions"
    __table_args__ = (UniqueConstraint("model_id", "version", name="uq_semantic_model_version"),)

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    model_id: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="draft", nullable=False)
    definition: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    published_by: Mapped[str | None] = mapped_column(String(255), nullable=True)


class SemanticModelDatasetModel(TimestampMixin, Base):
    __tablename__ = "semantic_model_datasets"
    __table_args__ = (UniqueConstraint("model_id", "dataset_id", name="uq_semantic_model_dataset"),)

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    model_id: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    dataset_id: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    role: Mapped[str] = mapped_column(String(32), default="source", nullable=False)
    join_config: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)


class SemanticMetricModel(TimestampMixin, Base):
    __tablename__ = "semantic_metrics"
    __table_args__ = (UniqueConstraint("model_id", "name", name="uq_semantic_metric_name"),)

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    model_id: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    label: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    expression: Mapped[str] = mapped_column(Text, nullable=False)
    dataset_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    source_columns: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    format: Mapped[str | None] = mapped_column(String(32), nullable=True)


class SemanticDimensionModel(TimestampMixin, Base):
    __tablename__ = "semantic_dimensions"
    __table_args__ = (UniqueConstraint("model_id", "name", name="uq_semantic_dimension_name"),)

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    model_id: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    label: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    column_name: Mapped[str] = mapped_column(String(255), nullable=False)
    dataset_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    data_type: Mapped[str | None] = mapped_column(String(64), nullable=True)


class SemanticRelationshipModel(TimestampMixin, Base):
    __tablename__ = "semantic_relationships"

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    model_id: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    from_dataset_id: Mapped[str] = mapped_column(String(255), nullable=False)
    to_dataset_id: Mapped[str] = mapped_column(String(255), nullable=False)
    relationship_type: Mapped[str] = mapped_column(String(32), default="many_to_one", nullable=False)
    join_expression: Mapped[str] = mapped_column(Text, nullable=False)


class SemanticVocabularyModel(TimestampMixin, Base):
    __tablename__ = "semantic_vocabulary"
    __table_args__ = (UniqueConstraint("model_id", "term", name="uq_semantic_vocabulary_term"),)

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    model_id: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    term: Mapped[str] = mapped_column(String(255), nullable=False)
    synonyms: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)


class RagDatasetProfileModel(TimestampMixin, Base):
    __tablename__ = "rag_dataset_profiles"

    dataset_id: Mapped[str] = mapped_column(String(255), primary_key=True)
    review_state: Mapped[str] = mapped_column(String(32), default="not_configured", nullable=False)
    index_status: Mapped[str] = mapped_column(String(32), default="not_indexed", nullable=False)
    embedding_status: Mapped[str] = mapped_column(String(32), default="not_started", nullable=False)
    source_manifest: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    schema_fingerprint: Mapped[str | None] = mapped_column(String(128), nullable=True)
    approved_schema_fingerprint: Mapped[str | None] = mapped_column(String(128), nullable=True)
    approved_definition_fingerprint: Mapped[str | None] = mapped_column(String(128), nullable=True)
    desired_generation: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    physical_column_mapping: Mapped[dict[str, str]] = mapped_column(JSON, default=dict, nullable=False)
    body_columns: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    title_columns: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    metadata_columns: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    identifier_columns: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    excluded_columns: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    semantic_bindings: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    classifier: Mapped[str | None] = mapped_column(String(255), nullable=True)
    classifier_confidence: Mapped[float | None] = mapped_column(nullable=True)
    target_alias: Mapped[str | None] = mapped_column(String(255), nullable=True)
    active_index: Mapped[str | None] = mapped_column(String(255), nullable=True)
    approved_by: Mapped[str | None] = mapped_column(String(255), nullable=True)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)


class RagClassificationRunModel(TimestampMixin, Base):
    __tablename__ = "rag_classification_runs"

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    dataset_id: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    status: Mapped[str] = mapped_column(String(32), default="queued", nullable=False)
    model: Mapped[str] = mapped_column(String(255), nullable=False)
    input_snapshot: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    output: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class RagColumnRecommendationModel(TimestampMixin, Base):
    __tablename__ = "rag_column_recommendations"
    __table_args__ = (UniqueConstraint("run_id", "column_name", name="uq_rag_recommendation_column"),)

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    run_id: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    dataset_id: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    column_name: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[str] = mapped_column(String(32), nullable=False)
    confidence: Mapped[float] = mapped_column(nullable=False)
    reason: Mapped[str] = mapped_column(Text, default="", nullable=False)
    approved: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)


class RagIndexJobModel(TimestampMixin, Base):
    __tablename__ = "rag_index_jobs"
    __table_args__ = (Index("ix_rag_index_jobs_dataset", "dataset_id", "created_at"), Index("uq_rag_index_job_idempotency", "dataset_id", "idempotency_key", unique=True))

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    dataset_id: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    status: Mapped[str] = mapped_column(String(32), default="queued", nullable=False)
    requested_by: Mapped[str] = mapped_column(String(255), nullable=False)
    requested_mode: Mapped[str] = mapped_column(String(32), default="index", nullable=False)
    idempotency_key: Mapped[str | None] = mapped_column(String(255), nullable=True)
    target_index: Mapped[str | None] = mapped_column(String(255), nullable=True)
    document_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    indexed_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    parent_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    chunk_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    failed_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    row_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    failed_row_rate: Mapped[float] = mapped_column(default=0.0, nullable=False)
    failed_row_rate_threshold: Mapped[float] = mapped_column(default=0.05, nullable=False)
    failed_row_report: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    fallback_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    fallback_reasons: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    stage: Mapped[str] = mapped_column(String(32), default="queued", nullable=False)
    source_fingerprint: Mapped[str | None] = mapped_column(String(128), nullable=True)
    policy_fingerprint: Mapped[str | None] = mapped_column(String(128), nullable=True)
    generation: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    physical_column_mapping: Mapped[dict[str, str]] = mapped_column(JSON, default=dict, nullable=False)
    metadata_columns: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    metadata_types: Mapped[dict[str, str]] = mapped_column(JSON, default=dict, nullable=False)
    filter_contract_version: Mapped[str | None] = mapped_column(String(64), nullable=True)
    embedding_provider: Mapped[str | None] = mapped_column(String(100), nullable=True)
    embedding_model: Mapped[str | None] = mapped_column(String(255), nullable=True)
    embedding_dimensions: Mapped[int | None] = mapped_column(Integer, nullable=True)
    parent_table: Mapped[str | None] = mapped_column(String(512), nullable=True)
    chunk_table: Mapped[str | None] = mapped_column(String(512), nullable=True)
    checkpoint_path: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    airflow_run_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    validation_status: Mapped[str] = mapped_column(String(32), default="pending", nullable=False)
    validated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    validated_index: Mapped[str | None] = mapped_column(String(255), nullable=True)
    validated_document_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    validated_parent_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    validated_dimensions: Mapped[int | None] = mapped_column(Integer, nullable=True)
    validation_evidence_hash: Mapped[str | None] = mapped_column(String(128), nullable=True)
    activation_status: Mapped[str] = mapped_column(String(32), default="none", nullable=False)
    activation_alias: Mapped[str | None] = mapped_column(String(255), nullable=True)
    activation_previous_index: Mapped[str | None] = mapped_column(String(255), nullable=True)
    activation_target_index: Mapped[str | None] = mapped_column(String(255), nullable=True)
    activation_started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    activation_committed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class RagIndexManifestModel(TimestampMixin, Base):
    __tablename__ = "rag_index_manifests"
    __table_args__ = (UniqueConstraint("dataset_id", "index_name", name="uq_rag_index_manifest"),)

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    dataset_id: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    index_name: Mapped[str] = mapped_column(String(255), nullable=False)
    alias_name: Mapped[str] = mapped_column(String(255), nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="building", nullable=False)
    embedding_provider: Mapped[str | None] = mapped_column(String(100), nullable=True)
    embedding_model: Mapped[str] = mapped_column(String(255), nullable=False)
    dimensions: Mapped[int] = mapped_column(Integer, nullable=False)
    document_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    parent_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    chunk_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    failed_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    row_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    failed_row_rate: Mapped[float] = mapped_column(default=0.0, nullable=False)
    failed_row_rate_threshold: Mapped[float] = mapped_column(default=0.05, nullable=False)
    failed_row_report: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    fallback_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    fallback_reasons: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    source_fingerprint: Mapped[str | None] = mapped_column(String(128), nullable=True)
    schema_fingerprint: Mapped[str | None] = mapped_column(String(128), nullable=True)
    policy_fingerprint: Mapped[str | None] = mapped_column(String(128), nullable=True)
    generation: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    physical_column_mapping: Mapped[dict[str, str]] = mapped_column(JSON, default=dict, nullable=False)
    metadata_columns: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    metadata_types: Mapped[dict[str, str]] = mapped_column(JSON, default=dict, nullable=False)
    filter_contract_version: Mapped[str | None] = mapped_column(String(64), nullable=True)
    semantic_bindings_fingerprint: Mapped[str | None] = mapped_column(String(128), nullable=True)
    chunking_version: Mapped[str | None] = mapped_column(String(64), nullable=True)
    embedding_input_version: Mapped[str | None] = mapped_column(String(64), nullable=True)
    parent_schema_version: Mapped[str | None] = mapped_column(String(64), nullable=True)
    parent_table: Mapped[str | None] = mapped_column(String(512), nullable=True)
    chunk_table: Mapped[str | None] = mapped_column(String(512), nullable=True)
    checkpoint_path: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    retired_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    activated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
