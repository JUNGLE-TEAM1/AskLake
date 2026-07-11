from sqlalchemy import inspect, select, text
from sqlalchemy.orm import Session

from app.core.permission_metadata import permission_grants_from_roles, resource_permissions
from app.models import CatalogDatasetModel, ETLJobModel, ETLRunModel, KafkaContinuousMaintenanceRunModel, KafkaContinuousRuntimeModel, KafkaSnapshotModel
from app.models.base import Base
from app.repositories.catalog_repository import ensure_catalog_schema
from app.schemas.etl import CatalogDataset, ContinuousMaintenanceRun, JobRowData, JobRunSummary, KafkaContinuousRuntime

_schema_ready_bind_ids: set[int] = set()


def ensure_schema(db: Session) -> None:
    bind = db.get_bind()
    bind_key = id(bind)
    if bind_key in _schema_ready_bind_ids:
        return

    with bind.begin() as connection:
        Base.metadata.create_all(bind=connection)
        inspector = inspect(connection)
        existing_columns = {column["name"] for column in inspector.get_columns("etl_jobs")}
        if "payload" in existing_columns:
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
            "permission_roles": "JSON",
            "permission_summary": "TEXT",
            "progress": "JSON",
            "quality_invalid_rows": "JSON",
            "quality_rules": "JSON",
            "quality_score": "FLOAT",
            "quality_status": "VARCHAR(32)",
            "rag": "BOOLEAN",
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
            "source": "VARCHAR(255)",
            "source_config": "JSON",
            "source_label": "VARCHAR(255)",
            "source_type": "VARCHAR(120)",
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
            if column_name not in existing_columns:
                connection.execute(text(f"ALTER TABLE etl_jobs ADD COLUMN {column_name} {column_type}"))

        runtime_columns = {column["name"] for column in inspector.get_columns("kafka_continuous_runtimes")}
        for column_name in ("metrics", "schema_state"):
            if column_name not in runtime_columns:
                connection.execute(text(f"ALTER TABLE kafka_continuous_runtimes ADD COLUMN {column_name} JSON"))

        job_defaults = {
            "dag_steps": "[]",
            "execution_mode": "snapshot",
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
                "stats",
                "transform_output_columns",
                "transform_steps",
            } and connection.dialect.name != "sqlite":
                sql_value = f"'{default_value}'::json"
            else:
                sql_value = f"'{default_value}'"
            connection.execute(text(f"UPDATE etl_jobs SET {column_name} = {sql_value} WHERE {column_name} IS NULL"))
        if "schema_fingerprint" in existing_columns:
            connection.execute(text("ALTER TABLE etl_jobs ALTER COLUMN schema_fingerprint TYPE TEXT"))
        if "last_state" in existing_columns:
            connection.execute(text("ALTER TABLE etl_jobs ALTER COLUMN last_state TYPE TEXT"))

        existing_run_columns = {column["name"] for column in inspector.get_columns("etl_runs")}
        if "failed_stage" in existing_run_columns:
            connection.execute(text("ALTER TABLE etl_runs ALTER COLUMN failed_stage TYPE TEXT"))
        if "error_summary" in existing_run_columns:
            connection.execute(text("ALTER TABLE etl_runs ALTER COLUMN error_summary TYPE TEXT"))


        existing_run_columns = {column["name"] for column in inspector.get_columns("etl_runs")}
        run_column_defs = {
            "airflow_dag_id": "VARCHAR(255)",
            "airflow_dag_run_id": "VARCHAR(255)",
            "airflow_run_url": "VARCHAR(1024)",
            "airflow_state": "VARCHAR(64)",
            "last_synced_at": "VARCHAR(64)",
            "sync_error": "VARCHAR(512)",
            "task_states": "JSON",
        }
        for column_name, column_type in run_column_defs.items():
            if column_name not in existing_run_columns:
                connection.execute(text(f"ALTER TABLE etl_runs ADD COLUMN {column_name} {column_type}"))

    ensure_catalog_schema(db)
    _schema_ready_bind_ids.add(bind_key)


def list_jobs(db: Session) -> list[JobRowData]:
    ensure_schema(db)
    jobs = db.scalars(select(ETLJobModel).order_by(ETLJobModel.created_at.desc())).all()
    return [job_to_schema(db, job) for job in jobs]


def list_job_models(db: Session) -> list[ETLJobModel]:
    ensure_schema(db)
    return db.scalars(select(ETLJobModel).order_by(ETLJobModel.created_at.desc())).all()


def get_job(db: Session, job_id: str) -> ETLJobModel | None:
    ensure_schema(db)
    return db.get(ETLJobModel, job_id)


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
    return db.scalar(
        select(CatalogDatasetModel)
        .where(CatalogDatasetModel.id == dataset_id)
        .with_for_update()
    )


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
    db.add(dataset)
    db.add(job)
    db.commit()
    db.refresh(job)
    db.refresh(dataset)
    return job_to_schema(db, job), dataset_to_schema(dataset)


def save_dataset(db: Session, dataset: CatalogDatasetModel) -> CatalogDataset:
    ensure_schema(db)
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


def refresh_run_for_update(db: Session, run: ETLRunModel) -> None:
    ensure_schema(db)
    db.refresh(run, with_for_update=True)


def job_to_schema(db: Session, job: ETLJobModel) -> JobRowData:
    runtime = get_kafka_continuous_runtime(db, job.id) if db is not None and job.execution_mode == "continuous" else None
    return JobRowData(
        created_at=job.created_at.isoformat() if job.created_at else None,
        id=job.id,
        name=job.name or job.target or job.id,
        owner=job.owner or "demo-user",
        created_by=job.created_by or job.owner or "demo-user",
        created_by_profile=job.created_by_profile,
        permission_grants=permission_grants_from_roles(job.owner, job.permission_roles, default_actions=["view", "run"]),
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
        execution_mode=job.execution_mode or "snapshot",
        continuous_config=job.continuous_config,
        continuous_runtime=continuous_runtime_to_schema(runtime),
        schema_columns=job.schema_columns,
        schema_fingerprint=job.schema_fingerprint,
        schema_sample_rows=job.schema_sample_rows,
        schema_summary=job.schema_summary,
        rule_summary=job.rule_summary,
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
        run_history=list_runs_for_job(db, job.id),
        dag_steps=job.dag_steps,
        dag_steps_by_run_id=job.dag_steps_by_run_id,
    )


def continuous_runtime_to_schema(runtime: KafkaContinuousRuntimeModel | None) -> KafkaContinuousRuntime | None:
    if runtime is None:
        return None
    metrics = runtime.metrics or {}
    schema_state = runtime.schema_state or {}
    return KafkaContinuousRuntime(
        status=runtime.status,
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
        consumed_count=int(runtime.consumed_count or 0),
        stored_count=int(runtime.stored_count or 0),
        quarantined_count=int(runtime.quarantined_count or 0),
        replayed_count=int(metrics.get("replayedCount") or 0),
        failed_count=int(runtime.failed_count or 0),
        last_error=runtime.last_error,
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
    return JobRunSummary(
        run_id=run.run_id,
        status=run.status,
        started_at=run.started_at,
        ended_at=run.ended_at,
        duration=run.duration,
        input_rows=run.input_rows,
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
