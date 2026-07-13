from __future__ import annotations

import threading
import time
import uuid

from sqlalchemy import delete
from app.core.auth_context import ActorContext
from app.core.database import SessionLocal, engine
from app.core.errors import ApiError
from app.models import ETLJobModel, KafkaContinuousRuntimeModel, KafkaContinuousSessionModel
from app.repositories.etl_repository import (
    canonical_kafka_consumer_identity,
    lock_kafka_consumer_identity,
)
from app.services import etl_service


BROKER_A = "boot-b.example.amazonaws.com:9098,boot-a.example.amazonaws.com:9098"
BROKER_A_REORDERED = "boot-a.example.amazonaws.com:9098,boot-b.example.amazonaws.com:9098"
TOPIC = "asklake.staging.identity-lock-contract"
GROUP = "asklake-identity-lock-contract"


def main() -> None:
    if engine.dialect.name != "postgresql":
        print(f"verify-kafka-consumer-identity-lock: SKIPPED (requires PostgreSQL, found {engine.dialect.name})")
        return

    assert canonical_kafka_consumer_identity(BROKER_A, TOPIC, GROUP) == canonical_kafka_consumer_identity(
        BROKER_A_REORDERED,
        TOPIC,
        GROUP,
    )

    first = SessionLocal()
    same_identity_acquired = threading.Event()
    same_identity_finished = threading.Event()
    same_identity_error: list[BaseException] = []

    def acquire_same_identity() -> None:
        second = SessionLocal()
        try:
            lock_kafka_consumer_identity(
                second,
                broker=BROKER_A_REORDERED,
                topic=TOPIC,
                consumer_group_id=GROUP,
            )
            same_identity_acquired.set()
            second.commit()
        except BaseException as exc:  # noqa: BLE001 - surface thread failures in the verifier.
            same_identity_error.append(exc)
            second.rollback()
        finally:
            second.close()
            same_identity_finished.set()

    try:
        lock_kafka_consumer_identity(
            first,
            broker=BROKER_A,
            topic=TOPIC,
            consumer_group_id=GROUP,
        )
        thread = threading.Thread(target=acquire_same_identity, daemon=True)
        thread.start()
        time.sleep(0.25)
        assert not same_identity_acquired.is_set(), "The same Kafka identity must block until the first transaction commits."
        first.commit()
        assert same_identity_finished.wait(5), "The waiting Kafka identity lock did not resume after commit."
        assert not same_identity_error, same_identity_error
        assert same_identity_acquired.is_set()
    finally:
        first.rollback()
        first.close()

    different_first = SessionLocal()
    different_finished = threading.Event()
    different_error: list[BaseException] = []

    def acquire_different_identity() -> None:
        second = SessionLocal()
        try:
            lock_kafka_consumer_identity(
                second,
                broker=BROKER_A,
                topic=TOPIC,
                consumer_group_id=f"{GROUP}-fanout",
            )
            second.commit()
        except BaseException as exc:  # noqa: BLE001
            different_error.append(exc)
            second.rollback()
        finally:
            second.close()
            different_finished.set()

    try:
        lock_kafka_consumer_identity(
            different_first,
            broker=BROKER_A,
            topic=TOPIC,
            consumer_group_id=GROUP,
        )
        thread = threading.Thread(target=acquire_different_identity, daemon=True)
        thread.start()
        assert different_finished.wait(2), "A different consumer group must not wait on the first identity lock."
        assert not different_error, different_error
    finally:
        different_first.rollback()
        different_first.close()

    verify_single_submission_reservation()

    print("verify-kafka-consumer-identity-lock: ok")


def verify_single_submission_reservation() -> None:
    suffix = uuid.uuid4().hex[:12]
    job_ids = [f"IDENTITY-LOCK-{suffix}-A", f"IDENTITY-LOCK-{suffix}-B"]
    with SessionLocal() as setup:
        setup.add_all([new_job(job_id) for job_id in job_ids])
        setup.add_all([
            KafkaContinuousRuntimeModel(
                job_id=job_id,
                broker=BROKER_A,
                topic=TOPIC,
                consumer_group_id=GROUP,
                target_identity=f"s3a://asklake-output/{job_id.lower()}",
                checkpoint_path=f"s3a://asklake-output/{job_id.lower()}/_checkpoints/{job_id.lower()}",
                status="stopped",
            )
            for job_id in job_ids
        ])
        setup.commit()

    barrier = threading.Barrier(2)
    results: list[tuple[str, str]] = []
    errors: list[BaseException] = []
    result_lock = threading.Lock()
    start_job_run_calls: list[str] = []

    def start_job_run(job: ETLJobModel, _runtime: KafkaContinuousRuntimeModel, action: str) -> dict[str, object]:
        assert action == "start"
        with result_lock:
            start_job_run_calls.append(job.id)
            attempt = len(start_job_run_calls)
        # Keep the transaction lock held across the external side effect so the
        # competing request exercises the same boundary as production.
        time.sleep(0.1)
        return {
            "containerId": f"jr-identity-lock-{attempt}",
            "containerState": "running",
            "jobRunId": f"jr-identity-lock-{attempt}",
            "runtime": "emr-serverless",
            "workerAttemptId": f"attempt-identity-lock-{attempt}",
        }

    def reserve(job_id: str) -> None:
        db = SessionLocal()
        try:
            barrier.wait(timeout=5)
            job = db.get(ETLJobModel, job_id)
            assert job is not None
            etl_service.command_kafka_continuous_job(
                db,
                job,
                "startContinuous",
                ActorContext(name="identity-lock-contract", role="admin"),
            )
            with result_lock:
                results.append((job_id, "submitted"))
        except ApiError as exc:
            if exc.status_code != 409:
                raise
            with result_lock:
                results.append((job_id, "conflict"))
            db.rollback()
        except BaseException as exc:  # noqa: BLE001
            errors.append(exc)
            db.rollback()
        finally:
            db.close()

    threads = [threading.Thread(target=reserve, args=(job_id,), daemon=True) for job_id in job_ids]
    original_worker = etl_service.run_kafka_continuous_worker
    try:
        etl_service.run_kafka_continuous_worker = start_job_run
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=10)
        assert all(not thread.is_alive() for thread in threads), "Concurrent reservation threads did not finish."
        assert not errors, errors
        assert [result for _job_id, result in results].count("submitted") == 1, results
        assert [result for _job_id, result in results].count("conflict") == 1, results
        assert len(start_job_run_calls) == 1, f"Expected exactly one StartJobRun side effect: {start_job_run_calls}"
    finally:
        etl_service.run_kafka_continuous_worker = original_worker
        with SessionLocal() as cleanup:
            cleanup.execute(delete(KafkaContinuousSessionModel).where(KafkaContinuousSessionModel.job_id.in_(job_ids)))
            cleanup.execute(delete(KafkaContinuousRuntimeModel).where(KafkaContinuousRuntimeModel.job_id.in_(job_ids)))
            cleanup.execute(delete(ETLJobModel).where(ETLJobModel.id.in_(job_ids)))
            cleanup.commit()


def new_job(job_id: str) -> ETLJobModel:
    return ETLJobModel(
        id=job_id,
        name=job_id,
        owner="contract-test",
        status="stopped",
        tag="[test]",
        source="Kafka",
        target=f"target-{job_id.lower()}",
        schedule="manual",
        source_config=[],
        source_label="Kafka contract",
        source_type="Stream / Kafka",
        execution_mode="continuous",
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


if __name__ == "__main__":
    main()
