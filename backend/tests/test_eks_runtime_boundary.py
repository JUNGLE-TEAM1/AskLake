import os
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from fastapi import status
from pydantic import ValidationError

from app.core.auth_context import ActorContext
from app.core.config import Settings
from app.core.errors import ApiError
from app.api import dashboard_live
from app.services import etl_service
from app.services.dashboard_runtime_service import DashboardRuntimeService


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

    def test_external_ec2_rejects_continuous_dataset_freshness_read(self) -> None:
        catalog_repository = Mock()
        catalog_repository.get_dataset_payload.return_value = {"id": "DATASET-CONTINUOUS"}
        live_repository = Mock()
        live_repository.get_freshness.return_value = None
        live_repository.continuous_job_by_dataset.return_value = SimpleNamespace(id="JOB-CONTINUOUS")

        with (
            patch.object(etl_service.settings, "asklake_continuous_control_plane", "external_ec2"),
            patch.object(dashboard_live.CatalogDatasetResponse, "model_validate", return_value=Mock()),
            patch.object(dashboard_live, "dataset_with_persisted_permission_grants", return_value=Mock()),
            patch.object(dashboard_live, "require_dashboard_dataset_query_access"),
        ):
            with self.assertRaises(ApiError) as raised:
                dashboard_live.dataset_freshness_response(
                    Mock(),
                    "DATASET-CONTINUOUS",
                    ActorContext(name="EKS Viewer", role="viewer"),
                    api_path="/api/datasets/DATASET-CONTINUOUS/freshness",
                    http_method="GET",
                    catalog_repository=catalog_repository,
                    live_repository=live_repository,
                )

        self.assertEqual(raised.exception.code, "CONTINUOUS_CONTROL_OWNED_BY_EC2")

    def test_external_ec2_rejects_continuous_dashboard_widget_read(self) -> None:
        live_repository = Mock()
        live_repository.continuous_job_by_dataset.return_value = SimpleNamespace(id="JOB-CONTINUOUS")
        service = DashboardRuntimeService(Mock(), Mock(), live_repository)
        widget = SimpleNamespace(dataset_id="DATASET-CONTINUOUS")

        with patch.object(etl_service.settings, "asklake_continuous_control_plane", "external_ec2"):
            with self.assertRaises(ApiError) as raised:
                service._widget_to_schema(
                    widget,
                    {},
                    {},
                    {},
                    {},
                    actor=ActorContext(name="EKS Viewer", role="viewer"),
                    remote_budget=Mock(),
                    api_path="/api/dashboards/DASH/widgets/query",
                    http_method="POST",
                )

        self.assertEqual(raised.exception.code, "CONTINUOUS_CONTROL_OWNED_BY_EC2")


class EksSparkRunnerBoundaryTests(unittest.TestCase):
    def test_kubernetes_runner_uses_the_node_bridge_provider(self) -> None:
        job = SimpleNamespace(
            dataset_id="DATASET-1",
            iceberg_target={},
            partition_columns=[],
            source_config=[],
            source_type="File / S3",
            storage_path="s3://bucket/input.jsonl",
            target="target",
        )
        expected = {"runId": "RUN-EKS", "status": "success"}
        with (
            patch.dict(os.environ, {"ASKLAKE_SPARK_RUNNER": "kubernetes"}, clear=True),
            patch.object(etl_service, "ensure_batch_iceberg_target") as ensure_target,
            patch.object(etl_service, "source_incremental_window", return_value=(None, None)),
            patch.object(etl_service, "source_uses_incremental_folder_window", return_value=False),
            patch.object(etl_service, "incremental_source_object_inventory", return_value=None),
            patch.object(etl_service, "is_internal_data_lake_source", return_value=False),
            patch.object(etl_service, "job_payload_for_spark", return_value={"id": "JOB-EKS"}),
            patch.object(etl_service, "run_node_bridge", return_value=expected) as node_bridge,
        ):
            actual = etl_service.run_spark_job(Mock(), job, "run", "RUN-EKS")

        self.assertEqual(actual, expected)
        ensure_target.assert_called_once()
        self.assertEqual(node_bridge.call_args.kwargs["timeout_seconds"], 7260)
        self.assertIsNone(node_bridge.call_args.kwargs["timeout_recovery"])


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
