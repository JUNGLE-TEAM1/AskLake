from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import CatalogDatasetModel, ETLJobModel, ETLRunModel
from app.models.base import Base
from app.schemas.etl import CatalogDataset, JobRowData, JobRunSummary


def ensure_schema(db: Session) -> None:
    Base.metadata.create_all(bind=db.get_bind())


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
    )


def dataset_to_schema(dataset: CatalogDatasetModel) -> CatalogDataset:
    return CatalogDataset(
        id=dataset.id,
        name=dataset.name,
        description=dataset.description,
        owner=dataset.owner,
        layer=dataset.layer,
        status=dataset.status,
        freshness=dataset.freshness,
        source=dataset.source,
        rows=dataset.rows,
        size=dataset.size,
        quality=dataset.quality,
        last_updated=dataset.last_updated,
        next_refresh=dataset.next_refresh,
        rag=dataset.rag,
        tags=dataset.tags,
        schema_=dataset.schema_json,
        sample_rows=dataset.sample_rows,
        upstream=dataset.upstream,
        downstream=dataset.downstream,
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
