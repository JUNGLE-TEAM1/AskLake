import threading
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from fastapi import status

from app.core.errors import ApiError
from app.services import eks_execution_contract as contract


class FakeDatabase:
    def __init__(self) -> None:
        self.bind = object()

    def get_bind(self) -> object:
        return self.bind


class EksControlPlaneContractTests(unittest.TestCase):
    def test_external_and_local_control_plane_visibility(self) -> None:
        with patch.object(contract, "settings", SimpleNamespace(asklake_continuous_control_plane="local")):
            self.assertFalse(contract.external_continuous_control_plane_enabled())
            self.assertTrue(contract.job_visible_in_current_control_plane("continuous"))
            contract.require_local_continuous_control_plane()

        with patch.object(contract, "settings", SimpleNamespace(asklake_continuous_control_plane="external_ec2")):
            self.assertTrue(contract.external_continuous_control_plane_enabled())
            self.assertTrue(contract.job_visible_in_current_control_plane("snapshot"))
            self.assertFalse(contract.job_visible_in_current_control_plane("continuous"))
            with self.assertRaises(ApiError) as raised:
                contract.require_local_continuous_control_plane()

        self.assertEqual(raised.exception.code, "CONTINUOUS_CONTROL_OWNED_BY_EC2")
        self.assertEqual(raised.exception.status_code, status.HTTP_409_CONFLICT)
        self.assertEqual(raised.exception.details, {"controlPlane": "external_ec2"})


class RunExecutionLeaseHeartbeatTests(unittest.TestCase):
    def test_heartbeat_interval_is_bounded(self) -> None:
        self.assertEqual(contract.run_execution_heartbeat_interval_seconds(1), 1.0)
        self.assertEqual(contract.run_execution_heartbeat_interval_seconds(60), 20.0)
        self.assertEqual(contract.run_execution_heartbeat_interval_seconds(3600), 30.0)

    def _heartbeat(self, renew: Mock) -> contract.RunExecutionLeaseHeartbeat:
        lease_session = Mock()
        session_context = Mock()
        session_context.__enter__ = Mock(return_value=lease_session)
        session_context.__exit__ = Mock(return_value=False)
        session_factory = Mock(return_value=session_context)
        patches = (
            patch.object(contract, "sessionmaker", return_value=session_factory),
            patch.object(contract, "run_execution_heartbeat_interval_seconds", return_value=0.001),
            patch.object(contract.etl_repository, "renew_run_execution_lease", renew),
        )
        for active_patch in patches:
            active_patch.start()
            self.addCleanup(active_patch.stop)
        return contract.RunExecutionLeaseHeartbeat(
            FakeDatabase(),
            run_id="RUN-LEASE-1",
            generation=2,
            lease_seconds=60,
        )

    def test_successful_renewal_stops_cleanly(self) -> None:
        renewed = threading.Event()

        def renew(*_args, **_kwargs) -> bool:
            renewed.set()
            return True

        heartbeat = self._heartbeat(Mock(side_effect=renew))
        heartbeat.start()
        self.assertTrue(renewed.wait(0.5))
        heartbeat.stop()

        self.assertFalse(heartbeat.lost)
        self.assertFalse(heartbeat._thread.is_alive())

    def test_false_renewal_marks_lease_lost(self) -> None:
        attempted = threading.Event()

        def renew(*_args, **_kwargs) -> bool:
            attempted.set()
            return False

        heartbeat = self._heartbeat(Mock(side_effect=renew))
        heartbeat.start()
        self.assertTrue(attempted.wait(0.5))
        heartbeat._thread.join(timeout=0.5)

        self.assertTrue(heartbeat.lost)
        self.assertFalse(heartbeat._thread.is_alive())

    def test_repository_error_marks_lease_lost(self) -> None:
        attempted = threading.Event()

        def renew(*_args, **_kwargs) -> bool:
            attempted.set()
            raise RuntimeError("database unavailable")

        heartbeat = self._heartbeat(Mock(side_effect=renew))
        heartbeat.start()
        self.assertTrue(attempted.wait(0.5))
        heartbeat._thread.join(timeout=0.5)

        self.assertTrue(heartbeat.lost)
        self.assertFalse(heartbeat._thread.is_alive())


class SparkKubernetesExecutionIdentityTests(unittest.TestCase):
    def identity(self, **overrides: object) -> dict[str, object]:
        value: dict[str, object] = {
            "runId": "RUN-1",
            "jobId": "JOB-1",
            "namespace": "asklake-dev",
            "applicationName": "asklake-run-1",
            "applicationUid": "application-uid",
            "imageDigest": "sha256:" + "a" * 64,
            "state": "RUNNING",
        }
        value.update(overrides)
        return value

    def test_normalization_preserves_optional_terminal_fields(self) -> None:
        normalized = contract.normalize_spark_kubernetes_execution(
            self.identity(
                driverPodName="asklake-run-1-driver",
                driverPodPhase="Succeeded",
                driverTerminationReason="Completed",
                driverFinishedAt="2026-07-17T00:00:00Z",
                observedAt="2026-07-17T00:00:01Z",
                driverExitCode=0,
                recovered=True,
                resultMarkerFound=True,
            ),
            job_id="JOB-1",
            run_id="RUN-1",
        )

        self.assertEqual(normalized["driverExitCode"], 0)
        self.assertTrue(normalized["recovered"])
        self.assertTrue(normalized["resultMarkerFound"])
        self.assertEqual(normalized["driverPodPhase"], "Succeeded")

    def test_missing_required_identity_is_rejected(self) -> None:
        value = self.identity()
        value.pop("applicationUid")

        with self.assertRaises(ApiError) as raised:
            contract.normalize_spark_kubernetes_execution(value, job_id="JOB-1", run_id="RUN-1")

        self.assertEqual(raised.exception.code, "SPARK_EXECUTION_IDENTITY_MISMATCH")

    def test_run_and_job_identity_mismatch_is_rejected(self) -> None:
        for job_id, run_id in (("JOB-OTHER", "RUN-1"), ("JOB-1", "RUN-OTHER")):
            with self.subTest(job_id=job_id, run_id=run_id):
                with self.assertRaises(ApiError):
                    contract.normalize_spark_kubernetes_execution(
                        self.identity(),
                        job_id=job_id,
                        run_id=run_id,
                    )

    def test_immutable_identity_drift_is_rejected(self) -> None:
        current = self.identity(driverPodName="driver-original")
        observed = self.identity(driverPodName="driver-replacement")

        with self.assertRaises(ApiError) as raised:
            contract.merge_spark_kubernetes_execution(
                current,
                observed,
                job_id="JOB-1",
                run_id="RUN-1",
            )

        self.assertEqual(raised.exception.code, "SPARK_EXECUTION_IDENTITY_MISMATCH")

    def test_progress_persistence_uses_the_execution_fence(self) -> None:
        database = Mock()
        run = SimpleNamespace(
            job_id="JOB-1",
            task_states={"sparkExecution": {"generation": 3, "status": "running"}},
        )
        with patch.object(contract.etl_repository, "get_run_for_execution_fence", return_value=run) as lookup:
            contract.persist_spark_kubernetes_execution_progress(
                database,
                job_id="JOB-1",
                run_id="RUN-1",
                generation=3,
                progress=self.identity(),
            )

        lookup.assert_called_once_with(
            database,
            "RUN-1",
            owner=contract.FASTAPI_EXECUTION_OWNER,
            generation=3,
        )
        self.assertEqual(
            run.task_states["sparkExecution"]["kubernetesExecution"]["applicationUid"],
            "application-uid",
        )
        database.commit.assert_called_once_with()

    def test_progress_callback_uses_a_separate_session(self) -> None:
        database = FakeDatabase()
        progress_database = Mock()
        session_context = Mock()
        session_context.__enter__ = Mock(return_value=progress_database)
        session_context.__exit__ = Mock(return_value=False)
        session_factory = Mock(return_value=session_context)
        progress = self.identity()

        with (
            patch.object(contract, "sessionmaker", return_value=session_factory) as create_sessions,
            patch.object(contract, "persist_spark_kubernetes_execution_progress") as persist,
        ):
            callback = contract.spark_kubernetes_execution_progress_callback(
                database,
                job_id="JOB-1",
                run_id="RUN-1",
                generation=4,
            )
            callback(progress)

        create_sessions.assert_called_once_with(
            bind=database.bind,
            autoflush=False,
            autocommit=False,
            class_=contract.Session,
        )
        persist.assert_called_once_with(
            progress_database,
            job_id="JOB-1",
            run_id="RUN-1",
            generation=4,
            progress=progress,
        )


if __name__ == "__main__":
    unittest.main()
