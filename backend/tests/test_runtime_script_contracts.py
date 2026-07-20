from __future__ import annotations

import ast
import json
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest


SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from runtime.contracts import (  # noqa: E402
    LEGACY_RUNTIME_JSON_PATH,
    ShutdownCoordinator,
    append_secondary_error,
    atomic_write_json,
    bounded_int_env,
    read_versioned_json,
    reset_runtime_compatibility_path_counts_for_test,
    required_env,
    runtime_compatibility_path_counts,
)
from runtime.config import KafkaWorkerConfig, SparkJobConfig  # noqa: E402
from runtime.kafka_state import (  # noqa: E402
    normalize_stream_partition_cursors,
    stream_partition_cursor_payload,
)
from runtime.spark_staged_cache import staged_cache_decision  # noqa: E402


class RuntimeScriptContractTests(unittest.TestCase):
    def test_historical_entrypoints_are_thin_compatibility_facades(self) -> None:
        for name in ("spark_job_run.py", "kafka_continuous_stream.py"):
            source = (SCRIPTS_DIR / name).read_text(encoding="utf-8")
            self.assertLessEqual(len(source.splitlines()), 20)
            self.assertIn("sys.modules[__name__] = _implementation", source)

    def test_rag_spark_runtime_supports_non_speculative_partition_work(self) -> None:
        runtime_path = SCRIPTS_DIR / "runtime" / "spark_job_runtime.py"
        source = runtime_path.read_text(encoding="utf-8")
        tree = ast.parse(source)
        make_spark = next(
            node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "make_spark"
        )

        self.assertIn("disable_speculation", [arg.arg for arg in make_spark.args.kwonlyargs])
        self.assertIn('.config("spark.speculation", "false")', source)
        for name in ("rag_parent_staging.py", "rag_chunk_staging.py", "rag_index_dispatch.py"):
            self.assertIn("disable_speculation=True", (SCRIPTS_DIR / name).read_text(encoding="utf-8"))

    def test_atomic_report_adds_version_and_legacy_reader_stays_compatible(self) -> None:
        reset_runtime_compatibility_path_counts_for_test()
        with TemporaryDirectory() as directory:
            path = Path(directory) / "runtime.json"
            atomic_write_json(path, {"status": "running"}, schema_field="runtimeReportSchemaVersion")
            payload = read_versioned_json(path, schema_field="runtimeReportSchemaVersion")
            self.assertEqual(payload["runtimeReportSchemaVersion"], 1)
            self.assertEqual(list(Path(directory).glob("*.tmp")), [])

            path.write_text(json.dumps({"status": "legacy"}), encoding="utf-8")
            legacy = read_versioned_json(path, schema_field="runtimeReportSchemaVersion")
            self.assertEqual(legacy["status"], "legacy")
            self.assertEqual(runtime_compatibility_path_counts()[LEGACY_RUNTIME_JSON_PATH], 1)

    def test_future_report_version_fails_closed(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "runtime.json"
            path.write_text(json.dumps({"runtimeReportSchemaVersion": 99}), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "Unsupported runtimeReportSchemaVersion"):
                read_versioned_json(path, schema_field="runtimeReportSchemaVersion")

    def test_environment_contract_is_typed_and_bounded(self) -> None:
        environment = {"COUNT": "999", "REQUIRED": "value"}
        self.assertEqual(
            bounded_int_env("COUNT", 3, minimum=1, maximum=10, environ=environment),
            10,
        )
        self.assertEqual(required_env("REQUIRED", environ=environment), "value")
        with self.assertRaisesRegex(ValueError, "MISSING"):
            required_env("MISSING", environ=environment)

    def test_spark_and_kafka_config_validate_without_runtime_dependencies(self) -> None:
        spark = SparkJobConfig.from_environment({
            "ASKLAKE_SPARK_SOURCE_PATH": "s3a://raw/events",
            "ASKLAKE_SPARK_SOURCE_FORMAT": "JSONL",
            "ASKLAKE_SPARK_OUTPUT_PATH": "s3a://output/events",
            "ASKLAKE_SPARK_RUN_ID": "run-1",
            "ASKLAKE_SPARK_RUN_ROW_LIMIT": "100",
            "ASKLAKE_SPARK_STAGED_CACHE_MAX_BYTES": "1048576",
        })
        self.assertEqual(
            (spark.source_format, spark.row_limit, spark.staged_cache_max_bytes),
            ("jsonl", 100, 1048576),
        )

        kafka = KafkaWorkerConfig.from_environment({
            "ASKLAKE_CONTINUOUS_JOB_ID": "job-1",
            "ASKLAKE_CONTINUOUS_BROKER": "redpanda:9092",
            "ASKLAKE_CONTINUOUS_TOPIC": "events",
            "ASKLAKE_CONTINUOUS_CONSUMER_GROUP_ID": "group-1",
            "ASKLAKE_CONTINUOUS_OUTPUT_PATH": "s3a://output/events",
            "ASKLAKE_CONTINUOUS_CHECKPOINT_PATH": "s3a://output/checkpoint",
            "ASKLAKE_CONTINUOUS_TRIGGER_SECONDS": "5",
        })
        self.assertEqual((kafka.topic, kafka.trigger_seconds), ("events", 5))

    def test_staged_cache_policy_fails_closed_until_an_exact_small_size_is_known(self) -> None:
        self.assertEqual(
            staged_cache_decision(100, 0),
            staged_cache_decision(None, 0),
        )
        self.assertEqual(staged_cache_decision(None, 100).reason, "size_unavailable")
        self.assertEqual(staged_cache_decision(0, 100).reason, "empty_materialization")
        self.assertEqual(staged_cache_decision(101, 100).reason, "above_threshold")
        self.assertTrue(staged_cache_decision(100, 100).eligible)

        base_environment = {
            "ASKLAKE_SPARK_OUTPUT_PATH": "s3a://output/events",
            "ASKLAKE_SPARK_RUN_ID": "run-1",
            "ASKLAKE_SPARK_SOURCE_FORMAT": "jsonl",
            "ASKLAKE_SPARK_SOURCE_PATH": "s3a://raw/events",
        }
        with self.assertRaisesRegex(
            ValueError,
            "ASKLAKE_SPARK_STAGED_CACHE_MAX_BYTES must be zero or greater",
        ):
            SparkJobConfig.from_environment({
                **base_environment,
                "ASKLAKE_SPARK_STAGED_CACHE_MAX_BYTES": "-1",
            })

    def test_partition_cursor_state_is_normalized_deterministically(self) -> None:
        cursors = normalize_stream_partition_cursors([
            {"topic": "events", "partition": 1, "nextOffset": 3},
            {"topic": "events", "partition": 0, "nextOffset": 5},
            {"topic": "events", "partition": 1, "nextOffset": 9},
            {"topic": "", "partition": 2, "nextOffset": 1},
        ])
        self.assertEqual(stream_partition_cursor_payload(cursors), [
            {"topic": "events", "partition": 0, "nextOffset": 5},
            {"topic": "events", "partition": 1, "nextOffset": 9},
        ])

    def test_shutdown_coordinator_is_spark_free_and_idempotent(self) -> None:
        query = SimpleNamespace(stops=0)
        query.stop = lambda: setattr(query, "stops", query.stops + 1)
        coordinator = ShutdownCoordinator()
        coordinator.request_stop(query)
        self.assertTrue(coordinator.requested)
        self.assertEqual(query.stops, 1)

    def test_secondary_report_error_does_not_replace_primary_error(self) -> None:
        result = {"error": "primary Spark failure", "status": "failed"}
        append_secondary_error(result, PermissionError("report denied"), stage="runtime_report")
        self.assertEqual(result["error"], "primary Spark failure")
        self.assertEqual(result["secondaryErrors"][0]["errorType"], "PermissionError")


if __name__ == "__main__":
    unittest.main()
