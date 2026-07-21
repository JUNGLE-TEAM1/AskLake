from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from app.application.etl_job_commands import EtlJobDeleteHooks, delete_job
from app.core.auth_context import ActorContext
from app.core.errors import ApiError
from app.models import (
    ETLRunModel,
    KafkaContinuousBatchModel,
    KafkaContinuousMaintenanceRunModel,
    KafkaContinuousRuntimeModel,
    KafkaContinuousSessionModel,
    KafkaSnapshotModel,
    PermissionGrantModel,
    ResourceLockModel,
)
from app.schemas.common import ErrorCode


def _job(job_id: str = "JOB-DELETE") -> SimpleNamespace:
    return SimpleNamespace(id=job_id, name="Delete fixture", owner="owner")


def _repository_patches(job: SimpleNamespace):
    return (
        patch("app.application.etl_job_commands.etl_repository.get_job_for_update", return_value=job),
        patch("app.application.etl_job_commands.etl_repository.list_run_models_for_job", return_value=[]),
        patch("app.application.etl_job_commands.etl_repository.get_kafka_continuous_runtime", return_value=None),
        patch("app.application.etl_job_commands.etl_repository.list_kafka_continuous_sessions", return_value=[]),
        patch(
            "app.application.etl_job_commands.etl_repository.list_kafka_continuous_maintenance_run_models",
            return_value=[],
        ),
        patch(
            "app.application.etl_job_commands._delete_catalog_datasets_produced_by_job",
            return_value=[],
        ),
    )


class EtlJobDeleteCommandTests(unittest.TestCase):
    def test_delete_preserves_not_found_without_running_authorization(self) -> None:
        db = Mock()
        governance = Mock()
        hooks = EtlJobDeleteHooks(
            add_audit_event=Mock(),
            permission_grants_for_job=Mock(return_value=[]),
            reconcile_stale_maintenance_runs=Mock(),
            record_audit_event=Mock(),
            require_governed_access=governance,
            require_permission=Mock(),
        )

        with patch("app.application.etl_job_commands.etl_repository.get_job_for_update", return_value=None):
            with self.assertRaises(ApiError) as raised:
                delete_job(db, "MISSING", ActorContext(name="owner"), hooks=hooks)

        self.assertEqual(raised.exception.status_code, 404)
        governance.assert_not_called()
        db.execute.assert_not_called()

    def test_delete_authorizes_before_workload_checks_and_forbidden_audit(self) -> None:
        db = Mock()
        job = _job("JOB-PRIVATE")
        list_runs = Mock(return_value=[])
        reconcile = Mock()
        record_audit = Mock()
        denied = ApiError(ErrorCode.FORBIDDEN, "denied", 403)
        hooks = EtlJobDeleteHooks(
            add_audit_event=Mock(),
            permission_grants_for_job=Mock(return_value=[]),
            reconcile_stale_maintenance_runs=reconcile,
            record_audit_event=record_audit,
            require_governed_access=Mock(),
            require_permission=Mock(side_effect=denied),
        )

        with (
            patch("app.application.etl_job_commands.etl_repository.get_job_for_update", return_value=job),
            patch("app.application.etl_job_commands.etl_repository.list_run_models_for_job", list_runs),
        ):
            with self.assertRaises(ApiError) as raised:
                delete_job(db, job.id, ActorContext(name="reader"), hooks=hooks)

        self.assertIs(raised.exception, denied)
        list_runs.assert_not_called()
        reconcile.assert_not_called()
        db.execute.assert_not_called()
        record_audit.assert_called_once()
        self.assertEqual(record_audit.call_args.kwargs["action"], "etl_job.delete.forbidden")
        self.assertEqual(record_audit.call_args.kwargs["target_id"], job.id)

    def test_delete_rejects_each_active_workload_with_existing_details(self) -> None:
        cases = [
            (
                "run",
                [SimpleNamespace(run_id="RUN-1", status="running")],
                None,
                [],
                [],
                {"runId": "RUN-1", "runStatus": "running"},
            ),
            (
                "runtime",
                [],
                SimpleNamespace(status="pausing"),
                [],
                [],
                {"runtimeStatus": "pausing"},
            ),
            (
                "session",
                [],
                None,
                [SimpleNamespace(session_id="SESSION-1", status="stopping")],
                [],
                {"sessionId": "SESSION-1", "sessionStatus": "stopping"},
            ),
            (
                "maintenance",
                [],
                None,
                [],
                [SimpleNamespace(run_id="MAINT-1", status="running")],
                {"maintenanceRunId": "MAINT-1", "maintenanceStatus": "running"},
            ),
        ]

        for label, runs, runtime, sessions, maintenance, expected_details in cases:
            with self.subTest(workload=label):
                db = Mock()
                job = _job(f"JOB-{label.upper()}")
                hooks = EtlJobDeleteHooks(
                    add_audit_event=Mock(),
                    permission_grants_for_job=Mock(return_value=[]),
                    reconcile_stale_maintenance_runs=Mock(),
                    record_audit_event=Mock(),
                    require_governed_access=Mock(),
                    require_permission=Mock(),
                )
                with (
                    patch("app.application.etl_job_commands.etl_repository.get_job_for_update", return_value=job),
                    patch("app.application.etl_job_commands.etl_repository.list_run_models_for_job", return_value=runs),
                    patch(
                        "app.application.etl_job_commands.etl_repository.get_kafka_continuous_runtime",
                        return_value=runtime,
                    ),
                    patch(
                        "app.application.etl_job_commands.etl_repository.list_kafka_continuous_sessions",
                        return_value=sessions,
                    ),
                    patch(
                        "app.application.etl_job_commands.etl_repository.list_kafka_continuous_maintenance_run_models",
                        return_value=maintenance,
                    ),
                ):
                    with self.assertRaises(ApiError) as raised:
                        delete_job(db, job.id, ActorContext(name="owner"), hooks=hooks)

                self.assertEqual(raised.exception.status_code, 409)
                self.assertEqual(raised.exception.details, expected_details)
                db.execute.assert_not_called()

    def test_delete_cleans_dependents_audits_and_commits_in_one_transaction(self) -> None:
        db = Mock()
        job = _job()
        events: list[str] = []
        hooks = EtlJobDeleteHooks(
            add_audit_event=lambda *_args, **_kwargs: events.append("audit"),
            permission_grants_for_job=lambda _db, _job: events.append("grants") or [],
            reconcile_stale_maintenance_runs=lambda *_args, **_kwargs: events.append("reconcile"),
            record_audit_event=Mock(),
            require_governed_access=lambda *_args, **_kwargs: events.append("governance"),
            require_permission=lambda *_args, **_kwargs: events.append("permission"),
        )
        repository_patches = _repository_patches(job)

        with (
            repository_patches[0],
            repository_patches[1],
            repository_patches[2],
            repository_patches[3],
            repository_patches[4],
            repository_patches[5],
        ):
            deleted_job_id = delete_job(db, job.id, ActorContext(name="owner"), hooks=hooks)

        self.assertEqual(deleted_job_id, job.id)
        self.assertEqual(events, ["governance", "grants", "permission", "reconcile", "audit"])
        expected_tables = [
            KafkaContinuousBatchModel.__table__.name,
            KafkaContinuousSessionModel.__table__.name,
            KafkaContinuousMaintenanceRunModel.__table__.name,
            KafkaContinuousRuntimeModel.__table__.name,
            ETLRunModel.__table__.name,
            KafkaSnapshotModel.__table__.name,
            PermissionGrantModel.__table__.name,
            ResourceLockModel.__table__.name,
        ]
        statements = [call.args[0] for call in db.execute.call_args_list]
        self.assertEqual([statement.table.name for statement in statements], expected_tables)
        db.delete.assert_called_once_with(job)
        db.commit.assert_called_once_with()
        db.rollback.assert_not_called()

    def test_delete_rolls_back_when_commit_fails(self) -> None:
        db = Mock()
        db.commit.side_effect = RuntimeError("commit failed")
        job = _job("JOB-ROLLBACK")
        add_audit = Mock()
        hooks = EtlJobDeleteHooks(
            add_audit_event=add_audit,
            permission_grants_for_job=Mock(return_value=[]),
            reconcile_stale_maintenance_runs=Mock(),
            record_audit_event=Mock(),
            require_governed_access=Mock(),
            require_permission=Mock(),
        )
        repository_patches = _repository_patches(job)

        with (
            repository_patches[0],
            repository_patches[1],
            repository_patches[2],
            repository_patches[3],
            repository_patches[4],
            repository_patches[5],
        ):
            with self.assertRaisesRegex(RuntimeError, "commit failed"):
                delete_job(db, job.id, ActorContext(name="owner"), hooks=hooks)

        add_audit.assert_called_once()
        db.rollback.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
