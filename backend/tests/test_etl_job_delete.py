from pathlib import Path
from queue import Queue
from tempfile import TemporaryDirectory
import json
import os
import threading
import time
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import Mock, patch
from uuid import uuid4

from sqlalchemy import create_engine, delete, select, text
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import Session, sessionmaker

from app.core.auth_context import ActorContext
from app.core.config import settings
from app.core.errors import ApiError
from app.application.eks_msk_fault_execution import (
    record_eks_msk_authorization_fault,
)
from app.schemas.etl import ScheduledJobRunRequest
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
    airflow_submission_error_is_definitive,
    command_job,
    delete_job,
    ensure_batch_iceberg_target,
    execute_airflow_spark_run,
    record_airflow_sync_error,
    run_due_scheduled_jobs,
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


def eks_mvp_bounded_fixture_job(
    job_id: str,
    consumer_group: str = "asklake-eks-mvp-spark-v1",
) -> ETLJobModel:
    job = kafka_fixture_job(job_id)
    job.source = "Kafka / asklake.eks-mvp.fixture.v1"
    job.source_label = "asklake.eks-mvp.fixture.v1"
    job.source_config = [
        ["Broker / Endpoint", "boot.example.kafka-serverless.ap-northeast-2.amazonaws.com:9098"],
        ["TOPIC / QUEUE NAME", "asklake.eks-mvp.fixture.v1"],
        ["CONSUMER GROUP ID", consumer_group],
        ["__EKS MVP Fixture Batch ID", "fixture-batch-001"],
        ["__EKS MVP Expected Count", "100"],
    ]
    return job


def kubernetes_execution_fixture(
    job_id: str,
    run_id: str,
    *,
    attempt_generation: int = 1,
    recovered: bool = False,
    replacement: bool = False,
    state: str = "COMPLETED",
) -> dict:
    suffix = "" if attempt_generation == 1 else f"-g{attempt_generation}"
    return {
        "applicationName": f"asklake-run-contract-001{suffix}",
        "applicationUid": f"spark-uid-contract-00{attempt_generation}",
        "attemptGeneration": attempt_generation,
        "driverPodName": f"asklake-run-contract-001{suffix}-driver",
        "driverPodPhase": "Succeeded",
        "driverTerminationReason": "Completed",
        "driverExitCode": 0,
        "imageDigest": f"example.invalid/spark@sha256:{'a' * 64}",
        "jobId": job_id,
        "namespace": "asklake-dev",
        "observedAt": "2026-07-16T02:00:00Z",
        "recovered": recovered,
        "replacement": replacement,
        "resultMarkerFound": True,
        "runId": run_id,
        "state": state,
    }


def spark_terminal_result(job_id: str, run_id: str, execution: dict) -> dict:
    return {
        "endedAt": "2026-07-16T02:00:02Z",
        "inputRows": 2,
        "kubernetesExecution": execution,
        "outputPath": f"s3a://asklake-output/test/{run_id}",
        "outputRows": 2,
        "runId": run_id,
        "startedAt": "2026-07-16T02:00:00Z",
        "status": "success",
    }


def eks_mvp_iceberg_target(table: str = "eks_mvp_fixture") -> dict:
    return {
        "catalog": "iceberg",
        "namespace": "asklake",
        "partitionColumns": [],
        "table": table,
        "tableUri": f"iceberg://iceberg/asklake/{table}",
        "writeMode": "replace",
    }


def eks_mvp_spark_terminal_result(
    job_id: str,
    run_id: str,
    execution: dict,
    source_boundary: dict,
) -> dict:
    target = eks_mvp_iceberg_target()
    expected_count = source_boundary["expectedCount"]
    return {
        **spark_terminal_result(job_id, run_id, execution),
        "icebergCommit": {
            "createdTable": True,
            "jobId": job_id,
            "runId": run_id,
            "snapshotId": "123456789",
            "sourceBoundary": source_boundary,
            "target": target,
        },
        "inputRows": expected_count,
        "outputPath": target["tableUri"],
        "outputRows": expected_count,
        "sourceBoundary": source_boundary,
    }


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
        self.assertTrue(statement.get_execution_options()["populate_existing"])

    def test_postgres_fixture_slot_reservation_uses_an_advisory_transaction_lock(self) -> None:
        db = Mock()
        db.get_bind.return_value.dialect.name = "postgresql"
        db.scalars.return_value.all.return_value = []

        with patch("app.repositories.etl_repository.ensure_schema"):
            self.assertIsNone(
                etl_repository.find_active_eks_fixture_slot_run(
                    db,
                    "approved-scale-17-01",
                )
            )

        lock_statement, lock_parameters = db.execute.call_args.args
        self.assertIn("pg_advisory_xact_lock", str(lock_statement))
        self.assertEqual(
            lock_parameters["lock_key"],
            "asklake:eks-fixture-slot:approved-scale-17-01",
        )


class BlockingAirflowClient:
    def __init__(self, entered: threading.Event | None = None, release: threading.Event | None = None) -> None:
        self.config = SimpleNamespace(dag_id="asklake_test_dag")
        self.entered = entered
        self.release = release
        self.trigger_count = 0
        self.last_conf: dict[str, object] | None = None

    def trigger_dag_run(self, *, dag_run_id: str, conf: dict[str, object], note: str) -> AirflowDagRun:
        del note
        self.trigger_count += 1
        self.last_conf = conf
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

    def insert_eks_mvp_fixture_job(
        self,
        job_id: str,
        consumer_group: str = "asklake-eks-mvp-spark-v1",
    ) -> None:
        with self.session_factory() as db:
            db.add(eks_mvp_bounded_fixture_job(job_id, consumer_group))
            db.commit()

    def test_eks_mvp_fixture_routes_through_airflow(self) -> None:
        job_id = "JOB-SQLITE-EKS-MVP-FIXTURE"
        self.insert_eks_mvp_fixture_job(job_id)
        airflow = BlockingAirflowClient()
        direct_ingest = Mock()

        with (
            patch.dict(os.environ, {
                "ASKLAKE_SPARK_OUTPUT_BUCKET": "asklake-dev-output-123-apne2",
                "ASKLAKE_SPARK_RUNNER": "kubernetes",
            }),
            patch("app.repositories.etl_repository.ensure_schema", return_value=None),
            patch("app.services.etl_service.build_airflow_client", return_value=airflow),
            patch("app.services.etl_service.run_kafka_ingest_request", direct_ingest),
        ):
            with self.session_factory() as db:
                response = command_job(db, job_id, "run", ActorContext(name="Test Admin", role="admin"))

        self.assertEqual(response.run.status, "queued")
        self.assertEqual(airflow.trigger_count, 1)
        direct_ingest.assert_not_called()
        with self.session_factory() as db:
            run = db.get(ETLRunModel, response.run.run_id)
            self.assertEqual(run.airflow_dag_run_id, run.run_id)
            self.assertEqual(run.status, "queued")
            fixture_state = run.task_states["eksMvpFixture"]
            boundary = fixture_state["sourceBoundary"]
            self.assertEqual(fixture_state["runId"], run.run_id)
            self.assertEqual(fixture_state["contractVersion"], 2)
            self.assertEqual(fixture_state["icebergTable"], "eks_mvp_fixture")
            self.assertEqual(boundary["snapshotId"], run.run_id)
            self.assertEqual(boundary["fixtureBatchId"], "fixture-batch-001")
            self.assertEqual(boundary["expectedCount"], 100)
            self.assertEqual(
                boundary["outputPath"],
                f"s3a://asklake-dev-output-123-apne2/eks-mvp/output/{run.run_id}",
            )
            self.assertEqual(airflow.last_conf["sourceBoundary"], boundary)

    def test_eks_mvp_fixture_execution_uses_persisted_boundary_after_job_drift(self) -> None:
        job_id = "JOB-SQLITE-EKS-MVP-FIXTURE-IMMUTABLE"
        self.insert_eks_mvp_fixture_job(job_id)
        airflow = BlockingAirflowClient()
        with (
            patch.dict(os.environ, {
                "ASKLAKE_SPARK_OUTPUT_BUCKET": "asklake-dev-output-123-apne2",
                "ASKLAKE_SPARK_RUNNER": "kubernetes",
            }),
            patch("app.repositories.etl_repository.ensure_schema", return_value=None),
            patch("app.services.etl_service.build_airflow_client", return_value=airflow),
        ):
            with self.session_factory() as db:
                response = command_job(db, job_id, "run", ActorContext(name="Test Admin", role="admin"))

        source_boundary = dict(airflow.last_conf["sourceBoundary"])
        with self.session_factory() as db:
            job = db.get(ETLJobModel, job_id)
            run = db.get(ETLRunModel, response.run.run_id)
            fixture_state = dict(run.task_states["eksMvpFixture"])
            fixture_state.pop("icebergTable")
            fixture_state["contractVersion"] = 1
            run.task_states = {
                **run.task_states,
                "eksMvpFixture": fixture_state,
            }
            job.source_config = [
                [label, "fixture-batch-drifted" if label == "__EKS MVP Fixture Batch ID" else value]
                for label, value in job.source_config
            ]
            db.commit()

        observed_boundary: dict = {}

        def spark_with_boundary(
            spark_db,
            spark_job,
            _command,
            requested_run_id,
            *,
            spark_progress_callback,
            source_boundary,
        ):
            observed_boundary.update(source_boundary)
            spark_job.iceberg_target = eks_mvp_iceberg_target()
            spark_db.add(spark_job)
            spark_db.commit()
            progress = kubernetes_execution_fixture(job_id, requested_run_id)
            spark_progress_callback(progress)
            return eks_mvp_spark_terminal_result(
                job_id,
                requested_run_id,
                progress,
                source_boundary,
            )

        with (
            patch.dict(os.environ, {"ASKLAKE_SPARK_RUNNER": "kubernetes"}),
            patch("app.repositories.etl_repository.ensure_schema", return_value=None),
            patch("app.services.etl_service.run_spark_job", side_effect=spark_with_boundary),
            self.session_factory() as db,
        ):
            execute_airflow_spark_run(
                db,
                job_id=job_id,
                run_id=response.run.run_id,
                command="run",
                airflow_source_boundary=source_boundary,
            )

        self.assertEqual(observed_boundary, source_boundary)
        self.assertEqual(observed_boundary["fixtureBatchId"], "fixture-batch-001")

    def test_eks_mvp_fixture_gets_dedicated_iceberg_target(self) -> None:
        job_id = "JOB-SQLITE-EKS-MVP-FIXTURE-TARGET"
        self.insert_eks_mvp_fixture_job(job_id)

        with self.session_factory() as db:
            job = db.get(ETLJobModel, job_id)
            ensure_batch_iceberg_target(db, job)

        with self.session_factory() as db:
            job = db.get(ETLJobModel, job_id)
            self.assertEqual(job.iceberg_target, eks_mvp_iceberg_target())
            self.assertTrue(job.dataset_id)

    def test_three_approved_fixture_slots_reserve_unique_groups_and_tables(self) -> None:
        slots = [
            {
                "consumerGroup": "asklake-eks-mvp-spark-v1",
                "table": "eks_mvp_fixture",
            },
            *[
                {
                    "consumerGroup": f"approved-scale-17-{index:02d}",
                    "table": f"eks_mvp_scale_17_{index:02d}",
                }
                for index in range(1, 4)
            ],
        ]
        job_groups = {
            f"JOB-SQLITE-EKS-SCALE-{index:02d}": f"approved-scale-17-{index:02d}"
            for index in range(1, 4)
        }
        duplicate_job_id = "JOB-SQLITE-EKS-SCALE-DUPLICATE"
        for job_id, consumer_group in job_groups.items():
            self.insert_eks_mvp_fixture_job(job_id, consumer_group)
        self.insert_eks_mvp_fixture_job(
            duplicate_job_id,
            "approved-scale-17-01",
        )
        airflow = BlockingAirflowClient()
        environment = {
            "ASKLAKE_EKS_MVP_FIXTURE_SLOTS_JSON": json.dumps(slots),
            "ASKLAKE_SPARK_OUTPUT_BUCKET": "asklake-dev-output-123-apne2",
            "ASKLAKE_SPARK_RUNNER": "kubernetes",
        }

        with (
            patch.dict(os.environ, environment),
            patch("app.repositories.etl_repository.ensure_schema", return_value=None),
            patch("app.services.etl_service.build_airflow_client", return_value=airflow),
        ):
            for job_id in job_groups:
                with self.session_factory() as db:
                    response = command_job(
                        db,
                        job_id,
                        "run",
                        ActorContext(name="Test Admin", role="admin"),
                    )
                    self.assertEqual(response.run.status, "queued")

            with self.session_factory() as db:
                with self.assertRaises(ApiError) as raised:
                    command_job(
                        db,
                        duplicate_job_id,
                        "run",
                        ActorContext(name="Test Admin", role="admin"),
                    )

            for job_id in job_groups:
                with self.session_factory() as db:
                    job = db.get(ETLJobModel, job_id)
                    ensure_batch_iceberg_target(db, job)

        self.assertEqual(raised.exception.code, "EKS_MVP_FIXTURE_SLOT_ACTIVE")
        self.assertEqual(airflow.trigger_count, 3)
        with self.session_factory() as db:
            jobs = [db.get(ETLJobModel, job_id) for job_id in job_groups]
            runs = list(db.scalars(
                select(ETLRunModel).where(ETLRunModel.job_id.in_(job_groups))
            ))
            duplicate_runs = list(db.scalars(
                select(ETLRunModel).where(ETLRunModel.job_id == duplicate_job_id)
            ))

        self.assertEqual(
            {job.iceberg_target["table"] for job in jobs},
            {f"eks_mvp_scale_17_{index:02d}" for index in range(1, 4)},
        )
        self.assertEqual(
            {
                run.task_states["eksMvpFixture"]["sourceBoundary"]["consumerGroup"]
                for run in runs
            },
            set(job_groups.values()),
        )
        self.assertEqual(duplicate_runs, [])

    def test_eks_mvp_fixture_rejects_success_without_exact_count_and_commit_boundary(self) -> None:
        job_id = "JOB-SQLITE-EKS-MVP-FIXTURE-RESULT-MISMATCH"
        self.insert_eks_mvp_fixture_job(job_id)
        airflow = BlockingAirflowClient()
        with (
            patch.dict(os.environ, {
                "ASKLAKE_SPARK_OUTPUT_BUCKET": "asklake-dev-output-123-apne2",
                "ASKLAKE_SPARK_RUNNER": "kubernetes",
            }),
            patch("app.repositories.etl_repository.ensure_schema", return_value=None),
            patch("app.services.etl_service.build_airflow_client", return_value=airflow),
        ):
            with self.session_factory() as db:
                response = command_job(db, job_id, "run", ActorContext(name="Test Admin", role="admin"))

        source_boundary = dict(airflow.last_conf["sourceBoundary"])

        def mismatched_spark(
            spark_db,
            spark_job,
            _command,
            requested_run_id,
            *,
            spark_progress_callback,
            source_boundary,
        ):
            spark_job.iceberg_target = eks_mvp_iceberg_target()
            spark_db.add(spark_job)
            spark_db.commit()
            progress = kubernetes_execution_fixture(job_id, requested_run_id)
            spark_progress_callback(progress)
            result = eks_mvp_spark_terminal_result(
                job_id,
                requested_run_id,
                progress,
                source_boundary,
            )
            result["inputRows"] = source_boundary["expectedCount"] - 1
            result["icebergCommit"]["sourceBoundary"] = {
                **source_boundary,
                "fixtureBatchId": "wrong-batch",
            }
            return result

        with (
            patch.dict(os.environ, {"ASKLAKE_SPARK_RUNNER": "kubernetes"}),
            patch("app.repositories.etl_repository.ensure_schema", return_value=None),
            patch("app.services.etl_service.run_spark_job", side_effect=mismatched_spark),
            self.session_factory() as db,
        ):
            with self.assertRaises(ApiError) as raised:
                execute_airflow_spark_run(
                    db,
                    job_id=job_id,
                    run_id=response.run.run_id,
                    command="run",
                    airflow_source_boundary=source_boundary,
                )

        self.assertEqual(raised.exception.code, "EKS_MVP_FIXTURE_RESULT_INVALID")
        self.assertEqual(
            set(raised.exception.details["mismatches"]),
            {"commitSourceBoundary", "inputRows"},
        )
        with self.session_factory() as db:
            run = db.get(ETLRunModel, response.run.run_id)
            self.assertEqual(run.task_states["sparkExecution"]["status"], "failed")
            self.assertNotIn("sparkResult", run.task_states)

    def test_eks_mvp_fixture_rejects_missing_or_drifted_airflow_boundary_before_spark(self) -> None:
        job_id = "JOB-SQLITE-EKS-MVP-FIXTURE-AIRFLOW-DRIFT"
        self.insert_eks_mvp_fixture_job(job_id)
        airflow = BlockingAirflowClient()
        with (
            patch.dict(os.environ, {
                "ASKLAKE_SPARK_OUTPUT_BUCKET": "asklake-dev-output-123-apne2",
                "ASKLAKE_SPARK_RUNNER": "kubernetes",
            }),
            patch("app.repositories.etl_repository.ensure_schema", return_value=None),
            patch("app.services.etl_service.build_airflow_client", return_value=airflow),
        ):
            with self.session_factory() as db:
                response = command_job(db, job_id, "run", ActorContext(name="Test Admin", role="admin"))

        drifted_boundary = {
            **dict(airflow.last_conf["sourceBoundary"]),
            "fixtureBatchId": "fixture-batch-drifted",
        }
        spark = Mock()
        for supplied_boundary in (None, drifted_boundary):
            with self.subTest(supplied_boundary=supplied_boundary):
                with (
                    patch("app.repositories.etl_repository.ensure_schema", return_value=None),
                    patch("app.services.etl_service.run_spark_job", spark),
                    self.session_factory() as db,
                ):
                    with self.assertRaises(ApiError) as raised:
                        execute_airflow_spark_run(
                            db,
                            job_id=job_id,
                            run_id=response.run.run_id,
                            command="run",
                            airflow_source_boundary=supplied_boundary,
                        )
                    self.assertEqual(raised.exception.code, "AIRFLOW_SOURCE_BOUNDARY_MISMATCH")
        spark.assert_not_called()

    def test_invalid_eks_mvp_fixture_fails_closed_before_any_executor_runs(self) -> None:
        job_id = "JOB-SQLITE-EKS-MVP-FIXTURE-INVALID"
        with self.session_factory() as db:
            job = eks_mvp_bounded_fixture_job(job_id)
            job.source_config = [
                [label, "" if label == "__EKS MVP Fixture Batch ID" else value]
                for label, value in job.source_config
            ]
            db.add(job)
            db.commit()
        airflow = BlockingAirflowClient()
        direct_ingest = Mock()

        with (
            patch.dict(os.environ, {"ASKLAKE_SPARK_RUNNER": "kubernetes"}),
            patch("app.repositories.etl_repository.ensure_schema", return_value=None),
            patch("app.services.etl_service.build_airflow_client", return_value=airflow),
            patch("app.services.etl_service.run_kafka_ingest_request", direct_ingest),
        ):
            with self.session_factory() as db:
                with self.assertRaises(ApiError) as raised:
                    command_job(db, job_id, "run", ActorContext(name="Test Admin", role="admin"))

        self.assertEqual(raised.exception.code, "EKS_MVP_FIXTURE_CONTRACT_INVALID")
        self.assertEqual(airflow.trigger_count, 0)
        direct_ingest.assert_not_called()
        with self.session_factory() as db:
            self.assertEqual(
                list(db.scalars(select(ETLRunModel).where(ETLRunModel.job_id == job_id))),
                [],
            )

    def test_eks_mvp_fixture_rejects_corrupted_persisted_boundary_before_spark(self) -> None:
        job_id = "JOB-SQLITE-EKS-MVP-FIXTURE-RDS-CORRUPT"
        self.insert_eks_mvp_fixture_job(job_id)
        airflow = BlockingAirflowClient()
        with (
            patch.dict(os.environ, {
                "ASKLAKE_SPARK_OUTPUT_BUCKET": "asklake-dev-output-123-apne2",
                "ASKLAKE_SPARK_RUNNER": "kubernetes",
            }),
            patch("app.repositories.etl_repository.ensure_schema", return_value=None),
            patch("app.services.etl_service.build_airflow_client", return_value=airflow),
        ):
            with self.session_factory() as db:
                response = command_job(db, job_id, "run", ActorContext(name="Test Admin", role="admin"))

        with self.session_factory() as db:
            run = db.get(ETLRunModel, response.run.run_id)
            state = dict(run.task_states["eksMvpFixture"])
            corrupted_boundary = {**state["sourceBoundary"], "expectedCount": 100_001}
            run.task_states = {
                **run.task_states,
                "eksMvpFixture": {**state, "sourceBoundary": corrupted_boundary},
            }
            db.commit()

        spark = Mock()
        with (
            patch("app.repositories.etl_repository.ensure_schema", return_value=None),
            patch("app.services.etl_service.run_spark_job", spark),
            self.session_factory() as db,
        ):
            with self.assertRaises(ApiError) as raised:
                execute_airflow_spark_run(
                    db,
                    job_id=job_id,
                    run_id=response.run.run_id,
                    command="run",
                    airflow_source_boundary=corrupted_boundary,
                )

        self.assertEqual(raised.exception.code, "EKS_MVP_FIXTURE_RUN_BOUNDARY_INVALID")
        spark.assert_not_called()

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
                "eksMvpFixture": {
                    "contractVersion": 1,
                    "runId": run_id,
                    "sourceBoundary": {
                        "kind": "kafka_snapshot",
                        "snapshotId": run_id,
                    },
                },
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
            self.assertEqual(run.task_states["eksMvpFixture"]["runId"], run_id)

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

        def blocking_spark(_db, _job, command, requested_run_id):
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
            patch("app.services.etl_service.run_spark_job", side_effect=blocking_spark),
        ):
            first_thread = threading.Thread(target=first_request, name="spark-lease-owner")
            first_thread.start()
            self.assertTrue(spark_entered.wait(timeout=5))
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

    def test_kubernetes_execution_identity_is_persisted_before_terminal_result(self) -> None:
        job_id = "JOB-SQLITE-SPARK-KUBERNETES-PROGRESS"
        run_id = "RUN-SQLITE-SPARK-KUBERNETES-PROGRESS"
        self.insert_job(job_id)
        self.insert_airflow_run(job_id, run_id)
        observed_while_running: dict = {}

        def spark_with_progress(_db, _job, _command, _run_id, *, spark_progress_callback):
            progress = kubernetes_execution_fixture(job_id, run_id)
            spark_progress_callback(progress)
            with self.session_factory() as observer:
                running = observer.get(ETLRunModel, run_id)
                observed_while_running.update(running.task_states["sparkExecution"]["kubernetesExecution"])
            return spark_terminal_result(job_id, run_id, progress)

        with (
            patch.dict(os.environ, {"ASKLAKE_SPARK_RUNNER": "kubernetes"}),
            patch("app.repositories.etl_repository.ensure_schema", return_value=None),
            patch("app.services.etl_service.run_spark_job", side_effect=spark_with_progress),
            self.session_factory() as db,
        ):
            result = execute_airflow_spark_run(db, job_id=job_id, run_id=run_id, command="run")

        self.assertEqual(observed_while_running["applicationUid"], "spark-uid-contract-001")
        self.assertEqual(observed_while_running["namespace"], "asklake-dev")
        self.assertEqual(result["kubernetesExecution"]["resultMarkerFound"], True)
        with self.session_factory() as db:
            run = db.get(ETLRunModel, run_id)
            self.assertEqual(run.task_states["sparkExecution"]["status"], "success")
            self.assertEqual(
                run.task_states["sparkResult"]["kubernetesExecution"]["applicationUid"],
                "spark-uid-contract-001",
            )

    def test_kubernetes_terminal_identity_mismatch_is_not_marked_success(self) -> None:
        job_id = "JOB-SQLITE-SPARK-KUBERNETES-MISMATCH"
        run_id = "RUN-SQLITE-SPARK-KUBERNETES-MISMATCH"
        self.insert_job(job_id)
        self.insert_airflow_run(job_id, run_id)

        def spark_with_mismatch(_db, _job, _command, _run_id, *, spark_progress_callback):
            progress = kubernetes_execution_fixture(job_id, run_id)
            spark_progress_callback(progress)
            terminal = {**progress, "applicationUid": "spark-uid-different"}
            return spark_terminal_result(job_id, run_id, terminal)

        with (
            patch.dict(os.environ, {"ASKLAKE_SPARK_RUNNER": "kubernetes"}),
            patch("app.repositories.etl_repository.ensure_schema", return_value=None),
            patch("app.services.etl_service.run_spark_job", side_effect=spark_with_mismatch),
            self.session_factory() as db,
        ):
            with self.assertRaises(ApiError) as raised:
                execute_airflow_spark_run(db, job_id=job_id, run_id=run_id, command="run")

        self.assertEqual(raised.exception.code, "SPARK_EXECUTION_IDENTITY_MISMATCH")
        with self.session_factory() as db:
            run = db.get(ETLRunModel, run_id)
            self.assertEqual(run.task_states["sparkExecution"]["status"], "failed")
            self.assertEqual(
                run.task_states["sparkExecution"]["kubernetesExecution"]["applicationUid"],
                "spark-uid-contract-001",
            )
            self.assertNotIn("sparkResult", run.task_states)

    def test_kubernetes_retry_recovers_the_same_persisted_uid(self) -> None:
        job_id = "JOB-SQLITE-SPARK-KUBERNETES-RECOVERY"
        run_id = "RUN-SQLITE-SPARK-KUBERNETES-RECOVERY"
        self.insert_job(job_id)
        self.insert_airflow_run(job_id, run_id)
        calls = 0
        expected_executions: list[dict | None] = []

        def recover_same_application(
            _db,
            _job,
            _command,
            _run_id,
            *,
            spark_progress_callback,
            expected_kubernetes_execution=None,
        ):
            nonlocal calls
            calls += 1
            expected_executions.append(expected_kubernetes_execution)
            progress = kubernetes_execution_fixture(job_id, run_id, recovered=calls > 1)
            spark_progress_callback(progress)
            if calls == 1:
                raise RuntimeError("simulated FastAPI interruption")
            return spark_terminal_result(job_id, run_id, progress)

        with (
            patch.dict(os.environ, {"ASKLAKE_SPARK_RUNNER": "kubernetes"}),
            patch("app.repositories.etl_repository.ensure_schema", return_value=None),
            patch("app.services.etl_service.run_spark_job", side_effect=recover_same_application),
        ):
            with self.session_factory() as db:
                with self.assertRaisesRegex(RuntimeError, "interruption"):
                    execute_airflow_spark_run(db, job_id=job_id, run_id=run_id, command="run")
            with self.session_factory() as db:
                result = execute_airflow_spark_run(db, job_id=job_id, run_id=run_id, command="run")

        self.assertEqual(result["kubernetesExecution"]["applicationUid"], "spark-uid-contract-001")
        self.assertEqual(result["kubernetesExecution"]["recovered"], True)
        self.assertIsNone(expected_executions[0])
        self.assertEqual(
            expected_executions[1]["applicationUid"],
            "spark-uid-contract-001",
        )
        with self.session_factory() as db:
            run = db.get(ETLRunModel, run_id)
            self.assertEqual(run.execution_generation, 2)
            self.assertEqual(
                run.task_states["sparkExecution"]["kubernetesExecution"]["applicationUid"],
                "spark-uid-contract-001",
            )

    def test_terminal_failed_application_retries_same_run_with_next_attempt_uid(self) -> None:
        job_id = "JOB-SQLITE-SPARK-KUBERNETES-TERMINAL-RETRY"
        run_id = "RUN-SQLITE-SPARK-KUBERNETES-TERMINAL-RETRY"
        self.insert_job(job_id)
        self.insert_airflow_run(job_id, run_id)
        failed_attempt = kubernetes_execution_fixture(
            job_id,
            run_id,
            state="FAILED",
        )
        with self.session_factory() as db:
            run = db.get(ETLRunModel, run_id)
            run.execution_generation = 1
            run.task_states = {
                "sparkExecution": {
                    "generation": 1,
                    "kubernetesExecution": failed_attempt,
                    "status": "failed",
                },
            }
            db.commit()

        observed: dict = {}

        def replace_terminal_application(
            _db,
            _job,
            _command,
            _run_id,
            *,
            expected_kubernetes_execution,
            spark_attempt_generation,
            spark_progress_callback,
        ):
            observed["expected"] = expected_kubernetes_execution
            observed["generation"] = spark_attempt_generation
            progress = kubernetes_execution_fixture(
                job_id,
                run_id,
                attempt_generation=2,
                replacement=True,
            )
            spark_progress_callback(progress)
            return spark_terminal_result(job_id, run_id, progress)

        with (
            patch.dict(os.environ, {
                "ASKLAKE_SPARK_KUBERNETES_MAX_ATTEMPTS": "2",
                "ASKLAKE_SPARK_RUNNER": "kubernetes",
            }),
            patch("app.repositories.etl_repository.ensure_schema", return_value=None),
            patch(
                "app.services.etl_service.run_spark_job",
                side_effect=replace_terminal_application,
            ),
            self.session_factory() as db,
        ):
            result = execute_airflow_spark_run(
                db,
                job_id=job_id,
                run_id=run_id,
                command="run",
            )

        self.assertEqual(observed["generation"], 2)
        self.assertEqual(
            observed["expected"]["applicationUid"],
            "spark-uid-contract-001",
        )
        self.assertEqual(
            result["kubernetesExecution"]["applicationUid"],
            "spark-uid-contract-002",
        )
        with self.session_factory() as db:
            run = db.get(ETLRunModel, run_id)
            execution = run.task_states["sparkExecution"]
            self.assertEqual(run.execution_generation, 2)
            self.assertEqual(
                execution["kubernetesAttempts"][0]["applicationUid"],
                "spark-uid-contract-001",
            )
            self.assertEqual(
                execution["kubernetesExecution"]["applicationUid"],
                "spark-uid-contract-002",
            )

    def test_terminal_failed_application_retry_is_bounded(self) -> None:
        job_id = "JOB-SQLITE-SPARK-KUBERNETES-TERMINAL-EXHAUSTED"
        run_id = "RUN-SQLITE-SPARK-KUBERNETES-TERMINAL-EXHAUSTED"
        self.insert_job(job_id)
        self.insert_airflow_run(job_id, run_id)
        with self.session_factory() as db:
            run = db.get(ETLRunModel, run_id)
            run.execution_generation = 1
            run.task_states = {
                "sparkExecution": {
                    "generation": 1,
                    "kubernetesExecution": kubernetes_execution_fixture(
                        job_id,
                        run_id,
                        state="FAILED",
                    ),
                    "status": "failed",
                },
            }
            db.commit()

        with (
            patch.dict(os.environ, {
                "ASKLAKE_SPARK_KUBERNETES_MAX_ATTEMPTS": "1",
                "ASKLAKE_SPARK_RUNNER": "kubernetes",
            }),
            patch("app.repositories.etl_repository.ensure_schema", return_value=None),
            patch("app.services.etl_service.run_spark_job") as run_spark,
            self.session_factory() as db,
        ):
            with self.assertRaises(ApiError) as raised:
                execute_airflow_spark_run(
                    db,
                    job_id=job_id,
                    run_id=run_id,
                    command="run",
                )

        self.assertEqual(raised.exception.code, "SPARK_TERMINAL_RETRY_EXHAUSTED")
        run_spark.assert_not_called()

    def test_msk_authorization_fault_is_fenced_into_the_same_persisted_run(self) -> None:
        job_id = "JOB-SQLITE-MSK-FAULT-PERSISTED"
        run_id = "RUN-SQLITE-MSK-FAULT-PERSISTED"
        evidence_sha256 = "b" * 64
        self.insert_eks_mvp_fixture_job(job_id)
        self.insert_airflow_run(job_id, run_id)

        with (
            patch("app.repositories.etl_repository.ensure_schema", return_value=None),
            self.session_factory() as db,
        ):
            first = record_eks_msk_authorization_fault(
                db,
                acknowledged_records=0,
                attempted_records=1,
                category="AUTHORIZATION",
                evidence_sha256=evidence_sha256,
                job_id=job_id,
                run_id=run_id,
            )
            duplicate = record_eks_msk_authorization_fault(
                db,
                acknowledged_records=0,
                attempted_records=1,
                category="AUTHORIZATION",
                evidence_sha256=evidence_sha256,
                job_id=job_id,
                run_id=run_id,
            )

        self.assertEqual(first, duplicate)
        self.assertEqual(first["generation"], 1)
        self.assertEqual(first["attemptedRecords"], 1)
        self.assertEqual(first["acknowledgedRecords"], 0)
        with self.session_factory() as db:
            run = db.get(ETLRunModel, run_id)
            self.assertEqual(run.execution_generation, 1)
            self.assertIsNone(run.execution_owner)
            self.assertEqual(
                run.task_states["faultAttempts"][0]["evidenceSha256"],
                evidence_sha256,
            )

    def test_msk_fault_then_spark_retry_preserves_one_logical_run(self) -> None:
        job_id = "JOB-SQLITE-MSK-FAULT-RETRY"
        run_id = "RUN-SQLITE-MSK-FAULT-RETRY"
        self.insert_eks_mvp_fixture_job(job_id)
        self.insert_airflow_run(job_id, run_id)
        with (
            patch("app.repositories.etl_repository.ensure_schema", return_value=None),
            self.session_factory() as db,
        ):
            record_eks_msk_authorization_fault(
                db,
                acknowledged_records=0,
                attempted_records=1,
                category="AUTHORIZATION",
                evidence_sha256="c" * 64,
                job_id=job_id,
                run_id=run_id,
            )

        def successful_retry(
            _db,
            _job,
            _command,
            _run_id,
            *,
            spark_progress_callback,
        ):
            progress = kubernetes_execution_fixture(job_id, run_id)
            spark_progress_callback(progress)
            return spark_terminal_result(job_id, run_id, progress)

        with (
            patch.dict(os.environ, {"ASKLAKE_SPARK_RUNNER": "kubernetes"}),
            patch("app.repositories.etl_repository.ensure_schema", return_value=None),
            patch(
                "app.services.etl_service.run_spark_job",
                side_effect=successful_retry,
            ),
            self.session_factory() as db,
        ):
            result = execute_airflow_spark_run(
                db,
                job_id=job_id,
                run_id=run_id,
                command="retry",
            )

        self.assertEqual(result["status"], "success")
        with self.session_factory() as db:
            runs = list(
                db.scalars(
                    select(ETLRunModel).where(ETLRunModel.run_id == run_id)
                ).all()
            )
            self.assertEqual(len(runs), 1)
            self.assertEqual(runs[0].execution_generation, 2)
            self.assertEqual(
                runs[0].task_states["faultAttempts"][0]["category"],
                "AUTHORIZATION",
            )
            self.assertEqual(
                runs[0].task_states["sparkResult"]["status"],
                "success",
            )

    def test_msk_fault_adapter_rejects_non_authorization_outcome(self) -> None:
        job_id = "JOB-SQLITE-MSK-FAULT-INVALID"
        run_id = "RUN-SQLITE-MSK-FAULT-INVALID"
        self.insert_eks_mvp_fixture_job(job_id)
        self.insert_airflow_run(job_id, run_id)
        with (
            patch("app.repositories.etl_repository.ensure_schema", return_value=None),
            self.session_factory() as db,
        ):
            with self.assertRaises(ApiError) as raised:
                record_eks_msk_authorization_fault(
                    db,
                    acknowledged_records=0,
                    attempted_records=1,
                    category="TIMEOUT",
                    evidence_sha256="d" * 64,
                    job_id=job_id,
                    run_id=run_id,
                )

        self.assertEqual(raised.exception.code, "MSK_FAULT_EVIDENCE_INVALID")

    def test_successful_same_run_retry_returns_persisted_result_without_spark_call(self) -> None:
        job_id = "JOB-SQLITE-SPARK-TERMINAL-RETRY"
        run_id = "RUN-SQLITE-SPARK-TERMINAL-RETRY"
        self.insert_job(job_id)
        self.insert_airflow_run(job_id, run_id)
        persisted = spark_terminal_result(
            job_id,
            run_id,
            kubernetes_execution_fixture(job_id, run_id),
        )
        with self.session_factory() as db:
            run = db.get(ETLRunModel, run_id)
            run.execution_generation = 7
            run.task_states = {
                "sparkExecution": {
                    "generation": 7,
                    "kubernetesExecution": persisted["kubernetesExecution"],
                    "status": "success",
                },
                "sparkResult": persisted,
            }
            db.commit()

        with (
            patch("app.repositories.etl_repository.ensure_schema", return_value=None),
            patch("app.services.etl_service.run_spark_job") as run_spark,
            self.session_factory() as db,
        ):
            result = execute_airflow_spark_run(db, job_id=job_id, run_id=run_id, command="run")

        self.assertEqual(result, persisted)
        run_spark.assert_not_called()
        with self.session_factory() as db:
            run = db.get(ETLRunModel, run_id)
            self.assertEqual(run.execution_generation, 7)
            self.assertEqual(
                run.task_states["sparkExecution"]["kubernetesExecution"]["applicationUid"],
                "spark-uid-contract-001",
            )

    def test_two_scheduler_ticks_reserve_one_airflow_run(self) -> None:
        job_id = "JOB-SQLITE-SCHEDULER-RACE"
        self.insert_job(job_id)
        with self.session_factory() as db:
            job = db.get(ETLJobModel, job_id)
            self.assertIsNotNone(job)
            job.schedule = "매일 09:00"
            job.schedule_policy = {
                "nextRunUtc": "2020-01-01T00:00:00Z",
                "timezone": "Asia/Seoul",
            }
            job.next_run = "2020-01-01T00:00:00Z"
            db.commit()

        listed_by_both_ticks = threading.Barrier(2)
        outcomes: Queue = Queue()
        trigger_entered = threading.Event()
        release_trigger = threading.Event()
        airflow = BlockingAirflowClient(trigger_entered, release_trigger)
        original_list_job_models = etl_repository.list_job_models

        def synchronized_list_job_models(db: Session):
            jobs = original_list_job_models(db)
            listed_by_both_ticks.wait(timeout=5)
            return jobs

        def tick() -> None:
            try:
                with self.session_factory() as db:
                    outcomes.put(run_due_scheduled_jobs(db, ScheduledJobRunRequest(kafka_only=False)))
            except BaseException as exc:
                outcomes.put(exc)

        first_tick = threading.Thread(target=tick, name="scheduler-pod-a")
        second_tick = threading.Thread(target=tick, name="scheduler-pod-b")
        try:
            with (
                patch("app.repositories.etl_repository.ensure_schema", return_value=None),
                patch("app.services.etl_service.build_airflow_client", return_value=airflow),
                patch(
                    "app.services.etl_service.etl_repository.list_job_models",
                    side_effect=synchronized_list_job_models,
                ),
            ):
                first_tick.start()
                second_tick.start()
                self.assertTrue(trigger_entered.wait(timeout=5))

                deadline = time.monotonic() + 5
                while outcomes.qsize() < 1 and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertEqual(outcomes.qsize(), 1, "losing scheduler did not skip the claimed occurrence")

                losing_tick = outcomes.get_nowait()
                self.assertFalse(isinstance(losing_tick, BaseException), losing_tick)
                self.assertEqual(losing_tick.triggered_count, 0)
                self.assertEqual([item.reason for item in losing_tick.items], ["already_claimed"])

                # The occurrence advance and Run reservation must already be durable
                # before the external Airflow request returns.
                with self.session_factory() as db:
                    reserved_runs = list(db.scalars(select(ETLRunModel).where(ETLRunModel.job_id == job_id)))
                    reserved_job = db.get(ETLJobModel, job_id)
                    self.assertEqual(len(reserved_runs), 1)
                    self.assertIsNotNone(reserved_job)
                    self.assertGreater(
                        reserved_job.schedule_policy["nextRunUtc"],
                        "2020-01-01T00:00:00Z",
                    )

                release_trigger.set()
                first_tick.join(timeout=10)
                second_tick.join(timeout=10)
        finally:
            release_trigger.set()
            first_tick.join(timeout=10)
            second_tick.join(timeout=10)

        self.assertFalse(first_tick.is_alive())
        self.assertFalse(second_tick.is_alive())
        winning_tick = outcomes.get_nowait()
        self.assertFalse(isinstance(winning_tick, BaseException), winning_tick)
        successes = [losing_tick, winning_tick]
        self.assertEqual(
            sum(outcome.triggered_count for outcome in successes),
            1,
            [(outcome.triggered_count, [item.reason for item in outcome.items]) for outcome in successes],
        )
        self.assertEqual(airflow.trigger_count, 1)
        with self.session_factory() as db:
            runs = list(db.scalars(select(ETLRunModel).where(ETLRunModel.job_id == job_id)))
            self.assertEqual(len(runs), 1)

    @patch("app.repositories.etl_repository.ensure_schema", return_value=None)
    def test_expired_run_lease_increments_generation_and_fences_previous_owner(self, _ensure_schema: Mock) -> None:
        job_id = "JOB-SQLITE-SPARK-LEASE-TAKEOVER"
        run_id = "RUN-SQLITE-SPARK-LEASE-TAKEOVER"
        self.insert_job(job_id)
        self.insert_airflow_run(job_id, run_id)

        with self.session_factory() as db:
            first = etl_repository.claim_run_execution_lease(
                db,
                run_id,
                owner="pod-a",
                lease_seconds=60,
            )
        self.assertIsNotNone(first)
        self.assertEqual(first.generation, 1)

        with self.session_factory() as db:
            run = db.get(ETLRunModel, run_id)
            run.execution_lease_expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
            db.commit()

        with self.session_factory() as db:
            second = etl_repository.claim_run_execution_lease(
                db,
                run_id,
                owner="pod-b",
                lease_seconds=60,
            )
        self.assertIsNotNone(second)
        self.assertEqual(second.generation, 2)

        with self.session_factory() as db:
            previous_owner = etl_repository.get_run_for_execution_fence(
                db,
                run_id,
                owner="pod-a",
                generation=first.generation,
            )
            self.assertIsNone(previous_owner)

        with self.session_factory() as db:
            current_owner = etl_repository.get_run_for_execution_fence(
                db,
                run_id,
                owner="pod-b",
                generation=second.generation,
            )
            self.assertIsNotNone(current_owner)
            current_owner.execution_owner = None
            current_owner.execution_lease_expires_at = None
            db.commit()

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


@unittest.skipUnless(
    os.getenv("ASKLAKE_TEST_POSTGRES_CONCURRENCY") == "1",
    "set ASKLAKE_TEST_POSTGRES_CONCURRENCY=1 to run the PostgreSQL scheduler lock test",
)
class EtlSchedulerPostgresConcurrencyTests(unittest.TestCase):
    def test_two_postgres_sessions_claim_one_scheduled_occurrence(self) -> None:
        engine = create_engine(settings.database_url, pool_pre_ping=True)
        if engine.dialect.name != "postgresql":
            engine.dispose()
            self.skipTest("PostgreSQL is required for row-lock serialization")

        Base.metadata.create_all(
            engine,
            tables=[
                ETLJobModel.__table__,
                ETLRunModel.__table__,
                PermissionGrantModel.__table__,
                PrincipalControlModel.__table__,
                ResourceLockModel.__table__,
                AuditEventModel.__table__,
            ],
        )
        session_factory = sessionmaker(bind=engine, expire_on_commit=False)
        job_id = f"JOB-POSTGRES-SCHEDULER-{uuid4().hex}"
        due_at = "2020-01-01T00:00:00Z"
        outcomes: Queue = Queue()
        listed_by_both_ticks = threading.Barrier(2)
        airflow = BlockingAirflowClient()
        original_list_job_models = etl_repository.list_job_models
        threads: list[threading.Thread] = []

        def synchronized_list_job_models(db: Session):
            jobs = original_list_job_models(db)
            listed_by_both_ticks.wait(timeout=10)
            return jobs

        def tick() -> None:
            try:
                with session_factory() as db:
                    outcomes.put(run_due_scheduled_jobs(
                        db,
                        ScheduledJobRunRequest(job_id=job_id, kafka_only=False),
                    ))
            except BaseException as exc:
                outcomes.put(exc)

        try:
            with session_factory() as db:
                job = delete_fixture_job(job_id)
                job.schedule = "매일 09:00"
                job.schedule_policy = {"nextRunUtc": due_at, "timezone": "Asia/Seoul"}
                job.next_run = due_at
                db.add(job)
                db.commit()

            with (
                patch("app.repositories.etl_repository.ensure_schema", return_value=None),
                patch("app.services.etl_service.build_airflow_client", return_value=airflow),
                patch(
                    "app.services.etl_service.etl_repository.list_job_models",
                    side_effect=synchronized_list_job_models,
                ),
            ):
                threads = [
                    threading.Thread(target=tick, name="postgres-scheduler-pod-a"),
                    threading.Thread(target=tick, name="postgres-scheduler-pod-b"),
                ]
                for thread in threads:
                    thread.start()
                for thread in threads:
                    thread.join(timeout=15)
                    self.assertFalse(thread.is_alive(), f"{thread.name} did not finish")

            tick_outcomes = [outcomes.get_nowait() for _ in range(2)]
            for outcome in tick_outcomes:
                self.assertFalse(isinstance(outcome, BaseException), outcome)
            self.assertEqual(sorted(outcome.triggered_count for outcome in tick_outcomes), [0, 1])
            self.assertEqual(
                sorted(item.reason for outcome in tick_outcomes for item in outcome.items),
                ["already_claimed", "due"],
            )
            self.assertEqual(airflow.trigger_count, 1)

            with session_factory() as db:
                runs = list(db.scalars(select(ETLRunModel).where(ETLRunModel.job_id == job_id)))
                job = db.get(ETLJobModel, job_id)
                self.assertEqual(len(runs), 1)
                self.assertIsNotNone(job)
                self.assertGreater(job.schedule_policy["nextRunUtc"], due_at)
        finally:
            for thread in threads:
                thread.join(timeout=15)
            try:
                with session_factory() as db:
                    db.execute(delete(ETLRunModel).where(ETLRunModel.job_id == job_id))
                    db.execute(delete(AuditEventModel).where(AuditEventModel.target_id == job_id))
                    db.execute(delete(ETLJobModel).where(ETLJobModel.id == job_id))
                    db.commit()
            finally:
                engine.dispose()


if __name__ == "__main__":
    unittest.main()
