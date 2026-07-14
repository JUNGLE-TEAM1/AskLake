from datetime import UTC, datetime, timedelta
from queue import Queue
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

from sqlalchemy import create_engine
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import sessionmaker

from app.core.auth_context import ActorContext
from app.core.errors import ApiError
from app.models.base import Base
from app.models.etl import ETLJobModel, KafkaContinuousRuntimeModel
from app.services.etl_service import (
    command_job,
    execute_kafka_continuous_maintenance,
    reconcile_stale_continuous_maintenance_runs,
)


@compiles(JSONB, "sqlite")
def compile_jsonb_for_sqlite(_type, _compiler, **_kwargs):
    return "JSON"


class ContinuousMaintenanceFencingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(prefix="asklake-continuous-fence-")
        self.engine = create_engine(
            f"sqlite:///{self.temp_dir.name}/fencing.db",
            connect_args={"check_same_thread": False, "timeout": 10},
        )
        Base.metadata.create_all(self.engine)
        self.sessions = sessionmaker(bind=self.engine, expire_on_commit=False)
        self.actor = ActorContext(name="Test Admin", role="admin")
        with self.sessions() as db:
            db.add(ETLJobModel(
                id="JOB-CONTINUOUS-FENCE",
                name="continuous_fence",
                owner="data-team-01",
                source="Stream / Kafka",
                target="reviews_fence",
                schedule="스케줄 없음",
                source_config=[
                    ["Broker / Endpoint", "redpanda:9092"],
                    ["TOPIC / QUEUE NAME", "reviews.fence"],
                    ["Consumer Group ID", "asklake-fence"],
                ],
                source_label="Kafka reviews.fence",
                source_type="Stream / Kafka",
                execution_mode="continuous",
                target_format="parquet",
                target_layer="BRONZE",
                last_run="생성 후 미실행",
                last_state="대기",
                next_run="-",
            ))
            db.add(KafkaContinuousRuntimeModel(
                job_id="JOB-CONTINUOUS-FENCE",
                broker="redpanda:9092",
                topic="reviews.fence",
                consumer_group_id="asklake-fence",
                target_identity="reviews_fence",
                checkpoint_path="s3a://asklake-output/reviews_fence/_checkpoints/job",
                status="stopped",
            ))
            db.commit()

    def tearDown(self) -> None:
        self.engine.dispose()
        self.temp_dir.cleanup()

    def test_worker_start_wins_and_maintenance_is_rejected(self) -> None:
        worker_entered = threading.Event()
        release_worker = threading.Event()
        outcomes: Queue = Queue()

        def start_worker(*_args, **_kwargs):
            worker_entered.set()
            if not release_worker.wait(timeout=10):
                raise TimeoutError("worker release timed out")
            return {"workerAttemptId": "worker-fence-1"}

        def start_request() -> None:
            try:
                with self.sessions() as db:
                    outcomes.put(("worker", command_job(
                        db,
                        "JOB-CONTINUOUS-FENCE",
                        "startContinuous",
                        self.actor,
                    )))
            except BaseException as exc:
                outcomes.put(("worker", exc))

        def maintenance_request() -> None:
            try:
                with self.sessions() as db:
                    outcomes.put(("maintenance", execute_kafka_continuous_maintenance(
                        db,
                        "JOB-CONTINUOUS-FENCE",
                        "quarantine_replay",
                        {},
                        self.actor,
                    )))
            except BaseException as exc:
                outcomes.put(("maintenance", exc))

        with (
            patch("app.repositories.etl_repository.ensure_schema", return_value=None),
            patch("app.services.etl_service.run_kafka_continuous_worker", side_effect=start_worker),
            patch("app.services.etl_service.run_kafka_continuous_maintenance") as maintenance_runner,
        ):
            worker_thread = threading.Thread(target=start_request, name="continuous-worker-owner")
            maintenance_thread = threading.Thread(target=maintenance_request, name="continuous-maintenance-loser")
            worker_thread.start()
            self.assertTrue(worker_entered.wait(timeout=5))
            maintenance_thread.start()
            release_worker.set()
            worker_thread.join(timeout=10)
            maintenance_thread.join(timeout=10)

        self.assertFalse(worker_thread.is_alive())
        self.assertFalse(maintenance_thread.is_alive())
        results = dict(outcomes.get_nowait() for _ in range(2))
        self.assertFalse(isinstance(results["worker"], BaseException), results["worker"])
        self.assertIsInstance(results["maintenance"], ApiError)
        self.assertEqual(results["maintenance"].status_code, 409)
        maintenance_runner.assert_not_called()

    def test_maintenance_start_wins_and_worker_is_rejected(self) -> None:
        maintenance_entered = threading.Event()
        release_maintenance = threading.Event()
        outcomes: Queue = Queue()

        def run_maintenance(*_args, **_kwargs):
            maintenance_entered.set()
            if not release_maintenance.wait(timeout=10):
                raise TimeoutError("maintenance release timed out")
            return {"endedAt": "2026-07-14T00:00:00Z", "storedCount": 0}

        def maintenance_request() -> None:
            try:
                with self.sessions() as db:
                    outcomes.put(("maintenance", execute_kafka_continuous_maintenance(
                        db,
                        "JOB-CONTINUOUS-FENCE",
                        "quarantine_replay",
                        {},
                        self.actor,
                    )))
            except BaseException as exc:
                outcomes.put(("maintenance", exc))

        def start_request() -> None:
            try:
                with self.sessions() as db:
                    outcomes.put(("worker", command_job(
                        db,
                        "JOB-CONTINUOUS-FENCE",
                        "startContinuous",
                        self.actor,
                    )))
            except BaseException as exc:
                outcomes.put(("worker", exc))

        with (
            patch("app.repositories.etl_repository.ensure_schema", return_value=None),
            patch("app.services.etl_service.run_kafka_continuous_maintenance", side_effect=run_maintenance),
            patch("app.services.etl_service.run_kafka_continuous_worker") as worker_runner,
        ):
            maintenance_thread = threading.Thread(target=maintenance_request, name="continuous-maintenance-owner")
            worker_thread = threading.Thread(target=start_request, name="continuous-worker-loser")
            maintenance_thread.start()
            self.assertTrue(maintenance_entered.wait(timeout=5))
            worker_thread.start()
            worker_thread.join(timeout=10)
            release_maintenance.set()
            maintenance_thread.join(timeout=10)

        self.assertFalse(worker_thread.is_alive())
        self.assertFalse(maintenance_thread.is_alive())
        results = dict(outcomes.get_nowait() for _ in range(2))
        self.assertFalse(isinstance(results["maintenance"], BaseException), results["maintenance"])
        self.assertIsInstance(results["worker"], ApiError)
        self.assertEqual(results["worker"].status_code, 409)
        worker_runner.assert_not_called()


class ContinuousMaintenanceLeaseTests(unittest.TestCase):
    def expired_run(self):
        expired = datetime.now(UTC) - timedelta(minutes=5)
        return Mock(
            run_id="continuous-maint-lease",
            status="running",
            started_at=(expired - timedelta(minutes=1)).isoformat().replace("+00:00", "Z"),
            config={"leaseExpiresAt": expired.isoformat().replace("+00:00", "Z")},
            result=None,
            ended_at=None,
            last_error=None,
        )

    def test_live_runner_renews_expired_database_lease(self) -> None:
        run = self.expired_run()
        now = datetime.now(UTC)
        with (
            patch("app.services.etl_service.etl_repository.list_kafka_continuous_maintenance_run_models", return_value=[run]),
            patch("app.services.etl_service.continuous_maintenance_runner_observation", return_value={
                "driverState": "RUNNING",
                "submissionId": "driver-1",
                "terminal": False,
                "updatedAt": now,
            }),
            patch("app.services.etl_service.cleanup_kafka_continuous_maintenance") as cleanup,
            patch("app.services.etl_service.persist_reconciled_maintenance_run") as persist,
        ):
            reconcile_stale_continuous_maintenance_runs(Mock(), "JOB-1")

        self.assertEqual(run.status, "running")
        self.assertEqual(run.config["runnerState"], "RUNNING")
        self.assertGreater(
            datetime.fromisoformat(run.config["leaseExpiresAt"].replace("Z", "+00:00")),
            now,
        )
        cleanup.assert_not_called()
        persist.assert_called_once()

    def test_stale_runner_is_cleaned_once(self) -> None:
        run = self.expired_run()
        with (
            patch("app.services.etl_service.etl_repository.list_kafka_continuous_maintenance_run_models", return_value=[run]),
            patch("app.services.etl_service.continuous_maintenance_runner_observation", return_value=None),
            patch("app.services.etl_service.cleanup_kafka_continuous_maintenance", return_value={"cleaned": True}) as cleanup,
            patch("app.services.etl_service.persist_reconciled_maintenance_run") as persist,
        ):
            reconcile_stale_continuous_maintenance_runs(Mock(), "JOB-1")

        self.assertEqual(run.status, "failed")
        self.assertTrue(run.result["leaseExpired"])
        cleanup.assert_called_once_with(run.run_id)
        persist.assert_called_once()

    def test_terminal_runner_is_reconciled_without_kill(self) -> None:
        run = self.expired_run()
        old = datetime.now(UTC) - timedelta(minutes=5)
        with (
            patch("app.services.etl_service.etl_repository.list_kafka_continuous_maintenance_run_models", return_value=[run]),
            patch("app.services.etl_service.continuous_maintenance_runner_observation", return_value={
                "driverState": "FINISHED",
                "submissionId": "driver-1",
                "terminal": True,
                "updatedAt": old,
            }),
            patch("app.services.etl_service.cleanup_kafka_continuous_maintenance") as cleanup,
            patch("app.services.etl_service.persist_reconciled_maintenance_run") as persist,
        ):
            reconcile_stale_continuous_maintenance_runs(Mock(), "JOB-1")

        self.assertEqual(run.status, "failed")
        self.assertTrue(run.result["cleanupSkipped"])
        self.assertEqual(run.result["runnerState"], "FINISHED")
        cleanup.assert_not_called()
        persist.assert_called_once()


if __name__ == "__main__":
    unittest.main()
