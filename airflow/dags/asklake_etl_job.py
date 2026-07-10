from __future__ import annotations

import json
import os
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import pendulum

try:
    from airflow.sdk import dag, task
except ImportError:  # Airflow 2 compatibility for local fallback environments.
    from airflow.decorators import dag, task


def execute_spark_via_asklake(conf: dict[str, Any]) -> dict[str, Any]:
    base_url = os.environ.get(
        "ASKLAKE_BACKEND_INTERNAL_URL",
        "http://host.docker.internal:8080/api",
    ).rstrip("/")
    job_id = str(conf["jobId"])
    run_id = str(conf["runId"])
    request = Request(
        f"{base_url}/etl/internal/jobs/{job_id}/runs/{run_id}/spark",
        data=json.dumps({"command": conf.get("command") or "run"}).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "X-AskLake-Airflow-Token": os.environ.get("ASKLAKE_BACKEND_INTERNAL_TOKEN", ""),
        },
        method="POST",
    )
    timeout = max(30, int(os.environ.get("ASKLAKE_BACKEND_INTERNAL_TIMEOUT_SECONDS", "1800")))
    try:
        with urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")[:4000]
        raise RuntimeError(f"AskLake Spark callback returned HTTP {exc.code}: {body}") from exc
    except (URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"AskLake Spark callback failed: {exc}") from exc
    if payload.get("status") != "success":
        raise RuntimeError(str(payload.get("error") or "AskLake Spark execution failed."))
    return payload


@dag(
    dag_id="asklake_etl_job",
    schedule=None,
    start_date=pendulum.datetime(2026, 1, 1, tz="UTC"),
    catchup=False,
    tags=["asklake", "spark", "etl"],
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
        return conf

    @task(task_id="spark_source_read")
    def spark_source_read(conf: dict[str, Any]) -> dict[str, Any]:
        job = conf.get("job") if isinstance(conf.get("job"), dict) else {}
        if not job.get("sourceType") or not job.get("schemaColumns"):
            raise ValueError("AskLake job manifest requires sourceType and schemaColumns.")
        return {
            "conf": conf,
            "manifestValidated": True,
        }

    @task(task_id="transform_quality_write")
    def transform_quality_write(payload: dict[str, Any]) -> dict[str, Any]:
        conf = payload["conf"]
        if conf.get("forceFail"):
            raise RuntimeError("AskLake forced failure from dag_run.conf.forceFail.")
        return {
            **payload,
            "sparkResult": execute_spark_via_asklake(conf),
        }

    @task(task_id="catalog_update")
    def catalog_update(payload: dict[str, Any]) -> dict[str, Any]:
        conf = payload["conf"]
        result = payload["sparkResult"]
        return {
            "jobId": conf.get("jobId"),
            "runId": conf.get("runId"),
            "status": result.get("status"),
            "outputPath": result.get("outputPath"),
            "inputRows": result.get("inputRows"),
            "outputRows": result.get("outputRows"),
            "catalogDatasetIds": result.get("catalogDatasetIds") or [],
            "artifacts": result.get("artifacts") or [],
        }

    catalog_update(transform_quality_write(spark_source_read(receive_asklake_run())))


asklake_etl_job()
