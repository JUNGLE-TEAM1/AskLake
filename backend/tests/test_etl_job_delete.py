from pathlib import Path
from queue import Queue
from tempfile import TemporaryDirectory
import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from sqlalchemy import create_engine, select, text
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import Session, sessionmaker

from app.core.auth_context import ActorContext
from app.core.errors import ApiError
from app.repositories import etl_repository
from app.models import (
    AuditEventModel,
    ETLJobModel,
    ETLRunModel,
    KafkaContinuousBatchModel,
    KafkaContinuousMaintenanceRunModel,
    KafkaContinuousRuntimeModel,
    KafkaContinuousSessionModel,
    KafkaSnapshotModel,
    PermissionGrantModel,
    PrincipalControlModel,
    ResourceLockModel,
)
from app.models.base import Base
from app.services.airflow_client import AirflowDagRun
from app.services.etl_service import command_job, delete_job


def delete_fixture_job(job_id: str = "JOB-DELETE-TEST") -> ETLJobModel:
    return ETLJobModel(
        id=job_id,
        name="Delete regression fixture",
        owner="Test Admin",
        status="scheduled",
        tag="test",
        source="unknown",
        target="unknown",
        schedule="manual",
        source_config=[],
        source_label="Unknown source",
        source_type="unknown",
        execution_mode="snapshot",
        schema_columns=[],
        schema_sample_rows=[],
        target_format="parquet",
        target_layer="RAW",
        rag=False,
        transform_output_columns=[],
        transform_steps=[],
        quality_invalid_rows=[],
        quality_rules=[],
        last_run="-",
        last_state="waiting",
        next_run="-",
        stats={},
        dag_steps=[],
    )


def kafka_fixture_job(job_id: str) -> ETLJobModel:
    job = delete_fixture_job(job_id)
    job.source = "Kafka / reviews.raw"
    job.source_label = "reviews.raw"
    job.source_type = "Kafka JSON"
    job.source_config = [
        ["Broker / Endpoint", "kafka.test:9092"],
        ["TOPIC / QUEUE NAME", "reviews.raw"],
        ["CONSUMER GROUP ID", f"asklake-{job_id.lower()}"],
    ]
    job.target = "reviews_bronze"
    job.target_layer = "BRONZE"
    return job


class EtlJobDeleteTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite+pysqlite:///:memory:")
        Base.metadata.create_all(
            self.engine,
            tables=[
                ETLJobModel.__table__,
                ETLRunModel.__table__,
                KafkaSnapshotModel.__table__,
                KafkaContinuousRuntimeModel.__table__,
                KafkaContinuousSessionModel.__table__,
                KafkaContinuousBatchModel.__table__,
                KafkaContinuousMaintenanceRunModel.__table__,
                PermissionGrantModel.__table__,
                PrincipalControlModel.__table__,
                ResourceLockModel.__table__,
                AuditEventModel.__table__,
            ],
        )
        self.db = Session(self.engine)

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    def test_delete_removes_job_grants_and_keeps_audit_event(self) -> None:
        job = delete_fixture_job()
        grant = PermissionGrantModel(
            id="grant-delete-test",
            resource_type="etl_job",
            resource_id=job.id,
            principal_type="user",
            principal_id="Test Admin",
            actions=["view", "run", "manage", "delete"],
            source="test",
        )
        self.db.add_all([job, grant])
        self.db.commit()

        with patch("app.repositories.etl_repository.ensure_schema", return_value=None):
            deleted_job_id = delete_job(self.db, job.id, ActorContext(name="Test Admin", role="admin"))

        self.assertEqual(deleted_job_id, job.id)
        self.assertIsNone(self.db.get(ETLJobModel, job.id))
        self.assertIsNone(self.db.get(PermissionGrantModel, grant.id))
        audit_event = self.db.scalar(select(AuditEventModel).where(
            AuditEventModel.action == "etl_job.deleted",
            AuditEventModel.target_id == job.id,
        ))
        self.assertIsNotNone(audit_event)
        self.assertEqual(audit_event.result, "success")

    def test_delete_authorizes_before_disclosing_active_run(self) -> None:
        job = delete_fixture_job("JOB-ACTIVE-PRIVATE")
        self.db.add(job)
        self.db.commit()
        active_run = SimpleNamespace(run_id="secret-run", status="running")

        with (
            patch("app.repositories.etl_repository.ensure_schema", return_value=None),
            patch("app.services.etl_service.etl_repository.list_run_models_for_job", return_value=[active_run]) as list_runs,
            patch("app.services.etl_service.reconcile_stale_continuous_maintenance_runs") as reconcile,
        ):
            with self.assertRaises(ApiError) as raised:
                delete_job(self.db, job.id, ActorContext(name="Unauthorized User", role="viewer"))

        self.assertEqual(raised.exception.status_code, 403)
        self.assertNotIn("secret-run", str(raised.exception.details or ""))
        list_runs.assert_not_called()
        reconcile.assert_not_called()
        self.assertIsNotNone(self.db.get(ETLJobModel, job.id))
        audit_event = self.db.scalar(select(AuditEventModel).where(
            AuditEventModel.action == "etl_job.delete.forbidden",
            AuditEventModel.target_id == job.id,
        ))
        self.assertIsNotNone(audit_event)
        self.assertEqual(audit_event.result, "forbidden")
        self.assertEqual(audit_event.status_code, 403)

    def test_authorized_delete_reports_active_run(self) -> None:
        job = delete_fixture_job("JOB-ACTIVE-AUTHORIZED")
        self.db.add(job)
        self.db.commit()
        active_run = SimpleNamespace(run_id="visible-run", status="running")

        with (
            patch("app.repositories.etl_repository.ensure_schema", return_value=None),
            patch("app.services.etl_service.etl_repository.list_run_models_for_job", return_value=[active_run]) as list_runs,
            patch("app.services.etl_service.reconcile_stale_continuous_maintenance_runs") as reconcile,
        ):
            with self.assertRaises(ApiError) as raised:
                delete_job(self.db, job.id, ActorContext(name="Test Admin", role="admin"))

        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(raised.exception.details, {"runId": "visible-run", "runStatus": "running"})
        list_runs.assert_called_once_with(self.db, job.id)
        reconcile.assert_not_called()
        self.assertIsNotNone(self.db.get(ETLJobModel, job.id))

    def test_postgres_job_lock_compiles_select_for_update(self) -> None:
        db = Mock()
        db.get_bind.return_value.dialect.name = "postgresql"
        db.scalar.return_value = None

        with patch("app.repositories.etl_repository.ensure_schema"):
            self.assertIsNone(etl_repository.get_job_for_update(db, "JOB-LOCK"))

        statement = db.scalar.call_args.args[0]
        compiled_sql = str(statement.compile(dialect=postgresql.dialect()))
        self.assertIn("FOR UPDATE", compiled_sql.upper())
        self.assertIn("etl_jobs.id", compiled_sql)


class BlockingAirflowClient:
    def __init__(self, entered: threading.Event | None = None, release: threading.Event | None = None) -> None:
        self.config = SimpleNamespace(dag_id="asklake_test_dag")
        self.entered = entered
        self.release = release
        self.trigger_count = 0

    def trigger_dag_run(self, *, dag_run_id: str, conf: dict[str, object], note: str) -> AirflowDagRun:
        del note
        self.trigger_count += 1
        if self.entered is not None:
            self.entered.set()
        if self.release is not None and not self.release.wait(timeout=10):
            raise TimeoutError("test did not release the Airflow trigger")
        return AirflowDagRun(
            dag_id=self.config.dag_id,
            dag_run_id=dag_run_id,
            state="queued",
            asklake_status="queued",
            conf=conf,
            raw={},
        )

    def dag_run_url(self, dag_run_id: str) -> str:
        return f"http://airflow.test/{dag_run_id}"


class EtlJobDeleteRunConcurrencyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = TemporaryDirectory()
        database_path = Path(self.temp_dir.name) / "locking.db"
        self.engine = create_engine(
            f"sqlite+pysqlite:///{database_path.as_posix()}",
            connect_args={"check_same_thread": False, "timeout": 10},
        )
        Base.metadata.create_all(
            self.engine,
            tables=[
                ETLJobModel.__table__,
                ETLRunModel.__table__,
                KafkaSnapshotModel.__table__,
                KafkaContinuousRuntimeModel.__table__,
                KafkaContinuousSessionModel.__table__,
                KafkaContinuousBatchModel.__table__,
                KafkaContinuousMaintenanceRunModel.__table__,
                PermissionGrantModel.__table__,
                PrincipalControlModel.__table__,
                ResourceLockModel.__table__,
                AuditEventModel.__table__,
            ],
        )
        with self.engine.begin() as connection:
            connection.execute(text("PRAGMA journal_mode=WAL"))
        self.session_factory = sessionmaker(bind=self.engine, expire_on_commit=False)

    def tearDown(self) -> None:
        self.engine.dispose()
        self.temp_dir.cleanup()

    def insert_job(self, job_id: str) -> None:
        with self.session_factory() as db:
            db.add(delete_fixture_job(job_id))
            db.commit()

    def insert_kafka_job(self, job_id: str) -> None:
        with self.session_factory() as db:
            db.add(kafka_fixture_job(job_id))
            db.commit()

    def test_delete_waits_for_airflow_start_then_observes_persisted_run(self) -> None:
        job_id = "JOB-SQLITE-RUN-WINS"
        self.insert_job(job_id)
        trigger_entered = threading.Event()
        release_trigger = threading.Event()
        airflow = BlockingAirflowClient(trigger_entered, release_trigger)
        run_results: Queue = Queue()
        delete_results: Queue = Queue()

        def start_run() -> None:
            try:
                with self.session_factory() as db:
                    run_results.put(command_job(db, job_id, "run", ActorContext(name="Test Admin", role="admin")))
            except BaseException as exc:
                run_results.put(exc)

        def delete() -> None:
            try:
                with self.session_factory() as db:
                    delete_results.put(delete_job(db, job_id, ActorContext(name="Test Admin", role="admin")))
            except BaseException as exc:
                delete_results.put(exc)

        with (
            patch("app.repositories.etl_repository.ensure_schema", return_value=None),
            patch("app.services.etl_service.build_airflow_client", return_value=airflow),
        ):
            run_thread = threading.Thread(target=start_run, name="run-owner")
            run_thread.start()
            self.assertTrue(trigger_entered.wait(timeout=5))

            delete_thread = threading.Thread(target=delete, name="delete-waiter")
            delete_thread.start()
            time.sleep(0.2)
            self.assertTrue(delete_thread.is_alive(), "delete should wait on the SQLite writer lock")

            release_trigger.set()
            run_thread.join(timeout=10)
            delete_thread.join(timeout=10)

        self.assertFalse(run_thread.is_alive())
        self.assertFalse(delete_thread.is_alive())
        run_result = run_results.get_nowait()
        delete_result = delete_results.get_nowait()
        self.assertFalse(isinstance(run_result, BaseException), run_result)
        self.assertIsInstance(delete_result, ApiError)
        self.assertEqual(delete_result.status_code, 409)
        self.assertEqual(airflow.trigger_count, 1)
        with self.session_factory() as db:
            self.assertIsNotNone(db.get(ETLJobModel, job_id))
            self.assertEqual(
                len(list(db.scalars(select(ETLRunModel).where(ETLRunModel.job_id == job_id)))),
                1,
            )

    def test_airflow_start_waits_for_delete_and_never_triggers_deleted_job(self) -> None:
        job_id = "JOB-SQLITE-DELETE-WINS"
        self.insert_job(job_id)
        delete_holds_lock = threading.Event()
        release_delete = threading.Event()
        airflow = BlockingAirflowClient()
        run_results: Queue = Queue()
        delete_results: Queue = Queue()
        original_list_runs = etl_repository.list_run_models_for_job

        def blocking_list_runs(db: Session, requested_job_id: str):
            if threading.current_thread().name == "delete-owner":
                delete_holds_lock.set()
                if not release_delete.wait(timeout=10):
                    raise TimeoutError("test did not release delete")
            return original_list_runs(db, requested_job_id)

        def delete() -> None:
            try:
                with self.session_factory() as db:
                    delete_results.put(delete_job(db, job_id, ActorContext(name="Test Admin", role="admin")))
            except BaseException as exc:
                delete_results.put(exc)

        def start_run() -> None:
            try:
                with self.session_factory() as db:
                    run_results.put(command_job(db, job_id, "run", ActorContext(name="Test Admin", role="admin")))
            except BaseException as exc:
                run_results.put(exc)

        with (
            patch("app.repositories.etl_repository.ensure_schema", return_value=None),
            patch("app.services.etl_service.build_airflow_client", return_value=airflow),
            patch("app.services.etl_service.etl_repository.list_run_models_for_job", side_effect=blocking_list_runs),
        ):
            delete_thread = threading.Thread(target=delete, name="delete-owner")
            delete_thread.start()
            self.assertTrue(delete_holds_lock.wait(timeout=5))

            run_thread = threading.Thread(target=start_run, name="run-waiter")
            run_thread.start()
            time.sleep(0.2)
            self.assertEqual(airflow.trigger_count, 0)
            self.assertTrue(run_thread.is_alive(), "run should wait on the SQLite writer lock")

            release_delete.set()
            delete_thread.join(timeout=10)
            run_thread.join(timeout=10)

        self.assertFalse(delete_thread.is_alive())
        self.assertFalse(run_thread.is_alive())
        self.assertEqual(delete_results.get_nowait(), job_id)
        run_result = run_results.get_nowait()
        self.assertIsInstance(run_result, ApiError)
        self.assertEqual(run_result.status_code, 404)
        self.assertEqual(airflow.trigger_count, 0)
        with self.session_factory() as db:
            self.assertIsNone(db.get(ETLJobModel, job_id))

    def test_delete_observes_kafka_reservation_while_external_ingest_runs(self) -> None:
        job_id = "JOB-SQLITE-KAFKA-RUN-WINS"
        self.insert_kafka_job(job_id)
        ingest_entered = threading.Event()
        release_ingest = threading.Event()
        ingest_calls = Mock()
        run_results: Queue = Queue()
        delete_results: Queue = Queue()

        def blocking_ingest(_db, request, command, requested_job_id):
            ingest_calls(request["runId"], command, requested_job_id)
            ingest_entered.set()
            if not release_ingest.wait(timeout=10):
                raise TimeoutError("test did not release Kafka ingest")
            return {
                "consumedCount": 4,
                "endedAt": "2026-07-12T11:00:01Z",
                "failedCount": 0,
                "runId": request["runId"],
                "snapshot": {"snapshotId": "snapshot-reserved"},
                "startedAt": "2026-07-12T11:00:00Z",
                "status": "success",
                "storageLocation": "s3a://asklake-output/reviews/run-1",
                "storedCount": 4,
                "topic": "reviews.raw",
            }

        def start_run() -> None:
            try:
                with self.session_factory() as db:
                    run_results.put(command_job(db, job_id, "run", ActorContext(name="Test Admin", role="admin")))
            except BaseException as exc:
                run_results.put(exc)

        def delete() -> None:
            try:
                with self.session_factory() as db:
                    delete_results.put(delete_job(db, job_id, ActorContext(name="Test Admin", role="admin")))
            except BaseException as exc:
                delete_results.put(exc)

        with (
            patch("app.repositories.etl_repository.ensure_schema", return_value=None),
            patch("app.services.etl_service.run_kafka_ingest_request", side_effect=blocking_ingest),
        ):
            run_thread = threading.Thread(target=start_run, name="kafka-run-owner")
            run_thread.start()
            self.assertTrue(ingest_entered.wait(timeout=5))

            with self.session_factory() as db:
                reserved_runs = list(db.scalars(select(ETLRunModel).where(ETLRunModel.job_id == job_id)))
                self.assertEqual(len(reserved_runs), 1)
                self.assertEqual(reserved_runs[0].status, "running")
                self.assertEqual(db.get(ETLJobModel, job_id).status, "running")

            delete_thread = threading.Thread(target=delete, name="kafka-delete-waiter")
            delete_thread.start()
            delete_thread.join(timeout=5)
            self.assertFalse(delete_thread.is_alive(), "delete should reject the committed Kafka reservation")
            delete_result = delete_results.get_nowait()
            self.assertIsInstance(delete_result, ApiError)
            self.assertEqual(delete_result.status_code, 409)

            release_ingest.set()
            run_thread.join(timeout=10)

        self.assertFalse(run_thread.is_alive())
        run_result = run_results.get_nowait()
        self.assertFalse(isinstance(run_result, BaseException), run_result)
        ingest_calls.assert_called_once()
        with self.session_factory() as db:
            runs = list(db.scalars(select(ETLRunModel).where(ETLRunModel.job_id == job_id)))
            self.assertEqual(len(runs), 1)
            self.assertEqual(runs[0].status, "success")
            self.assertEqual(db.get(ETLJobModel, job_id).status, "scheduled")

    def test_kafka_start_waits_for_delete_and_never_calls_external_ingest(self) -> None:
        job_id = "JOB-SQLITE-KAFKA-DELETE-WINS"
        self.insert_kafka_job(job_id)
        delete_holds_lock = threading.Event()
        release_delete = threading.Event()
        run_results: Queue = Queue()
        delete_results: Queue = Queue()
        ingest = Mock()
        original_list_runs = etl_repository.list_run_models_for_job

        def blocking_list_runs(db: Session, requested_job_id: str):
            if threading.current_thread().name == "kafka-delete-owner":
                delete_holds_lock.set()
                if not release_delete.wait(timeout=10):
                    raise TimeoutError("test did not release Kafka delete")
            return original_list_runs(db, requested_job_id)

        def delete() -> None:
            try:
                with self.session_factory() as db:
                    delete_results.put(delete_job(db, job_id, ActorContext(name="Test Admin", role="admin")))
            except BaseException as exc:
                delete_results.put(exc)

        def start_run() -> None:
            try:
                with self.session_factory() as db:
                    run_results.put(command_job(db, job_id, "run", ActorContext(name="Test Admin", role="admin")))
            except BaseException as exc:
                run_results.put(exc)

        with (
            patch("app.repositories.etl_repository.ensure_schema", return_value=None),
            patch("app.services.etl_service.run_kafka_ingest_request", ingest),
            patch("app.services.etl_service.etl_repository.list_run_models_for_job", side_effect=blocking_list_runs),
        ):
            delete_thread = threading.Thread(target=delete, name="kafka-delete-owner")
            delete_thread.start()
            self.assertTrue(delete_holds_lock.wait(timeout=5))

            run_thread = threading.Thread(target=start_run, name="kafka-run-waiter")
            run_thread.start()
            time.sleep(0.2)
            ingest.assert_not_called()
            self.assertTrue(run_thread.is_alive())

            release_delete.set()
            delete_thread.join(timeout=10)
            run_thread.join(timeout=10)

        self.assertEqual(delete_results.get_nowait(), job_id)
        run_result = run_results.get_nowait()
        self.assertIsInstance(run_result, ApiError)
        self.assertEqual(run_result.status_code, 404)
        ingest.assert_not_called()

    def test_kafka_failure_finalizes_the_committed_reservation_in_place(self) -> None:
        job_id = "JOB-SQLITE-KAFKA-FAILED"
        self.insert_kafka_job(job_id)

        with (
            patch("app.repositories.etl_repository.ensure_schema", return_value=None),
            patch(
                "app.services.etl_service.run_kafka_ingest_request",
                side_effect=RuntimeError("bridge disconnected"),
            ),
        ):
            with self.session_factory() as db:
                response = command_job(db, job_id, "run", ActorContext(name="Test Admin", role="admin"))

        self.assertEqual(response.run.status, "failed")
        with self.session_factory() as db:
            runs = list(db.scalars(select(ETLRunModel).where(ETLRunModel.job_id == job_id)))
            self.assertEqual(len(runs), 1)
            self.assertEqual(runs[0].run_id, response.run.run_id)
            self.assertEqual(runs[0].status, "failed")
            self.assertEqual(db.get(ETLJobModel, job_id).status, "failed")

    def test_kafka_mismatched_response_fails_the_reserved_run(self) -> None:
        job_id = "JOB-SQLITE-KAFKA-MISMATCH"
        self.insert_kafka_job(job_id)
        mismatched_result = {
            "runId": "foreign-run",
            "startedAt": "2026-07-12T11:00:00Z",
            "endedAt": "2026-07-12T11:00:01Z",
            "status": "success",
        }

        with (
            patch("app.repositories.etl_repository.ensure_schema", return_value=None),
            patch("app.services.etl_service.run_kafka_ingest_request", return_value=mismatched_result),
        ):
            with self.session_factory() as db:
                response = command_job(db, job_id, "run", ActorContext(name="Test Admin", role="admin"))

        self.assertEqual(response.run.status, "failed")
        self.assertNotEqual(response.run.run_id, "foreign-run")
        with self.session_factory() as db:
            runs = list(db.scalars(select(ETLRunModel).where(ETLRunModel.job_id == job_id)))
            self.assertEqual(len(runs), 1)
            self.assertEqual(runs[0].run_id, response.run.run_id)
            self.assertEqual(runs[0].status, "failed")
            self.assertIn("does not match", runs[0].error_summary)


if __name__ == "__main__":
    unittest.main()
