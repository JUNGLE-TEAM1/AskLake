import unittest

from app.application.eks_spark_retry import prepare_eks_spark_attempt
from app.domain.spark_resource_plan import build_spark_resource_plan


class EksSparkRetryResourcePlanTests(unittest.TestCase):
    def test_resource_plan_is_persisted_with_the_first_execution_attempt(self) -> None:
        plan = build_spark_resource_plan(
            input_bytes=97_079_116_733,
            input_file_count=1,
            input_size_source="s3_head",
            baseline_executors=1,
            environment={
                "ASKLAKE_SPARK_RESOURCE_PLANNER_MODE": "shadow",
                "ASKLAKE_SPARK_RESOURCE_MAX_EXECUTORS": "6",
            },
        )

        task_states, previous, generation = prepare_eks_spark_attempt(
            {},
            attempt_id="attempt-1",
            lease_generation=1,
            job_id="JOB-1",
            resource_plan=plan,
            run_id="RUN-1",
            started_at="2026-07-20T00:00:00Z",
        )

        self.assertIsNone(previous)
        self.assertEqual(generation, 1)
        self.assertEqual(task_states["sparkExecution"]["resourcePlan"], plan)

    def test_terminal_replacement_keeps_the_same_resource_plan(self) -> None:
        plan = build_spark_resource_plan(
            input_bytes=50_000_000_000,
            input_file_count=1,
            input_size_source="s3_head",
            baseline_executors=1,
            environment={
                "ASKLAKE_SPARK_RESOURCE_PLANNER_MODE": "enforce",
                "ASKLAKE_SPARK_RESOURCE_MAX_EXECUTORS": "6",
            },
        )
        previous_kubernetes = {
            "applicationName": "asklake-run-1",
            "applicationUid": "uid-1",
            "attemptGeneration": 1,
            "imageDigest": f"sha256:{'a' * 64}",
            "jobId": "JOB-1",
            "namespace": "asklake-dev",
            "resourcePlanHash": plan["planHash"],
            "runId": "RUN-1",
            "state": "FAILED",
        }

        task_states, previous, generation = prepare_eks_spark_attempt(
            {
                "sparkExecution": {
                    "kubernetesExecution": previous_kubernetes,
                    "resourcePlan": plan,
                },
            },
            attempt_id="attempt-2",
            lease_generation=2,
            job_id="JOB-1",
            resource_plan=plan,
            run_id="RUN-1",
            started_at="2026-07-20T00:01:00Z",
        )

        self.assertEqual(previous, previous_kubernetes)
        self.assertEqual(generation, 2)
        self.assertEqual(task_states["sparkExecution"]["resourcePlan"], plan)
        self.assertEqual(
            task_states["sparkExecution"]["kubernetesAttempts"],
            [previous_kubernetes],
        )


if __name__ == "__main__":
    unittest.main()
