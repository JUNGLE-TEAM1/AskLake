import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from app.application import spark_resource_planning
from app.domain.spark_resource_plan import (
    DEFAULT_TARGET_PARTITION_BYTES,
    build_spark_resource_plan,
    normalize_spark_resource_plan,
)


class SparkResourcePlanTests(unittest.TestCase):
    def environment(self, mode: str = "shadow") -> dict[str, str]:
        return {
            "ASKLAKE_SPARK_RESOURCE_PLANNER_MODE": mode,
            "ASKLAKE_SPARK_RESOURCE_MIN_EXECUTORS": "1",
            "ASKLAKE_SPARK_RESOURCE_MAX_EXECUTORS": "6",
            "ASKLAKE_SPARK_RESOURCE_TARGET_PARTITION_BYTES": str(DEFAULT_TARGET_PARTITION_BYTES),
            "ASKLAKE_SPARK_RESOURCE_TARGET_PARTITIONS_PER_EXECUTOR": "96",
        }

    def test_current_100gb_evidence_recommends_six_but_shadow_keeps_one(self) -> None:
        plan = build_spark_resource_plan(
            input_bytes=97_079_116_733,
            input_file_count=1,
            input_size_source="s3_head",
            baseline_executors=1,
            environment=self.environment(),
        )

        self.assertEqual(plan["estimatedPartitions"], 724)
        self.assertEqual(plan["calculatedExecutors"], 8)
        self.assertEqual(plan["recommendedExecutors"], 6)
        self.assertEqual(plan["appliedExecutors"], 1)
        self.assertEqual(plan["reason"], "capped_by_max_executors")
        self.assertEqual(len(plan["planHash"]), 64)
        self.assertEqual(normalize_spark_resource_plan(plan), plan)

    def test_enforce_applies_recommended_executor_count(self) -> None:
        plan = build_spark_resource_plan(
            input_bytes=50_000_000_000,
            input_file_count=1,
            input_size_source="s3_head",
            baseline_executors=1,
            environment=self.environment("enforce"),
        )

        self.assertEqual(plan["estimatedPartitions"], 373)
        self.assertEqual(plan["recommendedExecutors"], 4)
        self.assertEqual(plan["appliedExecutors"], 4)

    def test_small_and_unknown_inputs_keep_one_executor(self) -> None:
        small = build_spark_resource_plan(
            input_bytes=10_000_000_000,
            input_file_count=1,
            input_size_source="s3_head",
            baseline_executors=1,
            environment=self.environment(),
        )
        unknown = build_spark_resource_plan(
            input_bytes=None,
            input_file_count=None,
            input_size_source="",
            baseline_executors=1,
            environment=self.environment(),
        )

        self.assertEqual(small["recommendedExecutors"], 1)
        self.assertEqual(unknown["recommendedExecutors"], 1)
        self.assertEqual(unknown["reason"], "input_size_unavailable")
        self.assertEqual(unknown["inputSizeSource"], "unavailable")

    def test_tampered_persisted_plan_is_rejected(self) -> None:
        plan = build_spark_resource_plan(
            input_bytes=50_000_000_000,
            input_file_count=1,
            input_size_source="source_selection_snapshot",
            baseline_executors=1,
            environment=self.environment(),
        )
        plan["appliedExecutors"] = 5

        with self.assertRaisesRegex(ValueError, "hash"):
            normalize_spark_resource_plan(plan)

    def test_invalid_mode_fails_safe_to_off(self) -> None:
        plan = build_spark_resource_plan(
            input_bytes=50_000_000_000,
            input_file_count=1,
            input_size_source="source_selection_snapshot",
            baseline_executors=3,
            environment=self.environment("typo"),
        )

        self.assertEqual(plan["mode"], "off")
        self.assertEqual(plan["appliedExecutors"], 3)


class SparkResourceInputEstimateTests(unittest.TestCase):
    def test_legacy_active_application_recovers_without_a_new_plan(self) -> None:
        job = SimpleNamespace(source_type="File / S3", source_config=[])
        previous_execution = {
            "kubernetesExecution": {
                "applicationName": "legacy-application",
                "applicationUid": "legacy-uid",
            },
        }

        with patch.object(spark_resource_planning, "spark_resource_plan_for_job") as planner:
            plan = spark_resource_planning.resolve_spark_resource_plan_for_execution(
                previous_execution,
                job,
                job_id="JOB-LEGACY",
                run_id="RUN-LEGACY",
            )

        self.assertIsNone(plan)
        planner.assert_not_called()

    def test_single_s3_file_uses_head_content_length(self) -> None:
        job = SimpleNamespace(
            source_type="File / S3",
            source_config=[
                ["Bucket / Stage Name", "raw-bucket"],
                ["Path / Prefix", "dataset/input.jsonl"],
                ["__Selection Kind", "file"],
                ["__Selected Object", "dataset/input.jsonl"],
            ],
        )
        client = Mock()
        client.head_object.return_value = {"ContentLength": 97_079_116_733}

        with patch.object(
            spark_resource_planning,
            "_allows_unconfigured_s3_source",
            return_value=True,
        ):
            estimate = spark_resource_planning.spark_resource_input_estimate(
                job,
                s3_client=client,
            )

        self.assertEqual(estimate, {
            "inputBytes": 97_079_116_733,
            "inputFileCount": 1,
            "inputSizeSource": "s3_head",
        })
        client.head_object.assert_called_once_with(
            Bucket="raw-bucket",
            Key="dataset/input.jsonl",
        )

    def test_prefix_uses_stored_selection_snapshot(self) -> None:
        job = SimpleNamespace(
            source_type="File / S3",
            source_config=[
                ["__Selection Kind", "prefix"],
                ["__Source Total Bytes", "50000000000"],
                ["__Source Unit Count", "12"],
            ],
        )

        estimate = spark_resource_planning.spark_resource_input_estimate(job)

        self.assertEqual(estimate, {
            "inputBytes": 50_000_000_000,
            "inputFileCount": 12,
            "inputSizeSource": "source_selection_snapshot",
        })

    def test_metadata_failure_is_a_safe_unavailable_estimate(self) -> None:
        job = SimpleNamespace(
            source_type="File / S3",
            source_config=[
                ["Bucket / Stage Name", "raw-bucket"],
                ["Path / Prefix", "dataset/input.jsonl"],
                ["__Selection Kind", "file"],
            ],
        )
        client = Mock()
        client.head_object.side_effect = RuntimeError("temporary S3 failure")

        with patch.object(
            spark_resource_planning,
            "_allows_unconfigured_s3_source",
            return_value=True,
        ):
            estimate = spark_resource_planning.spark_resource_input_estimate(
                job,
                s3_client=client,
            )

        self.assertEqual(estimate, {
            "inputBytes": None,
            "inputFileCount": None,
            "inputSizeSource": "unavailable",
        })


if __name__ == "__main__":
    unittest.main()
