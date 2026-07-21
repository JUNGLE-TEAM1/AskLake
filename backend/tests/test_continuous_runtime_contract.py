from types import SimpleNamespace
import unittest

from app.domain.continuous_runtime import (
    ContinuousDesiredState,
    ContinuousErrorStage,
    ContinuousObservedState,
    ContinuousPublicStatus,
    bind_worker_attempt,
    classify_legacy_error,
    command_transition,
    derive_public_status,
    observation_is_current,
    record_runtime_command,
    record_runtime_error,
    record_runtime_observation,
    runtime_contract_projection,
    observed_state_from_evidence,
)
from app.models.etl import KafkaContinuousRuntimeModel
from app.repositories.etl_repository import continuous_runtime_to_schema
from app.services.etl_service import continuous_runtime_from_job, mark_continuous_runtime_failed


class ContinuousCommandPolicyTests(unittest.TestCase):
    def test_all_supported_command_transitions_are_table_driven(self) -> None:
        cases = [
            ("stopped", "startContinuous", True, "running", "starting"),
            ("paused", "resumeContinuous", True, "running", "starting"),
            ("failed", "startContinuous", True, "running", "starting"),
            ("starting", "startContinuous", False, "running", "starting"),
            ("running", "startContinuous", False, "running", "starting"),
            ("stopping", "resumeContinuous", False, "running", "starting"),
            ("starting", "pauseContinuous", True, "paused", "pausing"),
            ("running", "pauseContinuous", True, "paused", "pausing"),
            ("paused", "pauseContinuous", False, "paused", "pausing"),
            ("starting", "stopContinuous", True, "stopped", "stopping"),
            ("running", "stopContinuous", True, "stopped", "stopping"),
            ("pausing", "stopContinuous", True, "stopped", "stopping"),
            ("paused", "stopContinuous", True, "stopped", "stopping"),
            ("failed", "stopContinuous", True, "stopped", "stopping"),
            ("stopping", "stopContinuous", False, "stopped", "stopping"),
            ("stopped", "stopContinuous", False, "stopped", "stopping"),
        ]
        for current, command, allowed, desired, next_status in cases:
            with self.subTest(current=current, command=command):
                decision = command_transition(current, command)
                self.assertEqual(decision.allowed, allowed)
                self.assertEqual(decision.desired_state.value, desired)
                self.assertEqual(decision.next_status.value, next_status)

    def test_duplicate_start_has_a_distinct_rejection_reason(self) -> None:
        for status in ("starting", "running", "pausing", "stopping"):
            with self.subTest(status=status):
                self.assertEqual(command_transition(status, "startContinuous").rejection, "already_active")

    def test_command_revision_increments_and_binds_worker_fence(self) -> None:
        start = command_transition("stopped", "startContinuous")
        metrics = record_runtime_command({}, start)
        metrics = bind_worker_attempt(metrics, "worker-2")
        pause = command_transition("running", "pauseContinuous")
        metrics = record_runtime_command(metrics, pause)

        projection = runtime_contract_projection(metrics, public_status="pausing", legacy_error=None)
        self.assertEqual(projection["desiredState"], "paused")
        self.assertEqual(projection["stateRevision"], 2)
        self.assertEqual(projection["fencingToken"], "worker-2")
        self.assertTrue(observation_is_current(metrics, "worker-2"))
        self.assertFalse(observation_is_current(metrics, "worker-1"))
        self.assertTrue(observation_is_current({}, "legacy-worker"))


class ContinuousObservationPolicyTests(unittest.TestCase):
    def test_not_running_is_a_stopped_observation(self) -> None:
        self.assertEqual(
            observed_state_from_evidence(None, "not_running"),
            ContinuousObservedState.STOPPED,
        )

    def test_public_status_is_derived_from_desired_and_observed_state(self) -> None:
        cases = [
            (ContinuousDesiredState.RUNNING, ContinuousObservedState.STARTING, ContinuousPublicStatus.STARTING),
            (ContinuousDesiredState.RUNNING, ContinuousObservedState.RUNNING, ContinuousPublicStatus.RUNNING),
            (ContinuousDesiredState.PAUSED, ContinuousObservedState.RUNNING, ContinuousPublicStatus.PAUSING),
            (ContinuousDesiredState.PAUSED, ContinuousObservedState.STOPPED, ContinuousPublicStatus.PAUSED),
            (ContinuousDesiredState.STOPPED, ContinuousObservedState.STOPPING, ContinuousPublicStatus.STOPPING),
            (ContinuousDesiredState.STOPPED, ContinuousObservedState.STOPPED, ContinuousPublicStatus.STOPPED),
            (ContinuousDesiredState.RUNNING, ContinuousObservedState.FAILED, ContinuousPublicStatus.FAILED),
        ]
        for desired, observed, expected in cases:
            with self.subTest(desired=desired, observed=observed):
                self.assertEqual(derive_public_status(desired, observed), expected)

    def test_legacy_runtime_hydrates_without_contract_migration(self) -> None:
        runtime = KafkaContinuousRuntimeModel(
            job_id="legacy-job",
            broker="redpanda:9092",
            topic="clicks",
            consumer_group_id="legacy-group",
            target_identity="clicks",
            checkpoint_path="s3a://lake/clicks/_checkpoints/legacy-job",
            status="running",
            metrics={"currentWorkerAttemptId": "legacy-worker"},
            last_error=None,
        )

        schema = continuous_runtime_to_schema(runtime)

        self.assertIsNotNone(schema)
        self.assertEqual(schema.desired_state, "running")
        self.assertEqual(schema.observed_state, "running")
        self.assertEqual(schema.state_revision, 0)
        self.assertEqual(schema.fencing_token, "legacy-worker")
        self.assertIsNone(schema.error_detail)

    def test_new_runtime_starts_with_an_explicit_stopped_contract(self) -> None:
        runtime = continuous_runtime_from_job(SimpleNamespace(
            id="job-new",
            source_config=[
                ["Broker / Endpoint", "redpanda:9092"],
                ["TOPIC / QUEUE NAME", "clicks"],
                ["Consumer Group ID", "clicks-group"],
            ],
            continuous_config={"checkpointPath": "s3a://lake/clicks/_checkpoints/job-new"},
            storage_path="s3a://lake/clicks",
            target_path=None,
            target="clicks",
        ))
        projection = runtime_contract_projection(runtime.metrics, public_status=runtime.status, legacy_error=None)
        self.assertEqual(projection["desiredState"], "stopped")
        self.assertEqual(projection["observedState"], "stopped")
        self.assertEqual(projection["stateRevision"], 0)
        self.assertIs(runtime.metrics["publicationRecoveryPending"], False)

    def test_observation_preserves_revision_and_current_fence(self) -> None:
        metrics = record_runtime_command({}, command_transition("stopped", "startContinuous"))
        metrics = bind_worker_attempt(metrics, "worker-current")
        metrics = record_runtime_observation(
            metrics,
            "running",
            default_public_status="running",
            worker_attempt_id="worker-current",
        )
        projection = runtime_contract_projection(metrics, public_status="running", legacy_error=None)
        self.assertEqual(projection["stateRevision"], 1)
        self.assertEqual(projection["observedState"], "running")
        self.assertEqual(projection["fencingToken"], "worker-current")


class ContinuousErrorContractTests(unittest.TestCase):
    def test_structured_error_is_additive_and_keeps_context(self) -> None:
        metrics = record_runtime_error(
            {},
            stage=ContinuousErrorStage.REPORT,
            code="runtime_report_invalid",
            message="Runtime report is invalid.",
            retryable=True,
            context={"jobId": "job-1"},
        )
        projection = runtime_contract_projection(metrics, public_status="running", legacy_error="legacy")
        detail = projection["errorDetail"]
        self.assertEqual({key: value for key, value in detail.items() if key != "diagnosticId"}, {
            "stage": "report",
            "code": "runtime_report_invalid",
            "message": "Runtime report is invalid.",
            "retryable": True,
            "context": {"jobId": "job-1"},
            "operatorMessage": "Runtime report is invalid.",
            "userMessage": "Runtime report is invalid.",
        })
        self.assertRegex(detail["diagnosticId"], r"^[a-f0-9]{32}$")

    def test_legacy_errors_are_classified_without_rewriting_persisted_rows(self) -> None:
        cases = [
            ("Catalog materialization pending retry: denied", "catalog", "catalog_materialization_pending"),
            ("checkpoint fingerprint mismatch", "checkpoint", "checkpoint_contract_failed"),
            ("runtime report missing", "report", "runtime_report_failed"),
            ("storage path is read-only", "runtime_storage", "runtime_storage_failed"),
            ("worker start failed", "submission", "worker_submission_failed"),
            ("unclassified worker exception", "execution", "continuous_execution_failed"),
        ]
        for message, stage, code in cases:
            with self.subTest(message=message):
                detail = classify_legacy_error(message)
                self.assertEqual(detail.stage.value, stage)
                self.assertEqual(detail.code, code)

    def test_failure_identity_counts_once_and_exposes_stage(self) -> None:
        job = SimpleNamespace(id="job-1", status="running", last_state="", progress={})
        runtime = SimpleNamespace(
            status="running",
            failed_count=0,
            metrics={},
            last_error=None,
        )
        for _ in range(2):
            mark_continuous_runtime_failed(
                job,
                runtime,
                "worker heartbeat expired",
                "worker-1:heartbeat_expired",
                error_stage=ContinuousErrorStage.EXECUTION,
                error_code="worker_heartbeat_expired",
                retryable=True,
            )

        projection = runtime_contract_projection(runtime.metrics, public_status=runtime.status, legacy_error=runtime.last_error)
        self.assertEqual(runtime.failed_count, 1)
        self.assertEqual(projection["observedState"], "failed")
        self.assertEqual(projection["errorDetail"]["stage"], "execution")
        self.assertEqual(projection["errorDetail"]["code"], "worker_heartbeat_expired")


if __name__ == "__main__":
    unittest.main()
