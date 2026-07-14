#!/usr/bin/env python3
"""Run explicit, isolated production Job E2E checks inside the backend container.

This is intentionally opt-in. It exercises the deployed execution paths and
only creates resources with the ``asklake-production-smoke/`` prefix or a
unique ``asklake.production.smoke.*`` Kafka topic. Cleanup never enumerates or
deletes a user-provided target, topic, or dataset.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlparse

from sqlalchemy import delete

from app.core.auth_context import ActorContext
from app.core.config import settings
from app.core.database import SessionLocal
from app.models.catalog import CatalogDatasetModel
from app.schemas.etl import CreatePipelineRequest
from app.schemas.iceberg import IcebergWriterTarget
from app.services.etl_service import command_job, create_pipeline, delete_job, get_job
from app.services.iceberg_writer_service import IcebergWriterService


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def enabled(name: str) -> bool:
    return str(os.environ.get(name) or "").strip().casefold() in {"1", "true", "yes", "on"}


def broker() -> str:
    value = str(os.environ.get("ASKLAKE_KAFKA_BROKER") or "").strip()
    require(value, "ASKLAKE_KAFKA_BROKER is required")
    return value


def raw_bucket() -> str:
    value = str(os.environ.get("ASKLAKE_RAW_BUCKET") or "").strip()
    require(value, "ASKLAKE_RAW_BUCKET is required for the generic batch fixture")
    return value


def timeout_seconds() -> int:
    raw = str(os.environ.get("ASKLAKE_PRODUCTION_JOB_E2E_TIMEOUT_SECONDS") or "900").strip()
    try:
        value = int(raw)
    except ValueError as error:
        raise RuntimeError("ASKLAKE_PRODUCTION_JOB_E2E_TIMEOUT_SECONDS must be an integer between 60 and 3600") from error
    if not 60 <= value <= 3600:
        raise RuntimeError("ASKLAKE_PRODUCTION_JOB_E2E_TIMEOUT_SECONDS must be an integer between 60 and 3600")
    return value


@dataclass
class CreatedResource:
    job_id: str
    dataset_id: str
    target: dict[str, Any]
    continuous: bool = False


@dataclass
class SmokeResources:
    suffix: str
    source_key: str
    topics: list[str] = field(default_factory=list)
    jobs: list[CreatedResource] = field(default_factory=list)


def main() -> None:
    require(enabled("ASKLAKE_RUN_PRODUCTION_JOB_E2E"), "Set ASKLAKE_RUN_PRODUCTION_JOB_E2E=true to run production Job E2E smoke")
    require(settings.app_env.casefold() == "production", "Production Job E2E requires APP_ENV=production")
    require(settings.asklake_object_storage_provider == "aws", "Production Job E2E requires AWS object storage")
    require(settings.trino_enabled, "Production Job E2E requires TRINO_ENABLED=true")
    require(str(os.environ.get("ASKLAKE_SPARK_RUNNER") or "").casefold() == "rest", "Production Job E2E requires ASKLAKE_SPARK_RUNNER=rest")

    suffix = uuid.uuid4().hex[:12]
    resources = SmokeResources(suffix=suffix, source_key=f"asklake-production-smoke/{suffix}/generic.jsonl")
    actor = ActorContext(name="AskLake Production Job Smoke", role="admin")
    started_at = time.monotonic()
    results: dict[str, Any] = {}
    try:
        put_generic_fixture(resources.source_key, suffix)
        results["genericBatch"] = run_generic_batch(resources, actor)
        results["kafkaSnapshot"] = run_kafka_snapshot(resources, actor)
        results["kafkaContinuous"] = run_kafka_continuous(resources, actor)
    finally:
        cleanup(resources, actor)
    print(json.dumps({"ok": True, "results": results, "seconds": round(time.monotonic() - started_at, 2)}, sort_keys=True))


def put_generic_fixture(key: str, suffix: str) -> None:
    from app.services.etl_service import build_catalog_s3_client

    body = "\n".join([
        json.dumps({"event_id": f"batch-{suffix}-1", "created_at": "2026-07-14T00:00:00Z", "review": "production batch one"}),
        json.dumps({"event_id": f"batch-{suffix}-2", "created_at": "2026-07-14T00:01:00Z", "review": "production batch two"}),
    ]) + "\n"
    build_catalog_s3_client().put_object(Bucket=raw_bucket(), Key=key, Body=body.encode("utf-8"), ContentType="application/x-ndjson")


def run_generic_batch(resources: SmokeResources, actor: ActorContext) -> dict[str, Any]:
    target_dataset = f"production_smoke_batch_{resources.suffix}"
    request = CreatePipelineRequest.model_validate({
        "id": f"production-smoke-batch-{resources.suffix}",
        "jobName": f"production_smoke_batch_{resources.suffix}",
        "owner": "data-team-01",
        "sourceType": "File / S3",
        "sourceLabel": f"{raw_bucket()}/{resources.source_key}",
        "sourceConfig": [["Bucket / Stage Name", raw_bucket()], ["Path / Prefix", resources.source_key], ["File Type", "JSONL"]],
        "schemaColumns": schema_columns(),
        "scheduleLabel": "수동",
        "targetDataset": target_dataset,
        "targetLayer": "SILVER",
        "targetFormat": "Parquet",
        "storagePath": f"s3a://{os.environ['ASKLAKE_SPARK_OUTPUT_BUCKET']}/{target_dataset}/silver/",
    })
    return create_and_run(resources, actor, request, label="generic batch", command="run", expected_rows=2)


def run_kafka_snapshot(resources: SmokeResources, actor: ActorContext) -> dict[str, Any]:
    topic = f"asklake.production.smoke.snapshot.{resources.suffix}"
    resources.topics.append(topic)
    produce(topic, kafka_events(resources.suffix, "snapshot", 2))
    target_dataset = f"production_smoke_snapshot_{resources.suffix}"
    request = CreatePipelineRequest.model_validate({
        "id": f"production-smoke-snapshot-{resources.suffix}",
        "jobName": f"production_smoke_snapshot_{resources.suffix}",
        "owner": "data-team-01",
        "sourceType": "Stream / Kafka",
        "sourceLabel": topic,
        "sourceConfig": kafka_source_config(topic, f"asklake-production-smoke-snapshot-{resources.suffix}"),
        "schemaColumns": schema_columns(),
        "scheduleLabel": "수동",
        "targetDataset": target_dataset,
        "targetLayer": "SILVER",
        # Snapshot keeps the JSONL create-payload compatibility value while
        # the Job runtime still commits its final Dataset as Iceberg/Parquet.
        "targetFormat": "jsonl",
        "storagePath": f"s3a://{os.environ['ASKLAKE_SPARK_OUTPUT_BUCKET']}/{target_dataset}/silver/",
        "executionMode": "snapshot",
    })
    result = create_and_run(resources, actor, request, label="Kafka Snapshot", command="run", expected_rows=2)
    # A second run against the same consumer group must not append the completed snapshot.
    with SessionLocal() as db:
        duplicate = command_job(db, resources.jobs[-1].job_id, "run", actor)
    require(duplicate.run is not None, "Kafka Snapshot duplicate verification did not create a run")
    completed = wait_for_run(resources.jobs[-1].job_id, duplicate.run.run_id, expected_status="success")
    require(str(completed.output_rows or "") in {"0행", "0 rows", "0"}, "Kafka Snapshot retry consumed an already committed range")
    result["duplicateRetryRows"] = completed.output_rows
    return result


def run_kafka_continuous(resources: SmokeResources, actor: ActorContext) -> dict[str, Any]:
    topic = f"asklake.production.smoke.continuous.{resources.suffix}"
    resources.topics.append(topic)
    produce(topic, kafka_events(resources.suffix, "continuous", 2))
    target_dataset = f"production_smoke_continuous_{resources.suffix}"
    request = CreatePipelineRequest.model_validate({
        "id": f"production-smoke-continuous-{resources.suffix}",
        "jobName": f"production_smoke_continuous_{resources.suffix}",
        "owner": "data-team-01",
        "sourceType": "Stream / Kafka",
        "sourceLabel": topic,
        "sourceConfig": kafka_source_config(topic, f"asklake-production-smoke-continuous-{resources.suffix}"),
        "schemaColumns": schema_columns(),
        "scheduleLabel": "스케줄링 건너뛰기",
        "targetDataset": target_dataset,
        "targetLayer": "SILVER",
        "targetFormat": "Parquet",
        "storagePath": f"s3a://{os.environ['ASKLAKE_SPARK_OUTPUT_BUCKET']}/{target_dataset}/silver/",
        "executionMode": "continuous",
        "continuousConfig": {"initialOffsetPolicy": "earliest", "triggerIntervalSeconds": 2, "maxOffsetsPerTrigger": 100},
    })
    created = create_pipeline_with_resource(resources, actor, request, continuous=True)
    with SessionLocal() as db:
        command_job(db, created.job_id, "startContinuous", actor)
    completed = wait_for_continuous(created.job_id, expected_rows=2)
    assert_catalog_and_trino(created, 2)
    with SessionLocal() as db:
        command_job(db, created.job_id, "stopContinuous", actor)
    wait_for_continuous_status(created.job_id, "stopped")
    return {"catalogDatasetId": created.dataset_id, "rows": 2, "runtime": completed["runtime"]}


def create_and_run(resources: SmokeResources, actor: ActorContext, request: CreatePipelineRequest, *, label: str, command: str, expected_rows: int) -> dict[str, Any]:
    created = create_pipeline_with_resource(resources, actor, request)
    with SessionLocal() as db:
        response = command_job(db, created.job_id, command, actor)
    require(response.run is not None, f"{label} did not create a run")
    completed = wait_for_run(created.job_id, response.run.run_id, expected_status="success")
    assert_catalog_and_trino(created, expected_rows)
    return {"jobId": created.job_id, "rows": expected_rows, "runId": response.run.run_id, "status": completed.status}


def create_pipeline_with_resource(resources: SmokeResources, actor: ActorContext, request: CreatePipelineRequest, *, continuous: bool = False) -> CreatedResource:
    with SessionLocal() as db:
        response = create_pipeline(db, request, actor)
        job = __import__("app.repositories.etl_repository", fromlist=["get_job"]).get_job(db, response.job.id)
        require(job is not None and job.iceberg_target is not None and job.dataset_id, "Production smoke Job is missing Iceberg target metadata")
        created = CreatedResource(job_id=job.id, dataset_id=job.dataset_id, target=job.iceberg_target, continuous=continuous)
    resources.jobs.append(created)
    return created


def assert_catalog_and_trino(resource: CreatedResource, expected_rows: int) -> None:
    with SessionLocal() as db:
        dataset = __import__("app.repositories.etl_repository", fromlist=["get_dataset_by_id"]).get_dataset_by_id(db, resource.dataset_id)
        require(dataset is not None and (dataset.payload or {}).get("queryEngineStatus") == "available", "Catalog did not register an available Iceberg dataset")
    target = IcebergWriterTarget.model_validate(resource.target)
    writer = IcebergWriterService()
    writer.describe_table(target)
    rows = writer.query_rows(f'SELECT count(*) FROM "{target.catalog}"."{target.namespace}"."{target.table}"')
    require(rows and int(rows[0][0]) == expected_rows, f"Trino row count mismatch: expected {expected_rows}, received {rows}")


def wait_for_run(job_id: str, run_id: str, *, expected_status: str) -> Any:
    deadline = time.monotonic() + timeout_seconds()
    last = None
    while time.monotonic() < deadline:
        with SessionLocal() as db:
            job = get_job(db, job_id, ActorContext(name="AskLake Production Job Smoke", role="admin"))
        last = next((item for item in (job.run_history or []) if item.run_id == run_id), None)
        if last and last.status in {"success", "failed", "canceled"}:
            require(last.status == expected_status, f"Job run {run_id} finished as {last.status}: {last.error_summary}")
            return last
        time.sleep(3)
    raise RuntimeError(f"Timed out waiting for Job run {run_id}; last={last}")


def wait_for_continuous(job_id: str, *, expected_rows: int) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_seconds()
    while time.monotonic() < deadline:
        with SessionLocal() as db:
            job = get_job(db, job_id, ActorContext(name="AskLake Production Job Smoke", role="admin"))
        runtime = job.continuous_runtime
        if runtime and runtime.status == "failed":
            raise RuntimeError(f"Continuous worker failed: {runtime.last_error}")
        if runtime and runtime.stored_count >= expected_rows:
            return {"runtime": runtime.model_dump(mode="json")}
        time.sleep(3)
    raise RuntimeError(f"Timed out waiting for Continuous Job {job_id}")


def wait_for_continuous_status(job_id: str, expected: str) -> None:
    deadline = time.monotonic() + timeout_seconds()
    while time.monotonic() < deadline:
        with SessionLocal() as db:
            job = get_job(db, job_id, ActorContext(name="AskLake Production Job Smoke", role="admin"))
        if job.continuous_runtime and job.continuous_runtime.status == expected:
            return
        time.sleep(2)
    raise RuntimeError(f"Timed out waiting for Continuous Job {job_id} to become {expected}")


def schema_columns() -> list[dict[str, Any]]:
    return [
        {"included": True, "nullable": False, "sourceName": "event_id", "targetName": "event_id", "type": "String"},
        {"included": True, "nullable": False, "sourceName": "review", "targetName": "review", "type": "String"},
        {"included": True, "nullable": False, "sourceName": "created_at", "targetName": "created_at", "type": "Timestamp"},
    ]


def kafka_source_config(topic: str, group_id: str) -> list[list[str]]:
    return [["Stream Type", "Apache Kafka"], ["Broker / Endpoint", broker()], ["TOPIC / QUEUE NAME", topic], ["CONSUMER GROUP ID", group_id], ["Batch Max Messages (per partition)", "100"], ["Timeout Ms", "30000"], ["Offset Policy", "Earliest (Start from beginning)"]]


def kafka_events(suffix: str, kind: str, count: int) -> list[dict[str, Any]]:
    return [{"event_id": f"{kind}-{suffix}-{index}", "offset": index, "review": f"production {kind} {index}", "created_at": "2026-07-14T00:00:00Z"} for index in range(count)]


def produce(topic: str, records: list[dict[str, Any]]) -> None:
    program = """
import { Kafka } from 'kafkajs';
const kafka = new Kafka({ brokers: [process.env.ASKLAKE_KAFKA_BROKER], clientId: 'asklake-production-job-smoke' });
const admin = kafka.admin(); const producer = kafka.producer();
try { await admin.connect(); await admin.createTopics({ topics: [{ topic: process.env.TOPIC, numPartitions: 1, replicationFactor: 1 }], waitForLeaders: true }); await producer.connect(); await producer.send({ topic: process.env.TOPIC, messages: JSON.parse(process.env.RECORDS).map((value) => ({ value: JSON.stringify(value) })) }); }
finally { await producer.disconnect().catch(() => {}); await admin.disconnect().catch(() => {}); }
"""
    completed = subprocess.run(["node", "--input-type=module", "-e", program], text=True, capture_output=True, timeout=60, env={**os.environ, "ASKLAKE_KAFKA_BROKER": broker(), "TOPIC": topic, "RECORDS": json.dumps(records)})
    if completed.returncode != 0:
        raise RuntimeError(f"Kafka fixture produce failed: {(completed.stderr or completed.stdout).strip()}")


def cleanup(resources: SmokeResources, actor: ActorContext) -> None:
    errors: list[str] = []
    for resource in reversed(resources.jobs):
        try:
            if resource.continuous:
                with SessionLocal() as db:
                    job = get_job(db, resource.job_id, actor)
                    if job.continuous_runtime and job.continuous_runtime.status not in {"stopped", "failed"}:
                        command_job(db, resource.job_id, "stopContinuous", actor)
                wait_for_continuous_status(resource.job_id, "stopped")
            target = IcebergWriterTarget.model_validate(resource.target)
            writer = IcebergWriterService()
            warehouse_location = ""
            try:
                _snapshot_id, _committed_at, warehouse_location = writer.current_snapshot(target)
            except Exception:
                # A failed fixture may have no committed snapshot; DROP still removes
                # the catalog entry and the unique target name limits any residual scope.
                pass
            writer.drop_table(target)
            if warehouse_location:
                delete_s3_prefix(warehouse_location)
            with SessionLocal() as db:
                delete_job(db, resource.job_id, actor)
                db.execute(delete(CatalogDatasetModel).where(CatalogDatasetModel.id == resource.dataset_id))
                db.commit()
        except Exception as error:
            errors.append(f"job {resource.job_id}: {error}")
    try:
        from app.services.etl_service import build_catalog_s3_client
        build_catalog_s3_client().delete_object(Bucket=raw_bucket(), Key=resources.source_key)
    except Exception as error:
        errors.append(f"source fixture: {error}")
    for topic in resources.topics:
        try:
            delete_topic(topic)
        except Exception as error:
            errors.append(f"topic {topic}: {error}")
    if errors:
        raise RuntimeError("Production Job E2E cleanup failed: " + "; ".join(errors))


def delete_topic(topic: str) -> None:
    program = """
import { Kafka } from 'kafkajs';
const kafka = new Kafka({ brokers: [process.env.ASKLAKE_KAFKA_BROKER], clientId: 'asklake-production-job-smoke-cleanup' });
const admin = kafka.admin(); try { await admin.connect(); await admin.deleteTopics({ topics: [process.env.TOPIC] }); } finally { await admin.disconnect().catch(() => {}); }
"""
    completed = subprocess.run(["node", "--input-type=module", "-e", program], text=True, capture_output=True, timeout=60, env={**os.environ, "ASKLAKE_KAFKA_BROKER": broker(), "TOPIC": topic})
    if completed.returncode != 0:
        raise RuntimeError((completed.stderr or completed.stdout).strip())


def delete_s3_prefix(uri: str) -> None:
    parsed = urlparse(uri)
    require(parsed.scheme in {"s3", "s3a"} and parsed.netloc, f"Unexpected smoke warehouse URI: {uri}")
    prefix = parsed.path.lstrip("/").rstrip("/") + "/"
    # The prefix originates from the Iceberg target that this process created;
    # it is never accepted from a user argument.
    client = __import__("app.services.etl_service", fromlist=["build_catalog_s3_client"]).build_catalog_s3_client()
    continuation: str | None = None
    while True:
        request: dict[str, Any] = {"Bucket": parsed.netloc, "Prefix": prefix}
        if continuation:
            request["ContinuationToken"] = continuation
        response = client.list_objects_v2(**request)
        objects = [{"Key": item["Key"]} for item in response.get("Contents", []) if item.get("Key")]
        if objects:
            client.delete_objects(Bucket=parsed.netloc, Delete={"Objects": objects, "Quiet": True})
        if not response.get("IsTruncated"):
            return
        continuation = response.get("NextContinuationToken")
        require(bool(continuation), "S3 fixture cleanup received a truncated page without a continuation token")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"error": str(error), "ok": False}), file=sys.stderr)
        raise SystemExit(1) from error
