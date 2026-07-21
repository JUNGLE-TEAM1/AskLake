from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import BigInteger, Boolean, CheckConstraint, DateTime, ForeignKey, Index, Integer, JSON, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class ContinuousSqlJobModel(TimestampMixin, Base):
    __tablename__ = "continuous_sql_jobs"
    __table_args__ = (
        UniqueConstraint("owner", "client_request_id", name="uq_continuous_sql_job_client_request"),
        Index("ix_continuous_sql_jobs_owner_updated", "owner", "updated_at"),
        Index("ix_continuous_sql_jobs_state", "desired_state", "observed_state"),
    )

    id: Mapped[str] = mapped_column(String(160), primary_key=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    owner: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    created_by: Mapped[str] = mapped_column(String(255), nullable=False)
    client_request_id: Mapped[str | None] = mapped_column(String(160), nullable=True)
    request_fingerprint: Mapped[str | None] = mapped_column(String(64), nullable=True)
    original_sql: Mapped[str] = mapped_column(Text, nullable=False)
    normalized_sql: Mapped[str] = mapped_column(Text, nullable=False)
    plan_version: Mapped[str] = mapped_column(String(64), nullable=False)
    plan_hash: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    compiled_plan: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    relation_bindings: Mapped[list[dict[str, Any]]] = mapped_column(JSON, nullable=False, default=list)
    static_binding_policy: Mapped[str] = mapped_column(String(32), nullable=False)
    trigger_interval_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=10)
    checkpoint_path: Mapped[str] = mapped_column(String(2048), nullable=False)
    output_dataset_id: Mapped[str] = mapped_column(String(160), nullable=False, unique=True, index=True)
    output_dataset_name: Mapped[str] = mapped_column(String(255), nullable=False)
    output_layer: Mapped[str] = mapped_column(String(32), nullable=False, default="GOLD")
    output_storage_path: Mapped[str] = mapped_column(String(2048), nullable=False)
    output_target: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    desired_state: Mapped[str] = mapped_column(String(32), nullable=False, default="stopped")
    observed_state: Mapped[str] = mapped_column(String(32), nullable=False, default="stopped")
    generation: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    fencing_token: Mapped[str | None] = mapped_column(String(160), nullable=True)
    active_run_id: Mapped[str | None] = mapped_column(String(200), nullable=True, index=True)
    worker_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    last_error_code: Mapped[str | None] = mapped_column(String(120), nullable=True)
    last_error_message: Mapped[str | None] = mapped_column(Text, nullable=True)


class ContinuousSqlDependencyModel(TimestampMixin, Base):
    __tablename__ = "continuous_sql_dependencies"
    __table_args__ = (
        UniqueConstraint(
            "sql_job_id",
            "input_dataset_id",
            name="uq_continuous_sql_dependency_input",
        ),
        Index(
            "ix_continuous_sql_dependencies_child_job",
            "child_job_id",
            "input_type",
        ),
        CheckConstraint(
            "input_type IN ('realtime', 'batch', 'static')",
            name="ck_continuous_sql_dependency_input_type",
        ),
        CheckConstraint(
            "execution_policy IN ('run_on_tree_start', 'reuse_snapshot')",
            name="ck_continuous_sql_dependency_execution_policy",
        ),
        CheckConstraint(
            "(child_job_id IS NULL AND input_type = 'static' AND execution_policy = 'reuse_snapshot') "
            "OR (child_job_id IS NOT NULL AND execution_policy = 'run_on_tree_start')",
            name="ck_continuous_sql_dependency_owner",
        ),
    )

    sql_job_id: Mapped[str] = mapped_column(
        String(160),
        ForeignKey("continuous_sql_jobs.id", ondelete="CASCADE"),
        primary_key=True,
    )
    input_dataset_id: Mapped[str] = mapped_column(String(160), primary_key=True)
    child_job_id: Mapped[str | None] = mapped_column(String(160), nullable=True, index=True)
    input_type: Mapped[str] = mapped_column(String(32), nullable=False)
    execution_policy: Mapped[str] = mapped_column(String(32), nullable=False)
    required: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class ContinuousSqlTreeRunModel(TimestampMixin, Base):
    __tablename__ = "continuous_sql_tree_runs"
    __table_args__ = (
        UniqueConstraint("sql_job_id", "generation", name="uq_continuous_sql_tree_run_generation"),
        Index("ix_continuous_sql_tree_runs_job_status", "sql_job_id", "status"),
    )

    tree_run_id: Mapped[str] = mapped_column(String(200), primary_key=True)
    sql_job_id: Mapped[str] = mapped_column(
        String(160), ForeignKey("continuous_sql_jobs.id", ondelete="CASCADE"), nullable=False,
    )
    continuous_sql_run_id: Mapped[str | None] = mapped_column(String(200), nullable=True)
    generation: Mapped[int] = mapped_column(Integer, nullable=False)
    trigger_type: Mapped[str] = mapped_column(String(32), nullable=False, default="parent_tree")
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="locked")
    fencing_token: Mapped[str] = mapped_column(String(160), nullable=False)
    lease_expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    input_dataset_revisions: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
    started_at: Mapped[str] = mapped_column(String(64), nullable=False)
    ended_at: Mapped[str | None] = mapped_column(String(64), nullable=True)
    last_error_code: Mapped[str | None] = mapped_column(String(120), nullable=True)
    last_error_message: Mapped[str | None] = mapped_column(Text, nullable=True)


class ContinuousSqlTreeNodeRunModel(TimestampMixin, Base):
    __tablename__ = "continuous_sql_tree_node_runs"
    __table_args__ = (
        UniqueConstraint("tree_run_id", "job_id", name="uq_continuous_sql_tree_node_job"),
        Index("ix_continuous_sql_tree_node_runs_job", "job_id", "status"),
    )

    node_run_id: Mapped[str] = mapped_column(String(220), primary_key=True)
    tree_run_id: Mapped[str] = mapped_column(
        String(200), ForeignKey("continuous_sql_tree_runs.tree_run_id", ondelete="CASCADE"), nullable=False,
    )
    job_id: Mapped[str] = mapped_column(String(160), nullable=False)
    node_type: Mapped[str] = mapped_column(String(32), nullable=False)
    trigger_type: Mapped[str] = mapped_column(String(32), nullable=False, default="parent_tree")
    parent_run_id: Mapped[str | None] = mapped_column(String(200), nullable=True)
    producer_run_id: Mapped[str | None] = mapped_column(String(200), nullable=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="locked")
    input_dataset_revisions: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
    started_at: Mapped[str] = mapped_column(String(64), nullable=False)
    ended_at: Mapped[str | None] = mapped_column(String(64), nullable=True)


class ContinuousSqlTreeJobLockModel(TimestampMixin, Base):
    __tablename__ = "continuous_sql_tree_job_locks"
    __table_args__ = (
        Index("ix_continuous_sql_tree_job_locks_tree", "tree_run_id", "active"),
        Index("ix_continuous_sql_tree_job_locks_owner", "owner_sql_job_id", "active"),
    )

    job_id: Mapped[str] = mapped_column(String(160), primary_key=True)
    tree_run_id: Mapped[str] = mapped_column(
        String(200), ForeignKey("continuous_sql_tree_runs.tree_run_id", ondelete="CASCADE"), nullable=False,
    )
    node_run_id: Mapped[str] = mapped_column(String(220), nullable=False)
    owner_sql_job_id: Mapped[str] = mapped_column(String(160), nullable=False)
    lock_kind: Mapped[str] = mapped_column(String(32), nullable=False)
    generation: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    fencing_token: Mapped[str] = mapped_column(String(160), nullable=False)
    lease_expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    released_at: Mapped[str | None] = mapped_column(String(64), nullable=True)


class ContinuousSqlRunModel(TimestampMixin, Base):
    __tablename__ = "continuous_sql_runs"
    __table_args__ = (
        UniqueConstraint("job_id", "generation", name="uq_continuous_sql_run_generation"),
        Index("ix_continuous_sql_runs_job_created", "job_id", "created_at"),
    )

    run_id: Mapped[str] = mapped_column(String(200), primary_key=True)
    job_id: Mapped[str] = mapped_column(
        String(160),
        ForeignKey("continuous_sql_jobs.id"),
        nullable=False,
        index=True,
    )
    generation: Mapped[int] = mapped_column(Integer, nullable=False)
    fencing_token: Mapped[str] = mapped_column(String(160), nullable=False)
    plan_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="starting")
    static_bindings: Mapped[list[dict[str, Any]]] = mapped_column(JSON, nullable=False, default=list)
    checkpoint_path: Mapped[str] = mapped_column(String(2048), nullable=False)
    worker_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    started_at: Mapped[str] = mapped_column(String(64), nullable=False)
    ended_at: Mapped[str | None] = mapped_column(String(64), nullable=True)
    last_error_code: Mapped[str | None] = mapped_column(String(120), nullable=True)
    last_error_message: Mapped[str | None] = mapped_column(Text, nullable=True)


class ContinuousSqlBatchModel(TimestampMixin, Base):
    __tablename__ = "continuous_sql_batches"
    __table_args__ = (
        UniqueConstraint(
            "job_id",
            "generation",
            "batch_id",
            name="uq_continuous_sql_batch_identity",
        ),
        Index("ix_continuous_sql_batches_run_batch", "run_id", "batch_id"),
        Index("ix_continuous_sql_batches_stage", "stage", "updated_at"),
    )

    id: Mapped[str] = mapped_column(String(255), primary_key=True)
    job_id: Mapped[str] = mapped_column(
        String(160),
        ForeignKey("continuous_sql_jobs.id"),
        nullable=False,
        index=True,
    )
    run_id: Mapped[str] = mapped_column(
        String(200),
        ForeignKey("continuous_sql_runs.run_id"),
        nullable=False,
        index=True,
    )
    generation: Mapped[int] = mapped_column(Integer, nullable=False)
    batch_id: Mapped[int] = mapped_column(Integer, nullable=False)
    stage: Mapped[str] = mapped_column(String(32), nullable=False, default="planned")
    plan_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    input_offsets: Mapped[list[dict[str, Any]]] = mapped_column(JSON, nullable=False, default=list)
    static_snapshots: Mapped[list[dict[str, Any]]] = mapped_column(JSON, nullable=False, default=list)
    source_boundary: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
    output_commit: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    output_commit_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    manifest_path: Mapped[str | None] = mapped_column(String(2048), nullable=True)
    row_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    dataset_revision: Mapped[int | None] = mapped_column(Integer, nullable=True)
    published_at: Mapped[str | None] = mapped_column(String(64), nullable=True)
    last_error_code: Mapped[str | None] = mapped_column(String(120), nullable=True)
    last_error_message: Mapped[str | None] = mapped_column(Text, nullable=True)


class ContinuousSqlCommandModel(TimestampMixin, Base):
    __tablename__ = "continuous_sql_commands"
    __table_args__ = (
        UniqueConstraint("job_id", "command_id", name="uq_continuous_sql_command_id"),
    )

    id: Mapped[str] = mapped_column(String(255), primary_key=True)
    job_id: Mapped[str] = mapped_column(
        String(160),
        ForeignKey("continuous_sql_jobs.id"),
        nullable=False,
        index=True,
    )
    command_id: Mapped[str] = mapped_column(String(160), nullable=False)
    command: Mapped[str] = mapped_column(String(32), nullable=False)
    request_fingerprint: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="accepted")
    result: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)


class ContinuousSqlIncrementalBindingModel(TimestampMixin, Base):
    """Durable baseline and Kafka source checkpoint for one Continuous SQL Job."""

    __tablename__ = "continuous_sql_incremental_bindings"
    __table_args__ = (
        Index(
            "ix_continuous_sql_incremental_bindings_source_revision",
            "source_dataset_id",
            "source_revision",
        ),
        Index("ix_continuous_sql_incremental_bindings_status", "status", "updated_at"),
    )

    job_id: Mapped[str] = mapped_column(
        String(160),
        ForeignKey("continuous_sql_jobs.id"),
        primary_key=True,
    )
    source_dataset_id: Mapped[str] = mapped_column(String(160), nullable=False, index=True)
    baseline_dataset_id: Mapped[str] = mapped_column(String(160), nullable=False)
    baseline_snapshot_id: Mapped[str] = mapped_column(String(255), nullable=False)
    baseline_revision: Mapped[int] = mapped_column(BigInteger, nullable=False)
    source_revision: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    source_run_id: Mapped[str | None] = mapped_column(String(200), nullable=True)
    source_fingerprint: Mapped[str | None] = mapped_column(String(64), nullable=True)
    source_ranges: Mapped[list[dict[str, Any]]] = mapped_column(JSON, nullable=False, default=list)
    static_snapshots: Mapped[list[dict[str, Any]]] = mapped_column(JSON, nullable=False, default=list)
    next_offsets: Mapped[list[dict[str, Any]]] = mapped_column(JSON, nullable=False, default=list)
    output_revision: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    processed_rows: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    processed_static_keys: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    full_refresh_count: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="ready")
    last_error_code: Mapped[str | None] = mapped_column(String(120), nullable=True)
    last_error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
