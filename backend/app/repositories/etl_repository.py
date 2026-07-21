from datetime import datetime, timedelta, timezone
from typing import Any, NamedTuple

from sqlalchemy import inspect, select, text
from sqlalchemy.orm import Session

from app.core.compatibility import record_legacy_runtime_error_projection
from app.core.config import settings
from app.core.permission_metadata import permission_grants_from_roles, resource_permissions
from app.domain.continuous_runtime import runtime_contract_projection
from app.models import (
    CatalogDatasetModel,
    ETLJobModel,
    ETLRunModel,
    KafkaContinuousBatchModel,
    KafkaContinuousMaintenanceRunModel,
    KafkaContinuousRuntimeModel,
    KafkaContinuousSessionModel,
    KafkaSnapshotModel,
)
from app.models.base import Base
from app.repositories.catalog_repository import ensure_catalog_schema
from app.repositories import etl_job_list_repository
from app.repositories.etl_schema_migrations import (
    columns_by_name,
    migrate_columns_to_text,
)
from app.schemas.etl import (
    CatalogDataset,
    ContinuousMaintenanceRun,
    JobRowData,
    JobRunSummary,
    KafkaContinuousBatch,
    KafkaContinuousRuntime,
    KafkaContinuousSession,
)
from app.services.rule_compiler import compile_rule_set

_schema_ready_bind_ids: set[int] = set()


class RunExecutionLease(NamedTuple):
    generation: int
    recovered: bool


def execution_lease_is_live(expires_at: datetime | None, now: datetime) -> bool:
    if expires_at is None:
        return False
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    return expires_at > now


def ensure_schema(db: Session) -> None:
    bind = db.get_bind()
    bind_key = id(bind)
    if bind_key in _schema_ready_bind_ids:
        return
    if not settings.startup_schema_management_enabled:
        _schema_ready_bind_ids.add(bind_key)
        return

    with bind.begin() as connection:
        Base.metadata.create_all(bind=connection)
        inspector = inspect(connection)
        existing_column_defs = columns_by_name(inspector, "etl_jobs")
        if "payload" in existing_column_defs:
            connection.execute(text("ALTER TABLE etl_jobs ALTER COLUMN payload DROP NOT NULL"))
        column_defs = {
            "compression": "VARCHAR(64)",
            "continuous_config": "JSON",
            "created_by": "VARCHAR(255)",
            "created_by_profile": "JSON",
            "dag_steps": "JSON",
            "dag_steps_by_run_id": "JSON",
            "dataset_id": "VARCHAR(120)",
            "execution_mode": "VARCHAR(32)",
            "last_run": "VARCHAR(64)",
            "last_state": "TEXT",
            "name": "VARCHAR(255)",
            "next_run": "VARCHAR(255)",
            "owner": "VARCHAR(255)",
            "partition": "VARCHAR(255)",
            "partition_columns": "JSON",
            "index_columns": "JSON",
            "iceberg_target": "JSON",
            "job_kind": "VARCHAR(64)",
            "permission_roles": "JSON",
            "permission_summary": "TEXT",
            "progress": "JSON",
            "quality_invalid_rows": "JSON",
            "quality_rules": "JSON",
            "quality_score": "FLOAT",
            "quality_status": "VARCHAR(32)",
            "rag": "BOOLEAN",
            "record_parsing": "JSON",
            "retry_policy": "JSON",
            "retry_policy_summary": "VARCHAR(255)",
            "run_limit_summary": "VARCHAR(255)",
            "schedule": "VARCHAR(255)",
            "schedule_policy": "JSON",
            "schedule_summary": "TEXT",
            "schema_columns": "JSON",
            "schema_fingerprint": "TEXT",
            "schema_sample_rows": "JSON",
            "schema_summary": "TEXT",
            "rule_summary": "TEXT",
            "rule_contract_version": "VARCHAR(16)",
            "rules": "JSON",
            "source": "VARCHAR(255)",
            "source_config": "JSON",
            "source_label": "VARCHAR(255)",
            "source_type": "VARCHAR(120)",
            "sql_recipe": "JSON",
            "stats": "JSON",
            "status": "VARCHAR(64)",
            "storage_path": "VARCHAR(512)",
            "storage_type": "VARCHAR(64)",
            "tag": "VARCHAR(64)",
            "target": "VARCHAR(255)",
            "target_description": "TEXT",
            "target_database": "VARCHAR(255)",
            "target_format": "VARCHAR(120)",
            "target_layer": "VARCHAR(32)",
            "target_path": "VARCHAR(512)",
            "target_tags": "JSON",
            "transform_output_columns": "JSON",
            "transform_steps": "JSON",
        }
        for column_name, column_type in column_defs.items():
            if column_name not in existing_column_defs:
                connection.execute(text(f"ALTER TABLE etl_jobs ADD COLUMN {column_name} {column_type}"))

        runtime_columns = {column["name"] for column in inspector.get_columns("kafka_continuous_runtimes")}
        for column_name in ("metrics", "schema_state"):
            if column_name not in runtime_columns:
                connection.execute(text(f"ALTER TABLE kafka_continuous_runtimes ADD COLUMN {column_name} JSON"))

        session_columns = {column["name"] for column in inspector.get_columns("kafka_continuous_sessions")}
        if "dag_steps" not in session_columns:
            connection.execute(text("ALTER TABLE kafka_continuous_sessions ADD COLUMN dag_steps JSON"))
        connection.execute(text("UPDATE kafka_continuous_sessions SET dag_steps = '[]' WHERE dag_steps IS NULL"))

        batch_columns = {column["name"] for column in inspector.get_columns("kafka_continuous_batches")}
        batch_column_defs = {
            "status": "VARCHAR(32)",
            "last_error": "TEXT",
            "dag_steps": "JSON",
            "source_boundary": "JSON",
            "iceberg_snapshot_id": "VARCHAR(255)",
            "iceberg_table_uri": "VARCHAR(1024)",
        }
        for column_name, column_type in batch_column_defs.items():
            if column_name not in batch_columns:
                connection.execute(text(f"ALTER TABLE kafka_continuous_batches ADD COLUMN {column_name} {column_type}"))
        connection.execute(text("UPDATE kafka_continuous_batches SET status = 'success' WHERE status IS NULL"))
        connection.execute(text("UPDATE kafka_continuous_batches SET dag_steps = '[]' WHERE dag_steps IS NULL"))
        connection.execute(text("UPDATE kafka_continuous_batches SET source_boundary = '{}' WHERE source_boundary IS NULL"))

        job_defaults = {
            "dag_steps": "[]",
            "execution_mode": "snapshot",
            "job_kind": "pipeline",
            "last_run": "-",
            "last_state": "대기",
            "name": "Untitled ETL Job",
            "next_run": "-",
            "owner": "AskLake",
            "quality_invalid_rows": "[]",
            "quality_rules": "[]",
            "rag": False,
            "schedule": "수동",
            "schema_columns": "[]",
            "schema_sample_rows": "[]",
            "source": "unknown",
            "source_config": "[]",
            "source_label": "Unknown source",
            "source_type": "unknown",
            "stats": "{}",
            "status": "scheduled",
            "tag": "[생성]",
            "target": "unknown",
            "target_format": "parquet",
            "target_layer": "RAW",
            "transform_output_columns": "[]",
            "transform_steps": "[]",
        }
        for column_name, default_value in job_defaults.items():
            if isinstance(default_value, bool):
                sql_value = "true" if default_value else "false"
            elif column_name in {
                "dag_steps",
                "quality_invalid_rows",
                "quality_rules",
                "schema_columns",
                "schema_sample_rows",
                "source_config",
                "sql_recipe",
                "stats",
                "transform_output_columns",
                "transform_steps",
            } and connection.dialect.name != "sqlite":
                sql_value = f"'{default_value}'::json"
            else:
                sql_value = f"'{default_value}'"
            connection.execute(text(f"UPDATE etl_jobs SET {column_name} = {sql_value} WHERE {column_name} IS NULL"))
        migrate_columns_to_text(connection, "etl_jobs", existing_column_defs, ("schema_fingerprint", "last_state"))

        existing_run_column_defs = columns_by_name(inspector, "etl_runs")
        migrate_columns_to_text(connection, "etl_runs", existing_run_column_defs, ("failed_stage", "error_summary"))

        run_column_defs = {
            "airflow_dag_id": "VARCHAR(255)",
            "airflow_dag_run_id": "VARCHAR(255)",
            "airflow_run_url": "VARCHAR(1024)",
            "airflow_state": "VARCHAR(64)",
            "last_synced_at": "VARCHAR(64)",
            "sync_error": "VARCHAR(512)",
            "task_states": "JSON",
            "execution_owner": "VARCHAR(255)",
            "execution_lease_expires_at": "TIMESTAMP WITH TIME ZONE",
            "execution_generation": "INTEGER NOT NULL DEFAULT 0",
        }
        for column_name, column_type in run_column_defs.items():
            if column_name not in existing_run_column_defs:
                connection.execute(text(f"ALTER TABLE etl_runs ADD COLUMN {column_name} {column_type}"))
        connection.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_etl_runs_execution_claim "
            "ON etl_runs (execution_lease_expires_at, execution_owner)"
        ))

    ensure_catalog_schema(db)
    _schema_ready_bind_ids.add(bind_key)


def list_jobs(db: Session) -> list[JobRowData]:
    ensure_schema(db)
    jobs = db.scalars(select(ETLJobModel).order_by(ETLJobModel.created_at.desc())).all()
    job_ids = [job.id for job in jobs]
    continuous_runtime_by_job_id = etl_job_list_repository.list_continuous_runtimes(
        db,
        [job.id for job in jobs if job.execution_mode == "continuous"],
    )
    run_models_by_job_id = etl_job_list_repository.list_latest_run_models(db, job_ids)
    return [
        job_to_schema(
            db,
            job,
            continuous_runtime=continuous_runtime_by_job_id.get(job.id),
            related_loaded=True,
            run_history=[
                run_to_schema(run)
                for run in run_models_by_job_id.get(job.id, [])
            ],
        )
        for job in jobs
    ]


def list_job_models(db: Session) -> list[ETLJobModel]:
    ensure_schema(db)
    return db.scalars(select(ETLJobModel).order_by(ETLJobModel.created_at.desc())).all()


def get_job(db: Session, job_id: str) -> ETLJobModel | None:
    ensure_schema(db)
    return db.get(ETLJobModel, job_id)


def get_job_for_update(db: Session, job_id: str) -> ETLJobModel | None:
    ensure_schema(db)
    statement = (
        select(ETLJobModel)
        .where(ETLJobModel.id == job_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if db.get_bind().dialect.name == "sqlite":
        # SQLite ignores SELECT FOR UPDATE. A no-op write takes its database-level
        # writer lock before any external side effect while preserving row values.
        result = db.execute(
            text("UPDATE etl_jobs SET id = id WHERE id = :job_id"),
            {"job_id": job_id},
        )
        if result.rowcount == 0:
            return None
        return db.get(ETLJobModel, job_id, populate_existing=True)
    return db.scalar(statement)


def get_job_schema(db: Session, job_id: str) -> JobRowData | None:
    job = get_job(db, job_id)
    if job is None:
        return None
    return job_to_schema(db, job)


def get_job_by_dataset_id(db: Session, dataset_id: str) -> ETLJobModel | None:
    ensure_schema(db)
    return db.scalar(select(ETLJobModel).where(ETLJobModel.dataset_id == dataset_id))


def get_job_by_target(db: Session, target: str) -> ETLJobModel | None:
    ensure_schema(db)
    return db.scalar(select(ETLJobModel).where(ETLJobModel.target == target))


def get_dataset_by_id(db: Session, dataset_id: str) -> CatalogDatasetModel | None:
    ensure_schema(db)
    return db.get(CatalogDatasetModel, dataset_id)


def get_dataset_by_id_for_update(db: Session, dataset_id: str) -> CatalogDatasetModel | None:
    ensure_schema(db)
    model = db.scalar(
        select(CatalogDatasetModel)
        .where(CatalogDatasetModel.id == dataset_id)
        .with_for_update()
    )
    from app.repositories.catalog_deletion_repository import ensure_catalog_publication_allowed

    ensure_catalog_publication_allowed(db, dataset_id)
    return model


def get_dataset_by_name(db: Session, name: str) -> CatalogDatasetModel | None:
    ensure_schema(db)
    return db.scalar(select(CatalogDatasetModel).where(CatalogDatasetModel.name == name))


def list_datasets(db: Session) -> list[CatalogDataset]:
    ensure_schema(db)
    datasets = db.scalars(select(CatalogDatasetModel).order_by(CatalogDatasetModel.created_at.desc())).all()
    return [dataset_to_schema(dataset) for dataset in datasets]


def get_dataset_schema_by_id(db: Session, dataset_id: str) -> CatalogDataset | None:
    dataset = get_dataset_by_id(db, dataset_id)
    if dataset is None:
        return None
    return dataset_to_schema(dataset)


def create_job_and_dataset(db: Session, job: ETLJobModel, dataset: CatalogDatasetModel) -> tuple[JobRowData, CatalogDataset]:
    ensure_schema(db)
    get_dataset_by_id_for_update(db, dataset.id)
    db.add(dataset)
    db.add(job)
    db.commit()
    db.refresh(job)
    db.refresh(dataset)
    return job_to_schema(db, job), dataset_to_schema(dataset)


def save_dataset(db: Session, dataset: CatalogDatasetModel) -> CatalogDataset:
    ensure_schema(db)
    get_dataset_by_id_for_update(db, dataset.id)
    dataset = db.merge(dataset)
    try:
        db.commit()
    except Exception:
        db.rollback()
        raise
    db.refresh(dataset)
    return dataset_to_schema(dataset)


def save_command_result(
    db: Session,
    job: ETLJobModel,
    run: ETLRunModel | None = None,
    dataset: CatalogDatasetModel | None = None,
) -> tuple[JobRowData, JobRunSummary | None, CatalogDataset | None]:
    ensure_schema(db)
    if dataset is not None:
        get_dataset_by_id_for_update(db, dataset.id)
    merged_dataset = db.merge(dataset) if dataset is not None else None
    if run is not None:
        db.add(run)
    db.add(job)

    try:
        db.commit()
    except Exception:
        db.rollback()
        raise

    db.refresh(job)
    if run is not None:
        db.refresh(run)
    if merged_dataset is not None:
        db.refresh(merged_dataset)

    return (
        job_to_schema(db, job),
        run_to_schema(run) if run is not None else None,
        dataset_to_schema(merged_dataset) if merged_dataset is not None else None,
    )


def create_job(db: Session, job: ETLJobModel) -> JobRowData:
    ensure_schema(db)
    db.add(job)
    db.commit()
    db.refresh(job)
    return job_to_schema(db, job)


def save_job(db: Session, job: ETLJobModel) -> JobRowData:
    ensure_schema(db)
    db.add(job)
    db.commit()
    db.refresh(job)
    return job_to_schema(db, job)


def create_run(db: Session, run: ETLRunModel) -> JobRunSummary:
    ensure_schema(db)
    db.add(run)
    db.commit()
    db.refresh(run)
    return run_to_schema(run)


def get_run(db: Session, run_id: str) -> ETLRunModel | None:
    ensure_schema(db)
    return db.get(ETLRunModel, run_id)


def get_active_kafka_snapshot(
    db: Session,
    topic: str,
    consumer_group_id: str,
    job_id: str | None,
) -> KafkaSnapshotModel | None:
    ensure_schema(db)
    statement = (
        select(KafkaSnapshotModel)
        .where(
            KafkaSnapshotModel.topic == topic,
            KafkaSnapshotModel.consumer_group_id == consumer_group_id,
            KafkaSnapshotModel.status.in_(["running", "failed"]),
        )
        .order_by(KafkaSnapshotModel.created_at.desc())
    )
    if job_id is None:
        statement = statement.where(KafkaSnapshotModel.job_id.is_(None))
    else:
        statement = statement.where(KafkaSnapshotModel.job_id == job_id)
    return db.scalars(statement).first()


def find_conflicting_kafka_snapshot(
    db: Session,
    *,
    broker: str,
    topic: str,
    consumer_group_id: str,
    excluded_job_id: str | None,
) -> KafkaSnapshotModel | None:
    """Return an in-flight snapshot using the same Kafka consumer identity."""
    ensure_schema(db)
    snapshots = db.scalars(
        select(KafkaSnapshotModel)
        .where(
            KafkaSnapshotModel.topic == topic,
            KafkaSnapshotModel.consumer_group_id == consumer_group_id,
            KafkaSnapshotModel.status == "running",
        )
        .order_by(KafkaSnapshotModel.created_at.desc())
    ).all()
    for snapshot in snapshots:
        if excluded_job_id is not None and snapshot.job_id == excluded_job_id:
            continue
        snapshot_broker = str((snapshot.snapshot or {}).get("broker") or "")
        # Older records predate the broker field; blocking them is safer than
        # allowing two consumers to advance an unknown shared identity.
        if not snapshot_broker or snapshot_broker == broker:
            return snapshot
    return None


def save_kafka_snapshot(db: Session, snapshot: KafkaSnapshotModel) -> KafkaSnapshotModel:
    ensure_schema(db)
    db.add(snapshot)
    db.commit()
    db.refresh(snapshot)
    return snapshot


def update_kafka_snapshot(db: Session, snapshot: KafkaSnapshotModel, status: str, error: str | None = None) -> None:
    snapshot.status = status
    snapshot.last_error = error
    db.commit()


def get_kafka_continuous_runtime(db: Session, job_id: str) -> KafkaContinuousRuntimeModel | None:
    ensure_schema(db)
    return db.get(KafkaContinuousRuntimeModel, job_id)


def lock_kafka_continuous_runtime(db: Session, job_id: str) -> KafkaContinuousRuntimeModel | None:
    ensure_schema(db)
    return db.scalars(
        select(KafkaContinuousRuntimeModel)
        .where(KafkaContinuousRuntimeModel.job_id == job_id)
        .with_for_update()
    ).first()


def find_conflicting_kafka_continuous_runtime(
    db: Session,
    *,
    broker: str,
    topic: str,
    consumer_group_id: str,
    excluded_job_id: str,
) -> KafkaContinuousRuntimeModel | None:
    ensure_schema(db)
    return db.scalars(
        select(KafkaContinuousRuntimeModel)
        .where(
            KafkaContinuousRuntimeModel.job_id != excluded_job_id,
            KafkaContinuousRuntimeModel.broker == broker,
            KafkaContinuousRuntimeModel.topic == topic,
            KafkaContinuousRuntimeModel.consumer_group_id == consumer_group_id,
            KafkaContinuousRuntimeModel.status.in_(["starting", "running", "pausing", "stopping"]),
        )
        .order_by(KafkaContinuousRuntimeModel.updated_at.desc())
    ).first()


def save_kafka_continuous_runtime(db: Session, runtime: KafkaContinuousRuntimeModel) -> KafkaContinuousRuntimeModel:
    ensure_schema(db)
    db.add(runtime)
    db.commit()
    db.refresh(runtime)
    return runtime


def save_kafka_continuous_command(db: Session, job: ETLJobModel, runtime: KafkaContinuousRuntimeModel) -> JobRowData:
    ensure_schema(db)
    db.add(job)
    db.add(runtime)
    db.commit()
    db.refresh(job)
    return job_to_schema(db, job)


def stage_kafka_continuous_session(db: Session, session: KafkaContinuousSessionModel) -> None:
    ensure_schema(db)
    db.add(session)


def get_kafka_continuous_session(db: Session, session_id: str) -> KafkaContinuousSessionModel | None:
    ensure_schema(db)
    return db.get(KafkaContinuousSessionModel, session_id)


def get_latest_active_kafka_continuous_session(db: Session, job_id: str) -> KafkaContinuousSessionModel | None:
    ensure_schema(db)
    return db.scalars(
        select(KafkaContinuousSessionModel)
        .where(
            KafkaContinuousSessionModel.job_id == job_id,
            KafkaContinuousSessionModel.status.in_(["starting", "running", "stopping"]),
        )
        .order_by(KafkaContinuousSessionModel.started_at.desc())
    ).first()


def list_kafka_continuous_sessions(db: Session, job_id: str) -> list[KafkaContinuousSession]:
    ensure_schema(db)
    sessions = db.scalars(
        select(KafkaContinuousSessionModel)
        .where(KafkaContinuousSessionModel.job_id == job_id)
        .order_by(KafkaContinuousSessionModel.started_at.desc())
    ).all()
    return [continuous_session_to_schema(session) for session in sessions]


def stage_kafka_continuous_batch(db: Session, batch: KafkaContinuousBatchModel) -> KafkaContinuousBatchModel:
    ensure_schema(db)
    existing = db.get(KafkaContinuousBatchModel, batch.id)
    if existing is None:
        db.add(batch)
        return batch
    existing.status = batch.status
    existing.published_at = batch.published_at or existing.published_at
    existing.consumed_count = batch.consumed_count
    existing.stored_count = batch.stored_count
    existing.quarantined_count = batch.quarantined_count
    existing.duration_ms = batch.duration_ms if batch.duration_ms is not None else existing.duration_ms
    existing.source_ranges = batch.source_ranges
    existing.data_path = batch.data_path or existing.data_path
    existing.quarantine_path = batch.quarantine_path or existing.quarantine_path
    existing.manifest_path = batch.manifest_path or existing.manifest_path
    existing.last_error = batch.last_error
    existing.dag_steps = batch.dag_steps
    db.add(existing)
    return existing


def list_kafka_continuous_batches(
    db: Session,
    session_id: str,
    limit: int = 100,
) -> list[KafkaContinuousBatch]:
    ensure_schema(db)
    batches = db.scalars(
        select(KafkaContinuousBatchModel)
        .where(KafkaContinuousBatchModel.session_id == session_id)
        .order_by(KafkaContinuousBatchModel.batch_id.desc())
        .limit(limit)
    ).all()
    return [continuous_batch_to_schema(batch) for batch in batches]


def save_kafka_continuous_maintenance_run(
    db: Session,
    run: KafkaContinuousMaintenanceRunModel,
) -> ContinuousMaintenanceRun:
    ensure_schema(db)
    db.add(run)
    db.commit()
    db.refresh(run)
    return continuous_maintenance_run_to_schema(run)


def get_kafka_continuous_maintenance_run(db: Session, run_id: str) -> KafkaContinuousMaintenanceRunModel | None:
    ensure_schema(db)
    return db.get(KafkaContinuousMaintenanceRunModel, run_id)


def list_kafka_continuous_maintenance_run_models(
    db: Session,
    job_id: str | None = None,
    active_only: bool = False,
) -> list[KafkaContinuousMaintenanceRunModel]:
    ensure_schema(db)
    statement = select(KafkaContinuousMaintenanceRunModel)
    if job_id:
        statement = statement.where(KafkaContinuousMaintenanceRunModel.job_id == job_id)
    if active_only:
        statement = statement.where(KafkaContinuousMaintenanceRunModel.status.in_(["queued", "running"]))
    return list(db.scalars(statement.order_by(KafkaContinuousMaintenanceRunModel.created_at.desc())).all())


def list_failed_kafka_continuous_replay_models(
    db: Session,
    job_id: str,
) -> list[KafkaContinuousMaintenanceRunModel]:
    ensure_schema(db)
    statement = (
        select(KafkaContinuousMaintenanceRunModel)
        .where(
            KafkaContinuousMaintenanceRunModel.job_id == job_id,
            KafkaContinuousMaintenanceRunModel.kind == "quarantine_replay",
            KafkaContinuousMaintenanceRunModel.status == "failed",
        )
        .order_by(KafkaContinuousMaintenanceRunModel.created_at.asc())
    )
    return list(db.scalars(statement).all())


def list_kafka_continuous_maintenance_runs(db: Session, job_id: str) -> list[ContinuousMaintenanceRun]:
    return [continuous_maintenance_run_to_schema(run) for run in list_kafka_continuous_maintenance_run_models(db, job_id)]


def list_runs_for_job(db: Session, job_id: str) -> list[JobRunSummary]:
    ensure_schema(db)
    runs = db.scalars(
        select(ETLRunModel)
        .where(ETLRunModel.job_id == job_id)
        .order_by(ETLRunModel.created_at.desc())
    ).all()
    return [run_to_schema(run) for run in runs]


def list_run_models_for_job(db: Session, job_id: str) -> list[ETLRunModel]:
    ensure_schema(db)
    return db.scalars(
        select(ETLRunModel)
        .where(ETLRunModel.job_id == job_id)
        .order_by(ETLRunModel.created_at.desc())
    ).all()


def get_run_model(db: Session, run_id: str) -> ETLRunModel | None:
    ensure_schema(db)
    return db.get(ETLRunModel, run_id)


def find_active_eks_fixture_slot_run(
    db: Session,
    consumer_group: str,
) -> ETLRunModel | None:
    """Serialize and find an active EKS fixture Run using one approved slot."""
    ensure_schema(db)
    normalized_group = str(consumer_group or "").strip()
    if db.get_bind().dialect.name == "postgresql":
        db.execute(
            text(
                "SELECT pg_advisory_xact_lock("
                "hashtextextended(:lock_key, 0)"
                ")"
            ),
            {"lock_key": f"asklake:eks-fixture-slot:{normalized_group}"},
        )
    runs = db.scalars(
        select(ETLRunModel)
        .where(ETLRunModel.status.in_(["queued", "running"]))
        .order_by(ETLRunModel.created_at.asc())
    ).all()
    for run in runs:
        state = (run.task_states or {}).get("eksMvpFixture")
        boundary = state.get("sourceBoundary") if isinstance(state, dict) else None
        if (
            isinstance(boundary, dict)
            and str(boundary.get("consumerGroup") or "").strip() == normalized_group
        ):
            return run
    return None


def refresh_run_for_update(db: Session, run: ETLRunModel) -> None:
    ensure_schema(db)
    db.refresh(run, with_for_update=True)


def claim_run_execution_lease(
    db: Session,
    run_id: str,
    *,
    owner: str,
    lease_seconds: int,
) -> RunExecutionLease | None:
    """Atomically claim an expired or unowned ETL Run execution lease."""
    ensure_schema(db)
    now = datetime.now(timezone.utc)
    run = db.scalar(
        select(ETLRunModel)
        .where(ETLRunModel.run_id == run_id)
        .with_for_update()
    )
    if run is None:
        db.rollback()
        return None
    if execution_lease_is_live(run.execution_lease_expires_at, now):
        db.rollback()
        return None

    recovered = run.execution_lease_expires_at is not None
    run.execution_generation = int(run.execution_generation or 0) + 1
    run.execution_owner = owner
    run.execution_lease_expires_at = now + timedelta(seconds=lease_seconds)
    db.commit()
    return RunExecutionLease(generation=run.execution_generation, recovered=recovered)


def renew_run_execution_lease(
    db: Session,
    run_id: str,
    *,
    owner: str,
    generation: int,
    lease_seconds: int,
) -> bool:
    ensure_schema(db)
    now = datetime.now(timezone.utc)
    run = db.scalar(
        select(ETLRunModel)
        .where(ETLRunModel.run_id == run_id)
        .with_for_update()
    )
    if (
        run is None
        or run.execution_owner != owner
        or run.execution_generation != generation
        or run.execution_lease_expires_at is None
        or not execution_lease_is_live(run.execution_lease_expires_at, now)
    ):
        db.rollback()
        return False
    run.execution_lease_expires_at = now + timedelta(seconds=lease_seconds)
    db.commit()
    return True


def get_run_for_execution_fence(
    db: Session,
    run_id: str,
    *,
    owner: str,
    generation: int,
) -> ETLRunModel | None:
    """Lock a Run only when the caller still owns its live lease generation."""
    ensure_schema(db)
    now = datetime.now(timezone.utc)
    run = db.scalar(
        select(ETLRunModel)
        .where(ETLRunModel.run_id == run_id)
        .with_for_update()
    )
    if (
        run is None
        or run.execution_owner != owner
        or run.execution_generation != generation
        or run.execution_lease_expires_at is None
        or not execution_lease_is_live(run.execution_lease_expires_at, now)
    ):
        db.rollback()
        return None
    return run


def release_run_execution_lease(
    db: Session,
    run_id: str,
    *,
    owner: str,
    generation: int,
) -> bool:
    run = get_run_for_execution_fence(db, run_id, owner=owner, generation=generation)
    if run is None:
        return False
    run.execution_owner = None
    run.execution_lease_expires_at = None
    db.commit()
    return True


def public_sql_recipe(value: object) -> dict[str, Any] | None:
    """Return the public SQL recipe without a persisted identity snapshot."""
    if not isinstance(value, dict):
        return None
    recipe = dict(value)
    legacy_run_as = recipe.pop("runAs", None)
    if not recipe.get("runAsUserId") and isinstance(legacy_run_as, dict):
        legacy_user_id = str(legacy_run_as.get("id") or "").strip()
        if legacy_user_id:
            recipe["runAsUserId"] = legacy_user_id
    return recipe


def job_to_schema(
    db: Session,
    job: ETLJobModel,
    *,
    continuous_runtime: KafkaContinuousRuntimeModel | None = None,
    related_loaded: bool = False,
    run_history: list[JobRunSummary] | None = None,
) -> JobRowData:
    runtime = continuous_runtime
    hydrated_run_history = run_history or []
    if not related_loaded:
        runtime = get_kafka_continuous_runtime(db, job.id) if db is not None and job.execution_mode == "continuous" else None
        hydrated_run_history = list_runs_for_job(db, job.id)
    persisted_rules = job.rules if job.rule_contract_version is not None and job.rules is not None else None
    compiled_rules = compile_rule_set(
        contract_version=job.rule_contract_version,
        rules=persisted_rules,
        transform_steps=job.transform_steps,
        quality_rules=job.quality_rules,
        schema_columns=job.schema_columns,
        transform_output_columns=job.transform_output_columns,
        execution_mode=job.execution_mode or "snapshot",
        source_type=job.source_type or "",
    )
    return JobRowData(
        created_at=job.created_at.isoformat() if job.created_at else None,
        id=job.id,
        name=job.name or job.target or job.id,
        owner=job.owner or "demo-user",
        created_by=job.created_by or job.owner or "demo-user",
        created_by_profile=job.created_by_profile,
        permission_grants=[],
        permissions=resource_permissions(can_run=True),
        status=job.status or "scheduled",
        tag=job.tag or "[생성]",
        source=job.source or job.source_label or "-",
        target=job.target or job.name or job.id,
        updated_at=job.updated_at.isoformat() if job.updated_at else None,
        schedule=job.schedule or "-",
        schedule_policy=job.schedule_policy,
        schedule_summary=job.schedule_summary,
        source_config=job.source_config,
        source_label=job.source_label,
        source_type=job.source_type,
        job_kind=job.job_kind or "pipeline",
        sql_recipe=public_sql_recipe(job.sql_recipe),
        execution_mode=job.execution_mode or "snapshot",
        continuous_config=job.continuous_config,
        continuous_runtime=continuous_runtime_to_schema(runtime),
        record_parsing=job.record_parsing,
        schema_columns=job.schema_columns,
        schema_fingerprint=job.schema_fingerprint,
        schema_sample_rows=job.schema_sample_rows,
        schema_summary=job.schema_summary,
        rule_summary=job.rule_summary,
        rule_contract_version=compiled_rules.result.contract_version,
        rules=compiled_rules.result.rules,
        rule_compilation=compiled_rules.result,
        retry_policy=job.retry_policy,
        retry_policy_summary=job.retry_policy_summary,
        run_limit_summary=job.run_limit_summary,
        permission_roles=job.permission_roles,
        permission_summary=job.permission_summary,
        storage_type=job.storage_type,
        partition=job.partition,
        partition_columns=job.partition_columns,
        index_columns=job.index_columns,
        compression=job.compression,
        storage_path=job.storage_path,
        iceberg_target=job.iceberg_target,
        target_description=job.target_description,
        target_database=job.target_database,
        target_tags=job.target_tags,
        target_format=job.target_format,
        target_layer=job.target_layer,
        target_path=job.target_path,
        transform_output_columns=job.transform_output_columns,
        transform_steps=job.transform_steps,
        quality_invalid_rows=job.quality_invalid_rows,
        quality_rules=job.quality_rules,
        quality_score=job.quality_score,
        quality_status=job.quality_status,
        last_run=job.last_run or "-",
        last_state=job.last_state or "-",
        next_run=job.next_run or "-",
        progress=job.progress,
        stats=job.stats,
        run_history=hydrated_run_history,
        dag_steps=job.dag_steps,
        dag_steps_by_run_id=job.dag_steps_by_run_id,
    )


def continuous_runtime_to_schema(runtime: KafkaContinuousRuntimeModel | None) -> KafkaContinuousRuntime | None:
    if runtime is None:
        return None
    metrics = runtime.metrics or {}
    schema_state = runtime.schema_state or {}
    record_legacy_runtime_error_projection(
        metrics,
        runtime.last_error,
        public_status=runtime.status,
    )
    contract = runtime_contract_projection(
        metrics,
        public_status=runtime.status,
        legacy_error=runtime.last_error,
    )
    return KafkaContinuousRuntime(
        status=runtime.status,
        desired_state=contract["desiredState"],
        observed_state=contract["observedState"],
        state_revision=contract["stateRevision"],
        fencing_token=contract["fencingToken"],
        error_detail=contract["errorDetail"],
        checkpoint_path=runtime.checkpoint_path,
        heartbeat_at=runtime.heartbeat_at,
        last_flush_at=runtime.last_flush_at,
        last_batch_id=runtime.last_batch_id,
        lag=runtime.lag,
        max_partition_lag=metrics.get("maxPartitionLag"),
        lagging_partition_count=int(metrics.get("laggingPartitionCount") or 0),
        lag_available=bool(metrics.get("lagAvailable")),
        partition_progress=metrics.get("partitionProgress") or {},
        last_batch_duration_ms=metrics.get("lastBatchDurationMs"),
        last_batch_input_rows=int(metrics.get("lastBatchInputRows") or 0),
        throughput_rows_per_second=metrics.get("throughputRowsPerSecond"),
        schema_version=int(schema_state.get("schemaVersion") or 1),
        schema_fingerprint=schema_state.get("schemaFingerprint"),
        schema_status=str(schema_state.get("schemaStatus") or "stable"),
        schema_changes=schema_state.get("schemaChanges") or [],
        rule_contract_version=str(metrics.get("ruleContractVersion") or "1.0"),
        rule_fingerprint=metrics.get("ruleFingerprint"),
        runtime_fingerprint=metrics.get("runtimeFingerprint"),
        rule_metrics=metrics.get("ruleMetrics") or {},
        last_rule_result=metrics.get("lastRuleResult") or {},
        consumed_count=int(runtime.consumed_count or 0),
        stored_count=int(runtime.stored_count or 0),
        quarantined_count=int(runtime.quarantined_count or 0),
        replayed_count=int(metrics.get("replayedCount") or 0),
        failed_count=int(runtime.failed_count or 0),
        last_error=runtime.last_error,
    )


def continuous_session_to_schema(session: KafkaContinuousSessionModel) -> KafkaContinuousSession:
    return KafkaContinuousSession(
        session_id=session.session_id,
        job_id=session.job_id,
        worker_attempt_id=session.worker_attempt_id,
        status=session.status,
        started_at=session.started_at,
        ended_at=session.ended_at,
        end_reason=session.end_reason,
        consumed_count=int(session.consumed_count or 0),
        stored_count=int(session.stored_count or 0),
        quarantined_count=int(session.quarantined_count or 0),
        failed_count=int(session.failed_count or 0),
        last_batch_id=session.last_batch_id,
        last_flush_at=session.last_flush_at,
        lag=session.lag,
        checkpoint_path=session.checkpoint_path,
        last_error=session.last_error,
        dag_steps=session.dag_steps or [],
    )


def continuous_batch_to_schema(batch: KafkaContinuousBatchModel) -> KafkaContinuousBatch:
    return KafkaContinuousBatch(
        batch_id=batch.batch_id,
        session_id=batch.session_id,
        status=batch.status,
        published_at=batch.published_at,
        consumed_count=int(batch.consumed_count or 0),
        stored_count=int(batch.stored_count or 0),
        quarantined_count=int(batch.quarantined_count or 0),
        duration_ms=batch.duration_ms,
        source_ranges=batch.source_ranges or [],
        source_boundary=batch.source_boundary or {},
        data_path=batch.data_path,
        iceberg_snapshot_id=batch.iceberg_snapshot_id,
        iceberg_table_uri=batch.iceberg_table_uri,
        quarantine_path=batch.quarantine_path,
        manifest_path=batch.manifest_path,
        last_error=batch.last_error,
        dag_steps=batch.dag_steps or [],
    )


def continuous_maintenance_run_to_schema(run: KafkaContinuousMaintenanceRunModel) -> ContinuousMaintenanceRun:
    return ContinuousMaintenanceRun(
        run_id=run.run_id,
        job_id=run.job_id,
        kind=run.kind,
        status=run.status,
        requested_by=run.requested_by,
        config=run.config or {},
        result=run.result,
        started_at=run.started_at,
        ended_at=run.ended_at,
        last_error=run.last_error,
    )


def dataset_to_schema(dataset: CatalogDatasetModel) -> CatalogDataset:
    if dataset.payload:
        payload = dataset.payload
        return CatalogDataset(
            id=str(payload.get("id") or dataset.id),
            name=str(payload.get("name") or dataset.id),
            description=str(payload.get("description") or ""),
            owner=str(payload.get("owner") or ""),
            created_by=payload.get("createdBy"),
            created_by_profile=payload.get("createdByProfile"),
            permission_grants=payload.get("permissionGrants") or permission_grants_from_roles(str(payload.get("owner") or ""), default_actions=["view", "query"]),
            permissions=payload.get("permissions") or resource_permissions(can_query=True),
            layer=payload.get("layer") or "RAW",
            status=payload.get("status") or "available",
            freshness=payload.get("freshness") or "latest",
            source=str(payload.get("source") or ""),
            rows=str(payload.get("rows") or "0"),
            size=str(payload.get("size") or "Pending"),
            quality=str(payload.get("quality") or "확인 대기"),
            last_updated=str(payload.get("lastUpdated") or ""),
            next_refresh=str(payload.get("nextRefresh") or "-"),
            rag=bool(payload.get("rag")),
            tags=payload.get("tags") or [],
            schema_=payload.get("schema") or [],
            sample_rows=payload.get("sampleRows") or [],
            upstream=payload.get("upstream") or [],
            downstream=payload.get("downstream") or [],
            source_run_id=payload.get("sourceRunId"),
            storage_format=payload.get("storageFormat"),
            storage_location=payload.get("storageLocation"),
            storage_size_bytes=payload.get("storageSizeBytes"),
            lineage_graph=payload.get("lineageGraph"),
            materialization_runs=payload.get("materializationRuns") or [],
        )

    return CatalogDataset(
        id=dataset.id,
        name=dataset.name or dataset.id,
        description=dataset.description or "",
        owner=dataset.owner or "",
        created_by=dataset.payload.get("createdBy") if dataset.payload else dataset.owner,
        created_by_profile=dataset.payload.get("createdByProfile") if dataset.payload else None,
        permission_grants=permission_grants_from_roles(dataset.owner, default_actions=["view", "query"]),
        permissions=resource_permissions(can_query=True),
        layer=dataset.layer or "RAW",
        status=dataset.status or "available",
        freshness=dataset.freshness or "latest",
        source=dataset.source or "",
        rows=dataset.rows or "0",
        size=dataset.size or "Pending",
        quality=dataset.quality or "확인 대기",
        last_updated=dataset.last_updated or "",
        next_refresh=dataset.next_refresh or "-",
        rag=bool(dataset.rag),
        tags=dataset.tags or [],
        schema_=dataset.schema_json or [],
        sample_rows=dataset.sample_rows or [],
        upstream=dataset.upstream or [],
        downstream=dataset.downstream or [],
        lineage_graph=dataset.lineage_graph,
        materialization_runs=[],
    )


def run_to_schema(run: ETLRunModel) -> JobRunSummary:
    spark_result = (run.task_states or {}).get("sparkResult")
    if not isinstance(spark_result, dict):
        spark_result = {}
    return JobRunSummary(
        run_id=run.run_id,
        status=run.status,
        started_at=run.started_at,
        ended_at=run.ended_at,
        duration=run.duration,
        input_bytes=_optional_non_negative_int(spark_result.get("inputBytes")),
        input_file_count=_optional_non_negative_int(spark_result.get("inputFileCount")),
        input_rows=run.input_rows,
        output_file_count=_optional_non_negative_int(spark_result.get("outputFileCount")),
        output_rows=run.output_rows,
        output_path=run.output_path,
        failed_stage=run.failed_stage,
        error_summary=run.error_summary,
        airflow_dag_id=run.airflow_dag_id,
        airflow_dag_run_id=run.airflow_dag_run_id,
        airflow_run_url=run.airflow_run_url,
        airflow_state=run.airflow_state,
        task_states=run.task_states,
        last_synced_at=run.last_synced_at,
        sync_error=run.sync_error,
    )


def _optional_non_negative_int(value: Any) -> int | None:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed >= 0 else None
