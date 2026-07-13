"""Durable EMR admission, quota, queue, release, and admin projection checks."""

from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from threading import Barrier

from sqlalchemy import create_engine, delete
from sqlalchemy.orm import sessionmaker

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))

from app.core.auth_context import ActorContext
from app.core.errors import ApiError
from app.models import EmrAdmissionReservationModel, ETLJobModel
from app.models.base import Base
from app.repositories import emr_admission_repository
from app.services.emr_admission_service import (
    reserve_emr_capacity,
    runtime_capacity_overview,
    sync_emr_reservation,
)


def fixture_job(job_id: str) -> ETLJobModel:
    return ETLJobModel(
        id=job_id,
        name=job_id,
        owner="contract-owner",
        created_by="contract-owner",
        status="scheduled",
        tag="[test]",
        source="S3",
        target=f"target-{job_id.lower()}",
        schedule="manual",
        source_config=[],
        source_label="S3 contract",
        source_type="File / S3",
        execution_mode="snapshot",
        schema_columns=[],
        schema_sample_rows=[],
        target_format="parquet",
        target_layer="BRONZE",
        rag=False,
        transform_output_columns=[],
        transform_steps=[],
        quality_invalid_rows=[],
        quality_rules=[],
        last_run="-",
        last_state="test",
        next_run="-",
        stats={},
        dag_steps=[],
    )


original_environment = dict(os.environ)
try:
    with TemporaryDirectory(prefix="asklake-emr-admission-") as temporary_dir:
        os.environ.update({
            "ASKLAKE_SPARK_RUNTIME": "emr-serverless",
            "ASKLAKE_EMR_SERVERLESS_ADMISSION_ENABLED": "true",
            "ASKLAKE_EMR_SERVERLESS_APPLICATION_ID": "00admissioncontract",
            "ASKLAKE_EMR_SERVERLESS_BATCH_MAX_CONCURRENT_RUNS": "1",
            "ASKLAKE_EMR_SERVERLESS_BATCH_MAX_QUEUED_RUNS": "1",
            "ASKLAKE_EMR_SERVERLESS_BATCH_MAX_VCPU": "80",
            "ASKLAKE_EMR_SERVERLESS_BATCH_MAX_MEMORY_GB": "320",
            "ASKLAKE_EMR_SERVERLESS_BATCH_MAX_DISK_GB": "2000",
            "ASKLAKE_EMR_SERVERLESS_BATCH_ACTOR_MAX_CONCURRENT_RUNS": "10",
            "ASKLAKE_EMR_SERVERLESS_BATCH_ACTOR_MAX_VCPU": "1000",
            "ASKLAKE_EMR_SERVERLESS_BATCH_ACTOR_MAX_MEMORY_GB": "1000",
            "ASKLAKE_EMR_SERVERLESS_BATCH_ACTOR_MAX_DISK_GB": "5000",
            "ASKLAKE_EMR_SERVERLESS_BATCH_PROJECT_MAX_CONCURRENT_RUNS": "10",
            "ASKLAKE_EMR_SERVERLESS_BATCH_PROJECT_MAX_VCPU": "1000",
            "ASKLAKE_EMR_SERVERLESS_BATCH_PROJECT_MAX_MEMORY_GB": "1000",
            "ASKLAKE_EMR_SERVERLESS_BATCH_PROJECT_MAX_DISK_GB": "5000",
            "ASKLAKE_EMR_SERVERLESS_VCPU_HOUR_USD": "0.10",
            "ASKLAKE_EMR_SERVERLESS_MEMORY_GB_HOUR_USD": "0.01",
            "ASKLAKE_EMR_SERVERLESS_DISK_GB_HOUR_USD": "0.001",
        })
        database_path = Path(temporary_dir) / "admission.sqlite3"
        engine = create_engine(
            f"sqlite+pysqlite:///{database_path}",
            connect_args={"check_same_thread": False, "timeout": 15},
        )
        sessions = sessionmaker(bind=engine, expire_on_commit=False)
        Base.metadata.create_all(
            engine,
            tables=[ETLJobModel.__table__, EmrAdmissionReservationModel.__table__],
        )
        emr_admission_repository.ensure_schema = lambda _db: None
        with sessions() as db:
            db.add_all([fixture_job(f"JOB-ADMISSION-{index}") for index in range(1, 7)])
            db.commit()

        barrier = Barrier(2)

        def reserve(index: int) -> str:
            with sessions() as db:
                job = db.get(ETLJobModel, f"JOB-ADMISSION-{index}")
                assert job is not None
                barrier.wait()
                reservation = reserve_emr_capacity(
                    db,
                    job=job,
                    workload="batch",
                    run_reference=f"run-{index}",
                    actor_key=f"actor-{index}",
                )
                assert reservation is not None
                return reservation.status

        with ThreadPoolExecutor(max_workers=2) as executor:
            decisions = sorted(executor.map(reserve, (1, 2)))
        assert decisions == ["admitted", "queued"], decisions

        with sessions() as db:
            job3 = db.get(ETLJobModel, "JOB-ADMISSION-3")
            assert job3 is not None
            try:
                reserve_emr_capacity(db, job=job3, workload="batch", run_reference="run-3", actor_key="actor-3")
                raise AssertionError("A full queue must reject a third reservation.")
            except ApiError as error:
                assert error.code == "EMR_ADMISSION_QUEUE_FULL"
                assert error.status_code == 429
                db.rollback()

            active = db.query(EmrAdmissionReservationModel).filter_by(status="admitted").one()
            sync_emr_reservation(db, active, {"runtimeJobId": "jr-contract", "runtime": {"state": "SUCCESS"}})
            released = reserve_emr_capacity(db, job=job3, workload="batch", run_reference="run-3", actor_key="actor-3")
            assert released is not None and released.status == "admitted"
            assert released.estimated_cost_usd_per_hour is not None

            capacity = runtime_capacity_overview(db, ActorContext(name="admin", role="admin"))
            batch_usage = next(item for item in capacity["usage"] if item["workload"] == "batch")
            assert batch_usage["activeRuns"] == 1
            assert batch_usage["queuedRuns"] == 1
            try:
                runtime_capacity_overview(db, ActorContext(name="viewer", role="viewer"))
                raise AssertionError("The capacity endpoint must require an admin actor.")
            except ApiError as error:
                assert error.status_code == 403

            db.execute(delete(EmrAdmissionReservationModel))
            db.commit()
            job4 = db.get(ETLJobModel, "JOB-ADMISSION-4")
            assert job4 is not None
            failed_attempt = reserve_emr_capacity(db, job=job4, workload="batch", run_reference="retryable-run", actor_key="retry-actor")
            assert failed_attempt is not None
            sync_emr_reservation(db, failed_attempt, {"runtimeJobId": "jr-failed", "runtime": {"state": "FAILED"}})
            retried_attempt = reserve_emr_capacity(db, job=job4, workload="batch", run_reference="retryable-run", actor_key="retry-actor")
            assert retried_attempt is not None and retried_attempt.status == "admitted"

            db.execute(delete(EmrAdmissionReservationModel))
            db.commit()
            os.environ["ASKLAKE_EMR_SERVERLESS_BATCH_ACTOR_MAX_CONCURRENT_RUNS"] = "1"
            job5 = db.get(ETLJobModel, "JOB-ADMISSION-5")
            assert job4 is not None and job5 is not None
            reserve_emr_capacity(db, job=job4, workload="batch", run_reference="run-4", actor_key="quota-actor")
            try:
                reserve_emr_capacity(db, job=job5, workload="batch", run_reference="run-5", actor_key="quota-actor")
                raise AssertionError("Actor quota must reject the second reservation.")
            except ApiError as error:
                assert error.code == "EMR_ADMISSION_QUOTA_EXCEEDED"
                db.rollback()

            db.execute(delete(EmrAdmissionReservationModel))
            db.commit()
            os.environ["ASKLAKE_EMR_SERVERLESS_BATCH_ACTOR_MAX_CONCURRENT_RUNS"] = "10"
            os.environ["ASKLAKE_EMR_SERVERLESS_BATCH_MAX_VCPU"] = "20"
            job6 = db.get(ETLJobModel, "JOB-ADMISSION-6")
            assert job6 is not None
            try:
                reserve_emr_capacity(db, job=job6, workload="batch", run_reference="run-6", actor_key="actor-6")
                raise AssertionError("A Job larger than the application policy must be rejected.")
            except ApiError as error:
                assert error.code == "EMR_ADMISSION_RESOURCE_LIMIT_EXCEEDED"
                assert error.status_code == 422
                db.rollback()

        engine.dispose()
        print("EMR admission persistence verified: concurrent slot/queue decision, overflow, quota, resource rejection, cost estimate, release, and admin projection.")
finally:
    os.environ.clear()
    os.environ.update(original_environment)
