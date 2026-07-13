from types import SimpleNamespace
import unittest

from app.core.errors import ApiError
from app.schemas.iceberg import IcebergCommitEvidence
from app.services.etl_service import (
    canonical_rule_fingerprint,
    verify_spark_iceberg_result,
)
from app.services.iceberg_writer_service import build_iceberg_writer_target


class FakeIcebergWriterService:
    def __init__(self, *, file_count: int = 2, storage_size_bytes: int = 4096) -> None:
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
        schema_fingerprint,
        rule_fingerprint,
        source_boundary,
    ):
        return IcebergCommitEvidence(
            createdTable=created_table,
            jobId=job_id,
            runId=run_id,
            target=target,
            queryEngineTable=target.query_engine_table(),
            snapshotId=expected_snapshot_id,
            committedAt="2026-07-13T15:00:00Z",
            warehouseLocation=f"s3://asklake-warehouse/warehouse/asklake/{target.table}",
            schemaFingerprint=schema_fingerprint,
            ruleFingerprint=rule_fingerprint,
            sourceBoundary=source_boundary,
        )

    def table_storage_metrics(self, _target):
        return self.file_count, self.storage_size_bytes


class SparkIcebergReconciliationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.target = build_iceberg_writer_target(
            "orders",
            "ds_orders",
            write_mode="replace",
        )
        self.rule_fingerprint = canonical_rule_fingerprint("1.0", [])
        self.job = SimpleNamespace(
            execution_mode="snapshot",
            iceberg_target=self.target.model_dump(mode="json", by_alias=True),
            id="JOB-ICEBERG-BATCH",
            quality_rules=[],
            rule_contract_version="1.0",
            rules=[],
            schema_columns=[{
                "included": True,
                "nullable": False,
                "sourceName": "id",
                "targetName": "id",
                "type": "Long",
            }],
            schema_fingerprint="schema-orders-v1",
            source_type="File / S3",
            transform_output_columns=[],
            transform_steps=[],
        )

    def spark_result(self, *, output_rows: int = 2) -> dict:
        return {
            "icebergCommit": {
                "createdTable": True,
                "jobId": self.job.id,
                "operation": "replace",
                "ruleFingerprint": self.rule_fingerprint,
                "runId": "RUN-ICEBERG-BATCH",
                "schemaFingerprint": self.job.schema_fingerprint,
                "snapshotId": "123456789",
                "sourceBoundary": {"mode": "full", "scope": "file"},
                "target": self.target.model_dump(mode="json", by_alias=True),
            },
            "outputPath": self.target.table_uri,
            "outputRows": output_rows,
            "runId": "RUN-ICEBERG-BATCH",
            "status": "success",
        }

    def test_verified_snapshot_and_physical_files_enable_query_engine_mapping(self) -> None:
        result = verify_spark_iceberg_result(
            self.job,
            "RUN-ICEBERG-BATCH",
            self.spark_result(),
            writer_service=FakeIcebergWriterService(),
        )

        self.assertTrue(result["queryEngineVerified"])
        self.assertEqual(result["queryEngineTable"]["table"], self.target.table)
        self.assertEqual(result["icebergCommit"]["snapshotId"], "123456789")
        self.assertEqual(result["dataFileCount"], 2)
        self.assertEqual(result["storageSizeBytes"], 4096)

    def test_positive_output_rows_require_physical_file_evidence(self) -> None:
        with self.assertRaises(ApiError) as context:
            verify_spark_iceberg_result(
                self.job,
                "RUN-ICEBERG-BATCH",
                self.spark_result(),
                writer_service=FakeIcebergWriterService(file_count=0, storage_size_bytes=0),
            )

        self.assertEqual(str(context.exception.code), "CATALOG_RECONCILIATION_FAILED")


if __name__ == "__main__":
    unittest.main()
