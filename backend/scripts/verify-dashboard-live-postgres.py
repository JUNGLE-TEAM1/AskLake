import os
from uuid import uuid4

from sqlalchemy import delete, inspect

from app.core.database import SessionLocal
from app.models.catalog import CatalogDatasetModel
from app.models.dashboard_live import (
    DashboardWidgetResultModel,
    DatasetFreshnessModel,
    DatasetRevisionCommitModel,
)
from app.repositories.catalog_repository import CatalogRepository
from app.repositories.dashboard_live_repository import (
    DashboardLiveRepository,
    ensure_dashboard_live_schema,
    save_catalog_dataset_and_revision,
)


def main() -> None:
    if os.environ.get("ASKLAKE_VERIFY_DASHBOARD_POSTGRES", "").lower() != "true":
        raise RuntimeError(
            "Set ASKLAKE_VERIFY_DASHBOARD_POSTGRES=true with DATABASE_URL pointing to a disposable AskLake PostgreSQL database."
        )

    suffix = uuid4().hex[:12]
    dataset_id = f"verify_live_{suffix}"
    run_id = f"continuous:verify:{suffix}:batch:1"
    widget_id = f"verify_widget_{suffix}"
    with SessionLocal() as db:
        try:
            CatalogRepository(db)
            ensure_dashboard_live_schema(db)
            dataset = CatalogDatasetModel(
                id=dataset_id,
                name=dataset_id,
                payload={
                    "id": dataset_id,
                    "name": dataset_id,
                    "materializationRuns": [{
                        "materializationMode": "delta",
                        "rowCount": 3,
                        "runId": run_id,
                        "sourceKind": "kafka",
                        "status": "success",
                        "storageFormat": "parquet",
                        "storageLocation": "s3a://verify-live/batch_id=1",
                    }],
                },
            )
            first = save_catalog_dataset_and_revision(
                db,
                dataset,
                run_id=run_id,
                storage_location="s3a://verify-live/batch_id=1",
                storage_format="parquet",
                materialization_mode="delta",
                row_count=3,
                next_check_after_ms=5_000,
                source_ranges=[{
                    "endOffset": 13,
                    "partition": 0,
                    "startOffset": 10,
                    "topic": "verify.live",
                }],
            )
            repeated = save_catalog_dataset_and_revision(
                db,
                dataset,
                run_id=run_id,
                storage_location="s3a://verify-live/batch_id=1",
                storage_format="parquet",
                materialization_mode="delta",
                row_count=3,
                next_check_after_ms=5_000,
                source_ranges=[{
                    "endOffset": 13,
                    "partition": 0,
                    "startOffset": 10,
                    "topic": "verify.live",
                }],
            )
            repository = DashboardLiveRepository(db, ensure_schema=False)
            repository.save_widget_result(
                widget_id=widget_id,
                calculation_version="a" * 64,
                dataset_id=dataset_id,
                applied_revision=first.revision,
                result_payload={"config": {"aggregation": "sum"}, "data": [{"value": 3}]},
                calculation_state={"version": 1},
                calculation_mode="incremental",
            )
            db.commit()

            freshness = repository.get_freshness(dataset_id)
            result = repository.get_widget_result(widget_id, "a" * 64)
            expected_tables = {
                "dashboard_widget_results",
                "dataset_freshness",
                "dataset_revision_commits",
            }
            existing_tables = expected_tables.intersection(inspect(db.get_bind()).get_table_names())
            assert existing_tables == expected_tables
            assert first.revision == repeated.revision == 1
            assert first.source_ranges[0]["startOffset"] == 10
            assert freshness is not None and freshness.latest_revision == 1
            assert result is not None and result.applied_revision == 1
            print("verify-dashboard-live-postgres: ok")
        finally:
            db.rollback()
            db.execute(delete(DashboardWidgetResultModel).where(DashboardWidgetResultModel.widget_id == widget_id))
            db.execute(delete(DatasetRevisionCommitModel).where(DatasetRevisionCommitModel.dataset_id == dataset_id))
            db.execute(delete(DatasetFreshnessModel).where(DatasetFreshnessModel.dataset_id == dataset_id))
            db.execute(delete(CatalogDatasetModel).where(CatalogDatasetModel.id == dataset_id))
            db.commit()


if __name__ == "__main__":
    main()
