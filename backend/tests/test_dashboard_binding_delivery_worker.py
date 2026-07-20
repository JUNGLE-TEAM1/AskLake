from __future__ import annotations

from types import SimpleNamespace
import unittest
from unittest.mock import patch

from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.models.dashboard_job_binding import DashboardBindingDeliveryModel, DashboardJobBindingModel
from app.models.dashboard_live import DatasetRevisionCommitModel, DatasetFreshnessModel
from app.services import dashboard_binding_delivery_worker as worker


class DashboardBindingDeliveryWorkerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite://")
        # The worker contract only needs these durable metadata tables. The
        # full metadata includes PostgreSQL-only JSONB models, so intentionally
        # keep this unit test portable to SQLite.
        self.engine.connect()
        for table in (
            DashboardJobBindingModel.__table__,
            DashboardBindingDeliveryModel.__table__,
            DatasetFreshnessModel.__table__,
            DatasetRevisionCommitModel.__table__,
        ):
            table.create(self.engine)
        self.session_local = sessionmaker(bind=self.engine)

    def _seed(self) -> None:
        with self.session_local() as db:
            db.add(DashboardJobBindingModel(
                id="binding-1", dashboard_id="dashboard-1", job_id="job-1", job_kind="etl",
                output_dataset_id="dataset-1", mode="managed", enabled=True, created_by="Admin User",
            ))
            db.add(DatasetFreshnessModel(dataset_id="dataset-1", latest_revision=1, next_check_after_ms=1_000))
            db.add(DatasetRevisionCommitModel(
                dataset_id="dataset-1", revision=1, run_id="run-1", storage_location="s3://test/output",
                storage_format="parquet", materialization_mode="snapshot", commit_kind="legacy",
                row_count=1, mutation_type="replace",
            ))
            db.commit()

    def _deliveries(self) -> list[DashboardBindingDeliveryModel]:
        with self.session_local() as db:
            return list(db.scalars(select(DashboardBindingDeliveryModel)).all())

    def test_revision_is_delivered_once_even_when_worker_repeats(self) -> None:
        self._seed()
        with patch.object(worker, "SessionLocal", self.session_local), patch.object(worker, "_calculate_managed_widgets", return_value=[]):
            self.assertEqual(worker.process_dashboard_binding_deliveries(), 1)
            self.assertEqual(worker.process_dashboard_binding_deliveries(), 0)
        deliveries = self._deliveries()
        self.assertEqual(len(deliveries), 1)
        self.assertEqual(deliveries[0].status, "applied")
        self.assertEqual(deliveries[0].applied_revision, 1)
        self.assertEqual(deliveries[0].mutation_type, "replace")

    def test_failure_stays_degraded_until_explicit_retry(self) -> None:
        self._seed()
        failed_widget = SimpleNamespace(data_error="storage unavailable", data_status="error", applied_revision=0)
        with patch.object(worker, "SessionLocal", self.session_local), patch.object(worker, "_calculate_managed_widgets", return_value=[failed_widget]):
            self.assertEqual(worker.process_dashboard_binding_deliveries(), 0)
            self.assertEqual(worker.process_dashboard_binding_deliveries(), 0)
        delivery = self._deliveries()[0]
        self.assertEqual(delivery.status, "degraded")
        self.assertEqual(delivery.attempt_count, 1)

        with self.session_local() as db:
            retry_delivery = db.get(DashboardBindingDeliveryModel, delivery.id)
            assert retry_delivery is not None
            retry_delivery.status = "pending"
            db.commit()
        with patch.object(worker, "SessionLocal", self.session_local), patch.object(worker, "_calculate_managed_widgets", return_value=[]):
            self.assertEqual(worker.process_dashboard_binding_deliveries(), 1)
        self.assertEqual(self._deliveries()[0].status, "applied")

    def test_detached_binding_creates_no_delivery(self) -> None:
        self._seed()
        with self.session_local() as db:
            binding = db.get(DashboardJobBindingModel, "binding-1")
            assert binding is not None
            binding.mode = "detached"
            binding.enabled = False
            db.commit()
        with patch.object(worker, "SessionLocal", self.session_local):
            self.assertEqual(worker.process_dashboard_binding_deliveries(), 0)
        self.assertEqual(self._deliveries(), [])
