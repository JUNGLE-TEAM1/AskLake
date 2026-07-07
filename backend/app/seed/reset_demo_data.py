import shutil
import sys
from pathlib import Path

from app import models as _models  # noqa: F401
from app.core.config import settings
from app.core.database import SessionLocal, engine
from app.models import CatalogDatasetModel, ETLJobModel, ETLRunModel, SqlRunModel
from app.models.base import Base


BASE_DATASET_IDS = {
    "ds_orders_clean",
    "ds_customers_clean",
    "ds_order_items_clean",
    "ds_products_clean",
    "ds_payments_clean",
    "ds_customer_orders_gold",
    "ds_customer_reviews_source",
    "ds_app_events_source",
}


def reset_demo_data(*, dry_run: bool = False) -> None:
    Base.metadata.create_all(bind=engine)
    with SessionLocal() as session:
        catalog_models = session.query(CatalogDatasetModel).all()
        generated_dataset_ids = {
            dataset.id
            for dataset in catalog_models
            if is_generated_dataset(dataset)
        }

        generated_jobs = [
            job
            for job in session.query(ETLJobModel).all()
            if is_generated_job(job, generated_dataset_ids)
        ]
        generated_job_ids = {job.id for job in generated_jobs}

        sql_run_count = session.query(SqlRunModel).count()
        run_count = (
            session.query(ETLRunModel)
            .filter(ETLRunModel.job_id.in_(generated_job_ids))
            .count()
            if generated_job_ids
            else 0
        )

        print(
            "Demo reset target: "
            f"{len(generated_dataset_ids)} catalog datasets, "
            f"{len(generated_job_ids)} jobs, "
            f"{run_count} runs, "
            f"{sql_run_count} sql runs"
        )

        if dry_run:
            print("Dry run only; no data deleted.")
            return

        if generated_job_ids:
            session.query(ETLRunModel).filter(ETLRunModel.job_id.in_(generated_job_ids)).delete(synchronize_session=False)
            session.query(ETLJobModel).filter(ETLJobModel.id.in_(generated_job_ids)).delete(synchronize_session=False)
        if generated_dataset_ids:
            session.query(CatalogDatasetModel).filter(CatalogDatasetModel.id.in_(generated_dataset_ids)).delete(synchronize_session=False)
        session.query(SqlRunModel).delete(synchronize_session=False)
        session.commit()

    remove_sql_derived_storage()
    print("Demo reset complete. Base fixture datasets were preserved.")


def is_generated_dataset(dataset: CatalogDatasetModel) -> bool:
    if dataset.id in BASE_DATASET_IDS:
        return False

    payload = dataset.payload or {}
    tags = set(payload.get("tags") or dataset.tags or [])
    name = str(payload.get("name") or dataset.name or "")
    source = str(payload.get("source") or dataset.source or "")
    storage_location = str(payload.get("storageLocation") or "")

    return (
        bool(payload.get("sourceRunId"))
        or "#sql-derived" in tags
        or "#생성" in tags
        or "SQL Materialize" in source
        or name.endswith("_analysis")
        or dataset.id.startswith("ds_orders_clean_analysis")
        or "sql-derived" in storage_location
    )


def is_generated_job(job: ETLJobModel, generated_dataset_ids: set[str]) -> bool:
    name = str(job.name or "")
    target = str(job.target or "")
    return (
        str(job.source_type or "") == "SQL Result"
        or bool(job.dataset_id and job.dataset_id in generated_dataset_ids)
        or target.endswith("_analysis")
        or name.endswith("_analysis")
    )


def remove_sql_derived_storage() -> None:
    if not settings.local_lake_storage_dir:
        return
    derived_root = Path(settings.local_lake_storage_dir) / "sql-derived"
    if derived_root.exists():
        shutil.rmtree(derived_root)
        print(f"Removed SQL derived storage: {derived_root}")


if __name__ == "__main__":
    reset_demo_data(dry_run="--dry-run" in sys.argv)
