from types import SimpleNamespace
import unittest

from app.core.errors import ApiError
from app.schemas.etl import ContinuousIcebergMaintenanceRequest
from app.schemas.iceberg import IcebergCommitEvidence
from app.services.etl_service import verify_continuous_iceberg_maintenance
from app.services.iceberg_writer_service import build_iceberg_writer_target


class FakeIcebergWriterService:
    def __init__(self, *, file_count: int = 3, storage_size_bytes: int = 8192) -> None:
        self.file_count = file_count
        self.storage_size_bytes = storage_size_bytes

    def verify_commit(
        self,
        target,
        *,
        created_table,
        job_id,
        run_id,
        expected_snapshot_id,
    ):
        return IcebergCommitEvidence(
            createdTable=created_table,
            jobId=job_id,
            runId=run_id,
            target=target,
            queryEngineTable=target.query_engine_table(),
            snapshotId=expected_snapshot_id,
            committedAt="2026-07-14T12:00:00Z",
            warehouseLocation=f"s3://asklake-warehouse/warehouse/asklake/{target.table}",
        )

    def table_storage_metrics(self, _target, *, snapshot_id=None):
        if snapshot_id != "101":
            raise AssertionError(f"expected exact snapshot metrics, got {snapshot_id}")
        return self.file_count, self.storage_size_bytes


class ContinuousIcebergMaintenanceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.target = build_iceberg_writer_target(
            "reviews",
            "ds_reviews",
            write_mode="append",
        )
        self.job = SimpleNamespace(
            id="JOB-CONTINUOUS-MAINTENANCE",
            iceberg_target=self.target.model_dump(mode="json", by_alias=True),
        )

    def test_request_requires_an_enabled_operation(self) -> None:
        with self.assertRaises(ValueError):
            ContinuousIcebergMaintenanceRequest(
                rewrite_data_files=False,
                expire_snapshots=False,
                remove_orphan_files=False,
            )

    def test_trino_verification_enriches_maintenance_evidence(self) -> None:
        result = verify_continuous_iceberg_maintenance(
            self.job,
            "continuous-maint-1",
            {
                "tableUri": self.target.table_uri,
                "snapshotIdBefore": "100",
                "snapshotIdAfter": "101",
                "operations": [{"operation": "rewrite_data_files", "result": []}],
            },
            writer_service=FakeIcebergWriterService(),
        )

        self.assertTrue(result["queryEngineVerified"])
        self.assertEqual(result["icebergSnapshotId"], "101")
        self.assertEqual(result["dataFileCount"], 3)
        self.assertEqual(result["storageSizeBytes"], 8192)
        self.assertEqual(result["queryEngineTable"]["format"], "iceberg")

    def test_result_cannot_claim_another_iceberg_target(self) -> None:
        with self.assertRaises(ApiError) as context:
            verify_continuous_iceberg_maintenance(
                self.job,
                "continuous-maint-2",
                {
                    "tableUri": "iceberg://iceberg/asklake/other_table",
                    "snapshotIdAfter": "101",
                },
                writer_service=FakeIcebergWriterService(),
            )

        self.assertEqual(str(context.exception.code), "ICEBERG_MAINTENANCE_TARGET_MISMATCH")


if __name__ == "__main__":
    unittest.main()
