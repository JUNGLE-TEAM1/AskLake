import json
import os
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from app.application import spark_resource_planning
from app.domain.spark_resource_history import normalize_spark_resource_history
from app.domain.spark_resource_plan import (
    DEFAULT_TARGET_PARTITION_BYTES,
    build_spark_resource_plan,
    normalize_spark_resource_plan,
    spark_resource_plan_hash,
)


class SparkResourcePlanTests(unittest.TestCase):
    def environment(self, mode: str = "shadow") -> dict[str, str]:
        return {
            "ASKLAKE_SPARK_RESOURCE_PLANNER_MODE": mode,
            "ASKLAKE_SPARK_RESOURCE_MIN_EXECUTORS": "1",
            "ASKLAKE_SPARK_RESOURCE_MAX_EXECUTORS": "4",
            "ASKLAKE_SPARK_RESOURCE_TARGET_PARTITION_BYTES": str(DEFAULT_TARGET_PARTITION_BYTES),
            "ASKLAKE_SPARK_RESOURCE_TARGET_PARTITIONS_PER_EXECUTOR": "384",
            "ASKLAKE_SPARK_KUBERNETES_EXECUTOR_CORES": "2",
            "ASKLAKE_SPARK_KUBERNETES_EXECUTOR_CORE_REQUEST": "2",
            "ASKLAKE_SPARK_KUBERNETES_EXECUTOR_CORE_LIMIT": "3",
            "ASKLAKE_SPARK_KUBERNETES_EXECUTOR_MEMORY": "4g",
            "ASKLAKE_SPARK_KUBERNETES_EXECUTOR_MEMORY_OVERHEAD": "1g",
        }

    def test_current_100gb_evidence_recommends_two_but_shadow_keeps_one(self) -> None:
        plan = build_spark_resource_plan(
            input_bytes=97_079_116_733,
            input_file_count=1,
            input_size_source="s3_head",
            baseline_executors=1,
            environment=self.environment(),
        )

        self.assertEqual(plan["estimatedPartitions"], 724)
        self.assertEqual(plan["calculatedExecutors"], 2)
        self.assertEqual(plan["recommendedExecutors"], 2)
        self.assertEqual(plan["appliedExecutors"], 1)
        self.assertEqual(plan["reason"], "balanced_partition_budget")
        self.assertEqual(plan["policyVersion"], 3)
        self.assertEqual(plan["policyName"], "history-sla-cost-v1")
        self.assertEqual(plan["policyTargetCompletionSeconds"], 1800)
        self.assertEqual(plan["decisionBasis"], "size_seed")
        self.assertEqual(plan["historyEvidenceCount"], 0)
        self.assertEqual(plan["historyComparableCount"], 0)
        self.assertEqual(
            [item["estimateSource"] for item in plan["candidateEvaluations"]],
            ["unavailable", "unavailable", "unavailable"],
        )
        self.assertEqual(plan["executorCandidates"], [1, 2, 4])
        self.assertEqual(plan["executorProfileName"], "standard-v1")
        self.assertEqual(plan["executorCores"], 2)
        self.assertEqual(plan["executorCpuRequest"], "2")
        self.assertEqual(plan["executorCpuLimit"], "3")
        self.assertEqual(plan["executorMemory"], "4g")
        self.assertEqual(plan["executorMemoryOverhead"], "1g")
        self.assertEqual(len(plan["planHash"]), 64)
        self.assertEqual(normalize_spark_resource_plan(plan), plan)

    def test_enforce_applies_recommended_executor_count(self) -> None:
        plan = build_spark_resource_plan(
            input_bytes=97_079_116_733,
            input_file_count=1,
            input_size_source="s3_head",
            baseline_executors=1,
            environment=self.environment("enforce"),
        )

        self.assertEqual(plan["estimatedPartitions"], 724)
        self.assertEqual(plan["recommendedExecutors"], 2)
        self.assertEqual(plan["appliedExecutors"], 2)

    def test_small_input_uses_one_and_unknown_input_preserves_baseline(self) -> None:
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
            baseline_executors=2,
            environment=self.environment("enforce"),
        )

        self.assertEqual(small["recommendedExecutors"], 1)
        self.assertEqual(unknown["recommendedExecutors"], 2)
        self.assertEqual(unknown["appliedExecutors"], 2)
        self.assertEqual(unknown["decisionStatus"], "fallback")
        self.assertEqual(unknown["reason"], "input_size_unavailable")
        self.assertEqual(unknown["inputSizeSource"], "unavailable")

    def test_unsupported_executor_profile_falls_back_even_in_enforce(self) -> None:
        environment = {
            **self.environment("enforce"),
            "ASKLAKE_SPARK_KUBERNETES_EXECUTOR_CORES": "4",
            "ASKLAKE_SPARK_KUBERNETES_EXECUTOR_CORE_REQUEST": "4",
            "ASKLAKE_SPARK_KUBERNETES_EXECUTOR_CORE_LIMIT": "4",
        }
        plan = build_spark_resource_plan(
            input_bytes=97_079_116_733,
            input_file_count=1,
            input_size_source="s3_head",
            baseline_executors=1,
            environment=environment,
        )

        self.assertEqual(plan["calculatedExecutors"], 2)
        self.assertEqual(plan["recommendedExecutors"], 1)
        self.assertEqual(plan["appliedExecutors"], 1)
        self.assertEqual(plan["decisionStatus"], "fallback")
        self.assertEqual(plan["executorProfileName"], "custom")
        self.assertEqual(plan["reason"], "executor_profile_unsupported")
        self.assertEqual(plan["decisionBasis"], "fallback")

    def test_executor_recommendation_rounds_to_supported_tiers_and_caps_at_four(self) -> None:
        rounded = build_spark_resource_plan(
            input_bytes=150_000_000_000,
            input_file_count=1,
            input_size_source="s3_head",
            baseline_executors=1,
            environment=self.environment(),
        )
        capped = build_spark_resource_plan(
            input_bytes=300_000_000_000,
            input_file_count=1,
            input_size_source="s3_head",
            baseline_executors=1,
            environment=self.environment(),
        )

        self.assertEqual(rounded["calculatedExecutors"], 3)
        self.assertEqual(rounded["recommendedExecutors"], 4)
        self.assertEqual(rounded["reason"], "rounded_to_supported_executor_tier")
        self.assertGreater(capped["calculatedExecutors"], 4)
        self.assertEqual(capped["recommendedExecutors"], 4)
        self.assertEqual(capped["reason"], "capped_by_max_executor_tier")

    def test_tampered_persisted_plan_is_rejected(self) -> None:
        plan = build_spark_resource_plan(
            input_bytes=50_000_000_000,
            input_file_count=1,
            input_size_source="source_selection_snapshot",
            baseline_executors=1,
            environment=self.environment(),
        )
        plan["inputFileCount"] = 2

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

    def test_balanced_v1_rejects_policy_parameter_drift(self) -> None:
        environment = {
            **self.environment(),
            "ASKLAKE_SPARK_RESOURCE_TARGET_PARTITIONS_PER_EXECUTOR": "96",
        }

        with self.assertRaisesRegex(ValueError, "must be 384"):
            build_spark_resource_plan(
                input_bytes=97_079_116_733,
                input_file_count=1,
                input_size_source="s3_head",
                baseline_executors=1,
                environment=environment,
            )

    def test_sparse_history_selects_lowest_cost_candidate_that_meets_sla(self) -> None:
        plan = build_spark_resource_plan(
            input_bytes=97_079_116_733,
            input_file_count=1,
            input_size_source="s3_head",
            baseline_executors=1,
            historical_observations=[{
                "runId": "RUN-1",
                "inputBytes": 97_079_116_733,
                "durationMs": 2_482_265,
                "executorInstances": 1,
            }],
            environment=self.environment(),
        )

        self.assertEqual(plan["decisionBasis"], "history_sla_cost")
        self.assertEqual(plan["reason"], "history_min_cost_meets_sla")
        self.assertEqual(plan["recommendedExecutors"], 2)
        self.assertEqual(plan["historyEvidenceCount"], 1)
        self.assertEqual(plan["historyComparableCount"], 1)
        self.assertFalse(plan["candidateEvaluations"][0]["meetsTarget"])
        self.assertTrue(plan["candidateEvaluations"][1]["meetsTarget"])
        self.assertEqual(normalize_spark_resource_plan(plan), plan)

    def test_reference_100gb_backtest_selects_executor_two(self) -> None:
        fixture_path = (
            Path(__file__).parents[1]
            / "benchmarks"
            / "spark-resource-planner"
            / "reference-100gb.v1.json"
        )
        fixture = json.loads(fixture_path.read_text(encoding="utf-8"))

        plan = build_spark_resource_plan(
            input_bytes=fixture["inputBytes"],
            input_file_count=fixture["inputFileCount"],
            input_size_source="backtest_fixture",
            baseline_executors=1,
            historical_observations=fixture["observations"],
            environment=self.environment("enforce"),
        )

        self.assertEqual(plan["recommendedExecutors"], 2)
        self.assertEqual(plan["appliedExecutors"], 2)
        self.assertEqual(
            [item["estimateSource"] for item in plan["candidateEvaluations"]],
            ["measured", "measured", "measured"],
        )
        self.assertEqual(
            [item["estimatedExecutorSeconds"] for item in plan["candidateEvaluations"]],
            [2654.186, 3129.6, 4365.896],
        )

    def test_history_without_an_sla_candidate_uses_largest_bounded_tier(self) -> None:
        plan = build_spark_resource_plan(
            input_bytes=100_000_000_000,
            input_file_count=1,
            input_size_source="s3_head",
            baseline_executors=1,
            historical_observations=[{
                "runId": "RUN-SLOW",
                "inputBytes": 100_000_000_000,
                "durationMs": 10_000_000,
                "executorInstances": 1,
            }],
            environment=self.environment(),
        )

        self.assertEqual(plan["recommendedExecutors"], 4)
        self.assertEqual(plan["reason"], "history_no_candidate_meets_sla")

    def test_balanced_v1_rejects_baseline_above_four(self) -> None:
        with self.assertRaisesRegex(ValueError, "at most 4"):
            build_spark_resource_plan(
                input_bytes=97_079_116_733,
                input_file_count=1,
                input_size_source="s3_head",
                baseline_executors=5,
                environment=self.environment(),
            )

    def test_legacy_v1_persisted_plan_remains_recoverable(self) -> None:
        plan = {
            "policyVersion": 1,
            "mode": "shadow",
            "inputBytes": 97_079_116_733,
            "inputFileCount": 1,
            "inputSizeSource": "s3_head",
            "targetPartitionBytes": 134_217_728,
            "targetPartitionsPerExecutor": 96,
            "estimatedPartitions": 724,
            "calculatedExecutors": 8,
            "recommendedExecutors": 6,
            "baselineExecutors": 1,
            "appliedExecutors": 1,
            "minExecutors": 1,
            "maxExecutors": 6,
            "reason": "capped_by_max_executors",
        }
        plan["planHash"] = spark_resource_plan_hash(plan)

        self.assertEqual(normalize_spark_resource_plan(plan), plan)


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

    def test_history_normalization_accepts_only_matching_successful_run_evidence(self) -> None:
        environment = SparkResourcePlanTests().environment("shadow")
        previous_plan = build_spark_resource_plan(
            input_bytes=97_079_116_733,
            input_file_count=1,
            input_size_source="s3_head",
            baseline_executors=1,
            environment=environment,
        )
        accepted = SimpleNamespace(
            run_id="RUN-PREVIOUS",
            status="success",
            task_states={
                "sparkExecution": {"resourcePlan": previous_plan},
                "sparkResult": {
                    "status": "success",
                    "durationMs": 2_482_265,
                    "inputBytes": 97_079_116_733,
                    "sparkResources": {"executorInstances": 1, "executorCores": 2},
                },
            },
        )
        mismatched_actual_executor = SimpleNamespace(
            run_id="RUN-MISMATCH",
            status="success",
            task_states={
                "sparkExecution": {"resourcePlan": previous_plan},
                "sparkResult": {
                    "status": "success",
                    "durationMs": 1_000,
                    "inputBytes": 97_079_116_733,
                    "sparkResources": {"executorInstances": 2, "executorCores": 2},
                },
            },
        )

        observations = normalize_spark_resource_history(
            [mismatched_actual_executor, accepted],
            current_run_id="RUN-CURRENT",
            supported_executors=(1, 2, 4),
            normalize_plan=normalize_spark_resource_plan,
        )

        self.assertEqual(len(observations), 1)
        self.assertEqual(observations[0]["runId"], "RUN-PREVIOUS")

    def test_job_planner_reads_normalized_history_for_the_new_run(self) -> None:
        environment = SparkResourcePlanTests().environment("shadow")
        previous_plan = build_spark_resource_plan(
            input_bytes=97_079_116_733,
            input_file_count=1,
            input_size_source="s3_head",
            baseline_executors=1,
            environment=environment,
        )
        previous_run = SimpleNamespace(
            run_id="RUN-PREVIOUS",
            status="success",
            task_states={
                "sparkExecution": {"resourcePlan": previous_plan},
                "sparkResult": {
                    "status": "success",
                    "durationMs": 2_482_265,
                    "inputBytes": 97_079_116_733,
                    "sparkResources": {"executorInstances": 1, "executorCores": 2},
                },
            },
        )
        job = SimpleNamespace(
            source_type="File / S3",
            source_config=[
                ["Bucket / Stage Name", "raw-bucket"],
                ["Path / Prefix", "dataset/input.jsonl"],
                ["__Selection Kind", "file"],
            ],
        )
        client = Mock()
        client.head_object.return_value = {"ContentLength": 97_079_116_733}

        with (
            patch.dict(os.environ, environment, clear=False),
            patch.object(
                spark_resource_planning,
                "_allows_unconfigured_s3_source",
                return_value=True,
            ),
        ):
            plan = spark_resource_planning.spark_resource_plan_for_job(
                job,
                current_run_id="RUN-CURRENT",
                historical_runs=[previous_run],
                s3_client=client,
            )

        self.assertIsNotNone(plan)
        self.assertEqual(plan["decisionBasis"], "history_sla_cost")
        self.assertEqual(plan["recommendedExecutors"], 2)


if __name__ == "__main__":
    unittest.main()
