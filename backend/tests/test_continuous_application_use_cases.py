from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from app.application import continuous_commands
from app.application import continuous_reconciliation
from app.application.continuous_commands import (
    ContinuousCommandHooks,
    ContinuousCommandRequest,
    execute_continuous_command,
)
from app.application.continuous_reconciliation import (
    ContinuousReconciliationHooks,
    ReconciliationAction,
    ReconciliationCertainty,
    RuntimeEvidence,
    decide_reconciliation,
    reconcile_continuous_runtime,
)
from app.domain.continuous_runtime import command_transition, record_runtime_command
from app.ports.runtime_io import JsonDocument
from app.core.errors import ApiError
from app.ports.runtime_io import JsonDocumentState
from app.infrastructure.runtime_io import CallableKafkaRuntimeGateway


class FakeWorker:
    def __init__(self, events, *, lose_start_response: bool = False) -> None:
        self.events = events
        self.lose_start_response = lose_start_response

    def command(self, _job, _runtime, action, options=None):
        self.events.append(f"worker:{action}:{(options or {}).get('workerAttemptId', '')}")
        if action == "start" and self.lose_start_response:
            raise ApiError("BACKEND_BRIDGE_TIMEOUT", "response lost", 504)
        if action == "status":
            return {"containerState": "running", "workerAttemptId": "attempt-recovered"}
        return {"containerState": "starting", "workerAttemptId": "attempt-1"}


class KafkaRuntimeGatewayCompatibilityTests(unittest.TestCase):
    def test_omits_empty_options_for_legacy_three_argument_handler(self) -> None:
        calls = []
        gateway = CallableKafkaRuntimeGateway(
            lambda job_value, runtime_value, action: calls.append(
                (job_value, runtime_value, action)
            ) or {"containerState": "running"}
        )

        result = gateway.command("job", "runtime", "status")

        self.assertEqual(calls, [("job", "runtime", "status")])
        self.assertEqual(result["containerState"], "running")


def runtime(status="stopped"):
    return SimpleNamespace(
        broker="redpanda:9092",
        checkpoint_path="s3a://lake/checkpoint",
        consumed_count=0,
        consumer_group_id="group-1",
        failed_count=0,
        job_id="job-1",
        last_error=None,
        metrics={},
        quarantined_count=0,
        status=status,
        stored_count=0,
        topic="events",
    )


def job():
    return SimpleNamespace(
        execution_mode="continuous",
        id="job-1",
        last_state=None,
        progress=None,
        status="stopped",
    )


def hooks(worker_kind=None):
    return ContinuousCommandHooks(
        is_kafka_job=lambda _job: True,
        runtime_from_job=lambda _job: runtime(),
        reconcile_stale_maintenance=lambda *_args, **_kwargs: None,
        require_no_active_maintenance=lambda *_args: None,
        reconcile_pending_replay=lambda *_args: None,
        has_pending_replay=lambda *_args: False,
        begin_session=lambda *_args: SimpleNamespace(worker_attempt_id=None),
        persisted_partition_cursors=lambda *_args: [],
        fail_session=lambda *_args: None,
        mark_session_stopping=lambda *_args: None,
        with_permissions=lambda _db, saved, _actor: saved,
        worker_kind=worker_kind or (lambda _job: "spark_structured_streaming"),
    )


class ContinuousCommandUseCaseTests(unittest.TestCase):
    def execute(self, *, lose_start_response=False, dispatch_worker=True, worker_kind=None):
        events = []
        current_runtime = runtime()

        def save(_db, _job, _runtime):
            events.append("save")
            return SimpleNamespace(id="job-1")

        with (
            patch.object(continuous_commands.etl_repository, "lock_kafka_continuous_runtime", return_value=current_runtime),
            patch.object(continuous_commands.etl_repository, "find_conflicting_kafka_continuous_runtime", return_value=None),
            patch.object(continuous_commands.etl_repository, "find_conflicting_kafka_snapshot", return_value=None),
            patch.object(continuous_commands.etl_repository, "save_kafka_continuous_command", side_effect=save),
            patch.object(continuous_commands, "JobCommandResponse", side_effect=lambda **payload: payload),
        ):
            result = execute_continuous_command(
                SimpleNamespace(),
                job(),
                ContinuousCommandRequest(command="startContinuous", job_id="job-1"),
                SimpleNamespace(),
                worker=FakeWorker(events, lose_start_response=lose_start_response),
                hooks=hooks(worker_kind),
                dispatch_worker=dispatch_worker,
            )
        return events, current_runtime, result

    def test_desired_state_is_committed_before_worker_submission(self) -> None:
        events, current_runtime, result = self.execute()

        self.assertEqual(events[0], "save")
        self.assertTrue(events[1].startswith("worker:start:start-"))
        self.assertEqual(events[2], "save")
        self.assertEqual(current_runtime.status, "starting")
        self.assertEqual(result["processing_result"]["runtimeStatus"], "starting")

    def test_lost_start_response_is_reconciled_without_duplicate_submission(self) -> None:
        events, current_runtime, result = self.execute(lose_start_response=True)

        self.assertEqual(events[0], "save")
        self.assertTrue(events[1].startswith("worker:start:start-"))
        self.assertEqual(events[2:], ["worker:status:", "save"])
        self.assertEqual(current_runtime.failed_count, 0)
        self.assertTrue(result["processing_result"]["workerResult"]["submissionRecovered"])

    def test_external_control_plane_persists_intent_without_web_side_effect(self) -> None:
        events, current_runtime, result = self.execute(dispatch_worker=False)

        self.assertEqual(events, ["save", "save"])
        self.assertEqual(current_runtime.status, "starting")
        self.assertTrue(result["processing_result"]["controlPlaneOnly"])
        self.assertTrue(result["processing_result"]["workerResult"]["deferred"])
        contract = current_runtime.metrics["runtimeContract"]
        self.assertEqual(contract["desiredState"], "running")
        self.assertTrue(contract["activeWorkerAttemptId"].startswith("start-"))

    def test_external_v2_control_plane_reports_the_v2_worker_before_dispatch(self) -> None:
        _events, _runtime, result = self.execute(
            dispatch_worker=False,
            worker_kind=lambda _job: "kafka_connect_clickhouse_v2",
        )

        self.assertEqual(
            result["processing_result"]["worker"],
            "kafka_connect_clickhouse_v2",
        )
        self.assertEqual(
            result["processing_result"]["workerResult"]["worker"],
            "kafka_connect_clickhouse_v2",
        )


class ContinuousReconciliationPolicyTests(unittest.TestCase):
    def evidence(self, **updates):
        values = {
            "desired_state": "running",
            "public_status": "starting",
            "container_state": "missing",
            "report_state": JsonDocumentState.MISSING,
            "contract_initialized": True,
        }
        values.update(updates)
        return RuntimeEvidence(**values)

    def test_reboot_with_running_intent_restarts_missing_worker(self) -> None:
        decision = decide_reconciliation(self.evidence())
        self.assertEqual(decision.action, ReconciliationAction.RESTART_WORKER)
        self.assertEqual(decision.certainty, ReconciliationCertainty.UNCERTAIN)

    def test_running_worker_without_report_waits_instead_of_failing(self) -> None:
        decision = decide_reconciliation(self.evidence(container_state="running"))
        self.assertEqual(decision.action, ReconciliationAction.WAIT_FOR_REPORT)

    def test_terminal_command_beats_missing_report(self) -> None:
        decision = decide_reconciliation(self.evidence(
            desired_state="stopped",
            public_status="stopping",
            requested_action="stop",
        ))
        self.assertEqual(decision.action, ReconciliationAction.APPLY_TERMINAL_INTENT)
        self.assertEqual(decision.terminal_status, "stopped")

    def test_new_running_intent_beats_stale_stop_from_previous_worker(self) -> None:
        decision = decide_reconciliation(self.evidence(
            public_status="starting",
            requested_action="stop",
        ))

        self.assertEqual(decision.action, ReconciliationAction.RESTART_WORKER)
        self.assertEqual(decision.certainty, ReconciliationCertainty.UNCERTAIN)

    def test_stale_stop_starts_a_new_worker_for_the_current_running_intent(self) -> None:
        events = []
        current_runtime = runtime(status="starting")
        current_runtime.metrics = record_runtime_command(
            {"currentWorkerAttemptId": "old-attempt"},
            command_transition("stopped", "startContinuous"),
            worker_attempt_id="start-new-intent",
        )
        current_job = job()
        current_job.status = "running"
        current_job.last_state = "Continuous Spark worker 시작 요청"
        current_job.progress = {"label": "Continuous worker 시작 요청", "value": 5}

        reconciliation_hooks = ContinuousReconciliationHooks(
            reconcile_stale_maintenance=lambda *_args, **_kwargs: None,
            reconcile_pending_replay=lambda *_args, **_kwargs: None,
            report_path=lambda _job_id: Path("unused"),
            read_report=lambda _path: JsonDocument(state=JsonDocumentState.MISSING),
            worker_status=lambda _job, _runtime: {
                "containerState": "exited",
                "requestedAction": "stop",
                "workerAttemptId": "old-attempt",
            },
            materialize_batch=lambda *_args, **_kwargs: None,
            sync_session=lambda *_args, **_kwargs: None,
            write_ack=lambda *_args, **_kwargs: None,
            mark_failed=lambda *_args, **_kwargs: None,
            apply_report=lambda *_args, **_kwargs: None,
        )

        with (
            patch.object(
                continuous_reconciliation.etl_repository,
                "get_kafka_continuous_runtime",
                return_value=current_runtime,
            ),
            patch.object(
                continuous_reconciliation.etl_repository,
                "save_kafka_continuous_command",
                side_effect=lambda *_args: events.append("save"),
            ),
        ):
            reconcile_continuous_runtime(
                None,
                current_job,
                worker=FakeWorker(events),
                hooks=reconciliation_hooks,
            )

        self.assertTrue(events[0].startswith("worker:start:start-new-intent"))
        self.assertEqual(events[1:], ["save"])
        self.assertEqual(current_runtime.status, "starting")
        self.assertEqual(current_job.status, "running")
        self.assertEqual(
            current_runtime.metrics["lastReconciliation"]["action"],
            ReconciliationAction.RESTART_WORKER.value,
        )

    def test_old_report_is_ignored_by_worker_fence(self) -> None:
        decision = decide_reconciliation(self.evidence(
            container_state="running",
            report_state=JsonDocumentState.FOUND,
            expected_worker_attempt_id="new",
            observed_worker_attempt_id="old",
        ))
        self.assertEqual(decision.action, ReconciliationAction.IGNORE_STALE_REPORT)

    def test_terminal_stale_report_restarts_the_current_fenced_attempt(self) -> None:
        decision = decide_reconciliation(self.evidence(
            container_state="exited",
            expected_worker_attempt_id="start-current",
            observed_worker_attempt_id="old-attempt",
        ))

        self.assertEqual(decision.action, ReconciliationAction.RESTART_WORKER)
        self.assertEqual(decision.certainty, ReconciliationCertainty.CONFIRMED)

    def test_partial_publication_uses_current_report_for_resume(self) -> None:
        decision = decide_reconciliation(self.evidence(
            container_state="exited",
            report_state=JsonDocumentState.FOUND,
            manifest_present=True,
            catalog_applied=False,
            dashboard_applied=False,
        ))
        self.assertEqual(decision.action, ReconciliationAction.APPLY_REPORT)
        self.assertIn("catalog", decision.reason)
        self.assertIn("dashboard", decision.reason)

    def test_same_evidence_produces_the_same_decision(self) -> None:
        evidence = self.evidence(container_state="running")
        self.assertEqual(decide_reconciliation(evidence), decide_reconciliation(evidence))

    def test_v2_connector_status_becomes_running_without_a_spark_report(self) -> None:
        events = []
        synced = []
        current_runtime = runtime(status="starting")
        current_runtime.metrics = record_runtime_command(
            {},
            command_transition("stopped", "startContinuous"),
            worker_attempt_id="kafka-connect-v2:attempt-1",
        )
        current_job = job()
        current_job.status = "running"

        reconciliation_hooks = ContinuousReconciliationHooks(
            reconcile_stale_maintenance=lambda *_args, **_kwargs: None,
            reconcile_pending_replay=lambda *_args, **_kwargs: None,
            report_path=lambda _job_id: Path("unused"),
            read_report=lambda _path: JsonDocument(state=JsonDocumentState.MISSING),
            worker_status=lambda _job, _runtime: {
                "containerState": "running",
                "worker": "kafka_connect_clickhouse_v2",
                "workerAttemptId": "kafka-connect-v2:attempt-1",
                "consumedCount": 3,
                "storedCount": 3,
                "publicationRevision": 1,
                "clickhouseOffsets": [{"partition": 0, "maxOffset": 2}],
            },
            materialize_batch=lambda *_args, **_kwargs: None,
            sync_session=lambda *_args, **_kwargs: synced.append("sync"),
            write_ack=lambda *_args, **_kwargs: None,
            mark_failed=lambda *_args, **_kwargs: None,
            apply_report=lambda *_args, **_kwargs: self.fail("V2 must not wait for Spark report"),
        )

        with (
            patch.object(
                continuous_reconciliation.etl_repository,
                "get_kafka_continuous_runtime",
                return_value=current_runtime,
            ),
            patch.object(
                continuous_reconciliation.etl_repository,
                "save_kafka_continuous_command",
                side_effect=lambda *_args: events.append("save"),
            ),
        ):
            reconcile_continuous_runtime(
                None,
                current_job,
                worker=FakeWorker(events),
                hooks=reconciliation_hooks,
            )

        self.assertEqual(events, ["save"])
        self.assertEqual(synced, ["sync"])
        self.assertEqual(current_runtime.status, "running")
        self.assertEqual(current_runtime.stored_count, 3)
        self.assertEqual(
            current_runtime.metrics["clickhouseKafkaIngestV2"]["publicationRevision"],
            1,
        )
        self.assertIn("Kafka Connect", current_job.last_state)


if __name__ == "__main__":
    unittest.main()
