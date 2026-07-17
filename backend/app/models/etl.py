from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class ETLJobModel(TimestampMixin, Base):
    __tablename__ = "etl_jobs"

    id: Mapped[str] = mapped_column(String(120), primary_key=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    owner: Mapped[str] = mapped_column(String(255), nullable=False)
    created_by: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_by_profile: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    status: Mapped[str] = mapped_column(String(64), nullable=False, default="scheduled")
    tag: Mapped[str] = mapped_column(String(64), nullable=False, default="[생성]")
    source: Mapped[str] = mapped_column(String(255), nullable=False)
    target: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    schedule: Mapped[str] = mapped_column(String(255), nullable=False)
    schedule_policy: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    schedule_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    retry_policy: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    retry_policy_summary: Mapped[str | None] = mapped_column(String(255), nullable=True)
    run_limit_summary: Mapped[str | None] = mapped_column(String(255), nullable=True)
    source_config: Mapped[list[list[str]]] = mapped_column(JSON, nullable=False, default=list)
    source_label: Mapped[str] = mapped_column(String(255), nullable=False)
    source_type: Mapped[str] = mapped_column(String(120), nullable=False)
    job_kind: Mapped[str] = mapped_column(String(64), nullable=False, default="pipeline")
    sql_recipe: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    execution_mode: Mapped[str] = mapped_column(String(32), nullable=False, default="snapshot")
    continuous_config: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    record_parsing: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    schema_columns: Mapped[list[dict]] = mapped_column(JSON, nullable=False, default=list)
    schema_fingerprint: Mapped[str | None] = mapped_column(Text, nullable=True)
    schema_sample_rows: Mapped[list[list[str]]] = mapped_column(JSON, nullable=False, default=list)
    schema_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    rule_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    rule_contract_version: Mapped[str | None] = mapped_column(String(16), nullable=True)
    rules: Mapped[list[dict] | None] = mapped_column(JSON, nullable=True)
    permission_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    permission_roles: Mapped[list[dict] | None] = mapped_column(JSON, nullable=True)
    storage_type: Mapped[str | None] = mapped_column(String(64), nullable=True)
    partition: Mapped[str | None] = mapped_column(String(255), nullable=True)
    partition_columns: Mapped[list[str] | None] = mapped_column(JSON, nullable=True)
    index_columns: Mapped[list[str] | None] = mapped_column(JSON, nullable=True)
    compression: Mapped[str | None] = mapped_column(String(64), nullable=True)
    storage_path: Mapped[str | None] = mapped_column(String(512), nullable=True)
    iceberg_target: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    target_description: Mapped[str | None] = mapped_column(Text, nullable=True)
    target_database: Mapped[str | None] = mapped_column(String(255), nullable=True)
    target_tags: Mapped[list[str] | None] = mapped_column(JSON, nullable=True)
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
    last_state: Mapped[str] = mapped_column(Text, nullable=False)
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
    failed_stage: Mapped[str] = mapped_column(Text, nullable=False)
    error_summary: Mapped[str] = mapped_column(Text, nullable=False)
    airflow_dag_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    airflow_dag_run_id: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    airflow_run_url: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    airflow_state: Mapped[str | None] = mapped_column(String(64), nullable=True)
    task_states: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    last_synced_at: Mapped[str | None] = mapped_column(String(64), nullable=True)
    sync_error: Mapped[str | None] = mapped_column(String(512), nullable=True)


class ReviewAnalysisRunModel(TimestampMixin, Base):
    __tablename__ = "review_analysis_runs"
    __table_args__ = (
        Index("ix_review_analysis_runs_status", "status"),
        Index("ix_review_analysis_runs_created_by", "created_by"),
    )

    id: Mapped[str] = mapped_column(String(120), primary_key=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="queued")
    created_by: Mapped[str] = mapped_column(String(255), nullable=False)
    source: Mapped[dict] = mapped_column(JSON, nullable=False)
    request_payload: Mapped[dict] = mapped_column(JSON, nullable=False)
    result: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class KafkaSnapshotModel(TimestampMixin, Base):
    __tablename__ = "kafka_snapshots"
    __table_args__ = (
        Index("ix_kafka_snapshots_active", "topic", "consumer_group_id", "status"),
    )

    snapshot_id: Mapped[str] = mapped_column(String(120), primary_key=True)
    job_id: Mapped[str | None] = mapped_column(String(120), ForeignKey("etl_jobs.id"), nullable=True, index=True)
    topic: Mapped[str] = mapped_column(String(255), nullable=False)
    consumer_group_id: Mapped[str] = mapped_column(String(255), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="running")
    snapshot: Mapped[dict] = mapped_column(JSON, nullable=False)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)


class KafkaContinuousRuntimeModel(TimestampMixin, Base):
    __tablename__ = "kafka_continuous_runtimes"
    __table_args__ = (
        Index(
            "ix_kafka_continuous_runtimes_identity",
            "broker",
            "topic",
            "consumer_group_id",
            "target_identity",
            "checkpoint_path",
            "status",
        ),
    )

    job_id: Mapped[str] = mapped_column(String(120), ForeignKey("etl_jobs.id"), primary_key=True)
    broker: Mapped[str] = mapped_column(String(512), nullable=False)
    topic: Mapped[str] = mapped_column(String(255), nullable=False)
    consumer_group_id: Mapped[str] = mapped_column(String(255), nullable=False)
    target_identity: Mapped[str] = mapped_column(String(1024), nullable=False)
    checkpoint_path: Mapped[str] = mapped_column(String(1024), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="stopped")
    heartbeat_at: Mapped[str | None] = mapped_column(String(64), nullable=True)
    last_flush_at: Mapped[str | None] = mapped_column(String(64), nullable=True)
    last_batch_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    lag: Mapped[int | None] = mapped_column(nullable=True)
    metrics: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    schema_state: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    consumed_count: Mapped[int] = mapped_column(nullable=False, default=0)
    stored_count: Mapped[int] = mapped_column(nullable=False, default=0)
    quarantined_count: Mapped[int] = mapped_column(nullable=False, default=0)
    failed_count: Mapped[int] = mapped_column(nullable=False, default=0)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)


class KafkaContinuousSessionModel(TimestampMixin, Base):
    __tablename__ = "kafka_continuous_sessions"
    __table_args__ = (
        Index("ix_kafka_continuous_sessions_job_started", "job_id", "started_at"),
        Index("ix_kafka_continuous_sessions_worker_attempt", "worker_attempt_id"),
    )

    session_id: Mapped[str] = mapped_column(String(160), primary_key=True)
    job_id: Mapped[str] = mapped_column(String(120), ForeignKey("etl_jobs.id"), nullable=False, index=True)
    worker_attempt_id: Mapped[str | None] = mapped_column(String(160), nullable=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="starting", index=True)
    started_at: Mapped[str] = mapped_column(String(64), nullable=False)
    ended_at: Mapped[str | None] = mapped_column(String(64), nullable=True)
    end_reason: Mapped[str | None] = mapped_column(String(64), nullable=True)
    checkpoint_path: Mapped[str] = mapped_column(String(1024), nullable=False)
    baseline_counts: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    consumed_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    stored_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    quarantined_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    failed_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    last_batch_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    last_flush_at: Mapped[str | None] = mapped_column(String(64), nullable=True)
    lag: Mapped[int | None] = mapped_column(Integer, nullable=True)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    dag_steps: Mapped[list[dict]] = mapped_column(JSON, nullable=False, default=list)


class KafkaContinuousBatchModel(TimestampMixin, Base):
    __tablename__ = "kafka_continuous_batches"
    __table_args__ = (
        Index("ix_kafka_continuous_batches_session_batch", "session_id", "batch_id", unique=True),
    )

    id: Mapped[str] = mapped_column(String(255), primary_key=True)
    job_id: Mapped[str] = mapped_column(String(120), ForeignKey("etl_jobs.id"), nullable=False, index=True)
    session_id: Mapped[str] = mapped_column(String(160), ForeignKey("kafka_continuous_sessions.session_id"), nullable=False, index=True)
    batch_id: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="success")
    published_at: Mapped[str | None] = mapped_column(String(64), nullable=True)
    consumed_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    stored_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    quarantined_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    source_ranges: Mapped[list[dict]] = mapped_column(JSON, nullable=False, default=list)
    source_boundary: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    data_path: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    iceberg_snapshot_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    iceberg_table_uri: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    quarantine_path: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    manifest_path: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    dag_steps: Mapped[list[dict]] = mapped_column(JSON, nullable=False, default=list)


class KafkaContinuousMaintenanceRunModel(TimestampMixin, Base):
    __tablename__ = "kafka_continuous_maintenance_runs"

    run_id: Mapped[str] = mapped_column(String(120), primary_key=True)
    job_id: Mapped[str] = mapped_column(String(120), ForeignKey("etl_jobs.id"), nullable=False, index=True)
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="queued", index=True)
    requested_by: Mapped[str] = mapped_column(String(255), nullable=False)
    config: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    result: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    started_at: Mapped[str | None] = mapped_column(String(64), nullable=True)
    ended_at: Mapped[str | None] = mapped_column(String(64), nullable=True)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
