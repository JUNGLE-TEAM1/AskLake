import os
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from fastapi import status
from pydantic import ValidationError

from app.core.auth_context import ActorContext
from app.core.config import Settings
from app.core.errors import ApiError
from app.services import etl_service


class EksContinuousControlPlaneTests(unittest.TestCase):
    def test_settings_accept_only_local_or_external_ec2(self) -> None:
        configured = Settings(
            asklake_continuous_control_plane="external_ec2",
            _env_file=None,
        )

        self.assertEqual(configured.asklake_continuous_control_plane, "external_ec2")
        with self.assertRaises(ValidationError):
            Settings(asklake_continuous_control_plane="shared", _env_file=None)

    def test_external_ec2_rejects_continuous_command_before_database_access(self) -> None:
        database = Mock()

        with patch.object(
            etl_service.settings,
            "asklake_continuous_control_plane",
            "external_ec2",
        ):
            with self.assertRaises(ApiError) as raised:
                etl_service.command_job(
                    database,
                    "JOB-CONTINUOUS",
                    "startContinuous",
                    ActorContext(name="EKS Admin", role="admin"),
                )

        self.assertEqual(raised.exception.code, "CONTINUOUS_CONTROL_OWNED_BY_EC2")
        self.assertEqual(raised.exception.status_code, status.HTTP_409_CONFLICT)
        database.assert_not_called()

    def test_external_ec2_rejects_continuous_read_before_database_access(self) -> None:
        database = Mock()

        with patch.object(
            etl_service.settings,
            "asklake_continuous_control_plane",
            "external_ec2",
        ):
            with self.assertRaises(ApiError) as raised:
                etl_service.get_kafka_continuous_worker_logs(
                    database,
                    "JOB-CONTINUOUS",
                    ActorContext(name="EKS Viewer", role="viewer"),
                    100,
                )

        self.assertEqual(raised.exception.code, "CONTINUOUS_CONTROL_OWNED_BY_EC2")
        database.assert_not_called()

    def test_external_ec2_hides_continuous_jobs_from_general_list(self) -> None:
        with patch.object(
            etl_service.settings,
            "asklake_continuous_control_plane",
            "external_ec2",
        ):
            self.assertTrue(etl_service.job_visible_in_current_control_plane("snapshot"))
            self.assertFalse(etl_service.job_visible_in_current_control_plane("continuous"))

    def test_external_ec2_rejects_continuous_job_detail_without_refreshing_runtime(self) -> None:
        database = Mock()
        continuous_job = SimpleNamespace(execution_mode="continuous")

        with (
            patch.object(
                etl_service.settings,
                "asklake_continuous_control_plane",
                "external_ec2",
            ),
            patch.object(
                etl_service.etl_repository,
                "get_job",
                return_value=continuous_job,
            ),
            patch.object(etl_service, "refresh_kafka_continuous_runtime") as refresh,
        ):
            with self.assertRaises(ApiError) as raised:
                etl_service.get_job(database, "JOB-CONTINUOUS")

        self.assertEqual(raised.exception.code, "CONTINUOUS_CONTROL_OWNED_BY_EC2")
        refresh.assert_not_called()

    def test_external_ec2_background_sync_returns_without_opening_database(self) -> None:
        with (
            patch.object(
                etl_service.settings,
                "asklake_continuous_control_plane",
                "external_ec2",
            ),
            patch("app.core.database.SessionLocal") as session_factory,
        ):
            etl_service.sync_active_kafka_continuous_runtimes()

        session_factory.assert_not_called()


class EksSparkRunnerBoundaryTests(unittest.TestCase):
    def test_kubernetes_runner_fails_closed_until_provider_is_implemented(self) -> None:
        with (
            patch.dict(os.environ, {"ASKLAKE_SPARK_RUNNER": "kubernetes"}, clear=True),
            patch.object(etl_service, "ensure_batch_iceberg_target") as ensure_target,
            patch.object(etl_service, "run_node_bridge") as node_bridge,
        ):
            with self.assertRaises(ApiError) as raised:
                etl_service.run_spark_job(Mock(), Mock(), "run", "RUN-EKS")

        self.assertEqual(
            raised.exception.code,
            "SPARK_KUBERNETES_PROVIDER_NOT_IMPLEMENTED",
        )
        self.assertEqual(raised.exception.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)
        ensure_target.assert_not_called()
        node_bridge.assert_not_called()


class RunExecutionLeaseTimingTests(unittest.TestCase):
    def test_lease_is_independent_from_two_hour_spark_timeout(self) -> None:
        with patch.dict(
            os.environ,
            {
                "ASKLAKE_SPARK_EXECUTION_LEASE_SECONDS": "60",
                "ASKLAKE_SPARK_RUN_TIMEOUT_SECONDS": "7200",
            },
            clear=True,
        ):
            self.assertEqual(etl_service.spark_execution_lease_seconds(), 60)
            self.assertEqual(etl_service.run_execution_heartbeat_interval_seconds(60), 20.0)

    def test_lease_default_and_bounds_are_stable(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(etl_service.spark_execution_lease_seconds(), 60)
        with patch.dict(
            os.environ,
            {"ASKLAKE_SPARK_EXECUTION_LEASE_SECONDS": "1"},
            clear=True,
        ):
            self.assertEqual(etl_service.spark_execution_lease_seconds(), 10)
        with patch.dict(
            os.environ,
            {"ASKLAKE_SPARK_EXECUTION_LEASE_SECONDS": "99999"},
            clear=True,
        ):
            self.assertEqual(etl_service.spark_execution_lease_seconds(), 3600)


if __name__ == "__main__":
    unittest.main()
