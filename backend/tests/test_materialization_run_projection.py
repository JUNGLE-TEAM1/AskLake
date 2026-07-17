import unittest

from app.schemas.catalog import DatasetMaterializationRun
from app.services.catalog_service import recalculate_dataset_payload_from_runs
from app.services.materialization_projection import aggregate_materialization_runs, upsert_materialization_run


class MaterializationRunProjectionTests(unittest.TestCase):
    def test_new_snapshot_replaces_older_snapshot_in_catalog_metrics(self) -> None:
        runs = [
            successful_run("run-new", "snapshot", 10_000, 2_000),
            successful_run("run-old", "snapshot", 10_000, 1_800),
        ]

        projected = aggregate_materialization_runs(runs)
        self.assertEqual(projected["latestRunId"], "run-new")
        self.assertEqual(projected["activeRunIds"], ["run-new"])
        self.assertEqual(projected["rowCount"], 10_000)
        self.assertEqual(projected["storageSizeBytes"], 2_000)

    def test_newer_deltas_are_added_to_the_latest_snapshot(self) -> None:
        runs = [
            successful_run("delta-2", "delta", 3, 30),
            {**successful_run("failed-delta", "delta", 99, 990), "status": "failed"},
            successful_run("delta-1", "delta", 2, 20),
            successful_run("snapshot-new", "snapshot", 10, 100),
            successful_run("snapshot-old", "snapshot", 8, 80),
        ]

        projected = aggregate_materialization_runs(runs)
        self.assertEqual(projected["latestRunId"], "delta-2")
        self.assertEqual(projected["activeRunIds"], ["delta-2", "delta-1", "snapshot-new"])
        self.assertEqual(projected["rowCount"], 15)
        self.assertEqual(projected["storageSizeBytes"], 150)

    def test_legacy_kafka_runs_remain_append_only(self) -> None:
        runs = [
            successful_run("kafka-2", None, 7, 70, source_kind="kafka"),
            successful_run("kafka-1", None, 5, 50, source_kind="kafka"),
        ]

        projected = aggregate_materialization_runs(runs)
        self.assertEqual(projected["rowCount"], 12)
        self.assertEqual(projected["storageSizeBytes"], 120)

    def test_api_contract_preserves_materialization_mode(self) -> None:
        run = DatasetMaterializationRun.model_validate({
            "createdAt": "2026-07-13T00:00:00Z",
            "jobId": "job-1",
            "materializationMode": "snapshot",
            "rowCount": 10,
            "runId": "run-1",
            "sourceKind": "etl",
            "sourceLabel": "products",
            "status": "success",
            "storageSizeBytes": 100,
        })

        self.assertEqual(run.materialization_mode, "snapshot")
        self.assertEqual(run.model_dump(by_alias=True)["materializationMode"], "snapshot")

    def test_late_historical_iceberg_run_does_not_replace_current_head(self) -> None:
        current = {
            **successful_run("run-current", "delta", 10, 100),
            "createdAt": "2026-07-13T10:00:00Z",
            "icebergCommittedAt": "2026-07-13T09:59:00Z",
            "icebergSnapshotId": "200",
        }
        historical = {
            **successful_run("run-historical", "delta", 8, 80),
            "createdAt": "2026-07-13T10:05:00Z",
            "icebergCommittedAt": "2026-07-13T09:55:00Z",
            "icebergSnapshotId": "100",
        }

        runs = upsert_materialization_run([current], historical)

        self.assertEqual([run["runId"] for run in runs], ["run-current", "run-historical"])

    def test_trino_utc_timestamp_keeps_latest_iceberg_run_at_catalog_head(self) -> None:
        previous = {
            **successful_run("run-previous", "delta", 8, 80),
            "icebergCommittedAt": "2026-07-14 14:54:58.833 UTC",
            "icebergSnapshotId": "9999999999999999999",
        }
        latest = {
            **successful_run("run-latest", "delta", 10, 100),
            "icebergCommittedAt": "2026-07-14 15:03:25.673 UTC",
            "icebergSnapshotId": "1000000000000000000",
        }

        runs = upsert_materialization_run([previous], latest)

        self.assertEqual([run["runId"] for run in runs], ["run-latest", "run-previous"])

    def test_deleting_current_snapshot_falls_back_to_previous_snapshot(self) -> None:
        previous = successful_run("run-old", "snapshot", 8, 80)
        recalculated = recalculate_dataset_payload_from_runs({
            "lastUpdated": "2026-07-13T00:00:00Z",
            "materializationRuns": [previous],
            "rows": "10 rows",
            "size": "100B",
            "sourceRunId": "run-new",
            "storageFormat": "parquet",
            "storageLocation": "s3://asklake/run-new",
            "storageSizeBytes": 100,
        })

        self.assertEqual(recalculated["rows"], "8 rows")
        self.assertEqual(recalculated["sourceRunId"], "run-old")
        self.assertEqual(recalculated["storageLocation"], "s3://asklake/run-old")
        self.assertEqual(recalculated["storageSizeBytes"], 80)


def successful_run(
    run_id: str,
    mode: str | None,
    row_count: int,
    storage_size_bytes: int,
    *,
    source_kind: str = "etl",
) -> dict[str, object]:
    return {
        "createdAt": "2026-07-13T00:00:00Z",
        **({"materializationMode": mode} if mode else {}),
        "rowCount": row_count,
        "runId": run_id,
        "sourceKind": source_kind,
        "status": "success",
        "storageLocation": f"s3://asklake/{run_id}",
        "storageSizeBytes": storage_size_bytes,
    }


if __name__ == "__main__":
    unittest.main()
