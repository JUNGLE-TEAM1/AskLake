from __future__ import annotations

import json
import os
import time

from app.core.auth_context import ActorContext
from app.core.database import SessionLocal
from app.models import ETLJobModel, ETLRunModel
from app.repositories import etl_repository
from app.services.etl_service import command_job, get_job


BATCH_FIELD = "__EKS MVP Fixture Batch ID"
COUNT_FIELD = "__EKS MVP Expected Count"


def required(name: str) -> str:
    value = str(os.environ.get(name) or "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


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


def main() -> None:
    job_id = required("JOB_ID")
    batch_id = required("FIXTURE_BATCH_ID")
    expected_count = int(required("EXPECTED_COUNT"))
    timeout_seconds = int(os.environ.get("E2E_TIMEOUT_SECONDS") or "9000")
    if expected_count != 100:
        raise RuntimeError("bounded E2E requires exactly 100 records")
    if timeout_seconds < 300 or timeout_seconds > 9600:
        raise RuntimeError("E2E timeout must be between 300 and 9600 seconds")

    db = SessionLocal()
    try:
        etl_repository.ensure_schema(db)
        job = db.get(ETLJobModel, job_id)
        if job is None:
            raise RuntimeError("bounded fixture Job is missing")
        job.source_config = replace_field(job.source_config or [], BATCH_FIELD, batch_id)
        job.source_config = replace_field(job.source_config, COUNT_FIELD, str(expected_count))
        db.commit()

        response = command_job(db, job_id, "run", ActorContext(name="phase6-evidence", role="admin"))
        run_id = str(response.run.run_id)
    finally:
        db.close()

    deadline = time.monotonic() + timeout_seconds
    terminal: ETLRunModel | None = None
    while time.monotonic() < deadline:
        db = SessionLocal()
        try:
            # The public job read is the supported reconciliation boundary for
            # Airflow state. A raw database poll would leave a completed DAG
            # Run reported as queued until another API consumer reads the Job.
            get_job(db, job_id, ActorContext(name="phase6-evidence", role="admin"))
            terminal = db.get(ETLRunModel, run_id)
            if terminal is not None and terminal.status in {"success", "failed", "cancelled"}:
                break
        finally:
            db.close()
        time.sleep(5)
    if terminal is None or terminal.status != "success":
        raise RuntimeError("bounded E2E did not reach success")

    spark = (terminal.task_states or {}).get("sparkResult") or {}
    execution = spark.get("kubernetesExecution") or {}
    if execution.get("state") != "COMPLETED" or not execution.get("applicationName") or not execution.get("applicationUid"):
        raise RuntimeError("bounded E2E has no completed Kubernetes identity")
    print(json.dumps({
        "contractVersion": "1.0",
        "submitted": True,
        "jobId": job_id,
        "runId": run_id,
        "expectedCount": expected_count,
        "applicationName": execution.get("applicationName"),
        "applicationUid": execution.get("applicationUid"),
    }))


if __name__ == "__main__":
    main()
