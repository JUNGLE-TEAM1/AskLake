from __future__ import annotations

import hashlib
import json
import os
import ssl
import threading
import time
from datetime import datetime, timezone
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from sqlalchemy import func, select

from app.core.auth_context import ActorContext
from app.core.config import settings
from app.core.database import SessionLocal
from app.models import (
    CatalogDatasetModel,
    ETLJobModel,
    ETLRunModel,
    KafkaContinuousRuntimeModel,
    KafkaContinuousSessionModel,
)
from app.repositories import etl_repository
from app.schemas.iceberg import IcebergWriterTarget
from app.services.airflow_client import build_airflow_client
from app.services.airflow_client import path_segment
from app.services.etl_service import (
    command_job,
    get_job,
    sync_airflow_run,
)
from app.services.iceberg_writer_service import (
    IcebergWriterService,
    qualified_identifier,
)
from scripts.kafka_fixture_slots import EKS_MVP_FIXTURE_CONSUMER_GROUP


BATCH_FIELD = "__EKS MVP Fixture Batch ID"
COUNT_FIELD = "__EKS MVP Expected Count"
TERMINAL_STATUSES = {"success", "failed", "cancelled"}
FIXTURE_TOPIC = "asklake.eks-mvp.fixture.v1"


def required(name: str) -> str:
    value = str(os.environ.get(name) or "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def short_hash(value: object) -> str:
    return hashlib.sha256(str(value or "").encode("utf-8")).hexdigest()[:12]


def replace_field(fields: list[list[str]], label: str, value: str) -> list[list[str]]:
    result: list[list[str]] = []
    replaced = False
    for item in fields:
        if len(item) >= 2 and str(item[0]) == label:
            result.append([label, value])
            replaced = True
        else:
            result.append(list(item))
    if not replaced:
        result.append([label, value])
    return result


def field_value(fields: list[list[str]], *labels: str) -> str:
    wanted = set(labels)
    for item in fields:
        if len(item) >= 2 and str(item[0]) in wanted:
            return str(item[1] or "").strip()
    return ""


def fixture_consumer_group(job: ETLJobModel) -> str:
    return field_value(
        job.source_config or [],
        "CONSUMER GROUP ID",
        "Consumer Group ID",
    )


def fixture_target(job: ETLJobModel) -> IcebergWriterTarget:
    return IcebergWriterTarget.model_validate(job.iceberg_target)


def fixture_jobs(db) -> list[ETLJobModel]:
    """Find the deployed bounded Job from persisted successful fixture evidence.

    The live Backend image can lag local private helper names. Persisted
    source-boundary evidence is the stable cross-version contract.
    """
    runs = db.scalars(
        select(ETLRunModel).order_by(ETLRunModel.created_at.asc())
    ).all()
    candidate_ids: set[str] = set()
    for run in runs:
        state = (run.task_states or {}).get("eksMvpFixture")
        boundary = state.get("sourceBoundary") if isinstance(state, dict) else None
        if not isinstance(boundary, dict):
            continue
        if (
            boundary.get("kind") != "kafka_snapshot"
            or boundary.get("topic") != FIXTURE_TOPIC
            or int(boundary.get("expectedCount") or 0) != 100
            or str(boundary.get("consumerGroup") or "").strip()
            != EKS_MVP_FIXTURE_CONSUMER_GROUP
        ):
            continue
        candidate_ids.add(str(run.job_id))
    candidates: list[ETLJobModel] = []
    for job_id in sorted(candidate_ids):
        job = db.get(ETLJobModel, job_id)
        if job is None:
            continue
        try:
            target = fixture_target(job)
        except Exception:
            continue
        topic = field_value(
            job.source_config or [],
            "TOPIC / QUEUE NAME",
            "Topic",
            "topic",
        )
        if (
            topic == FIXTURE_TOPIC
            and fixture_consumer_group(job) == EKS_MVP_FIXTURE_CONSUMER_GROUP
            and target.table
        ):
            candidates.append(job)
    return candidates


def only_fixture_job(db) -> ETLJobModel:
    candidates = fixture_jobs(db)
    if len(candidates) != 1:
        raise RuntimeError(
            f"expected exactly one valid bounded fixture Job, found {len(candidates)}"
        )
    return candidates[0]


def snapshot_ids(service: IcebergWriterService, target: IcebergWriterTarget) -> set[str]:
    table = qualified_identifier(
        target.catalog,
        target.namespace,
        f"{target.table}$snapshots",
    )
    rows = service.query_rows(
        f"SELECT CAST(snapshot_id AS VARCHAR) FROM {table}"
    )
    return {
        str(row[0]).strip()
        for row in rows
        if row and str(row[0] or "").strip()
    }


def materialization_runs(dataset: CatalogDatasetModel | None) -> list[dict]:
    payload = dataset.payload if dataset is not None and isinstance(dataset.payload, dict) else {}
    runs = payload.get("materializationRuns")
    return [item for item in runs if isinstance(item, dict)] if isinstance(runs, list) else []


def count_rows(db, model, *filters) -> int:
    statement = select(func.count()).select_from(model)
    for condition in filters:
        statement = statement.where(condition)
    return int(db.scalar(statement) or 0)


def kubernetes_json(path: str) -> dict:
    host = required("KUBERNETES_SERVICE_HOST")
    port = str(os.environ.get("KUBERNETES_SERVICE_PORT_HTTPS") or "443")
    token_path = "/var/run/secrets/kubernetes.io/serviceaccount/token"
    ca_path = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
    with open(token_path, encoding="utf-8") as token_file:
        token = token_file.read().strip()
    request = Request(
        f"https://{host}:{port}{path}",
        headers={"Accept": "application/json", "Authorization": f"Bearer {token}"},
    )
    context = ssl.create_default_context(cafile=ca_path)
    with urlopen(request, timeout=20, context=context) as response:
        parsed = json.loads(response.read().decode("utf-8"))
    if not isinstance(parsed, dict):
        raise RuntimeError("Kubernetes API returned an invalid document")
    return parsed


def spark_applications(namespace: str) -> list[dict]:
    document = kubernetes_json(
        f"/apis/sparkoperator.k8s.io/v1beta2/namespaces/{namespace}/sparkapplications"
    )
    items = document.get("items")
    if not isinstance(items, list):
        raise RuntimeError("SparkApplication list response is invalid")
    return [item for item in items if isinstance(item, dict)]


def active_fixture_run_count(db, consumer_group: str) -> int:
    runs = db.scalars(
        select(ETLRunModel).where(ETLRunModel.status.in_(["queued", "running"]))
    ).all()
    count = 0
    for run in runs:
        state = (run.task_states or {}).get("eksMvpFixture")
        boundary = state.get("sourceBoundary") if isinstance(state, dict) else None
        if (
            isinstance(boundary, dict)
            and str(boundary.get("consumerGroup") or "").strip() == consumer_group
        ):
            count += 1
    return count


def preflight() -> None:
    db = SessionLocal()
    try:
        etl_repository.ensure_schema(db)
        candidates = fixture_jobs(db)
        if len(candidates) != 1:
            raise RuntimeError(
                f"expected exactly one valid bounded fixture Job, found {len(candidates)}"
            )
        job = candidates[0]
        group = fixture_consumer_group(job)
        target = fixture_target(job)
        dataset = db.get(CatalogDatasetModel, job.dataset_id) if job.dataset_id else None
        if dataset is None:
            raise RuntimeError("bounded fixture Catalog Dataset is missing")
        service = IcebergWriterService()
        snapshots = snapshot_ids(service, target)
        if not snapshots:
            raise RuntimeError("bounded fixture Iceberg table has no baseline snapshot")
        active = active_fixture_run_count(db, group)
        if active != 0:
            raise RuntimeError("bounded fixture slot is already active")
        applications = spark_applications(
            str(os.environ.get("ASKLAKE_SPARK_KUBERNETES_NAMESPACE") or "asklake-dev")
        )
        airflow = build_airflow_client()
        checks = {
            "candidateJobExactlyOne": len(candidates) == 1,
            "fixtureSlotIdle": active == 0,
            "baselineSnapshotPresent": len(snapshots) > 0,
            "catalogDatasetPresent": dataset is not None,
            "sparkApplicationListReadable": isinstance(applications, list),
            "airflowConfigured": bool(airflow.config.api_base_url and airflow.config.dag_id),
        }
        result = {
            "status": "passed" if all(checks.values()) else "failed",
            "checks": checks,
            "counts": {
                "candidateJobs": len(candidates),
                "activeFixtureRuns": active,
                "baselineSnapshots": len(snapshots),
                "baselineMaterializations": len(materialization_runs(dataset)),
            },
        }
        print(json.dumps(result))
        if result["status"] != "passed":
            raise RuntimeError("Day 17 race preflight did not pass")
    finally:
        db.close()


def prepare_fixture_reuse() -> None:
    db = SessionLocal()
    try:
        etl_repository.ensure_schema(db)
        job = only_fixture_job(db)
        dataset = db.get(CatalogDatasetModel, job.dataset_id) if job.dataset_id else None
        if dataset is None:
            raise RuntimeError("bounded fixture Catalog Dataset is missing")
        runs = db.scalars(
            select(ETLRunModel)
            .where(ETLRunModel.job_id == job.id)
            .order_by(ETLRunModel.created_at.desc())
        ).all()
        reusable: list[tuple[ETLRunModel, dict]] = []
        for run in runs:
            states = run.task_states or {}
            fixture = states.get("eksMvpFixture")
            boundary = fixture.get("sourceBoundary") if isinstance(fixture, dict) else None
            spark = states.get("sparkResult")
            catalog = states.get("catalogResult")
            if (
                run.status == "success"
                and run.airflow_state == "success"
                and isinstance(boundary, dict)
                and boundary.get("topic") == FIXTURE_TOPIC
                and int(boundary.get("expectedCount") or 0) == 100
                and str(boundary.get("fixtureBatchId") or "").strip()
                and isinstance(spark, dict)
                and spark.get("status") == "success"
                and int(spark.get("inputRows") or 0) == 100
                and int(spark.get("outputRows") or 0) == 100
                and isinstance(catalog, dict)
                and catalog.get("status") == "success"
            ):
                reusable.append((run, boundary))
        if not reusable:
            raise RuntimeError("no persisted successful 100-record fixture boundary is reusable")
        source_run, boundary = reusable[0]
        matching = [
            item
            for item in materialization_runs(dataset)
            if item.get("runId") == source_run.run_id
        ]
        if len(matching) != 1:
            raise RuntimeError("reusable fixture source Run has no exact Catalog materialization")
        print(
            json.dumps(
                {
                    "contractVersion": "1.0",
                    "batchId": boundary["fixtureBatchId"],
                    "topic": FIXTURE_TOPIC,
                    "expectedCount": 100,
                    "producedCount": 100,
                    "reusedFromPersistedSuccess": True,
                    "sourceRunId": source_run.run_id,
                    "sourceRunHash": short_hash(source_run.run_id),
                    "preparedAt": utc_now(),
                }
            )
        )
    finally:
        db.close()


def response_error_code(document: object) -> str | None:
    if isinstance(document, dict):
        for key in ("code", "errorCode"):
            value = document.get(key)
            if isinstance(value, str) and value:
                return value
        for key in ("detail", "error"):
            nested = response_error_code(document.get(key))
            if nested:
                return nested
    return None


def execute_request(
    target: str,
    *,
    run_id: str,
    job_id: str,
    source_boundary: dict,
    token: str,
    barrier: threading.Barrier,
) -> dict:
    target_hash = short_hash(target)
    barrier.wait(timeout=30)
    started = time.monotonic()
    request = Request(
        f"{target.rstrip('/')}/api/internal/airflow/spark-runs/{run_id}/execute",
        data=json.dumps(
            {
                "command": "run",
                "jobId": job_id,
                "sourceBoundary": source_boundary,
            }
        ).encode("utf-8"),
        method="POST",
        headers={
            "Accept": "application/json",
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    status_code = 0
    document: object = {}
    try:
        with urlopen(request, timeout=7_500) as response:
            status_code = int(response.status)
            document = json.loads(response.read().decode("utf-8") or "{}")
    except HTTPError as exc:
        status_code = int(exc.code)
        try:
            document = json.loads(exc.read().decode("utf-8") or "{}")
        except json.JSONDecodeError:
            document = {}
    except Exception as exc:
        return {
            "targetHash": target_hash,
            "status": 0,
            "code": type(exc).__name__,
            "durationMs": round((time.monotonic() - started) * 1_000),
        }
    return {
        "targetHash": target_hash,
        "status": status_code,
        "code": response_error_code(document)
        or ("SUCCESS" if status_code == 200 else "UNKNOWN"),
        "durationMs": round((time.monotonic() - started) * 1_000),
    }


def monitor_run(run_id: str, stop: threading.Event, timeline: list[dict]) -> None:
    previous: tuple | None = None
    while not stop.is_set():
        db = SessionLocal()
        try:
            run = db.get(ETLRunModel, run_id)
            if run is not None:
                states = run.task_states or {}
                spark = states.get("sparkExecution") if isinstance(states, dict) else None
                catalog = states.get("catalogResult") if isinstance(states, dict) else None
                current = (
                    int(run.execution_generation or 0),
                    short_hash(run.execution_owner) if run.execution_owner else None,
                    str(run.status or ""),
                    str(spark.get("status") or "") if isinstance(spark, dict) else "",
                    str(catalog.get("status") or "") if isinstance(catalog, dict) else "",
                )
                if current != previous:
                    timeline.append(
                        {
                            "at": utc_now(),
                            "generation": current[0],
                            "ownerHash": current[1],
                            "runStatus": current[2],
                            "sparkStatus": current[3],
                            "catalogStatus": current[4],
                        }
                    )
                    previous = current
        finally:
            db.close()
        stop.wait(0.25)


def run_race() -> None:
    targets = json.loads(required("TARGET_URLS_JSON"))
    if (
        not isinstance(targets, list)
        or len(targets) < 2
        or len(set(str(item) for item in targets)) != len(targets)
        or any(not str(item).startswith("http://") for item in targets)
    ):
        raise RuntimeError("TARGET_URLS_JSON must contain distinct HTTP Pod targets")
    expected_replicas = int(required("EXPECTED_REPLICAS"))
    if len(targets) != expected_replicas or expected_replicas < 2:
        raise RuntimeError("race target count does not match EXPECTED_REPLICAS")
    batch_id = required("FIXTURE_BATCH_ID")
    expected_count = int(required("EXPECTED_COUNT"))
    timeout_seconds = int(os.environ.get("E2E_TIMEOUT_SECONDS") or "9000")
    if expected_count != 100:
        raise RuntimeError("Day 17 bounded race requires exactly 100 records")

    service = IcebergWriterService()
    db = SessionLocal()
    try:
        etl_repository.ensure_schema(db)
        job = only_fixture_job(db)
        group = fixture_consumer_group(job)
        if active_fixture_run_count(db, group) != 0:
            raise RuntimeError("bounded fixture slot became active before the race")
        target = fixture_target(job)
        dataset = db.get(CatalogDatasetModel, job.dataset_id) if job.dataset_id else None
        if dataset is None:
            raise RuntimeError("bounded fixture Catalog Dataset is missing")
        pre_snapshots = snapshot_ids(service, target)
        pre_materializations = len(materialization_runs(dataset))
        pre_job_runs = count_rows(db, ETLRunModel, ETLRunModel.job_id == job.id)
        pre_continuous_runtimes = count_rows(db, KafkaContinuousRuntimeModel)
        pre_continuous_sessions = count_rows(db, KafkaContinuousSessionModel)

        job.source_config = replace_field(job.source_config or [], BATCH_FIELD, batch_id)
        job.source_config = replace_field(
            job.source_config,
            COUNT_FIELD,
            str(expected_count),
        )
        db.commit()
        response = command_job(
            db,
            job.id,
            "run",
            ActorContext(name="day17-hpa-race", role="admin"),
        )
        run_id = str(response.run.run_id)
        job_id = str(job.id)
        db.expire_all()
        run = db.get(ETLRunModel, run_id)
        state = (run.task_states or {}).get("eksMvpFixture") if run is not None else None
        source_boundary = state.get("sourceBoundary") if isinstance(state, dict) else None
        if not isinstance(source_boundary, dict):
            raise RuntimeError("new race Run has no persisted fixture boundary")
    finally:
        db.close()

    timeline: list[dict] = [
        {
            "at": utc_now(),
            "event": "race-run-created",
            "hpaReadyReplicas": expected_replicas,
        }
    ]
    stop_monitor = threading.Event()
    monitor = threading.Thread(
        target=monitor_run,
        args=(run_id, stop_monitor, timeline),
        daemon=True,
    )
    monitor.start()

    token = str(
        settings.airflow_execution_api_token
        or settings.airflow_internal_token
        or ""
    ).strip()
    if not token:
        raise RuntimeError("Airflow execution token is not configured")
    barrier = threading.Barrier(len(targets))
    results: list[dict] = []
    result_lock = threading.Lock()

    def invoke(target_url: str) -> None:
        outcome = execute_request(
            target_url,
            run_id=run_id,
            job_id=job_id,
            source_boundary=source_boundary,
            token=token,
            barrier=barrier,
        )
        with result_lock:
            results.append(outcome)

    workers = [
        threading.Thread(target=invoke, args=(str(target),), daemon=True)
        for target in targets
    ]
    for worker in workers:
        worker.start()
    for worker in workers:
        worker.join(timeout=7_800)
    if any(worker.is_alive() for worker in workers):
        raise RuntimeError("one or more replica race requests did not finish")

    deadline = time.monotonic() + timeout_seconds
    terminal: ETLRunModel | None = None
    while time.monotonic() < deadline:
        db = SessionLocal()
        try:
            get_job(
                db,
                job_id,
                ActorContext(name="day17-hpa-race", role="admin"),
            )
            terminal = db.get(ETLRunModel, run_id)
            if (
                terminal is not None
                and terminal.status in TERMINAL_STATUSES
                and isinstance((terminal.task_states or {}).get("catalogResult"), dict)
            ):
                break
        finally:
            db.close()
        time.sleep(5)

    stop_monitor.set()
    monitor.join(timeout=5)
    timeline.append({"at": utc_now(), "event": "race-verification-started"})
    if terminal is None or terminal.status != "success":
        raise RuntimeError("Day 17 race Run did not reach success")

    db = SessionLocal()
    try:
        db.expire_all()
        run = db.get(ETLRunModel, run_id)
        job = db.get(ETLJobModel, job_id)
        if run is None or job is None:
            raise RuntimeError("race Run or Job disappeared")
        dataset = db.get(CatalogDatasetModel, job.dataset_id) if job.dataset_id else None
        states = run.task_states or {}
        spark_execution = states.get("sparkExecution") or {}
        spark_result = states.get("sparkResult") or {}
        catalog_result = states.get("catalogResult") or {}
        execution = spark_result.get("kubernetesExecution") or {}
        commit = spark_result.get("icebergCommit") or {}
        target = fixture_target(job)

        post_snapshots = snapshot_ids(service, target)
        new_snapshots = post_snapshots - pre_snapshots
        all_materializations = materialization_runs(dataset)
        matching_materializations = [
            item for item in all_materializations if item.get("runId") == run_id
        ]
        rds_run_count = count_rows(
            db,
            ETLRunModel,
            ETLRunModel.run_id == run_id,
        )
        post_job_runs = count_rows(db, ETLRunModel, ETLRunModel.job_id == job_id)
        post_continuous_runtimes = count_rows(db, KafkaContinuousRuntimeModel)
        post_continuous_sessions = count_rows(db, KafkaContinuousSessionModel)

        namespace = str(
            os.environ.get("ASKLAKE_SPARK_KUBERNETES_NAMESPACE") or "asklake-dev"
        )
        applications = [
            item
            for item in spark_applications(namespace)
            if (
                ((item.get("metadata") or {}).get("annotations") or {}).get(
                    "asklake.io/run-id"
                )
                == run_id
            )
        ]
        application = applications[0] if len(applications) == 1 else {}
        metadata = application.get("metadata") or {}
        application_state = (
            ((application.get("status") or {}).get("applicationState") or {}).get(
                "state"
            )
        )
        airflow_run = build_airflow_client().get_dag_run(run_id)
        verified_rows = service.verify_snapshot_run_row_count(
            target,
            snapshot_id=str(commit.get("snapshotId") or ""),
            run_id=run_id,
            expected_row_count=expected_count,
        )
        file_count, storage_size = service.table_storage_metrics(
            target,
            snapshot_id=str(commit.get("snapshotId") or ""),
        )

        spark_generation = int(spark_execution.get("generation") or 0)
        spark_owner_hashes = {
            item["ownerHash"]
            for item in timeline
            if item.get("generation") == spark_generation and item.get("ownerHash")
        }
        request_statuses = [int(item.get("status") or 0) for item in results]
        conflict_count = sum(
            1
            for item in results
            if item.get("status") == 409
            and item.get("code") == "SPARK_RUN_ALREADY_EXECUTING"
        )
        checks = {
            "hpaReplicaTargetsExact": len(results) == expected_replicas,
            "distinctReplicaTargetsExact": len(
                {item.get("targetHash") for item in results}
            )
            == expected_replicas,
            "raceResponsesBounded": all(code in {200, 409} for code in request_statuses),
            "raceConflictObserved": conflict_count >= 1,
            "rdsRunExactlyOne": rds_run_count == 1,
            "jobRunDeltaExactlyOne": post_job_runs - pre_job_runs == 1,
            "sparkOwnerExactlyOne": len(spark_owner_hashes) == 1,
            "sparkGenerationExactlyOne": spark_generation == 1,
            "sparkAttemptExactlyOne": bool(spark_execution.get("attemptId")),
            "finalGenerationSparkPlusCatalog": int(run.execution_generation or 0) == 2,
            "executionOwnerReleased": run.execution_owner is None
            and run.execution_lease_expires_at is None,
            "airflowDagRunExactlyOne": airflow_run.dag_run_id == run_id
            and airflow_run.dag_id == run.airflow_dag_id,
            "runSuccess": run.status == "success",
            "airflowSuccess": run.airflow_state == "success",
            "sparkSuccess": spark_result.get("status") == "success",
            "catalogSuccess": catalog_result.get("status") == "success",
            "externalExecutionExactlyOne": spark_generation == 1
            and bool(spark_execution.get("attemptId")),
            "sparkApplicationExactlyOne": len(applications) == 1,
            "sparkApplicationUidMatches": len(applications) == 1
            and metadata.get("uid") == execution.get("applicationUid"),
            "sparkApplicationCompleted": application_state == "COMPLETED",
            "icebergSnapshotDeltaExactlyOne": len(new_snapshots) == 1,
            "icebergCommitIsNewSnapshot": str(commit.get("snapshotId") or "")
            in new_snapshots,
            "catalogMaterializationExactlyOne": len(matching_materializations) == 1,
            "catalogMaterializationDeltaExactlyOne": len(all_materializations)
            - pre_materializations
            == 1,
            "catalogSnapshotMatches": len(matching_materializations) == 1
            and matching_materializations[0].get("icebergSnapshotId")
            == commit.get("snapshotId"),
            "exactInputRows": int(spark_result.get("inputRows") or -1)
            == expected_count,
            "exactOutputRows": int(spark_result.get("outputRows") or -1)
            == expected_count,
            "trinoExactRows": verified_rows == expected_count,
            "physicalFilesPresent": file_count > 0 and storage_size > 0,
            "continuousRuntimeCountStable": post_continuous_runtimes
            == pre_continuous_runtimes,
            "continuousSessionCountStable": post_continuous_sessions
            == pre_continuous_sessions,
        }
        result = {
            "contractVersion": "1.0",
            "status": "passed" if all(checks.values()) else "failed",
            "createdAt": utc_now(),
            "checks": checks,
            "counts": {
                "raceTargets": len(results),
                "http200": request_statuses.count(200),
                "http409AlreadyExecuting": conflict_count,
                "rdsRuns": rds_run_count,
                "sparkOwners": len(spark_owner_hashes),
                "sparkGeneration": spark_generation,
                "finalRdsGeneration": int(run.execution_generation or 0),
                "externalExecutions": 1
                if checks["externalExecutionExactlyOne"]
                else 0,
                "sparkApplications": len(applications),
                "newIcebergSnapshots": len(new_snapshots),
                "catalogMaterializations": len(matching_materializations),
                "verifiedRows": verified_rows,
                "dataFiles": file_count,
            },
            "raceResponses": sorted(
                results,
                key=lambda item: str(item.get("targetHash") or ""),
            ),
            "timeline": timeline,
            "privateIdentity": {
                "jobId": job_id,
                "runId": run_id,
                "applicationName": execution.get("applicationName"),
                "applicationUid": execution.get("applicationUid"),
                "snapshotId": commit.get("snapshotId"),
                "datasetId": job.dataset_id,
                "fixtureBatchId": batch_id,
            },
            "redactedIdentity": {
                "run": short_hash(run_id),
                "application": short_hash(execution.get("applicationUid")),
                "snapshot": short_hash(commit.get("snapshotId")),
                "dataset": short_hash(job.dataset_id),
                "fixtureBatch": short_hash(batch_id),
            },
        }
        print(json.dumps(result))
        if result["status"] != "passed":
            raise RuntimeError("Day 17 HPA race exact-one verification failed")
    finally:
        db.close()


def recover_race() -> None:
    source_run_id = required("SOURCE_RUN_ID")
    expected_replicas = int(required("EXPECTED_REPLICAS"))
    recovered_conflicts = int(required("RECOVERED_CONFLICT_COUNT"))
    expected_count = 100
    service = IcebergWriterService()
    db = SessionLocal()
    try:
        etl_repository.ensure_schema(db)
        source_run = db.get(ETLRunModel, source_run_id)
        if source_run is None:
            raise RuntimeError("persisted fixture source Run is missing")
        job = db.get(ETLJobModel, source_run.job_id)
        if job is None:
            raise RuntimeError("persisted fixture Job is missing")
        source_states = source_run.task_states or {}
        source_fixture = source_states.get("eksMvpFixture") or {}
        source_boundary = source_fixture.get("sourceBoundary") or {}
        source_spark = source_states.get("sparkResult") or {}
        source_commit = source_spark.get("icebergCommit") or {}
        batch_id = str(source_boundary.get("fixtureBatchId") or "")
        if (
            source_run.status != "success"
            or source_boundary.get("topic") != FIXTURE_TOPIC
            or int(source_boundary.get("expectedCount") or 0) != expected_count
            or not batch_id
            or not str(source_commit.get("snapshotId") or "")
        ):
            raise RuntimeError("persisted fixture source Run is not reusable evidence")

        later_runs = db.scalars(
            select(ETLRunModel)
            .where(
                ETLRunModel.job_id == job.id,
                ETLRunModel.created_at > source_run.created_at,
            )
            .order_by(ETLRunModel.created_at.asc())
        ).all()
        fixture_later_runs: list[ETLRunModel] = []
        for candidate in later_runs:
            state = (candidate.task_states or {}).get("eksMvpFixture")
            boundary = state.get("sourceBoundary") if isinstance(state, dict) else None
            if (
                isinstance(boundary, dict)
                and boundary.get("topic") == FIXTURE_TOPIC
                and boundary.get("fixtureBatchId") == batch_id
                and int(boundary.get("expectedCount") or 0) == expected_count
            ):
                fixture_later_runs.append(candidate)
        if len(fixture_later_runs) != 1:
            raise RuntimeError(
                "expected exactly one new fixture Run after the persisted source Run"
            )
        run = fixture_later_runs[0]
        run_id = run.run_id
        states = run.task_states or {}
        spark_execution = states.get("sparkExecution") or {}
        spark_result = states.get("sparkResult") or {}
        catalog_result = states.get("catalogResult") or {}
        execution = spark_result.get("kubernetesExecution") or {}
        commit = spark_result.get("icebergCommit") or {}
        dataset = db.get(CatalogDatasetModel, job.dataset_id) if job.dataset_id else None
        target = fixture_target(job)

        snapshots_table = qualified_identifier(
            target.catalog,
            target.namespace,
            f"{target.table}$snapshots",
        )
        snapshot_rows = service.query_rows(
            "SELECT CAST(snapshot_id AS VARCHAR), CAST(committed_at AS VARCHAR) "
            f"FROM {snapshots_table} ORDER BY committed_at, snapshot_id"
        )
        ordered_snapshot_ids = [
            str(row[0]).strip()
            for row in snapshot_rows
            if row and str(row[0] or "").strip()
        ]
        source_snapshot_id = str(source_commit.get("snapshotId"))
        if source_snapshot_id not in ordered_snapshot_ids:
            raise RuntimeError("persisted source snapshot is absent from Iceberg history")
        source_index = ordered_snapshot_ids.index(source_snapshot_id)
        snapshots_after_source = ordered_snapshot_ids[source_index + 1 :]

        all_materializations = materialization_runs(dataset)
        source_materializations = [
            item for item in all_materializations if item.get("runId") == source_run_id
        ]
        if len(source_materializations) != 1:
            raise RuntimeError("persisted source materialization is not unique")
        later_run_ids = {item.run_id for item in later_runs}
        later_run_materializations = [
            item
            for item in all_materializations
            if item.get("runId") in later_run_ids
        ]
        matching_materializations = [
            item for item in all_materializations if item.get("runId") == run_id
        ]

        namespace = str(
            os.environ.get("ASKLAKE_SPARK_KUBERNETES_NAMESPACE") or "asklake-dev"
        )
        applications = [
            item
            for item in spark_applications(namespace)
            if (
                ((item.get("metadata") or {}).get("annotations") or {}).get(
                    "asklake.io/run-id"
                )
                == run_id
            )
        ]
        application = applications[0] if len(applications) == 1 else {}
        metadata = application.get("metadata") or {}
        application_state = (
            ((application.get("status") or {}).get("applicationState") or {}).get(
                "state"
            )
        )
        airflow_run = build_airflow_client().get_dag_run(run_id)
        verified_rows = service.verify_snapshot_run_row_count(
            target,
            snapshot_id=str(commit.get("snapshotId") or ""),
            run_id=run_id,
            expected_row_count=expected_count,
        )
        file_count, storage_size = service.table_storage_metrics(
            target,
            snapshot_id=str(commit.get("snapshotId") or ""),
        )
        rds_run_count = count_rows(
            db,
            ETLRunModel,
            ETLRunModel.run_id == run_id,
        )
        sessions_during_run = count_rows(
            db,
            KafkaContinuousSessionModel,
            KafkaContinuousSessionModel.created_at >= run.created_at,
        )
        spark_generation = int(spark_execution.get("generation") or 0)
        checks = {
            "raceStartedAtSixReplicas": expected_replicas == 6,
            "raceConflictRecovered": recovered_conflicts >= 1,
            "rdsRunExactlyOne": rds_run_count == 1,
            "jobRunDeltaExactlyOne": len(later_runs) == 1
            and len(fixture_later_runs) == 1,
            "rdsSparkAttemptOwnerExactlyOne": spark_generation == 1
            and bool(spark_execution.get("attemptId")),
            "sparkGenerationExactlyOne": spark_generation == 1,
            "finalGenerationSparkPlusCatalog": int(run.execution_generation or 0) == 2,
            "executionOwnerReleased": run.execution_owner is None
            and run.execution_lease_expires_at is None,
            "airflowDagRunExactlyOne": airflow_run.dag_run_id == run_id
            and airflow_run.dag_id == run.airflow_dag_id,
            "runSuccess": run.status == "success",
            "airflowSuccess": run.airflow_state == "success",
            "sparkSuccess": spark_result.get("status") == "success",
            "catalogSuccess": catalog_result.get("status") == "success",
            "externalExecutionExactlyOne": spark_generation == 1
            and bool(spark_execution.get("attemptId")),
            "sparkApplicationExactlyOne": len(applications) == 1,
            "sparkApplicationUidMatches": len(applications) == 1
            and metadata.get("uid") == execution.get("applicationUid"),
            "sparkApplicationCompleted": application_state == "COMPLETED",
            "icebergSnapshotDeltaExactlyOne": len(snapshots_after_source) == 1,
            "icebergCommitIsOnlyNewSnapshot": snapshots_after_source
            == [str(commit.get("snapshotId") or "")],
            "catalogMaterializationExactlyOne": len(matching_materializations) == 1,
            "catalogMaterializationDeltaExactlyOne": len(later_run_materializations)
            == 1
            and later_run_materializations[0].get("runId") == run_id,
            "catalogSnapshotMatches": len(matching_materializations) == 1
            and matching_materializations[0].get("icebergSnapshotId")
            == commit.get("snapshotId"),
            "exactInputRows": int(spark_result.get("inputRows") or -1)
            == expected_count,
            "exactOutputRows": int(spark_result.get("outputRows") or -1)
            == expected_count,
            "trinoExactRows": verified_rows == expected_count,
            "physicalFilesPresent": file_count > 0 and storage_size > 0,
            "noContinuousSessionStarted": sessions_during_run == 0,
        }
        result = {
            "contractVersion": "1.0",
            "status": "passed" if all(checks.values()) else "failed",
            "createdAt": utc_now(),
            "recoveredAfterVerifierEviction": True,
            "fixtureReused": True,
            "checks": checks,
            "counts": {
                "raceTargets": expected_replicas,
                "recoveredHttp409AlreadyExecuting": recovered_conflicts,
                "rdsRuns": rds_run_count,
                "sparkOwners": 1 if checks["rdsSparkAttemptOwnerExactlyOne"] else 0,
                "sparkGeneration": spark_generation,
                "finalRdsGeneration": int(run.execution_generation or 0),
                "externalExecutions": 1
                if checks["externalExecutionExactlyOne"]
                else 0,
                "sparkApplications": len(applications),
                "newIcebergSnapshots": len(snapshots_after_source),
                "catalogMaterializations": len(matching_materializations),
                "verifiedRows": verified_rows,
                "dataFiles": file_count,
                "continuousSessionsStarted": sessions_during_run,
            },
            "timeline": [
                {
                    "at": str(run.started_at),
                    "event": "race-run-created-at-six-replicas",
                },
                {
                    "at": str((spark_execution or {}).get("startedAt") or run.started_at),
                    "event": "single-spark-owner-generation-claimed",
                    "generation": spark_generation,
                },
                {
                    "at": str(execution.get("submittedAt") or run.started_at),
                    "event": "single-spark-application-submitted",
                },
                {
                    "at": str(execution.get("completedAt") or run.ended_at),
                    "event": "single-spark-application-completed",
                },
                {
                    "at": str(catalog_result.get("reconciledAt") or run.ended_at),
                    "event": "single-snapshot-and-materialization-verified",
                },
                {
                    "at": utc_now(),
                    "event": "read-only-recovery-verification-passed",
                },
            ],
            "privateIdentity": {
                "jobId": job.id,
                "runId": run_id,
                "applicationName": execution.get("applicationName"),
                "applicationUid": execution.get("applicationUid"),
                "snapshotId": commit.get("snapshotId"),
                "datasetId": job.dataset_id,
                "fixtureBatchId": batch_id,
            },
            "redactedIdentity": {
                "run": short_hash(run_id),
                "application": short_hash(execution.get("applicationUid")),
                "snapshot": short_hash(commit.get("snapshotId")),
                "dataset": short_hash(job.dataset_id),
                "fixtureBatch": short_hash(batch_id),
            },
        }
        print(json.dumps(result))
        if result["status"] != "passed":
            raise RuntimeError("recovered Day 17 exact-one verification failed")
    finally:
        db.close()


def race_status() -> None:
    source_run_id = required("SOURCE_RUN_ID")
    db = SessionLocal()
    try:
        etl_repository.ensure_schema(db)
        source_run = db.get(ETLRunModel, source_run_id)
        if source_run is None:
            raise RuntimeError("persisted fixture source Run is missing")
        later_runs = db.scalars(
            select(ETLRunModel)
            .where(
                ETLRunModel.job_id == source_run.job_id,
                ETLRunModel.created_at > source_run.created_at,
            )
            .order_by(ETLRunModel.created_at.asc())
        ).all()
        if len(later_runs) != 1:
            raise RuntimeError("expected exactly one new Run for status recovery")
        run = later_runs[0]
        get_job(
            db,
            run.job_id,
            ActorContext(name="day17-hpa-race-status", role="admin"),
        )
        db.expire_all()
        run = db.get(ETLRunModel, run.run_id)
        states = run.task_states or {}
        spark = states.get("sparkResult") or {}
        catalog = states.get("catalogResult") or {}
        airflow = build_airflow_client()
        dag_run = airflow.get_dag_run(run.run_id)
        tasks = airflow.list_task_instances(run.run_id)
        task_counts: dict[str, int] = {}
        for task in tasks:
            key = str(task.state or "unknown")
            task_counts[key] = task_counts.get(key, 0) + 1
        print(
            json.dumps(
                {
                    "status": "passed",
                    "checks": {"newRunExactlyOne": len(later_runs) == 1},
                    "runStatus": run.status,
                    "airflowState": run.airflow_state,
                    "airflowApiState": dag_run.state,
                    "sparkStatus": spark.get("status"),
                    "catalogStatus": catalog.get("status"),
                    "executionGeneration": int(run.execution_generation or 0),
                    "ownerPresent": run.execution_owner is not None,
                    "taskStateCounts": task_counts,
                }
            )
        )
    finally:
        db.close()


def clear_failed_airflow_tasks(*, dry_run: bool) -> None:
    source_run_id = required("SOURCE_RUN_ID")
    if not dry_run and required("CLEAR_FAILED_CONFIRM") != "clear-same-run-failed-tasks":
        raise RuntimeError("same-run Airflow clear confirmation is missing")
    db = SessionLocal()
    try:
        etl_repository.ensure_schema(db)
        source_run = db.get(ETLRunModel, source_run_id)
        if source_run is None:
            raise RuntimeError("persisted fixture source Run is missing")
        later_runs = db.scalars(
            select(ETLRunModel)
            .where(
                ETLRunModel.job_id == source_run.job_id,
                ETLRunModel.created_at > source_run.created_at,
            )
            .order_by(ETLRunModel.created_at.asc())
        ).all()
        if len(later_runs) != 1:
            raise RuntimeError("expected exactly one new Run for Airflow recovery")
        run = later_runs[0]
        states = run.task_states or {}
        spark = states.get("sparkResult") or {}
        catalog = states.get("catalogResult") or {}
        if (
            run.status != "failed"
            or run.airflow_state != "failed"
            or spark.get("status") != "success"
            or catalog.get("status") == "success"
            or int(run.execution_generation or 0) != 1
            or run.execution_owner is not None
        ):
            raise RuntimeError("same-run Airflow recovery preconditions are not met")

        airflow = build_airflow_client()
        path = (
            f"/dags/{path_segment(airflow.config.dag_id)}"
            f"/dagRuns/{path_segment(run.run_id)}/clear"
        )
        response = airflow._request_json(
            "POST",
            path,
            {
                "dry_run": dry_run,
                "only_failed": True,
                "only_new": False,
                "run_on_latest_version": False,
                "note": "Day 17 same-run recovery after HPA connection drain",
            },
        )
        if dry_run:
            tasks = response.get("task_instances")
            if not isinstance(tasks, list):
                raise RuntimeError("Airflow clear dry-run did not return task instances")
            task_ids = sorted(
                {
                    str(item.get("task_id") or "")
                    for item in tasks
                    if isinstance(item, dict) and str(item.get("task_id") or "")
                }
            )
            print(
                json.dumps(
                    {
                        "status": "passed",
                        "checks": {
                            "sameRunExactlyOne": len(later_runs) == 1,
                            "failedTasksSelected": len(tasks) >= 1,
                            "sparkResultAlreadyDurable": spark.get("status") == "success",
                            "catalogNotYetCommitted": catalog.get("status") != "success",
                        },
                        "dryRun": True,
                        "selectedTaskCount": len(tasks),
                        "selectedTasks": task_ids,
                    }
                )
            )
            return

        deadline = time.monotonic() + 900
        observed_nonterminal = False
        airflow_state = ""
        while time.monotonic() < deadline:
            dag_run = airflow.get_dag_run(run.run_id)
            airflow_state = str(dag_run.state or "")
            if airflow_state not in {"failed", "success"}:
                observed_nonterminal = True
            if airflow_state == "success":
                break
            if airflow_state == "failed" and observed_nonterminal:
                break
            time.sleep(5)
        get_job(
            db,
            run.job_id,
            ActorContext(name="day17-same-run-recovery", role="admin"),
        )
        db.expire_all()
        run = db.get(ETLRunModel, run.run_id)
        states = run.task_states or {}
        catalog = states.get("catalogResult") or {}
        checks = {
            "sameRunExactlyOne": len(later_runs) == 1,
            "airflowRecovered": airflow_state == "success",
            "rdsRunRecovered": run.status == "success"
            and run.airflow_state == "success",
            "catalogCommitted": catalog.get("status") == "success",
            "finalGenerationSparkPlusCatalog": int(run.execution_generation or 0) == 2,
            "executionOwnerReleased": run.execution_owner is None
            and run.execution_lease_expires_at is None,
        }
        print(
            json.dumps(
                {
                    "status": "passed" if all(checks.values()) else "failed",
                    "checks": checks,
                    "dryRun": False,
                    "airflowState": airflow_state,
                    "runStatus": run.status,
                    "catalogStatus": catalog.get("status"),
                    "executionGeneration": int(run.execution_generation or 0),
                }
            )
        )
        if not all(checks.values()):
            raise RuntimeError("same-run Airflow recovery did not reach success")
    finally:
        db.close()


def sync_recovered_run() -> None:
    source_run_id = required("SOURCE_RUN_ID")
    db = SessionLocal()
    try:
        etl_repository.ensure_schema(db)
        source_run = db.get(ETLRunModel, source_run_id)
        if source_run is None:
            raise RuntimeError("persisted fixture source Run is missing")
        later_runs = db.scalars(
            select(ETLRunModel)
            .where(
                ETLRunModel.job_id == source_run.job_id,
                ETLRunModel.created_at > source_run.created_at,
            )
            .order_by(ETLRunModel.created_at.asc())
        ).all()
        if len(later_runs) != 1:
            raise RuntimeError("expected exactly one new Run for supported sync")
        run = later_runs[0]
        job = db.get(ETLJobModel, run.job_id)
        dataset = db.get(CatalogDatasetModel, job.dataset_id) if job and job.dataset_id else None
        states = run.task_states or {}
        spark = states.get("sparkResult") or {}
        catalog = states.get("catalogResult") or {}
        airflow = build_airflow_client()
        dag_run = airflow.get_dag_run(run.run_id)
        if (
            job is None
            or dataset is None
            or dag_run.state != "success"
            or spark.get("status") != "success"
            or catalog.get("status") != "success"
            or int(run.execution_generation or 0) != 2
            or run.execution_owner is not None
        ):
            raise RuntimeError("supported Airflow sync preconditions are not met")
        sync_airflow_run(db, job, run, airflow, dataset)
        db.expire_all()
        run = db.get(ETLRunModel, run.run_id)
        states = run.task_states or {}
        catalog = states.get("catalogResult") or {}
        checks = {
            "sameRunExactlyOne": len(later_runs) == 1,
            "rdsRunSuccess": run.status == "success",
            "rdsAirflowSuccess": run.airflow_state == "success",
            "catalogStillSuccess": catalog.get("status") == "success",
            "generationStable": int(run.execution_generation or 0) == 2,
            "ownerStillReleased": run.execution_owner is None
            and run.execution_lease_expires_at is None,
        }
        print(
            json.dumps(
                {
                    "status": "passed" if all(checks.values()) else "failed",
                    "checks": checks,
                    "runStatus": run.status,
                    "airflowState": run.airflow_state,
                    "catalogStatus": catalog.get("status"),
                    "executionGeneration": int(run.execution_generation or 0),
                }
            )
        )
        if not all(checks.values()):
            raise RuntimeError("supported Airflow Run sync did not reach success")
    finally:
        db.close()


def main() -> None:
    mode = str(os.environ.get("DAY17_RACE_MODE") or "preflight").strip()
    if mode == "preflight":
        preflight()
        return
    if mode == "fixture-reuse":
        prepare_fixture_reuse()
        return
    if mode == "recover":
        recover_race()
        return
    if mode == "status":
        race_status()
        return
    if mode == "clear-dry-run":
        clear_failed_airflow_tasks(dry_run=True)
        return
    if mode == "clear-failed":
        clear_failed_airflow_tasks(dry_run=False)
        return
    if mode == "sync-recovered":
        sync_recovered_run()
        return
    if mode == "run":
        run_race()
        return
    raise RuntimeError(
        "DAY17_RACE_MODE must be preflight, fixture-reuse, status, clear-dry-run, "
        "clear-failed, sync-recovered, recover, or run"
    )


if __name__ == "__main__":
    main()
