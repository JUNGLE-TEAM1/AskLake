from datetime import UTC, datetime
from concurrent.futures import ThreadPoolExecutor
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
from app.services.etl_service import (
    SPARK_EXECUTION_OWNER_ID,
    airflow_submission_error_is_definitive,
    command_job,
    delete_job,
    execute_airflow_spark_run,
    record_airflow_sync_error,
    spark_execution_lease_is_active,
    sync_airflow_run,
)


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
    job.target_format = "jsonl"
    job.target_layer = "BRONZE"
    job.target_format = "jsonl"
    return job


def stopped_continuous_runtime(job_id: str) -> KafkaContinuousRuntimeModel:
    return KafkaContinuousRuntimeModel(
        job_id=job_id,
        broker="kafka.test:9092",
        topic="reviews.raw",
        consumer_group_id=f"asklake-{job_id.lower()}",
        target_identity=f"reviews_bronze:{job_id}",
        checkpoint_path=f"s3a://asklake-output/checkpoints/{job_id}",
        status="stopped",
        metrics={},
        schema_state={},
        consumed_count=0,
        stored_count=0,
        quarantined_count=0,
        failed_count=0,
    )


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

    def test_delete_terminates_stopped_continuous_runtime_before_commit(self) -> None:
        job = kafka_fixture_job("JOB-CONTINUOUS-DELETE")
        job.execution_mode = "continuous"
        runtime = stopped_continuous_runtime(job.id)
        self.db.add_all([job, runtime])
        self.db.commit()

        with (
            patch("app.repositories.etl_repository.ensure_schema", return_value=None),
            patch(
                "app.services.etl_service.run_kafka_continuous_worker",
                return_value={"containerState": "not_running"},
            ) as terminate,
        ):
            deleted_job_id = delete_job(self.db, job.id, ActorContext(name="Test Admin", role="admin"))

        self.assertEqual(deleted_job_id, job.id)
        terminate.assert_called_once()
        terminated_job, terminated_runtime, action = terminate.call_args.args
        self.assertEqual(terminated_job.id, job.id)
        self.assertEqual(terminated_runtime.job_id, job.id)
        self.assertEqual(action, "terminate")
        self.assertIsNone(self.db.get(ETLJobModel, job.id))
        self.assertIsNone(self.db.get(KafkaContinuousRuntimeModel, job.id))

    def test_delete_preserves_continuous_metadata_when_termination_fails(self) -> None:
        job = kafka_fixture_job("JOB-CONTINUOUS-DELETE-FAILED")
        job.execution_mode = "continuous"
        runtime = stopped_continuous_runtime(job.id)
        self.db.add_all([job, runtime])
        self.db.commit()

        with (
            patch("app.repositories.etl_repository.ensure_schema", return_value=None),
            patch(
                "app.services.etl_service.run_kafka_continuous_worker",
                side_effect=RuntimeError("SparkApplication still exists"),
            ),
        ):
            with self.assertRaisesRegex(RuntimeError, "still exists"):
                delete_job(self.db, job.id, ActorContext(name="Test Admin", role="admin"))

        self.assertIsNotNone(self.db.get(ETLJobModel, job.id))
        self.assertIsNotNone(self.db.get(KafkaContinuousRuntimeModel, job.id))

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

    def get_dag_run(self, dag_run_id: str) -> AirflowDagRun:
        return AirflowDagRun(
            dag_id=self.config.dag_id,
            dag_run_id=dag_run_id,
            state="queued",
            asklake_status="queued",
            conf={},
            raw={},
        )

    def list_task_instances(self, dag_run_id: str) -> list:
        del dag_run_id
        return []


class TimeoutAfterAcceptAirflowClient(BlockingAirflowClient):
    def __init__(self) -> None:
        super().__init__()
        self.accepted_run: AirflowDagRun | None = None
        self.lookup_count = 0

    def trigger_dag_run(self, *, dag_run_id: str, conf: dict[str, object], note: str) -> AirflowDagRun:
        del note
        self.trigger_count += 1
        self.accepted_run = AirflowDagRun(
            dag_id=self.config.dag_id,
            dag_run_id=dag_run_id,
            state="queued",
            asklake_status="queued",
            conf=conf,
            raw={},
        )
        raise TimeoutError("response was lost after Airflow accepted the run")

    def get_dag_run(self, dag_run_id: str) -> AirflowDagRun:
        self.lookup_count += 1
        if self.accepted_run is None or self.accepted_run.dag_run_id != dag_run_id:
            raise AssertionError("reserved Airflow run was not found")
        return self.accepted_run


class RejectedAirflowClient(BlockingAirflowClient):
    def trigger_dag_run(self, *, dag_run_id: str, conf: dict[str, object], note: str) -> AirflowDagRun:
        del dag_run_id, conf, note
        self.trigger_count += 1
        raise ApiError(
            "AIRFLOW_API_ERROR",
            "Airflow rejected the request",
            502,
            {"airflowStatus": 401},
        )

    def get_dag_run(self, dag_run_id: str) -> AirflowDagRun:
        del dag_run_id
        raise ApiError(
            "AIRFLOW_API_ERROR",
            "Airflow run does not exist",
            502,
            {"airflowStatus": 404},
        )


class LostResponseAirflowClient(BlockingAirflowClient):
    def trigger_dag_run(self, *, dag_run_id: str, conf: dict[str, object], note: str) -> AirflowDagRun:
        del dag_run_id, conf, note
        self.trigger_count += 1
        if self.entered is not None:
            self.entered.set()
        if self.release is not None and not self.release.wait(timeout=10):
            raise TimeoutError("test did not release the lost Airflow response")
        raise TimeoutError("Airflow accepted the run but the response was lost")

    def get_dag_run(self, dag_run_id: str) -> AirflowDagRun:
        del dag_run_id
        raise ApiError("AIRFLOW_API_UNAVAILABLE", "Airflow lookup is temporarily unavailable", 502)


class MissingTaskInstancesAirflowClient(BlockingAirflowClient):
    def list_task_instances(self, dag_run_id: str) -> list:
        del dag_run_id
        raise ApiError(
            "AIRFLOW_API_ERROR",
            "Task instances were not found",
            502,
            {"airflowStatus": 404},
        )


class EtlJobDeleteRunConcurrencyTests(unittest.TestCase):
    def test_spark_execution_lease_is_scoped_to_current_backend_process(self) -> None:
        started_at = datetime.now(UTC).isoformat()
        self.assertTrue(spark_execution_lease_is_active({
            "ownerId": SPARK_EXECUTION_OWNER_ID,
            "startedAt": started_at,
            "status": "running",
        }))
        self.assertFalse(spark_execution_lease_is_active({
            "ownerId": "stopped-backend-process",
            "startedAt": started_at,
            "status": "running",
        }))
        self.assertFalse(spark_execution_lease_is_active({
            "startedAt": started_at,
            "status": "running",
        }))

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

    def insert_airflow_run(self, job_id: str, run_id: str) -> None:
        with self.session_factory() as db:
            db.add(ETLRunModel(
                run_id=run_id,
                job_id=job_id,
                status="queued",
                started_at="2026-07-12T11:00:00Z",
                ended_at="-",
                duration="-",
                input_rows="-",
                output_rows="-",
                output_path="s3a://asklake-output/test",
                failed_stage="-",
                error_summary="-",
                airflow_dag_id="asklake_test_dag",
                airflow_dag_run_id=run_id,
                airflow_state="queued",
                task_states={},
            ))
            db.commit()

    def test_delete_observes_airflow_reservation_while_external_trigger_runs(self) -> None:
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
            delete_thread.join(timeout=5)
            self.assertFalse(delete_thread.is_alive(), "delete should reject the committed Airflow reservation")
            delete_result = delete_results.get_nowait()
            self.assertIsInstance(delete_result, ApiError)
            self.assertEqual(delete_result.status_code, 409)

            release_trigger.set()
            run_thread.join(timeout=10)

        self.assertFalse(run_thread.is_alive())
        run_result = run_results.get_nowait()
        self.assertFalse(isinstance(run_result, BaseException), run_result)
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

    def test_airflow_timeout_after_accept_reconciles_the_reserved_run(self) -> None:
        job_id = "JOB-SQLITE-AIRFLOW-TIMEOUT"
        self.insert_job(job_id)
        airflow = TimeoutAfterAcceptAirflowClient()

        with (
            patch("app.repositories.etl_repository.ensure_schema", return_value=None),
            patch("app.services.etl_service.build_airflow_client", return_value=airflow),
        ):
            with self.session_factory() as db:
                response = command_job(db, job_id, "run", ActorContext(name="Test Admin", role="admin"))
            with self.session_factory() as db:
                with self.assertRaises(ApiError) as duplicate:
                    command_job(db, job_id, "retry", ActorContext(name="Test Admin", role="admin"))

        self.assertEqual(response.run.status, "queued")
        self.assertEqual(duplicate.exception.status_code, 409)
        self.assertEqual(airflow.trigger_count, 1)
        self.assertEqual(airflow.lookup_count, 1)
        with self.session_factory() as db:
            runs = list(db.scalars(select(ETLRunModel).where(ETLRunModel.job_id == job_id)))
            self.assertEqual(len(runs), 1)
            self.assertEqual(runs[0].run_id, response.run.run_id)
            self.assertEqual(runs[0].airflow_dag_run_id, response.run.run_id)

    def test_definitive_airflow_rejection_fails_the_reserved_run(self) -> None:
        job_id = "JOB-SQLITE-AIRFLOW-REJECTED"
        self.insert_job(job_id)
        airflow = RejectedAirflowClient()

        with (
            patch("app.repositories.etl_repository.ensure_schema", return_value=None),
            patch("app.services.etl_service.build_airflow_client", return_value=airflow),
        ):
            with self.session_factory() as db:
                response = command_job(db, job_id, "run", ActorContext(name="Test Admin", role="admin"))

        self.assertEqual(response.run.status, "failed")
        self.assertEqual(response.run.failed_stage, "Airflow submission")
        with self.session_factory() as db:
            self.assertEqual(db.get(ETLJobModel, job_id).status, "failed")

    def test_repeated_authoritative_airflow_404_terminates_reservation(self) -> None:
        job_id = "JOB-SQLITE-AIRFLOW-MISSING"
        run_id = "RUN-SQLITE-AIRFLOW-MISSING"
        self.insert_job(job_id)
        self.insert_airflow_run(job_id, run_id)
        missing = ApiError(
            "AIRFLOW_API_ERROR",
            "Airflow DAG Run was not found",
            502,
            {"airflowStatus": 404},
        )

        with self.session_factory() as db:
            run = db.get(ETLRunModel, run_id)
            record_airflow_sync_error(run, missing, "2026-07-12T11:01:00Z")
            record_airflow_sync_error(run, missing, "2026-07-12T11:02:00Z")
            self.assertEqual(run.status, "queued")
            record_airflow_sync_error(run, missing, "2026-07-12T11:03:00Z")
            self.assertEqual(run.status, "failed")
            self.assertEqual(run.failed_stage, "Airflow submission")
            self.assertEqual(run.task_states["airflowReservation"]["missingCount"], 3)

    def test_airflow_submit_finalization_preserves_worker_completion(self) -> None:
        job_id = "JOB-SQLITE-AIRFLOW-WORKER-WINS"
        self.insert_job(job_id)
        trigger_entered = threading.Event()
        release_trigger = threading.Event()
        airflow = BlockingAirflowClient(trigger_entered, release_trigger)
        command_result: Queue = Queue()

        def start_run() -> None:
            try:
                with self.session_factory() as db:
                    command_result.put(command_job(db, job_id, "run", ActorContext(name="Test Admin", role="admin")))
            except BaseException as exc:
                command_result.put(exc)

        with (
            patch("app.repositories.etl_repository.ensure_schema", return_value=None),
            patch("app.services.etl_service.build_airflow_client", return_value=airflow),
        ):
            command_thread = threading.Thread(target=start_run, name="airflow-command-finalizer")
            command_thread.start()
            self.assertTrue(trigger_entered.wait(timeout=5))
            with self.session_factory() as db:
                run = db.scalar(select(ETLRunModel).where(ETLRunModel.job_id == job_id))
                self.assertIsNotNone(run)
                run.status = "success"
                run.airflow_state = "success"
                run.output_path = "s3a://asklake-output/test/worker-complete"
                run.output_rows = "7 rows"
                run.task_states = {
                    "sparkResult": {"status": "success", "outputRows": 7},
                    "catalogResult": {"status": "success", "datasetId": "dataset-1"},
                }
                db.commit()
            release_trigger.set()
            command_thread.join(timeout=10)

        self.assertFalse(command_thread.is_alive())
        response = command_result.get_nowait()
        self.assertFalse(isinstance(response, BaseException), response)
        self.assertEqual(response.run.status, "success")
        with self.session_factory() as db:
            run = db.get(ETLRunModel, response.run.run_id)
            self.assertEqual(run.status, "success")
            self.assertEqual(run.output_rows, "7 rows")
            self.assertEqual(run.output_path, "s3a://asklake-output/test/worker-complete")
            self.assertEqual(run.task_states["sparkResult"]["status"], "success")
            self.assertEqual(run.task_states["catalogResult"]["status"], "success")

    def test_lost_airflow_submit_response_preserves_worker_completion(self) -> None:
        job_id = "JOB-SQLITE-AIRFLOW-LOST-RESPONSE"
        self.insert_job(job_id)
        trigger_entered = threading.Event()
        release_trigger = threading.Event()
        airflow = LostResponseAirflowClient(trigger_entered, release_trigger)
        command_result: Queue = Queue()

        def start_run() -> None:
            try:
                with self.session_factory() as db:
                    command_result.put(command_job(db, job_id, "run", ActorContext(name="Test Admin", role="admin")))
            except BaseException as exc:
                command_result.put(exc)

        with (
            patch("app.repositories.etl_repository.ensure_schema", return_value=None),
            patch("app.services.etl_service.build_airflow_client", return_value=airflow),
        ):
            command_thread = threading.Thread(target=start_run, name="airflow-lost-response")
            command_thread.start()
            self.assertTrue(trigger_entered.wait(timeout=5))
            with self.session_factory() as db:
                run = db.scalar(select(ETLRunModel).where(ETLRunModel.job_id == job_id))
                run.status = "success"
                run.airflow_state = "success"
                run.output_rows = "9 rows"
                run.task_states = {"sparkResult": {"status": "success"}}
                db.commit()
            release_trigger.set()
            command_thread.join(timeout=10)

        response = command_result.get_nowait()
        self.assertFalse(isinstance(response, BaseException), response)
        self.assertEqual(response.run.status, "success")
        with self.session_factory() as db:
            run = db.get(ETLRunModel, response.run.run_id)
            self.assertEqual(run.status, "success")
            self.assertEqual(run.output_rows, "9 rows")
            self.assertEqual(run.task_states["sparkResult"]["status"], "success")

    def test_airflow_sync_preserves_active_spark_execution_lease(self) -> None:
        job_id = "JOB-SQLITE-AIRFLOW-SYNC-LEASE"
        run_id = "RUN-SQLITE-AIRFLOW-SYNC-LEASE"
        self.insert_job(job_id)
        self.insert_airflow_run(job_id, run_id)
        with self.session_factory() as db:
            run = db.get(ETLRunModel, run_id)
            run.task_states = {
                "sparkExecution": {
                    "attemptId": "attempt-1",
                    "startedAt": "2026-07-12T11:00:00Z",
                    "status": "running",
                },
            }
            db.commit()

        with (
            patch("app.repositories.etl_repository.ensure_schema", return_value=None),
            self.session_factory() as db,
        ):
            sync_airflow_run(
                db,
                db.get(ETLJobModel, job_id),
                db.get(ETLRunModel, run_id),
                BlockingAirflowClient(),
            )

        with self.session_factory() as db:
            run = db.get(ETLRunModel, run_id)
            self.assertEqual(run.task_states["sparkExecution"]["attemptId"], "attempt-1")
            self.assertEqual(run.task_states["sparkExecution"]["status"], "running")

    def test_task_instance_404_does_not_mark_dag_run_missing(self) -> None:
        job_id = "JOB-SQLITE-AIRFLOW-TASKS-MISSING"
        run_id = "RUN-SQLITE-AIRFLOW-TASKS-MISSING"
        self.insert_job(job_id)
        self.insert_airflow_run(job_id, run_id)
        client = MissingTaskInstancesAirflowClient()

        with patch("app.repositories.etl_repository.ensure_schema", return_value=None):
            for _ in range(3):
                with self.session_factory() as db:
                    sync_airflow_run(
                        db,
                        db.get(ETLJobModel, job_id),
                        db.get(ETLRunModel, run_id),
                        client,
                    )

        with self.session_factory() as db:
            run = db.get(ETLRunModel, run_id)
            self.assertEqual(run.status, "queued")
            self.assertNotIn("missingCount", (run.task_states or {}).get("airflowReservation", {}))

    def test_bad_airflow_response_is_not_a_definitive_rejection(self) -> None:
        self.assertFalse(airflow_submission_error_is_definitive(ApiError(
            "AIRFLOW_BAD_RESPONSE",
            "Airflow returned malformed JSON",
            502,
        )))

    def test_duplicate_airflow_spark_request_is_blocked_by_run_lease(self) -> None:
        job_id = "JOB-SQLITE-SPARK-LEASE"
        run_id = "RUN-SQLITE-SPARK-LEASE"
        self.insert_job(job_id)
        self.insert_airflow_run(job_id, run_id)
        spark_entered = threading.Event()
        release_spark = threading.Event()
        spark_calls = Mock()
        first_result: Queue = Queue()

        prepared_job = {
            "command": "run",
            "runId": run_id,
        }

        def prepare_spark(_db, _job, command, requested_run_id):
            self.assertEqual(command, "run")
            self.assertEqual(requested_run_id, run_id)
            return prepared_job

        def blocking_spark(prepared):
            self.assertIs(prepared, prepared_job)
            command = str(prepared["command"])
            requested_run_id = str(prepared["runId"])
            spark_calls(command, requested_run_id)
            spark_entered.set()
            if not release_spark.wait(timeout=10):
                raise TimeoutError("test did not release Spark")
            return {
                "endedAt": "2026-07-12T11:00:02Z",
                "inputRows": 2,
                "outputPath": f"s3a://asklake-output/test/{requested_run_id}",
                "outputRows": 2,
                "runId": requested_run_id,
                "startedAt": "2026-07-12T11:00:00Z",
                "status": "success",
            }

        def first_request() -> None:
            try:
                with self.session_factory() as db:
                    first_result.put(execute_airflow_spark_run(
                        db,
                        job_id=job_id,
                        run_id=run_id,
                        command="run",
                    ))
            except BaseException as exc:
                first_result.put(exc)

        with (
            patch("app.repositories.etl_repository.ensure_schema", return_value=None),
            patch("app.services.etl_service.prepare_spark_job", side_effect=prepare_spark),
            patch("app.services.etl_service.run_prepared_spark_job", side_effect=blocking_spark),
        ):
            first_thread = threading.Thread(target=first_request, name="spark-lease-owner")
            first_thread.start()
            self.assertTrue(spark_entered.wait(timeout=5))
            self.assertEqual(
                self.engine.pool.checkedout(),
                0,
                "The Spark wait must not keep a pooled database connection checked out.",
            )
            with self.session_factory() as db:
                with self.assertRaises(ApiError) as duplicate:
                    execute_airflow_spark_run(db, job_id=job_id, run_id=run_id, command="run")
            self.assertEqual(duplicate.exception.status_code, 409)
            release_spark.set()
            first_thread.join(timeout=10)

        self.assertFalse(first_thread.is_alive())
        completed = first_result.get_nowait()
        self.assertFalse(isinstance(completed, BaseException), completed)
        self.assertEqual(completed["status"], "success")
        spark_calls.assert_called_once_with("run", run_id)
        with self.session_factory() as db:
            run = db.get(ETLRunModel, run_id)
            self.assertEqual(run.task_states["sparkExecution"]["status"], "success")
            self.assertEqual(run.task_states["sparkResult"]["status"], "success")

    def test_parallel_spark_waits_leave_pool_available_for_status_polling(self) -> None:
        run_count = 8
        job_ids = [f"JOB-SPARK-POOL-{index}" for index in range(run_count)]
        run_ids = [f"RUN-SPARK-POOL-{index}" for index in range(run_count)]
        for job_id, run_id in zip(job_ids, run_ids, strict=True):
            self.insert_job(job_id)
            self.insert_airflow_run(job_id, run_id)

        entered_condition = threading.Condition()
        entered_run_ids: set[str] = set()
        release_spark = threading.Event()
        results: Queue = Queue()

        def prepare_spark(_db, _job, command, requested_run_id):
            return {"command": command, "runId": requested_run_id}

        def blocking_spark(prepared):
            requested_run_id = str(prepared["runId"])
            with entered_condition:
                entered_run_ids.add(requested_run_id)
                entered_condition.notify_all()
            if not release_spark.wait(timeout=10):
                raise TimeoutError("test did not release parallel Spark waits")
            return {
                "endedAt": "2026-07-12T11:00:02Z",
                "inputRows": 2,
                "outputPath": f"s3a://asklake-output/test/{requested_run_id}",
                "outputRows": 2,
                "runId": requested_run_id,
                "status": "success",
            }

        def execute(job_id: str, run_id: str) -> None:
            try:
                with self.session_factory() as db:
                    results.put(execute_airflow_spark_run(
                        db,
                        job_id=job_id,
                        run_id=run_id,
                        command="run",
                    ))
            except BaseException as exc:
                results.put(exc)

        def poll_status(run_id: str) -> str:
            with self.session_factory() as db:
                run = db.get(ETLRunModel, run_id)
                return str(run.task_states["sparkExecution"]["status"])

        with (
            patch("app.repositories.etl_repository.ensure_schema", return_value=None),
            patch("app.services.etl_service.prepare_spark_job", side_effect=prepare_spark),
            patch("app.services.etl_service.run_prepared_spark_job", side_effect=blocking_spark),
        ):
            execution_threads = [
                threading.Thread(
                    target=execute,
                    args=(job_id, run_id),
                    name=f"spark-pool-{index}",
                )
                for index, (job_id, run_id) in enumerate(zip(job_ids, run_ids, strict=True))
            ]
            for thread in execution_threads:
                thread.start()

            with entered_condition:
                all_waiting = entered_condition.wait_for(
                    lambda: len(entered_run_ids) == run_count,
                    timeout=5,
                )
            self.assertTrue(all_waiting, entered_run_ids)
            self.assertEqual(
                self.engine.pool.checkedout(),
                0,
                "Parallel external Spark waits must return every pooled DB connection.",
            )

            poll_started_at = time.monotonic()
            with ThreadPoolExecutor(max_workers=20) as executor:
                statuses = list(executor.map(poll_status, run_ids * 5))
            poll_elapsed_seconds = time.monotonic() - poll_started_at
            self.assertEqual(statuses, ["running"] * (run_count * 5))
            self.assertLess(poll_elapsed_seconds, 5)

            release_spark.set()
            for thread in execution_threads:
                thread.join(timeout=10)

        self.assertTrue(all(not thread.is_alive() for thread in execution_threads))
        completed = [results.get_nowait() for _ in range(run_count)]
        failures = [item for item in completed if isinstance(item, BaseException)]
        self.assertEqual(failures, [])
        self.assertTrue(all(item["status"] == "success" for item in completed))

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
            patch("app.services.etl_service.etl_repository.get_dataset_schema_by_id", return_value=None),
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
            patch("app.services.etl_service.etl_repository.get_dataset_schema_by_id", return_value=None),
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
            patch("app.services.etl_service.etl_repository.get_dataset_schema_by_id", return_value=None),
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
