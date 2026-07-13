#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import time
import uuid


BACKEND_DIR = Path(__file__).resolve().parents[1]


def load_harness():
    path = Path(__file__).with_name("verify-kafka-snapshot-iceberg.py")
    spec = importlib.util.spec_from_file_location("asklake_snapshot_iceberg_harness", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load the shared Iceberg live-test harness.")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> None:
    if os.environ.get("ASKLAKE_VERIFY_ICEBERG_LIVE", "").lower() not in {"1", "true", "yes", "on"}:
        print("verify-kafka-continuous-iceberg: skipped (set ASKLAKE_VERIFY_ICEBERG_LIVE=true)")
        return

    harness = load_harness()
    harness.require_command("docker")
    suffix = uuid.uuid4().hex[:10]
    harness.NETWORK = harness.container_network("asklake-postgres")
    harness.REDPANDA_CONTAINER = f"asklake-phase4-redpanda-{suffix}"
    harness.TRINO_CONTAINER = f"asklake-phase4-trino-{suffix}"
    harness.SPARK_MASTER_CONTAINER = f"asklake-phase4-spark-master-{suffix}"
    harness.SPARK_WORKER_CONTAINER = f"asklake-phase4-spark-worker-{suffix}"
    harness.SPARK_OUTPUT_VOLUME = f"asklake-phase4-spark-output-{suffix}"
    topic = f"reviews.phase4.{suffix}"
    group_id = f"asklake-phase4-{suffix}"
    target_dataset = f"reviews_phase4_{suffix}"
    job_id = ""
    dataset_id = ""
    target = None
    actor = None

    with tempfile.TemporaryDirectory(prefix="asklake-kafka-continuous-iceberg-") as report_dir:
        try:
            harness.start_redpanda()
            trino_port = harness.start_test_trino()
            harness.configure_runtime(report_dir, trino_port)
            os.environ.update({
                "ASKLAKE_SPARK_RUNNER": "docker",
                "ASKLAKE_CONTINUOUS_WORKER_START_TIMEOUT_MS": "120000",
            })
            harness.create_topic(topic)
            harness.produce(topic, events(suffix, 0, 4))

            from app.core.auth_context import ActorContext
            from app.core.database import SessionLocal
            from app.repositories import etl_repository
            from app.schemas.etl import CreatePipelineRequest
            from app.services.etl_service import command_job, create_pipeline, get_job

            actor = ActorContext(name="Phase 4 Verifier", role="admin")
            with SessionLocal() as db:
                created = create_pipeline(
                    db,
                    CreatePipelineRequest.model_validate(
                        job_payload(topic, group_id, target_dataset, suffix)
                    ),
                    actor,
                )
                job_id = created.job.id
                stored_job = etl_repository.get_job(db, job_id)
                dataset_id = stored_job.dataset_id or ""
                target = stored_job.iceberg_target
                command_job(db, job_id, "startContinuous", actor)

            wait_for_count(SessionLocal, get_job, actor, job_id, 4)
            assert harness.trino_scalar(target, "SELECT count(*)") == "4"
            assert_catalog(SessionLocal, etl_repository, dataset_id, expected_rows=4)

            command(SessionLocal, command_job, actor, job_id, "stopContinuous")
            wait_for_status(SessionLocal, get_job, actor, job_id, "stopped")
            harness.produce(topic, events(suffix, 4, 3))
            os.environ["ASKLAKE_CONTINUOUS_FAIL_AFTER_DATA_WRITE_ONCE"] = "true"
            command(SessionLocal, command_job, actor, job_id, "resumeContinuous")
            wait_for_status(SessionLocal, get_job, actor, job_id, "failed")
            assert harness.trino_scalar(target, "SELECT count(*)") == "7"

            os.environ.pop("ASKLAKE_CONTINUOUS_FAIL_AFTER_DATA_WRITE_ONCE", None)
            command(SessionLocal, command_job, actor, job_id, "resumeContinuous")
            wait_for_count(SessionLocal, get_job, actor, job_id, 7)
            assert harness.trino_scalar(target, "SELECT count(*)") == "7"
            assert_catalog(SessionLocal, etl_repository, dataset_id, expected_rows=7)

            command(SessionLocal, command_job, actor, job_id, "stopContinuous")
            wait_for_status(SessionLocal, get_job, actor, job_id, "stopped")
            harness.produce(topic, events(suffix, 7, 2))
            command(SessionLocal, command_job, actor, job_id, "resumeContinuous")
            wait_for_count(SessionLocal, get_job, actor, job_id, 9)
            assert harness.trino_scalar(target, "SELECT count(*)") == "9"
            assert_catalog(SessionLocal, etl_repository, dataset_id, expected_rows=9)
        finally:
            os.environ.pop("ASKLAKE_CONTINUOUS_FAIL_AFTER_DATA_WRITE_ONCE", None)
            if job_id and actor is not None:
                try:
                    from app.core.database import SessionLocal
                    from app.services.etl_service import command_job

                    command(SessionLocal, command_job, actor, job_id, "stopContinuous")
                except Exception:
                    pass
            if target:
                try:
                    from app.schemas.iceberg import IcebergWriterTarget
                    from app.services.iceberg_writer_service import IcebergWriterService

                    IcebergWriterService().drop_table(IcebergWriterTarget.model_validate(target))
                except Exception:
                    pass
            if job_id:
                try:
                    from app.core.database import SessionLocal

                    with SessionLocal() as cleanup_db:
                        harness.cleanup_metadata(cleanup_db, job_id, dataset_id)
                except Exception:
                    pass
            harness.stop_container(harness.SPARK_WORKER_CONTAINER)
            harness.stop_container(harness.SPARK_MASTER_CONTAINER)
            harness.stop_container(harness.TRINO_CONTAINER)
            harness.stop_container(harness.REDPANDA_CONTAINER)
            subprocess.run(
                ["docker", "volume", "rm", "-f", harness.SPARK_OUTPUT_VOLUME],
                text=True,
                capture_output=True,
                timeout=30,
            )
    print("verify-kafka-continuous-iceberg: ok")


def job_payload(topic: str, group_id: str, target_dataset: str, suffix: str) -> dict:
    return {
        "id": f"kafka-phase4-{suffix}",
        "jobName": f"Kafka Phase 4 {suffix}",
        "owner": "data-team-01",
        "ruleContractVersion": "1.0",
        "rules": [],
        "scheduleLabel": "스케줄링 건너뛰기",
        "schemaColumns": [
            schema_column("event_id", "String"),
            schema_column("offset", "Long"),
            schema_column("review", "String"),
            schema_column("created_at", "String"),
        ],
        "schemaFingerprint": f"schema-phase4-{suffix}",
        "sourceConfig": [
            ["Stream Type", "Apache Kafka"],
            ["Broker / Endpoint", "redpanda:9092"],
            ["TOPIC / QUEUE NAME", topic],
            ["CONSUMER GROUP ID", group_id],
        ],
        "sourceLabel": topic,
        "sourceType": "Stream / Kafka",
        "storagePath": f"s3a://asklake-output/{target_dataset}/bronze",
        "storageType": "S3",
        "targetDataset": target_dataset,
        "targetFormat": "parquet",
        "targetLayer": "BRONZE",
        "executionMode": "continuous",
        "continuousConfig": {
            "initialOffsetPolicy": "earliest",
            "triggerIntervalSeconds": 2,
            "maxOffsetsPerTrigger": 100,
        },
    }


def schema_column(name: str, logical_type: str) -> dict:
    return {
        "included": True,
        "nullable": False,
        "sourceName": name,
        "targetName": name,
        "type": logical_type,
    }


def events(suffix: str, start: int, count: int) -> list[dict]:
    return [
        {
            "created_at": "2026-07-14T00:00:00Z",
            "event_id": f"phase4-{suffix}-{offset}",
            "offset": offset,
            "review": f"continuous iceberg review {offset}",
        }
        for offset in range(start, start + count)
    ]


def command(session_factory, command_job, actor, job_id: str, action: str) -> None:
    with session_factory() as db:
        command_job(db, job_id, action, actor)


def read_job(session_factory, get_job, actor, job_id: str):
    with session_factory() as db:
        return get_job(db, job_id, actor)


def wait_for_count(session_factory, get_job, actor, job_id: str, expected: int) -> None:
    wait_for(
        lambda: (job := read_job(session_factory, get_job, actor, job_id)).continuous_runtime
        and job.continuous_runtime.stored_count == expected
        and job.continuous_runtime.status == "running",
        f"Continuous stored count {expected}",
    )


def wait_for_status(session_factory, get_job, actor, job_id: str, expected: str) -> None:
    wait_for(
        lambda: (job := read_job(session_factory, get_job, actor, job_id)).continuous_runtime
        and job.continuous_runtime.status == expected,
        f"Continuous status {expected}",
    )


def wait_for(predicate, label: str, timeout_seconds: int = 300) -> None:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(2)
    raise AssertionError(f"Timed out waiting for {label}.")


def assert_catalog(session_factory, repository, dataset_id: str, *, expected_rows: int) -> None:
    with session_factory() as db:
        dataset = repository.get_dataset_by_id(db, dataset_id)
        assert dataset is not None
        payload = dataset.payload or {}
        assert payload.get("queryEngineStatus") == "available"
        assert payload.get("queryEngineTable", {}).get("format") == "iceberg"
        runs = payload.get("materializationRuns") or []
        assert len({run.get("runId") for run in runs}) == len(runs)
        assert sum(int(run.get("rowCount") or 0) for run in runs) == expected_rows


if __name__ == "__main__":
    main()
