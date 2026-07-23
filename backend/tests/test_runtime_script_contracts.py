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
    load_spark_job_manifest,
    read_versioned_json,
    reset_runtime_compatibility_path_counts_for_test,
    required_env,
    runtime_compatibility_path_counts,
)
from runtime.config import (  # noqa: E402
    KafkaWorkerConfig,
    SparkJobConfig,
    kafka_security_options,
)
from runtime.kafka_state import (  # noqa: E402
    normalize_stream_partition_cursors,
    stream_partition_cursor_payload,
)
from runtime.kafka_stream import load_kafka_stream  # noqa: E402


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

    def test_inline_spark_manifest_precedes_container_local_path(self) -> None:
        manifest = {"icebergTarget": {"table": "events"}, "jobId": "job-1"}
        loaded = load_spark_job_manifest(environ={
            "ASKLAKE_SPARK_JOB_MANIFEST_JSON": json.dumps(manifest),
            "ASKLAKE_SPARK_JOB_MANIFEST_FILE": "/work/reports/missing.json",
        })
        self.assertEqual(loaded, manifest)

    def test_spark_and_kafka_config_validate_without_runtime_dependencies(self) -> None:
        spark = SparkJobConfig.from_environment({
            "ASKLAKE_SPARK_SOURCE_PATH": "s3a://raw/events",
            "ASKLAKE_SPARK_SOURCE_FORMAT": "JSONL",
            "ASKLAKE_SPARK_OUTPUT_PATH": "s3a://output/events",
            "ASKLAKE_SPARK_RUN_ID": "run-1",
            "ASKLAKE_SPARK_RUN_ROW_LIMIT": "100",
        })
        self.assertEqual((spark.source_format, spark.row_limit), ("jsonl", 100))

        kafka = KafkaWorkerConfig.from_environment({
            "ASKLAKE_CONTINUOUS_JOB_ID": "job-1",
            "ASKLAKE_CONTINUOUS_BROKER": "redpanda:9092",
            "ASKLAKE_CONTINUOUS_TOPIC": "events",
            "ASKLAKE_CONTINUOUS_CONSUMER_GROUP_ID": "group-1",
            "ASKLAKE_CONTINUOUS_OUTPUT_PATH": "s3a://output/events",
            "ASKLAKE_CONTINUOUS_CHECKPOINT_PATH": "s3a://output/checkpoint",
            "ASKLAKE_CONTINUOUS_TRIGGER_SECONDS": "5",
        })
        self.assertEqual((kafka.topic, kafka.trigger_seconds, kafka.auth_mode), ("events", 5, "none"))

        msk = KafkaWorkerConfig.from_environment({
            "ASKLAKE_CONTINUOUS_JOB_ID": "job-msk",
            "ASKLAKE_CONTINUOUS_BROKER": "b-1.example:9098,b-2.example:9098",
            "ASKLAKE_CONTINUOUS_TOPIC": "events",
            "ASKLAKE_CONTINUOUS_CONSUMER_GROUP_ID": "group-msk",
            "ASKLAKE_CONTINUOUS_OUTPUT_PATH": "s3a://output/events",
            "ASKLAKE_CONTINUOUS_CHECKPOINT_PATH": "s3a://output/checkpoint",
            "ASKLAKE_CONTINUOUS_TRIGGER_SECONDS": "5",
            "ASKLAKE_KAFKA_AUTH_MODE": "iam",
        })
        self.assertEqual(msk.auth_mode, "iam")
        self.assertEqual(kafka_security_options(msk.auth_mode), {
            "kafka.security.protocol": "SASL_SSL",
            "kafka.sasl.mechanism": "AWS_MSK_IAM",
            "kafka.sasl.jaas.config": "software.amazon.msk.auth.iam.IAMLoginModule required;",
            "kafka.sasl.client.callback.handler.class": (
                "software.amazon.msk.auth.iam.IAMClientCallbackHandler"
            ),
        })
        with self.assertRaisesRegex(ValueError, "does not match|requires"):
            KafkaWorkerConfig.from_environment({
                "ASKLAKE_CONTINUOUS_JOB_ID": "job-invalid-auth",
                "ASKLAKE_CONTINUOUS_BROKER": "redpanda:9092",
                "ASKLAKE_CONTINUOUS_TOPIC": "events",
                "ASKLAKE_CONTINUOUS_CONSUMER_GROUP_ID": "group-invalid-auth",
                "ASKLAKE_CONTINUOUS_OUTPUT_PATH": "s3a://output/events",
                "ASKLAKE_CONTINUOUS_CHECKPOINT_PATH": "s3a://output/checkpoint",
                "ASKLAKE_KAFKA_AUTH_MODE": "iam",
            })

        class FakeReader:
            def __init__(self) -> None:
                self.options = {}
                self.loaded = False

            def format(self, value):
                self.options["format"] = value
                return self

            def option(self, name, value):
                self.options[name] = value
                return self

            def load(self):
                self.loaded = True
                return self

        reader = FakeReader()
        loaded = load_kafka_stream(
            SimpleNamespace(readStream=reader),
            msk,
            {
                "ASKLAKE_CONTINUOUS_OFFSET_POLICY": "latest",
                "ASKLAKE_CONTINUOUS_MAX_OFFSETS": "25",
            },
        )
        self.assertIs(loaded, reader)
        self.assertTrue(reader.loaded)
        self.assertEqual(reader.options["kafka.sasl.mechanism"], "AWS_MSK_IAM")
        self.assertEqual(reader.options["startingOffsets"], "latest")
        self.assertEqual(reader.options["maxOffsetsPerTrigger"], "25")

    def test_continuous_record_parser_maps_nested_leaf_paths(self) -> None:
        source = (
            SCRIPTS_DIR / "runtime" / "kafka_continuous_runtime.py"
        ).read_text(encoding="utf-8")
        tree = ast.parse(source)
        raw_record_payload = next(
            node
            for node in tree.body
            if isinstance(node, ast.FunctionDef) and node.name == "raw_record_payload"
        )
        rendered = ast.unparse(raw_record_payload)

        self.assertIn("source_path = f", rendered)
        self.assertIn("parent_path}.{field.name}", rendered)
        self.assertIn("isinstance(field.dataType, StructType)", rendered)
        self.assertIn("columns_by_name.get(source_path)", rendered)

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
