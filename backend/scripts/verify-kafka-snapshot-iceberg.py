#!/usr/bin/env python3
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import uuid


BACKEND_DIR = Path(__file__).resolve().parents[1]
NETWORK = ""
REDPANDA_CONTAINER = ""
TRINO_CONTAINER = ""
SPARK_MASTER_CONTAINER = ""
SPARK_WORKER_CONTAINER = ""
SPARK_OUTPUT_VOLUME = ""


def main() -> None:
    global NETWORK, REDPANDA_CONTAINER, TRINO_CONTAINER
    global SPARK_MASTER_CONTAINER, SPARK_WORKER_CONTAINER, SPARK_OUTPUT_VOLUME
    if os.environ.get("ASKLAKE_VERIFY_ICEBERG_LIVE", "").lower() not in {"1", "true", "yes", "on"}:
        print("verify-kafka-snapshot-iceberg: skipped (set ASKLAKE_VERIFY_ICEBERG_LIVE=true)")
        return
    require_command("docker")
    NETWORK = container_network("asklake-postgres")
    suffix = uuid.uuid4().hex[:10]
    REDPANDA_CONTAINER = f"asklake-phase3-redpanda-{suffix}"
    TRINO_CONTAINER = f"asklake-phase3-trino-{suffix}"
    SPARK_MASTER_CONTAINER = f"asklake-phase3-spark-master-{suffix}"
    SPARK_WORKER_CONTAINER = f"asklake-phase3-spark-worker-{suffix}"
    SPARK_OUTPUT_VOLUME = f"asklake-phase3-spark-output-{suffix}"
    topic = f"reviews.phase3.{suffix}"
    group_id = f"asklake-phase3-{suffix}"
    target_dataset = f"reviews_phase3_{suffix}"
    job_id = ""
    dataset_id = ""
    target = None

    with tempfile.TemporaryDirectory(prefix="asklake-kafka-snapshot-iceberg-") as report_dir:
        try:
            start_redpanda()
            trino_port = start_test_trino()
            configure_runtime(report_dir, trino_port)
            create_topic(topic)
            produce(topic, [
                review_event(f"phase3-{suffix}-1", 1, "first snapshot review"),
                review_event(f"phase3-{suffix}-2", 2, "second snapshot review"),
            ])

            from app.core.database import SessionLocal
            from app.core.auth_context import ActorContext
            from app.schemas.etl import CreatePipelineRequest
            from app.services.etl_service import command_job, create_pipeline
            from app.services.iceberg_writer_service import IcebergWriterService
            from app.repositories import etl_repository

            actor = ActorContext(name="Phase 3 Verifier", role="admin")
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

                os.environ["ASKLAKE_KAFKA_SNAPSHOT_FAIL_BEFORE_OFFSET_COMMIT"] = "true"
                failed = command_job(db, job_id, "run", actor)
                assert failed.run and failed.run.status == "failed"
                failed_snapshot = (failed.run.task_states or {}).get("kafkaSnapshot") or {}
                assert failed_snapshot.get("snapshotId")
                assert trino_scalar(target, "SELECT count(*)") == "2"

                os.environ.pop("ASKLAKE_KAFKA_SNAPSHOT_FAIL_BEFORE_OFFSET_COMMIT", None)
                retried = command_job(db, job_id, "retry", actor)
                if not retried.run or retried.run.status != "success":
                    raise AssertionError(
                        "Kafka Snapshot retry failed: "
                        + retried.model_dump_json(by_alias=True, exclude_none=True)
                    )
                assert (retried.run.task_states or {}).get("metadataUpdate", {}).get("status") == "success"
                assert retried.dataset and retried.dataset.storage_format == "iceberg"
                catalog_model = etl_repository.get_dataset_by_id(db, dataset_id)
                assert catalog_model and catalog_model.payload.get("queryEngineStatus") == "available"
                assert catalog_model.payload.get("queryEngineTable", {}).get("format") == "iceberg"
                assert retried.dataset.rows == "2행"
                assert len(retried.dataset.materialization_runs) == 1
                materialization = retried.dataset.materialization_runs[0]
                assert materialization.get("kafkaSnapshot", {}).get("snapshotId") == failed_snapshot["snapshotId"]
                assert materialization.get("materializationMode") == "snapshot"
                assert trino_scalar(target, "SELECT count(*)") == "2"

                empty = command_job(db, job_id, "run", actor)
                assert empty.run and empty.run.status == "success"
                assert empty.run.output_rows == "0행"
                assert trino_scalar(target, "SELECT count(*)") == "2"

                IcebergWriterService().drop_table(
                    __import__("app.schemas.iceberg", fromlist=["IcebergWriterTarget"]).IcebergWriterTarget.model_validate(target)
                )
                cleanup_metadata(db, job_id, dataset_id)
                target = None
        finally:
            os.environ.pop("ASKLAKE_KAFKA_SNAPSHOT_FAIL_BEFORE_OFFSET_COMMIT", None)
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
                        cleanup_metadata(cleanup_db, job_id, dataset_id)
                except Exception:
                    pass
            stop_container(SPARK_WORKER_CONTAINER)
            stop_container(SPARK_MASTER_CONTAINER)
            stop_container(TRINO_CONTAINER)
            stop_container(REDPANDA_CONTAINER)
            if SPARK_OUTPUT_VOLUME:
                subprocess.run(
                    ["docker", "volume", "rm", "-f", SPARK_OUTPUT_VOLUME],
                    text=True,
                    capture_output=True,
                    timeout=30,
                )
    print("verify-kafka-snapshot-iceberg: ok")


def configure_runtime(report_dir: str, trino_port: int) -> None:
    os.environ.update({
        "APP_ENV": "development",
        "ASKLAKE_DOCKER_NETWORK": NETWORK,
        "ASKLAKE_ENABLE_KAFKA_TEST_HOOKS": "true",
        "ASKLAKE_KAFKA_BROKER": "127.0.0.1:19092",
        "ASKLAKE_OBJECT_STORAGE_PROVIDER": "minio",
        "ASKLAKE_SPARK_EXECUTION_MODE": "docker",
        "ASKLAKE_SPARK_HOST_SCRIPTS_DIR": str(BACKEND_DIR / "scripts"),
        "ASKLAKE_SPARK_ICEBERG_CATALOG_NAME": "asklake",
        "ASKLAKE_SPARK_ICEBERG_JDBC_PASSWORD": "asklake_dev",
        "ASKLAKE_SPARK_ICEBERG_JDBC_URL": "jdbc:postgresql://postgres:5432/asklake",
        "ASKLAKE_SPARK_ICEBERG_JDBC_USER": "asklake",
        "ASKLAKE_SPARK_ICEBERG_WAREHOUSE": "s3a://asklake-warehouse/warehouse",
        "ASKLAKE_SPARK_MASTER_CONTAINER": SPARK_MASTER_CONTAINER,
        "ASKLAKE_SPARK_MASTER_URL": f"spark://{SPARK_MASTER_CONTAINER}:7077",
        "ASKLAKE_SPARK_OUTPUT_BUCKET": "asklake-output",
        "ASKLAKE_SPARK_OUTPUT_MODE": "s3a",
        "ASKLAKE_SPARK_OUTPUT_VOLUME": SPARK_OUTPUT_VOLUME,
        "ASKLAKE_SPARK_PUBLISH_UI": "false",
        "ASKLAKE_SPARK_REPORT_DIR": report_dir,
        "ASKLAKE_SPARK_WORKER_CONTAINER": SPARK_WORKER_CONTAINER,
        "DATABASE_URL": "postgresql+psycopg://asklake:asklake_dev@127.0.0.1:54328/asklake",
        "MINIO_ACCESS_KEY": "m3admin",
        "MINIO_ENDPOINT": "http://127.0.0.1:9000",
        "MINIO_ENDPOINT_IN_DOCKER": "http://minio:9000",
        "MINIO_SECRET_KEY": "wishuponastar",
        "TRINO_BASE_URL": f"http://127.0.0.1:{trino_port}",
        "TRINO_CATALOG": "iceberg",
        "TRINO_ENABLED": "true",
        "TRINO_ICEBERG_JDBC_DATABASE": "asklake",
        "TRINO_ICEBERG_JDBC_PASSWORD": "asklake_dev",
        "TRINO_ICEBERG_JDBC_USER": "asklake",
        "TRINO_ICEBERG_WAREHOUSE_BUCKET": "asklake-warehouse",
        "TRINO_ICEBERG_WAREHOUSE_PREFIX": "warehouse",
        "TRINO_SCHEMA": "asklake",
    })


def job_payload(topic: str, group_id: str, target_dataset: str, suffix: str) -> dict:
    return {
        "id": f"kafka-phase3-{suffix}",
        "jobName": f"Kafka Phase 3 {suffix}",
        "owner": "data-team-01",
        "permissionSummary": "Data Engineer Group",
        "ruleContractVersion": "1.0",
        "rules": [],
        "scheduleLabel": "수동",
        "schemaColumns": [
            schema_column("schema_version", "String"),
            schema_column("event_id", "String"),
            schema_column("source", "String"),
            schema_column("offset", "Long"),
            schema_column("review", "String"),
            schema_column("created_at", "String"),
        ],
        "schemaFingerprint": f"schema-phase3-{suffix}",
        "schemaSummary": "Kafka Phase 3 fixture",
        "sourceConfig": [
            ["Stream Type", "Apache Kafka"],
            ["Broker / Endpoint", "127.0.0.1:19092"],
            ["TOPIC / QUEUE NAME", topic],
            ["CONSUMER GROUP ID", group_id],
            ["Batch Max Messages (per partition)", "100"],
            ["Timeout Ms", "30000"],
            ["Offset Policy", "Earliest (Start from beginning)"],
        ],
        "sourceLabel": topic,
        "sourceType": "Stream / Kafka",
        "storagePath": f"s3://asklake-output/{target_dataset}/bronze",
        "storageType": "S3",
        "targetDataset": target_dataset,
        "targetFormat": "jsonl",
        "targetLayer": "BRONZE",
    }


def schema_column(name: str, logical_type: str) -> dict:
    return {
        "included": True,
        "nullable": False,
        "sourceName": name,
        "targetName": name,
        "type": logical_type,
    }


def review_event(event_id: str, offset: int, review: str) -> dict:
    return {
        "created_at": "2026-07-14T00:00:00Z",
        "event_id": event_id,
        "offset": offset,
        "review": review,
        "schema_version": "1.0",
        "source": "phase3-verifier",
    }


def start_redpanda() -> None:
    command = [
        "docker", "run", "-d", "--rm", "--name", REDPANDA_CONTAINER,
        "--network", NETWORK, "--network-alias", "redpanda", "-p", "19092:19092",
        "redpandadata/redpanda:v24.3.1", "redpanda", "start", "--overprovisioned",
        "--smp", "1", "--memory", "1G", "--reserve-memory", "0M", "--node-id", "0",
        "--check=false", "--kafka-addr", "internal://0.0.0.0:9092,external://0.0.0.0:19092",
        "--advertise-kafka-addr", "internal://redpanda:9092,external://127.0.0.1:19092",
    ]
    run_checked(command, "Redpanda could not start")
    wait_for_container_command(
        REDPANDA_CONTAINER,
        ["rpk", "cluster", "health", "--api-urls", "localhost:9644"],
        "Redpanda did not become ready",
    )


def start_test_trino() -> int:
    catalog_dir = BACKEND_DIR.parent / "deploy" / "trino" / "etc" / "catalog"
    command = [
        "docker", "run", "-d", "--rm", "--name", TRINO_CONTAINER, "--network", NETWORK,
        "-p", "127.0.0.1::8080",
        "-e", "TRINO_ICEBERG_CATALOG_NAME=asklake",
        "-e", "TRINO_ICEBERG_JDBC_DATABASE=asklake",
        "-e", "TRINO_ICEBERG_JDBC_PASSWORD=asklake_dev",
        "-e", "TRINO_ICEBERG_JDBC_USER=asklake",
        "-e", "TRINO_ICEBERG_WAREHOUSE_BUCKET=asklake-warehouse",
        "-e", "TRINO_ICEBERG_WAREHOUSE_PREFIX=warehouse",
        "-e", "TRINO_S3_ACCESS_KEY=m3admin",
        "-e", "TRINO_S3_ENDPOINT=http://minio:9000",
        "-e", "TRINO_S3_REGION=us-east-1",
        "-e", "TRINO_S3_SECRET_KEY=wishuponastar",
        "-v", f"{catalog_dir}:/etc/trino/catalog:ro",
        os.environ.get("TRINO_IMAGE", "trinodb/trino:482"),
    ]
    run_checked(command, "Test Trino could not start")
    wait_for_container_command(
        TRINO_CONTAINER,
        ["trino", "--execute", "SHOW CATALOGS"],
        "Test Trino did not become ready",
        required_output="iceberg",
    )
    port = subprocess.check_output(
        ["docker", "port", TRINO_CONTAINER, "8080/tcp"],
        text=True,
    ).strip().rsplit(":", 1)[-1]
    return int(port)


def create_topic(topic: str) -> None:
    run_checked(
        ["docker", "exec", REDPANDA_CONTAINER, "rpk", "topic", "create", topic, "--partitions", "1"],
        "Kafka topic could not be created",
    )


def produce(topic: str, records: list[dict]) -> None:
    completed = subprocess.run(
        ["docker", "exec", "-i", REDPANDA_CONTAINER, "rpk", "topic", "produce", topic],
        input="".join(f"{json.dumps(record)}\n" for record in records),
        text=True,
        capture_output=True,
        timeout=60,
    )
    if completed.returncode != 0:
        raise RuntimeError(f"Kafka fixture produce failed: {completed.stderr or completed.stdout}")


def trino_scalar(target: dict, select_sql: str) -> str:
    query = (
        f'{select_sql} FROM "{target["catalog"]}"."{target["namespace"]}".'
        f'"{target["table"]}"'
    )
    completed = subprocess.run(
        ["docker", "exec", TRINO_CONTAINER, "trino", "--output-format", "CSV", "--execute", query],
        text=True,
        capture_output=True,
        timeout=120,
    )
    if completed.returncode != 0:
        raise RuntimeError(f"Trino query failed: {completed.stderr or completed.stdout}")
    return completed.stdout.strip().strip('"')


def cleanup_metadata(db, job_id: str, dataset_id: str) -> None:
    from sqlalchemy import delete
    from app.models.catalog import CatalogDatasetModel
    from app.models.etl import ETLJobModel, ETLRunModel, KafkaSnapshotModel

    db.execute(delete(KafkaSnapshotModel).where(KafkaSnapshotModel.job_id == job_id))
    db.execute(delete(ETLRunModel).where(ETLRunModel.job_id == job_id))
    db.execute(delete(ETLJobModel).where(ETLJobModel.id == job_id))
    if dataset_id:
        db.execute(delete(CatalogDatasetModel).where(CatalogDatasetModel.id == dataset_id))
    db.commit()


def container_network(container: str) -> str:
    output = subprocess.check_output([
        "docker", "inspect", "-f",
        "{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{\"\\n\"}}{{end}}",
        container,
    ], text=True)
    network = next((line.strip() for line in output.splitlines() if line.strip()), "")
    if not network:
        raise RuntimeError(f"No Docker network found for {container}")
    return network


def wait_for_container_command(
    container: str,
    command: list[str],
    message: str,
    *,
    required_output: str = "",
) -> None:
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        completed = subprocess.run(
            ["docker", "exec", container, *command],
            text=True,
            capture_output=True,
            timeout=20,
        )
        if completed.returncode == 0 and required_output in completed.stdout:
            return
        time.sleep(2)
    logs = subprocess.run(
        ["docker", "logs", "--tail", "200", container],
        text=True,
        capture_output=True,
    )
    raise RuntimeError(f"{message}: {logs.stdout or logs.stderr}")


def run_checked(command: list[str], message: str) -> None:
    completed = subprocess.run(command, text=True, capture_output=True, timeout=120)
    if completed.returncode != 0:
        raise RuntimeError(f"{message}: {completed.stderr or completed.stdout}")


def stop_container(container: str) -> None:
    if container:
        subprocess.run(
            ["docker", "rm", "-f", container],
            text=True,
            capture_output=True,
            timeout=30,
        )


def require_command(command: str) -> None:
    if shutil.which(command) is None:
        raise RuntimeError(f"Required command is not installed: {command}")


if __name__ == "__main__":
    main()
