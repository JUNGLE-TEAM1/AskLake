from __future__ import annotations

import json
import os
import time
from typing import Any
from urllib import error, parse, request

import pendulum

try:
    from airflow.sdk import dag, task
except ImportError:  # Airflow 2 compatibility for local fallback environments.
    from airflow.decorators import dag, task


def sleep_seconds(conf: dict[str, Any], key: str, default: int) -> int:
    try:
        return max(0, min(int(conf.get(key, default)), 60))
    except (TypeError, ValueError):
        return default


def execute_asklake_run(conf: dict[str, Any]) -> dict[str, Any]:
    base_url = str(os.environ.get("AIRFLOW_INTERNAL_BASE_URL") or "").rstrip("/")
    token = str(os.environ.get("AIRFLOW_INTERNAL_TOKEN") or "")
    if not base_url or not token:
        raise RuntimeError("AIRFLOW_INTERNAL_BASE_URL and AIRFLOW_INTERNAL_TOKEN are required.")

    job_id = parse.quote(str(conf["jobId"]), safe="")
    run_id = parse.quote(str(conf["runId"]), safe="")
    url = f"{base_url}/api/etl/internal/airflow/jobs/{job_id}/runs/{run_id}/execute"
    body = json.dumps({"command": conf.get("command") or "run"}).encode("utf-8")
    http_request = request.Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "X-AskLake-Airflow-Token": token,
        },
        method="POST",
    )
    timeout_seconds = max(30, int(os.environ.get("AIRFLOW_INTERNAL_TIMEOUT_SECONDS") or "1800"))
    try:
        with request.urlopen(http_request, timeout=timeout_seconds) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except error.HTTPError as exc:
        details = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"AskLake Spark execution endpoint failed: HTTP {exc.code} {details}") from exc
    except error.URLError as exc:
        raise RuntimeError(f"AskLake Spark execution endpoint is unreachable: {exc.reason}") from exc

    if payload.get("status") != "success":
        raise RuntimeError(payload.get("error") or "AskLake Spark execution failed.")
    return payload


@dag(
    dag_id="asklake_etl_job",
    schedule=None,
    start_date=pendulum.datetime(2026, 1, 1, tz="UTC"),
    catchup=False,
    tags=["asklake", "etl"],
    is_paused_upon_creation=False,
)
def asklake_etl_job() -> None:
    @task(task_id="receive_asklake_run")
    def receive_asklake_run(**context: Any) -> dict[str, Any]:
        conf = dict(context["dag_run"].conf or {})
        run_id = conf.get("runId")
        job_id = conf.get("jobId")
        if not run_id or not job_id:
            raise ValueError("AskLake DAG Run conf must include jobId and runId.")
        time.sleep(sleep_seconds(conf, "smokeReceiveSeconds", 2))
        return conf

    @task(task_id="spark_source_read")
    def spark_source_read(conf: dict[str, Any]) -> dict[str, Any]:
        time.sleep(sleep_seconds(conf, "smokeReadSeconds", 1))
        return {
            "conf": conf,
            "sourceValidated": True,
        }

    @task(task_id="transform_quality_write")
    def transform_quality_write(payload: dict[str, Any]) -> dict[str, Any]:
        conf = payload["conf"]
        if conf.get("forceFail"):
            raise RuntimeError("AskLake forced failure from dag_run.conf.forceFail.")
        return {
            **payload,
            "result": execute_asklake_run(conf),
        }

    @task(task_id="catalog_update")
    def catalog_update(payload: dict[str, Any]) -> dict[str, Any]:
        conf = payload["conf"]
        result = payload["result"]
        if not result.get("datasetId"):
            raise RuntimeError("Spark succeeded without a persisted Catalog dataset id.")
        return {
            "jobId": conf.get("jobId"),
            "runId": conf.get("runId"),
            "status": "success",
            "datasetId": result.get("datasetId"),
            "outputPath": result.get("outputPath"),
            "inputRows": result.get("inputRows"),
            "outputRows": result.get("outputRows"),
        }

    catalog_update(transform_quality_write(spark_source_read(receive_asklake_run())))


asklake_etl_job()
