#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import threading
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
    read_probe = None

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
            from app.schemas.etl import (
                ContinuousCompactionRequest,
                ContinuousIcebergMaintenanceRequest,
                CreatePipelineRequest,
            )
            from app.services.etl_service import (
                command_job,
                compact_kafka_continuous_target,
                create_pipeline,
                get_job,
                list_kafka_continuous_maintenance_runs,
                maintain_kafka_continuous_iceberg_target,
            )

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
            first_snapshot_id = current_snapshot_id(harness, target)
            assert time_travel_count(harness, target, first_snapshot_id) == 4

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
            read_probe = ConcurrentReadProbe(harness, target)
            read_probe.start()
            wait_for_count(SessionLocal, get_job, actor, job_id, 9)
            time.sleep(1)
            read_probe.stop()
            read_probe.assert_atomic_append(7, 9)
            read_probe = None
            assert harness.trino_scalar(target, "SELECT count(*)") == "9"
            assert_catalog(SessionLocal, etl_repository, dataset_id, expected_rows=9)
            final_snapshot_id = current_snapshot_id(harness, target)
            assert final_snapshot_id != first_snapshot_id
            assert time_travel_count(harness, target, first_snapshot_id) == 4
            assert time_travel_count(harness, target, final_snapshot_id) == 9

            command(SessionLocal, command_job, actor, job_id, "stopContinuous")
            wait_for_status(SessionLocal, get_job, actor, job_id, "stopped")
            checkpoint_before = read_job(SessionLocal, get_job, actor, job_id).continuous_runtime.checkpoint_path
            with SessionLocal() as db:
                compaction = compact_kafka_continuous_target(
                    db,
                    job_id,
                    ContinuousCompactionRequest(target_file_size_mb=128),
                    actor,
                )
            assert compaction.status == "success"
            assert compaction.result and compaction.result.get("queryEngineVerified") is True
            assert any(
                operation.get("operation") == "rewrite_data_files"
                for operation in compaction.result.get("operations", [])
            )
            assert harness.trino_scalar(target, "SELECT count(*)") == "9"
            assert time_travel_count(harness, target, first_snapshot_id) == 4

            with SessionLocal() as db:
                cleanup = maintain_kafka_continuous_iceberg_target(
                    db,
                    job_id,
                    ContinuousIcebergMaintenanceRequest(
                        rewrite_data_files=False,
                        expire_snapshots=True,
                        snapshot_retention_hours=24,
                        retain_last_snapshots=10,
                        remove_orphan_files=True,
                        orphan_retention_hours=72,
                    ),
                    actor,
                )
            assert cleanup.status == "success"
            assert cleanup.result and cleanup.result.get("queryEngineVerified") is True
            assert [
                operation.get("operation")
                for operation in cleanup.result.get("operations", [])
            ] == ["expire_snapshots", "remove_orphan_files"]
            assert harness.trino_scalar(target, "SELECT count(*)") == "9"
            assert time_travel_count(harness, target, first_snapshot_id) == 4

            maintained_job = read_job(SessionLocal, get_job, actor, job_id)
            assert maintained_job.continuous_runtime.checkpoint_path == checkpoint_before
            assert maintained_job.continuous_runtime.stored_count == 9
            with SessionLocal() as db:
                maintenance_runs = list_kafka_continuous_maintenance_runs(db, job_id, actor)
            successful_kinds = {run.kind for run in maintenance_runs if run.status == "success"}
            assert {"compaction", "iceberg_maintenance"}.issubset(successful_kinds)
        finally:
            if read_probe is not None:
                read_probe.stop()
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


class ConcurrentReadProbe:
    def __init__(self, harness, target: dict) -> None:
        self.harness = harness
        self.target = target
        self.counts: list[int] = []
        self.errors: list[str] = []
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="asklake-continuous-read-probe", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._thread.join(timeout=130)
        if self._thread.is_alive():
            raise AssertionError("Concurrent Trino read probe did not stop.")

    def assert_atomic_append(self, before_count: int, after_count: int) -> None:
        if self.errors:
            raise AssertionError(f"Concurrent Trino read failed: {self.errors[0]}")
        if not self.counts:
            raise AssertionError("Concurrent Trino read did not collect a sample.")
        if any(count not in {before_count, after_count} for count in self.counts):
            raise AssertionError(f"Concurrent read observed a partial Iceberg commit: {self.counts}")
        if any(current < previous for previous, current in zip(self.counts, self.counts[1:])):
            raise AssertionError(f"Concurrent read row count regressed: {self.counts}")

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                self.counts.append(int(self.harness.trino_scalar(self.target, "SELECT count(*)")))
            except Exception as exc:
                self.errors.append(str(exc))
                return
            self._stop.wait(0.25)


def qualified_table(target: dict, *, suffix: str = "") -> str:
    table = f'{target["table"]}{suffix}'
    return ".".join(
        f'"{str(value).replace(chr(34), chr(34) * 2)}"'
        for value in (target["catalog"], target["namespace"], table)
    )


def trino_query_scalar(harness, query: str) -> str:
    completed = subprocess.run(
        [
            "docker", "exec", harness.TRINO_CONTAINER, "trino",
            "--output-format", "CSV", "--execute", query,
        ],
        text=True,
        capture_output=True,
        timeout=120,
    )
    if completed.returncode != 0:
        raise RuntimeError(f"Trino query failed: {completed.stderr or completed.stdout}")
    return completed.stdout.strip().strip('"')


def current_snapshot_id(harness, target: dict) -> str:
    snapshot_id = trino_query_scalar(
        harness,
        f"SELECT snapshot_id FROM {qualified_table(target, suffix='$refs')} "
        "WHERE name = 'main' LIMIT 1",
    )
    if not snapshot_id.isdigit():
        raise AssertionError(f"Invalid Iceberg snapshot ID: {snapshot_id}")
    return snapshot_id


def time_travel_count(harness, target: dict, snapshot_id: str) -> int:
    return int(trino_query_scalar(
        harness,
        f"SELECT count(*) FROM {qualified_table(target)} FOR VERSION AS OF {int(snapshot_id)}",
    ))


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
