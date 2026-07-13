import importlib
import os
from pathlib import Path
import sys
from threading import Lock
import time
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import Mock, patch

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

    def withColumn(self, _name: str, _value):
        return self


class FakeSpark:
    def __init__(self, frame: FakeFrame) -> None:
        self.read = SimpleNamespace(parquet=Mock(return_value=frame))
        self.stop = Mock()


class SparkSourceIdentityTests(unittest.TestCase):
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
        with (
            patch.dict(os.environ, environment, clear=True),
            patch.object(spark_job_run, "load_spark_job_manifest", return_value={"sourceCollection": collection}),
            patch.object(spark_job_run, "make_spark", return_value=spark),
            patch.object(
                spark_job_run,
                "verify_spark_source_inventory",
                side_effect=[None, ValueError("SOURCE_OBJECT_IDENTITY_MISMATCH key=incoming/a.jsonl phase=after_read")],
            ) as verify,
            patch.object(spark_job_run, "read_source", return_value=frame),
            patch.object(spark_job_run, "normalize_columns", return_value=frame),
            patch.object(spark_job_run, "apply_schema_contract", return_value=frame),
            patch.object(spark_job_run, "apply_transform_steps", return_value=frame),
            patch.object(spark_job_run, "select_final_schema_columns", return_value=frame),
            patch.object(spark_job_run, "resolve_partition_columns", return_value=[]),
            patch.object(spark_job_run, "plan_review_row_analysis_checks", return_value=[]),
            patch.object(spark_job_run, "evaluate_quality_rules", return_value={"status": "pass"}),
            patch.object(spark_job_run, "evaluate_custom_csv_classifier_checks", return_value=[]),
            patch.object(spark_job_run, "evaluate_review_row_analysis_checks", return_value=[]),
            patch.object(spark_job_run, "text_structuring_manifest", return_value={"definition": {"columns": []}}),
            patch.object(spark_job_run, "collect_sample_rows", return_value=[]),
            patch.object(spark_job_run, "write_report", write_report),
            patch.object(spark_job_run, "cleanup_failed_output_paths", return_value=[]) as cleanup,
            patch.object(spark_job_run.F, "lit", return_value="run-1"),
            patch.object(spark_job_run.F, "current_timestamp", return_value="now"),
            patch("builtins.print"),
        ):
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
        source = (Path(__file__).parents[1] / "scripts" / "spark_job_run.py").read_text(encoding="utf-8")
        before = source.index('phase="before_read"')
        read = source.index("source_df = read_source")
        last_action = source.index("sample_rows = collect_sample_rows")
        after = source.index('phase="after_read"')
        quality_report = source.index("write_report(report_file, result, spark)", after)
        success_result = source.index('"status": "success"', after)

        self.assertLess(before, read)
        self.assertLess(read, last_action)
        self.assertLess(last_action, after)
        self.assertLess(after, quality_report)
        self.assertLess(after, success_result)


if __name__ == "__main__":
    unittest.main()
