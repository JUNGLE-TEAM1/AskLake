import os
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import uuid4

from sqlalchemy import delete, func, inspect, select

from app.core.database import SessionLocal
from app.models.catalog import CatalogDatasetModel
from app.models.dashboard_live import (
    DashboardWidgetResultModel,
    DatasetFreshnessModel,
    DatasetKafkaPartitionCursorModel,
    DatasetRevisionCommitModel,
)
from app.repositories.dashboard_live_repository import (
    DashboardLiveRepository,
    save_catalog_dataset_and_revision,
)


def main() -> None:
    if os.environ.get("ASKLAKE_VERIFY_DASHBOARD_POSTGRES", "").lower() != "true":
        raise RuntimeError(
            "Set ASKLAKE_VERIFY_DASHBOARD_POSTGRES=true with DATABASE_URL pointing to a disposable AskLake PostgreSQL database."
        )
    suffix = uuid4().hex[:12]
    dataset_id = f"verify_live_{suffix}"
    concurrent_dataset_id = f"verify_live_concurrent_{suffix}"
    concurrent_distinct_dataset_id = f"verify_live_distinct_{suffix}"
    run_id = f"continuous:verify:{suffix}:batch:1"
    widget_id = f"verify_widget_{suffix}"
    with SessionLocal() as db:
        try:
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
                        "publicationManifest": "s3a://verify-live/_manifests/batch_id=1.json",
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
                manifest_location="s3a://verify-live/_manifests/batch_id=1.json",
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
                manifest_location="s3a://verify-live/_manifests/batch_id=1.json",
            )
            repeated_offsets = save_catalog_dataset_and_revision(
                db,
                dataset,
                run_id=f"{run_id}:duplicate-report",
                storage_location="s3a://verify-live/batch_id=duplicate-report",
                storage_format="parquet",
                materialization_mode="delta",
                row_count=3,
                next_check_after_ms=5_000,
                source_ranges=[{
                    "topic": "verify.live",
                    "partition": 0,
                    "startOffset": 10,
                    "endOffset": 13,
                }],
                manifest_location="s3a://verify-live/_manifests/batch_id=duplicate-report.json",
            )
            repository = DashboardLiveRepository(db, ensure_schema=False)
            try:
                repository.record_dataset_commit(
                    dataset_id=dataset_id,
                    run_id=f"{run_id}:overlap",
                    storage_location="s3a://verify-live/batch_id=overlap",
                    storage_format="parquet",
                    materialization_mode="delta",
                    row_count=2,
                    next_check_after_ms=5_000,
                    source_ranges=[{
                        "topic": "verify.live",
                        "partition": 0,
                        "startOffset": 12,
                        "endOffset": 14,
                    }],
                    commit_kind="stream",
                    manifest_location="s3a://verify-live/_manifests/batch_id=overlap.json",
                )
            except ValueError as error:
                assert "partition watermark" in str(error)
            else:
                raise AssertionError("Partially overlapping stream offsets must be rejected.")
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
                "dataset_kafka_partition_cursors",
                "dataset_revision_commits",
            }
            existing_tables = expected_tables.intersection(inspect(db.get_bind()).get_table_names())
            assert existing_tables == expected_tables
            assert first.revision == repeated.revision == repeated_offsets.revision == 1
            assert first.source_ranges[0]["startOffset"] == 10
            assert first.source_fingerprint and len(first.source_fingerprint) == 64
            assert first.manifest_location == "s3a://verify-live/_manifests/batch_id=1.json"
            assert freshness is not None and freshness.latest_revision == 1
            cursor = repository.stream_partition_cursor(dataset_id, "verify.live", 0)
            assert cursor is not None and cursor.next_offset == 13 and cursor.updated_revision == 1
            assert result is not None and result.applied_revision == 1

            start_together = Barrier(2)

            def publish_same_offsets(index: int) -> int:
                with SessionLocal() as concurrent_db:
                    concurrent_dataset = CatalogDatasetModel(
                        id=concurrent_dataset_id,
                        name=concurrent_dataset_id,
                        payload={"id": concurrent_dataset_id, "name": concurrent_dataset_id},
                    )
                    start_together.wait(timeout=10)
                    concurrent_commit = save_catalog_dataset_and_revision(
                        concurrent_db,
                        concurrent_dataset,
                        run_id=f"continuous:verify:{suffix}:concurrent:{index}",
                        storage_location=f"s3a://verify-live/concurrent/batch_id={index}",
                        storage_format="parquet",
                        materialization_mode="delta",
                        row_count=3,
                        next_check_after_ms=5_000,
                        source_ranges=[{
                            "topic": "verify.concurrent",
                            "partition": 0,
                            "startOffset": 100,
                            "endOffset": 103,
                        }],
                        manifest_location=f"s3a://verify-live/concurrent/_manifests/batch_id={index}.json",
                    )
                    return int(concurrent_commit.revision)

            with ThreadPoolExecutor(max_workers=2) as executor:
                concurrent_revisions = list(executor.map(publish_same_offsets, (1, 2)))
            db.expire_all()
            concurrent_commit_count = db.scalar(
                select(func.count()).select_from(DatasetRevisionCommitModel).where(
                    DatasetRevisionCommitModel.dataset_id == concurrent_dataset_id
                )
            )
            concurrent_freshness = db.get(DatasetFreshnessModel, concurrent_dataset_id)
            assert concurrent_revisions == [1, 1]
            assert concurrent_commit_count == 1
            assert concurrent_freshness is not None and concurrent_freshness.latest_revision == 1

            distinct_start = Barrier(2)

            def publish_distinct_offsets(index: int) -> int:
                with SessionLocal() as concurrent_db:
                    distinct_start.wait(timeout=10)
                    concurrent_repository = DashboardLiveRepository(
                        concurrent_db,
                        ensure_schema=False,
                    )
                    concurrent_repository.lock_dataset_publication_identity(
                        concurrent_distinct_dataset_id
                    )
                    current_dataset = concurrent_db.scalar(
                        select(CatalogDatasetModel)
                        .where(CatalogDatasetModel.id == concurrent_distinct_dataset_id)
                        .with_for_update()
                    )
                    current_payload = (
                        dict(current_dataset.payload or {})
                        if current_dataset is not None
                        else {
                            "id": concurrent_distinct_dataset_id,
                            "name": concurrent_distinct_dataset_id,
                        }
                    )
                    current_runs = list(current_payload.get("materializationRuns") or [])
                    distinct_run_id = f"continuous:verify:{suffix}:distinct:{index}"
                    current_payload["materializationRuns"] = [{
                        "materializationMode": "delta",
                        "rowCount": index,
                        "runId": distinct_run_id,
                        "sourceKind": "kafka",
                        "status": "success",
                        "storageFormat": "parquet",
                        "storageLocation": f"s3a://verify-live/distinct/batch_id={index}",
                    }, *current_runs]
                    concurrent_dataset = CatalogDatasetModel(
                        id=concurrent_distinct_dataset_id,
                        name=concurrent_distinct_dataset_id,
                        payload=current_payload,
                    )
                    concurrent_commit = save_catalog_dataset_and_revision(
                        concurrent_db,
                        concurrent_dataset,
                        run_id=distinct_run_id,
                        storage_location=f"s3a://verify-live/distinct/batch_id={index}",
                        storage_format="parquet",
                        materialization_mode="delta",
                        row_count=index,
                        next_check_after_ms=5_000,
                        source_ranges=[{
                            "topic": "verify.concurrent.distinct",
                            "partition": index,
                            "startOffset": 0,
                            "endOffset": index,
                        }],
                        manifest_location=(
                            "s3a://verify-live/distinct/_manifests/"
                            f"batch_id={index}.json"
                        ),
                    )
                    return int(concurrent_commit.revision)

            with ThreadPoolExecutor(max_workers=2) as executor:
                distinct_revisions = list(executor.map(publish_distinct_offsets, (1, 2)))
            db.expire_all()
            distinct_dataset = db.get(CatalogDatasetModel, concurrent_distinct_dataset_id)
            distinct_commit_count = db.scalar(
                select(func.count()).select_from(DatasetRevisionCommitModel).where(
                    DatasetRevisionCommitModel.dataset_id == concurrent_distinct_dataset_id
                )
            )
            distinct_freshness = db.get(
                DatasetFreshnessModel,
                concurrent_distinct_dataset_id,
            )
            assert sorted(distinct_revisions) == [1, 2]
            assert distinct_commit_count == 2
            assert distinct_freshness is not None and distinct_freshness.latest_revision == 2
            assert distinct_dataset is not None
            assert {
                item["runId"]
                for item in distinct_dataset.payload["materializationRuns"]
            } == {
                f"continuous:verify:{suffix}:distinct:1",
                f"continuous:verify:{suffix}:distinct:2",
            }
            print("verify-dashboard-live-postgres: ok")
        finally:
            db.rollback()
            db.execute(delete(DashboardWidgetResultModel).where(DashboardWidgetResultModel.widget_id == widget_id))
            cleanup_dataset_ids = [
                dataset_id,
                concurrent_dataset_id,
                concurrent_distinct_dataset_id,
            ]
            db.execute(delete(DatasetKafkaPartitionCursorModel).where(DatasetKafkaPartitionCursorModel.dataset_id.in_(cleanup_dataset_ids)))
            db.execute(delete(DatasetRevisionCommitModel).where(DatasetRevisionCommitModel.dataset_id.in_(cleanup_dataset_ids)))
            db.execute(delete(DatasetFreshnessModel).where(DatasetFreshnessModel.dataset_id.in_(cleanup_dataset_ids)))
            db.execute(delete(CatalogDatasetModel).where(CatalogDatasetModel.id.in_(cleanup_dataset_ids)))
            db.commit()


if __name__ == "__main__":
    main()
