from sqlalchemy import inspect, select, text
from sqlalchemy.orm import Session

from app.models import CatalogDatasetModel, ETLJobModel, ETLRunModel
from app.models.base import Base
from app.repositories.catalog_repository import ensure_catalog_schema
from app.schemas.etl import CatalogDataset, JobRowData, JobRunSummary

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
        column_defs = {
            "compression": "VARCHAR(64)",
            "dag_steps_by_run_id": "JSON",
            "partition": "VARCHAR(255)",
            "permission_roles": "JSON",
            "storage_path": "VARCHAR(512)",
            "storage_type": "VARCHAR(64)",
        }
        for column_name, column_type in column_defs.items():
            if column_name not in existing_columns:
                connection.execute(text(f"ALTER TABLE etl_jobs ADD COLUMN {column_name} {column_type}"))
        if "schema_fingerprint" in existing_columns and connection.dialect.name != "sqlite":
            connection.execute(text("ALTER TABLE etl_jobs ALTER COLUMN schema_fingerprint TYPE TEXT"))

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
    db.commit()
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


def list_runs_for_job(db: Session, job_id: str) -> list[JobRunSummary]:
    ensure_schema(db)
    runs = db.scalars(
        select(ETLRunModel)
        .where(ETLRunModel.job_id == job_id)
        .order_by(ETLRunModel.created_at.desc())
    ).all()
    return [run_to_schema(run) for run in runs]


def job_to_schema(db: Session, job: ETLJobModel) -> JobRowData:
    return JobRowData(
        id=job.id,
        name=job.name,
        owner=job.owner,
        status=job.status,
        tag=job.tag,
        source=job.source,
        target=job.target,
        schedule=job.schedule,
        source_config=job.source_config,
        source_label=job.source_label,
        source_type=job.source_type,
        permission_roles=job.permission_roles,
        storage_type=job.storage_type,
        partition=job.partition,
        compression=job.compression,
        storage_path=job.storage_path,
        target_format=job.target_format,
        target_layer=job.target_layer,
        target_path=job.target_path,
        transform_output_columns=job.transform_output_columns,
        transform_steps=job.transform_steps,
        quality_invalid_rows=job.quality_invalid_rows,
        quality_rules=job.quality_rules,
        quality_score=job.quality_score,
        quality_status=job.quality_status,
        last_run=job.last_run,
        last_state=job.last_state,
        next_run=job.next_run,
        progress=job.progress,
        stats=job.stats,
        run_history=list_runs_for_job(db, job.id),
        dag_steps=job.dag_steps,
        dag_steps_by_run_id=job.dag_steps_by_run_id,
    )


def dataset_to_schema(dataset: CatalogDatasetModel) -> CatalogDataset:
    if dataset.payload:
        payload = dataset.payload
        return CatalogDataset(
            id=str(payload.get("id") or dataset.id),
            name=str(payload.get("name") or dataset.id),
            description=str(payload.get("description") or ""),
            owner=str(payload.get("owner") or ""),
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
            lineage_graph=payload.get("lineageGraph"),
        )

    return CatalogDataset(
        id=dataset.id,
        name=dataset.name or dataset.id,
        description=dataset.description or "",
        owner=dataset.owner or "",
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
        last_synced_at=run.last_synced_at,
        sync_error=run.sync_error,
        task_states=run.task_states,
    )
