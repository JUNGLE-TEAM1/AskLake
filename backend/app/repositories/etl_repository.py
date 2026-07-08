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
            "dag_steps": "JSON",
            "dag_steps_by_run_id": "JSON",
            "dataset_id": "VARCHAR(120)",
            "last_run": "VARCHAR(64)",
            "last_state": "VARCHAR(255)",
            "name": "VARCHAR(255)",
            "next_run": "VARCHAR(255)",
            "owner": "VARCHAR(255)",
            "partition": "VARCHAR(255)",
            "payload": "JSONB NOT NULL DEFAULT '{}'::jsonb",
            "permission_roles": "JSON",
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
            "target_format": "VARCHAR(120)",
            "target_layer": "VARCHAR(32)",
            "target_path": "VARCHAR(512)",
            "transform_output_columns": "JSON",
            "transform_steps": "JSON",
        }
        for column_name, column_type in column_defs.items():
            if column_name not in existing_columns:
                connection.execute(text(f"ALTER TABLE etl_jobs ADD COLUMN {column_name} {column_type}"))
        if "payload" in existing_columns:
            connection.execute(text("UPDATE etl_jobs SET payload = '{}'::jsonb WHERE payload IS NULL"))
            connection.execute(text("ALTER TABLE etl_jobs ALTER COLUMN payload SET DEFAULT '{}'::jsonb"))
        if "schema_fingerprint" in existing_columns:
            connection.execute(text("ALTER TABLE etl_jobs ALTER COLUMN schema_fingerprint TYPE TEXT"))

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
    sync_job_payload(db, job, run)
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
    sync_job_payload(db, job)
    db.add(job)
    db.commit()
    db.refresh(job)
    return job_to_schema(db, job)


def save_job(db: Session, job: ETLJobModel) -> JobRowData:
    ensure_schema(db)
    sync_job_payload(db, job)
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


def sync_job_payload(db: Session, job: ETLJobModel, pending_run: ETLRunModel | None = None) -> None:
    run_history = list_runs_for_job(db, job.id)
    if pending_run is not None:
        run_history = [run_to_schema(pending_run), *[run for run in run_history if run.run_id != pending_run.run_id]]

    payload = job_to_schema(db, job, run_history=run_history).model_dump(mode="json", by_alias=True)
    job.payload = {
        **(job.payload or {}),
        **payload,
    }


def job_to_schema(db: Session, job: ETLJobModel, run_history: list[JobRunSummary] | None = None) -> JobRowData:
    payload = job.payload if isinstance(job.payload, dict) else {}

    return JobRowData(
        id=job.id,
        name=job.name or payload.get("name") or job.target or job.id,
        owner=job.owner or payload.get("owner") or "demo-user",
        status=job.status or payload.get("status") or "scheduled",
        tag=job.tag or payload.get("tag") or "[생성]",
        source=job.source or payload.get("source") or job.source_label or "-",
        target=job.target or payload.get("target") or job.name or job.id,
        schedule=job.schedule or payload.get("schedule") or "-",
        schedule_policy=job.schedule_policy or payload.get("schedulePolicy"),
        schedule_summary=job.schedule_summary or payload.get("scheduleSummary"),
        source_config=job.source_config or payload.get("sourceConfig"),
        source_label=job.source_label or payload.get("sourceLabel"),
        source_type=job.source_type or payload.get("sourceType"),
        retry_policy=job.retry_policy or payload.get("retryPolicy"),
        retry_policy_summary=job.retry_policy_summary or payload.get("retryPolicySummary"),
        run_limit_summary=job.run_limit_summary or payload.get("runLimitSummary"),
        permission_roles=job.permission_roles or payload.get("permissionRoles"),
        storage_type=job.storage_type or payload.get("storageType"),
        partition=job.partition or payload.get("partition"),
        compression=job.compression or payload.get("compression"),
        storage_path=job.storage_path or payload.get("storagePath"),
        target_format=job.target_format or payload.get("targetFormat"),
        target_layer=job.target_layer or payload.get("targetLayer"),
        target_path=job.target_path or payload.get("targetPath"),
        transform_output_columns=job.transform_output_columns or payload.get("transformOutputColumns"),
        transform_steps=job.transform_steps or payload.get("transformSteps"),
        quality_invalid_rows=job.quality_invalid_rows or payload.get("qualityInvalidRows"),
        quality_rules=job.quality_rules or payload.get("qualityRules"),
        quality_score=job.quality_score if job.quality_score is not None else payload.get("qualityScore"),
        quality_status=job.quality_status or payload.get("qualityStatus"),
        last_run=job.last_run or payload.get("lastRun") or "-",
        last_state=job.last_state or payload.get("lastState") or "-",
        next_run=job.next_run or payload.get("nextRun") or "-",
        progress=job.progress or payload.get("progress"),
        stats=job.stats or payload.get("stats"),
        run_history=run_history if run_history is not None else list_runs_for_job(db, job.id),
        dag_steps=job.dag_steps or payload.get("dagSteps"),
        dag_steps_by_run_id=job.dag_steps_by_run_id or payload.get("dagStepsByRunId"),
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
    )
