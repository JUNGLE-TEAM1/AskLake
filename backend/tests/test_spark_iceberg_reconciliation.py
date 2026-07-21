from types import SimpleNamespace
import unittest
from unittest.mock import patch

from app.core.errors import ApiError
from app.schemas.iceberg import IcebergCommitEvidence
from app.services.etl_service import (
    canonical_rule_fingerprint,
    dataset_from_spark_result,
    dataset_payload_from_spark_result,
    enrich_airflow_catalog_spark_result,
    verify_spark_iceberg_result,
)
from app.services.iceberg_writer_service import IcebergWriterError, build_iceberg_writer_target


class FakeIcebergWriterService:
    def __init__(
        self,
        *,
        file_count: int = 2,
        run_row_count_error: str | None = None,
        storage_size_bytes: int = 4096,
    ) -> None:
        self.file_count = file_count
        self.run_row_count_error = run_row_count_error
        self.run_row_count_verifications = []
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

    def table_storage_metrics(self, _target, *, snapshot_id=None):
        if snapshot_id != "123456789":
            raise AssertionError(f"expected exact snapshot metrics, got {snapshot_id}")
        return self.file_count, self.storage_size_bytes

    def verify_snapshot_run_row_count(
        self,
        target,
        *,
        snapshot_id,
        run_id,
        expected_row_count,
    ):
        if self.run_row_count_error:
            raise IcebergWriterError(self.run_row_count_error)
        self.run_row_count_verifications.append({
            "expectedRowCount": expected_row_count,
            "runId": run_id,
            "snapshotId": snapshot_id,
            "target": target,
        })
        return expected_row_count


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
        writer_service = FakeIcebergWriterService()
        result = verify_spark_iceberg_result(
            self.job,
            "RUN-ICEBERG-BATCH",
            self.spark_result(),
            writer_service=writer_service,
        )

        self.assertTrue(result["queryEngineVerified"])
        self.assertEqual(result["queryEngineTable"]["table"], self.target.table)
        self.assertEqual(result["icebergCommit"]["snapshotId"], "123456789")
        self.assertEqual(result["dataFileCount"], 2)
        self.assertEqual(result["outputFileCount"], 2)
        self.assertEqual(result["storageSizeBytes"], 4096)
        self.assertEqual(writer_service.run_row_count_verifications, [])

    def test_runtime_and_trino_snapshot_file_count_mismatch_fails_closed(self) -> None:
        result = self.spark_result()
        result["outputFileCount"] = 3
        result["icebergCommit"]["dataFileCount"] = 3

        with self.assertRaises(ApiError) as context:
            verify_spark_iceberg_result(
                self.job,
                "RUN-ICEBERG-BATCH",
                result,
                writer_service=FakeIcebergWriterService(file_count=2),
            )

        self.assertEqual(str(context.exception.code), "CATALOG_RECONCILIATION_FAILED")
        self.assertIn("file counts do not match", context.exception.message)

    def test_continuous_path_verifies_run_rows_at_verified_snapshot(self) -> None:
        writer_service = FakeIcebergWriterService()

        verify_spark_iceberg_result(
            self.job,
            "RUN-ICEBERG-BATCH",
            self.spark_result(),
            expected_run_row_count=2,
            writer_service=writer_service,
        )

        self.assertEqual(len(writer_service.run_row_count_verifications), 1)
        verification = writer_service.run_row_count_verifications[0]
        self.assertEqual(verification["expectedRowCount"], 2)
        self.assertEqual(verification["runId"], "RUN-ICEBERG-BATCH")
        self.assertEqual(verification["snapshotId"], "123456789")
        self.assertEqual(verification["target"], self.target)

    def test_run_row_count_trino_failure_remains_safe_502(self) -> None:
        with self.assertRaises(ApiError) as context:
            verify_spark_iceberg_result(
                self.job,
                "RUN-ICEBERG-BATCH",
                self.spark_result(),
                expected_run_row_count=2,
                writer_service=FakeIcebergWriterService(
                    run_row_count_error="ICEBERG_TRINO_QUERY_FAILED",
                ),
            )

        self.assertEqual(context.exception.status_code, 502)
        self.assertEqual(context.exception.code, "ICEBERG_TRINO_QUERY_FAILED")

    def test_eks_fixture_catalog_uses_exact_snapshot_run_count_verification(self) -> None:
        fixture_target = {
            "catalog": "iceberg",
            "namespace": "asklake",
            "partitionColumns": [],
            "table": "eks_mvp_fixture",
            "tableUri": "iceberg://iceberg/asklake/eks_mvp_fixture",
            "writeMode": "replace",
        }
        fixture_job = SimpleNamespace(
            execution_mode="snapshot",
            iceberg_target=fixture_target,
            id="JOB-EKS-FIXTURE",
            source_config=[
                ["Broker / Endpoint", "boot.example.kafka-serverless.ap-northeast-2.amazonaws.com:9098"],
                ["TOPIC / QUEUE NAME", "asklake.eks-mvp.fixture.v1"],
                ["CONSUMER GROUP ID", "asklake-eks-mvp-spark-v1"],
                ["__EKS MVP Fixture Batch ID", "fixture-batch-001"],
                ["__EKS MVP Expected Count", "100"],
            ],
            source_type="Kafka JSON",
        )
        source_boundary = {
            "broker": "boot.example.kafka-serverless.ap-northeast-2.amazonaws.com:9098",
            "checkpointPath": "s3a://asklake-output/eks-mvp/checkpoints/run_fixture_001",
            "consumerGroup": "asklake-eks-mvp-spark-v1",
            "expectedCount": 100,
            "fixtureBatchId": "fixture-batch-001",
            "kind": "kafka_snapshot",
            "outputPath": "s3a://asklake-output/eks-mvp/output/run_fixture_001",
            "snapshotId": "run_fixture_001",
            "topic": "asklake.eks-mvp.fixture.v1",
        }
        fixture_run = SimpleNamespace(
            job_id=fixture_job.id,
            run_id="run_fixture_001",
            task_states={
                "eksMvpFixture": {
                    "capturedAt": "2026-07-16T02:00:00Z",
                    "contractVersion": 1,
                    "runId": "run_fixture_001",
                    "sourceBoundary": source_boundary,
                },
            },
        )
        result = {
            "outputPath": fixture_target["tableUri"],
            "runId": fixture_run.run_id,
            "status": "success",
        }
        verified = {**result, "dataFileCount": 1, "storageSizeBytes": 1024}

        with patch(
            "app.services.etl_service.verify_spark_iceberg_result",
            return_value=verified,
        ) as verify:
            actual = enrich_airflow_catalog_spark_result(fixture_job, fixture_run, result)

        self.assertEqual(actual, verified)
        verify.assert_called_once_with(
            fixture_job,
            fixture_run.run_id,
            result,
            expected_run_row_count=100,
        )

    def test_ordinary_kafka_job_keeps_legacy_catalog_output_verification(self) -> None:
        kafka_job = SimpleNamespace(
            execution_mode="snapshot",
            iceberg_target={"tableUri": "iceberg://iceberg/asklake/legacy_kafka"},
            id="JOB-KAFKA-LEGACY",
            source_config=[
                ["Broker / Endpoint", "kafka.test:9092"],
                ["TOPIC / QUEUE NAME", "reviews.raw"],
                ["CONSUMER GROUP ID", "asklake-reviews"],
            ],
            source_type="Kafka JSON",
            storage_path=None,
        )
        kafka_run = SimpleNamespace(run_id="run_kafka_legacy")
        result = {
            "outputPath": "/tmp/asklake/run_kafka_legacy",
            "runId": kafka_run.run_id,
            "status": "success",
        }

        with (
            patch(
                "app.services.etl_service.inspect_spark_output",
                return_value={"parquetObjectCount": 2, "storageSizeBytes": 2048},
            ) as inspect,
            patch("app.services.etl_service.verify_spark_iceberg_result") as verify,
        ):
            actual = enrich_airflow_catalog_spark_result(kafka_job, kafka_run, result)

        inspect.assert_called_once_with(result["outputPath"])
        verify.assert_not_called()
        self.assertEqual(actual["parquetObjectCount"], 2)
        self.assertEqual(actual["storageSizeBytes"], 2048)

    def test_positive_output_rows_require_physical_file_evidence(self) -> None:
        with self.assertRaises(ApiError) as context:
            verify_spark_iceberg_result(
                self.job,
                "RUN-ICEBERG-BATCH",
                self.spark_result(),
                writer_service=FakeIcebergWriterService(file_count=0, storage_size_bytes=0),
            )

        self.assertEqual(str(context.exception.code), "CATALOG_RECONCILIATION_FAILED")

    def test_late_historical_snapshot_does_not_regress_current_catalog_projection(self) -> None:
        job = SimpleNamespace(
            created_by="qa",
            created_by_profile=None,
            dataset_id="ds_orders",
            id="JOB-ICEBERG-BATCH",
            index_columns=[],
            name="orders_pipeline",
            owner="qa",
            partition=None,
            partition_columns=[],
            permission_roles=[],
            quality_score=100,
            quality_status="passed",
            rag=False,
            schedule="manual",
            schema_columns=[{
                "included": True,
                "sourceName": "id",
                "targetName": "id",
                "type": "Long",
            }],
            source="File / S3 / orders",
            source_label="orders.parquet",
            source_type="File / S3",
            target="orders",
            target_description="orders current dataset",
            target_layer="SILVER",
            target_tags=["orders"],
            transform_steps=[],
        )
        previous = {
            "description": "orders current dataset",
            "freshness": "latest",
            "id": "ds_orders",
            "lastUpdated": "2026-07-14T02:00:00Z",
            "layer": "SILVER",
            "materializationRuns": [{
                "createdAt": "2026-07-14T02:00:00Z",
                "icebergCommittedAt": "2026-07-14T02:00:00Z",
                "icebergSnapshotId": "200",
                "jobId": job.id,
                "materializationMode": "snapshot",
                "rowCount": 10,
                "runId": "RUN-NEW",
                "sourceKind": "etl",
                "sourceLabel": job.name,
                "status": "success",
                "storageFormat": "iceberg",
                "storageLocation": "s3://warehouse/orders",
                "storageSizeBytes": 2000,
            }],
            "name": "orders",
            "nextRefresh": "manual",
            "owner": "qa",
            "quality": "current-quality",
            "queryEngineStatus": "available",
            "queryEngineTable": {"catalog": "iceberg", "schema": "asklake", "table": "orders", "format": "iceberg"},
            "rag": False,
            "rows": "10 rows",
            "sampleRows": [["10"]],
            "schema": [["id", "bigint"]],
            "size": "2KB",
            "source": job.name,
            "sourceRunId": "RUN-NEW",
            "status": "available",
            "storageFormat": "iceberg",
            "storageLocation": "s3://warehouse/orders",
            "storageSizeBytes": 2000,
            "tags": ["#orders"],
        }
        historical_result = {
            "endedAt": "2026-07-14T01:00:00Z",
            "icebergCommit": {"committedAt": "2026-07-14T01:00:00Z", "snapshotId": "100"},
            "materializationRows": 2,
            "outputPath": "iceberg://iceberg/asklake/orders",
            "outputRows": 2,
            "quality": {"summary": "historical-quality"},
            "queryEngineTable": {"catalog": "iceberg", "schema": "asklake", "table": "orders", "format": "iceberg"},
            "queryEngineVerified": True,
            "runId": "RUN-OLD",
            "sampleRows": [["1"]],
            "schema": [{"name": "legacy_id", "type": "string"}],
            "status": "success",
            "storageSizeBytes": 500,
            "warehouseLocation": "s3://warehouse/orders",
        }

        payload = dataset_payload_from_spark_result(
            job,
            historical_result,
            "ds_orders",
            [["legacy_id", "string"]],
            historical_result["endedAt"],
            previous,
        )

        self.assertEqual([run["runId"] for run in payload["materializationRuns"]], ["RUN-NEW", "RUN-OLD"])
        self.assertEqual(payload["sourceRunId"], "RUN-NEW")
        self.assertEqual(payload["schema"], [["id", "bigint"]])
        self.assertEqual(payload["sampleRows"], [["10"]])
        self.assertEqual(payload["quality"], "current-quality")
        self.assertEqual(payload["size"], "2KB")
        self.assertEqual(payload["storageSizeBytes"], 2000)


if __name__ == "__main__":
    unittest.main()
