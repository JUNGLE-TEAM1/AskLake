import importlib
from contextlib import ExitStack
import os
from pathlib import Path
import sys
from threading import Lock
import time
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import Mock, call, patch

SCRIPTS_DIR = Path(__file__).parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))
try:
    try:
        spark_job_run = importlib.import_module("spark_job_run")
    except ModuleNotFoundError as exc:
        if exc.name != "pyspark":
            raise
        pyspark_module = ModuleType("pyspark")
        sql_module = ModuleType("pyspark.sql")
        functions_module = ModuleType("pyspark.sql.functions")
        types_module = ModuleType("pyspark.sql.types")
        functions_module.lit = Mock(name="lit")
        functions_module.current_timestamp = Mock(name="current_timestamp")
        sql_module.SparkSession = object
        sql_module.functions = functions_module
        sql_module.types = types_module
        pyspark_module.sql = sql_module
        with patch.dict(sys.modules, {
            "pyspark": pyspark_module,
            "pyspark.sql": sql_module,
            "pyspark.sql.functions": functions_module,
            "pyspark.sql.types": types_module,
        }):
            spark_job_run = importlib.import_module("spark_job_run")
finally:
    sys.path.remove(str(SCRIPTS_DIR))

from scripts.spark_source_identity import (
    source_change_detection_mode,
    verify_incremental_source_inventory,
)


def identity(
    key: str,
    *,
    e_tag: str = "etag-1",
    version_id: str | None = None,
    last_modified: str = "2026-07-12T10:30:00.000Z",
    size: int = 10,
) -> dict[str, object]:
    return {
        "key": key,
        "eTag": e_tag,
        "versionId": version_id,
        "lastModified": last_modified,
        "size": size,
    }


def source_collection(*items: dict[str, object], version: int = 2) -> dict[str, object]:
    return {
        "mode": "incremental",
        "objectInventory": list(items),
        "objectKeys": [str(item["key"]) for item in items],
        "scope": "folder",
        "windowContractVersion": version,
    }


class FakeWriter:
    def mode(self, _mode: str):
        return self

    def partitionBy(self, *_columns: str):
        return self

    def parquet(self, _path: str) -> None:
        return None


class FakeFrame:
    columns: list[str] = []
    schema = SimpleNamespace(fields=[])
    write = FakeWriter()

    def count(self) -> int:
        return 1

    def limit(self, _limit: int):
        return self

    def inputFiles(self) -> list[str]:
        return []

    def withColumn(self, _name: str, _value):
        return self

    def inputFiles(self) -> list[str]:
        return []


class FakeSpark:
    def __init__(self, frame: FakeFrame) -> None:
        self.read = SimpleNamespace(parquet=Mock(return_value=frame))
        self.stop = Mock()


class SparkSourceIdentityTests(unittest.TestCase):
    def test_iceberg_source_manifest_paths_are_normalized_to_quoted_table_identifiers(self) -> None:
        frame = FakeFrame()
        spark = SimpleNamespace(table=Mock(return_value=frame))

        for source_path in (
            "iceberg:asklake.asklake.amazon_products",
            "iceberg://asklake/asklake/amazon_products",
            "asklake.asklake.amazon_products",
        ):
            self.assertIs(
                spark_job_run.read_source(spark, "iceberg", source_path, []),
                frame,
            )

        self.assertEqual(
            spark.table.call_args_list,
            [call("`asklake`.`asklake`.`amazon_products`")] * 3,
        )

    def test_invalid_iceberg_source_manifest_path_fails_closed(self) -> None:
        spark = SimpleNamespace(table=Mock())

        with self.assertRaisesRegex(ValueError, "ICEBERG_SOURCE_INVALID"):
            spark_job_run.read_source(spark, "iceberg", "iceberg:missing-table", [])

    def test_iceberg_source_manifest_reads_the_committed_snapshot(self) -> None:
        frame = FakeFrame()
        reader = Mock()
        iceberg_reader = Mock()
        reader.format.return_value = iceberg_reader
        iceberg_reader.option.return_value = iceberg_reader
        iceberg_reader.load.return_value = frame
        spark = SimpleNamespace(read=reader, table=Mock())

        result = spark_job_run.read_source(
            spark,
            "iceberg",
            "iceberg:asklake.asklake.amazon_products",
            [],
            source_snapshot_id="123456789",
        )

        self.assertIs(result, frame)
        reader.format.assert_called_once_with("iceberg")
        iceberg_reader.option.assert_called_once_with("snapshot-id", "123456789")
        iceberg_reader.load.assert_called_once_with("`asklake`.`asklake`.`amazon_products`")
        spark.table.assert_not_called()

    def test_current_iceberg_snapshot_uses_main_ref_not_newest_history(self) -> None:
        target = {
            "catalog": "iceberg",
            "namespace": "asklake",
            "table": "reviews_batch",
        }

        def execute(query: str):
            if ".refs" in query:
                return SimpleNamespace(collect=lambda: [{"snapshot_id": "123"}])
            self.assertIn("WHERE CAST(snapshot_id AS STRING) = '123'", query)
            return SimpleNamespace(collect=lambda: [{
                "committed_at": "2026-07-14T00:00:00Z",
                "manifest_list": "s3://warehouse/reviews/metadata/snap-123.avro",
                "snapshot_id": "123",
            }])

        spark = SimpleNamespace(sql=Mock(side_effect=execute))

        snapshot = spark_job_run.current_iceberg_snapshot(spark, target)

        self.assertEqual(snapshot["snapshotId"], "123")
        self.assertEqual(spark.sql.call_count, 2)

    def test_kafka_snapshot_retry_reuses_existing_iceberg_commit(self) -> None:
        spark = SimpleNamespace(sql=Mock())
        frame = SimpleNamespace(writeTo=Mock())
        target = {
            "catalog": "iceberg",
            "namespace": "asklake",
            "partitionColumns": [],
            "table": "reviews_snapshot",
            "tableUri": "iceberg://iceberg/asklake/reviews_snapshot",
            "writeMode": "append",
        }
        boundary = {
            "kind": "kafka_snapshot",
            "snapshotId": "kafka_snapshot_1234",
        }
        committed = {
            "committedAt": "2026-07-14T00:00:00Z",
            "snapshotId": "999",
            "warehouseLocation": "s3://asklake-warehouse/warehouse/reviews_snapshot",
        }

        with (
            patch.object(spark_job_run, "iceberg_table_exists", return_value=True),
            patch.object(spark_job_run, "latest_iceberg_snapshot", return_value=committed),
            patch.object(spark_job_run, "iceberg_source_boundary_exists", return_value=True),
        ):
            result = spark_job_run.commit_iceberg_table(
                spark,
                frame,
                target,
                job_id="JOB-KAFKA",
                run_id="RUN-RETRY",
                partition_columns=[],
                schema_fingerprint="schema-v1",
                rule_fingerprint="rules-v1",
                source_boundary=boundary,
            )

        self.assertEqual(result["operation"], "reuse")
        self.assertEqual(result["snapshotId"], "999")
        self.assertEqual(result["sourceBoundary"], boundary)
        frame.writeTo.assert_not_called()

    def test_kafka_snapshot_retry_reuses_existing_iceberg_commit_for_replace_target(self) -> None:
        spark = SimpleNamespace(sql=Mock())
        frame = SimpleNamespace(writeTo=Mock())
        target = {
            "catalog": "iceberg",
            "namespace": "asklake",
            "partitionColumns": [],
            "table": "eks_mvp_fixture",
            "tableUri": "iceberg://iceberg/asklake/eks_mvp_fixture",
            "writeMode": "replace",
        }
        boundary = {
            "kind": "kafka_snapshot",
            "snapshotId": "run_cp4_retry_001",
        }
        committed = {
            "committedAt": "2026-07-16T09:00:00Z",
            "snapshotId": "676467971672461132",
            "warehouseLocation": "s3://asklake-warehouse/warehouse/eks_mvp_fixture",
        }

        with (
            patch.object(spark_job_run, "iceberg_table_exists", return_value=True),
            patch.object(spark_job_run, "latest_iceberg_snapshot", return_value=committed),
            patch.object(spark_job_run, "iceberg_source_boundary_exists", return_value=True),
        ):
            result = spark_job_run.commit_iceberg_table(
                spark,
                frame,
                target,
                job_id="JOB-EKS-MVP",
                run_id="run_cp4_retry_001",
                partition_columns=[],
                schema_fingerprint="schema-v1",
                rule_fingerprint="rules-v1",
                source_boundary=boundary,
            )

        self.assertEqual(result["operation"], "reuse")
        self.assertEqual(result["snapshotId"], "676467971672461132")
        self.assertEqual(result["sourceBoundary"], boundary)
        frame.writeTo.assert_not_called()

    def test_iceberg_rollback_uses_fully_qualified_table_name(self) -> None:
        spark = SimpleNamespace(sql=Mock())
        target = {
            "catalog": "iceberg",
            "namespace": "asklake",
            "partitionColumns": [],
            "table": "reviews_batch",
            "tableUri": "iceberg://iceberg/asklake/reviews_batch",
            "writeMode": "replace",
        }
        previous_snapshot = {"snapshotId": "123"}

        with (
            patch.object(spark_job_run, "spark_iceberg_catalog_name", return_value="asklake"),
            patch.object(spark_job_run, "current_iceberg_snapshot_id", return_value="123"),
        ):
            spark_job_run.rollback_iceberg_commit(spark, target, previous_snapshot)

        sql = spark.sql.call_args.args[0]
        self.assertIn("table => 'asklake.asklake.reviews_batch'", sql)
        self.assertIn("snapshot_id => 123", sql)

    def test_matching_versioned_identity_is_verified_before_read(self) -> None:
        expected = identity("incoming/a.jsonl", version_id="version-1")
        loader = Mock(return_value={
            "ETag": '"etag-1"',
            "VersionId": "version-1",
            "LastModified": "2026-07-12T10:30:00Z",
            "Size": 10,
        })

        paths = verify_incremental_source_inventory(
            "s3a://m3-raw/incoming/",
            source_collection(expected),
            loader,
        )

        self.assertEqual(paths, ["s3a://m3-raw/incoming/a.jsonl"])
        loader.assert_called_once_with("s3a://m3-raw/incoming/a.jsonl")
        self.assertEqual(source_change_detection_mode(source_collection(expected)), "versionid")

    def test_same_key_version_replacement_fails_closed(self) -> None:
        expected = identity("incoming/a.jsonl", version_id="version-1")

        with self.assertRaises(ValueError) as raised:
            verify_incremental_source_inventory(
                "s3a://m3-raw/incoming/",
                source_collection(expected),
                lambda _path: identity("incoming/a.jsonl", version_id="version-2"),
            )

        self.assertIn("SOURCE_OBJECT_IDENTITY_MISMATCH", str(raised.exception))
        self.assertIn("versionId", str(raised.exception))

    def test_unversioned_etag_replacement_fails_closed(self) -> None:
        expected = identity("incoming/a.jsonl")

        with self.assertRaises(ValueError) as raised:
            verify_incremental_source_inventory(
                "s3://m3-raw/incoming/",
                source_collection(expected),
                lambda _path: identity("incoming/a.jsonl", e_tag="etag-2"),
            )

        self.assertIn("eTag", str(raised.exception))
        self.assertEqual(source_change_detection_mode(source_collection(expected)), "etag")

    def test_v2_manifest_requires_inventory_to_match_object_keys(self) -> None:
        collection = source_collection(identity("incoming/a.jsonl"))
        collection["objectKeys"] = ["incoming/other.jsonl"]

        with self.assertRaises(ValueError) as raised:
            verify_incremental_source_inventory(
                "s3a://m3-raw/incoming/",
                collection,
                Mock(),
            )

        self.assertIn("objectKeys and objectInventory do not match", str(raised.exception))

    def test_v2_manifest_rejects_non_integral_object_size(self) -> None:
        malformed = identity("incoming/a.jsonl")
        malformed["size"] = 1.5

        with self.assertRaises(ValueError) as raised:
            verify_incremental_source_inventory(
                "s3a://m3-raw/incoming/",
                source_collection(malformed),
                Mock(),
            )

        self.assertIn("object size is missing or invalid", str(raised.exception))

    def test_v1_manifest_remains_compatible_without_identity_inventory(self) -> None:
        loader = Mock(side_effect=AssertionError("legacy manifests must not perform v2 verification"))
        collection = {
            "mode": "incremental",
            "objectKeys": ["incoming/a.jsonl"],
            "scope": "folder",
            "windowContractVersion": 1,
        }

        self.assertEqual(
            verify_incremental_source_inventory("s3a://m3-raw/incoming/", collection, loader),
            [],
        )
        loader.assert_not_called()

    def test_unknown_future_contract_version_fails_closed(self) -> None:
        collection = source_collection(identity("incoming/a.jsonl"), version=3)

        with self.assertRaises(ValueError) as raised:
            verify_incremental_source_inventory("s3a://m3-raw/incoming/", collection, Mock())

        self.assertIn("unsupported contract version=3", str(raised.exception))

    def test_replacement_after_precheck_is_caught_by_postcheck(self) -> None:
        expected = identity("incoming/a.jsonl", e_tag="etag-before")
        current = identity("incoming/a.jsonl", e_tag="etag-before")
        collection = source_collection(expected)

        verify_incremental_source_inventory(
            "s3a://m3-raw/incoming/",
            collection,
            lambda _path: dict(current),
        )
        current["eTag"] = "etag-after"

        with self.assertRaises(ValueError) as raised:
            verify_incremental_source_inventory(
                "s3a://m3-raw/incoming/",
                collection,
                lambda _path: dict(current),
            )

        self.assertIn("SOURCE_OBJECT_IDENTITY_MISMATCH", str(raised.exception))

    def test_postcheck_replacement_marks_the_spark_run_failed(self) -> None:
        collection = source_collection(identity("incoming/a.jsonl", e_tag="etag-before"))
        frame = FakeFrame()
        spark = FakeSpark(frame)
        write_report = Mock()
        environment = {
            "ASKLAKE_SPARK_OUTPUT_PATH": "s3a://m3-output/run-1",
            "ASKLAKE_SPARK_RUN_ID": "run-1",
            "ASKLAKE_SPARK_SOURCE_FORMAT": "jsonl",
            "ASKLAKE_SPARK_SOURCE_PATH": "s3a://m3-raw/incoming/",
        }

        original_delete = spark_job_run.delete_spark_path
        original_publish = spark_job_run.publish_spark_paths
        spark_job_run.delete_spark_path = lambda _spark, _path: None
        spark_job_run.publish_spark_paths = lambda _spark, _staging, _output, _quarantine: None
        with ExitStack() as stack:
            stack.enter_context(patch.dict(os.environ, environment, clear=True))
            stack.enter_context(patch.object(
                spark_job_run,
                "load_spark_job_manifest",
                return_value={"sourceCollection": collection},
            ))
            stack.enter_context(patch.object(spark_job_run, "make_spark", return_value=spark))
            verify = stack.enter_context(patch.object(
                spark_job_run,
                "verify_spark_source_inventory",
                side_effect=[None, ValueError("SOURCE_OBJECT_IDENTITY_MISMATCH key=incoming/a.jsonl phase=after_read")],
            ))
            for name, value in (
                ("read_source", frame),
                ("normalize_columns", frame),
                ("apply_transform_steps", frame),
                ("select_final_schema_columns", frame),
                ("resolve_partition_columns", []),
                ("plan_review_row_analysis_checks", []),
                ("evaluate_quality_rules", {"status": "pass"}),
                ("evaluate_custom_csv_classifier_checks", []),
                ("evaluate_review_row_analysis_checks", []),
                ("text_structuring_manifest", {"definition": {"columns": []}}),
                ("collect_sample_rows", []),
            ):
                stack.enter_context(patch.object(spark_job_run, name, return_value=value))
            stack.enter_context(patch.object(
                spark_job_run,
                "apply_schema_contract_with_count",
                return_value=(frame, 1),
            ))
            stack.enter_context(patch.object(spark_job_run, "write_report", write_report))
            cleanup = stack.enter_context(
                patch.object(spark_job_run, "cleanup_failed_output_paths", return_value=[])
            )
            stack.enter_context(patch.object(spark_job_run.F, "lit", return_value="run-1"))
            stack.enter_context(patch.object(spark_job_run.F, "current_timestamp", return_value="now"))
            stack.enter_context(patch("builtins.print"))
            exit_code = spark_job_run.main()
        spark_job_run.delete_spark_path = original_delete
        spark_job_run.publish_spark_paths = original_publish

        self.assertEqual(exit_code, 1)
        self.assertEqual([call.kwargs["phase"] for call in verify.call_args_list], ["before_read", "after_read"])
        report = write_report.call_args.args[1]
        self.assertEqual(report["status"], "failed")
        self.assertEqual(report["failedStage"], "Source Inventory")
        self.assertIn("phase=after_read", report["error"])
        self.assertEqual(report["outputCleanup"], {"errors": [], "status": "success"})
        cleanup.assert_called_once_with(spark, "s3a://m3-output/run-1.__staging__run-1")
        spark.stop.assert_called_once_with()

    def test_identity_status_checks_use_bounded_concurrency_and_keep_path_order(self) -> None:
        items = [
            identity(f"incoming/{index}.jsonl", e_tag=f"etag-{index}")
            for index in range(6)
        ]
        collection = source_collection(*items)
        by_path = {
            f"s3a://m3-raw/{item['key']}": item
            for item in items
        }
        lock = Lock()
        active = 0
        max_active = 0

        def tracked_loader(path: str) -> dict[str, object]:
            nonlocal active, max_active
            with lock:
                active += 1
                max_active = max(max_active, active)
            try:
                time.sleep(0.03)
                return dict(by_path[path])
            finally:
                with lock:
                    active -= 1

        with patch.dict(os.environ, {"ASKLAKE_SOURCE_IDENTITY_WORKERS": "3"}, clear=False):
            paths = verify_incremental_source_inventory(
                "s3a://m3-raw/incoming/",
                collection,
                tracked_loader,
            )

        self.assertEqual(paths, sorted(by_path))
        self.assertGreater(max_active, 1)
        self.assertLessEqual(max_active, 3)

    def test_spark_job_invokes_identity_guard_before_and_after_all_actions(self) -> None:
        source = (
            Path(__file__).parents[1] / "scripts" / "runtime" / "spark_job_runtime.py"
        ).read_text(encoding="utf-8")
        before = source.index('phase="before_read"')
        read = source.index("source_df = read_source")
        last_action = source.index("sample_rows = collect_sample_rows")
        after = source.index('phase="after_read"')
        quality_report = source.index("write_report(report_file, result)", after)
        success_result = source.index('"status": "success"', after)

        self.assertLess(before, read)
        self.assertLess(read, last_action)
        self.assertLess(last_action, after)
        self.assertLess(after, quality_report)
        self.assertLess(after, success_result)


if __name__ == "__main__":
    unittest.main()
