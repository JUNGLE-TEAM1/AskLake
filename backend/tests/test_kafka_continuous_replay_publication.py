import importlib.util
import json
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import Mock, patch


class DynamicModule(ModuleType):
    def __getattr__(self, _name):
        return lambda *_args, **_kwargs: None


def load_maintenance_module():
    scripts_dir = Path(__file__).resolve().parents[1] / "scripts"
    module_path = scripts_dir / "kafka_continuous_maintenance.py"
    pyspark = ModuleType("pyspark")
    pyspark_sql = ModuleType("pyspark.sql")
    pyspark_functions = DynamicModule("pyspark.sql.functions")
    pyspark_types = DynamicModule("pyspark.sql.types")
    pyspark_window = ModuleType("pyspark.sql.window")
    pyspark_sql.SparkSession = object
    pyspark_sql.functions = pyspark_functions
    pyspark_sql.types = pyspark_types
    pyspark_window.Window = SimpleNamespace()

    kafka_schema_paths = DynamicModule("kafka_schema_paths")
    object_storage_runtime = DynamicModule("object_storage_runtime")
    snapshot_rule_runtime = DynamicModule("snapshot_rule_runtime")
    spark_job_run = DynamicModule("spark_job_run")
    stubs = {
        "pyspark": pyspark,
        "pyspark.sql": pyspark_sql,
        "pyspark.sql.functions": pyspark_functions,
        "pyspark.sql.types": pyspark_types,
        "pyspark.sql.window": pyspark_window,
        "kafka_schema_paths": kafka_schema_paths,
        "object_storage_runtime": object_storage_runtime,
        "snapshot_rule_runtime": snapshot_rule_runtime,
        "spark_job_run": spark_job_run,
    }
    spec = importlib.util.spec_from_file_location(
        "_test_kafka_continuous_maintenance",
        module_path,
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load Kafka continuous maintenance script")
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, stubs):
        spec.loader.exec_module(module)
    return module


maintenance = load_maintenance_module()


class FakeManifestWriter:
    def __init__(self, *, failure: Exception | None = None) -> None:
        self.failure = failure
        self.mode_value: str | None = None
        self.path: str | None = None

    def mode(self, value: str):
        self.mode_value = value
        return self

    def json(self, path: str) -> None:
        self.path = path
        if self.failure is not None:
            raise self.failure


class FakeManifestRead:
    def __init__(self, writer: FakeManifestWriter) -> None:
        self.writer = writer
        self.rows: list[str] = []

    def json(self, rows: list[str]):
        self.rows = rows
        return SimpleNamespace(write=self.writer)


def fake_spark(*, write_failure: Exception | None = None):
    writer = FakeManifestWriter(failure=write_failure)
    reader = FakeManifestRead(writer)
    spark = SimpleNamespace(
        read=reader,
        sparkContext=SimpleNamespace(parallelize=lambda rows: rows),
    )
    return spark, reader, writer


def commit_evidence(previous_snapshot, *, operation: str = "append") -> dict:
    return {
        "_committedSnapshotId": "101",
        "_previousSnapshot": previous_snapshot,
        "_rollbackRequired": operation != "reuse",
        "createdTable": previous_snapshot is None,
        "operation": operation,
        "runId": "replay-1",
        "snapshotId": "101",
    }


class KafkaContinuousReplayPublicationTests(unittest.TestCase):
    target = {
        "namespace": "asklake",
        "table": "orders",
        "tableUri": "iceberg://iceberg/asklake/orders",
    }
    boundary = {
        "kind": "kafka_continuous_replay",
        "runId": "replay-1",
    }
    ranges = [{
        "topic": "orders",
        "partition": 0,
        "startOffset": 10,
        "endOffset": 11,
    }]

    def publish(self, spark, commit):
        return maintenance.publish_replay_manifest(
            spark,
            "s3a://lake/orders/_replay-manifests/run_id=replay-1",
            self.target,
            commit,
            run_id="replay-1",
            stored_count=1,
            source_boundary=self.boundary,
            source_ranges=self.ranges,
        )

    def test_missing_success_marker_rolls_back_existing_or_new_table_commit(self) -> None:
        for previous_snapshot in ({"snapshotId": "100"}, None):
            with self.subTest(previous_snapshot=previous_snapshot):
                spark, _reader, writer = fake_spark()
                commit = commit_evidence(previous_snapshot)
                with (
                    patch.object(maintenance, "output_committed", return_value=False),
                    patch.object(maintenance, "rollback_iceberg_commit") as rollback,
                ):
                    with self.assertRaisesRegex(RuntimeError, "completion marker"):
                        self.publish(spark, commit)

                rollback.assert_called_once_with(
                    spark,
                    self.target,
                    previous_snapshot,
                    committed_snapshot_id="101",
                )
                self.assertIn("_previousSnapshot", commit)
                self.assertEqual(writer.mode_value, "errorifexists")

    def test_manifest_write_failure_rolls_back_and_returns_no_public_evidence(self) -> None:
        spark, _reader, _writer = fake_spark(
            write_failure=RuntimeError("manifest write failed")
        )
        previous_snapshot = {"snapshotId": "100"}
        commit = commit_evidence(previous_snapshot)
        with patch.object(maintenance, "rollback_iceberg_commit") as rollback:
            with self.assertRaisesRegex(RuntimeError, "manifest write failed"):
                self.publish(spark, commit)

        rollback.assert_called_once_with(
            spark,
            self.target,
            previous_snapshot,
            committed_snapshot_id="101",
        )
        self.assertIn("_previousSnapshot", commit)

    def test_success_marker_removes_private_rollback_evidence_only_after_publish(self) -> None:
        spark, reader, _writer = fake_spark()
        commit = commit_evidence({"snapshotId": "100"})
        with (
            patch.object(maintenance, "output_committed", return_value=True),
            patch.object(maintenance, "rollback_iceberg_commit") as rollback,
        ):
            result = self.publish(spark, commit)

        rollback.assert_not_called()
        self.assertNotIn("_previousSnapshot", result)
        self.assertNotIn("_previousSnapshot", commit)
        self.assertNotIn("_committedSnapshotId", result)
        self.assertNotIn("_rollbackRequired", result)
        manifest = json.loads(reader.rows[0])
        self.assertNotIn("_previousSnapshot", manifest["icebergCommit"])

    def test_reused_marker_does_not_rollback_a_commit_from_an_earlier_attempt(self) -> None:
        spark, _reader, _writer = fake_spark()
        commit = commit_evidence(None, operation="reuse")
        with (
            patch.object(maintenance, "output_committed", return_value=False),
            patch.object(maintenance, "rollback_iceberg_commit") as rollback,
        ):
            with self.assertRaisesRegex(RuntimeError, "completion marker"):
                self.publish(spark, commit)

        rollback.assert_not_called()


if __name__ == "__main__":
    unittest.main()
